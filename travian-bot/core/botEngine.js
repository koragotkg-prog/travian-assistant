/**
 * BotEngine - Main bot engine that ties together TaskQueue, Scheduler, and DecisionEngine
 * Runs in service worker context (no DOM, no window)
 * Exported via self.TravianBotEngine
 *
 * Dependencies (must be loaded before this file):
 *   - self.TravianTaskQueue   (core/taskQueue.js)
 *   - self.TravianScheduler   (core/scheduler.js)
 *   - self.TravianDecisionEngine (core/decisionEngine.js)
 *   - self.TravianGameStateCollector (core/gameStateCollector.js)
 */

class BotEngine {
  constructor() {
    this.running = false;
    this.paused = false;

    // Core subsystems
    this.taskQueue = new self.TravianTaskQueue();
    this.scheduler = new self.TravianScheduler();
    this.decisionEngine = new self.TravianDecisionEngine();
    this.stateCollector = new self.TravianGameStateCollector();

    // Current state
    this.gameState = null;
    this.config = null;
    this.activeTabId = null;
    this.serverKey = null; // Set by InstanceManager

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

    // Persistent farm cooldown (survives gameState overwrites)
    this._lastFarmTime = 0;

    // Rate limiting
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // Content script communication timeout (ms)
    this._messageTimeout = 15000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the bot engine.
   * Loads config, starts the scheduler, sets up the main loop and heartbeat alarm.
   *
   * @param {number} tabId - The Chrome tab ID running the Travian content script
   */
  async start(tabId) {
    if (this.running) {
      console.warn('[BotEngine] Already running');
      return;
    }

    this.activeTabId = tabId;
    this.emergencyStopped = false;

    // Load configuration from storage
    await this.loadConfig();

    if (!this.config) {
      console.error('[BotEngine] Failed to load config, cannot start');
      return;
    }

    this.running = true;
    this.paused = false;
    this.stats.startTime = Date.now();
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // Restore persistent state (e.g., lastFarmTime) from chrome.storage
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && typeof self.TravianStorage !== 'undefined') {
        const savedState = this.serverKey
          ? await self.TravianStorage.getServerState(this.serverKey)
          : null;
        if (savedState) {
          this._lastFarmTime = savedState.lastFarmTime || 0;
          console.log('[BotEngine] Restored lastFarmTime: ' + this._lastFarmTime);
        }
      }
    } catch (err) {
      console.warn('[BotEngine] Could not restore saved state:', err);
    }

    // Start the scheduler
    this.scheduler.start();

    // Schedule the hourly rate-limit counter reset
    this.scheduler.scheduleCycle('hourly_reset', () => {
      this.resetHourlyCounter();
    }, 3600000, 0); // Exactly every hour

    // Schedule the main decision/execution loop
    const loopInterval = this._getLoopInterval();
    this.scheduler.scheduleCycle('main_loop', () => {
      this.mainLoop();
    }, loopInterval, Math.floor(loopInterval * 0.2)); // 20% jitter

    // Set up a chrome.alarms heartbeat as a fallback
    // Service workers can go to sleep; alarms wake them back up
    try {
      if (typeof chrome !== 'undefined' && chrome.alarms) {
        var alarmName = this.serverKey ? 'botHeartbeat__' + this.serverKey : 'botHeartbeat';
        chrome.alarms.create(alarmName, { periodInMinutes: 1 });
      }
    } catch (err) {
      console.warn('[BotEngine] Could not create chrome.alarms heartbeat:', err);
    }

    console.log('[BotEngine] Started for tab ' + tabId + (this.serverKey ? ' (server: ' + this.serverKey + ')' : ''));

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

    // Clear heartbeat alarm
    try {
      if (typeof chrome !== 'undefined' && chrome.alarms) {
        var alarmName = this.serverKey ? 'botHeartbeat__' + this.serverKey : 'botHeartbeat';
        chrome.alarms.clear(alarmName);
      }
    } catch (err) {
      // Ignore
    }

    // Save state before fully stopping
    this.saveState();

    console.log('[BotEngine] Stopped');
  }

  /**
   * Pause the bot. The main loop keeps running but skips actions.
   */
  pause() {
    if (!this.running) return;
    this.paused = true;
    console.log('[BotEngine] Paused');
  }

  /**
   * Resume the bot from a paused state.
   */
  resume() {
    if (!this.running) return;
    this.paused = false;
    console.log('[BotEngine] Resumed');
  }

  /**
   * Emergency stop. Immediately halts all activity and records the reason.
   * @param {string} reason - Why the emergency stop was triggered
   */
  emergencyStop(reason) {
    console.error(`[BotEngine] EMERGENCY STOP: ${reason}`);

    this.emergencyStopped = true;
    this.stop();

    // Persist the emergency stop reason
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({
          'bot_emergency_stop': {
            reason: reason,
            timestamp: Date.now()
          }
        });
      }
    } catch (err) {
      console.error('[BotEngine] Failed to persist emergency stop:', err);
    }

    // Attempt to notify the user via the content script
    this.sendToContentScript({
      action: 'NOTIFY',
      data: {
        type: 'emergency',
        message: `Bot emergency stop: ${reason}`
      }
    }).catch(() => {});
  }

  // ---------------------------------------------------------------------------
  // Main Loop
  // ---------------------------------------------------------------------------

  /**
   * The core main loop. Runs on each scheduler cycle.
   *
   * Steps:
   *  1. Check if running and not paused
   *  2. Check rate limits
   *  3. Request game state scan from content script
   *  4. Check for captcha/errors -> emergency stop
   *  5. Run decision engine to generate new tasks
   *  6. Get next task from queue
   *  7. Execute the task
   *  8. Adjust loop interval based on activity
   */
  async mainLoop() {
    // 1. Check running state
    if (!this.running || this.paused || this.emergencyStopped) {
      return;
    }

    try {
      // 2. Check rate limits
      if (!this.checkRateLimit()) {
        console.log('[BotEngine] Rate limit reached, skipping this cycle');
        return;
      }

      // 3. Scan game state via content script
      const scanResponse = await this.sendToContentScript({
        type: 'SCAN'
      });

      if (!scanResponse || !scanResponse.success) {
        console.warn('[BotEngine] Failed to get game state scan');
        return;
      }

      this.gameState = scanResponse.data;

      // Enrich gameState with cached extras
      this.gameState = this.stateCollector.enrichGameState(this.gameState);

      // Inject persistent lastFarmTime so DecisionEngine sees it
      this.gameState.lastFarmTime = this._lastFarmTime || 0;

      // 4. Safety checks - captcha / errors
      if (this.gameState.captcha) {
        this.emergencyStop('Captcha detected on page');
        return;
      }

      if (this.gameState.error) {
        this.emergencyStop('Game error detected');
        return;
      }

      if (!this.gameState.loggedIn) {
        console.warn('[BotEngine] Not logged in, skipping cycle');
        return;
      }

      // 5. Run decision engine to produce new tasks
      const newTasks = this.decisionEngine.evaluate(
        this.gameState,
        this.config,
        this.taskQueue
      );

      // Check if decision engine flagged an emergency
      for (const task of newTasks) {
        if (task.type === 'emergency_stop') {
          this.emergencyStop(task.params.reason);
          return;
        }
      }

      // Add new tasks to the queue
      for (const task of newTasks) {
        this.taskQueue.add(
          task.type,
          task.params,
          task.priority,
          task.villageId,
          task.scheduledFor || null
        );
      }

      // 5b. Proactive hero resource claim: if resources are critically low
      //     and hero is home with resource items, claim before executing upgrades
      if (this._shouldProactivelyClaimHero()) {
        TravianLogger.log('INFO', '[BotEngine] Resources critically low — attempting proactive hero claim');
        const claimed = await this._proactiveHeroClaim();
        if (claimed) {
          this._heroClaimCooldown = Date.now() + 300000; // 5 min cooldown
          return; // skip this cycle, let resources update
        }
        // Even if failed, set cooldown so we don't spam attempts
        this._heroClaimCooldown = Date.now() + 120000; // 2 min cooldown on failure
      }

      // 6. Get next task from queue
      const nextTask = this.taskQueue.getNext();
      if (!nextTask) {
        // No tasks ready - adjust to idle interval
        this._adjustLoopInterval('idle');
        return;
      }

      // 7. Execute the task
      await this.executeTask(nextTask);

      // Adjust loop interval back to active pace
      this._adjustLoopInterval('active');

    } catch (err) {
      console.error('[BotEngine] Error in main loop:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Task Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single task by dispatching commands to the content script.
   *
   * @param {object} task - The task object from the queue
   */
  async executeTask(task) {
    console.log(`[BotEngine] Executing task: ${task.type} (${task.id})`);

    try {
      let response;

      // All tasks are sent as EXECUTE messages to the content script's message handler
      switch (task.type) {
        case 'upgrade_resource':
          // Step 1: Navigate to dorf1 (resource view)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._randomDelay();
          // Step 2: Click the resource field
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickResourceField', params: { fieldId: task.params.fieldId }
          });
          await this._randomDelay();
          // Step 3: Click upgrade button
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'upgrade_building':
          // Step 1: Navigate to dorf2 (village view)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          // Step 2: Click the building slot (use slot number, not gid)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          await this._randomDelay();
          // Step 3: Click upgrade button (green = affordable, no button = can't afford)
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'train_troops':
          // Navigate to the barracks/stable page and train
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
          // Step 1: Navigate to rally point
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
          });
          await this._randomDelay();
          // Step 2: Click the farm list tab (tt=99) - causes page reload
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickFarmListTab', params: {}
          });
          await this._randomDelay();
          // Step 3: Click start on farm lists
          if (task.params.farmListId != null) {
            // Send a specific farm list
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendFarmList', params: {
                farmListId: task.params.farmListId
              }
            });
          } else {
            // Send all farm lists on the page
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendAllFarmLists', params: {}
            });
          }
          // Update last farm time (persistent, not on gameState which gets overwritten)
          this._lastFarmTime = Date.now();
          this.stats.farmRaidsSent++;
          break;

        case 'build_traps':
          // Step 1: Find trapper building slot from gameState (gid=36, slot != 40 which is wall)
          var trapperSlot = null;
          if (this.gameState && this.gameState.buildings) {
            var trapperBld = this.gameState.buildings.find(function(b) {
              return (b.id === 36 || b.gid === 36) && b.slot !== 40;
            });
            if (trapperBld) trapperSlot = trapperBld.slot;
          }
          if (!trapperSlot) {
            response = { success: false, reason: 'building_not_available', message: 'Trapper building not found' };
            break;
          }
          // Step 2: Navigate to dorf2
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          // Step 3: Click the trapper building slot (navigates to /build.php?id=XX)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: trapperSlot }
          });
          await this._randomDelay();
          // Step 4: Wait for content script re-injection after page navigation
          await this._waitForContentScript(10000);
          // Step 5: Train traps
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'trainTraps', params: { count: task.params.count || 10 }
          });
          break;

        case 'send_hero_adventure':
          // Navigate to hero adventures page and send hero
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroAdventures' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'sendHeroAdventure', params: {}
          });
          break;

        case 'claim_hero_resources':
          // Navigate to hero page and claim resource items
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
          });
          await this._randomDelay();
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'useHeroItem', params: { itemIndex: task.params.itemIndex || 0 }
          });
          break;

        case 'build_new':
          // Navigate to empty slot in dorf2 and build a new building
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          // Click the empty building slot to open build menu
          var slotClick = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          if (!slotClick || slotClick === false || (slotClick && slotClick.success === false)) {
            response = { success: false, reason: 'button_not_found', message: 'Empty slot ' + task.params.slot + ' not found on dorf2' };
            break;
          }
          // Clicking empty slot navigates to build.php — wait for new page + content script
          await this._randomDelay();
          await this._waitForContentScript(10000);
          // Try to build in current tab first
          console.log('[BotEngine] build_new: trying GID ' + task.params.gid + ' in default tab');
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
          });
          // If building not in current tab, try switching tabs (each click causes page reload)
          // Tab switching must happen at botEngine level because page reloads kill content script
          if (response && response.reason === 'building_not_in_tab') {
            console.log('[BotEngine] build_new: GID ' + task.params.gid + ' not in default tab, trying other tabs');
            for (var tabIdx = 0; tabIdx < 3; tabIdx++) {
              var tabClick = await this.sendToContentScript({
                type: 'EXECUTE', action: 'clickBuildTab', params: { tabIndex: tabIdx }
              });
              if (tabClick && tabClick.success) {
                // Tab was clicked — page reloads, wait for new content script
                await this._randomDelay();
                await this._waitForContentScript(10000);
              } else {
                // Tab already active or not found — still retry buildNewByGid
                // (the first attempt might have raced with page load)
                await this._randomDelay();
              }
              // Try buildNewByGid again
              response = await this.sendToContentScript({
                type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
              });
              console.log('[BotEngine] build_new: tab ' + tabIdx + ' result:', response && response.reason || (response && response.success ? 'OK' : 'fail'));
              if (!response || response.reason !== 'building_not_in_tab') break;
            }
          }
          break;

        case 'send_attack':
          // Navigate to rally point and send attack to coordinates
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
          // Update last farm time (persistent, not on gameState which gets overwritten)
          this._lastFarmTime = Date.now();
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

      // Process response — with smart error handling
      if (response && response.success) {
        this.taskQueue.markCompleted(task.id);
        this.stats.tasksCompleted++;
        this.stats.lastAction = Date.now();
        this.actionsThisHour++;

        // Set cooldown for this action type to avoid spamming
        const cooldownMs = this._getCooldownForType(task.type);
        this.decisionEngine.setCooldown(task.type, cooldownMs);

        console.log(`[BotEngine] Task completed: ${task.type} (${task.id})`);
      } else {
        const errorMsg = (response && response.error) || 'Unknown error from content script';
        const reason = (response && response.reason) || '';

        // Smart handling: some failures should NOT retry
        if (this._isHopelessFailure(reason)) {
          // Force permanent failure — don't waste 3 cycles retrying
          task.retries = task.maxRetries;
          this.taskQueue.markFailed(task.id, errorMsg);
          this.stats.tasksFailed++;

          // Set longer cooldown so decision engine doesn't recreate immediately
          const failCooldown = this._getFailCooldownForReason(reason, task.type);
          this.decisionEngine.setCooldown(task.type, failCooldown);

          console.warn(`[BotEngine] Task skipped (${reason}): ${task.type} (${task.id}): ${errorMsg}`);

          // Special: if insufficient resources, try claiming hero inventory
          if (reason === 'insufficient_resources' &&
              (task.type === 'upgrade_resource' || task.type === 'upgrade_building' || task.type === 'build_new')) {
            const claimed = await this._tryClaimHeroResources(task);
            if (claimed) {
              // Re-queue the same task so it retries after hero item was used
              this.taskQueue.add(task.type, task.params, task.priority, task.villageId);
              this.decisionEngine.setCooldown(task.type, 15000); // 15 sec retry
              console.log(`[BotEngine] Re-queued ${task.type} after hero resource claim`);
            }
          }
        } else {
          // Normal retry logic
          this.taskQueue.markFailed(task.id, errorMsg);

          if (task.retries + 1 >= task.maxRetries) {
            this.stats.tasksFailed++;
            console.error(`[BotEngine] Task permanently failed: ${task.type} (${task.id}): ${errorMsg}`);
          } else {
            console.warn(`[BotEngine] Task failed, will retry: ${task.type} (${task.id}): ${errorMsg}`);
          }
        }
      }

    } catch (err) {
      const errorMsg = err.message || 'Exception during task execution';
      this.taskQueue.markFailed(task.id, errorMsg);

      if (task.retries + 1 >= task.maxRetries) {
        this.stats.tasksFailed++;
      }

      console.error(`[BotEngine] Exception executing task ${task.type} (${task.id}):`, err);
    }

    // Navigate back to dorf1 (resource overview) after every task
    // so the next scan gets fresh data and the page looks natural
    await this._returnHome(task.type);
  }

  // ---------------------------------------------------------------------------
  // Content Script Communication
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the content script running in the active tab.
   * Wraps chrome.tabs.sendMessage with a timeout.
   *
   * @param {object} message - The message to send
   * @returns {Promise<object>} The response from the content script
   */
  async sendToContentScript(message) {
    if (!this.activeTabId) {
      throw new Error('No active tab ID set');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Content script message timed out after ${this._messageTimeout}ms`));
      }, this._messageTimeout);

      try {
        chrome.tabs.sendMessage(this.activeTabId, message, (response) => {
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          resolve(response);
        });
      } catch (err) {
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting
  // ---------------------------------------------------------------------------

  /**
   * Check if the bot is within the rate limit for actions per hour.
   * @returns {boolean} True if within limits, false if rate limit reached
   */
  checkRateLimit() {
    const maxActions = (this.config && this.config.safetyConfig && this.config.safetyConfig.maxActionsPerHour) || 60;

    // Check if we need to reset the counter (hour has passed)
    if (Date.now() - this.hourResetTime >= 3600000) {
      this.resetHourlyCounter();
    }

    return this.actionsThisHour < maxActions;
  }

  /**
   * Reset the hourly action counter
   */
  resetHourlyCounter() {
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();
    console.log('[BotEngine] Hourly action counter reset');
  }

  // ---------------------------------------------------------------------------
  // Status & Persistence
  // ---------------------------------------------------------------------------

  /**
   * Get the full bot status for UI display
   * @returns {object} Status object
   */
  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      emergencyStopped: this.emergencyStopped,
      activeTabId: this.activeTabId,
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
      nextActionTime: this.nextActionTime,
      lastAIAction: this.decisionEngine ? this.decisionEngine.lastAIAction : null
    };
  }

  /**
   * Load bot configuration from chrome.storage.local
   */
  async loadConfig() {
    try {
      // Per-server config when serverKey is set
      if (this.serverKey && typeof self.TravianStorage !== 'undefined' && self.TravianStorage.getServerConfig) {
        this.config = await self.TravianStorage.getServerConfig(this.serverKey);
        console.log('[BotEngine] Config loaded for server: ' + this.serverKey);
        return;
      }

      // Fallback to legacy single-key config
      if (typeof chrome === 'undefined' || !chrome.storage) {
        console.warn('[BotEngine] chrome.storage not available, using default config');
        this.config = this._getDefaultConfig();
        return;
      }

      return new Promise((resolve) => {
        chrome.storage.local.get(['bot_config'], (result) => {
          if (chrome.runtime.lastError) {
            console.error('[BotEngine] Error loading config:', chrome.runtime.lastError.message);
            this.config = this._getDefaultConfig();
            resolve();
            return;
          }

          if (result.bot_config) {
            this.config = result.bot_config;
            console.log('[BotEngine] Config loaded from storage');
          } else {
            this.config = this._getDefaultConfig();
            console.log('[BotEngine] No saved config found, using defaults');
          }
          resolve();
        });
      });
    } catch (err) {
      console.error('[BotEngine] Failed to load config:', err);
      this.config = this._getDefaultConfig();
    }
  }

  /**
   * Persist current bot state to chrome.storage.local
   */
  async saveState() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;

      const state = {
        stats: this.stats,
        taskQueue: this.taskQueue.getAll(),
        actionsThisHour: this.actionsThisHour,
        hourResetTime: this.hourResetTime,
        lastFarmTime: this._lastFarmTime || 0,
        wasRunning: this.running,
        savedAt: Date.now()
      };

      // Per-server state when serverKey is set
      if (this.serverKey && typeof self.TravianStorage !== 'undefined' && self.TravianStorage.saveServerState) {
        await self.TravianStorage.saveServerState(this.serverKey, state);
        console.log('[BotEngine] State saved for server: ' + this.serverKey);
        return;
      }

      // Fallback to legacy single key
      return new Promise((resolve) => {
        chrome.storage.local.set({ 'bot_state': state }, () => {
          if (chrome.runtime.lastError) {
            console.error('[BotEngine] Error saving state:', chrome.runtime.lastError.message);
          } else {
            console.log('[BotEngine] State saved');
          }
          resolve();
        });
      });
    } catch (err) {
      console.error('[BotEngine] Failed to save state:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get default bot configuration
   * @returns {object}
   */
  _getDefaultConfig() {
    return {
      // Feature toggles
      autoUpgradeResources: true,
      autoUpgradeBuildings: false,
      autoTrainTroops: false,
      autoFarm: false,

      // Resource upgrade settings
      resourceConfig: {
        maxLevel: 10
      },

      // Building upgrade settings
      buildingConfig: {
        maxLevel: 10,
        priorityList: ['granary', 'warehouse', 'barracks', 'marketplace']
      },

      // Troop training settings
      troopConfig: {
        defaultTroopType: 'infantry',
        trainCount: 5,
        trainingBuilding: 'barracks',
        minResourceThreshold: {
          wood: 500,
          clay: 500,
          iron: 500,
          crop: 300
        }
      },

      // Farming settings
      farmConfig: {
        intervalMs: 300000,  // 5 minutes
        minTroops: 10,
        useRallyPointFarmList: true,  // Use rally point farm lists (tt=99)
        targets: []                   // Legacy coordinate targets
      },

      // Safety settings
      safetyConfig: {
        maxActionsPerHour: 60
      },

      // Delay settings (milliseconds)
      delays: {
        minActionDelay: 2000,   // Minimum delay between actions
        maxActionDelay: 8000,   // Maximum delay between actions
        loopActiveMs: 45000,    // Loop interval when active (30-120s range with jitter)
        loopIdleMs: 180000      // Loop interval when idle (60-300s range with jitter)
      }
    };
  }

  /**
   * Wait until the content script in the active tab is ready and responding.
   * Used after page-reload navigations (clicking links that cause full page load)
   * to avoid sending messages before the new content script has registered.
   *
   * @param {number} maxWaitMs - Maximum time to wait (default 10000ms)
   * @returns {Promise<boolean>} true if content script responded, false if timed out
   */
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
            console.log('[BotEngine] Content script ready after ' + attempts + ' attempts (' + (Date.now() - start) + 'ms)');
          }
          return true;
        }
      } catch (e) {
        // Content script not ready yet — retry after a short wait
      }
      await new Promise(function (r) { setTimeout(r, 1000); });
    }

    console.warn('[BotEngine] Content script not ready after ' + maxWaitMs + 'ms (' + attempts + ' attempts)');
    return false;
  }

  /**
   * Wait a random delay between configured min and max.
   * Simulates human-like pauses between actions.
   * @returns {Promise<void>}
   */
  _randomDelay() {
    const minDelay = (this.config && this.config.delays && this.config.delays.minActionDelay) || 2000;
    const maxDelay = (this.config && this.config.delays && this.config.delays.maxActionDelay) || 8000;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    return new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Get the appropriate cooldown duration for a task type.
   * Prevents the decision engine from re-creating the same task too quickly.
   *
   * @param {string} taskType
   * @returns {number} Cooldown in milliseconds
   */
  _getCooldownForType(taskType) {
    switch (taskType) {
      case 'upgrade_resource':
      case 'upgrade_building':
        return 60000;     // 1 minute cooldown after building/resource upgrade
      case 'train_troops':
        return 120000;    // 2 minutes cooldown after troop training
      case 'build_traps':
        return 120000;    // 2 minutes cooldown after trap building
      case 'send_farm':
      case 'send_attack':
        return 300000;    // 5 minutes cooldown after farm/attack send
      case 'send_hero_adventure':
        return 180000;    // 3 minutes cooldown after hero adventure
      default:
        return 30000;     // 30 seconds default cooldown
    }
  }

  /**
   * Get the main loop interval based on config.
   * @returns {number} Interval in milliseconds
   */
  _getLoopInterval() {
    return (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
  }

  /**
   * Navigate back to dorf1 (resource overview) after completing a task.
   * Skips if the task already ends on dorf1, or if task is just navigation.
   *
   * @param {string} taskType - The task type that just finished
   */
  async _returnHome(taskType) {
    // Tasks that already end on or near dorf1 — no need to navigate
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
      console.log('[BotEngine] Returned to dorf1');
    } catch (err) {
      // Non-critical — just log and continue
      console.warn('[BotEngine] Failed to return to dorf1:', err.message);
    }
  }

  /**
   * Check if a failure reason means retrying is hopeless.
   * @param {string} reason - Error reason code from content script
   * @returns {boolean}
   */
  _isHopelessFailure(reason) {
    const hopeless = [
      'no_adventure',       // No adventures available, won't change by retrying
      'hero_unavailable',   // Hero is away/dead
      'insufficient_resources', // Can't afford — retrying immediately won't help
      'queue_full',         // Build queue full — must wait for current build
      'building_not_available', // Building doesn't exist for this tribe/level
      'no_items'            // No hero items to use
    ];
    return hopeless.indexOf(reason) !== -1;
  }

  /**
   * Get a longer cooldown when a task fails for a known reason.
   * Prevents decision engine from recreating the same failing task.
   * @param {string} reason
   * @param {string} taskType
   * @returns {number} Cooldown in ms
   */
  _getFailCooldownForReason(reason, taskType) {
    switch (reason) {
      case 'no_adventure':
        return 600000;   // 10 min — adventures reset slowly
      case 'hero_unavailable':
        return 300000;   // 5 min — hero may return
      case 'insufficient_resources':
        return 180000;   // 3 min — wait for production
      case 'queue_full':
        return 120000;   // 2 min — wait for current build
      case 'building_not_available':
        return 300000;   // 5 min — might be timing issue, retry
      default:
        return 60000;    // 1 min default
    }
  }

  /**
   * When an upgrade fails due to insufficient resources, try claiming
   * hero inventory resource items as a fallback.
   * @param {object} failedTask - The task that failed
   */
  async _tryClaimHeroResources(failedTask) {
    try {
      // Pre-check: hero must be at home (not on adventure or dead)
      const heroStatus = this.gameState?.hero;
      if (heroStatus && (heroStatus.isAway || heroStatus.isDead)) {
        TravianLogger.log('INFO', '[BotEngine] Hero not available for resource claim — skipping');
        return false;
      }

      TravianLogger.log('INFO', '[BotEngine] Attempting to claim hero inventory resources...');

      // Calculate deficit: what resources are we short of?
      // Must know the exact deficit BEFORE navigating — if we can't calculate it,
      // skip entirely to avoid the dialog default (fills warehouse to max capacity).
      const deficit = this._calcResourceDeficit(failedTask);
      if (!deficit) {
        TravianLogger.log('WARN', '[BotEngine] Cannot calculate resource deficit — skipping hero claim to avoid waste');
        return false;
      }
      TravianLogger.log('DEBUG', '[BotEngine] Resource deficit: ' + JSON.stringify(deficit));

      // Step 1: Navigate to hero page (causes page reload)
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
      });
      await this._randomDelay();
      // Wait for hero page content script to be ready
      var heroReady = await this._waitForContentScript(10000);
      if (!heroReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero page did not load in time');
        return false;
      }

      // Step 2: Navigate to inventory tab (causes page reload)
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
      });
      await this._randomDelay();
      // Wait for inventory page content script to be ready
      var invReady = await this._waitForContentScript(10000);
      if (!invReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory page did not load in time');
        return false;
      }

      // Step 3: Scan inventory items
      const scanResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'scanHeroInventory', params: {}
      });

      if (!scanResult || !scanResult.success || !scanResult.data) {
        TravianLogger.log('WARN', '[BotEngine] No hero inventory data');
        return false;
      }

      // Robust data extraction: scanResult.data may contain items directly
      // or nested under scanResult.data.data (double-wrapped response)
      const rawData = scanResult.data || {};
      const items = rawData.items || (rawData.data && rawData.data.items) || [];
      if (items.length === 0) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory scan returned no items');
        return false;
      }

      const usableResources = items.filter(item => item.isResource && item.hasUseButton);

      if (usableResources.length === 0) {
        TravianLogger.log('INFO', '[BotEngine] No claimable resource items in hero inventory');
        return false;
      }

      // Map item class to resource type.
      // In Travian Legends, hero resource items are resource POOLS, not individual crates.
      // item.count = total resource amount stored (e.g., 21909 wood).
      // The dialog input asks for RESOURCE AMOUNT to transfer (not number of items).
      // So we pass the raw deficit directly as the amount.
      const itemClassToRes = {
        item145: 'wood', item176: 'wood',
        item146: 'clay', item177: 'clay',
        item147: 'iron', item178: 'iron',
        item148: 'crop', item179: 'crop'
      };

      let claimed = false;
      for (const item of usableResources) {
        // Determine resource type from itemClass
        let resType = null;
        const cls = item.itemClass || '';
        for (const [pattern, type] of Object.entries(itemClassToRes)) {
          if (cls.indexOf(pattern) !== -1) { resType = type; break; }
        }
        if (!resType) continue;

        // Calculate exact amount needed for THIS resource type
        const needed = deficit[resType] || 0;
        if (needed <= 0) {
          TravianLogger.log('DEBUG', `[BotEngine] Skipping ${resType} — not short`);
          continue; // don't need this resource type
        }

        // Cap at available amount (don't try to transfer more than hero has)
        const available = parseInt(item.count) || 0;
        const transferAmount = Math.min(Math.ceil(needed), available);
        if (transferAmount <= 0) {
          TravianLogger.log('DEBUG', `[BotEngine] Skipping ${resType} — hero has none available`);
          continue;
        }

        TravianLogger.log('INFO', `[BotEngine] Claiming ${transferAmount} ${resType} from hero (deficit=${Math.ceil(needed)}, heroHas=${available})`);

        const useResult = await this.sendToContentScript({
          type: 'EXECUTE', action: 'useHeroItem',
          params: { itemIndex: item.index, amount: transferAmount }
        });

        if (useResult && useResult.success) {
          TravianLogger.log('INFO', `[BotEngine] ${resType} claimed (${transferAmount} resources)`);
          claimed = true;
        } else {
          TravianLogger.log('WARN', `[BotEngine] Failed to claim ${resType} from hero`);
        }

        await this._randomDelay();
      }

      if (claimed) {
        TravianLogger.log('INFO', '[BotEngine] Hero resource(s) claimed successfully');
      }
      return claimed;
    } catch (err) {
      TravianLogger.log('WARN', '[BotEngine] Hero resource claim failed: ' + err.message);
      return false;
    }
  }

  /**
   * Check if hero resources should be proactively claimed.
   * Triggers when any resource is below 30% of warehouse capacity,
   * hero is at home, and cooldown has elapsed.
   */
  _shouldProactivelyClaimHero() {
    // Cooldown check
    if (this._heroClaimCooldown && Date.now() < this._heroClaimCooldown) return false;

    // Hero must be home
    const hero = this.gameState && this.gameState.hero;
    if (hero && (hero.isAway || hero.isDead)) return false;

    const res = this.gameState && this.gameState.resources;
    const cap = this.gameState && this.gameState.resourceCapacity;
    if (!res || !cap) return false;

    const wCap = cap.warehouse || 0;
    const gCap = cap.granary || wCap;
    if (wCap === 0) return false;

    // Check if any resource is below 30% of capacity
    var threshold = 0.3;
    return (res.wood || 0) < wCap * threshold ||
           (res.clay || 0) < wCap * threshold ||
           (res.iron || 0) < wCap * threshold ||
           (res.crop || 0) < gCap * threshold;
  }

  /**
   * Proactively claim hero resources to fill low resource types.
   * Navigates to hero inventory, scans items, and transfers resources
   * for any type below 50% of warehouse capacity.
   * @returns {boolean} true if any resources were claimed
   */
  async _proactiveHeroClaim() {
    try {
      const res = this.gameState.resources;
      const cap = this.gameState.resourceCapacity;
      const wCap = cap.warehouse || 800;
      const gCap = cap.granary || wCap;
      const targetFill = 0.5; // fill to 50% of capacity

      // Calculate how much of each resource we need to reach targetFill
      const deficit = {
        wood: Math.max(0, Math.floor(wCap * targetFill) - (res.wood || 0)),
        clay: Math.max(0, Math.floor(wCap * targetFill) - (res.clay || 0)),
        iron: Math.max(0, Math.floor(wCap * targetFill) - (res.iron || 0)),
        crop: Math.max(0, Math.floor(gCap * targetFill) - (res.crop || 0))
      };

      const totalDeficit = deficit.wood + deficit.clay + deficit.iron + deficit.crop;
      if (totalDeficit <= 0) return false;

      TravianLogger.log('DEBUG', '[BotEngine] Proactive hero claim deficit: ' + JSON.stringify(deficit));

      // Step 1: Navigate to hero page
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
      });
      await this._randomDelay();
      var heroReady = await this._waitForContentScript(10000);
      if (!heroReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero page did not load for proactive claim');
        return false;
      }

      // Step 2: Navigate to inventory tab
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
      });
      await this._randomDelay();
      var invReady = await this._waitForContentScript(10000);
      if (!invReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory did not load for proactive claim');
        return false;
      }

      // Step 3: Scan inventory
      const scanResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'scanHeroInventory', params: {}
      });
      if (!scanResult || !scanResult.success || !scanResult.data) {
        TravianLogger.log('WARN', '[BotEngine] No hero inventory data for proactive claim');
        return false;
      }
      const rawData = scanResult.data || {};
      const items = rawData.items || (rawData.data && rawData.data.items) || [];
      const usableResources = items.filter(item => item.isResource && item.hasUseButton);
      if (usableResources.length === 0) {
        TravianLogger.log('INFO', '[BotEngine] No hero resource items for proactive claim');
        return false;
      }

      // Step 4: Claim resources for each type with deficit
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

        const needed = deficit[resType] || 0;
        if (needed <= 0) continue;

        const available = parseInt(item.count) || 0;
        const transferAmount = Math.min(Math.ceil(needed), available);
        if (transferAmount <= 0) continue;

        TravianLogger.log('INFO', `[BotEngine] Proactive claim: ${transferAmount} ${resType} (deficit=${needed}, heroHas=${available})`);

        const useResult = await this.sendToContentScript({
          type: 'EXECUTE', action: 'useHeroItem',
          params: { itemIndex: item.index, amount: transferAmount }
        });

        if (useResult && useResult.success) {
          TravianLogger.log('INFO', `[BotEngine] Proactive claim: ${resType} transferred (${transferAmount})`);
          claimed = true;
        } else {
          TravianLogger.log('WARN', `[BotEngine] Proactive claim: ${resType} failed`);
        }
        await this._randomDelay();
      }

      if (claimed) {
        TravianLogger.log('INFO', '[BotEngine] Proactive hero resource claim completed');
      }
      return claimed;
    } catch (err) {
      TravianLogger.log('WARN', '[BotEngine] Proactive hero claim error: ' + err.message);
      return false;
    }
  }

  /**
   * Calculate how much of each resource we're short of for a failed task.
   * Uses TravianGameData to look up building costs and compares with current resources.
   * @param {object} task - The failed task
   * @returns {object|null} { wood, clay, iron, crop } deficit (positive = need more), or null if can't calculate
   */
  _calcResourceDeficit(task) {
    try {
      const GameData = typeof self !== 'undefined' && self.TravianGameData;
      if (!GameData || !this.gameState || !this.gameState.resources) return null;

      const current = this.gameState.resources;
      let cost = null;

      if (task.type === 'build_new' && task.params && task.params.gid) {
        // New building: level 0 → 1
        const key = GameData.gidToKey(Number(task.params.gid));
        if (key) cost = GameData.getUpgradeCost(key, 0);

      } else if (task.type === 'upgrade_resource' && task.params) {
        // Upgrade resource field: params have { fieldId } — look up from gameState
        // Note: domScanner.getResourceFields returns { id, type, level } but no gid.
        // We map type back to gid: wood→1, clay→2, iron→3, crop→4.
        const resTypeToGid = { wood: 1, clay: 2, iron: 3, crop: 4 };
        const fieldId = task.params.fieldId || task.params.slot;
        let gid = task.params.gid; // may exist in some cases
        let level = task.params.level || 0;

        // Look up field in gameState.resourceFields (from domScanner.getFullState)
        const fieldArray = this.gameState.resourceFields || this.gameState.resources_fields || [];
        if (!gid && fieldId && fieldArray.length > 0) {
          const field = fieldArray.find(function (f) {
            return f.id == fieldId || f.position == fieldId;
          });
          if (field) {
            // field.type is "wood"/"clay"/"iron"/"crop", convert to gid
            gid = field.gid || resTypeToGid[field.type] || null;
            level = field.level || 0;
          }
        }

        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }

      } else if (task.type === 'upgrade_building' && task.params) {
        // Upgrade building: params have { slot } — look up gid from gameState
        const slot = task.params.slot || task.params.buildingSlot;
        let gid = task.params.gid || task.params.buildingGid;
        let level = task.params.level || task.params.currentLevel || 0;

        if (!gid && slot && this.gameState.buildings) {
          // Note: domScanner.getBuildings returns { id: gid, slot: slotId }
          // where 'id' is the building type (gid), not the slot number.
          // Match by slot only to avoid false matches.
          const building = this.gameState.buildings.find(function (b) {
            return b.slot == slot;
          });
          if (building) {
            gid = building.id; // building.id IS the gid (building type)
            level = building.level || 0;
          }
        }

        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }
      }

      if (!cost) {
        console.log('[BotEngine] _calcResourceDeficit: could not determine cost for', task.type, JSON.stringify(task.params));
        return null;
      }

      const deficit = {
        wood: Math.max(0, (cost.wood || 0) - (current.wood || 0)),
        clay: Math.max(0, (cost.clay || 0) - (current.clay || 0)),
        iron: Math.max(0, (cost.iron || 0) - (current.iron || 0)),
        crop: Math.max(0, (cost.crop || 0) - (current.crop || 0))
      };
      console.log('[BotEngine] _calcResourceDeficit: cost=' + JSON.stringify(cost) + ' current=' + JSON.stringify(current) + ' deficit=' + JSON.stringify(deficit));
      return deficit;
    } catch (e) {
      console.warn('[BotEngine] _calcResourceDeficit error:', e.message);
      return null;
    }
  }

  /**
   * Adjust the main loop interval based on current activity level.
   * @param {'active'|'idle'} mode
   */
  _adjustLoopInterval(mode) {
    const activeMs = (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
    const idleMs = (this.config && this.config.delays && this.config.delays.loopIdleMs) || 180000;

    const targetMs = mode === 'idle' ? idleMs : activeMs;

    // Track when the next action will happen (for UI countdown)
    this.nextActionTime = Date.now() + targetMs;

    // Only reschedule if the interval actually changed
    const currentStatus = this.scheduler.getStatus();
    const mainLoop = currentStatus['main_loop'];
    if (mainLoop && mainLoop.intervalMs !== targetMs) {
      this.scheduler.reschedule('main_loop', targetMs);
    }
  }
}

// Export for service worker context
self.TravianBotEngine = BotEngine;
