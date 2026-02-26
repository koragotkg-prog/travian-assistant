# Resource Intelligence System — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a resource forecast engine with pressure model to prevent overflow and optimize spending decisions.

**Architecture:** New `strategy/resourceIntel.js` module (IIFE, multi-context export) consumed by DecisionEngine. Three public methods: `forecast()`, `pressure()`, `policy()`. Pure functions, no side effects. Follows exact same pattern as existing strategy modules.

**Tech Stack:** Plain JavaScript (no ES modules, no npm). IIFE pattern with `self/window/module.exports` export. Test via Node.js `require()` like `test_integration.js`.

---

## Task 1: Create ResourceIntel Module — Forecast Engine

**Files:**
- Create: `strategy/resourceIntel.js`

**Step 1: Create the module scaffold with forecast()**

The forecast engine is deterministic: `projected = min(capacity, current + production/hr * T)`.

```js
/**
 * resourceIntel.js — Resource Intelligence System
 *
 * Provides deterministic resource forecasting, pressure scoring,
 * and action policy for preventing overflow and optimizing spending.
 *
 * Compatible with: Service Worker (self), Browser (window), Node.js (module.exports)
 * Depends on: TravianGameData (gameData.js)
 */
(function () {
  'use strict';

  // Resolve dependency
  var GD = (typeof self !== 'undefined' && self.TravianGameData) ||
           (typeof window !== 'undefined' && window.TravianGameData) ||
           (typeof global !== 'undefined' && global.TravianGameData) ||
           (typeof require === 'function' ? require('./gameData') : null);

  var RESOURCE_TYPES = ['wood', 'clay', 'iron', 'crop'];

  // =========================================================================
  // ResourceIntel
  // =========================================================================
  function ResourceIntel() {
    this.GD = GD;
  }

  // -------------------------------------------------------------------------
  // Snapshot Builder
  // -------------------------------------------------------------------------

  /**
   * Build a ResourceSnapshot from raw gameState.
   * Normalizes the different shapes (resourceCapacity vs storage levels).
   *
   * @param {object} gameState - From domScanner.getFullState()
   * @returns {object} Normalized snapshot
   */
  ResourceIntel.prototype.buildSnapshot = function (gameState) {
    if (!gameState) return null;

    var res = gameState.resources || { wood: 0, clay: 0, iron: 0, crop: 0 };
    var prod = gameState.resourceProduction || gameState.production || { wood: 0, clay: 0, iron: 0, crop: 0 };

    // Resolve capacity: prefer direct resourceCapacity, fall back to storage levels
    var whCap = 0, grCap = 0;
    if (gameState.resourceCapacity) {
      whCap = gameState.resourceCapacity.warehouse || 0;
      grCap = gameState.resourceCapacity.granary || 0;
    }
    if (whCap === 0 && this.GD) {
      // Fall back to storage building levels
      var whLevel = 1, grLevel = 1;
      if (gameState.buildings) {
        for (var i = 0; i < gameState.buildings.length; i++) {
          var b = gameState.buildings[i];
          var gid = b.gid || b.id;
          if (gid === 10 && (b.level || 0) > whLevel) whLevel = b.level;
          if (gid === 11 && (b.level || 0) > grLevel) grLevel = b.level;
        }
      }
      if (gameState.storage) {
        if (gameState.storage.warehouse) whLevel = gameState.storage.warehouse;
        if (gameState.storage.granary) grLevel = gameState.storage.granary;
      }
      whCap = this.GD.getStorageCapacity(whLevel);
      grCap = this.GD.getStorageCapacity(grLevel);
    }
    // Final fallback
    if (whCap === 0) whCap = 800;
    if (grCap === 0) grCap = 800;

    // Queue time remaining
    var queueTimeMs = 0;
    if (gameState.constructionQueue && gameState.constructionQueue.items) {
      var items = gameState.constructionQueue.items;
      for (var j = 0; j < items.length; j++) {
        if (items[j].remainingMs) queueTimeMs += items[j].remainingMs;
        else if (items[j].remainingSec) queueTimeMs += items[j].remainingSec * 1000;
      }
    }

    return {
      resources: { wood: res.wood || 0, clay: res.clay || 0, iron: res.iron || 0, crop: res.crop || 0 },
      capacity: { warehouse: whCap, granary: grCap },
      production: { wood: prod.wood || 0, clay: prod.clay || 0, iron: prod.iron || 0, crop: prod.crop || 0 },
      queueTimeRemainingMs: queueTimeMs,
      timestamp: Date.now()
    };
  };

  // -------------------------------------------------------------------------
  // Forecast Engine
  // -------------------------------------------------------------------------

  /**
   * Predict resource levels at a future time.
   * Deterministic linear projection capped at storage capacity.
   *
   * @param {object} snapshot - From buildSnapshot()
   * @param {number} [horizonMs=7200000] - How far ahead to predict (default 2h)
   * @returns {object} Forecast with per-resource projections
   */
  ResourceIntel.prototype.forecast = function (snapshot, horizonMs) {
    if (!snapshot) return null;
    horizonMs = horizonMs || 7200000; // 2 hours default

    var result = { horizonMs: horizonMs, firstOverflowMs: null };

    for (var i = 0; i < RESOURCE_TYPES.length; i++) {
      var r = RESOURCE_TYPES[i];
      var current = snapshot.resources[r] || 0;
      var prodPerHour = snapshot.production[r] || 0;
      var cap = (r === 'crop') ? snapshot.capacity.granary : snapshot.capacity.warehouse;

      // Production per millisecond
      var prodPerMs = prodPerHour / 3600000;

      // Project at horizon
      var projected = current + prodPerMs * horizonMs;
      var overflow = projected >= cap;
      projected = Math.min(projected, cap);

      // Time to overflow
      var msToFull = null;
      if (prodPerHour > 0 && current < cap) {
        msToFull = (cap - current) / prodPerMs;
      } else if (current >= cap) {
        msToFull = 0; // Already full
      }
      // else: production <= 0, will never fill

      // Track earliest overflow
      if (msToFull !== null && msToFull <= horizonMs) {
        if (result.firstOverflowMs === null || msToFull < result.firstOverflowMs) {
          result.firstOverflowMs = Math.round(msToFull);
        }
      }

      result[r] = {
        current: current,
        projected: Math.round(projected),
        overflow: overflow,
        overflowMs: (msToFull !== null && msToFull <= horizonMs) ? Math.round(msToFull) : null,
        msToFull: msToFull !== null ? Math.round(msToFull) : null
      };
    }

    return result;
  };

  // -------------------------------------------------------------------------
  // Pressure Model
  // -------------------------------------------------------------------------

  /**
   * Calculate resource pressure (0-100) indicating urgency to spend.
   *
   * Formula per resource:
   *   pressure = 40 * fillRatio + 40 * overflowUrgency + 20 * imbalancePenalty
   *
   * Overall = max of per-resource pressures
   *
   * @param {object} snapshot - From buildSnapshot()
   * @returns {object} PressureReport
   */
  ResourceIntel.prototype.pressure = function (snapshot) {
    if (!snapshot) return null;

    var forecast = this.forecast(snapshot);
    if (!forecast) return null;

    var totalProd = 0;
    for (var k = 0; k < RESOURCE_TYPES.length; k++) {
      totalProd += snapshot.production[RESOURCE_TYPES[k]] || 0;
    }

    var perResource = {};
    var overflowRisk = {};
    var maxPressure = 0;
    var OVERFLOW_WINDOW_MS = 4 * 3600000; // 4 hours

    for (var i = 0; i < RESOURCE_TYPES.length; i++) {
      var r = RESOURCE_TYPES[i];
      var current = snapshot.resources[r] || 0;
      var cap = (r === 'crop') ? snapshot.capacity.granary : snapshot.capacity.warehouse;
      var msToFull = forecast[r].msToFull;
      var prod = snapshot.production[r] || 0;

      // Component 1: Fill ratio (0-1)
      var fillRatio = cap > 0 ? Math.min(1, current / cap) : 0;

      // Component 2: Overflow urgency (0-1, 1 = overflowing now)
      var overflowUrgency = 0;
      if (msToFull !== null && msToFull < OVERFLOW_WINDOW_MS) {
        overflowUrgency = Math.max(0, 1 - msToFull / OVERFLOW_WINDOW_MS);
      } else if (msToFull === 0) {
        overflowUrgency = 1;
      }

      // Component 3: Imbalance penalty (0-1)
      var ratio = totalProd > 0 ? prod / totalProd : 0.25;
      var imbalancePenalty = Math.min(1, Math.abs(ratio - 0.25) / 0.25);

      // Weighted sum
      var p = Math.round(
        Math.min(100, Math.max(0,
          40 * fillRatio + 40 * overflowUrgency + 20 * imbalancePenalty
        ))
      );

      perResource[r] = p;
      overflowRisk[r] = forecast[r].overflow;
      if (p > maxPressure) maxPressure = p;
    }

    // Determine level
    var level = 'low';
    if (maxPressure >= 80) level = 'critical';
    else if (maxPressure >= 60) level = 'high';
    else if (maxPressure >= 30) level = 'medium';

    // Determine urgent action
    var urgentAction = null;
    if (maxPressure >= 80) {
      // Check if storage upgrade is needed
      var anyOverflow = overflowRisk.wood || overflowRisk.clay || overflowRisk.iron || overflowRisk.crop;
      urgentAction = anyOverflow ? 'upgrade_storage' : 'spend_resources';
    } else if (maxPressure >= 60) {
      urgentAction = 'spend_resources';
    }

    return {
      overall: maxPressure,
      perResource: perResource,
      urgentAction: urgentAction,
      overflowRisk: overflowRisk,
      firstOverflowMs: forecast.firstOverflowMs,
      level: level
    };
  };

  // -------------------------------------------------------------------------
  // Action Policy
  // -------------------------------------------------------------------------

  /**
   * Re-rank upgrade candidates based on resource pressure.
   * When pressure is low, candidates are returned unchanged.
   * When pressure is high, candidates that drain pressured resources are boosted.
   *
   * @param {object} pressureReport - From pressure()
   * @param {Array} candidates - From BuildOptimizer.rankUpgrades()
   * @param {object} [options] - { maxStorageLevel: 20 }
   * @returns {Array} Re-ranked candidates (mutated in place)
   */
  ResourceIntel.prototype.policy = function (pressureReport, candidates, options) {
    if (!pressureReport || !candidates || candidates.length === 0) {
      return candidates || [];
    }

    var overall = pressureReport.overall;
    if (overall < 30) return candidates; // Low pressure — ROI drives

    options = options || {};
    var maxStorageLevel = options.maxStorageLevel || 20;

    // Determine pressure multiplier by level
    var pressureMult = 0;
    if (overall >= 80) pressureMult = 1.0;
    else if (overall >= 60) pressureMult = 0.6;
    else pressureMult = 0.3;

    // Calculate relief score for each candidate
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c.cost) { c._adjustedScore = c.score || 0; continue; }

      var totalCost = (c.cost.wood || 0) + (c.cost.clay || 0) + (c.cost.iron || 0) + (c.cost.crop || 0);
      if (totalCost <= 0) { c._adjustedScore = c.score || 0; continue; }

      // Relief = how much this candidate drains high-pressure resources
      var relief = 0;
      for (var j = 0; j < RESOURCE_TYPES.length; j++) {
        var r = RESOURCE_TYPES[j];
        relief += (c.cost[r] || 0) * (pressureReport.perResource[r] || 0);
      }
      relief = relief / totalCost / 100; // normalize to 0-1 range

      c._adjustedScore = (c.score || 0) * (1 + relief * pressureMult);
    }

    // High/Critical: filter to affordable only
    if (overall >= 60) {
      // Don't actually remove — just heavily penalize unaffordable
      for (var k = 0; k < candidates.length; k++) {
        if (!candidates[k].affordable) {
          candidates[k]._adjustedScore *= 0.01;
        }
      }
    }

    // Sort by adjusted score
    candidates.sort(function (a, b) {
      return (b._adjustedScore || 0) - (a._adjustedScore || 0);
    });

    // Critical: if any storage upgrade candidate, boost to top
    if (overall >= 80) {
      for (var m = 0; m < candidates.length; m++) {
        var bk = candidates[m].buildingKey;
        if ((bk === 'warehouse' || bk === 'granary') &&
            candidates[m].affordable &&
            (candidates[m].fromLevel || 0) < maxStorageLevel) {
          // Move to position 0
          var storageCandidate = candidates.splice(m, 1)[0];
          storageCandidate._adjustedScore = 999;
          candidates.unshift(storageCandidate);
          break;
        }
      }
    }

    return candidates;
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = ResourceIntel;
  else if (typeof self !== 'undefined') self.TravianResourceIntel = ResourceIntel;
  else if (typeof window !== 'undefined') window.TravianResourceIntel = ResourceIntel;
})();
```

**Step 2: Verify syntax**

Run: `node -c strategy/resourceIntel.js`
Expected: No output (clean parse)

**Step 3: Commit**

```bash
git add strategy/resourceIntel.js
git commit -m "feat: add Resource Intelligence module (forecast, pressure, policy)"
```

---

## Task 2: Write Integration Test

**Files:**
- Create: `strategy/test_resourceIntel.js`

**Step 1: Write test that exercises all 3 methods**

```js
/**
 * Test: ResourceIntel forecast, pressure, and policy
 */
global.self = global;
global.chrome = { storage: { local: { get: function(){}, set: function(){} } } };

self.TravianGameData = require('./gameData.js');
self.TravianResourceIntel = require('./resourceIntel.js');

var intel = new self.TravianResourceIntel();
var passed = 0;
var failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.error('  ✗ FAIL: ' + label); }
}

// --- buildSnapshot ---
console.log('\n=== buildSnapshot ===');
var gameState = {
  resources: { wood: 5000, clay: 3200, iron: 4100, crop: 2800 },
  resourceCapacity: { warehouse: 8780, granary: 8780 },
  resourceProduction: { wood: 280, clay: 200, iron: 375, crop: 145 },
  constructionQueue: { count: 1, maxCount: 1, items: [{ remainingSec: 1800 }] },
  buildings: []
};

var snap = intel.buildSnapshot(gameState);
assert(snap !== null, 'snapshot created');
assert(snap.resources.wood === 5000, 'wood correct');
assert(snap.capacity.warehouse === 8780, 'warehouse cap from resourceCapacity');
assert(snap.queueTimeRemainingMs === 1800000, 'queue time parsed');

// --- forecast ---
console.log('\n=== forecast ===');
var fc = intel.forecast(snap, 7200000); // 2 hours
assert(fc !== null, 'forecast created');
assert(fc.wood.current === 5000, 'wood current');
assert(fc.wood.projected > 5000, 'wood projected > current');
assert(fc.wood.projected <= 8780, 'wood projected <= capacity');
assert(typeof fc.wood.msToFull === 'number', 'wood msToFull is number');
assert(fc.wood.msToFull > 0, 'wood msToFull > 0');

// Test overflow detection: nearly full resource
var nearFullSnap = {
  resources: { wood: 8700, clay: 100, iron: 100, crop: 100 },
  capacity: { warehouse: 8780, granary: 8780 },
  production: { wood: 280, clay: 200, iron: 375, crop: 145 },
  queueTimeRemainingMs: 0, timestamp: Date.now()
};
var fc2 = intel.forecast(nearFullSnap, 7200000);
assert(fc2.wood.overflow === true, 'near-full wood overflows at 2h');
assert(fc2.wood.overflowMs !== null, 'overflow time reported');
assert(fc2.wood.overflowMs < 3600000, 'overflow within 1 hour');

// Test zero production
var zeroProdSnap = {
  resources: { wood: 5000, clay: 5000, iron: 5000, crop: 5000 },
  capacity: { warehouse: 8780, granary: 8780 },
  production: { wood: 0, clay: 0, iron: 0, crop: 0 },
  queueTimeRemainingMs: 0, timestamp: Date.now()
};
var fc3 = intel.forecast(zeroProdSnap, 7200000);
assert(fc3.wood.projected === 5000, 'zero prod: projected unchanged');
assert(fc3.wood.msToFull === null, 'zero prod: msToFull is null');
assert(fc3.firstOverflowMs === null, 'zero prod: no overflow');

// --- pressure ---
console.log('\n=== pressure ===');
var pr = intel.pressure(snap);
assert(pr !== null, 'pressure report created');
assert(typeof pr.overall === 'number', 'overall is number');
assert(pr.overall >= 0 && pr.overall <= 100, 'overall in 0-100');
assert(typeof pr.perResource.wood === 'number', 'per-resource wood');
assert(pr.level === 'low' || pr.level === 'medium' || pr.level === 'high' || pr.level === 'critical', 'level is valid');

// High pressure scenario
var highPressureSnap = {
  resources: { wood: 8500, clay: 8600, iron: 8700, crop: 8000 },
  capacity: { warehouse: 8780, granary: 8780 },
  production: { wood: 280, clay: 200, iron: 375, crop: 145 },
  queueTimeRemainingMs: 0, timestamp: Date.now()
};
var pr2 = intel.pressure(highPressureSnap);
assert(pr2.overall >= 60, 'near-full gives high pressure (' + pr2.overall + ')');
assert(pr2.level === 'high' || pr2.level === 'critical', 'level is high or critical');
assert(pr2.urgentAction !== null, 'urgent action suggested');

// --- policy ---
console.log('\n=== policy ===');
var candidates = [
  { buildingKey: 'woodcutter', slot: 1, score: 5.0, cost: { wood: 200, clay: 500, iron: 250, crop: 300 }, affordable: true, fromLevel: 7 },
  { buildingKey: 'warehouse', slot: 31, score: 2.0, cost: { wood: 500, clay: 600, iron: 350, crop: 150 }, affordable: true, fromLevel: 7 },
  { buildingKey: 'ironMine', slot: 4, score: 6.0, cost: { wood: 400, clay: 300, iron: 120, crop: 240 }, affordable: false, fromLevel: 4 },
];

// Low pressure: no reranking
var lowPressure = { overall: 15, perResource: { wood: 15, clay: 10, iron: 20, crop: 12 }, level: 'low' };
var result1 = intel.policy(lowPressure, JSON.parse(JSON.stringify(candidates)));
assert(result1[0].buildingKey === candidates[0].buildingKey || result1[0].buildingKey === candidates[2].buildingKey, 'low pressure: candidates unchanged order');

// Critical pressure: warehouse should float to top
var critPressure = { overall: 85, perResource: { wood: 90, clay: 85, iron: 92, crop: 70 }, level: 'critical' };
var result2 = intel.policy(critPressure, JSON.parse(JSON.stringify(candidates)));
assert(result2[0].buildingKey === 'warehouse', 'critical pressure: warehouse promoted to #1');

console.log('\n=== Results ===');
console.log('Passed: ' + passed + ', Failed: ' + failed);
if (failed > 0) process.exit(1);
```

**Step 2: Run the test**

Run: `cd strategy && node test_resourceIntel.js`
Expected: All tests pass

**Step 3: Commit**

```bash
git add strategy/test_resourceIntel.js
git commit -m "test: add Resource Intelligence integration tests"
```

---

## Task 3: Register in Service Worker importScripts

**Files:**
- Modify: `background/service-worker.js` (line 14-30, the importScripts block)

**Step 1: Add resourceIntel.js to importScripts**

Insert `'../strategy/resourceIntel.js'` after `strategyEngine.js` (line 23), before `actionScorer.js` (line 24). The DecisionEngine needs ResourceIntel available at construction time.

Change:
```js
  '../strategy/strategyEngine.js',
  '../core/actionScorer.js',
```
To:
```js
  '../strategy/strategyEngine.js',
  '../strategy/resourceIntel.js',
  '../core/actionScorer.js',
```

**Step 2: Verify syntax**

Run: `node -c background/service-worker.js`
Expected: Clean parse (Note: importScripts is not available in Node, but syntax check still works)

**Step 3: Commit**

```bash
git add background/service-worker.js
git commit -m "chore: register resourceIntel.js in service worker importScripts"
```

---

## Task 4: Integrate into DecisionEngine — Constructor

**Files:**
- Modify: `core/decisionEngine.js` (constructor, around line 36-44)

**Step 1: Add ResourceIntel initialization**

In the constructor, after `this.militaryPlanner = null;` and before `this.actionScorer = null;`, add:

```js
    this.resourceIntel = null;
```

Inside the `try` block where strategy modules are initialized (after `if (self.TravianMilitaryPlanner)` line), add:

```js
        if (self.TravianResourceIntel) this.resourceIntel = new self.TravianResourceIntel();
```

After the existing log lines, add:

```js
      if (this.resourceIntel) {
        console.log('[DecisionEngine] ResourceIntel integrated — pressure-aware decisions enabled');
      }
```

**Step 2: Verify syntax**

Run: `node -c core/decisionEngine.js`
Expected: Clean parse

**Step 3: Commit**

```bash
git add core/decisionEngine.js
git commit -m "feat: wire ResourceIntel into DecisionEngine constructor"
```

---

## Task 5: Integrate into DecisionEngine — Pressure in evaluate()

**Files:**
- Modify: `core/decisionEngine.js` (evaluate method, around line 127-131)

**Step 1: Add pressure calculation before upgrade decisions**

After the `lastAnalysis` block (around line 158) and before the cranny rule check (line 162), add a pressure calculation block:

```js
    // 4.4. Resource pressure analysis (if ResourceIntel available)
    var resourcePressure = null;
    if (this.resourceIntel) {
      try {
        var snapshot = this.resourceIntel.buildSnapshot(gameState);
        if (snapshot) {
          resourcePressure = this.resourceIntel.pressure(snapshot);
          if (resourcePressure && resourcePressure.overall >= 60) {
            console.log('[DecisionEngine] Resource pressure: ' + resourcePressure.overall +
              '/100 (' + resourcePressure.level + ') — ' + (resourcePressure.urgentAction || 'monitor'));
          }
        }
      } catch (err) {
        console.warn('[DecisionEngine] ResourceIntel pressure failed:', err.message);
      }
    }
```

Also, pass `resourcePressure` to the `_strategyUpgrade` call. Change line ~182 from:

```js
      const upgradeTask = this.evaluateUpgrades(gameState, config, autoRes, autoBld);
```

To:

```js
      const upgradeTask = this.evaluateUpgrades(gameState, config, autoRes, autoBld, resourcePressure);
```

Update `evaluateUpgrades` signature to accept the new parameter:

```js
  evaluateUpgrades(state, config, autoRes, autoBld, resourcePressure) {
```

Pass it through to `_strategyUpgrade`:

```js
    if (this.buildOptimizer) {
      return this._strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets, resourcePressure);
    }
```

**Step 2: Verify syntax**

Run: `node -c core/decisionEngine.js`

**Step 3: Commit**

```bash
git add core/decisionEngine.js
git commit -m "feat: calculate resource pressure in DecisionEngine.evaluate()"
```

---

## Task 6: Integrate into DecisionEngine — Policy in _strategyUpgrade()

**Files:**
- Modify: `core/decisionEngine.js` (_strategyUpgrade method, around line 261)

**Step 1: Apply policy re-ranking after BuildOptimizer ranking**

Update `_strategyUpgrade` signature to accept `resourcePressure`:

```js
  _strategyUpgrade(state, config, autoRes, autoBld, targets, hasTargets, resourcePressure) {
```

After the `rankUpgrades` call (line 271) and before the `for (const candidate of ranked)` loop (line 273), insert policy application:

```js
    // Apply resource pressure policy re-ranking
    if (this.resourceIntel && resourcePressure && resourcePressure.overall >= 30) {
      try {
        ranked = this.resourceIntel.policy(resourcePressure, ranked);
        if (resourcePressure.overall >= 60) {
          console.log('[DecisionEngine] Pressure policy applied — candidates re-ranked for overflow prevention');
        }
      } catch (err) {
        console.warn('[DecisionEngine] ResourceIntel policy failed:', err.message);
      }
    }
```

**Step 2: Verify syntax**

Run: `node -c core/decisionEngine.js`

**Step 3: Commit**

```bash
git add core/decisionEngine.js
git commit -m "feat: apply pressure policy to re-rank upgrade candidates"
```

---

## Task 7: End-to-End Integration Test

**Files:**
- Modify: `strategy/test_integration.js` (add ResourceIntel to existing test)

**Step 1: Add ResourceIntel to the integration test**

After line 13 (`require('../core/decisionEngine.js');`), add:

```js
self.TravianResourceIntel = require('./resourceIntel.js');
```

After the `DecisionEngine` check (line 22), add:

```js
console.log('ResourceIntel:', typeof self.TravianResourceIntel === 'function' ? 'OK' : 'FAIL');
```

After the `Military planner:` check (line 29), add:

```js
console.log('Resource intel:', engine.resourceIntel ? 'INTEGRATED' : 'NOT FOUND');
```

After the existing test output, add a pressure analysis section:

```js
// Resource pressure analysis
console.log('');
console.log('=== Resource Pressure Analysis ===');
if (engine.resourceIntel) {
  var snapshot = engine.resourceIntel.buildSnapshot(gameState);
  var pressure = engine.resourceIntel.pressure(snapshot);
  console.log('Overall pressure:', pressure.overall + '/100 (' + pressure.level + ')');
  console.log('Per resource:');
  ['wood','clay','iron','crop'].forEach(function(r) {
    console.log('  ' + r + ': ' + pressure.perResource[r] + '/100' +
      (pressure.overflowRisk[r] ? ' ⚠️ OVERFLOW RISK' : ''));
  });
  if (pressure.firstOverflowMs) {
    console.log('First overflow in: ' + Math.round(pressure.firstOverflowMs / 60000) + ' minutes');
  }
  console.log('Urgent action:', pressure.urgentAction || 'none');
}
```

**Step 2: Run the full integration test**

Run: `cd strategy && node test_integration.js`
Expected: All modules load, ResourceIntel integrates, pressure analysis displays

**Step 3: Run the dedicated resourceIntel test**

Run: `cd strategy && node test_resourceIntel.js`
Expected: All assertions pass

**Step 4: Commit**

```bash
git add strategy/test_integration.js
git commit -m "test: add ResourceIntel to integration test"
```

---

## Task 8: Final Squash Commit & Push

**Step 1: Verify all files parse cleanly**

```bash
node -c strategy/resourceIntel.js
node -c core/decisionEngine.js
node -c background/service-worker.js
```

**Step 2: Run all tests**

```bash
cd strategy && node test_resourceIntel.js && node test_integration.js
```

**Step 3: Push and create PR**

```bash
git push origin claude/charming-kalam
# Create PR to feat/ai-bot-scoring-engine
```
