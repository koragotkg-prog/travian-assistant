// core/actionScorer.js — Hybrid AI Action Scoring Engine
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class ActionScorer {
    constructor() {
      this.gameData = root.TravianGameData ? new root.TravianGameData() : null;
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

      for (const field of fields) {
        if (field.upgrading) continue;

        const gidMap = { wood: 1, clay: 2, iron: 3, crop: 4 };
        const gid = gidMap[field.type] || 0;
        if (!gid) continue;

        // Check target level from config
        const targetKey = `${field.type}Target`;
        const targetLevel = config.upgradeTargets?.[targetKey] || config[targetKey] || 10;
        if (field.level >= targetLevel) continue;

        // Base value: production gain per hour
        let baseValue = 5; // default
        if (this.gameData) {
          const currentProd = this.gameData.getProduction(gid, field.level);
          const nextProd = this.gameData.getProduction(gid, field.level + 1);
          baseValue = (nextProd - currentProd) || 5;
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
          reason: `${field.type} lv${field.level}→${field.level+1} +${baseValue}/hr`
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

        // Score by building utility
        let baseValue = 10;
        if (gid === 10) baseValue = 15; // Warehouse — high utility
        if (gid === 11) baseValue = 15; // Granary
        if (gid === 15) baseValue = 12; // Main Building — build speed
        if (gid === 19) baseValue = 8;  // Barracks
        if (gid === 17) baseValue = 7;  // Marketplace
        if (gid === 23) baseValue = 6;  // Cranny
        if (gid === 36 || gid === 31 || gid === 33) baseValue = 5; // Wall

        const score = baseValue * (1 + (10 - bld.level) * 0.1); // lower levels = higher priority

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

      const troopType = config.troopType || 't1';
      const trainCount = config.trainCount || 5;

      // Crop awareness: don't train if free crop is very low
      const freeCrop = state.freeCrop || 0;
      const cropPenalty = freeCrop < 10 ? 0.3 : freeCrop < 50 ? 0.7 : 1.0;

      const score = 8 * cropPenalty;

      actions.push({
        type: 'train_troops',
        params: { troopType, count: trainCount },
        score,
        reason: `Train ${trainCount}x ${troopType} (troops: ${totalTroops})`
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
