/**
 * FarmScheduler — Timing and target prioritization layer
 * Part of the 4-layer Farm Stack: FarmManager → FarmScheduler → FarmIntelligence → Storage
 *
 * Determines optimal raid timing and target ordering using intelligence data.
 * Prioritizes targets by score, distance, and time since last raid.
 *
 * Exported via self.TravianFarmScheduler
 *
 * Dependencies:
 *   - self.TravianFarmIntelligence (core/farmIntelligence.js)
 *   - self.TravianLogger           (utils/logger.js)
 */
(function() {
  'use strict';

  var Logger = (typeof self !== 'undefined' && self.TravianLogger) || { log: function() {} };
  var LOG_TAG = '[FarmSched]';

  // Default troop speed (TT for Gauls = 19 tiles/hour)
  var DEFAULT_TROOP_SPEED = 19;

  // Minimum resources worth raiding for (below this = "empty")
  var MIN_WORTHWHILE_LOOT = 50;

  // ── FarmScheduler Class ──────────────────────────────────────────────

  function FarmScheduler(intelligence) {
    this._intelligence = intelligence;
  }

  // ── Target Prioritization ────────────────────────────────────────────

  /**
   * Prioritize re-raid targets using intelligence scores and timing.
   * Targets with higher scores and longer time since last raid get boosted.
   *
   * @param {Array} targets — array of {x, y, name, lastLoot, distance} from scanReRaidTargets
   * @returns {Array} — same targets sorted by priority (highest first)
   */
  FarmScheduler.prototype.prioritizeTargets = function(targets) {
    if (!targets || targets.length === 0) return [];
    if (!this._intelligence) return targets; // No intelligence = keep original order

    var now = Date.now();
    var scored = [];

    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];
      var intel = this._intelligence.getTarget(t.x, t.y);
      var baseScore = intel ? intel.score : 50; // Default mid-score for unknown targets
      var distance = t.distance || (intel ? intel.distance : 10);

      // Time boost: targets not raided recently get priority boost
      var timeSinceLast = 0;
      if (intel && intel.metrics.lastRaidAt) {
        timeSinceLast = now - intel.metrics.lastRaidAt;
      }
      var optimalInterval = this._estimateOptimalInterval(distance, intel);
      var timeBoost = optimalInterval > 0 ? Math.min(timeSinceLast / optimalInterval, 2.0) : 1.0;

      // Priority = base score * time multiplier, capped at 200
      var priority = Math.min(200, Math.round(baseScore * (1 + timeBoost)));

      scored.push({
        target: t,
        priority: priority,
        baseScore: baseScore,
        timeBoost: timeBoost
      });
    }

    // Sort by priority descending
    scored.sort(function(a, b) { return b.priority - a.priority; });

    // Return targets in priority order
    var result = [];
    for (var j = 0; j < scored.length; j++) {
      result.push(scored[j].target);
    }

    Logger.log('DEBUG', LOG_TAG + ' Prioritized ' + result.length + ' targets (top: ' +
      (result[0] ? result[0].name + ' p=' + scored[0].priority : 'none') + ')');

    return result;
  };

  /**
   * Filter targets to only those worth raiding right now.
   * Removes blacklisted/paused targets and targets raided too recently.
   *
   * @param {Array} targets — array of {x, y, ...} from scanReRaidTargets
   * @returns {Array} — filtered targets
   */
  FarmScheduler.prototype.filterDueTargets = function(targets) {
    if (!targets || targets.length === 0) return [];
    if (!this._intelligence) return targets;

    var filtered = [];
    for (var i = 0; i < targets.length; i++) {
      var t = targets[i];

      // Skip blacklisted targets
      if (this._intelligence.isBlacklisted(t.x, t.y)) {
        Logger.log('DEBUG', LOG_TAG + ' Skip blacklisted: (' + t.x + '|' + t.y + ')');
        continue;
      }

      // Skip paused targets (getTarget checks auto-resume internally)
      var intel = this._intelligence.getTarget(t.x, t.y);
      if (intel && intel.status === 'paused') {
        Logger.log('DEBUG', LOG_TAG + ' Skip paused: (' + t.x + '|' + t.y + ')');
        continue;
      }

      filtered.push(t);
    }

    return filtered;
  };

  // ── Timing Optimization ──────────────────────────────────────────────

  /**
   * Estimate optimal raid interval for a target based on its production and distance.
   *
   * @param {number} distance — distance in tiles
   * @param {Object|null} intel — TargetRecord from FarmIntelligence
   * @returns {number} — optimal interval in milliseconds
   */
  FarmScheduler.prototype._estimateOptimalInterval = function(distance, intel) {
    var population = (intel && intel.population) || 50;
    var troopSpeed = DEFAULT_TROOP_SPEED;

    // Estimated resource production: ~4 res/hour per population point (rough Travian estimate)
    var productionPerHour = population * 4;

    // Round-trip travel time in hours
    var roundTripHours = (distance * 2) / troopSpeed;

    // Estimate carry capacity (5 TT * 150 = 750, or use avg loot if available)
    var carryCapacity = 750;
    if (intel && intel.metrics.avgLootPerRaid > 0) {
      carryCapacity = Math.max(carryCapacity, intel.metrics.avgLootPerRaid * 1.5);
    }

    // Time for target to regenerate enough resources to fill carry
    var fillTimeHours = productionPerHour > 0 ? (carryCapacity / productionPerHour) : 2;

    // Optimal interval = max of round-trip time and fill time
    var optimalHours = Math.max(roundTripHours, fillTimeHours);

    // Convert to milliseconds, with minimum 30 minutes
    return Math.max(optimalHours * 3600000, 1800000);
  };

  /**
   * Suggest an optimal farm interval based on aggregate target data.
   * DecisionEngine can use this instead of a static config interval.
   *
   * @param {Object} config — farmConfig from user settings
   * @returns {number} — suggested interval in milliseconds
   */
  FarmScheduler.prototype.getOptimalInterval = function(config) {
    if (!this._intelligence) {
      // No intelligence data — use config default
      return (config && config.farmInterval) ? config.farmInterval * 60000 : 600000; // 10 min default
    }

    var active = this._intelligence.getActiveTargets();
    if (active.length === 0) return 3600000; // 1 hour if no active targets

    // Find the minimum optimal interval across all active targets
    var minInterval = Infinity;
    for (var i = 0; i < active.length; i++) {
      var dist = active[i].distance || 10;
      var interval = this._estimateOptimalInterval(dist, active[i]);
      if (interval < minInterval) minInterval = interval;
    }

    // Don't go below 5 minutes or above 60 minutes
    return Math.max(300000, Math.min(minInterval, 3600000));
  };

  /**
   * Check if it's worth farming now based on active target availability.
   *
   * @param {Object} config — farmConfig
   * @returns {boolean}
   */
  FarmScheduler.prototype.shouldFarmNow = function(config) {
    if (!this._intelligence) return true; // No data = always farm

    var active = this._intelligence.getActiveTargets();
    if (active.length === 0) {
      Logger.log('DEBUG', LOG_TAG + ' shouldFarmNow: false (no active targets)');
      return false;
    }

    return true;
  };

  // ── Export ───────────────────────────────────────────────────────────

  var target = (typeof self !== 'undefined') ? self :
               (typeof window !== 'undefined') ? window :
               (typeof global !== 'undefined') ? global : {};
  target.TravianFarmScheduler = FarmScheduler;

})();
