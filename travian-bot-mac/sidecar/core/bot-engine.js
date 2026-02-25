/**
 * BotEngine - Adapted for Node.js + Puppeteer sidecar
 *
 * Changes from Chrome extension version:
 * - sendToContentScript() → uses PageController (page.evaluate)
 * - chrome.alarms → not needed (Node.js process is persistent)
 * - chrome.storage → uses adapted Storage module
 * - activeTabId → pageController reference
 * - Export via module.exports instead of self.TravianBotEngine
 *
 * Dependencies (loaded via load-modules.js):
 *   - global.TravianTaskQueue
 *   - global.TravianScheduler
 *   - global.TravianDecisionEngine
 *   - global.TravianStorage (adapted file-based)
 *   - global.TravianGameData
 */

const Storage = require('../utils/storage');
const Logger = require('../utils/logger');

class BotEngine {
  constructor() {
    this.running = false;
    this.paused = false;

    // Core subsystems
    this.taskQueue = new global.TravianTaskQueue();
    this.scheduler = new global.TravianScheduler();
    this.decisionEngine = new global.TravianDecisionEngine();

    // Current state
    this.gameState = null;
    this.config = null;
    this.pageController = null; // Set by InstanceManager (replaces activeTabId)
    this.serverKey = null;      // Set by InstanceManager

    // Statistics
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      startTime: null,
      lastAction: null,
      farmRaidsSent: 0
    };

    // Next action scheduling
    this.nextActionTime = null;

    // Safety
    this.emergencyStopped = false;

    // Rate limiting
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // Content script communication timeout (ms)
    this._messageTimeout = 15000;

    // Event emitter for status updates to frontend
    this._emitter = null;
  }

  /**
   * Set a callback for emitting events to the frontend.
   * @param {Function} fn - Called as fn(event, data)
   */
  setEmitter(fn) {
    this._emitter = fn;
  }

  _emit(event, data) {
    if (this._emitter) {
      try { this._emitter(event, data); } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the bot engine.
   * @param {PageController} pageController - The Puppeteer page controller
   */
  async start(pageController) {
    if (this.running) {
      Logger.warn('BotEngine already running');
      return;
    }

    this.pageController = pageController;
    this.emergencyStopped = false;

    // Load configuration from file storage
    await this.loadConfig();

    if (!this.config) {
      Logger.error('Failed to load config, cannot start');
      return;
    }

    this.running = true;
    this.paused = false;
    this.stats.startTime = Date.now();
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // Start the scheduler
    this.scheduler.start();

    // Schedule the hourly rate-limit counter reset
    this.scheduler.scheduleCycle('hourly_reset', () => {
      this.resetHourlyCounter();
    }, 3600000, 0);

    // Schedule the main decision/execution loop
    const loopInterval = this._getLoopInterval();
    this.scheduler.scheduleCycle('main_loop', () => {
      this.mainLoop();
    }, loopInterval, Math.floor(loopInterval * 0.2));

    // No chrome.alarms needed — Node.js process is persistent

    Logger.info('BotEngine started' + (this.serverKey ? ' (server: ' + this.serverKey + ')' : ''));
    this._emit('statusUpdate', this.getStatus());

    // Run the first loop immediately
    this.mainLoop();
  }

  /**
   * Stop the bot engine. Saves state and clears all timers.
   */
  stop() {
    this.running = false;
    this.paused = false;

    // Stop scheduler (clears all timers and cycles)
    this.scheduler.stop();

    // Save state before fully stopping
    this.saveState();

    Logger.info('BotEngine stopped');
    this._emit('statusUpdate', this.getStatus());
  }

  /**
   * Pause the bot.
   */
  pause() {
    if (!this.running) return;
    this.paused = true;
    Logger.info('BotEngine paused');
    this._emit('statusUpdate', this.getStatus());
  }

  /**
   * Resume the bot from a paused state.
   */
  resume() {
    if (!this.running) return;
    this.paused = false;
    Logger.info('BotEngine resumed');
    this._emit('statusUpdate', this.getStatus());
  }

  /**
   * Emergency stop.
   * @param {string} reason
   */
  emergencyStop(reason) {
    Logger.error('EMERGENCY STOP: ' + reason);

    this.emergencyStopped = true;
    this.stop();

    // Persist emergency stop reason via file storage
    Storage.set('bot_emergency_stop', {
      reason: reason,
      timestamp: Date.now()
    }).catch(() => {});

    this._emit('emergencyStop', { reason });
  }

  // ---------------------------------------------------------------------------
  // Main Loop (identical logic to Chrome extension)
  // ---------------------------------------------------------------------------

  async mainLoop() {
    if (!this.running || this.paused || this.emergencyStopped) {
      return;
    }

    try {
      // Check rate limits
      if (!this.checkRateLimit()) {
        Logger.info('Rate limit reached, skipping cycle');
        return;
      }

      // Scan game state via PageController
      const scanResponse = await this.sendToContentScript({ type: 'SCAN' });

      if (!scanResponse || !scanResponse.success) {
        Logger.warn('Failed to get game state scan');
        return;
      }

      this.gameState = scanResponse.data;

      // Safety checks
      if (this.gameState.captcha) {
        this.emergencyStop('Captcha detected on page');
        return;
      }
      if (this.gameState.error) {
        this.emergencyStop('Game error detected');
        return;
      }
      if (!this.gameState.loggedIn) {
        Logger.warn('Not logged in, skipping cycle');
        return;
      }

      // Run decision engine
      const newTasks = this.decisionEngine.evaluate(
        this.gameState,
        this.config,
        this.taskQueue
      );

      for (const task of newTasks) {
        if (task.type === 'emergency_stop') {
          this.emergencyStop(task.params.reason);
          return;
        }
      }

      for (const task of newTasks) {
        this.taskQueue.add(
          task.type,
          task.params,
          task.priority,
          task.villageId,
          task.scheduledFor || null
        );
      }

      // Get and execute next task
      const nextTask = this.taskQueue.getNext();
      if (!nextTask) {
        this._adjustLoopInterval('idle');
        return;
      }

      await this.executeTask(nextTask);
      this._adjustLoopInterval('active');

      // Emit status update after each cycle
      this._emit('statusUpdate', this.getStatus());

    } catch (err) {
      Logger.error('Error in main loop: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Task Execution (identical logic to Chrome extension)
  // ---------------------------------------------------------------------------

  async executeTask(task) {
    Logger.info('Executing task: ' + task.type + ' (' + task.id + ')');

    try {
      let response;

      switch (task.type) {
        case 'upgrade_resource':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._randomDelay();
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickResourceField', params: { fieldId: task.params.fieldId }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'upgrade_building':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'train_troops':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: task.params.buildingType || 'barracks' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'trainTroops', params: {
              troopType: task.params.troopType,
              count: task.params.count
            }
          });
          break;

        case 'send_farm':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
          });
          await this._randomDelay();
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickFarmListTab', params: {}
          });
          await this._randomDelay();
          if (task.params.farmListId != null) {
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendFarmList', params: {
                farmListId: task.params.farmListId
              }
            });
          } else {
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendAllFarmLists', params: {}
            });
          }
          if (this.gameState) this.gameState.lastFarmTime = Date.now();
          this.stats.farmRaidsSent++;
          break;

        case 'send_hero_adventure':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroAdventures' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'sendHeroAdventure', params: {}
          });
          break;

        case 'claim_hero_resources':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'useHeroItem', params: { itemIndex: task.params.itemIndex || 0 }
          });
          break;

        case 'claim_quest':
          // Quest rewards can be claimed from any page via the quest notification icon.
          // Navigate to dorf1 first so the questmaster sidebar is visible, then claim.
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._randomDelay();
          await this._waitForContentScript(10000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'claimQuest', params: { questId: task.params && task.params.questId }
          });
          break;

        case 'build_new':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          var slotClick = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          if (!slotClick || slotClick === false || (slotClick && slotClick.success === false)) {
            response = { success: false, reason: 'button_not_found', message: 'Empty slot ' + task.params.slot + ' not found on dorf2' };
            break;
          }
          await this._randomDelay();
          await this._waitForContentScript(10000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
          });
          if (response && response.reason === 'building_not_in_tab') {
            for (var tabIdx = 0; tabIdx < 3; tabIdx++) {
              var tabClick = await this.sendToContentScript({
                type: 'EXECUTE', action: 'clickBuildTab', params: { tabIndex: tabIdx }
              });
              if (tabClick && tabClick.success) {
                await this._randomDelay();
                await this._waitForContentScript(10000);
              } else {
                await this._randomDelay();
              }
              response = await this.sendToContentScript({
                type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
              });
              if (!response || response.reason !== 'building_not_in_tab') break;
            }
          }
          break;

        case 'send_attack':
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'sendAttack', params: {
              target: task.params.target,
              troops: task.params.troops || {}
            }
          });
          if (this.gameState) this.gameState.lastFarmTime = Date.now();
          break;

        case 'switch_village':
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'switchVillage', params: {
              villageId: task.params.targetVillageId
            }
          });
          break;

        case 'navigate':
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: {
              page: task.params.page
            }
          });
          break;

        default:
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: task.type, params: task.params
          });
          break;
      }

      // Process response
      if (response && response.success) {
        this.taskQueue.markCompleted(task.id);
        this.stats.tasksCompleted++;
        this.stats.lastAction = Date.now();
        this.actionsThisHour++;
        const cooldownMs = this._getCooldownForType(task.type);
        this.decisionEngine.setCooldown(task.type, cooldownMs);
        Logger.info('Task completed: ' + task.type + ' (' + task.id + ')');
      } else {
        const errorMsg = (response && response.error) || 'Unknown error';
        const reason = (response && response.reason) || '';

        if (this._isHopelessFailure(reason)) {
          task.retries = task.maxRetries;
          this.taskQueue.markFailed(task.id, errorMsg);
          this.stats.tasksFailed++;
          const failCooldown = this._getFailCooldownForReason(reason, task.type);
          this.decisionEngine.setCooldown(task.type, failCooldown);
          Logger.warn('Task skipped (' + reason + '): ' + task.type + ': ' + errorMsg);

          if (reason === 'insufficient_resources' &&
              (task.type === 'upgrade_resource' || task.type === 'upgrade_building' || task.type === 'build_new')) {
            const claimed = await this._tryClaimHeroResources(task);
            if (claimed) {
              this.taskQueue.add(task.type, task.params, task.priority, task.villageId);
              this.decisionEngine.setCooldown(task.type, 15000);
            }
          }
        } else {
          this.taskQueue.markFailed(task.id, errorMsg);
          if (task.retries + 1 >= task.maxRetries) {
            this.stats.tasksFailed++;
            Logger.error('Task permanently failed: ' + task.type + ': ' + errorMsg);
          } else {
            Logger.warn('Task failed, will retry: ' + task.type + ': ' + errorMsg);
          }
        }
      }

    } catch (err) {
      this.taskQueue.markFailed(task.id, err.message);
      if (task.retries + 1 >= task.maxRetries) {
        this.stats.tasksFailed++;
      }
      Logger.error('Exception executing task ' + task.type + ': ' + err.message);
    }

    await this._returnHome(task.type);
  }

  // ---------------------------------------------------------------------------
  // Content Script Communication — PageController bridge
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the content script via PageController.
   * Replaces chrome.tabs.sendMessage.
   *
   * @param {object} message - { type: 'SCAN' } or { type: 'EXECUTE', action, params }
   * @returns {Promise<object>}
   */
  async sendToContentScript(message) {
    if (!this.pageController) {
      throw new Error('No page controller set');
    }

    if (message.type === 'SCAN') {
      return this.pageController.scan();
    }

    if (message.type === 'EXECUTE') {
      return this.pageController.execute(message.action, message.params);
    }

    return { success: false, error: 'Unknown message type: ' + message.type };
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting
  // ---------------------------------------------------------------------------

  checkRateLimit() {
    const maxActions = (this.config && this.config.safetyConfig && this.config.safetyConfig.maxActionsPerHour) || 60;
    if (Date.now() - this.hourResetTime >= 3600000) {
      this.resetHourlyCounter();
    }
    return this.actionsThisHour < maxActions;
  }

  resetHourlyCounter() {
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();
  }

  // ---------------------------------------------------------------------------
  // Status & Persistence
  // ---------------------------------------------------------------------------

  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      emergencyStopped: this.emergencyStopped,
      serverKey: this.serverKey,
      stats: { ...this.stats },
      actionsThisHour: this.actionsThisHour,
      taskQueue: {
        total: this.taskQueue.getAll().length,
        pending: this.taskQueue.size(),
        tasks: this.taskQueue.getAll()
      },
      scheduler: this.scheduler.getStatus(),
      gameState: this.gameState,
      config: this.config,
      nextActionTime: this.nextActionTime
    };
  }

  /**
   * Load bot configuration from file storage.
   */
  async loadConfig() {
    try {
      if (this.serverKey) {
        this.config = await Storage.getServerConfig(this.serverKey);
        Logger.info('Config loaded for server: ' + this.serverKey);
        return;
      }

      // Fallback to global config
      this.config = await Storage.getConfig();
      if (!this.config) {
        this.config = this._getDefaultConfig();
        Logger.info('Using default config');
      }
    } catch (err) {
      Logger.error('Failed to load config: ' + err.message);
      this.config = this._getDefaultConfig();
    }
  }

  /**
   * Persist current bot state to file storage.
   */
  async saveState() {
    try {
      const state = {
        stats: this.stats,
        taskQueue: this.taskQueue.getAll(),
        actionsThisHour: this.actionsThisHour,
        hourResetTime: this.hourResetTime,
        wasRunning: this.running,
        savedAt: Date.now()
      };

      if (this.serverKey) {
        await Storage.saveServerState(this.serverKey, state);
      } else {
        await Storage.set('bot_state', state);
      }
    } catch (err) {
      Logger.error('Failed to save state: ' + err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers (identical to Chrome extension)
  // ---------------------------------------------------------------------------

  _getDefaultConfig() {
    return {
      autoUpgradeResources: true,
      autoUpgradeBuildings: false,
      autoTrainTroops: false,
      autoFarm: false,
      resourceConfig: { maxLevel: 10 },
      buildingConfig: {
        maxLevel: 10,
        priorityList: ['granary', 'warehouse', 'barracks', 'marketplace']
      },
      troopConfig: {
        defaultTroopType: 'infantry',
        trainCount: 5,
        trainingBuilding: 'barracks',
        minResourceThreshold: { wood: 500, clay: 500, iron: 500, crop: 300 }
      },
      farmConfig: {
        intervalMs: 300000,
        minTroops: 10,
        useRallyPointFarmList: true,
        targets: []
      },
      safetyConfig: { maxActionsPerHour: 60 },
      delays: {
        minActionDelay: 2000,
        maxActionDelay: 8000,
        loopActiveMs: 45000,
        loopIdleMs: 180000
      }
    };
  }

  async _waitForContentScript(maxWaitMs) {
    maxWaitMs = maxWaitMs || 10000;
    var start = Date.now();
    var attempts = 0;
    while (Date.now() - start < maxWaitMs) {
      attempts++;
      try {
        var ping = await this.sendToContentScript({ type: 'SCAN' });
        if (ping && ping.success) {
          if (attempts > 1) {
            Logger.debug('Content script ready after ' + attempts + ' attempts');
          }
          return true;
        }
      } catch (e) {}
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    Logger.warn('Content script not ready after ' + maxWaitMs + 'ms');
    return false;
  }

  _randomDelay() {
    const minDelay = (this.config && this.config.delays && this.config.delays.minActionDelay) || 2000;
    const maxDelay = (this.config && this.config.delays && this.config.delays.maxActionDelay) || 8000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  _getCooldownForType(taskType) {
    switch (taskType) {
      case 'upgrade_resource':
      case 'upgrade_building': return 60000;
      case 'train_troops':     return 120000;
      case 'send_farm':        return 300000;
      case 'send_hero_adventure': return 180000;
      case 'claim_quest':         return 300000;  // 5 min — quests don't refresh that often
      default:                 return 30000;
    }
  }

  _getLoopInterval() {
    return (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
  }

  async _returnHome(taskType) {
    const skipTypes = ['upgrade_resource', 'navigate', 'switch_village'];
    if (skipTypes.indexOf(taskType) !== -1) {
      await this._randomDelay();
      return;
    }
    try {
      await this._randomDelay();
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
      });
    } catch (err) {
      Logger.warn('Failed to return to dorf1: ' + err.message);
    }
  }

  _isHopelessFailure(reason) {
    return ['no_adventure', 'hero_unavailable', 'insufficient_resources',
            'queue_full', 'building_not_available', 'no_items'].indexOf(reason) !== -1;
  }

  _getFailCooldownForReason(reason) {
    switch (reason) {
      case 'no_adventure':         return 600000;
      case 'hero_unavailable':     return 300000;
      case 'insufficient_resources': return 180000;
      case 'queue_full':           return 120000;
      case 'building_not_available': return 300000;
      default:                     return 60000;
    }
  }

  async _tryClaimHeroResources(failedTask) {
    try {
      Logger.info('Attempting to claim hero inventory resources...');
      const deficit = this._calcResourceDeficit(failedTask);
      if (deficit) Logger.debug('Resource deficit: ' + JSON.stringify(deficit));

      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
      });
      await this._randomDelay();
      if (!await this._waitForContentScript(10000)) return false;

      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
      });
      await this._randomDelay();
      if (!await this._waitForContentScript(10000)) return false;

      const scanResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'scanHeroInventory', params: {}
      });
      if (!scanResult || !scanResult.success || !scanResult.data) return false;

      const items = scanResult.data.items || [];
      const usableResources = items.filter(item => item.isResource && item.hasUseButton);
      if (usableResources.length === 0) return false;

      const itemClassToRes = {
        item145: 'wood', item176: 'wood',
        item146: 'clay', item177: 'clay',
        item147: 'iron', item178: 'iron',
        item148: 'crop', item179: 'crop'
      };

      let claimed = false;
      for (const item of usableResources) {
        let resType = null;
        const cls = item.itemClass || '';
        for (const [pattern, type] of Object.entries(itemClassToRes)) {
          if (cls.indexOf(pattern) !== -1) { resType = type; break; }
        }
        if (!resType) continue;

        let transferAmount = null;
        if (deficit && deficit[resType] !== undefined) {
          if (deficit[resType] <= 0) continue;
          transferAmount = Math.ceil(deficit[resType]);
        }
        const available = item.count || 0;
        if (transferAmount && available > 0) {
          transferAmount = Math.min(transferAmount, available);
        }

        const useResult = await this.sendToContentScript({
          type: 'EXECUTE', action: 'useHeroItem',
          params: { itemIndex: item.index, amount: transferAmount }
        });
        if (useResult && useResult.success) claimed = true;
        await this._randomDelay();
      }
      return claimed;
    } catch (err) {
      Logger.warn('Hero resource claim failed: ' + err.message);
      return false;
    }
  }

  _calcResourceDeficit(task) {
    try {
      const GameData = global.TravianGameData;
      if (!GameData || !this.gameState || !this.gameState.resources) return null;

      const current = this.gameState.resources;
      let cost = null;

      if (task.type === 'build_new' && task.params && task.params.gid) {
        const key = GameData.gidToKey(Number(task.params.gid));
        if (key) cost = GameData.getUpgradeCost(key, 0);

      } else if (task.type === 'upgrade_resource' && task.params) {
        const resTypeToGid = { wood: 1, clay: 2, iron: 3, crop: 4 };
        const fieldId = task.params.fieldId || task.params.slot;
        let gid = task.params.gid;
        let level = task.params.level || 0;
        const fieldArray = this.gameState.resourceFields || this.gameState.resources_fields || [];
        if (!gid && fieldId && fieldArray.length > 0) {
          const field = fieldArray.find(f => f.id == fieldId || f.position == fieldId);
          if (field) {
            gid = field.gid || resTypeToGid[field.type] || null;
            level = field.level || 0;
          }
        }
        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }

      } else if (task.type === 'upgrade_building' && task.params) {
        const slot = task.params.slot || task.params.buildingSlot;
        let gid = task.params.gid || task.params.buildingGid;
        let level = task.params.level || task.params.currentLevel || 0;
        if (!gid && slot && this.gameState.buildings) {
          const building = this.gameState.buildings.find(b => b.slot == slot);
          if (building) {
            gid = building.id;
            level = building.level || 0;
          }
        }
        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }
      }

      if (!cost) return null;

      return {
        wood: Math.max(0, (cost.wood || 0) - (current.wood || 0)),
        clay: Math.max(0, (cost.clay || 0) - (current.clay || 0)),
        iron: Math.max(0, (cost.iron || 0) - (current.iron || 0)),
        crop: Math.max(0, (cost.crop || 0) - (current.crop || 0))
      };
    } catch (e) {
      return null;
    }
  }

  _adjustLoopInterval(mode) {
    const activeMs = (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
    const idleMs = (this.config && this.config.delays && this.config.delays.loopIdleMs) || 180000;
    const targetMs = mode === 'idle' ? idleMs : activeMs;
    this.nextActionTime = Date.now() + targetMs;
    const currentStatus = this.scheduler.getStatus();
    const mainLoop = currentStatus['main_loop'];
    if (mainLoop && mainLoop.intervalMs !== targetMs) {
      this.scheduler.reschedule('main_loop', targetMs);
    }
  }
}

module.exports = BotEngine;
