/**
 * Test: DecisionEngine + Strategy Engine integration
 */
global.self = global;
global.chrome = { storage: { local: { get: function(){}, set: function(){} } } };
// TravianLogger stub for DecisionEngine's resource pressure logging
global.TravianLogger = { log: function(level, msg) { console.log('[' + level + '] ' + msg); } };

// Load in service-worker importScripts order
// In Node.js, module.exports takes priority over self assignment,
// so we must manually assign to self (which equals global here).
self.TravianGameData = require('./gameData.js');
self.TravianBuildOptimizer = require('./buildOptimizer.js');
self.TravianMilitaryPlanner = require('./militaryPlanner.js');
self.TravianStrategyEngine = require('./strategyEngine.js');
self.TravianResourceIntel = require('./resourceIntel.js');
// decisionEngine.js assigns to self directly (no module.exports)
require('../core/decisionEngine.js');

console.log('=== Module Loading ===');
console.log('GameData:', typeof self.TravianGameData === 'object' ? 'OK' : 'FAIL');
console.log('BuildOptimizer:', typeof self.TravianBuildOptimizer === 'function' ? 'OK' : 'FAIL');
console.log('MilitaryPlanner:', typeof self.TravianMilitaryPlanner === 'function' ? 'OK' : 'FAIL');
console.log('StrategyEngine:', typeof self.TravianStrategyEngine === 'function' ? 'OK' : 'FAIL');
console.log('ResourceIntel:', typeof self.TravianResourceIntel === 'function' ? 'OK' : 'FAIL');
console.log('DecisionEngine:', typeof self.TravianDecisionEngine === 'function' ? 'OK' : 'FAIL');

var engine = new self.TravianDecisionEngine();
console.log('');
console.log('=== Integration Check ===');
console.log('Strategy engine:', engine.strategyEngine ? 'INTEGRATED' : 'NOT FOUND');
console.log('Build optimizer:', engine.buildOptimizer ? 'INTEGRATED' : 'NOT FOUND');
console.log('Military planner:', engine.militaryPlanner ? 'INTEGRATED' : 'NOT FOUND');
console.log('Resource intel:', engine.resourceIntel ? 'INTEGRATED' : 'NOT FOUND');

// Simulate real game state from Asia 4
var gameState = {
  loggedIn: true,
  captcha: false,
  error: false,
  constructionQueue: { count: 0, maxCount: 1 },
  resourceFields: [
    {id:1, gid:1, level:7, type:'wood'},
    {id:3, gid:1, level:5, type:'wood'},
    {id:4, gid:3, level:4, type:'iron'},
    {id:5, gid:2, level:7, type:'clay'},
    {id:6, gid:2, level:6, type:'clay'},
    {id:7, gid:3, level:4, type:'iron'},
    {id:8, gid:4, level:5, type:'crop'},
    {id:10, gid:3, level:5, type:'iron'},
    {id:11, gid:3, level:4, type:'iron'},
    {id:14, gid:1, level:5, type:'wood'},
    {id:17, gid:1, level:6, type:'wood'},
    {id:18, gid:2, level:5, type:'clay'},
  ],
  buildings: [
    {slot:26, gid:15, level:5, id:15},  // Main Building
    {slot:31, gid:10, level:7, id:10},  // Warehouse
    {slot:32, gid:11, level:7, id:11},  // Granary
    {slot:34, gid:19, level:3, id:19},  // Barracks
    {slot:36, gid:25, level:3, id:25},  // Residence
    {slot:38, gid:17, level:3, id:17},  // Marketplace
  ],
  resources: { wood: 2800, clay: 3100, iron: 1500, crop: 2200 },
  production: { wood: 180, clay: 195, iron: 115, crop: 145 },
  troops: {},
};

var config = {
  autoResourceUpgrade: true,
  autoBuildingUpgrade: true,
  autoTroopTraining: true,
  tribe: 'gaul',
  serverSpeed: 1,
  troopConfig: {
    defaultTroopType: 't1',
    trainCount: 5,
    minResourceThreshold: { wood: 500, clay: 500, iron: 500, crop: 300 },
    trainingBuilding: 'barracks',
  },
};

var taskQueue = { hasTaskOfType: function() { return false; } };

console.log('');
console.log('=== Decision Cycle ===');
var tasks = engine.evaluate(gameState, config, taskQueue);
console.log('Phase detected:', engine.getPhase());
console.log('Tasks generated:', tasks.length);
console.log('');

tasks.forEach(function(t) {
  console.log('[' + t.type + '] priority=' + t.priority);
  console.log('  params: ' + JSON.stringify(t.params));
});

console.log('');
console.log('=== Strategy Analysis (for popup) ===');
var analysis = engine.getLastAnalysis();
if (analysis) {
  console.log('Phase:', analysis.phaseDetection.phase, '(' + analysis.phaseDetection.confidence + '%)');
  console.log('Focus:', analysis.phaseStrategy.focus);
  console.log('');
  console.log('Top 5 AI Recommendations:');
  (analysis.recommendations || []).slice(0, 5).forEach(function(r) {
    console.log('  #' + r.rank + ' [' + r.category.toUpperCase() + '] ' + r.action);
    console.log('       ' + r.reason);
  });
  console.log('');
  console.log('Bottleneck:', analysis.resourceOptimization.bottleneck
    ? analysis.resourceOptimization.bottleneck.bottleneck + ' (' + analysis.resourceOptimization.bottleneck.ratios[analysis.resourceOptimization.bottleneck.bottleneck] + '%)'
    : 'N/A');
  console.log('Risk:', analysis.riskAssessment.riskLevel);
  console.log('Expansion:', analysis.expansionTiming.readinessScore + '% ready');
} else {
  console.log('No analysis available');
}

console.log('');
console.log('=== Comparison: Old vs New ===');
console.log('OLD: Would pick lowest-level field (iron Lv.4)');
console.log('NEW: Picks by ROI score — see actual task above');

// =========================================================================
// Resource Intelligence integration tests
// =========================================================================
console.log('');
console.log('=== Resource Intelligence: Pressure Analysis ===');

var intel = engine.resourceIntel;
if (intel) {
  // Scenario 1: Normal state (low pressure)
  var snapshot1 = intel.buildSnapshot(gameState);
  var pressure1 = intel.pressure(snapshot1);
  console.log('Normal state pressure:', pressure1.overall, '(' + pressure1.level + ')');
  console.log('  Per-resource:', JSON.stringify(pressure1.perResource));
  console.log('  Overflow risk:', JSON.stringify(pressure1.overflowRisk));

  // Scenario 2: Near-full state (high pressure)
  var highFillState = JSON.parse(JSON.stringify(gameState));
  // Warehouse capacity at Lv.7 is ~16800; fill to 90%
  highFillState.resources = { wood: 15000, clay: 14500, iron: 16000, crop: 14000 };
  highFillState.resourceCapacity = { warehouse: 16800, granary: 16800 };

  var snapshot2 = intel.buildSnapshot(highFillState);
  var pressure2 = intel.pressure(snapshot2);
  console.log('');
  console.log('Near-full state pressure:', pressure2.overall, '(' + pressure2.level + ')');
  console.log('  Per-resource:', JSON.stringify(pressure2.perResource));
  console.log('  Overflow risk:', JSON.stringify(pressure2.overflowRisk));
  console.log('  First overflow:', pressure2.firstOverflowMs != null
    ? Math.round(pressure2.firstOverflowMs / 60000) + ' min'
    : 'none');

  // Scenario 3: Pressure-driven re-ranking
  console.log('');
  console.log('=== Resource Intelligence: Pressure Re-ranking ===');
  var villageState = {
    resourceFields: gameState.resourceFields || [],
    buildings: gameState.buildings || [],
    resources: highFillState.resources,
    production: gameState.production,
    storage: { warehouse: 7, granary: 7 },
  };
  var ranked = engine.buildOptimizer.rankUpgrades(villageState, engine.currentPhase, 10);
  console.log('Before policy (ROI order):');
  ranked.slice(0, 5).forEach(function(c, i) {
    console.log('  #' + (i + 1) + ' ' + c.buildingKey + ' slot ' + c.slot +
      ' (score: ' + c.score + ', affordable: ' + c.affordable + ')');
  });

  var reranked = intel.policy(pressure2, ranked);
  console.log('');
  console.log('After policy (pressure-adjusted, pressure=' + pressure2.overall + '):');
  reranked.slice(0, 5).forEach(function(c, i) {
    console.log('  #' + (i + 1) + ' ' + c.buildingKey + ' slot ' + c.slot +
      ' (adjusted: ' + (c._adjustedScore || c.score) + ', affordable: ' + c.affordable + ')');
  });

  // Scenario 4: Full evaluate() with high pressure
  console.log('');
  console.log('=== Resource Intelligence: Full Cycle with High Pressure ===');
  var tasks2 = engine.evaluate(highFillState, config, taskQueue);
  console.log('Tasks generated under pressure:', tasks2.length);
  tasks2.forEach(function(t) {
    console.log('  [' + t.type + '] priority=' + t.priority +
      ' params=' + JSON.stringify(t.params));
  });
} else {
  console.log('ResourceIntel NOT integrated — skipping pressure tests');
}

console.log('');
console.log('=== Integration Test Complete ===');
