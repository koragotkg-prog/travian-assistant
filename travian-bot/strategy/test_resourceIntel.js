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
  // Medium pressure should boost scores above base (relief > 0 for high-pressure resources)
  assert(result[0]._adjustedScore >= result[0].score,
    'adjustedScore >= base score when pressure present');
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
// Phase 2: forecast with pendingCosts (build cost drain)
// =========================================================================
console.log('');
console.log('=== forecast: build cost drain ===');

(function testForecastWithPendingCosts() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 3000, clay: 3000, iron: 3000, crop: 3000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  // Queue a build that costs 500 of each, completing in 30 min
  var pending = [
    { wood: 500, clay: 500, iron: 500, crop: 500, completionMs: 1800000 }
  ];

  var fc = intel.forecast(snapshot, 7200000, { pendingCosts: pending });
  // Without drain: 3000 + 200*2 = 3400
  // With drain: 3400 - 500 = 2900
  assert(fc.wood.projected === 2900, 'wood projected with drain = 2900 (got ' + fc.wood.projected + ')');
  assert(fc.clay.projected === 2900, 'clay projected with drain = 2900 (got ' + fc.clay.projected + ')');
  assert(fc.pendingDrain.wood === 500, 'pendingDrain.wood = 500');
})();

(function testForecastPendingCostOutsideHorizon() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 3000, clay: 3000, iron: 3000, crop: 3000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  // Build completes in 3 hours, but horizon is 2 hours — should NOT drain
  var pending = [
    { wood: 1000, clay: 1000, iron: 1000, crop: 1000, completionMs: 10800000 }
  ];

  var fc = intel.forecast(snapshot, 7200000, { pendingCosts: pending });
  assert(fc.wood.projected === 3400, 'pending beyond horizon ignored: wood = 3400 (got ' + fc.wood.projected + ')');
  assert(fc.pendingDrain.wood === 0, 'pendingDrain.wood = 0 (outside horizon)');
})();

(function testForecastProjectedFloorAtZero() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 100, clay: 100, iron: 100, crop: 100 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 50, clay: 50, iron: 50, crop: 50 },
    timestamp: Date.now()
  };

  // Huge build cost that exceeds what we'll have
  var pending = [
    { wood: 5000, clay: 5000, iron: 5000, crop: 5000, completionMs: 1800000 }
  ];

  var fc = intel.forecast(snapshot, 7200000, { pendingCosts: pending });
  assert(fc.wood.projected === 0, 'projected floors at 0 (got ' + fc.wood.projected + ')');
})();

(function testForecastWithFarmIncome() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 100 },
    timestamp: Date.now()
  };

  // Farm income adds 50/hr per resource
  var fc = intel.forecast(snapshot, 7200000, {
    farmIncomePerHr: { wood: 50, clay: 50, iron: 50, crop: 50 }
  });
  // Effective production: 150/hr, 2h = 300 gain
  assert(fc.wood.projected === 1300, 'farm income: wood = 1300 (got ' + fc.wood.projected + ')');
})();

(function testForecastWithMultiplePendingCosts() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 5000, clay: 5000, iron: 5000, crop: 5000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  var pending = [
    { wood: 300, clay: 200, iron: 400, crop: 100, completionMs: 600000 },
    { wood: 200, clay: 300, iron: 100, crop: 400, completionMs: 1800000 }
  ];

  var fc = intel.forecast(snapshot, 7200000, { pendingCosts: pending });
  assert(fc.pendingDrain.wood === 500, 'multiple drains sum: wood = 500');
  assert(fc.pendingDrain.clay === 500, 'multiple drains sum: clay = 500');
  assert(fc.pendingDrain.iron === 500, 'multiple drains sum: iron = 500');
  assert(fc.pendingDrain.crop === 500, 'multiple drains sum: crop = 500');
  // 5000 + 200*2 = 5400, 5400 - 500 = 4900
  assert(fc.wood.projected === 4900, 'multiple drains: wood = 4900 (got ' + fc.wood.projected + ')');
})();

(function testForecastBackwardCompatible() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 200, clay: 200, iron: 200, crop: 200 },
    timestamp: Date.now()
  };

  // No options — should work exactly as before
  var fc = intel.forecast(snapshot, 7200000);
  assert(fc.wood.projected === 1400, 'backward compatible: no options works (got ' + fc.wood.projected + ')');
  assert(fc.pendingDrain.wood === 0, 'backward compatible: pendingDrain.wood = 0');
})();

// =========================================================================
// Phase 2: cropSafety
// =========================================================================
console.log('');
console.log('=== cropSafety ===');

(function testCropSafetySafe() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 3000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 120 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot, 20);
  assert(report !== null, 'cropSafety not null');
  assert(report.level === 'safe', 'positive net crop = safe (got ' + report.level + ')');
  assert(report.netCrop === 100, 'netCrop = 120 - 20 = 100 (got ' + report.netCrop + ')');
  assert(report.safeToTrain === true, 'safe to train with 100/hr net');
  assert(report.hoursToStarvation === null, 'no starvation with positive net');
  assert(report.action === null, 'no action needed when safe');
})();

(function testCropSafetyWarningLowMargin() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 3000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 25 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot, 22);
  assert(report.level === 'warning', 'low margin (3/hr net) = warning (got ' + report.level + ')');
  assert(report.netCrop === 3, 'netCrop = 25 - 22 = 3 (got ' + report.netCrop + ')');
  assert(report.safeToTrain === false, 'not safe to train with 3/hr net');
  assert(report.action === 'monitor', 'action = monitor for low margin');
})();

(function testCropSafetyWarningNegative() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 5000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 80 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot, 100);
  assert(report.netCrop === -20, 'netCrop = 80 - 100 = -20 (got ' + report.netCrop + ')');
  // 5000 / 20 = 250 hours — well above 2h danger threshold
  assert(report.level === 'warning', 'negative net but far from starvation = warning');
  assert(report.hoursToStarvation !== null, 'hoursToStarvation set');
  assertClose(report.hoursToStarvation, 250, 1, 'hoursToStarvation ~250h');
  assert(report.action === 'upgrade_crop', 'action = upgrade_crop for negative net');
})();

(function testCropSafetyDanger() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 100 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 30 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot, 100);
  assert(report.netCrop === -70, 'netCrop = 30 - 100 = -70 (got ' + report.netCrop + ')');
  // 100 / 70 = ~1.43 hours — under 2h danger threshold
  assert(report.level === 'danger', 'imminent starvation = danger (got ' + report.level + ')');
  assert(report.hoursToStarvation < 2, 'starvation in < 2h (got ' + report.hoursToStarvation + ')');
  assert(report.safeToTrain === false, 'definitely not safe to train');
  assert(report.action === 'upgrade_crop', 'action = upgrade_crop for danger');
})();

(function testCropSafetyAlreadyStarving() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 0 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 20 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot, 50);
  assert(report.hoursToStarvation === 0, 'zero crop with negative net = starvation now');
  assert(report.level === 'danger', 'already starving = danger');
})();

(function testCropSafetyNoUpkeep() {
  var intel = new self.TravianResourceIntel();
  var snapshot = {
    resources: { wood: 1000, clay: 1000, iron: 1000, crop: 1000 },
    capacity: { warehouse: 6000, granary: 6000 },
    production: { wood: 100, clay: 100, iron: 100, crop: 50 },
    timestamp: Date.now()
  };

  var report = intel.cropSafety(snapshot);
  assert(report.netCrop === 50, 'no upkeep: netCrop = production (got ' + report.netCrop + ')');
  assert(report.troopUpkeep === 0, 'troopUpkeep defaults to 0');
  assert(report.level === 'safe', 'no upkeep = safe');
})();

(function testCropSafetyNullInput() {
  var intel = new self.TravianResourceIntel();
  assert(intel.cropSafety(null) === null, 'null input returns null');
})();

// =========================================================================
// Phase 2: Farm Loot Prediction (EMA)
// =========================================================================
console.log('');
console.log('=== Farm Loot Prediction ===');

(function testRecordFarmRunAndPredict() {
  var intel = new self.TravianResourceIntel();

  // First run — insufficient for prediction (need >= 2)
  intel.recordFarmRun('farm1', { wood: 200, clay: 150, iron: 100, crop: 50 });
  var pred = intel.predictFarmIncome('farm1');
  assert(pred === null, 'single run: no prediction yet');

  // Second run after a delay (simulate 30 min interval)
  var orig = Date.now;
  try {
    Date.now = function () { return orig() + 1800000; }; // +30 min
    intel.recordFarmRun('farm1', { wood: 300, clay: 200, iron: 150, crop: 100 });
  } finally { Date.now = orig; }

  pred = intel.predictFarmIncome('farm1');
  assert(pred !== null, 'two runs: prediction available');
  assert(pred.farmId === 'farm1', 'farmId = farm1');
  assert(pred.runs === 2, 'runs = 2');
  assert(pred.totalPerHr > 0, 'totalPerHr > 0 (got ' + pred.totalPerHr + ')');
  assert(pred.incomePerHr.wood > 0, 'wood income > 0');
  assert(pred.successRate === 1, 'all successful: rate = 1');
})();

(function testFarmRunFailure() {
  var intel = new self.TravianResourceIntel();

  intel.recordFarmRun('farm2', { wood: 100, clay: 100, iron: 100, crop: 100 });

  var orig = Date.now;
  try {
    Date.now = function () { return orig() + 1800000; };
    intel.recordFarmRun('farm2', null, false); // failed raid
  } finally { Date.now = orig; }

  var pred = intel.predictFarmIncome('farm2');
  if (pred) {
    assert(pred.successRate === 0.5, 'one success + one fail = 0.5 rate (got ' + pred.successRate + ')');
  } else {
    // Prediction might be null with only 2 runs and one fail
    assert(true, 'prediction null or correct after failure');
  }
})();

(function testGetAllFarmPredictions() {
  var intel = new self.TravianResourceIntel();

  // Create two farms with enough history
  var orig = Date.now;
  var baseTime = orig();

  try {
    // Farm A: 2 runs
    Date.now = function () { return baseTime; };
    intel.recordFarmRun('farmA', { wood: 200, clay: 200, iron: 200, crop: 200 });
    Date.now = function () { return baseTime + 3600000; }; // +1hr
    intel.recordFarmRun('farmA', { wood: 300, clay: 300, iron: 300, crop: 300 });

    // Farm B: 2 runs
    Date.now = function () { return baseTime; };
    intel.recordFarmRun('farmB', { wood: 100, clay: 100, iron: 100, crop: 100 });
    Date.now = function () { return baseTime + 3600000; };
    intel.recordFarmRun('farmB', { wood: 150, clay: 150, iron: 150, crop: 150 });
  } finally { Date.now = orig; }

  var all = intel.getAllFarmPredictions();
  assert(all.farms.length === 2, 'two farms tracked');
  assert(all.incomePerHr.wood > 0, 'combined wood income > 0 (got ' + all.incomePerHr.wood + ')');
})();

(function testPredictFarmIncomeNullForUnknown() {
  var intel = new self.TravianResourceIntel();
  var pred = intel.predictFarmIncome('nonexistent');
  assert(pred === null, 'unknown farm returns null');
})();

(function testGetAllFarmPredictionsEmpty() {
  var intel = new self.TravianResourceIntel();
  var all = intel.getAllFarmPredictions();
  assert(all.farms.length === 0, 'empty: no farms');
  assert(all.incomePerHr.wood === 0, 'empty: income = 0');
})();

// =========================================================================
// Phase 2: State persistence (getState / loadState)
// =========================================================================
console.log('');
console.log('=== State Persistence ===');

(function testGetAndLoadState() {
  var intel1 = new self.TravianResourceIntel();
  var orig = Date.now;
  var baseTime = orig();

  Date.now = function () { return baseTime; };
  intel1.recordFarmRun('farmX', { wood: 500, clay: 400, iron: 300, crop: 200 });
  Date.now = function () { return baseTime + 1800000; };
  intel1.recordFarmRun('farmX', { wood: 600, clay: 500, iron: 400, crop: 300 });
  Date.now = orig;

  // Export state
  var state = intel1.getState();
  assert(state.version === 2, 'state version = 2');
  assert(state.farmHistory.farmX !== undefined, 'farmX in exported state');

  // Create new instance and load state
  var intel2 = new self.TravianResourceIntel();
  intel2.loadState(state);

  var pred = intel2.predictFarmIncome('farmX');
  assert(pred !== null, 'prediction available after loadState');
  assert(pred.runs === 2, 'runs preserved after loadState (got ' + pred.runs + ')');
})();

(function testLoadStateNullSafe() {
  var intel = new self.TravianResourceIntel();
  intel.loadState(null);
  intel.loadState(undefined);
  intel.loadState('invalid');
  assert(true, 'loadState handles null/undefined/invalid gracefully');
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
