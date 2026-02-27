/**
 * buildOptimizer.js — Build Order Optimization & ROI Calculator
 *
 * Scores every possible upgrade by return-on-investment,
 * detects resource overflow risk, identifies bottlenecks,
 * and produces optimal build queues.
 *
 * Depends on: TravianGameData (gameData.js)
 */
(function () {
  'use strict';

  // Resolve dependency
  var GD = (typeof self !== 'undefined' && self.TravianGameData) ||
           (typeof window !== 'undefined' && window.TravianGameData) ||
           (typeof global !== 'undefined' && global.TravianGameData) ||
           (typeof require === 'function' ? require('./gameData') : null);

  // =========================================================================
  // BuildOptimizer
  // =========================================================================
  function BuildOptimizer() {
    this.GD = GD;
  }

  // -------------------------------------------------------------------------
  // Core ROI Calculation
  // -------------------------------------------------------------------------

  /**
   * Calculate payback period (hours) for upgrading a resource field.
   * Lower payback = better investment.
   *
   * payback = total_cost / additional_production_per_hour
   *
   * @param {number} fromLevel - Current level
   * @param {string} buildingKey - e.g., 'woodcutter', 'clayPit', 'ironMine', 'cropField'
   * @returns {{ paybackHours: number, roi: number, cost: object, productionGain: number }}
   */
  BuildOptimizer.prototype.resourceFieldROI = function (fromLevel, buildingKey) {
    var cost = this.GD.getUpgradeCost(buildingKey, fromLevel);
    var totalCost = this.GD.totalCost(cost);
    var gain = this.GD.getProductionGain(fromLevel);

    if (gain <= 0) return { paybackHours: Infinity, roi: 0, cost: cost, productionGain: 0 };

    var paybackHours = totalCost / gain;
    return {
      paybackHours: Math.round(paybackHours * 10) / 10,
      roi: Math.round((1 / paybackHours) * 1000) / 1000, // higher = better
      cost: cost,
      productionGain: gain,
    };
  };

  /**
   * Score a non-resource building upgrade based on utility value.
   * Returns a composite score where higher = more urgent.
   *
   * @param {string} buildingKey
   * @param {number} fromLevel
   * @param {object} villageState - { resources, production, storage, buildings, troops, ... }
   * @param {string} phase - 'early' | 'mid' | 'late'
   * @returns {{ score: number, reason: string, cost: object }}
   */
  BuildOptimizer.prototype.buildingUtilityScore = function (buildingKey, fromLevel, villageState, phase) {
    var cost = this.GD.getUpgradeCost(buildingKey, fromLevel);
    var totalCost = this.GD.totalCost(cost);
    if (totalCost <= 0) return { score: 0, reason: 'invalid', cost: cost };

    var building = this.GD.BUILDINGS[buildingKey];
    if (!building) return { score: 0, reason: 'unknown building', cost: cost };

    var score = 0;
    var reason = '';

    switch (building.category) {
      case 'storage': {
        // Urgency based on how close resources are to overflow
        var overflowUrgency = this._overflowUrgency(villageState, buildingKey);
        score = overflowUrgency * 100 / totalCost;
        reason = overflowUrgency > 0.8 ? 'CRITICAL: storage overflow imminent' : 'prevent resource waste';
        break;
      }
      case 'infra': {
        if (buildingKey === 'mainBuilding') {
          // MB value = future construction time savings
          // Approximate: saves ~3.5% per level on ALL future builds
          var futureBuilds = phase === 'early' ? 40 : phase === 'mid' ? 20 : 10;
          var avgBuildTime = 3000; // rough average seconds
          var timeSaved = futureBuilds * avgBuildTime * 0.035;
          score = timeSaved / totalCost * 10;
          reason = 'speeds up all future construction';
        } else {
          score = 5 / totalCost;
          reason = 'infrastructure';
        }
        break;
      }
      case 'military': {
        var militaryMult = phase === 'early' ? 0.3 : phase === 'mid' ? 1.0 : 1.5;
        score = (10 * militaryMult) / totalCost;
        reason = phase === 'late' ? 'war preparation' : 'military capability';
        break;
      }
      case 'defense': {
        if (buildingKey === 'wall') {
          var wallLevel = fromLevel;
          var defBonus = this.GD.getWallBonus(wallLevel + 1) - this.GD.getWallBonus(wallLevel);
          var defMult = phase === 'early' ? 0.5 : 1.0;
          score = (defBonus * defMult) / totalCost * 100;
          reason = '+' + defBonus + '% defense bonus from wall';
        } else {
          // Cranny, trapper, etc. - moderate defensive value
          var crannyMult = phase === 'early' ? 0.8 : 0.3;
          score = (5 * crannyMult) / totalCost;
          reason = 'resource protection';
        }
        break;
      }
      case 'expansion': {
        var expMult = phase === 'early' ? 1.5 : phase === 'mid' ? 1.0 : 0.3;
        score = (15 * expMult) / totalCost;
        reason = 'expansion capability';
        break;
      }
      case 'trade': {
        var tradeMult = phase === 'early' ? 0.2 : 0.8;
        score = (8 * tradeMult) / totalCost;
        reason = 'trading capability';
        break;
      }
      case 'bonus': {
        // Bonus buildings (sawmill, brickyard, etc.) add +5% per level to resource production
        var totalProd = this._getTotalProductionForBonus(buildingKey, villageState);
        var bonusGain = totalProd * this.GD.BONUS_BUILDING_PER_LEVEL;
        score = bonusGain / totalCost;
        reason = '+5% production (' + Math.round(bonusGain) + '/hr gain)';
        break;
      }
      default:
        score = 1 / totalCost;
        reason = 'general upgrade';
    }

    return {
      score: Math.round(score * 10000) / 10000,
      reason: reason,
      cost: cost,
    };
  };

  // -------------------------------------------------------------------------
  // Rank All Possible Upgrades
  // -------------------------------------------------------------------------

  /**
   * Evaluate and rank all possible upgrades for a village.
   *
   * @param {object} villageState
   *   { resourceFields: [{slot, gid, level}], buildings: [{slot, gid, level}],
   *     resources: {wood,clay,iron,crop}, production: {wood,clay,iron,crop},
   *     storage: {warehouse: level, granary: level} }
   * @param {string} phase - 'early'|'mid'|'late'
   * @param {number} [count=10] - How many recommendations to return
   * @returns {Array<{rank, type, buildingKey, slot, fromLevel, score, payback, reason, cost, affordable}>}
   */
  BuildOptimizer.prototype.rankUpgrades = function (villageState, phase, count) {
    count = count || 10;
    var candidates = [];
    var GID_TO_KEY = { 1: 'woodcutter', 2: 'clayPit', 3: 'ironMine', 4: 'cropField' };
    var self = this;

    // --- Score resource fields ---
    (villageState.resourceFields || []).forEach(function (f) {
      if (!f || f.upgrading || (f.level || 0) >= 20) return;
      var key = GID_TO_KEY[f.gid] || GID_TO_KEY[f.type === 'wood' ? 1 : f.type === 'clay' ? 2 : f.type === 'iron' ? 3 : 4];
      if (!key) return;

      var roi = self.resourceFieldROI(f.level || 0, key);
      var phaseMult = phase === 'early' ? 1.5 : phase === 'mid' ? 1.0 : 0.6;

      candidates.push({
        type: 'upgrade_resource',
        buildingKey: key,
        slot: f.slot || f.id,
        fromLevel: f.level || 0,
        score: roi.roi * phaseMult,
        payback: roi.paybackHours,
        reason: 'ROI: ' + roi.paybackHours + 'h payback, +' + roi.productionGain + '/hr',
        cost: roi.cost,
      });
    });

    // --- Score buildings ---
    (villageState.buildings || []).forEach(function (b) {
      if (!b || b.upgrading || (b.level || 0) >= 20) return;
      var key = self.GD.gidToKey(b.gid || b.id);
      if (!key) return;

      var util = self.buildingUtilityScore(key, b.level || 0, villageState, phase);
      candidates.push({
        type: 'upgrade_building',
        buildingKey: key,
        slot: b.slot,
        fromLevel: b.level || 0,
        score: util.score,
        payback: null,
        reason: util.reason,
        cost: util.cost,
      });
    });

    // --- Check affordability ---
    var res = villageState.resources || { wood: 0, clay: 0, iron: 0, crop: 0 };
    candidates.forEach(function (c) {
      c.affordable = c.cost &&
        res.wood >= c.cost.wood &&
        res.clay >= c.cost.clay &&
        res.iron >= c.cost.iron &&
        res.crop >= c.cost.crop;
    });

    // --- Sort by score descending ---
    candidates.sort(function (a, b) { return b.score - a.score; });

    // --- Assign rank ---
    return candidates.slice(0, count).map(function (c, i) {
      c.rank = i + 1;
      return c;
    });
  };

  // -------------------------------------------------------------------------
  // Overflow Detection
  // -------------------------------------------------------------------------

  /**
   * Detect how many hours until storage overflows for each resource.
   * Returns urgency flags and recommendations.
   */
  BuildOptimizer.prototype.detectOverflow = function (villageState) {
    var res = villageState.resources || {};
    var prod = villageState.production || {};
    var whLevel = (villageState.storage && villageState.storage.warehouse) || 1;
    var grLevel = (villageState.storage && villageState.storage.granary) || 1;

    var whCap = this.GD.getStorageCapacity(whLevel);
    var grCap = this.GD.getStorageCapacity(grLevel);

    var result = {};
    var types = { wood: whCap, clay: whCap, iron: whCap, crop: grCap };

    for (var type in types) {
      var current = res[type] || 0;
      var production = prod[type] || 0;
      var capacity = types[type];
      var remaining = capacity - current;
      var hoursUntilFull = production > 0 ? remaining / production : Infinity;
      var fillPercent = capacity > 0 ? current / capacity : 0;

      result[type] = {
        current: current,
        capacity: capacity,
        production: production,
        hoursUntilFull: Math.round(hoursUntilFull * 10) / 10,
        fillPercent: Math.round(fillPercent * 100),
        critical: hoursUntilFull < 2,
        warning: hoursUntilFull < 4,
      };
    }

    return result;
  };

  // -------------------------------------------------------------------------
  // Bottleneck Detection
  // -------------------------------------------------------------------------

  /**
   * Identify which resource is the bottleneck (lowest production relative to demand).
   */
  BuildOptimizer.prototype.getBottleneck = function (villageState) {
    var prod = villageState.production || {};
    var types = ['wood', 'clay', 'iron', 'crop'];
    var min = Infinity;
    var bottleneck = 'wood';

    types.forEach(function (t) {
      var p = prod[t] || 0;
      if (p < min) {
        min = p;
        bottleneck = t;
      }
    });

    var total = (prod.wood || 0) + (prod.clay || 0) + (prod.iron || 0) + (prod.crop || 0);
    var ratios = {};
    types.forEach(function (t) {
      ratios[t] = total > 0 ? Math.round(((prod[t] || 0) / total) * 100) : 25;
    });

    return {
      bottleneck: bottleneck,
      production: prod,
      ratios: ratios,
      advice: 'Focus upgrades on ' + bottleneck + ' (' + ratios[bottleneck] + '% of total production)',
    };
  };

  // -------------------------------------------------------------------------
  // Suggested Build Order (next N steps)
  // -------------------------------------------------------------------------

  /**
   * Generate an optimal build order for the next N upgrades.
   * Simulates building each top candidate, re-evaluates, repeats.
   *
   * @param {object} villageState
   * @param {string} phase
   * @param {number} steps - Number of steps to plan
   * @returns {Array}
   */
  BuildOptimizer.prototype.suggestBuildOrder = function (villageState, phase, steps) {
    steps = steps || 5;
    var order = [];
    var simState = JSON.parse(JSON.stringify(villageState)); // deep clone

    for (var i = 0; i < steps; i++) {
      var ranked = this.rankUpgrades(simState, phase, 1);
      if (ranked.length === 0) break;

      var best = ranked[0];
      order.push({
        step: i + 1,
        action: best.type,
        building: best.buildingKey,
        slot: best.slot,
        fromLevel: best.fromLevel,
        toLevel: best.fromLevel + 1,
        score: best.score,
        reason: best.reason,
      });

      // Simulate the upgrade in our cloned state
      this._applyUpgrade(simState, best);
    }

    return order;
  };

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  BuildOptimizer.prototype._overflowUrgency = function (villageState, buildingKey) {
    var res = villageState.resources || {};
    var prod = villageState.production || {};
    var whLevel = (villageState.storage && villageState.storage.warehouse) || 1;
    var grLevel = (villageState.storage && villageState.storage.granary) || 1;

    if (buildingKey === 'warehouse') {
      var whCap = this.GD.getStorageCapacity(whLevel);
      var maxRes = Math.max(res.wood || 0, res.clay || 0, res.iron || 0);
      return whCap > 0 ? maxRes / whCap : 0;
    } else if (buildingKey === 'granary') {
      var grCap = this.GD.getStorageCapacity(grLevel);
      return grCap > 0 ? (res.crop || 0) / grCap : 0;
    }
    return 0;
  };

  BuildOptimizer.prototype._getTotalProductionForBonus = function (buildingKey, villageState) {
    var prod = villageState.production || {};
    var bonusMap = {
      sawmill: prod.wood || 0,
      brickyard: prod.clay || 0,
      ironFoundry: prod.iron || 0,
      grainMill: prod.crop || 0,
      bakery: prod.crop || 0,
    };
    return bonusMap[buildingKey] || 0;
  };

  BuildOptimizer.prototype._applyUpgrade = function (simState, upgrade) {
    // Find and increment level in simulated state
    var list = upgrade.type === 'upgrade_resource' ? simState.resourceFields : simState.buildings;
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      if ((list[i].slot || list[i].id) === upgrade.slot) {
        list[i].level = (list[i].level || 0) + 1;
        break;
      }
    }
    // Update production if resource field
    if (upgrade.type === 'upgrade_resource') {
      var typeMap = { woodcutter: 'wood', clayPit: 'clay', ironMine: 'iron', cropField: 'crop' };
      var resType = typeMap[upgrade.buildingKey];
      if (resType && simState.production) {
        var gain = this.GD.getProductionGain(upgrade.fromLevel);
        simState.production[resType] = (simState.production[resType] || 0) + gain;
      }
    }
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = BuildOptimizer;
  else if (typeof self !== 'undefined') self.TravianBuildOptimizer = BuildOptimizer;
  else if (typeof window !== 'undefined') window.TravianBuildOptimizer = BuildOptimizer;
})();
