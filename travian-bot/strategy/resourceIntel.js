/**
 * resourceIntel.js — Resource Intelligence & Pressure Analysis
 *
 * Provides real-time resource forecasting, overflow detection,
 * pressure scoring, and policy-based candidate re-ranking.
 *
 * Depends on: TravianGameData (gameData.js)
 * Compatible with: Service Worker (self), Browser (window), Node.js (module.exports)
 */
(function () {
  'use strict';

  // Resolve dependency
  var GD = (typeof self !== 'undefined' && self.TravianGameData) ||
           (typeof window !== 'undefined' && window.TravianGameData) ||
           (typeof global !== 'undefined' && global.TravianGameData) ||
           (typeof require === 'function' ? require('./gameData') : null);

  var RESOURCE_KEYS = ['wood', 'clay', 'iron', 'crop'];
  var FARM_EMA_ALPHA = 0.3; // EMA smoothing factor (0.3 = responsive to recent, 0.7 weight to history)

  // =========================================================================
  // ResourceIntel
  // =========================================================================
  function ResourceIntel() {
    this.GD = GD;
  }

  // -------------------------------------------------------------------------
  // buildSnapshot — Normalize gameState into a clean snapshot
  // -------------------------------------------------------------------------

  /**
   * Build a normalized resource snapshot from raw gameState.
   *
   * @param {object} gameState - Raw game state from DOM scanner
   * @returns {object|null} Normalized snapshot or null on bad input
   */
  ResourceIntel.prototype.buildSnapshot = function (gameState) {
    if (!gameState) return null;

    var resources = this._extractResources(gameState);
    var capacity = this._extractCapacity(gameState);
    var production = this._extractProduction(gameState);
    var queueTimeRemainingMs = this._extractQueueTime(gameState);

    return {
      resources: resources,
      capacity: capacity,
      production: production,
      queueTimeRemainingMs: queueTimeRemainingMs,
      timestamp: Date.now()
    };
  };

  /** @private */
  ResourceIntel.prototype._extractResources = function (gs) {
    var r = gs.resources || {};
    return {
      wood: r.wood || 0,
      clay: r.clay || 0,
      iron: r.iron || 0,
      crop: r.crop || 0
    };
  };

  /** @private */
  ResourceIntel.prototype._extractProduction = function (gs) {
    var p = gs.production || {};
    return {
      wood: p.wood || 0,
      clay: p.clay || 0,
      iron: p.iron || 0,
      crop: p.crop || 0
    };
  };

  /** @private */
  ResourceIntel.prototype._extractCapacity = function (gs) {
    var warehouse = 800;
    var granary = 800;

    // Priority 1: Direct resourceCapacity
    if (gs.resourceCapacity) {
      if (gs.resourceCapacity.warehouse > 0) warehouse = gs.resourceCapacity.warehouse;
      if (gs.resourceCapacity.granary > 0) granary = gs.resourceCapacity.granary;
      return { warehouse: warehouse, granary: granary };
    }

    // Priority 2: Resolve from building levels (gid 10=warehouse, 11=granary)
    var buildings = gs.buildings || [];
    var warehouseFound = false;
    var granaryFound = false;

    for (var i = 0; i < buildings.length; i++) {
      var b = buildings[i];
      var gid = b.gid || b.id;
      if (gid === 10 && !warehouseFound) {
        warehouse = this.GD ? this.GD.getStorageCapacity(b.level) : 800;
        warehouseFound = true;
      }
      if (gid === 11 && !granaryFound) {
        granary = this.GD ? this.GD.getStorageCapacity(b.level) : 800;
        granaryFound = true;
      }
    }
    if (warehouseFound || granaryFound) {
      return { warehouse: warehouse, granary: granary };
    }

    // Priority 3: storage object with levels
    if (gs.storage) {
      if (gs.storage.warehouse > 0 && this.GD) {
        warehouse = this.GD.getStorageCapacity(gs.storage.warehouse);
      }
      if (gs.storage.granary > 0 && this.GD) {
        granary = this.GD.getStorageCapacity(gs.storage.granary);
      }
    }

    return { warehouse: warehouse, granary: granary };
  };

  /** @private */
  ResourceIntel.prototype._extractQueueTime = function (gs) {
    var queue = gs.constructionQueue;
    if (!queue || !queue.items || !queue.items.length) return 0;

    var total = 0;
    for (var i = 0; i < queue.items.length; i++) {
      var item = queue.items[i];
      if (typeof item.remainingMs === 'number') {
        total += item.remainingMs;
      } else if (typeof item.remainingSec === 'number') {
        total += item.remainingSec * 1000;
      }
    }
    return total;
  };

  // -------------------------------------------------------------------------
  // forecast — Deterministic linear projection with build cost drain
  // -------------------------------------------------------------------------

  /**
   * Project resource levels forward in time.
   *
   * Phase 2 enhancement: supports pendingCosts to model resource drain
   * when queued builds complete. Each pending cost has a completionMs
   * (ms from now) and resource costs that are subtracted at that time.
   *
   * @param {object} snapshot - From buildSnapshot()
   * @param {number} [horizonMs=7200000] - Forecast horizon in ms (default 2h)
   * @param {object} [options] - Optional settings
   * @param {Array}  [options.pendingCosts] - Queued build costs: [{wood,clay,iron,crop,completionMs}]
   * @param {object} [options.farmIncomePerHr] - Predicted farm income: {wood,clay,iron,crop}
   * @returns {object|null} Forecast per resource or null on bad input
   */
  ResourceIntel.prototype.forecast = function (snapshot, horizonMs, options) {
    if (!snapshot || !snapshot.resources || !snapshot.capacity || !snapshot.production) {
      return null;
    }

    if (typeof horizonMs !== 'number' || horizonMs < 0) {
      horizonMs = 7200000; // default 2 hours
    }

    var opts = options || {};
    var pendingCosts = opts.pendingCosts || [];
    var farmIncome = opts.farmIncomePerHr || null;

    // Pre-compute total pending drain per resource within horizon
    var pendingDrain = { wood: 0, clay: 0, iron: 0, crop: 0 };
    for (var p = 0; p < pendingCosts.length; p++) {
      var pc = pendingCosts[p];
      if (pc && typeof pc.completionMs === 'number' && pc.completionMs <= horizonMs) {
        for (var pk = 0; pk < RESOURCE_KEYS.length; pk++) {
          pendingDrain[RESOURCE_KEYS[pk]] += (pc[RESOURCE_KEYS[pk]] || 0);
        }
      }
    }

    var result = {};
    var firstOverflowMs = null;

    for (var i = 0; i < RESOURCE_KEYS.length; i++) {
      var r = RESOURCE_KEYS[i];
      var current = snapshot.resources[r] || 0;
      var prodPerHr = snapshot.production[r] || 0;

      // Add predicted farm income to effective production
      if (farmIncome && typeof farmIncome[r] === 'number') {
        prodPerHr += farmIncome[r];
      }

      var cap = this._getCapForResource(r, snapshot.capacity);

      // Projected value at horizon (before pending drain)
      var projected;
      if (prodPerHr > 0) {
        projected = Math.min(cap, current + prodPerHr * horizonMs / 3600000);
      } else {
        projected = Math.max(0, current + prodPerHr * horizonMs / 3600000);
        projected = Math.min(projected, cap);
      }

      // Subtract pending build costs from projection
      projected = Math.max(0, projected - pendingDrain[r]);
      projected = Math.min(projected, cap);

      // Time to full (without drain — conservative overflow estimate)
      var msToFull = null;
      if (current >= cap) {
        msToFull = 0;
      } else if (prodPerHr > 0) {
        msToFull = (cap - current) / (prodPerHr / 3600000);
      }

      // Overflow detection
      var overflow = projected >= cap && prodPerHr > 0;
      var overflowMs = null;
      if (overflow && prodPerHr > 0 && current < cap) {
        overflowMs = (cap - current) / (prodPerHr / 3600000);
      } else if (current >= cap && prodPerHr > 0) {
        overflowMs = 0;
      }

      if (overflowMs !== null && (firstOverflowMs === null || overflowMs < firstOverflowMs)) {
        firstOverflowMs = overflowMs;
      }

      result[r] = {
        current: current,
        projected: Math.round(projected),
        overflow: overflow,
        overflowMs: overflowMs !== null ? Math.round(overflowMs) : null,
        msToFull: msToFull !== null ? Math.round(msToFull) : null
      };
    }

    result.horizonMs = horizonMs;
    result.firstOverflowMs = firstOverflowMs !== null ? Math.round(firstOverflowMs) : null;
    result.pendingDrain = pendingDrain;

    return result;
  };

  /** @private — Get the correct capacity for a resource type */
  ResourceIntel.prototype._getCapForResource = function (resKey, capacity) {
    if (resKey === 'crop') return capacity.granary || 800;
    return capacity.warehouse || 800;
  };

  // -------------------------------------------------------------------------
  // pressure — Weighted pressure scoring per resource
  // -------------------------------------------------------------------------

  /**
   * Calculate resource pressure scores.
   *
   * @param {object} snapshot - From buildSnapshot()
   * @returns {object|null} Pressure report or null on bad input
   */
  ResourceIntel.prototype.pressure = function (snapshot) {
    if (!snapshot || !snapshot.resources || !snapshot.capacity || !snapshot.production) {
      return null;
    }

    var fc = this.forecast(snapshot);
    if (!fc) return null;

    var totalProd = 0;
    for (var i = 0; i < RESOURCE_KEYS.length; i++) {
      totalProd += (snapshot.production[RESOURCE_KEYS[i]] || 0);
    }

    var perResource = {};
    var overflowRisk = {};
    var overall = 0;

    for (var j = 0; j < RESOURCE_KEYS.length; j++) {
      var r = RESOURCE_KEYS[j];
      var current = snapshot.resources[r] || 0;
      var cap = this._getCapForResource(r, snapshot.capacity);
      var prodPerHr = snapshot.production[r] || 0;
      var msToFull = fc[r].msToFull;

      // Fill ratio (0-1)
      var fillRatio = cap > 0 ? current / cap : 0;
      fillRatio = Math.min(1, Math.max(0, fillRatio));

      // Overflow urgency (0-1): higher when closer to full
      var overflowUrgency = 0;
      if (msToFull !== null && msToFull >= 0) {
        overflowUrgency = Math.max(0, 1 - msToFull / (4 * 3600000));
      }

      // Imbalance penalty (0-1)
      var prodRatio = totalProd > 0 ? prodPerHr / totalProd : 0.25;
      var imbalancePenalty = Math.abs(prodRatio - 0.25) / 0.25;
      imbalancePenalty = Math.min(1, imbalancePenalty);

      // Weighted pressure
      var p = 40 * fillRatio + 40 * overflowUrgency + 20 * imbalancePenalty;
      p = Math.max(0, Math.min(100, Math.round(p * 10) / 10));

      perResource[r] = p;
      overflowRisk[r] = fc[r].overflow;

      if (p > overall) overall = p;
    }

    // Determine level
    var level;
    if (overall >= 80) level = 'critical';
    else if (overall >= 60) level = 'high';
    else if (overall >= 30) level = 'medium';
    else level = 'low';

    // Determine urgent action
    var urgentAction = null;
    if (overall >= 60) {
      // Check if overflow is the primary concern
      var hasOverflow = false;
      for (var k = 0; k < RESOURCE_KEYS.length; k++) {
        if (overflowRisk[RESOURCE_KEYS[k]]) {
          hasOverflow = true;
          break;
        }
      }
      urgentAction = hasOverflow ? 'upgrade_storage' : 'spend_resources';
    }

    return {
      overall: Math.round(overall * 10) / 10,
      perResource: perResource,
      urgentAction: urgentAction,
      overflowRisk: overflowRisk,
      firstOverflowMs: fc.firstOverflowMs,
      level: level
    };
  };

  // -------------------------------------------------------------------------
  // policy — Re-rank BuildOptimizer candidates based on pressure
  // -------------------------------------------------------------------------

  /**
   * Re-rank build candidates based on resource pressure.
   *
   * @param {object} pressureReport - From pressure()
   * @param {Array} candidates - BuildOptimizer candidates
   * @param {object} [options] - Optional settings
   * @returns {Array} Re-ranked candidates (new array, original untouched)
   */
  ResourceIntel.prototype.policy = function (pressureReport, candidates, options) {
    if (!pressureReport || !candidates || !candidates.length) {
      return candidates ? candidates.slice() : [];
    }

    // Clone to avoid mutating caller's array (consistent with BuildOptimizer.rankUpgrades)
    candidates = candidates.slice();

    // Low pressure: return unchanged
    if (pressureReport.overall < 30) {
      for (var x = 0; x < candidates.length; x++) {
        candidates[x]._adjustedScore = candidates[x].score || 0;
      }
      return candidates;
    }

    var lvl = pressureReport.level;
    var pressureMult;
    if (lvl === 'critical') pressureMult = 1.0;
    else if (lvl === 'high') pressureMult = 0.6;
    else pressureMult = 0.3; // medium

    var pr = pressureReport.perResource || {};

    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var cost = c.cost || {};
      var totalCost = (cost.wood || 0) + (cost.clay || 0) + (cost.iron || 0) + (cost.crop || 0);

      // Calculate relief score
      var relief = 0;
      if (totalCost > 0) {
        for (var j = 0; j < RESOURCE_KEYS.length; j++) {
          var rk = RESOURCE_KEYS[j];
          relief += (cost[rk] || 0) * (pr[rk] || 0);
        }
        relief = relief / totalCost / 100;
      }

      var baseScore = c.score || 0;
      var adjustedScore = baseScore * (1 + relief * pressureMult);

      // High/critical: heavily penalize non-affordable candidates
      if (pressureReport.overall >= 60 && !c.affordable) {
        adjustedScore = adjustedScore * 0.01;
      }

      c._adjustedScore = Math.round(adjustedScore * 10000) / 10000;
    }

    // Sort by adjustedScore descending
    candidates.sort(function (a, b) {
      return (b._adjustedScore || 0) - (a._adjustedScore || 0);
    });

    // Critical: promote affordable warehouse/granary to position 0
    if (pressureReport.overall >= 80) {
      for (var k = 0; k < candidates.length; k++) {
        var ck = candidates[k];
        if (ck.affordable && (ck.buildingKey === 'warehouse' || ck.buildingKey === 'granary')) {
          if (k !== 0) {
            candidates.splice(k, 1);
            candidates.unshift(ck);
          }
          break;
        }
      }
    }

    return candidates;
  };

  // -------------------------------------------------------------------------
  // cropSafety — Crop sustainability check
  // -------------------------------------------------------------------------

  /**
   * Check crop sustainability: can the village sustain its troops?
   *
   * Crop is unique — troops consume it. A village can starve when
   * net crop (production - upkeep) goes negative. This method flags
   * danger early so the bot can avoid training more troops or
   * prioritize crop field upgrades.
   *
   * @param {object} snapshot - From buildSnapshot()
   * @param {number} [troopUpkeep=0] - Total troop crop consumption per hour
   * @returns {object|null} Crop safety report or null on bad input
   */
  ResourceIntel.prototype.cropSafety = function (snapshot, troopUpkeep) {
    if (!snapshot || !snapshot.resources || !snapshot.production) {
      return null;
    }

    var cropProd = snapshot.production.crop || 0;
    var upkeep = typeof troopUpkeep === 'number' ? troopUpkeep : 0;
    var netCrop = cropProd - upkeep;
    var currentCrop = snapshot.resources.crop || 0;
    var cap = snapshot.capacity ? (snapshot.capacity.granary || 800) : 800;

    // Hours until starvation (crop reaches 0 with negative net)
    var hoursToStarvation = null;
    if (netCrop < 0 && currentCrop > 0) {
      hoursToStarvation = currentCrop / Math.abs(netCrop);
      hoursToStarvation = Math.round(hoursToStarvation * 100) / 100;
    } else if (netCrop < 0 && currentCrop <= 0) {
      hoursToStarvation = 0;
    }

    // Fill ratio for crop
    var fillRatio = cap > 0 ? currentCrop / cap : 0;
    fillRatio = Math.min(1, Math.max(0, fillRatio));

    // Determine safety level
    var level;
    if (netCrop < 0) {
      level = hoursToStarvation !== null && hoursToStarvation < 2 ? 'danger' : 'warning';
    } else if (netCrop < 5) {
      // Very low margin (< 5/hr net) — warn
      level = 'warning';
    } else {
      level = 'safe';
    }

    // Should the bot train more troops?
    // Safe to train when: net crop > 5/hr AND crop isn't critically low
    var safeToTrain = netCrop > 5 && fillRatio > 0.1;

    // Recommended action
    var action = null;
    if (level === 'danger') {
      action = 'upgrade_crop';
    } else if (level === 'warning' && netCrop < 0) {
      action = 'upgrade_crop';
    } else if (level === 'warning') {
      action = 'monitor';
    }

    return {
      netCrop: Math.round(netCrop * 10) / 10,
      cropProduction: cropProd,
      troopUpkeep: upkeep,
      currentCrop: currentCrop,
      fillRatio: Math.round(fillRatio * 1000) / 1000,
      hoursToStarvation: hoursToStarvation,
      safeToTrain: safeToTrain,
      level: level,
      action: action
    };
  };

  // -------------------------------------------------------------------------
  // Farm Loot Prediction — EMA-based farm income estimation
  // -------------------------------------------------------------------------

  /**
   * Record a completed farm run for EMA tracking.
   *
   * Tracks per-farm-list loot history using an Exponential Moving Average.
   * Smooths out raid-to-raid variance to predict reliable income.
   *
   * @param {string} farmId - Farm list ID or name
   * @param {object} loot - Resources gained: {wood, clay, iron, crop}
   * @param {boolean} [success=true] - Whether the raid succeeded
   */
  ResourceIntel.prototype.recordFarmRun = function (farmId, loot, success) {
    if (!farmId) return;

    if (!this._farmHistory) this._farmHistory = {};

    var now = Date.now();
    var isSuccess = success !== false;
    var totalLoot = 0;

    if (isSuccess && loot) {
      for (var i = 0; i < RESOURCE_KEYS.length; i++) {
        totalLoot += (loot[RESOURCE_KEYS[i]] || 0);
      }
    }

    var entry = this._farmHistory[farmId];
    if (!entry) {
      entry = {
        emaLoot: { wood: 0, clay: 0, iron: 0, crop: 0 },
        emaTotal: 0,
        runs: 0,
        successes: 0,
        lastRunTs: now,
        avgIntervalMs: 0,
        alpha: FARM_EMA_ALPHA
      };
      this._farmHistory[farmId] = entry;
    }

    // Update run interval EMA
    if (entry.lastRunTs > 0 && entry.runs > 0) {
      var interval = now - entry.lastRunTs;
      if (entry.avgIntervalMs === 0) {
        entry.avgIntervalMs = interval;
      } else {
        entry.avgIntervalMs = entry.alpha * interval + (1 - entry.alpha) * entry.avgIntervalMs;
      }
    }

    entry.runs++;
    if (isSuccess) entry.successes++;
    entry.lastRunTs = now;

    // Update per-resource EMA (only on success)
    if (isSuccess && loot) {
      for (var j = 0; j < RESOURCE_KEYS.length; j++) {
        var rk = RESOURCE_KEYS[j];
        var val = loot[rk] || 0;
        if (entry.runs <= 1) {
          entry.emaLoot[rk] = val;
        } else {
          entry.emaLoot[rk] = entry.alpha * val + (1 - entry.alpha) * entry.emaLoot[rk];
        }
      }
      if (entry.runs <= 1) {
        entry.emaTotal = totalLoot;
      } else {
        entry.emaTotal = entry.alpha * totalLoot + (1 - entry.alpha) * entry.emaTotal;
      }
    }
  };

  /**
   * Predict farm income per hour for a specific farm.
   *
   * Formula: expected_loot_per_hour = avg_loot_per_run × runs_per_hour × success_rate
   *
   * @param {string} farmId - Farm list ID or name
   * @returns {object|null} Prediction or null if insufficient data
   */
  ResourceIntel.prototype.predictFarmIncome = function (farmId) {
    if (!this._farmHistory || !this._farmHistory[farmId]) return null;

    var entry = this._farmHistory[farmId];
    if (entry.runs < 2 || entry.avgIntervalMs <= 0) return null;

    var successRate = entry.runs > 0 ? entry.successes / entry.runs : 0;
    var runsPerHour = 3600000 / entry.avgIntervalMs;

    var incomePerHr = {};
    var totalPerHr = 0;
    for (var i = 0; i < RESOURCE_KEYS.length; i++) {
      var rk = RESOURCE_KEYS[i];
      var rate = entry.emaLoot[rk] * runsPerHour * successRate;
      incomePerHr[rk] = Math.round(rate * 10) / 10;
      totalPerHr += rate;
    }

    return {
      farmId: farmId,
      incomePerHr: incomePerHr,
      totalPerHr: Math.round(totalPerHr * 10) / 10,
      successRate: Math.round(successRate * 1000) / 1000,
      runsPerHour: Math.round(runsPerHour * 100) / 100,
      avgLootPerRun: Math.round(entry.emaTotal),
      runs: entry.runs,
      lastRunTs: entry.lastRunTs
    };
  };

  /**
   * Get aggregate farm income prediction across all tracked farms.
   *
   * @returns {object} Combined income: {wood,clay,iron,crop} per hour + farms array
   */
  ResourceIntel.prototype.getAllFarmPredictions = function () {
    var combined = { wood: 0, clay: 0, iron: 0, crop: 0 };
    var farms = [];

    if (!this._farmHistory) return { incomePerHr: combined, farms: farms };

    for (var farmId in this._farmHistory) {
      var pred = this.predictFarmIncome(farmId);
      if (pred) {
        farms.push(pred);
        for (var i = 0; i < RESOURCE_KEYS.length; i++) {
          var rk = RESOURCE_KEYS[i];
          combined[rk] += pred.incomePerHr[rk];
        }
      }
    }

    return {
      incomePerHr: {
        wood: Math.round(combined.wood * 10) / 10,
        clay: Math.round(combined.clay * 10) / 10,
        iron: Math.round(combined.iron * 10) / 10,
        crop: Math.round(combined.crop * 10) / 10
      },
      farms: farms
    };
  };

  // -------------------------------------------------------------------------
  // State persistence — Serialize/restore for chrome.storage
  // -------------------------------------------------------------------------

  /**
   * Export internal state for persistence (e.g., to chrome.storage).
   * Includes farm history for EMA continuity across service worker restarts.
   *
   * @returns {object} Serializable state object
   */
  ResourceIntel.prototype.getState = function () {
    return {
      farmHistory: this._farmHistory || {},
      version: 2
    };
  };

  /**
   * Restore internal state from persisted data.
   *
   * @param {object} state - Previously exported state from getState()
   */
  ResourceIntel.prototype.loadState = function (state) {
    if (!state || typeof state !== 'object') return;
    if (state.farmHistory && typeof state.farmHistory === 'object') {
      this._farmHistory = state.farmHistory;
    }
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = ResourceIntel;
  else if (typeof self !== 'undefined') self.TravianResourceIntel = ResourceIntel;
  else if (typeof window !== 'undefined') window.TravianResourceIntel = ResourceIntel;
})();
