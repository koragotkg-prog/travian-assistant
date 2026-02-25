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

    /** @type {string} Detected game phase */
    this.currentPhase = 'early';

    // Initialize strategy modules (loaded via importScripts before this file)
    this.strategyEngine = null;
    this.buildOptimizer = null;
    this.militaryPlanner = null;

    try {
      if (typeof self !== 'undefined') {
        if (self.TravianStrategyEngine) this.strategyEngine = new self.TravianStrategyEngine();
        if (self.TravianBuildOptimizer) this.buildOptimizer = new self.TravianBuildOptimizer();
        if (self.TravianMilitaryPlanner) this.militaryPlanner = new self.TravianMilitaryPlanner();
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

    // 2. Construction queue check
    const queue = gameState.constructionQueue || { count: 0, maxCount: 1 };
    const buildQueueFull = queue.count >= queue.maxCount;

    // 3. Run strategy analysis (if available)
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

    // 3.5. Cranny protection rule: cranny must be >= warehouse level
    //      This runs BEFORE normal upgrades so it takes priority
    if (!buildQueueFull && !this.isCoolingDown('upgrade_building') && !this.isCoolingDown('build_new')) {
      const crannyTask = this._evaluateCrannyRule(gameState, config, taskQueue);
      if (crannyTask) {
        newTasks.push(crannyTask);
      }
    }

    // 3.5. Quest rewards — claim before spending resources on upgrades
    if (config.autoClaimQuests !== false) {  // enabled by default
      const questTask = this._evaluateQuests(gameState, config, taskQueue);
      if (questTask && !taskQueue.hasTaskOfType('claim_quest')) {
        newTasks.push(questTask);
      }
    }

    // 3.55. Gaul Trapper rule (Task 15): upgrade trapper when incoming attacks detected
    if (config.autoTrapper && !buildQueueFull &&
        !this.isCoolingDown('upgrade_building') && !this.isCoolingDown('build_new')) {
      const trapperTask = this._evaluateTrapperRule(gameState, config, taskQueue);
      if (trapperTask && !taskQueue.hasTaskOfType(trapperTask.type, trapperTask.villageId)) {
        newTasks.push(trapperTask);
      }
    }

    // 3.6. New building construction from user's empty-slot selections
    if (!buildQueueFull && !this.isCoolingDown('build_new')) {
      const buildNewTask = this._evaluateNewBuilds(gameState, config, taskQueue);
      if (buildNewTask) {
        newTasks.push(buildNewTask);
      }
    }

    // 4. Upgrade decisions (resources + buildings)
    const autoRes = config.autoUpgradeResources || config.autoResourceUpgrade;
    const autoBld = config.autoUpgradeBuildings || config.autoBuildingUpgrade;
    if ((autoRes || autoBld) && !buildQueueFull &&
        !this.isCoolingDown('upgrade_resource') && !this.isCoolingDown('upgrade_building')) {
      const upgradeTask = this.evaluateUpgrades(gameState, config, autoRes, autoBld);
      if (upgradeTask && !taskQueue.hasTaskOfType(upgradeTask.type, upgradeTask.villageId)) {
        newTasks.push(upgradeTask);
      }
    }

    // 5. Troop training
    if ((config.autoTrainTroops || config.autoTroopTraining) && !this.isCoolingDown('train_troops')) {
      const troopTask = this.evaluateTroopTraining(gameState, config);
      if (troopTask && !taskQueue.hasTaskOfType('train_troops', troopTask.villageId)) {
        newTasks.push(troopTask);
      }
    }

    // 6. Hero adventure
    if ((config.autoHeroAdventure) && !this.isCoolingDown('send_hero_adventure')) {
      const heroTask = this.evaluateHeroAdventure(gameState, config);
      if (heroTask && !taskQueue.hasTaskOfType('send_hero_adventure', heroTask.villageId)) {
        newTasks.push(heroTask);
      }
    }

    // 7. Farming
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

          // Crop-balance gate
          const cropCheck = this._checkCropBalance(state, config, finalTroopType, trainCount);
          if (!cropCheck.ok) {
            console.log('[DecisionEngine] Skipping troops (strategy) — crop balance: ' +
              cropCheck.balance + '/hr');
            return null;
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
    const fallbackType  = config.troopConfig.defaultTroopType || 'infantry';
    const fallbackCount = config.troopConfig.trainCount || 5;

    // ── Crop-balance check (Task 14) ──────────────────────────────────
    // Skip training if it would push crop balance below the safety margin.
    const cropCheck = this._checkCropBalance(state, config, fallbackType, fallbackCount);
    if (!cropCheck.ok) {
      console.log('[DecisionEngine] Skipping troops — crop balance: ' +
        cropCheck.balance + '/hr (threshold: -' + cropCheck.threshold + ')');
      return null;
    }

    return {
      type: 'train_troops',
      params: {
        troopType: fallbackType,
        count: fallbackCount,
        buildingType: config.troopConfig.trainingBuilding || 'barracks'
      },
      priority: 6,
      villageId: state.currentVillageId || null
    };
  }

  // ── Crop-balance helpers (Task 14) ─────────────────────────────────

  /**
   * Check if training `count` of `troopType` would keep crop balance acceptable.
   * @returns {{ ok: boolean, balance: number, threshold: number }}
   */
  _checkCropBalance(state, config, troopType, count) {
    const threshold = (config.cropSafetyMargin !== undefined)
      ? config.cropSafetyMargin : 50;

    const cropProd     = (state.resourceProduction && state.resourceProduction.crop) || 0;
    const existingUpkeep = this._estimateCropConsumption(state, config.tribe);
    const newUpkeep    = this._getTroopUpkeep(troopType, config.tribe) * count;
    const balance      = cropProd - existingUpkeep - newUpkeep;

    return { ok: balance >= -threshold, balance: Math.round(balance), threshold };
  }

  /**
   * Estimate total crop consumed per hour by existing troops.
   * Uses state.troops {troopName: count} + TravianGameData upkeep values.
   */
  _estimateCropConsumption(state, tribe) {
    if (!state.troops || typeof state.troops !== 'object') return 0;

    let total = 0;
    const allTribes = ['roman', 'gaul', 'teuton'];
    const tribes = tribe ? [tribe] : allTribes;

    for (const [name, count] of Object.entries(state.troops)) {
      if (!count || count <= 0) continue;
      const upkeep = this._getTroopUpkeep(name, tribe) ||
                     this._searchAllTribeUpkeep(name, allTribes);
      total += upkeep * count;
    }
    return total;
  }

  /**
   * Look up crop upkeep for a troop unit key (or generic type name).
   * @param {string} unitKey  e.g. 'legionnaire', 'infantry', 't1'
   * @param {string} tribe    e.g. 'roman', 'gaul', 'teuton'
   * @returns {number} Crop upkeep per troop per hour
   */
  _getTroopUpkeep(unitKey, tribe) {
    try {
      var GD = self.TravianGameData;
      if (!GD || !GD.TROOPS) return 1;

      // Direct lookup
      if (tribe && GD.TROOPS[tribe] && GD.TROOPS[tribe][unitKey]) {
        return GD.TROOPS[tribe][unitKey].upkeep || 1;
      }

      // Generic type mapping → approximate upkeep
      const genericMap = {
        infantry: 1, t1: 1, spear: 1,
        cavalry: 2,  t2: 1, t3: 1,
        t4: 2, t5: 3, scout: 1
      };
      if (genericMap[unitKey] !== undefined) return genericMap[unitKey];
    } catch (_) {}
    return 1; // safe default
  }

  /** Search all tribe tables for an upkeep value by unit key */
  _searchAllTribeUpkeep(unitKey, tribes) {
    try {
      var GD = self.TravianGameData;
      if (!GD || !GD.TROOPS) return 1;
      for (const t of tribes) {
        if (GD.TROOPS[t] && GD.TROOPS[t][unitKey]) {
          return GD.TROOPS[t][unitKey].upkeep || 1;
        }
      }
    } catch (_) {}
    return 1;
  }

  // ---------------------------------------------------------------------------
  // Farming (unchanged — works well as-is)
  // ---------------------------------------------------------------------------

  evaluateFarming(state, config) {
    if (!config.farmConfig) return null;

    const farmInterval = config.farmConfig.intervalMs || 300000;
    const lastFarmTime = state.lastFarmTime || 0;
    if (Date.now() - lastFarmTime < farmInterval) return null;

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

  setCooldown(actionType, durationMs) {
    this.cooldowns.set(actionType, Date.now() + durationMs);
  }

  isCoolingDown(actionType) {
    const expiresAt = this.cooldowns.get(actionType);
    if (!expiresAt) return false;
    if (Date.now() >= expiresAt) {
      this.cooldowns.delete(actionType);
      return false;
    }
    return true;
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
      if (taskQueue.hasTaskOfType('upgrade_building')) return null;

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

    if (taskQueue.hasTaskOfType('build_new')) return null;

    console.log(`[DecisionEngine] Cranny rule: no cranny found, building in empty slot ${emptySlot}`);
    return {
      type: 'build_new',
      params: { slot: emptySlot, gid: 23, buildingName: 'Cranny' },
      priority: 2, // High priority
      villageId: gameState.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // Gaul Trapper Rule (Task 15)
  // ---------------------------------------------------------------------------

  /**
   * Upgrade or build the Trapper (GID 36) when incoming attacks are detected.
   * Only activates for Gaul tribes with config.autoTrapper = true.
   *
   * Logic: if incomingAttacks > 0, make sure trapper capacity covers them.
   * If trapper is at capacity for current level, queue an upgrade.
   * If no trapper exists and tribe is gaul, build one in an empty slot.
   */
  _evaluateTrapperRule(gameState, config, taskQueue) {
    // Only for Gaul
    const tribe = (config.tribe || gameState.tribe || '').toLowerCase();
    if (tribe !== 'gaul') return null;

    const incomingAttacks = gameState.incomingAttacks || 0;
    if (incomingAttacks <= 0) return null; // No threat — skip

    const buildings = gameState.buildings || [];
    let trapper = null;
    let emptySlot = null;

    for (const b of buildings) {
      const gid = b.gid || b.id;
      if (gid === 36) {
        trapper = { slot: b.slot, level: b.level || 0 };
      }
      if (b.empty && !emptySlot) {
        emptySlot = b.slot;
      }
    }

    if (!trapper) {
      // Build a new trapper
      if (!emptySlot) return null;
      if (taskQueue.hasTaskOfType('build_new')) return null;
      console.log('[DecisionEngine] Trapper rule: no trapper, building in slot ' + emptySlot);
      return {
        type: 'build_new',
        params: { slot: emptySlot, gid: 36, buildingName: 'Trapper' },
        priority: 2,
        villageId: gameState.currentVillageId || null
      };
    }

    // Trapper exists — check if capacity needs upgrading
    try {
      var GD = self.TravianGameData;
      const capTable = GD && GD.TRAPPER_CAPACITY;
      const currentCap = capTable ? (capTable[trapper.level] || 0) : (trapper.level * 10);
      const maxLevel = capTable ? capTable.length - 1 : 20;

      if (currentCap >= incomingAttacks * 10) return null; // Enough capacity
      if (trapper.level >= maxLevel) return null;          // Already maxed
    } catch (_) { /* proceed with upgrade anyway */ }

    if (taskQueue.hasTaskOfType('upgrade_building')) return null;

    console.log('[DecisionEngine] Trapper rule: upgrading trapper Lv.' + trapper.level +
      ' (incoming attacks: ' + incomingAttacks + ')');
    return {
      type: 'upgrade_building',
      params: { slot: trapper.slot },
      priority: 2,
      villageId: gameState.currentVillageId || null
    };
  }

  // ---------------------------------------------------------------------------
  // Quest reward evaluation (Task 17)
  // ---------------------------------------------------------------------------

  /**
   * Check if there are claimable quest rewards in the current game state.
   *
   * The dom-scanner's scanQuests() returns:
   *   { hasClaimable: bool, claimable: [{id, title}], hasNew: bool }
   *
   * If claimable rewards exist, we emit a claim_quest task with the first
   * available quest ID. The task dispatcher in BotEngine will navigate to
   * the quest page if needed before executing claimQuest.
   *
   * @param {object} gameState
   * @param {object} config
   * @param {object} taskQueue
   * @returns {object|null}
   */
  _evaluateQuests(gameState, config, taskQueue) {
    const quests = gameState.quests;
    if (!quests || !quests.hasClaimable) return null;
    if (!quests.claimable || quests.claimable.length === 0) return null;

    // Take the first claimable quest
    const first = quests.claimable[0];
    const questId = first && first.id;

    console.log('[DecisionEngine] Quest reward available:', first && first.title);
    return {
      type: 'claim_quest',
      params: { questId: questId || null },
      priority: 1,  // High priority — free resources
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

      // Check if we already have this task queued
      if (taskQueue.hasTaskOfType('build_new')) continue;

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
