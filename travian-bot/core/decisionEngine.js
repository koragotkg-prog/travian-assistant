/**
 * DecisionEngine - Strategy-powered decision engine for Travian Bot
 *
 * Integrates with the Strategy Engine (strategy/) for ROI-based build
 * optimization, phase-aware troop planning, and risk assessment.
 * Falls back to simple heuristics when strategy modules aren't available.
 *
 * Runs in service worker context (no DOM, no window)
 * Exported via self.TravianDecisionEngine
 */

class DecisionEngine {
  constructor() {
    /** @type {Array<Function>} Custom rule functions */
    this.rules = [];

    /** @type {number} Timestamp of last decision cycle */
    this.lastDecisionTime = 0;

    /** @type {Map<string, number>} Cooldown map: actionType -> expiresAt timestamp */
    this.cooldowns = new Map();

    /** @type {object|null} Cached strategy analysis (refreshed each cycle) */
    this.lastAnalysis = null;

    /** @type {object|null} Last AI-scored action for popup display */
    this.lastAIAction = null;

    /** @type {string} Detected game phase */
    this.currentPhase = 'early';

    /** @type {Array<object>} Last prerequisite resolution results for UI display */
    this.lastPrereqResolutions = [];

    // Initialize strategy modules (loaded via importScripts before this file)
    this.strategyEngine = null;
    this.buildOptimizer = null;
    this.militaryPlanner = null;
    this.actionScorer = null;

    try {
      if (typeof self !== 'undefined') {
        if (self.TravianStrategyEngine) this.strategyEngine = new self.TravianStrategyEngine();
        if (self.TravianBuildOptimizer) this.buildOptimizer = new self.TravianBuildOptimizer();
        if (self.TravianMilitaryPlanner) this.militaryPlanner = new self.TravianMilitaryPlanner();
        if (self.TravianActionScorer) this.actionScorer = new self.TravianActionScorer();
      }
      if (this.actionScorer) {
        console.log('[DecisionEngine] ActionScorer integrated — hybrid AI scoring enabled');
      }
      if (this.strategyEngine) {
        console.log('[DecisionEngine] Strategy Engine integrated');
      } else {
        console.warn('[DecisionEngine] Strategy Engine not available, using fallback logic');
      }
    } catch (err) {
      console.warn('[DecisionEngine] Failed to init strategy modules:', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Main evaluation entry point
  // ---------------------------------------------------------------------------

  /**
   * Evaluate the current game state and produce tasks.
   *
   * When strategy engine is available:
   *  1. Safety checks (captcha, errors) → emergency stop
   *  2. Run full strategy analysis → ROI-ranked recommendations
   *  3. Convert top recommendations into executable tasks
   *  4. Apply user config filters (upgradeTargets, feature toggles)
   *
   * Fallback (no strategy engine): same logic as before.
   */
  evaluate(gameState, config, taskQueue) {
    const newTasks = [];
    this.lastDecisionTime = Date.now();

    if (!gameState || !config) {
      console.warn('[DecisionEngine] Missing gameState or config, skipping evaluation');
      return newTasks;
    }

    // 1. Safety checks — always first, independent of strategy engine
    if (gameState.captcha || gameState.error) {
      newTasks.push({
        type: 'emergency_stop',
        params: {
          reason: gameState.captcha ? 'Captcha detected' : 'Error detected',
          details: ''
        },
        priority: 1,
        villageId: null
      });
      return newTasks;
    }

    // 2a. Construction queue check (needed by both AI and fallback paths)
    const queue = gameState.constructionQueue || { count: 0, maxCount: 1 };
    const buildQueueFull = queue.count >= queue.maxCount;

    // 2b. If ActionScorer is available, use hybrid AI scoring
    //     FIX: AI path now falls through to safety rules (cranny, new builds)
    //     instead of returning early — AI complements safety, not replaces it.
    let aiHandledUpgradeOrTrain = false;
    if (this.actionScorer && config.useAIScoring !== false) {
      const scoredActions = this.actionScorer.scoreAll(gameState, config, taskQueue);

      // FIX: Filter out actions that are on cooldown — AI path previously bypassed this
      const available = scoredActions.filter(a => !this.isCoolingDown(a.type));

      if (available.length > 0) {
        // FIX: Try runner-up actions if top-scored is already queued
        for (const action of available) {
          if (!taskQueue.hasAnyTaskOfType(action.type)) {
            TravianLogger.log('INFO', `[AI] Best action: ${action.type} (score: ${action.score.toFixed(1)}) — ${action.reason}`);
            this.lastAIAction = { type: action.type, score: action.score, reason: action.reason };
            newTasks.push({
              type: action.type,
              params: action.params,
              priority: Math.max(1, 10 - Math.floor(action.score / 5)),
              villageId: gameState.currentVillageId || null
            });
            aiHandledUpgradeOrTrain = true;
            break;
          }
        }
      }

      // FALL THROUGH to safety rules below (cranny, new builds, farming, hero)
      // AI handles scoring for upgrades/troops, but safety rules always run.
    }

    // 4. Run strategy analysis (if available)
    if (this.strategyEngine) {
      try {
        this.lastAnalysis = this.strategyEngine.analyze({
          tribe: config.tribe || 'gaul',
          serverSpeed: config.serverSpeed || 1,
          gameDay: config.gameDay || this._estimateGameDay(),
          villageCount: config.villageCount || (gameState.villages ? gameState.villages.length : 1),
          totalPopulation: config.totalPopulation || 0,
          armySize: this._countTroops(gameState),
          threatLevel: config.threatLevel || 0,
          villageState: {
            resourceFields: gameState.resourceFields || [],
            buildings: gameState.buildings || [],
            resources: gameState.resources || {},
            production: gameState.resourceProduction || gameState.production || {},
            storage: this._extractStorage(gameState),
            troops: gameState.troops || {},
          },
          origin: config.origin || { x: 0, y: 0 },
          enemies: config.enemies || [],
        });
        this.currentPhase = this.lastAnalysis.phaseDetection.phase;
      } catch (err) {
        console.warn('[DecisionEngine] Strategy analysis failed:', err.message);
        this.lastAnalysis = null;
      }
    }

    // 4.5. Cranny protection rule: cranny must be >= warehouse level
    //       This runs BEFORE normal upgrades so it takes priority
    if (!buildQueueFull && !this.isCoolingDown('upgrade_building') && !this.isCoolingDown('build_new')) {
      const crannyTask = this._evaluateCrannyRule(gameState, config, taskQueue);
      if (crannyTask) {
        newTasks.push(crannyTask);
      }
    }

    // 4.6. New building construction from user's empty-slot selections
    if (!buildQueueFull && !this.isCoolingDown('build_new')) {
      const buildNewTask = this._evaluateNewBuilds(gameState, config, taskQueue);
      if (buildNewTask) {
        newTasks.push(buildNewTask);
      }
    }

    // 5. Upgrade decisions (resources + buildings) — skip if AI already queued one
    if (!aiHandledUpgradeOrTrain) {
      const autoRes = config.autoUpgradeResources || config.autoResourceUpgrade;
      const autoBld = config.autoUpgradeBuildings || config.autoBuildingUpgrade;
      if ((autoRes || autoBld) && !buildQueueFull &&
          !this.isCoolingDown('upgrade_resource') && !this.isCoolingDown('upgrade_building')) {
        const upgradeTask = this.evaluateUpgrades(gameState, config, autoRes, autoBld);
        if (upgradeTask && !taskQueue.hasTaskOfType(upgradeTask.type, upgradeTask.villageId)) {
          newTasks.push(upgradeTask);
        }
      }
    }

    // 6. Troop training — skip if AI already queued one
    if (!aiHandledUpgradeOrTrain) {
      if ((config.autoTrainTroops || config.autoTroopTraining) && !this.isCoolingDown('train_troops')) {
        const troopTask = this.evaluateTroopTraining(gameState, config);
        if (troopTask && !taskQueue.hasTaskOfType('train_troops', troopTask.villageId)) {
          newTasks.push(troopTask);
        }
      }
    }

    // 7. Hero adventure
    if ((config.autoHeroAdventure) && !this.isCoolingDown('send_hero_adventure')) {
      const heroTask = this.evaluateHeroAdventure(gameState, config);
      if (heroTask && !taskQueue.hasTaskOfType('send_hero_adventure', heroTask.villageId)) {
        newTasks.push(heroTask);
      }
    }

    // 8. Farming
    if ((config.autoFarm || config.autoFarming) && !this.isCoolingDown('send_farm')) {
      const farmTasks = this.evaluateFarming(gameState, config);
      if (farmTasks && farmTasks.length > 0) {
        for (const ft of farmTasks) {
          if (!taskQueue.hasTaskOfType('send_farm', ft.villageId)) {
            newTasks.push(ft);
          }
        }
      }
    }

    // Run custom rules
    for (const rule of this.rules) {
      try {
        const result = rule(gameState, config, taskQueue);
        if (result) {
          const tasks = Array.isArray(result) ? result : [result];
          newTasks.push(...tasks);
        }
      } catch (err) {
        console.error('[DecisionEngine] Custom rule error:', err);
      }
    }

    return newTasks;
  }

  // ---------------------------------------------------------------------------
  // Strategy-powered upgrade evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate what to upgrade next using ROI-based strategy engine.
   *
   * Priority order:
   *  1. User-configured upgradeTargets (checkbox + target level from popup)
   *  2. Strategy engine ROI ranking (if available)
   *  3. Fallback: lowest-level field/building up to level 10
   */
  evaluateUpgrades(state, config, autoRes, autoBld) {
    const targets = config.upgradeTargets || {};
    const hasTargets = Object.keys(targets).length > 0;

    // --- Strategy-engine path: use ROI ranking ---
    if (this.buildOptimizer) {
      return this._strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets);
    }

    // --- Fallback path: simple lowest-level logic ---
    return this._fallbackUpgrade(state, config, autoRes, autoBld, targets, hasTargets);
  }

  /**
   * Strategy-engine upgrade: rank all upgrades by ROI/utility, then filter by
   * user config (upgradeTargets) and pick the best affordable one.
   */
  _strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets) {
    const villageState = {
      resourceFields: state.resourceFields || [],
      buildings: state.buildings || [],
      resources: state.resources || {},
      production: state.resourceProduction || state.production || {},
      storage: this._extractStorage(state),
    };

    // Get ROI-ranked candidates from build optimizer
    const ranked = this.buildOptimizer.rankUpgrades(villageState, this.currentPhase, 20);

    for (const candidate of ranked) {
      // Filter by feature toggles
      if (candidate.type === 'upgrade_resource' && !autoRes) continue;
      if (candidate.type === 'upgrade_building' && !autoBld) continue;

      // Filter by user-configured targets (if any)
      if (hasTargets) {
        const slotKey = String(candidate.slot);
        const target = targets[slotKey];
        if (!target || !target.enabled) continue;
        if (candidate.fromLevel >= target.targetLevel) continue;
      }

      // Skip items currently upgrading
      const isUpgrading = this._isSlotUpgrading(state, candidate.slot, candidate.type);
      if (isUpgrading) continue;

      // Skip slots with active per-slot cooldown (e.g., this slot failed recently)
      if (this.isSlotCoolingDown(candidate.type, candidate.slot)) continue;

      // Skip if not affordable (let the game's green button decide, but skip obviously too expensive)
      // We don't strictly enforce affordability — the bot will click and the game handles it
      // But if strategy says not affordable, log it
      if (!candidate.affordable) {
        console.log('[DecisionEngine] Best ROI pick not affordable yet: ' +
          candidate.buildingKey + ' slot ' + candidate.slot + ' (score: ' + candidate.score + ')');
        // Still try it — if no affordable picks, skip
        continue;
      }

      const params = candidate.type === 'upgrade_resource'
        ? { fieldId: candidate.slot }
        : { slot: candidate.slot };

      console.log('[DecisionEngine] Strategy pick: ' + candidate.buildingKey +
        ' slot ' + candidate.slot + ' Lv.' + candidate.fromLevel + '→' + (candidate.fromLevel + 1) +
        ' (ROI score: ' + candidate.score + ', reason: ' + candidate.reason + ')');

      return {
        type: candidate.type,
        params: params,
        priority: candidate.type === 'upgrade_resource' ? 3 : 4,
        villageId: state.currentVillageId || null
      };
    }

    // If no affordable candidate with targets, try without target filter
    if (hasTargets) {
      for (const candidate of ranked) {
        if (candidate.type === 'upgrade_resource' && !autoRes) continue;
        if (candidate.type === 'upgrade_building' && !autoBld) continue;
        if (!candidate.affordable) continue;
        if (this._isSlotUpgrading(state, candidate.slot, candidate.type)) continue;

        // This candidate isn't in targets — skip (user didn't select it)
        // Actually, respect user choices: if they have targets, only build those
        break;
      }
    }

    return null;
  }

  /**
   * Fallback upgrade logic: picks lowest-level candidate.
   * Used when strategy engine is not available.
   */
  _fallbackUpgrade(state, config, autoRes, autoBld, targets, hasTargets) {
    const candidates = [];

    // Resource fields
    if (autoRes && state.resourceFields && state.resourceFields.length > 0) {
      for (const field of state.resourceFields) {
        if (!field.id || field.id <= 0) continue;
        if (field.upgrading) continue;
        if (this.isSlotCoolingDown('upgrade_resource', field.id)) continue;

        const key = String(field.id);
        const target = targets[key];

        if (hasTargets) {
          if (!target || !target.enabled) continue;
          if ((field.level || 0) >= target.targetLevel) continue;
        } else {
          if ((field.level || 0) >= 10) continue;
        }

        candidates.push({
          type: 'upgrade_resource',
          slot: field.id,
          level: field.level || 0,
          priority: 3,
          params: { fieldId: field.id }
        });
      }
    }

    // Buildings
    if (autoBld && state.buildings && state.buildings.length > 0) {
      for (const building of state.buildings) {
        if (!building.slot || building.slot <= 0) continue;
        if (building.upgrading) continue;
        if (this.isSlotCoolingDown('upgrade_building', building.slot)) continue;

        const key = String(building.slot);
        const target = targets[key];

        if (hasTargets) {
          if (!target || !target.enabled) continue;
          if ((building.level || 0) >= target.targetLevel) continue;
        } else {
          if ((building.level || 0) >= 10) continue;
        }

        candidates.push({
          type: 'upgrade_building',
          slot: building.slot,
          level: building.level || 0,
          priority: 4,
          params: { slot: building.slot }
        });
      }
    }

    if (candidates.length === 0) return null;

    const best = candidates.reduce((a, b) => (a.level <= b.level) ? a : b);

    return {
      type: best.type,
      params: best.params,
      priority: best.priority,
      villageId: state.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // Strategy-powered troop training
  // ---------------------------------------------------------------------------

  /**
   * Evaluate whether troops should be trained.
   * Uses military planner for phase-aware recommendations when available.
   */
  evaluateTroopTraining(state, config) {
    if (!config.troopConfig) return null;

    const currentResources = state.resources;
    if (!currentResources) return null;

    // Check minimum resource threshold
    const minThreshold = config.troopConfig.minResourceThreshold || {
      wood: 500, clay: 500, iron: 500, crop: 300
    };

    if (currentResources.wood < minThreshold.wood ||
        currentResources.clay < minThreshold.clay ||
        currentResources.iron < minThreshold.iron ||
        currentResources.crop < minThreshold.crop) {
      return null;
    }

    // Read from v2 slots config (popup saves slots array, not flat fields)
    const slots = config.troopConfig.slots;
    const firstSlot = (Array.isArray(slots) && slots.length > 0) ? slots[0] : null;
    // v2 slot fields: troopType ('t4'), building ('stable'), batchSize (3)
    // v1 legacy fields: defaultTroopType, trainCount, trainingBuilding
    const userTroopType = (firstSlot && firstSlot.troopType) || config.troopConfig.defaultTroopType || null;
    const userBatchSize = (firstSlot && firstSlot.batchSize) || config.troopConfig.trainCount || 5;
    const userBuilding = (firstSlot && firstSlot.building) || config.troopConfig.trainingBuilding || 'barracks';

    // Strategy-powered: use military planner for troop type recommendation
    if (this.militaryPlanner && config.tribe) {
      try {
        const plan = this.militaryPlanner.troopProductionPlan(
          config.tribe,
          this.currentPhase,
          config.threatLevel || 0,
          currentResources
        );

        if (plan && plan.primaryUnit && plan.affordableCount > 0) {
          const trainCount = Math.min(userBatchSize, plan.affordableCount);

          console.log('[DecisionEngine] Troop plan: ' + plan.primaryUnit +
            ' x' + trainCount + ' (' + plan.reasoning.join('; ') + ')');

          // If user has a specific troop type configured, use theirs; otherwise use strategy
          const useStrategyUnit = !userTroopType;
          let finalTroopType = useStrategyUnit ? plan.primaryUnit : userTroopType;
          const finalBuilding = useStrategyUnit
            ? this._getTroopBuilding(plan.primaryUnit, config.tribe)
            : userBuilding;

          // Convert strategy unit name (e.g. 'theutatesThunder') to DOM input name ('t4')
          if (useStrategyUnit) {
            var GD = (typeof self !== 'undefined' && self.TravianGameData) ? self.TravianGameData : null;
            if (GD && GD.getInputName) {
              var inputName = GD.getInputName(config.tribe, finalTroopType);
              if (inputName) {
                finalTroopType = inputName;
              } else {
                console.warn('[DecisionEngine] Cannot map unit ' + finalTroopType + ' to input name for tribe ' + config.tribe);
                return null;
              }
            }
          }

          return {
            type: 'train_troops',
            params: {
              troopType: finalTroopType,
              count: trainCount,
              buildingType: finalBuilding
            },
            priority: this.currentPhase === 'late' ? 4 : 6,
            villageId: state.currentVillageId || null
          };
        }
      } catch (err) {
        console.warn('[DecisionEngine] Military planner error:', err.message);
      }
    }

    // Fallback: use config values directly
    if (!userTroopType) return null; // no troop type configured at all
    return {
      type: 'train_troops',
      params: {
        troopType: userTroopType,
        count: userBatchSize,
        buildingType: userBuilding
      },
      priority: 6,
      villageId: state.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // Farming (unchanged — works well as-is)
  // ---------------------------------------------------------------------------

  evaluateFarming(state, config) {
    if (!config.farmConfig) return null;

    // Skip if farm intelligence reports all targets blacklisted/paused
    if (this._farmIntelligence) {
      var activeTargets = this._farmIntelligence.getActiveTargets();
      if (activeTargets.length === 0 && Object.keys(this._farmIntelligence._targets || {}).length > 0) {
        TravianLogger.log('DEBUG', '[DecisionEngine] Skipping farm — all targets blacklisted/paused');
        return null;
      }
    }

    const farmInterval = config.farmConfig.intervalMs || 300000;
    const lastFarmTime = state.lastFarmTime || 0;
    if (Date.now() - lastFarmTime < farmInterval) return null;

    // Skip if raids are already out
    const outgoing = state.troopMovements?.outgoing || 0;
    if (outgoing > 0) {
      TravianLogger.log('DEBUG', `[DecisionEngine] Skipping farm — ${outgoing} raids still out`);
      return null;
    }

    const minTroops = config.farmConfig.minTroops || 10;
    let totalTroops = 0;
    if (state.troops && typeof state.troops === 'object') {
      for (const name in state.troops) {
        totalTroops += state.troops[name] || 0;
      }
    }
    if (totalTroops < minTroops) return null;

    const tasks = [];
    const useRallyPointFarmList = config.farmConfig.useRallyPointFarmList !== false;

    if (useRallyPointFarmList) {
      tasks.push({
        type: 'send_farm',
        params: { farmListId: null },
        priority: 7,
        villageId: state.currentVillageId || null
      });
    }

    if (!useRallyPointFarmList) {
      const farmTargets = config.farmConfig.targets || [];
      for (const target of farmTargets) {
        if (target.x == null || target.y == null) continue;
        tasks.push({
          type: 'send_attack',
          params: {
            target: { x: parseInt(target.x, 10), y: parseInt(target.y, 10) },
            targetName: target.name || (target.x + '|' + target.y),
            troops: config.farmConfig.defaultTroops || null
          },
          priority: 7,
          villageId: state.currentVillageId || null
        });
      }
    }

    return tasks.length > 0 ? tasks : null;
  }

  // ---------------------------------------------------------------------------
  // Hero Adventure (unchanged)
  // ---------------------------------------------------------------------------

  evaluateHeroAdventure(state, config) {
    if (!state.hero) return null;

    const hero = state.hero;
    if (!hero.isHome || hero.isAway || hero.isDead) return null;
    if (!hero.hasAdventure || hero.adventureCount <= 0) return null;

    const minHealth = (config.heroConfig && config.heroConfig.minHealth) || 30;
    if (hero.health < minHealth) return null;

    return {
      type: 'send_hero_adventure',
      params: {
        adventureCount: hero.adventureCount,
        heroHealth: hero.health
      },
      priority: 5,
      villageId: state.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // Public API: get strategy analysis for popup display
  // ---------------------------------------------------------------------------

  /**
   * Get the last strategy analysis result.
   * Can be sent to the popup for displaying recommendations.
   */
  getLastAnalysis() {
    return this.lastAnalysis;
  }

  /**
   * Get current detected phase.
   */
  getPhase() {
    return this.currentPhase;
  }

  // ---------------------------------------------------------------------------
  // Cooldown management
  // ---------------------------------------------------------------------------

  /**
   * Set a cooldown for an action type or a specific slot within a type.
   * @param {string} actionType - e.g. 'upgrade_resource' or 'upgrade_resource:3'
   * @param {number} durationMs
   */
  setCooldown(actionType, durationMs) {
    this.cooldowns.set(actionType, Date.now() + durationMs);

    // ML-3 FIX: Prune expired cooldowns periodically.
    // Without this, the Map grows unbounded as new slot-specific keys are added.
    // Prune every 20 entries to keep overhead minimal.
    if (this.cooldowns.size > 20) {
      var now = Date.now();
      for (var [key, expiresAt] of this.cooldowns) {
        if (now >= expiresAt) this.cooldowns.delete(key);
      }
    }
  }

  /**
   * Check if an action type (or slot-specific key) is cooling down.
   * @param {string} actionType - e.g. 'upgrade_resource' or 'upgrade_resource:3'
   * @returns {boolean}
   */
  isCoolingDown(actionType) {
    const expiresAt = this.cooldowns.get(actionType);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      this.cooldowns.delete(actionType);
      return false;
    }
    return true;
  }

  /**
   * Check if a specific slot within an action type is cooling down.
   * Uses composite key format: 'actionType:slotId'
   * @param {string} actionType - e.g. 'upgrade_resource'
   * @param {string|number} slotId - e.g. 3 or '22'
   * @returns {boolean}
   */
  isSlotCoolingDown(actionType, slotId) {
    return this.isCoolingDown(actionType + ':' + slotId);
  }

  // ---------------------------------------------------------------------------
  // Cranny Protection Rule
  // ---------------------------------------------------------------------------

  /**
   * Evaluate cranny vs warehouse: cranny capacity must be >= warehouse capacity.
   * If cranny is lower, queue cranny upgrade.
   * If no cranny exists, queue building a new cranny in an empty slot.
   *
   * Cranny GID = 23, Warehouse GID = 10
   *
   * @returns {object|null} Task to create, or null if cranny is fine
   */
  _evaluateCrannyRule(gameState, config, taskQueue) {
    const buildings = gameState.buildings || [];

    // Find warehouse and cranny
    let warehouse = null;
    let cranny = null;
    let emptySlot = null;

    for (const b of buildings) {
      const gid = b.gid || b.id;
      if (gid === 10 && (!warehouse || (b.level || 0) > warehouse.level)) {
        warehouse = { slot: b.slot, level: b.level || 0 };
      }
      if (gid === 23 && (!cranny || (b.level || 0) > cranny.level)) {
        cranny = { slot: b.slot, level: b.level || 0 };
      }
      if (b.empty && !emptySlot) {
        emptySlot = b.slot;
      }
    }

    // No warehouse = nothing to protect against
    if (!warehouse || warehouse.level === 0) return null;

    // If cranny exists, check if it needs upgrading
    if (cranny) {
      if (cranny.level >= warehouse.level) return null; // OK, cranny is adequate
      if (cranny.level >= 10) return null; // Max cranny level

      // Cranny needs upgrading
      if (taskQueue.hasTaskOfType('upgrade_building', null) ||
          taskQueue.hasTaskOfType('upgrade_building', gameState.currentVillageId)) return null;

      console.log(`[DecisionEngine] Cranny rule: cranny Lv.${cranny.level} < warehouse Lv.${warehouse.level}, upgrading cranny`);
      return {
        type: 'upgrade_building',
        params: { slot: cranny.slot },
        priority: 2, // High priority — protection
        villageId: gameState.currentVillageId || null
      };
    }

    // No cranny exists — need to build one
    if (!emptySlot) return null; // No empty slot available

    if (taskQueue.hasTaskOfType('build_new', null) ||
        taskQueue.hasTaskOfType('build_new', gameState.currentVillageId)) return null;

    console.log(`[DecisionEngine] Cranny rule: no cranny found, building in empty slot ${emptySlot}`);
    return {
      type: 'build_new',
      params: { slot: emptySlot, gid: 23, buildingName: 'Cranny' },
      priority: 2, // High priority
      villageId: gameState.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // New Building Construction from user selections
  // ---------------------------------------------------------------------------

  /**
   * Check if any user-selected empty slots need a new building constructed.
   * Looks for upgradeTargets with isNewBuild=true and buildGid set.
   */
  _evaluateNewBuilds(gameState, config, taskQueue) {
    const targets = config.upgradeTargets || {};
    const buildings = gameState.buildings || [];
    // Reset prereq resolution tracking for this cycle
    this.lastPrereqResolutions = [];
    const villageId = gameState.currentVillageId || null;
    var GD = (typeof self !== 'undefined' && self.TravianGameData) ? self.TravianGameData : null;
    var getName = GD ? function (g) { return GD.getBuildingName(g); } : function (g) { return 'GID' + g; };

    for (const key in targets) {
      const target = targets[key];
      if (!target.isNewBuild || !target.enabled || !target.buildGid) continue;

      const slot = target.slot;
      if (!slot) continue;

      // Check if this slot is still empty in current game state
      const existing = buildings.find(b => b.slot === slot);
      if (existing && !existing.empty && (existing.gid || existing.id) !== 0) {
        // Slot is no longer empty — building already placed
        // If building level < targetLevel, let normal upgrade handle it
        continue;
      }

      // Check per-slot cooldown (this specific slot may have recently failed)
      if (this.isSlotCoolingDown('build_new', slot)) continue;

      // Check building prerequisites (e.g., Stable needs Academy 5 + Barracks 3)
      if (GD && typeof GD.checkPrerequisites === 'function') {
        var prereqResult = GD.checkPrerequisites(
          target.buildGid, buildings, gameState.resourceFields
        );
        if (!prereqResult.met) {
          // --- AUTO-RESOLVE PREREQUISITES ---
          // Instead of skipping, walk the dependency tree and return the first
          // actionable prerequisite task (build or upgrade).
          var stateReader = this._makeStateReader(gameState);
          var resolveResult = this._resolveFirstActionable(
            target.buildGid, stateReader, taskQueue, villageId,
            new Set(), 0, [target.buildGid]
          );

          // Log the resolution result with readable names
          var missingStr = prereqResult.missing.map(function (m) {
            return getName(m.gid) + ' need L' + m.need + ' (have L' + m.have + ')';
          }).join(', ');

          // Store resolution for UI display
          var resEntry = {
            targetGid: target.buildGid,
            targetName: getName(target.buildGid),
            slot: target.slot,
            missing: prereqResult.missing.map(function(m) {
              return { gid: m.gid, name: getName(m.gid), need: m.need, have: m.have };
            }),
            chain: (resolveResult.chain || []).map(function(g) { return { gid: g, name: getName(g) }; }),
            status: resolveResult.task ? 'resolving' : (resolveResult.blocked ? 'blocked' : 'waiting'),
            reason: resolveResult.reason || null,
            action: resolveResult.task ? {
              type: resolveResult.task.type,
              gid: resolveResult.task.params.gid,
              name: getName(resolveResult.task.params.gid || 0),
              slot: resolveResult.task.params.slot,
              fieldId: resolveResult.task.params.fieldId
            } : null
          };
          this.lastPrereqResolutions.push(resEntry);

          if (resolveResult.task) {
            var t = resolveResult.task;
            var chainStr = resolveResult.chain.map(getName).join(' → ');
            console.log('[DecisionEngine] Prereq resolution for ' + getName(target.buildGid) +
              ': missing [' + missingStr + '] → action: ' + t.type + ' ' +
              getName(t.params.gid || 0) + (t.params.slot ? ' slot ' + t.params.slot : '') +
              (t.params.fieldId ? ' field ' + t.params.fieldId : '') +
              ' | chain: ' + chainStr);
            return t;
          } else if (resolveResult.blocked) {
            console.log('[DecisionEngine] Prereq BLOCKED for ' + getName(target.buildGid) +
              ': ' + resolveResult.reason + ' | missing [' + missingStr + ']');
          } else {
            // reason = 'already_queued' or 'awaiting_upgrade' — silent wait
            console.log('[DecisionEngine] Prereq wait for ' + getName(target.buildGid) +
              ': ' + resolveResult.reason);
          }
          continue;
        }
      }

      // All prereqs met — queue the target build itself
      if (taskQueue.hasTaskOfType('build_new', null) ||
          taskQueue.hasTaskOfType('build_new', villageId)) continue;

      console.log('[DecisionEngine] New build: ' + getName(target.buildGid) +
        ' (GID ' + target.buildGid + ') in slot ' + slot);
      return {
        type: 'build_new',
        params: { slot: slot, gid: target.buildGid, buildingName: getName(target.buildGid) },
        priority: 3,
        villageId: villageId
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Build Prerequisite Resolution (auto-queue missing dependencies)
  // ---------------------------------------------------------------------------

  /**
   * Create a normalized StateReader from raw gameState for efficient lookups.
   * Memoizes building/resource levels so repeated DFS lookups are O(1).
   * @param {Object} gameState - Raw scan snapshot
   * @returns {Object} StateReader with lookup methods
   */
  _makeStateReader(gameState) {
    const buildings = gameState.buildings || [];
    const resourceFields = gameState.resourceFields || [];
    const resTypeToGid = { wood: 1, clay: 2, iron: 3, crop: 4 };

    // Build lookup: gid → {maxLevel, slot, upgrading}
    // Takes highest-level instance if multiple exist (e.g., multiple crannies)
    const buildingMap = new Map();
    for (const b of buildings) {
      const gid = Number(b.gid || b.id || 0);
      if (gid === 0 || b.empty) continue;
      const level = b.level || 0;
      const existing = buildingMap.get(gid);
      if (!existing || level > existing.level) {
        buildingMap.set(gid, { level, slot: b.slot, upgrading: !!b.upgrading });
      }
    }

    // Resource field lookup: gid → {maxLevel, bestFieldId}
    const resFieldMap = new Map();
    for (const rf of resourceFields) {
      const gid = Number(rf.gid || resTypeToGid[rf.type] || 0);
      if (gid === 0) continue;
      const level = rf.level || 0;
      const existing = resFieldMap.get(gid);
      if (!existing || level > existing.level) {
        resFieldMap.set(gid, { level, fieldId: rf.id || rf.position });
      }
    }

    // Collect empty slots
    const emptySlots = buildings
      .filter(b => b.empty || (b.gid || b.id) === 0)
      .map(b => b.slot)
      .filter(s => s != null);

    return {
      /** Get max level of a building by GID (0 if not built) */
      getBuildingLevel(gid) {
        if (gid <= 4) {
          // Resource fields live in dorf1, not dorf2
          const rf = resFieldMap.get(gid);
          return rf ? rf.level : 0;
        }
        const b = buildingMap.get(gid);
        return b ? b.level : 0;
      },
      /** Get building info by GID (null if not built) */
      getBuilding(gid) {
        return buildingMap.get(gid) || null;
      },
      /** Get resource field info by GID (null if not exists) */
      getResourceField(gid) {
        return resFieldMap.get(gid) || null;
      },
      /** Is a building currently being upgraded? */
      isBuildingUpgrading(gid) {
        const b = buildingMap.get(gid);
        return b ? b.upgrading : false;
      },
      /** Get all empty building slots in dorf2 */
      getEmptySlots() {
        return emptySlots;
      }
    };
  }

  /**
   * DFS resolver: find the FIRST actionable task to make progress toward building targetGid.
   *
   * Walks the prerequisite tree depth-first. For each unmet prereq:
   *   - If the prereq building doesn't exist → recurse to check ITS prereqs, then build_new
   *   - If the prereq building exists but level too low → upgrade_building / upgrade_resource
   *   - If the prereq building is currently upgrading → wait (return null task)
   *
   * @param {number} targetGid - Building GID we ultimately want
   * @param {Object} stateReader - Normalized state from _makeStateReader()
   * @param {Object} taskQueue - For dedup checks
   * @param {string|null} villageId - Current village
   * @param {Set<number>} visited - Cycle detection set (GIDs already in this DFS path)
   * @param {number} depth - Current recursion depth
   * @param {Array<number>} chain - Debug trace of GIDs walked
   * @returns {Object} ResolveResult: {blocked, reason, task, targetGid, chain}
   */
  _resolveFirstActionable(targetGid, stateReader, taskQueue, villageId, visited, depth, chain) {
    var MAX_DEPTH = 5;
    var GD = (typeof self !== 'undefined' && self.TravianGameData) ? self.TravianGameData : null;
    var getName = GD ? function (g) { return GD.getBuildingName(g); } : function (g) { return 'GID' + g; };

    // Safety: depth limit
    if (depth > MAX_DEPTH) {
      return { blocked: true, reason: 'max_depth_exceeded', task: null, targetGid: targetGid, chain: chain };
    }

    // Safety: cycle detection
    if (visited.has(targetGid)) {
      return { blocked: true, reason: 'circular_dependency', task: null, targetGid: targetGid, chain: chain };
    }
    visited.add(targetGid);

    var prereqs = (GD && GD.PREREQUISITES) ? GD.PREREQUISITES[targetGid] : null;
    if (!prereqs) prereqs = [];

    // Check each prerequisite in order (deterministic — array is ordered)
    for (var i = 0; i < prereqs.length; i++) {
      var req = prereqs[i]; // {gid, level}
      var currentLevel = stateReader.getBuildingLevel(req.gid);

      if (currentLevel >= req.level) continue; // This prereq is satisfied

      // --- This prereq is NOT met ---

      var isResourceField = req.gid <= 4;

      // Case A: Building/field doesn't exist at all (level 0)
      if (currentLevel === 0 && !isResourceField) {
        // Before we can build this prereq, check if ITS prereqs are met
        var subChain = chain.concat(req.gid);
        var subVisited = new Set(visited);
        var subResult = this._resolveFirstActionable(
          req.gid, stateReader, taskQueue, villageId, subVisited, depth + 1, subChain
        );

        if (subResult.blocked) return subResult; // Propagate impossibility
        if (subResult.task) return subResult;     // Deeper dependency found — do that first

        // All sub-prereqs met → this is the building to construct
        var emptySlots = stateReader.getEmptySlots();
        if (emptySlots.length === 0) {
          return { blocked: true, reason: 'no_empty_slot', task: null, targetGid: targetGid, chain: subChain };
        }

        // Dedup: don't queue if already queued
        if (taskQueue.hasTaskOfType('build_new', villageId) ||
            taskQueue.hasTaskOfType('build_new', null) ||
            taskQueue.hasAnyTaskOfType('build_new')) {
          return { blocked: false, reason: 'already_queued', task: null, targetGid: targetGid, chain: subChain };
        }

        return {
          blocked: false,
          reason: null,
          task: {
            type: 'build_new',
            params: {
              slot: emptySlots[0],
              gid: req.gid,
              buildingName: getName(req.gid),
              _prereqFor: targetGid,
              _resolveChain: subChain
            },
            priority: 2,
            villageId: villageId
          },
          targetGid: targetGid,
          chain: subChain
        };
      }

      // Case B: Building/field exists but level too low → upgrade
      if (isResourceField) {
        // Resource field: find the best field to upgrade
        var rfInfo = stateReader.getResourceField(req.gid);
        if (!rfInfo || !rfInfo.fieldId) {
          // Shouldn't happen — if level > 0, field must exist. Safety bail.
          return { blocked: true, reason: 'resource_field_not_found', task: null, targetGid: targetGid, chain: chain };
        }

        if (taskQueue.hasTaskOfType('upgrade_resource', villageId) ||
            taskQueue.hasTaskOfType('upgrade_resource', null)) {
          return { blocked: false, reason: 'already_queued', task: null, targetGid: targetGid, chain: chain };
        }

        return {
          blocked: false,
          reason: null,
          task: {
            type: 'upgrade_resource',
            params: {
              fieldId: rfInfo.fieldId,
              _prereqFor: targetGid,
              _resolveChain: chain.concat(req.gid)
            },
            priority: 2,
            villageId: villageId
          },
          targetGid: targetGid,
          chain: chain.concat(req.gid)
        };
      }

      // Dorf2 building exists but level too low
      var buildingInfo = stateReader.getBuilding(req.gid);
      if (buildingInfo && buildingInfo.upgrading) {
        // Already being upgraded — just wait for it
        return { blocked: false, reason: 'awaiting_upgrade', task: null, targetGid: targetGid, chain: chain };
      }

      if (taskQueue.hasTaskOfType('upgrade_building', villageId) ||
          taskQueue.hasTaskOfType('upgrade_building', null)) {
        return { blocked: false, reason: 'already_queued', task: null, targetGid: targetGid, chain: chain };
      }

      return {
        blocked: false,
        reason: null,
        task: {
          type: 'upgrade_building',
          params: {
            slot: buildingInfo ? buildingInfo.slot : null,
            _prereqFor: targetGid,
            _resolveChain: chain.concat(req.gid)
          },
          priority: 2,
          villageId: villageId
        },
        targetGid: targetGid,
        chain: chain.concat(req.gid)
      };
    }

    // All prereqs met — the target itself is what we need to act on
    return { blocked: false, reason: 'prereqs_met', task: null, targetGid: targetGid, chain: chain };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Check if a slot is currently being upgraded */
  _isSlotUpgrading(state, slot, type) {
    const list = type === 'upgrade_resource'
      ? (state.resourceFields || [])
      : (state.buildings || []);
    for (const item of list) {
      const itemSlot = item.slot || item.id;
      if (itemSlot === slot && item.upgrading) return true;
    }
    return false;
  }

  /** Extract storage levels from game state */
  _extractStorage(state) {
    let warehouse = 1, granary = 1;
    if (state.buildings) {
      for (const b of state.buildings) {
        const gid = b.gid || b.id;
        if (gid === 10 && (b.level || 0) > warehouse) warehouse = b.level;
        if (gid === 11 && (b.level || 0) > granary) granary = b.level;
      }
    }
    // Also check if directly provided
    if (state.storage) {
      if (state.storage.warehouse) warehouse = state.storage.warehouse;
      if (state.storage.granary) granary = state.storage.granary;
    }
    return { warehouse, granary };
  }

  /** Count total troops from game state */
  _countTroops(state) {
    let total = 0;
    if (state.troops && typeof state.troops === 'object') {
      for (const k in state.troops) {
        total += state.troops[k] || 0;
      }
    }
    return total;
  }

  /** Estimate game day from bot start time */
  _estimateGameDay() {
    // If we don't know the server start, estimate from config or default to 15
    return 15;
  }

  /** Get the training building for a troop unit */
  _getTroopBuilding(unitKey, tribe) {
    try {
      var GD = self.TravianGameData;
      if (GD && GD.TROOPS && GD.TROOPS[tribe] && GD.TROOPS[tribe][unitKey]) {
        return GD.TROOPS[tribe][unitKey].building || 'barracks';
      }
    } catch (_) {}
    return 'barracks';
  }

  /**
   * Calculate a resource efficiency score.
   */
  getResourceScore(state) {
    if (!state.resources) return 0;

    const { wood, clay, iron, crop } = state.resources;
    const total = wood + clay + iron + crop;
    if (total === 0) return 0;

    const avg = total / 4;
    const deviations = [
      Math.abs(wood - avg), Math.abs(clay - avg),
      Math.abs(iron - avg), Math.abs(crop - avg)
    ];
    const avgDeviation = deviations.reduce((a, b) => a + b, 0) / 4;
    const balanceFactor = avg > 0 ? Math.max(0, 1 - (avgDeviation / avg)) : 0;

    const maxStorage = state.maxStorage || 10000;
    const storageFactor = Math.min(1, total / (maxStorage * 4));

    let productionFactor = 0.5;
    if (state.production) {
      const prodTotal = (state.production.wood || 0) + (state.production.clay || 0) +
                        (state.production.iron || 0) + (state.production.crop || 0);
      productionFactor = Math.min(1, prodTotal / 400);
    }

    return Math.round(Math.min(100, Math.max(0,
      (balanceFactor * 40) + (storageFactor * 30) + (productionFactor * 30)
    )));
  }
}

// Export for service worker context
self.TravianDecisionEngine = DecisionEngine;
