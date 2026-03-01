/**
 * strategyEngine.js — Main Travian Strategy Engine
 *
 * Orchestrates all strategy modules: build optimization, military planning,
 * risk assessment, phase detection, and forward simulation.
 *
 * Produces comprehensive strategic analysis with ranked recommendations.
 *
 * Depends on:
 *   - TravianGameData      (gameData.js)
 *   - TravianBuildOptimizer (buildOptimizer.js)
 *   - TravianMilitaryPlanner (militaryPlanner.js)
 */
(function () {
  'use strict';

  // Resolve dependencies (supports service worker, browser, and Node.js)
  var resolve = function (name, fallbackPath) {
    if (typeof self !== 'undefined' && self[name]) return self[name];
    if (typeof window !== 'undefined' && window[name]) return window[name];
    if (typeof global !== 'undefined' && global[name]) return global[name];
    if (typeof require === 'function' && fallbackPath) {
      try { return require(fallbackPath); } catch (_) {}
    }
    return null;
  };

  var GD = resolve('TravianGameData', './gameData');
  var BuildOptimizer = resolve('TravianBuildOptimizer', './buildOptimizer');
  var MilitaryPlanner = resolve('TravianMilitaryPlanner', './militaryPlanner');

  // =========================================================================
  // StrategyEngine
  // =========================================================================
  function StrategyEngine() {
    this.buildOptimizer = BuildOptimizer ? new BuildOptimizer() : null;
    this.militaryPlanner = MilitaryPlanner ? new MilitaryPlanner() : null;
    this.GD = GD;
  }

  // =========================================================================
  // Phase Detection
  // =========================================================================

  /**
   * Detect the current game phase based on game state indicators.
   *
   * @deprecated Phase detection is now unified under GlobalPlanner as the
   *   single authority. This method is retained for backward compatibility
   *   (used by StrategyEngine.analyze() for phaseDetection output) but
   *   DecisionEngine derives its currentPhase from GlobalPlanner instead.
   *   Do NOT add new consumers of this method; use GlobalPlanner.phase.
   *
   * @param {object} params
   *   { gameDay, serverSpeed, villageCount, totalPopulation, armySize,
   *     highestBuildingLevel, totalResourceProduction }
   * @returns {{ phase: string, confidence: number, indicators: object }}
   */
  StrategyEngine.prototype.detectPhase = function (params) {
    var speed = params.serverSpeed || 1;
    var day = params.gameDay || 1;
    var villages = params.villageCount || 1;
    var pop = params.totalPopulation || 0;
    var army = params.armySize || 0;
    var maxBuilding = params.highestBuildingLevel || 0;
    var totalProd = params.totalResourceProduction || 0;

    // Normalize game day by server speed (day 30 on 3x = day 10 on 1x)
    var normalizedDay = day / speed;

    // Score each phase (0-1)
    var earlyScore = 0;
    var midScore = 0;
    var lateScore = 0;

    // Time-based indicators
    if (normalizedDay < 20) earlyScore += 0.4;
    else if (normalizedDay < 60) midScore += 0.4;
    else lateScore += 0.4;

    // Village count
    if (villages <= 1) earlyScore += 0.2;
    else if (villages <= 4) midScore += 0.2;
    else lateScore += 0.2;

    // Population
    if (pop < 200) earlyScore += 0.15;
    else if (pop < 800) midScore += 0.15;
    else lateScore += 0.15;

    // Army size
    if (army < 50) earlyScore += 0.1;
    else if (army < 500) midScore += 0.1;
    else lateScore += 0.1;

    // Building levels
    if (maxBuilding < 8) earlyScore += 0.15;
    else if (maxBuilding < 15) midScore += 0.15;
    else lateScore += 0.15;

    // Determine phase
    var phase, confidence;
    if (earlyScore >= midScore && earlyScore >= lateScore) {
      phase = 'early';
      confidence = earlyScore;
    } else if (midScore >= lateScore) {
      phase = 'mid';
      confidence = midScore;
    } else {
      phase = 'late';
      confidence = lateScore;
    }

    return {
      phase: phase,
      confidence: Math.round(confidence * 100),
      indicators: {
        normalizedDay: Math.round(normalizedDay),
        earlyScore: Math.round(earlyScore * 100),
        midScore: Math.round(midScore * 100),
        lateScore: Math.round(lateScore * 100),
      },
    };
  };

  // =========================================================================
  // Phase-Specific Strategy
  // =========================================================================

  /**
   * Get strategic priorities for the current phase.
   *
   * @param {string} phase
   * @param {string} tribe
   * @returns {{ priorities, focus, avoid, tips }}
   */
  StrategyEngine.prototype.getPhaseStrategy = function (phase, tribe) {
    var profile = this.GD ? this.GD.TRIBE_PROFILES[tribe] : null;

    var strategies = {
      early: {
        priorities: [
          'Maximize resource field upgrades (focus on ROI)',
          'Upgrade Main Building to level 10+',
          'Build Warehouse/Granary as needed to prevent overflow',
          'Start hero adventure farming',
          'Build small raiding force (' + (profile ? profile.bestFarmer : 'farmers') + ')',
          'Plan for 2nd village by day 5-7 (speed-adjusted)',
        ],
        focus: 'ECONOMY',
        avoid: ['Large military investment', 'Unnecessary infrastructure', 'PvP combat'],
        tips: [
          tribe === 'teuton' ? 'Use clubswingers for early farming - cheap and high carry' :
          tribe === 'gaul' ? 'Double cranny protection lets you save more resources' :
          'Roman double build queue is your advantage - always have 2 buildings going',
          'Upgrade lowest-level resource fields first for best ROI',
          'Keep hero on resource production bonus until level 10+',
        ],
      },
      mid: {
        priorities: [
          'Optimize farming operations',
          'Build balanced troop composition',
          'Upgrade resource fields to 8-10',
          'Build bonus buildings (sawmill, brickyard, etc.) at resource level 10',
          'Expand to 3-5 villages',
          'Upgrade wall to level 10+',
          'Research key military upgrades at academy',
        ],
        focus: 'BALANCED',
        avoid: ['Neglecting defense', 'Over-expanding without troops', 'Idle production buildings'],
        tips: [
          'Specialize villages: one for offense, one for defense, rest for resources',
          'Farm list raids every 10-15 minutes for maximum income',
          'Start coordinating with alliance for defense operations',
        ],
      },
      late: {
        priorities: [
          'Full military production',
          'Alliance coordination for operations',
          'Resource funneling to hammer village',
          'Max out key buildings in capital',
          'Prepare siege units (rams, catapults)',
          'Defense coordination with alliance',
        ],
        focus: 'MILITARY',
        avoid: ['Solo operations', 'Uncoordinated attacks', 'Neglecting defense on support villages'],
        tips: [
          'Capital should be maxed resource fields with Great Barracks/Stable',
          'Coordinate hammer timing with alliance for maximum impact',
          'Keep scouts active to detect incoming attacks',
        ],
      },
    };

    return strategies[phase] || strategies.mid;
  };

  // =========================================================================
  // Expansion Planner
  // =========================================================================

  /**
   * Evaluate expansion readiness and timing.
   *
   * @param {object} villageState
   * @param {string} phase
   * @param {number} currentVillages
   * @returns {{ ready, readinessScore, requirements, estimatedTimeHours, advice }}
   */
  StrategyEngine.prototype.evaluateExpansion = function (villageState, phase, currentVillages) {
    if (!this.GD) return { ready: false, readinessScore: 0, requirements: ['Game data not loaded'], advice: [] };

    var requirements = [];
    var score = 0;

    // Check residence/palace
    var hasResidence = false;
    var residenceLevel = 0;
    (villageState.buildings || []).forEach(function (b) {
      if ((b.gid === 25 || b.gid === 26) && (b.level || 0) >= 10) {
        hasResidence = true;
        residenceLevel = b.level;
      }
    });

    if (hasResidence) {
      score += 0.3;
    } else {
      requirements.push('Need Residence/Palace level 10+ (current: ' + residenceLevel + ')');
    }

    // Check resources for 3 settlers
    var settlerCost = this.GD.SETTLER_COST;
    var totalNeeded = {
      wood: settlerCost.wood * 3,
      clay: settlerCost.clay * 3,
      iron: settlerCost.iron * 3,
      crop: settlerCost.crop * 3,
    };
    var res = villageState.resources || {};
    var canAfford = res.wood >= totalNeeded.wood && res.clay >= totalNeeded.clay &&
                    res.iron >= totalNeeded.iron && res.crop >= totalNeeded.crop;

    if (canAfford) {
      score += 0.3;
    } else {
      var deficit = {
        wood: Math.max(0, totalNeeded.wood - (res.wood || 0)),
        clay: Math.max(0, totalNeeded.clay - (res.clay || 0)),
        iron: Math.max(0, totalNeeded.iron - (res.iron || 0)),
        crop: Math.max(0, totalNeeded.crop - (res.crop || 0)),
      };
      requirements.push('Need resources for 3 settlers: ' + JSON.stringify(totalNeeded));
      requirements.push('Deficit: ' + JSON.stringify(deficit));
    }

    // Check culture points (simplified)
    var hasCulturePoints = currentVillages < 3; // first expansions are easier
    if (hasCulturePoints) score += 0.2;
    else requirements.push('May need culture points (celebrations at Town Hall)');

    // Production capacity
    var prod = villageState.production || {};
    var totalProd = (prod.wood || 0) + (prod.clay || 0) + (prod.iron || 0) + (prod.crop || 0);
    if (totalProd > 300) score += 0.2;
    else requirements.push('Low production (' + totalProd + '/hr). Upgrade resource fields first.');

    // Estimate time to readiness
    var maxDeficit = Math.max(
      totalNeeded.wood - (res.wood || 0),
      totalNeeded.clay - (res.clay || 0),
      totalNeeded.iron - (res.iron || 0),
      totalNeeded.crop - (res.crop || 0),
      0
    );
    var avgProd = totalProd / 4;
    var estimatedHours = avgProd > 0 ? maxDeficit / avgProd : Infinity;

    var advice = [];
    if (score >= 0.8) advice.push('Ready to settle! Choose a 15-cropper for capital or 9-cropper for support.');
    else if (score >= 0.5) advice.push('Almost ready. Focus on requirements above.');
    else if (phase === 'early') advice.push('Settle early for maximum advantage. Rush residence level 10.');
    else advice.push('Expansion delayed. Consider trading for resources.');

    return {
      ready: score >= 0.8,
      readinessScore: Math.round(score * 100),
      requirements: requirements,
      estimatedTimeHours: Math.round(estimatedHours * 10) / 10,
      advice: advice,
    };
  };

  // =========================================================================
  // Forward Simulation
  // =========================================================================

  /**
   * Project resource levels forward in time.
   *
   * @param {object} resources - Current resources {wood, clay, iron, crop}
   * @param {object} production - Per hour {wood, clay, iron, crop}
   * @param {number} hours - Hours to project
   * @param {object} capacity - {warehouse, granary} levels
   * @returns {{ projected, overflowAt, wastedResources }}
   */
  StrategyEngine.prototype.projectResources = function (resources, production, hours, capacity) {
    if (!this.GD) return null;

    var whCap = this.GD.getStorageCapacity(capacity.warehouse || 1);
    var grCap = this.GD.getStorageCapacity(capacity.granary || 1);

    var caps = { wood: whCap, clay: whCap, iron: whCap, crop: grCap };
    var projected = {};
    var overflowAt = {};
    var wasted = {};

    ['wood', 'clay', 'iron', 'crop'].forEach(function (type) {
      var current = resources[type] || 0;
      var prod = production[type] || 0;
      var cap = caps[type];

      var raw = current + prod * hours;
      projected[type] = Math.min(raw, cap);
      wasted[type] = Math.max(0, raw - cap);

      // When does it overflow?
      var remaining = cap - current;
      overflowAt[type] = prod > 0 ? Math.round(remaining / prod * 10) / 10 : null;
    });

    return {
      projected: projected,
      overflowAt: overflowAt,
      wastedResources: wasted,
      totalWasted: wasted.wood + wasted.clay + wasted.iron + wasted.crop,
    };
  };

  /**
   * Compare two build orders by simulating forward.
   *
   * @param {object} villageState - Starting state
   * @param {Array} orderA - Build order A [{building, fromLevel}, ...]
   * @param {Array} orderB - Build order B
   * @param {number} horizonHours - How far to simulate
   * @returns {{ orderA: {totalProduction, time}, orderB: {totalProduction, time}, winner, advantage }}
   */
  StrategyEngine.prototype.compareBuildOrders = function (villageState, orderA, orderB, horizonHours) {
    horizonHours = horizonHours || 24;

    var resultA = this._simulateBuildOrder(villageState, orderA, horizonHours);
    var resultB = this._simulateBuildOrder(villageState, orderB, horizonHours);

    var advantage = resultA.totalProductionPerHour - resultB.totalProductionPerHour;

    return {
      orderA: resultA,
      orderB: resultB,
      winner: advantage > 0 ? 'A' : advantage < 0 ? 'B' : 'TIE',
      advantagePerHour: Math.round(Math.abs(advantage)),
      explanation: Math.abs(advantage) < 5
        ? 'Orders are roughly equivalent'
        : 'Order ' + (advantage > 0 ? 'A' : 'B') + ' produces ' + Math.round(Math.abs(advantage)) + ' more resources/hr',
    };
  };

  StrategyEngine.prototype._simulateBuildOrder = function (villageState, order, horizonHours) {
    if (!this.GD) return { totalProductionPerHour: 0, totalBuildTime: 0 };

    var prod = JSON.parse(JSON.stringify(villageState.production || { wood: 10, clay: 10, iron: 10, crop: 10 }));
    var totalBuildTime = 0;
    var mbLevel = 1;

    // Find current MB level
    (villageState.buildings || []).forEach(function (b) {
      if ((b.gid || b.id) === 15) mbLevel = b.level || 1;
    });

    var GD = this.GD;
    var typeMap = { woodcutter: 'wood', clayPit: 'clay', ironMine: 'iron', cropField: 'crop' };

    (order || []).forEach(function (step) {
      var building = step.building || step.buildingKey;
      var fromLevel = step.fromLevel || 0;
      var buildTime = GD.getConstructionTime(building, fromLevel, mbLevel, 1) / 3600; // hours
      totalBuildTime += buildTime;

      // If it's a resource building, add production
      var resType = typeMap[building];
      if (resType) {
        prod[resType] = (prod[resType] || 0) + GD.getProductionGain(fromLevel);
      }
      if (building === 'mainBuilding') mbLevel++;
    });

    var totalProd = (prod.wood || 0) + (prod.clay || 0) + (prod.iron || 0) + (prod.crop || 0);

    return {
      totalProductionPerHour: Math.round(totalProd),
      production: prod,
      totalBuildTimeHours: Math.round(totalBuildTime * 10) / 10,
    };
  };

  // =========================================================================
  // Main Analysis — Comprehensive Output
  // =========================================================================

  /**
   * Run complete strategic analysis.
   *
   * @param {object} input
   *   { tribe, serverSpeed, gameDay, villageCount,
   *     villageState: { resourceFields, buildings, resources, production, storage, troops },
   *     enemies: [{x, y, population, aggressionLevel}],
   *     farmData: { totalRaids, totalLoot, totalLosses, raidsPerDay },
   *     origin: {x, y},
   *     threatLevel }
   *
   * @returns {object} Full strategic analysis
   */
  StrategyEngine.prototype.analyze = function (input) {
    var tribe = input.tribe || 'roman';
    var serverSpeed = input.serverSpeed || 1;
    var villageState = input.villageState || {};
    var enemies = input.enemies || [];
    var origin = input.origin || { x: 0, y: 0 };

    // 1. Phase Detection
    var totalProd = 0;
    var prod = villageState.production || {};
    totalProd = (prod.wood || 0) + (prod.clay || 0) + (prod.iron || 0) + (prod.crop || 0);
    var maxBuildLevel = 0;
    (villageState.buildings || []).forEach(function (b) {
      if ((b.level || 0) > maxBuildLevel) maxBuildLevel = b.level;
    });

    var phaseResult = this.detectPhase({
      gameDay: input.gameDay || 1,
      serverSpeed: serverSpeed,
      villageCount: input.villageCount || 1,
      totalPopulation: input.totalPopulation || 0,
      armySize: input.armySize || 0,
      highestBuildingLevel: maxBuildLevel,
      totalResourceProduction: totalProd,
    });

    var phase = phaseResult.phase;

    // 2. Phase Strategy
    var phaseStrategy = this.getPhaseStrategy(phase, tribe);

    // 3. Build Optimization
    var buildRanking = this.buildOptimizer
      ? this.buildOptimizer.rankUpgrades(villageState, phase, 20)
      : [];

    var buildOrder = this.buildOptimizer
      ? this.buildOptimizer.suggestBuildOrder(villageState, phase, 5)
      : [];

    // 4. Overflow Detection
    var overflow = this.buildOptimizer
      ? this.buildOptimizer.detectOverflow(villageState)
      : {};

    // 5. Bottleneck
    var bottleneck = this.buildOptimizer
      ? this.buildOptimizer.getBottleneck(villageState)
      : {};

    // 6. Risk Assessment
    var risk = this.militaryPlanner
      ? this.militaryPlanner.assessRisk(villageState, tribe, enemies, origin)
      : { riskScore: 0, riskLevel: 'UNKNOWN' };

    // 7. Troop Strategy
    var troopPlan = this.militaryPlanner
      ? this.militaryPlanner.troopProductionPlan(tribe, phase, input.threatLevel || 0, villageState.resources)
      : null;

    // 8. Farming Analysis
    var farmAnalysis = null;
    if (input.farmData && this.militaryPlanner) {
      farmAnalysis = this.militaryPlanner.analyzeFarmingEfficiency(
        input.farmData,
        input.troopCosts || { totalInvestment: 0, upkeepPerHour: 0 }
      );
    }

    // 9. Expansion Evaluation
    var expansion = this.evaluateExpansion(villageState, phase, input.villageCount || 1);

    // 10. Resource Projection (next 6 hours)
    var projection = this.projectResources(
      villageState.resources || {},
      villageState.production || {},
      6,
      villageState.storage || { warehouse: 1, granary: 1 }
    );

    // 11. Compile Top 10 Recommendations
    var recommendations = this._compileRecommendations(
      buildRanking, overflow, risk, troopPlan, expansion, phase, bottleneck
    );

    // =====================================================================
    // Final Output
    // =====================================================================
    return {
      // Meta
      timestamp: Date.now(),
      tribe: tribe,
      serverSpeed: serverSpeed,

      // 1. Ranked Recommendations (top 10)
      recommendations: recommendations,

      // 2. Build Order & Ranking
      buildOrder: buildOrder,
      buildRanking: buildRanking,  // ROI-ranked upgrade candidates (used by DecisionEngine)

      // 3. Troop Strategy
      troopStrategy: troopPlan,

      // 4. Farming Efficiency
      farmingAnalysis: farmAnalysis,

      // 5. Risk Assessment
      riskAssessment: risk,

      // 6. Resource Optimization
      resourceOptimization: {
        overflow: overflow,
        bottleneck: bottleneck,
        projection6h: projection,
      },

      // 7. Expansion Timing
      expansionTiming: expansion,

      // 8. Phase Strategy
      phaseDetection: phaseResult,
      phaseStrategy: phaseStrategy,
    };
  };

  // -------------------------------------------------------------------------
  // Compile final recommendations from all modules
  // -------------------------------------------------------------------------
  StrategyEngine.prototype._compileRecommendations = function (
    buildRanking, overflow, risk, troopPlan, expansion, phase, bottleneck
  ) {
    var recs = [];

    // Overflow emergencies (highest priority)
    if (overflow) {
      ['wood', 'clay', 'iron', 'crop'].forEach(function (type) {
        var o = overflow[type];
        if (o && o.critical) {
          recs.push({
            priority: 1,
            action: 'URGENT: Upgrade ' + (type === 'crop' ? 'Granary' : 'Warehouse'),
            reason: type + ' overflow in ' + o.hoursUntilFull + ' hours (' + o.fillPercent + '% full)',
            category: 'storage',
          });
        }
      });
    }

    // Risk emergencies
    if (risk && risk.riskLevel === 'CRITICAL') {
      recs.push({
        priority: 1,
        action: 'EMERGENCY: Build defenses immediately',
        reason: (risk.defense && risk.defense.recommendation) || 'Extreme threat detected. Risk score: ' + risk.riskScore,
        category: 'defense',
      });
    } else if (risk && risk.riskLevel === 'HIGH') {
      recs.push({
        priority: 2,
        action: 'Prioritize wall + defense troops',
        reason: (risk.defense && risk.defense.recommendation) || 'High threat level',
        category: 'defense',
      });
    }

    // Build recommendations
    (buildRanking || []).forEach(function (b, i) {
      recs.push({
        priority: (b.affordable ? 2 : 4) + (i * 0.1),
        action: (b.type === 'upgrade_resource' ? 'Upgrade ' : 'Build ') + b.buildingKey +
                ' (slot ' + b.slot + ') Lv.' + b.fromLevel + ' → ' + (b.fromLevel + 1),
        reason: b.reason + (b.affordable ? '' : ' [NOT AFFORDABLE YET]'),
        category: 'build',
        affordable: b.affordable,
        score: b.score,
      });
    });

    // Troop recommendation
    if (troopPlan && troopPlan.primaryUnit) {
      recs.push({
        priority: phase === 'late' ? 2 : 3,
        action: 'Train ' + troopPlan.primaryUnit + (troopPlan.affordableCount ? ' (can train ' + troopPlan.affordableCount + ')' : ''),
        reason: (troopPlan.reasoning || []).join('. '),
        category: 'military',
      });
    }

    // Expansion recommendation
    if (expansion && expansion.ready) {
      recs.push({
        priority: 2,
        action: 'Settle new village NOW',
        reason: 'All expansion requirements met. Score: ' + expansion.readinessScore + '%',
        category: 'expansion',
      });
    } else if (expansion && expansion.readinessScore > 50) {
      recs.push({
        priority: 3,
        action: 'Prepare for expansion (' + expansion.readinessScore + '% ready)',
        reason: (expansion.requirements || []).join('; '),
        category: 'expansion',
      });
    }

    // Sort by priority (lower number = higher priority)
    recs.sort(function (a, b) { return a.priority - b.priority; });

    // Assign final rank
    return recs.slice(0, 10).map(function (r, i) {
      r.rank = i + 1;
      return r;
    });
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = StrategyEngine;
  else if (typeof self !== 'undefined') self.TravianStrategyEngine = StrategyEngine;
  else if (typeof window !== 'undefined') window.TravianStrategyEngine = StrategyEngine;
})();
