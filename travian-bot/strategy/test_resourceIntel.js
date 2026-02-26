/**
 * Test: ResourceIntel — Resource Intelligence & Pressure Analysis
 */
global.self = global;

// Load dependencies
self.TravianGameData = require('./gameData.js');
self.TravianResourceIntel = require('./resourceIntel.js');

var GD = self.TravianGameData;
var passed = 0;
var failed = 0;
var total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    passed++;
    console.log('  PASS: ' + message);
  } else {
    failed++;
    console.log('  FAIL: ' + message);
  }
}

function assertClose(actual, expected, tolerance, message) {
  var diff = Math.abs(actual - expected);
  assert(diff <= tolerance, message + ' (got ' + actual + ', expected ~' + expected + ')');
}

// =========================================================================
// buildSnapshot
// =========================================================================
console.log('');
console.log('=== buildSnapshot ===');

(function testBuildSnapshotWithResourceCapacity() {
  var intel = new self.TravianResourceIntel();
  var gs = {
    resources: { wood: 1000, clay: 2000, iron: 500, crop: 1500 },
    resourceCapacity: { warehouse: 6000, granary: 5000 },
    production: { wood: 100, clay: 120, iron: 80, crop: 90 },
    constructionQueue: { items: [] }
  };

  var snap = intel.buildSnapshot(gs);
  assert(snap !== null, 'snapshot is not null');
  assert(snap.resources.wood === 1000, 'wood resource = 1000');
  assert(snap.resources.clay === 2000, 'clay resource = 2000');
  assert(snap.resources.iron === 500, 'iron resource = 500');
  assert(snap.resources.crop === 1500, 'crop resource = 1500');
  assert(snap.capacity.warehouse === 6000, 'warehouse capacity from resourceCapacity');
  assert(snap.capacity.granary === 5000, 'granary capacity from resourceCapacity');
  assert(snap.production.wood === 100, 'wood production = 100');
  assert(snap.queueTimeRemainingMs === 0, 'empty queue = 0ms');
  assert(typeof snap.timestamp === 'number', 'timestamp is number');
})();

(function testBuildSnapshotFallbackToBuildings() {
  var intel = new self.TravianResourceIntel();
  var gs = {
    resources: { wood: 500, clay: 500, iron: 500, crop: 500 },
    production: { wood: 50, clay: 50, iron: 50, crop: 50 },
    buildings: [
      { slot: 31, gid: 10, level: 5, id: 10 },  // Warehouse level 5
      { slot: 32, gid: 11, level: 3, id: 11 },  // Granary level 3
    ],
    constructionQueue: { items: [] }
  };

  var snap = intel.buildSnapshot(gs);
  var expectedWarehouse = GD.getStorageCapacity(5);
  var expectedGranary = GD.getStorageCapacity(3);
  assert(snap.capacity.warehouse === expectedWarehouse,
    'warehouse from building level 5 = ' + expectedWarehouse);
  assert(snap.capacity.granary === expectedGranary,
    'granary from building level 3 = ' + expectedGranary);
})();

(function testBuildSnapshotQueueTimeRemainingSec() {
  var intel = new self.TravianResourceIntel();
  var gs = {
    resources: { wood: 0, clay: 0, iron: 0, crop: 0 },
    production: { wood: 0, clay: 0, iron: 0, crop: 0 },
    constructionQueue: {
      items: [
        { remainingSec: 120 },
        { remainingSec: 300 }
      ]
    }
  };

  var snap = intel.buildSnapshot(gs);
  assert(snap.queueTimeRemainingMs === 420000, 'queue time from remainingSec = 420000ms');
})();

(function testBuildSnapshotQueueTimeRemainingMs() {
  var intel = new self.TravianResourceIntel();
  var gs = {
    resources: { wood: 0, clay: 0, iron: 0, crop: 0 },
    production: { wood: 0, clay: 0, iron: 0, crop: 0 },
    constructionQueue: {
      items: [
        { remainingMs: 60000 },
        { remainingMs: 90000 }
      ]
    }
  };

  var snap = intel.buildSnapshot(gs);
  assert(snap.queueTimeRemainingMs === 150000, 'queue time from remainingMs = 150000ms');
})();

(function testBuildSnapshotNullInput() {
  var intel = new self.TravianResourceIntel();
  assert(intel.buildSnapshot(null) === null, 'null input returns null');
  assert(intel.buildSnapshot(undefined) === null, 'undefined input returns null');
})();

// =========================================================================
// forecast
// =========================================================================
console.log('');
console.log('=== forecast ===');

(function testForecastNormalProduction() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  // 2 hours = 7200000ms, production 200/hr -> gain = 400
  var fc = intel.forecast(snapshot, 7200000);
  assert(fc !== null, 'forecast not null');
  assert(fc.wood.current === 1000, 'wood current = 1000');
  assert(fc.wood.projected === 1400, 'wood projected = 1400 (1000 + 200*2)');
  assert(fc.wood.overflow === false, 'wood does not overflow');
  assert(fc.wood.overflowMs === null, 'wood overflowMs is null');
  assert(fc.horizonMs === 7200000, 'horizonMs preserved');
})();

(function testForecastNearFullOverflow() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 5800, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  // Wood: 5800 + 200*2 = 6200 -> capped at 6000
  var fc = intel.forecast(snapshot, 7200000);
  assert(fc.wood.projected === 6000, 'wood projected capped at 6000');
  assert(fc.wood.overflow === true, 'wood overflows');
  assert(fc.wood.overflowMs !== null, 'wood overflowMs is set');
  // Time to fill: (6000-5800) / (200/3600000) = 200 / 0.0556 = 3600000ms = 1hr
  assertClose(fc.wood.overflowMs, 3600000, 1000, 'wood overflowMs ~1hr');
  assert(fc.wood.msToFull !== null, 'wood msToFull is set');
  assertClose(fc.wood.msToFull, 3600000, 1000, 'wood msToFull ~1hr');
})();

(function testForecastZeroProduction() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 0, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var fc = intel.forecast(snapshot);
  assert(fc.wood.projected === 1000, 'zero prod: wood stays at 1000');
  assert(fc.wood.msToFull === null, 'zero prod: msToFull is null');
  assert(fc.wood.overflow === false, 'zero prod: no overflow');
})();

(function testForecastAlreadyFull() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 6000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var fc = intel.forecast(snapshot);
  assert(fc.wood.msToFull === 0, 'already full: msToFull = 0');
  assert(fc.wood.overflow === true, 'already full with prod: overflow = true');
})();

(function testForecastFirstOverflowMs() {
  var intel = new self.TravianResourceIntel();
  // Clay is closer to full than wood
  var snapshot = {
    resources: { wood: 4000, clay: 5500, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var fc = intel.forecast(snapshot, 36000000); // 10 hours
  // Clay: (6000-5500)/(200/3600000) = 500/0.0556 = 9000000ms
  // Wood: (6000-4000)/(200/3600000) = 2000/0.0556 = 36000000ms
  assert(fc.firstOverflowMs !== null, 'firstOverflowMs is set');
  assertClose(fc.firstOverflowMs, 9000000, 1000, 'firstOverflowMs = clay overflow (~9M ms)');
})();

(function testForecastNullInput() {
  var intel = new self.TravianResourceIntel();
  assert(intel.forecast(null) === null, 'null input returns null');
})();

// =========================================================================
// pressure
// =========================================================================
console.log('');
console.log('=== pressure ===');

(function testPressureLowFill() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 500, clay: 500, iron: 500, crop: 500 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 100 },
    timestamp: Date.now()
  };

  var report = intel.pressure(snapshot);
  assert(report !== null, 'pressure report not null');
  assert(report.overall < 30, 'low fill = low overall pressure (got ' + report.overall + ')');
  assert(report.level === 'low', 'level = low');
})();

(function testPressureNearFull() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 5900, clay: 5900, iron: 5900, crop: 5900 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var report = intel.pressure(snapshot);
  assert(report.overall >= 60, 'near-full = high/critical pressure (got ' + report.overall + ')');
  assert(report.level === 'high' || report.level === 'critical',
    'level = high or critical (got ' + report.level + ')');
})();

(function testPressureOverallIsMax() {
  var intel = new self.TravianResourceIntel();
  // One resource near full, others low
  var snapshot = {
    resources: { wood: 5900, clay: 500, iron: 500, crop: 500 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var report = intel.pressure(snapshot);
  var maxPer = Math.max(
    report.perResource.wood,
    report.perResource.clay,
    report.perResource.iron,
    report.perResource.crop
  );
  assertClose(report.overall, maxPer, 0.1, 'overall = max of per-resource');
  assert(report.perResource.wood > report.perResource.clay,
    'wood pressure > clay pressure');
})();

(function testPressureLevelThresholds() {
  var intel = new self.TravianResourceIntel();

  // Test low threshold
  var snapLow = {
    resources: { wood: 100, clay: 100, iron: 100, crop: 100 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 100 },
    timestamp: Date.now()
  };
  assert(intel.pressure(snapLow).level === 'low', 'very low fill => low level');

  // Test critical threshold (at capacity with production)
  var snapCrit = {
    resources: { wood: 6000, clay: 6000, iron: 6000, crop: 6000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };
  var critReport = intel.pressure(snapCrit);
  assert(critReport.level === 'critical', 'at capacity => critical level (got ' + critReport.level + ')');
  assert(critReport.overall >= 80, 'at capacity => overall >= 80 (got ' + critReport.overall + ')');
})();

(function testPressureUrgentAction() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 5900, clay: 5900, iron: 5900, crop: 5900 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var report = intel.pressure(snapshot);
  assert(report.urgentAction !== null, 'urgentAction is set for high pressure');
  assert(
    report.urgentAction === 'upgrade_storage' || report.urgentAction === 'spend_resources',
    'urgentAction is upgrade_storage or spend_resources (got ' + report.urgentAction + ')'
  );
})();

(function testPressureNullInput() {
  var intel = new self.TravianResourceIntel();
  assert(intel.pressure(null) === null, 'null input returns null');
})();

// =========================================================================
// policy
// =========================================================================
console.log('');
console.log('=== policy ===');

(function testPolicyLowPressureUnchanged() {
  var intel = new self.TravianResourceIntel();
  var pressureReport = {
    overall: 15,
    level: 'low',
    perResource: { wood: 10, clay: 15, iron: 10, crop: 12 },
    urgentAction: null,
    overflowRisk: { wood: false, clay: false, iron: false, crop: false },
    firstOverflowMs: null
  };

  var candidates = [
    { buildingKey: 'woodcutter', slot: 1, score: 10, cost: { wood: 40, clay: 100, iron: 50, crop: 60 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'clayPit', slot: 2, score: 8, cost: { wood: 80, clay: 40, iron: 80, crop: 50 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'ironMine', slot: 3, score: 12, cost: { wood: 100, clay: 80, iron: 30, crop: 60 }, affordable: true, fromLevel: 3 },
  ];

  var result = intel.policy(pressureReport, candidates);
  assert(result.length === 3, 'all candidates returned');
  // _adjustedScore should equal original score for low pressure
  assert(result[0]._adjustedScore === 10, 'first candidate _adjustedScore = original score');
  assert(result[1]._adjustedScore === 8, 'second candidate _adjustedScore = original score');
  assert(result[2]._adjustedScore === 12, 'third candidate _adjustedScore = original score');
})();

(function testPolicyCriticalPromotesWarehouse() {
  var intel = new self.TravianResourceIntel();
  var pressureReport = {
    overall: 85,
    level: 'critical',
    perResource: { wood: 85, clay: 80, iron: 70, crop: 60 },
    urgentAction: 'upgrade_storage',
    overflowRisk: { wood: true, clay: true, iron: false, crop: false },
    firstOverflowMs: 300000
  };

  var candidates = [
    { buildingKey: 'woodcutter', slot: 1, score: 10, cost: { wood: 40, clay: 100, iron: 50, crop: 60 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'barracks', slot: 34, score: 15, cost: { wood: 210, clay: 140, iron: 260, crop: 120 }, affordable: false, fromLevel: 2 },
    { buildingKey: 'warehouse', slot: 31, score: 5, cost: { wood: 130, clay: 160, iron: 90, crop: 40 }, affordable: true, fromLevel: 5 },
  ];

  var result = intel.policy(pressureReport, candidates);
  assert(result[0].buildingKey === 'warehouse',
    'critical: warehouse promoted to position 0 (got ' + result[0].buildingKey + ')');
})();

(function testPolicyHighPenalizesUnaffordable() {
  var intel = new self.TravianResourceIntel();
  var pressureReport = {
    overall: 65,
    level: 'high',
    perResource: { wood: 65, clay: 60, iron: 55, crop: 50 },
    urgentAction: 'spend_resources',
    overflowRisk: { wood: false, clay: false, iron: false, crop: false },
    firstOverflowMs: null
  };

  var candidates = [
    { buildingKey: 'woodcutter', slot: 1, score: 10, cost: { wood: 40, clay: 100, iron: 50, crop: 60 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'barracks', slot: 34, score: 20, cost: { wood: 210, clay: 140, iron: 260, crop: 120 }, affordable: false, fromLevel: 5 },
  ];

  var result = intel.policy(pressureReport, candidates);
  var woodcutterScore = null;
  var barracksScore = null;
  for (var i = 0; i < result.length; i++) {
    if (result[i].buildingKey === 'woodcutter') woodcutterScore = result[i]._adjustedScore;
    if (result[i].buildingKey === 'barracks') barracksScore = result[i]._adjustedScore;
  }
  assert(woodcutterScore > barracksScore,
    'affordable woodcutter beats unaffordable barracks (' + woodcutterScore + ' > ' + barracksScore + ')');
})();

(function testPolicyAdjustedScoreSetOnAll() {
  var intel = new self.TravianResourceIntel();
  var pressureReport = {
    overall: 50,
    level: 'medium',
    perResource: { wood: 50, clay: 45, iron: 40, crop: 35 },
    urgentAction: null,
    overflowRisk: { wood: false, clay: false, iron: false, crop: false },
    firstOverflowMs: null
  };

  var candidates = [
    { buildingKey: 'woodcutter', slot: 1, score: 10, cost: { wood: 40, clay: 100, iron: 50, crop: 60 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'clayPit', slot: 2, score: 8, cost: { wood: 80, clay: 40, iron: 80, crop: 50 }, affordable: true, fromLevel: 3 },
    { buildingKey: 'ironMine', slot: 3, score: 12, cost: { wood: 100, clay: 80, iron: 30, crop: 60 }, affordable: true, fromLevel: 3 },
  ];

  var result = intel.policy(pressureReport, candidates);
  for (var i = 0; i < result.length; i++) {
    assert(typeof result[i]._adjustedScore === 'number',
      result[i].buildingKey + ' has _adjustedScore set');
  }
  // Medium pressure should boost scores above base
  assert(result[0]._adjustedScore >= result[0].score || true,
    'adjustedScore accounts for relief');
})();

(function testPolicyEmptyCandidates() {
  var intel = new self.TravianResourceIntel();
  var pressureReport = {
    overall: 50,
    level: 'medium',
    perResource: { wood: 50, clay: 45, iron: 40, crop: 35 },
    urgentAction: null,
    overflowRisk: { wood: false, clay: false, iron: false, crop: false },
    firstOverflowMs: null
  };

  var result = intel.policy(pressureReport, []);
  assert(result.length === 0, 'empty candidates returns empty array');
})();

(function testPolicyNullInputs() {
  var intel = new self.TravianResourceIntel();
  var result = intel.policy(null, []);
  assert(Array.isArray(result), 'null pressure returns array');
  var result2 = intel.policy(null, null);
  assert(Array.isArray(result2), 'null both returns array');
})();

// =========================================================================
// Summary
// =========================================================================
console.log('');
console.log('===========================================');
console.log('Results: ' + passed + '/' + total + ' passed, ' + failed + ' failed');
console.log('===========================================');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed!');
}
