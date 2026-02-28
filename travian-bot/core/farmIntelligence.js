/**
 * FarmIntelligence — Persistent target intelligence and analysis layer
 * Part of the 4-layer Farm Stack: FarmManager → FarmScheduler → FarmIntelligence → Storage
 *
 * Tracks raid results per target, computes profitability scores, and auto-manages
 * target status (active/paused/blacklisted) based on configurable rules.
 *
 * Exported via self.TravianFarmIntelligence
 *
 * Dependencies:
 *   - self.TravianLogger   (utils/logger.js)
 *   - self.TravianStorage  (utils/storage.js)
 */
(function() {
  'use strict';

  var Logger = (typeof self !== 'undefined' && self.TravianLogger) || { log: function() {} };
  var Storage = (typeof self !== 'undefined' && self.TravianStorage) || null;
  var LOG_TAG = '[FarmIntel]';

  // Max raid history entries per target (rolling window)
  var MAX_HISTORY = 20;

  // Default auto-management settings
  var DEFAULT_SETTINGS = {
    cleanupDays: 14,
    maxEmptyBeforePause: 3,
    maxLossesBeforeBlacklist: 2,
    dryPauseHours: 2
  };

  // ── Helpers ──────────────────────────────────────────────────────────

  function coordKey(x, y) {
    return x + '|' + y;
  }

  function emptyStats() {
    return {
      totalRaids: 0,
      totalLoot: { wood: 0, clay: 0, iron: 0, crop: 0 },
      totalTroopLosses: 0,
      firstRaidAt: null,
      lastRaidAt: null
    };
  }

  function emptyTargetRecord(x, y) {
    return {
      coords: { x: x, y: y },
      coordKey: coordKey(x, y),
      name: '',
      population: 0,
      distance: 0,
      status: 'active',
      pauseReason: null,
      pauseUntil: null,
      raidHistory: [],
      metrics: {
        totalRaids: 0,
        avgLootPerRaid: 0,
        profitPerHour: 0,
        consecutiveEmpty: 0,
        consecutiveLosses: 0,
        lastRaidAt: null,
        lootTrend: 'stable'
      },
      score: 0,
      discoveredAt: Date.now(),
      discoverySource: 'farmList'
    };
  }

  // ── FarmIntelligence Class ───────────────────────────────────────────

  function FarmIntelligence(serverKey) {
    this._serverKey = serverKey;
    this._targets = {};       // coordKey → TargetRecord
    this._globalStats = emptyStats();
    this._settings = Object.assign({}, DEFAULT_SETTINGS);
    this._loaded = false;
    this._dirty = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Load persisted intelligence data from chrome.storage
   */
  FarmIntelligence.prototype.load = async function() {
    if (!Storage || !this._serverKey) return;
    try {
      var key = 'farm_data__' + this._serverKey;
      var data = await Storage.get(key, null);
      if (data && data.version === 1) {
        this._targets = data.targets || {};
        this._globalStats = data.globalStats || emptyStats();
        if (data.settings) {
          this._settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
        }
        this._loaded = true;
        var count = Object.keys(this._targets).length;
        Logger.log('INFO', LOG_TAG + ' Loaded ' + count + ' targets from storage');
      } else {
        this._loaded = true;
        Logger.log('INFO', LOG_TAG + ' No existing data, starting fresh');
      }
    } catch (err) {
      Logger.log('WARN', LOG_TAG + ' Load failed: ' + (err.message || err));
      this._loaded = true;
    }
  };

  /**
   * Persist intelligence data to chrome.storage
   */
  FarmIntelligence.prototype.persist = async function() {
    if (!Storage || !this._serverKey) return;
    if (!this._dirty) return;
    try {
      var key = 'farm_data__' + this._serverKey;
      await Storage.set(key, {
        version: 1,
        targets: this._targets,
        globalStats: this._globalStats,
        settings: this._settings
      });
      this._dirty = false;
      Logger.log('DEBUG', LOG_TAG + ' Persisted ' + Object.keys(this._targets).length + ' targets');
    } catch (err) {
      Logger.log('WARN', LOG_TAG + ' Persist failed: ' + (err.message || err));
    }
  };

  /**
   * Remove stale targets not raided within cleanupDays
   */
  FarmIntelligence.prototype.cleanup = function() {
    var cutoff = Date.now() - (this._settings.cleanupDays * 24 * 60 * 60 * 1000);
    var removed = 0;
    var keys = Object.keys(this._targets);
    for (var i = 0; i < keys.length; i++) {
      var t = this._targets[keys[i]];
      // Use lastRaidAt if available, fall back to discoveredAt for never-raided targets
      var lastActivity = (t.metrics && t.metrics.lastRaidAt) || t.discoveredAt;
      if (!lastActivity || lastActivity < cutoff) {
        delete this._targets[keys[i]];
        removed++;
      }
    }
    if (removed > 0) {
      this._dirty = true;
      Logger.log('INFO', LOG_TAG + ' Cleanup: removed ' + removed + ' stale targets');
    }
  };

  // ── Recording ────────────────────────────────────────────────────────

  /**
   * Record that a raid was sent to a target (before results are known)
   * Creates the target record if it doesn't exist yet.
   */
  FarmIntelligence.prototype.recordRaidSent = function(x, y, troops, timestamp, source) {
    var key = coordKey(x, y);
    if (!this._targets[key]) {
      this._targets[key] = emptyTargetRecord(x, y);
      this._targets[key].discoverySource = source || 'farmList';
    }
    var t = this._targets[key];

    // Add a pending history entry (loot filled in by recordRaidResult later)
    t.raidHistory.push({
      timestamp: timestamp || Date.now(),
      loot: null, // Filled by recordRaidResult
      totalLoot: 0,
      troopsSent: troops ? Object.assign({}, troops) : {},
      troopsLost: {},
      totalLosses: 0,
      bountyFull: false,
      source: source || 'farmList',
      pending: true
    });

    // Trim history
    if (t.raidHistory.length > MAX_HISTORY) {
      t.raidHistory = t.raidHistory.slice(-MAX_HISTORY);
    }

    // Update global stats
    this._globalStats.totalRaids++;
    this._globalStats.lastRaidAt = timestamp || Date.now();
    if (!this._globalStats.firstRaidAt) {
      this._globalStats.firstRaidAt = this._globalStats.lastRaidAt;
    }

    this._dirty = true;
  };

  /**
   * Record the result of a raid (loot, losses) after it completes.
   * Updates the most recent pending history entry for this target.
   */
  FarmIntelligence.prototype.recordRaidResult = function(x, y, result) {
    var key = coordKey(x, y);
    var t = this._targets[key];
    if (!t) return; // Target not tracked

    // Find the most recent pending entry
    var entry = null;
    for (var i = t.raidHistory.length - 1; i >= 0; i--) {
      if (t.raidHistory[i].pending) {
        entry = t.raidHistory[i];
        break;
      }
    }

    if (entry && result) {
      entry.loot = result.loot || { wood: 0, clay: 0, iron: 0, crop: 0 };
      entry.totalLoot = (entry.loot.wood || 0) + (entry.loot.clay || 0) +
                         (entry.loot.iron || 0) + (entry.loot.crop || 0);
      entry.troopsLost = result.troopsLost || {};
      entry.totalLosses = 0;
      var lostKeys = Object.keys(entry.troopsLost);
      for (var j = 0; j < lostKeys.length; j++) {
        entry.totalLosses += entry.troopsLost[lostKeys[j]];
      }
      entry.bountyFull = !!result.bountyFull;
      delete entry.pending;

      // Update global loot stats
      var gs = this._globalStats;
      gs.totalLoot.wood += (entry.loot.wood || 0);
      gs.totalLoot.clay += (entry.loot.clay || 0);
      gs.totalLoot.iron += (entry.loot.iron || 0);
      gs.totalLoot.crop += (entry.loot.crop || 0);
      gs.totalTroopLosses += entry.totalLosses;
    }

    // Recompute metrics and evaluate status
    this._recomputeMetrics(t);
    this._evaluateStatus(t);
    this._computeScore(t);
    this._dirty = true;
  };

  /**
   * Update target metadata (name, population, distance) without recording a raid.
   * Useful when scanning farm lists or map data.
   */
  FarmIntelligence.prototype.updateTargetInfo = function(x, y, info) {
    var key = coordKey(x, y);
    if (!this._targets[key]) {
      this._targets[key] = emptyTargetRecord(x, y);
    }
    var t = this._targets[key];
    if (info.name != null) t.name = info.name;
    if (info.population != null) t.population = info.population;
    if (info.distance != null) t.distance = info.distance;
    if (info.discoverySource) t.discoverySource = info.discoverySource;
    this._dirty = true;
  };

  // ── Metrics Computation ──────────────────────────────────────────────

  /**
   * Recompute aggregated metrics from raidHistory
   */
  FarmIntelligence.prototype._recomputeMetrics = function(target) {
    var history = target.raidHistory;
    var completed = [];
    for (var i = 0; i < history.length; i++) {
      if (!history[i].pending) completed.push(history[i]);
    }

    var m = target.metrics;
    m.totalRaids = completed.length;

    if (completed.length === 0) {
      m.avgLootPerRaid = 0;
      m.profitPerHour = 0;
      m.consecutiveEmpty = 0;
      m.consecutiveLosses = 0;
      m.lastRaidAt = null;
      m.lootTrend = 'stable';
      return;
    }

    // Average loot
    var totalLoot = 0;
    for (var j = 0; j < completed.length; j++) {
      totalLoot += completed[j].totalLoot;
    }
    m.avgLootPerRaid = Math.round(totalLoot / completed.length);

    // Last raid timestamp
    m.lastRaidAt = completed[completed.length - 1].timestamp;

    // Consecutive empty raids (loot < 50 = "empty")
    m.consecutiveEmpty = 0;
    for (var k = completed.length - 1; k >= 0; k--) {
      if (completed[k].totalLoot < 50) {
        m.consecutiveEmpty++;
      } else {
        break;
      }
    }

    // Consecutive losses
    m.consecutiveLosses = 0;
    for (var l = completed.length - 1; l >= 0; l--) {
      if (completed[l].totalLosses > 0) {
        m.consecutiveLosses++;
      } else {
        break;
      }
    }

    // Profit per hour estimate
    if (target.distance > 0 && m.avgLootPerRaid > 0) {
      // Assume TT speed ~19 tiles/hour for Gauls
      var roundTripHours = (target.distance * 2) / 19;
      m.profitPerHour = Math.round(m.avgLootPerRaid / Math.max(roundTripHours, 0.5));
    }

    // Loot trend (compare last 5 vs previous 5)
    if (completed.length >= 10) {
      var recent5 = 0, older5 = 0;
      for (var r = completed.length - 5; r < completed.length; r++) {
        recent5 += completed[r].totalLoot;
      }
      for (var o = completed.length - 10; o < completed.length - 5; o++) {
        older5 += completed[o].totalLoot;
      }
      if (recent5 > older5 * 1.2) {
        m.lootTrend = 'rising';
      } else if (recent5 < older5 * 0.8) {
        m.lootTrend = 'declining';
      } else {
        m.lootTrend = 'stable';
      }
    }
  };

  // ── Auto-Management Rules ────────────────────────────────────────────

  /**
   * Evaluate and update target status based on metrics
   */
  FarmIntelligence.prototype._evaluateStatus = function(target) {
    var m = target.metrics;
    var s = this._settings;

    // Rule 1: Blacklist on consecutive losses
    if (m.consecutiveLosses >= s.maxLossesBeforeBlacklist) {
      if (target.status !== 'blacklisted') {
        target.status = 'blacklisted';
        target.pauseReason = 'losses';
        Logger.log('WARN', LOG_TAG + ' Blacklisted ' + target.coordKey + ' (' + target.name + '): ' + m.consecutiveLosses + ' consecutive losses');
      }
      return;
    }

    // Rule 2: Pause on consecutive empty raids
    if (m.consecutiveEmpty >= s.maxEmptyBeforePause && target.status === 'active') {
      target.status = 'paused';
      target.pauseReason = 'dry';
      target.pauseUntil = Date.now() + (s.dryPauseHours * 60 * 60 * 1000);
      Logger.log('INFO', LOG_TAG + ' Paused ' + target.coordKey + ' (' + target.name + '): ' + m.consecutiveEmpty + ' empty raids, resume in ' + s.dryPauseHours + 'h');
      return;
    }

    // Rule 3: Auto-resume expired pauses
    if (target.status === 'paused' && target.pauseUntil && Date.now() >= target.pauseUntil) {
      target.status = 'active';
      target.pauseReason = null;
      target.pauseUntil = null;
      Logger.log('INFO', LOG_TAG + ' Reactivated ' + target.coordKey + ' (' + target.name + '): pause expired');
      return;
    }

    // Rule 4: Reactivate paused-for-losses if last raid had no losses
    if (target.status === 'paused' && target.pauseReason === 'losses') {
      if (m.consecutiveLosses === 0) {
        target.status = 'active';
        target.pauseReason = null;
        target.pauseUntil = null;
        Logger.log('INFO', LOG_TAG + ' Reactivated ' + target.coordKey + ': clean raid after loss pause');
      }
    }
  };

  // ── Score Calculation ────────────────────────────────────────────────

  /**
   * Compute target score (0-100)
   */
  FarmIntelligence.prototype._computeScore = function(target) {
    var m = target.metrics;

    // Find max avgLoot across all active targets for normalization
    var maxAvg = 1;
    var maxRatio = 1;
    var keys = Object.keys(this._targets);
    for (var i = 0; i < keys.length; i++) {
      var tm = this._targets[keys[i]].metrics;
      if (tm.avgLootPerRaid > maxAvg) maxAvg = tm.avgLootPerRaid;
      var dist = this._targets[keys[i]].distance || 1;
      var ratio = tm.avgLootPerRaid / dist;
      if (ratio > maxRatio) maxRatio = ratio;
    }

    // Profit score (0-40): normalized average loot
    var profitScore = Math.round((m.avgLootPerRaid / maxAvg) * 40);

    // Safety score (0-30): penalty for losses
    var safetyScore = 30;
    if (m.consecutiveLosses > 0) {
      safetyScore = Math.max(0, 30 - m.consecutiveLosses * 15);
    }

    // Efficiency score (0-30): loot per distance ratio
    var dist = target.distance || 1;
    var effRatio = m.avgLootPerRaid / dist;
    var efficiencyScore = Math.round((effRatio / maxRatio) * 30);

    target.score = profitScore + safetyScore + efficiencyScore;
  };

  /**
   * Recompute scores for all targets (call after batch updates)
   */
  FarmIntelligence.prototype.recomputeAllScores = function() {
    var keys = Object.keys(this._targets);
    for (var i = 0; i < keys.length; i++) {
      this._computeScore(this._targets[keys[i]]);
    }
    this._dirty = true;
  };

  // ── Querying ─────────────────────────────────────────────────────────

  /**
   * Get all targets with status=active (also checks expired pauses)
   */
  FarmIntelligence.prototype.getActiveTargets = function() {
    var result = [];
    var keys = Object.keys(this._targets);
    var now = Date.now();
    for (var i = 0; i < keys.length; i++) {
      var t = this._targets[keys[i]];
      // Auto-resume expired pauses on read
      if (t.status === 'paused' && t.pauseUntil && now >= t.pauseUntil) {
        t.status = 'active';
        t.pauseReason = null;
        t.pauseUntil = null;
        this._dirty = true;
      }
      if (t.status === 'active') {
        result.push(t);
      }
    }
    return result;
  };

  /**
   * Get a specific target by coordinates
   */
  FarmIntelligence.prototype.getTarget = function(x, y) {
    return this._targets[coordKey(x, y)] || null;
  };

  /**
   * Get top N targets ranked by score (descending)
   */
  FarmIntelligence.prototype.getRankedTargets = function(n) {
    var active = this.getActiveTargets();
    active.sort(function(a, b) { return b.score - a.score; });
    return n ? active.slice(0, n) : active;
  };

  /**
   * Quick check if a target is blacklisted
   */
  FarmIntelligence.prototype.isBlacklisted = function(x, y) {
    var t = this._targets[coordKey(x, y)];
    return t ? t.status === 'blacklisted' : false;
  };

  // ── Status Management ────────────────────────────────────────────────

  FarmIntelligence.prototype.pauseTarget = function(x, y, reason, durationMs) {
    var t = this._targets[coordKey(x, y)];
    if (!t) return;
    t.status = 'paused';
    t.pauseReason = reason || 'manual';
    t.pauseUntil = durationMs ? (Date.now() + durationMs) : null;
    this._dirty = true;
  };

  FarmIntelligence.prototype.blacklistTarget = function(x, y, reason) {
    var t = this._targets[coordKey(x, y)];
    if (!t) return;
    t.status = 'blacklisted';
    t.pauseReason = reason || 'manual';
    this._dirty = true;
  };

  FarmIntelligence.prototype.reactivateTarget = function(x, y) {
    var t = this._targets[coordKey(x, y)];
    if (!t) return;
    t.status = 'active';
    t.pauseReason = null;
    t.pauseUntil = null;
    t.metrics.consecutiveEmpty = 0;
    t.metrics.consecutiveLosses = 0;
    this._dirty = true;
  };

  // ── Analytics ────────────────────────────────────────────────────────

  /**
   * Get global farm statistics
   */
  FarmIntelligence.prototype.getStats = function() {
    var targetCount = Object.keys(this._targets).length;
    var active = 0, paused = 0, blacklisted = 0;
    var keys = Object.keys(this._targets);
    for (var i = 0; i < keys.length; i++) {
      var s = this._targets[keys[i]].status;
      if (s === 'active') active++;
      else if (s === 'paused') paused++;
      else if (s === 'blacklisted') blacklisted++;
    }
    return {
      targetCount: targetCount,
      active: active,
      paused: paused,
      blacklisted: blacklisted,
      globalStats: this._globalStats
    };
  };

  /**
   * Get profit report for a time range
   */
  FarmIntelligence.prototype.getProfitReport = function(timeMs) {
    var cutoff = Date.now() - (timeMs || 86400000); // Default: last 24h
    var loot = { wood: 0, clay: 0, iron: 0, crop: 0 };
    var raids = 0;
    var losses = 0;
    var keys = Object.keys(this._targets);
    for (var i = 0; i < keys.length; i++) {
      var history = this._targets[keys[i]].raidHistory;
      for (var j = 0; j < history.length; j++) {
        var h = history[j];
        if (h.timestamp >= cutoff && !h.pending && h.loot) {
          loot.wood += h.loot.wood || 0;
          loot.clay += h.loot.clay || 0;
          loot.iron += h.loot.iron || 0;
          loot.crop += h.loot.crop || 0;
          raids++;
          losses += h.totalLosses || 0;
        }
      }
    }
    return { loot: loot, raids: raids, losses: losses, periodMs: timeMs || 86400000 };
  };

  // ── Export ───────────────────────────────────────────────────────────

  var target = (typeof self !== 'undefined') ? self :
               (typeof window !== 'undefined') ? window :
               (typeof global !== 'undefined') ? global : {};
  target.TravianFarmIntelligence = FarmIntelligence;

})();
