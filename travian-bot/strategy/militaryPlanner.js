/**
 * militaryPlanner.js — Troop Strategy, Farming & Risk Assessment
 *
 * Evaluates troop efficiency, plans raids, scores farm targets,
 * assesses defense needs, and calculates threat risk.
 *
 * Depends on: TravianGameData (gameData.js)
 */
(function () {
  'use strict';

  var GD = (typeof self !== 'undefined' && self.TravianGameData) ||
           (typeof window !== 'undefined' && window.TravianGameData) ||
           (typeof global !== 'undefined' && global.TravianGameData) ||
           (typeof require === 'function' ? require('./gameData') : null);

  // =========================================================================
  // MilitaryPlanner
  // =========================================================================
  function MilitaryPlanner() {
    this.GD = GD;
  }

  // -------------------------------------------------------------------------
  // Troop Efficiency Analysis
  // -------------------------------------------------------------------------

  /**
   * Calculate efficiency metrics for a troop type.
   *
   * @param {string} tribe - 'roman' | 'teuton' | 'gaul'
   * @param {string} unitKey - e.g. 'clubswinger', 'legionnaire'
   * @returns {{ attackPerRes, defPerRes, farmEfficiency, raidScore, costTotal }}
   */
  MilitaryPlanner.prototype.troopEfficiency = function (tribe, unitKey) {
    var troops = this.GD.TROOPS[tribe];
    if (!troops || !troops[unitKey]) return null;

    var unit = troops[unitKey];
    var totalCost = this.GD.totalCost(unit.cost);

    return {
      unit: unitKey,
      tribe: tribe,
      costTotal: totalCost,
      attackPerRes: totalCost > 0 ? Math.round(unit.attack / totalCost * 1000) / 1000 : 0,
      defInfPerRes: totalCost > 0 ? Math.round(unit.defInf / totalCost * 1000) / 1000 : 0,
      defCavPerRes: totalCost > 0 ? Math.round(unit.defCav / totalCost * 1000) / 1000 : 0,
      farmEfficiency: totalCost > 0 ? Math.round(unit.carry / totalCost * 1000) / 1000 : 0,
      raidScore: totalCost > 0 ? Math.round((unit.carry * unit.speed) / totalCost * 1000) / 1000 : 0,
      upkeepEfficiency: unit.upkeep > 0 ? Math.round(unit.attack / unit.upkeep * 10) / 10 : 0,
    };
  };

  /**
   * Rank all troops of a tribe by a given purpose.
   *
   * @param {string} tribe
   * @param {'attack'|'defense'|'farming'|'raiding'} purpose
   * @returns {Array<{unit, score, ...}>}
   */
  MilitaryPlanner.prototype.rankTroops = function (tribe, purpose) {
    var troops = this.GD.TROOPS[tribe];
    if (!troops) return [];

    var self = this;
    var results = [];

    for (var key in troops) {
      var eff = self.troopEfficiency(tribe, key);
      if (!eff) continue;

      var score = 0;
      switch (purpose) {
        case 'attack':  score = eff.attackPerRes; break;
        case 'defense':  score = (eff.defInfPerRes + eff.defCavPerRes) / 2; break;
        case 'farming':  score = eff.farmEfficiency; break;
        case 'raiding':  score = eff.raidScore; break;
      }

      eff.score = score;
      results.push(eff);
    }

    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  };

  // -------------------------------------------------------------------------
  // Farm Target Scoring
  // -------------------------------------------------------------------------

  /**
   * Score a farm target for raid worthiness.
   *
   * @param {object} target - { x, y, population, lastLoot, lastRaidTime, wallLevel, losses }
   * @param {object} origin - { x, y }
   * @param {object} troops - { type, count, speed, carryPerUnit }
   * @param {number} serverSpeed
   * @returns {{ score, expectedLoot, travelTime, risk, efficiency }}
   */
  MilitaryPlanner.prototype.scoreFarmTarget = function (target, origin, troops, serverSpeed) {
    serverSpeed = serverSpeed || 1;

    // Distance calculation (Travian uses Euclidean distance)
    var dx = target.x - origin.x;
    var dy = target.y - origin.y;
    var distance = Math.sqrt(dx * dx + dy * dy);

    // Travel time in hours (one way)
    var speed = troops.speed || 7;
    var travelTimeHours = distance / (speed * serverSpeed);
    var roundTripHours = travelTimeHours * 2;

    // Expected loot estimation
    var estimatedProduction = (target.population || 10) * 4; // rough: pop * 4 resources/hr
    var timeSinceLastRaid = target.lastRaidTime
      ? (Date.now() - target.lastRaidTime) / 3600000
      : 6; // assume 6 hours if unknown
    var availableLoot = Math.round(estimatedProduction * timeSinceLastRaid);
    var carryCapacity = (troops.count || 1) * (troops.carryPerUnit || 50);
    var expectedLoot = Math.min(availableLoot, carryCapacity);

    // Risk estimation (0 = safe, 1 = dangerous)
    var wallRisk = (target.wallLevel || 0) * 0.05; // each wall level adds 5% risk
    var lossHistory = target.losses || 0;
    var lossRisk = Math.min(lossHistory * 0.2, 0.5);
    var populationRisk = Math.min((target.population || 0) / 500, 0.5);
    var risk = Math.min(wallRisk + lossRisk + populationRisk, 1.0);

    // Success probability (inverse of risk)
    var successProb = 1 - risk;

    // Efficiency: expected value per hour of troop commitment
    var expectedValue = expectedLoot * successProb;
    var efficiency = roundTripHours > 0 ? Math.round(expectedValue / roundTripHours) : 0;

    // Composite score
    var score = efficiency * (1 - risk * 0.5); // penalize risky targets

    return {
      score: Math.round(score),
      expectedLoot: expectedLoot,
      travelTimeHours: Math.round(roundTripHours * 100) / 100,
      distance: Math.round(distance * 10) / 10,
      risk: Math.round(risk * 100) / 100,
      successProbability: Math.round(successProb * 100) / 100,
      efficiency: efficiency,
      recommendation: risk > 0.6 ? 'AVOID' : risk > 0.3 ? 'CAUTION' : 'SAFE',
    };
  };

  /**
   * Rank multiple farm targets and plan optimal raid order.
   *
   * @param {Array} targets - Array of target objects
   * @param {object} origin
   * @param {object} troops
   * @param {number} maxRaids - Max concurrent raids
   * @param {number} serverSpeed
   * @returns {Array} Sorted targets with scores
   */
  MilitaryPlanner.prototype.planRaids = function (targets, origin, troops, maxRaids, serverSpeed) {
    var self = this;
    maxRaids = maxRaids || 10;

    var scored = targets.map(function (t) {
      var result = self.scoreFarmTarget(t, origin, troops, serverSpeed);
      result.target = t;
      return result;
    });

    // Filter out dangerous targets
    scored = scored.filter(function (s) { return s.recommendation !== 'AVOID'; });

    // Sort by score descending
    scored.sort(function (a, b) { return b.score - a.score; });

    return scored.slice(0, maxRaids);
  };

  // -------------------------------------------------------------------------
  // Farming Efficiency Analysis
  // -------------------------------------------------------------------------

  /**
   * Analyze overall farming efficiency.
   *
   * @param {object} farmData - { totalRaids, totalLoot, totalLosses, averageLootPerRaid, raidsPerDay }
   * @param {object} troopCosts - { totalInvestment, upkeepPerHour }
   * @returns {{ efficiencyScore, profitPerHour, roiDays, grade, advice }}
   */
  MilitaryPlanner.prototype.analyzeFarmingEfficiency = function (farmData, troopCosts) {
    var lootPerHour = farmData.raidsPerDay ? (farmData.totalLoot / (farmData.totalRaids || 1)) * (farmData.raidsPerDay / 24) : 0;
    var upkeep = troopCosts.upkeepPerHour || 0;
    var netProfit = lootPerHour - upkeep;

    var roiDays = troopCosts.totalInvestment > 0 ? troopCosts.totalInvestment / (netProfit * 24) : Infinity;

    var lossRate = farmData.totalRaids > 0 ? (farmData.totalLosses || 0) / farmData.totalRaids : 0;

    // Grade: A-F
    var grade;
    if (netProfit > 500 && lossRate < 0.01) grade = 'A';
    else if (netProfit > 200 && lossRate < 0.05) grade = 'B';
    else if (netProfit > 50 && lossRate < 0.1) grade = 'C';
    else if (netProfit > 0) grade = 'D';
    else grade = 'F';

    var advice = [];
    if (lossRate > 0.05) advice.push('Loss rate too high (' + Math.round(lossRate * 100) + '%). Scout before raiding.');
    if (netProfit < upkeep) advice.push('Farming barely covers troop upkeep. Optimize targets or increase carry capacity.');
    if (farmData.raidsPerDay < 5) advice.push('Increase raid frequency. More frequent small raids > infrequent large raids.');
    if (grade === 'A') advice.push('Excellent farming operation. Consider expanding farm list.');

    return {
      efficiencyScore: Math.round(netProfit),
      lootPerHour: Math.round(lootPerHour),
      profitPerHour: Math.round(netProfit),
      upkeepPerHour: Math.round(upkeep),
      roiDays: Math.round(roiDays * 10) / 10,
      lossRate: Math.round(lossRate * 1000) / 10, // percentage
      grade: grade,
      advice: advice,
    };
  };

  // -------------------------------------------------------------------------
  // Defense Assessment
  // -------------------------------------------------------------------------

  /**
   * Assess village defense strength and needs.
   *
   * @param {object} villageState
   * @param {string} tribe
   * @param {number} threatLevel - 0 (safe) to 10 (extreme danger)
   * @returns {{ defenseScore, wallBonus, troopDefense, recommendation, needed }}
   */
  MilitaryPlanner.prototype.assessDefense = function (villageState, tribe, threatLevel) {
    threatLevel = threatLevel || 0;

    var wallLevel = 0;
    (villageState.buildings || []).forEach(function (b) {
      if (b.gid === 31 || b.gid === 32 || b.gid === 33) wallLevel = b.level || 0;
    });

    var wallBonusPct = this.GD.getWallBonus(wallLevel);
    var wallBaseDef = this.GD.WALL_BASE_DEF[tribe] || 0;
    var wallDefense = wallBaseDef * wallLevel;

    // Estimate troop defense from troops array
    var troops = this.GD.TROOPS[tribe] || {};
    var troopDefense = 0;
    var troopCount = villageState.troops || {};
    for (var unitKey in troopCount) {
      var unit = troops[unitKey];
      if (unit) {
        var count = troopCount[unitKey] || 0;
        troopDefense += count * ((unit.defInf + unit.defCav) / 2);
      }
    }

    var totalDefense = troopDefense * (1 + wallBonusPct / 100) + wallDefense;

    // Required defense based on threat level
    var requiredDefense = threatLevel * threatLevel * 200; // exponential scaling

    var defenseScore = requiredDefense > 0 ? Math.min(totalDefense / requiredDefense, 2.0) : 2.0;

    var recommendation;
    var needed = [];
    if (defenseScore >= 1.5) {
      recommendation = 'Defense is strong. Focus on offense/economy.';
    } else if (defenseScore >= 1.0) {
      recommendation = 'Defense is adequate. Monitor threats.';
    } else if (defenseScore >= 0.5) {
      recommendation = 'Defense is weak. Train defenders urgently.';
      needed.push('Train defensive troops (deficit: ' + Math.round(requiredDefense - totalDefense) + ' defense points)');
      if (wallLevel < 10) needed.push('Upgrade wall to at least level 10');
    } else {
      recommendation = 'CRITICAL: Village is nearly undefended!';
      needed.push('Emergency defense build required');
      needed.push('Request alliance defense support');
      if (wallLevel < 5) needed.push('Build wall immediately');
    }

    return {
      defenseScore: Math.round(defenseScore * 100) / 100,
      wallLevel: wallLevel,
      wallBonusPct: wallBonusPct,
      troopDefense: Math.round(troopDefense),
      totalDefense: Math.round(totalDefense),
      requiredDefense: Math.round(requiredDefense),
      recommendation: recommendation,
      needed: needed,
    };
  };

  // -------------------------------------------------------------------------
  // Risk Assessment
  // -------------------------------------------------------------------------

  /**
   * Calculate overall risk score for a village.
   *
   * @param {object} villageState
   * @param {string} tribe
   * @param {Array} enemies - [{ x, y, population, aggressionLevel }]
   * @param {object} origin - { x, y }
   * @returns {{ riskScore, riskLevel, threats, advice }}
   */
  MilitaryPlanner.prototype.assessRisk = function (villageState, tribe, enemies, origin) {
    enemies = enemies || [];
    var totalThreat = 0;

    var threats = enemies.map(function (enemy) {
      var dx = enemy.x - origin.x;
      var dy = enemy.y - origin.y;
      var distance = Math.sqrt(dx * dx + dy * dy);
      var proximity = distance > 0 ? 1 / distance : 10;
      var power = (enemy.population || 50) * (enemy.aggressionLevel || 1);
      var threat = power * proximity;
      totalThreat += threat;
      return {
        distance: Math.round(distance * 10) / 10,
        power: Math.round(power),
        threat: Math.round(threat * 100) / 100,
      };
    });

    var defense = this.assessDefense(villageState, tribe, Math.sqrt(totalThreat));
    var riskScore = defense.totalDefense > 0 ? totalThreat / defense.totalDefense : totalThreat;
    riskScore = Math.min(riskScore, 10);

    var riskLevel;
    if (riskScore < 1) riskLevel = 'LOW';
    else if (riskScore < 3) riskLevel = 'MODERATE';
    else if (riskScore < 6) riskLevel = 'HIGH';
    else riskLevel = 'CRITICAL';

    var advice = [];
    if (riskLevel === 'LOW') advice.push('Safe to focus on economy.');
    if (riskLevel === 'MODERATE') advice.push('Maintain basic defenses. Keep crannies upgraded.');
    if (riskLevel === 'HIGH') advice.push('Prioritize wall + defense troops. Consider dodging attacks.');
    if (riskLevel === 'CRITICAL') advice.push('Immediate danger! Request alliance help. Build crannies. Dodge troops.');

    return {
      riskScore: Math.round(riskScore * 100) / 100,
      riskLevel: riskLevel,
      threats: threats,
      defense: defense,
      advice: advice,
    };
  };

  // -------------------------------------------------------------------------
  // Troop Production Plan
  // -------------------------------------------------------------------------

  /**
   * Recommend troop production strategy based on game phase and needs.
   *
   * @param {string} tribe
   * @param {string} phase - 'early'|'mid'|'late'
   * @param {number} threatLevel
   * @param {object} resources - available resources
   * @returns {{ primaryUnit, secondaryUnit, ratio, reasoning, queue }}
   */
  MilitaryPlanner.prototype.troopProductionPlan = function (tribe, phase, threatLevel, resources) {
    var profile = this.GD.TRIBE_PROFILES[tribe];
    if (!profile) return null;

    var plan = { queue: [], reasoning: [] };

    if (phase === 'early') {
      // Early: small farming force
      plan.primaryUnit = profile.bestFarmer;
      plan.ratio = { offense: 0.8, defense: 0.2 };
      plan.reasoning.push('Early game: build farming troops to fuel economy.');
      plan.reasoning.push('Primary: ' + profile.bestFarmer + ' for farm raids.');
    } else if (phase === 'mid') {
      if (threatLevel > 3) {
        // Under threat: defensive focus
        plan.primaryUnit = profile.bestDefInf;
        plan.secondaryUnit = profile.bestDefCav;
        plan.ratio = { offense: 0.3, defense: 0.7 };
        plan.reasoning.push('Mid game with threats: defensive build.');
      } else {
        // Safe: balanced build
        plan.primaryUnit = profile.bestOff;
        plan.secondaryUnit = profile.bestDefInf;
        plan.ratio = { offense: 0.6, defense: 0.4 };
        plan.reasoning.push('Mid game: balanced offense/defense split.');
      }
    } else {
      // Late: full military
      plan.primaryUnit = profile.bestOff;
      plan.secondaryUnit = profile.bestDefCav;
      plan.ratio = { offense: 0.7, defense: 0.3 };
      plan.reasoning.push('Late game: heavy offense build for alliance operations.');
    }

    // Calculate how many we can afford
    var primary = this.GD.TROOPS[tribe][plan.primaryUnit];
    if (primary && resources) {
      var maxByRes = Math.min(
        Math.floor((resources.wood || 0) / primary.cost.wood),
        Math.floor((resources.clay || 0) / primary.cost.clay),
        Math.floor((resources.iron || 0) / primary.cost.iron),
        Math.floor((resources.crop || 0) / primary.cost.crop)
      );
      plan.affordableCount = Math.max(0, maxByRes);
      plan.queue.push({ unit: plan.primaryUnit, count: Math.min(plan.affordableCount, 20), building: primary.building });
    }

    return plan;
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = MilitaryPlanner;
  else if (typeof self !== 'undefined') self.TravianMilitaryPlanner = MilitaryPlanner;
  else if (typeof window !== 'undefined') window.TravianMilitaryPlanner = MilitaryPlanner;
})();
