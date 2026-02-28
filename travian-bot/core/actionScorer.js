// core/actionScorer.js — Hybrid AI Action Scoring Engine
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class ActionScorer {
    constructor() {
      this.gameData = root.TravianGameData || null;
      this.buildOptimizer = root.TravianBuildOptimizer ? new root.TravianBuildOptimizer() : null;
    }

    /**
     * Score all possible actions given current game state
     * @param {Object} gameState - Full game state from scan
     * @param {Object} config - Bot configuration
     * @param {Object} taskQueue - Current task queue instance
     * @returns {Array<{type, params, score, reason}>} Sorted by score descending
     */
    scoreAll(gameState, config, taskQueue) {
      const actions = [];

      // Collect candidates from each category
      if (config.autoResourceUpgrade || config.autoUpgradeResources) {
        actions.push(...this._scoreResourceUpgrades(gameState, config));
      }
      if (config.autoBuildingUpgrade || config.autoUpgradeBuildings) {
        actions.push(...this._scoreBuildingUpgrades(gameState, config));
      }
      if (config.autoTroopTraining) {
        actions.push(...this._scoreTroopTraining(gameState, config));
      }
      if (config.autoFarming) {
        actions.push(...this._scoreFarming(gameState, config));
      }
      if (config.autoHeroAdventure) {
        actions.push(...this._scoreHeroAdventure(gameState, config));
      }

      // Trapper and Wall scoring
      actions.push(...this._scoreTrapperAndWall(gameState, config));

      // Quest bonus: boost actions that align with quest goals
      if (gameState.quests) {
        this._applyQuestBonuses(actions, gameState.quests);
      }

      // Filter out infeasible actions
      const feasible = actions.filter(a => a.score > 0);

      // Sort by score descending
      feasible.sort((a, b) => b.score - a.score);

      return feasible;
    }

    _scoreResourceUpgrades(state, config) {
      const actions = [];
      const fields = state.resourceFields || [];
      const resources = state.resources || {};
      const capacity = state.resourceCapacity || {};

      // FIX: Check build queue — resource upgrades use the same construction queue
      const buildQueue = state.constructionQueue || { count: 0 };
      if (buildQueue.count >= (buildQueue.maxCount || 1)) return actions;

      const gidMap = { wood: 1, clay: 2, iron: 3, crop: 4 };

      for (const field of fields) {
        if (field.upgrading) continue;

        const gid = gidMap[field.type] || 0;
        if (!gid) continue;

        // Check target level from config
        const targetKey = `${field.type}Target`;
        const targetLevel = config.upgradeTargets?.[targetKey] || config[targetKey] || 10;
        if (field.level >= targetLevel) continue;

        // ROI-based scoring: gain per resource invested
        let baseValue = 5; // fallback
        if (this.gameData) {
          const currentProd = this.gameData.getProduction(field.level);
          const nextProd = this.gameData.getProduction(field.level + 1);
          const prodGain = (nextProd - currentProd) || 5;

          // Calculate total upgrade cost using gameData
          const cost = this.gameData.getBuildingCost
            ? this.gameData.getBuildingCost(gid, field.level + 1)
            : null;
          const totalCost = cost
            ? (cost.wood || 0) + (cost.clay || 0) + (cost.iron || 0) + (cost.crop || 0)
            : 500; // safe fallback

          // ROI = hourly gain / total investment (normalized x1000 for readable scores)
          baseValue = totalCost > 0 ? (prodGain / totalCost) * 1000 : prodGain;
        }

        // Urgency: boost if this resource is lowest
        const resValues = [resources.wood || 0, resources.clay || 0, resources.iron || 0, resources.crop || 0];
        const minRes = Math.min(...resValues);
        const thisRes = resources[field.type] || 0;
        const urgency = thisRes <= minRes * 1.1 ? 1.5 : 1.0;

        // Warehouse urgency: penalize if near capacity (wasteful upgrade)
        const warehouseCap = field.type === 'crop' ? (capacity.granary || 10000) : (capacity.warehouse || 10000);
        const fillRatio = thisRes / warehouseCap;
        const overflowUrgency = fillRatio > 0.9 ? 0.5 : 1.0;

        const score = baseValue * urgency * overflowUrgency;

        actions.push({
          type: 'upgrade_resource',
          params: { fieldId: field.id, type: field.type, level: field.level },
          score,
          reason: `${field.type} lv${field.level}→${field.level+1} ROI:${baseValue.toFixed(1)}`
        });
      }

      return actions;
    }

    _scoreBuildingUpgrades(state, config) {
      const actions = [];
      const buildings = state.buildings || [];
      const buildQueue = state.constructionQueue || { count: 0 };

      if (buildQueue.count >= (buildQueue.maxCount || 1)) return actions;

      for (const bld of buildings) {
        if (bld.empty || bld.upgrading) continue;

        const gid = bld.id || bld.gid;
        const targetLevel = config.buildingTargets?.[`b${gid}`] || null;
        if (targetLevel && bld.level >= targetLevel) continue;

        // Cost-aware scoring with utility multipliers
        let baseValue = 10;
        // Utility multipliers by building type
        const utilityMap = { 10: 1.5, 11: 1.5, 15: 1.2, 19: 0.8, 17: 0.7, 23: 0.6, 36: 0.5, 31: 0.5, 33: 0.5 };
        const utilityMult = utilityMap[gid] || 1.0;

        // Cost-aware: lower levels are cheaper → better ROI
        if (this.gameData && this.gameData.getBuildingCost) {
          const cost = this.gameData.getBuildingCost(gid, bld.level + 1);
          const totalCost = cost ? (cost.wood || 0) + (cost.clay || 0) + (cost.iron || 0) + (cost.crop || 0) : 1000;
          baseValue = Math.min((1000 / Math.max(totalCost, 100)) * 10 * utilityMult, 25);
        } else {
          baseValue = 10 * utilityMult * (1 + (10 - bld.level) * 0.1);
        }

        const score = baseValue;

        actions.push({
          type: 'upgrade_building',
          params: { slot: bld.slot, gid, level: bld.level },
          score,
          reason: `${bld.name || 'building'} lv${bld.level}→${bld.level+1}`
        });
      }

      return actions;
    }

    _scoreTroopTraining(state, config) {
      const actions = [];
      const troops = state.troops || {};
      const totalTroops = Object.values(troops).reduce((sum, n) => sum + (parseInt(n) || 0), 0);

      // Simple: if below minimum troops, train more
      const minTroops = config.minTroops || 50;
      if (totalTroops >= minTroops && !config.alwaysTrain) return actions;

      // Support new slots format + backward compat
      var tc = config.troopConfig || config;
      var firstSlot = (tc.slots && tc.slots.length > 0) ? tc.slots[0] : null;
      const troopType = firstSlot ? firstSlot.troopType : (tc.defaultTroopType || config.troopType || 't1');
      const trainCount = firstSlot ? (firstSlot.batchSize || 5) : (tc.trainCount || config.trainCount || 5);
      // FIX: Include buildingType so execution navigates to the correct building
      const buildingType = firstSlot ? (firstSlot.building || 'barracks') : (tc.trainingBuilding || 'barracks');

      // Crop awareness: don't train if free crop is very low (skip penalty if data unavailable)
      const freeCrop = state.freeCrop;
      const cropPenalty = (freeCrop == null) ? 1.0 : freeCrop < 10 ? 0.3 : freeCrop < 50 ? 0.7 : 1.0;

      const score = 8 * cropPenalty;

      actions.push({
        type: 'train_troops',
        params: { troopType, count: trainCount, buildingType },
        score,
        reason: `Train ${trainCount}x ${troopType} @ ${buildingType} (troops: ${totalTroops})`
      });

      return actions;
    }

    _scoreFarming(state, config) {
      const actions = [];
      const farmConfig = config.farmConfig || config;

      if (!farmConfig.autoFarming && !config.autoFarming) return actions;

      // Base farming score
      const lastFarm = state.lastFarmTime || 0;
      const elapsed = Date.now() - lastFarm;
      const interval = (farmConfig.farmInterval || 300) * 1000;

      if (elapsed < interval) return actions;

      // Check outgoing raids
      const outgoing = state.troopMovements?.outgoing || 0;
      if (outgoing > 0) return actions;

      const score = 20; // farming is generally high value

      actions.push({
        type: 'send_farm',
        params: { useRallyPointFarmList: farmConfig.useRallyPointFarmList !== false },
        score,
        reason: `Farm raid (${Math.floor(elapsed/1000)}s since last)`
      });

      return actions;
    }

    _scoreHeroAdventure(state, config) {
      const actions = [];
      const hero = state.hero || {};

      if (!hero.hasAdventure || hero.isAway || hero.isDead) return actions;
      if ((hero.health || 0) < (config.minHeroHealth || 30)) return actions;

      actions.push({
        type: 'send_hero_adventure',
        params: {},
        score: 25, // adventures are high value (XP + items)
        reason: `Hero adventure available (health: ${hero.health}%)`
      });

      return actions;
    }

    _scoreTrapperAndWall(state, config) {
      const actions = [];
      const trapper = state.trapperInfo;

      // Trap training
      if (trapper && trapper.canTrain && trapper.maxTrain > 0 && config.autoTrapTraining === true) {
        const deficit = trapper.maxTraps - trapper.currentTraps;
        if (deficit > 0) {
          const threatLevel = state.defenseReports?.recentAttacks > 0 ? 2.0 : 1.0;
          const score = (deficit / trapper.maxTraps) * 15 * threatLevel;
          actions.push({
            type: 'build_traps',
            params: { count: Math.min(deficit, trapper.maxTrain, (config.trapConfig && config.trapConfig.batchSize) || 10) },
            score,
            reason: `Train traps (${trapper.currentTraps}/${trapper.maxTraps})`
          });
        }
      }

      // Wall upgrade — scored as normal building but with defense boost
      const buildings = state.buildings || [];
      const wall = buildings.find(b => [31, 33, 36].includes(b.id || b.gid));
      if (wall && !wall.upgrading && wall.level < 20) {
        const score = 8 + (state.defenseReports?.recentAttacks > 0 ? 10 : 0);
        actions.push({
          type: 'upgrade_building',
          params: { slot: wall.slot, gid: wall.id || wall.gid, level: wall.level },
          score,
          reason: `Wall lv${wall.level}→${wall.level + 1}`
        });
      }

      return actions;
    }

    _applyQuestBonuses(actions, quests) {
      for (const quest of quests) {
        if (!quest.progress || !quest.total) continue;
        const progressPct = quest.progress / quest.total;

        // Find actions that help complete this quest
        for (const action of actions) {
          if (this._actionMatchesQuest(action, quest)) {
            const bonus = progressPct > 0.9 ? 2.0 : progressPct > 0.7 ? 1.5 : 1.2;
            action.score *= bonus;
            action.reason += ` [quest×${bonus}]`;
          }
        }
      }
    }

    _actionMatchesQuest(action, quest) {
      const title = (quest.title || '').toLowerCase();
      if (action.type === 'upgrade_resource') {
        if (title.includes(action.params.type)) return true;
        if (title.includes('population') || title.includes('ประชากร')) return true;
        if (title.includes('culture') || title.includes('วัฒนธรรม')) return true;
      }
      if (action.type === 'upgrade_building' || action.type === 'build_new') {
        if (title.includes('population') || title.includes('ประชากร')) return true;
        if (title.includes('culture') || title.includes('วัฒนธรรม')) return true;
      }
      if (action.type === 'train_troops' && (title.includes('troop') || title.includes('ทหาร'))) return true;
      return false;
    }
  }

  root.TravianActionScorer = ActionScorer;
})();
