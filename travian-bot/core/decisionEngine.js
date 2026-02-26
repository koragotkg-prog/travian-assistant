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

    // Initialize strategy modules (loaded via importScripts before this file)
    this.strategyEngine = null;
    this.buildOptimizer = null;
    this.militaryPlanner = null;
    this.actionScorer = null;
    this.resourceIntel = null;

    try {
      if (typeof self !== 'undefined') {
        if (self.TravianStrategyEngine) this.strategyEngine = new self.TravianStrategyEngine();
        if (self.TravianBuildOptimizer) this.buildOptimizer = new self.TravianBuildOptimizer();
        if (self.TravianMilitaryPlanner) this.militaryPlanner = new self.TravianMilitaryPlanner();
        if (self.TravianActionScorer) this.actionScorer = new self.TravianActionScorer();
        if (self.TravianResourceIntel) this.resourceIntel = new self.TravianResourceIntel();
      }
      if (this.resourceIntel) {
        console.log('[DecisionEngine] Resource Intelligence integrated — pressure-aware decisions enabled');
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

    // 2. If ActionScorer is available, use hybrid AI scoring
    if (this.actionScorer && config.useAIScoring !== false) {
      const scoredActions = this.actionScorer.scoreAll(gameState, config, taskQueue);

      if (scoredActions.length > 0) {
        // Take the top-scored action
        const best = scoredActions[0];
        TravianLogger.log('INFO', `[AI] Best action: ${best.type} (score: ${best.score.toFixed(1)}) — ${best.reason}`);
        this.lastAIAction = { type: best.type, score: best.score, reason: best.reason };

        // TQ-1 FIX: Use villageId-agnostic check to prevent dedup mismatch
        // (AI path might use null villageId while fallback uses actual villageId)
        if (!taskQueue.hasAnyTaskOfType(best.type)) {
          newTasks.push({
            type: best.type,
            params: best.params,
            priority: Math.max(1, 10 - Math.floor(best.score / 5)),
            villageId: gameState.currentVillageId || null
          });
        }

        // Log runner-up for transparency
        if (scoredActions.length > 1) {
          const second = scoredActions[1];
          TravianLogger.log('DEBUG', `[AI] Runner-up: ${second.type} (score: ${second.score.toFixed(1)}) — ${second.reason}`);
        }
      }

      return newTasks;
    }

    // 3. Construction queue check (rule-based fallback path)
    const queue = gameState.constructionQueue || { count: 0, maxCount: 1 };
    const buildQueueFull = queue.count >= queue.maxCount;

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

    // 4.7. Resource pressure analysis (informs upgrade decisions)
    let resourcePressure = null;
    let cropSafetyReport = null;
    if (this.resourceIntel) {
      try {
        const snapshot = this.resourceIntel.buildSnapshot(gameState);
        if (snapshot) {
          // Build pending cost drain from construction queue
          const pendingCosts = this._extractPendingCosts(gameState);

          // Get farm income prediction (if farm history available)
          let farmIncomePerHr = null;
          try {
            const farmPreds = this.resourceIntel.getAllFarmPredictions();
            if (farmPreds && farmPreds.farms.length > 0) {
              farmIncomePerHr = farmPreds.incomePerHr;
            }
          } catch (_) {}

          // Enhanced forecast with build drain and farm income
          const forecastOpts = {};
          if (pendingCosts.length > 0) forecastOpts.pendingCosts = pendingCosts;
          if (farmIncomePerHr) forecastOpts.farmIncomePerHr = farmIncomePerHr;

          resourcePressure = this.resourceIntel.pressure(snapshot);
          if (resourcePressure && resourcePressure.overall >= 30) {
            TravianLogger.log('INFO', '[ResourceIntel] Pressure: ' + resourcePressure.overall +
              ' (' + resourcePressure.level + ')' +
              (resourcePressure.firstOverflowMs != null
                ? ' — overflow in ' + Math.round(resourcePressure.firstOverflowMs / 60000) + 'min'
                : ''));
          }

          // Crop safety check (for troop training gate)
          const troopUpkeep = this._estimateTroopUpkeep(gameState);
          cropSafetyReport = this.resourceIntel.cropSafety(snapshot, troopUpkeep);
          if (cropSafetyReport && cropSafetyReport.level !== 'safe') {
            TravianLogger.log('WARN', '[ResourceIntel] Crop safety: ' + cropSafetyReport.level +
              ' (net: ' + cropSafetyReport.netCrop + '/hr' +
              (cropSafetyReport.hoursToStarvation != null
                ? ', starvation in ' + cropSafetyReport.hoursToStarvation + 'h'
                : '') + ')');
          }
        }
      } catch (err) {
        console.warn('[DecisionEngine] Resource pressure analysis failed:', err.message);
      }
    }

    // 5. Upgrade decisions (resources + buildings)
    const autoRes = config.autoUpgradeResources || config.autoResourceUpgrade;
    const autoBld = config.autoUpgradeBuildings || config.autoBuildingUpgrade;
    if ((autoRes || autoBld) && !buildQueueFull &&
        !this.isCoolingDown('upgrade_resource') && !this.isCoolingDown('upgrade_building')) {
      const upgradeTask = this.evaluateUpgrades(gameState, config, autoRes, autoBld, resourcePressure);
      if (upgradeTask && !taskQueue.hasTaskOfType(upgradeTask.type, upgradeTask.villageId)) {
        newTasks.push(upgradeTask);
      }
    }

    // 6. Troop training (gated by crop safety)
    if ((config.autoTrainTroops || config.autoTroopTraining) && !this.isCoolingDown('train_troops')) {
      // Crop safety gate: skip training when crop sustainability is at risk
      let cropSafe = true;
      if (cropSafetyReport && !cropSafetyReport.safeToTrain) {
        cropSafe = false;
        TravianLogger.log('INFO', '[ResourceIntel] Troop training blocked — crop ' +
          cropSafetyReport.level + ' (net: ' + cropSafetyReport.netCrop + '/hr)');
      }

      if (cropSafe) {
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
  evaluateUpgrades(state, config, autoRes, autoBld, resourcePressure) {
    const targets = config.upgradeTargets || {};
    const hasTargets = Object.keys(targets).length > 0;

    // --- Strategy-engine path: use ROI ranking ---
    if (this.buildOptimizer) {
      return this._strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets, resourcePressure);
    }

    // --- Fallback path: simple lowest-level logic ---
    return this._fallbackUpgrade(state, config, autoRes, autoBld, targets, hasTargets);
  }

  /**
   * Strategy-engine upgrade: rank all upgrades by ROI/utility, then filter by
   * user config (upgradeTargets) and pick the best affordable one.
   */
  _strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets, resourcePressure) {
    const villageState = {
      resourceFields: state.resourceFields || [],
      buildings: state.buildings || [],
      resources: state.resources || {},
      production: state.resourceProduction || state.production || {},
      storage: this._extractStorage(state),
    };

    // Get ROI-ranked candidates from build optimizer
    let ranked = this.buildOptimizer.rankUpgrades(villageState, this.currentPhase, 20);

    // Apply resource pressure re-ranking when pressure >= 30
    if (this.resourceIntel && resourcePressure && resourcePressure.overall >= 30) {
      try {
        ranked = this.resourceIntel.policy(resourcePressure, ranked);
        TravianLogger.log('DEBUG', '[ResourceIntel] Re-ranked ' + ranked.length +
          ' candidates by pressure relief (pressure=' + resourcePressure.overall + ')');
      } catch (err) {
        console.warn('[DecisionEngine] ResourceIntel policy failed:', err.message);
      }
    }

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
          // Map strategy unit names to config troop types if user has one set
          const userTroopType = config.troopConfig.defaultTroopType;
          const trainCount = Math.min(
            config.troopConfig.trainCount || 5,
            plan.affordableCount
          );

          console.log('[DecisionEngine] Troop plan: ' + plan.primaryUnit +
            ' x' + trainCount + ' (' + plan.reasoning.join('; ') + ')');

          // If user has a specific troop type configured, use their building too
          const useStrategyUnit = !userTroopType;
          const finalTroopType = useStrategyUnit ? plan.primaryUnit : userTroopType;
          const finalBuilding = useStrategyUnit
            ? this._getTroopBuilding(plan.primaryUnit, config.tribe)
            : (config.troopConfig.trainingBuilding || 'barracks');

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
    return {
      type: 'train_troops',
      params: {
        troopType: config.troopConfig.defaultTroopType || 'infantry',
        count: config.troopConfig.trainCount || 5,
        buildingType: config.troopConfig.trainingBuilding || 'barracks'
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

  /**
   * Record a completed farm run for loot prediction.
   * Called by BotEngine when farm task results come back.
   *
   * @param {string} farmId - Farm list identifier
   * @param {object} loot - Resources looted: {wood, clay, iron, crop}
   * @param {boolean} [success=true] - Whether the raid was successful
   */
  recordFarmResult(farmId, loot, success) {
    if (this.resourceIntel) {
      try {
        this.resourceIntel.recordFarmRun(farmId, loot, success);
      } catch (err) {
        console.warn('[DecisionEngine] Failed to record farm result:', err.message);
      }
    }
  }

  /**
   * Get ResourceIntel state for persistence (farm history etc).
   * Called by BotEngine before service worker shutdown.
   */
  getResourceIntelState() {
    if (this.resourceIntel) {
      try {
        return this.resourceIntel.getState();
      } catch (_) {}
    }
    return null;
  }

  /**
   * Restore ResourceIntel state from persisted data.
   * Called by BotEngine on startup.
   */
  loadResourceIntelState(state) {
    if (this.resourceIntel && state) {
      try {
        this.resourceIntel.loadState(state);
      } catch (err) {
        console.warn('[DecisionEngine] Failed to load ResourceIntel state:', err.message);
      }
    }
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

      // Check if we already have this task queued
      if (taskQueue.hasTaskOfType('build_new', null) ||
          taskQueue.hasTaskOfType('build_new', gameState.currentVillageId)) continue;

      console.log(`[DecisionEngine] New build: GID ${target.buildGid} in slot ${slot}`);
      return {
        type: 'build_new',
        params: { slot: slot, gid: target.buildGid },
        priority: 3,
        villageId: gameState.currentVillageId || null
      };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Extract pending build costs from construction queue for forecast drain.
   * Maps queue items to {wood,clay,iron,crop,completionMs} format.
   * @private
   */
  _extractPendingCosts(gameState) {
    var costs = [];
    var queue = gameState.constructionQueue;
    if (!queue || !queue.items || !queue.items.length) return costs;

    for (var i = 0; i < queue.items.length; i++) {
      var item = queue.items[i];
      // Extract remaining time in ms
      var remainMs = 0;
      if (typeof item.remainingMs === 'number') {
        remainMs = item.remainingMs;
      } else if (typeof item.remainingSec === 'number') {
        remainMs = item.remainingSec * 1000;
      }
      // Extract resource costs if available on the queue item
      if (item.cost && typeof item.cost === 'object') {
        costs.push({
          wood: item.cost.wood || 0,
          clay: item.cost.clay || 0,
          iron: item.cost.iron || 0,
          crop: item.cost.crop || 0,
          completionMs: remainMs
        });
      }
    }
    return costs;
  }

  /**
   * Estimate total troop crop upkeep from game state.
   * Falls back to simple count × 1 if detailed troop data unavailable.
   * @private
   */
  _estimateTroopUpkeep(gameState) {
    var totalUpkeep = 0;
    var troops = gameState.troops;
    if (!troops || typeof troops !== 'object') return 0;

    // If we have GameData, use actual upkeep values
    var GD = null;
    try {
      if (typeof self !== 'undefined' && self.TravianGameData) GD = self.TravianGameData;
    } catch (_) {}

    for (var unitKey in troops) {
      var count = troops[unitKey] || 0;
      if (count <= 0) continue;

      // Try to look up upkeep from GameData
      var upkeepPerUnit = 1; // default: 1 crop/hr per unit
      if (GD && GD.TROOPS) {
        // Check all tribes for this unit key
        var tribes = ['roman', 'teuton', 'gaul'];
        for (var t = 0; t < tribes.length; t++) {
          var tribeData = GD.TROOPS[tribes[t]];
          if (tribeData && tribeData[unitKey]) {
            upkeepPerUnit = tribeData[unitKey].upkeep || 1;
            break;
          }
        }
      }

      totalUpkeep += count * upkeepPerUnit;
    }
    return totalUpkeep;
  }

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
