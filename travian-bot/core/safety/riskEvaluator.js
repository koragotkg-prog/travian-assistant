/**
 * RiskEvaluator — Weighted risk scoring model (0-100).
 *
 * Components:
 *   action_rate    (0-25) — hourly action rate vs limit
 *   error_rate     (0-25) — scan error rate over 30 min
 *   retry_pressure (0-15) — retry count vs budget
 *   pattern_violations (0-20) — active behavior guardrail violations
 *   anomaly_score  (0-15) — DOM/response anomalies
 *
 * Levels: LOW (0-25), MEDIUM (26-50), HIGH (51-75), CRITICAL (76-100)
 *
 * Exported: self.TravianRiskEvaluator
 */
(function(root) {
  'use strict';

  var HISTORY_SIZE = 20;

  function TravianRiskEvaluator() {
    this.currentScore = 0;
    this.currentLevel = 'LOW';
    this._history = [];             // last N { score, level, timestamp }
    this._consecutiveLowCount = 0;  // for safe mode auto-recovery
  }

  /**
   * Compute risk score from all safety signals.
   * Must complete in <5ms (synchronous, no async).
   *
   * @param {TravianRateLimiter} rateLimiter
   * @param {TravianActivityMonitor} activityMonitor
   * @param {TravianAccountHealthMonitor} healthMonitor
   * @returns {{ score: number, level: string, components: object, consecutiveLow: number, trend: string }}
   */
  TravianRiskEvaluator.prototype.evaluate = function(rateLimiter, activityMonitor, healthMonitor) {
    var components = {};

    // Component 1: Action rate (0-25)
    var hourlyCount = rateLimiter.actionsPerHour.count();
    var hourlyLimit = rateLimiter.limits.actionsPerHour;
    components.actionRate = hourlyLimit > 0
      ? Math.min(25, Math.round((hourlyCount / hourlyLimit) * 25))
      : 0;

    // Component 2: Error rate (0-25)
    var errorRate = healthMonitor.getErrorRate30Min();
    components.errorRate = Math.min(25, Math.round(errorRate * 25));

    // Component 3: Retry pressure (0-15)
    var retryCount = rateLimiter.retriesPerHour.count();
    var retryLimit = rateLimiter.limits.retriesPerHour;
    components.retryPressure = retryLimit > 0
      ? Math.min(15, Math.round((retryCount / retryLimit) * 15))
      : 0;

    // Component 4: Pattern violations (0-20) — 5 points per active violation
    var violations = activityMonitor.violations;
    components.patternViolations = Math.min(20, violations.length * 5);

    // Component 5: Anomaly score (0-15)
    components.anomalyScore = Math.min(15, healthMonitor.getAnomalyScore());

    // Total score (capped at 100)
    var total = components.actionRate + components.errorRate +
                components.retryPressure + components.patternViolations +
                components.anomalyScore;
    this.currentScore = Math.min(100, total);

    // Determine level
    if (this.currentScore <= 25)      this.currentLevel = 'LOW';
    else if (this.currentScore <= 50) this.currentLevel = 'MEDIUM';
    else if (this.currentScore <= 75) this.currentLevel = 'HIGH';
    else                              this.currentLevel = 'CRITICAL';

    // Track consecutive LOW readings for safe mode auto-recovery
    if (this.currentLevel === 'LOW') {
      this._consecutiveLowCount++;
    } else {
      this._consecutiveLowCount = 0;
    }

    // History ring buffer
    this._history.push({
      score: this.currentScore,
      level: this.currentLevel,
      timestamp: Date.now()
    });
    if (this._history.length > HISTORY_SIZE) this._history.shift();

    return {
      score: this.currentScore,
      level: this.currentLevel,
      components: components,
      consecutiveLow: this._consecutiveLowCount,
      trend: this._calculateTrend()
    };
  };

  /**
   * Calculate trend from recent history: 'rising', 'falling', or 'stable'.
   * Compares latest score to average of last 3.
   */
  TravianRiskEvaluator.prototype._calculateTrend = function() {
    if (this._history.length < 3) return 'stable';
    var recent = this._history.slice(-3);
    var avg = (recent[0].score + recent[1].score + recent[2].score) / 3;
    var latest = recent[2].score;
    if (latest > avg + 5) return 'rising';
    if (latest < avg - 5) return 'falling';
    return 'stable';
  };

  // ---- Serialization ----

  TravianRiskEvaluator.prototype.serialize = function() {
    return {
      currentScore: this.currentScore,
      currentLevel: this.currentLevel,
      consecutiveLowCount: this._consecutiveLowCount,
      history: this._history
    };
  };

  TravianRiskEvaluator.prototype.deserialize = function(data) {
    if (!data) return;
    if (typeof data.currentScore === 'number') this.currentScore = data.currentScore;
    if (data.currentLevel) this.currentLevel = data.currentLevel;
    if (typeof data.consecutiveLowCount === 'number') this._consecutiveLowCount = data.consecutiveLowCount;
    if (Array.isArray(data.history)) this._history = data.history;
  };

  // Export
  root.TravianRiskEvaluator = TravianRiskEvaluator;

})(typeof window !== 'undefined' ? window : self);
