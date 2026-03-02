/**
 * AccountHealthMonitor — Session, DOM, and game response health tracking.
 *
 * Tracks: scan success/null fields, response times, login failures,
 * selector failures, maintenance detection. Feeds anomaly score (0-15)
 * into the RiskEvaluator.
 *
 * Exported: self.TravianAccountHealthMonitor
 */
(function(root) {
  'use strict';

  var MAX_HISTORY = 50;

  function TravianAccountHealthMonitor() {
    this._scanResults = [];           // { success, nullFields, timestamp }
    this._responseTimes = [];         // { ms, timestamp }
    this._selectorFailures = {};      // selectorName -> consecutive failure count
    this._loginFailures = 0;          // consecutive login check failures
    this._consecutiveNullScans = 0;   // consecutive scans returning null/incomplete
    this._totalActions = 0;           // total actions in last 30 min (for error rate)
    this._totalErrors = 0;            // total errors in last 30 min
  }

  /**
   * Record scan results for health tracking.
   * @param {object|null} gameState - The scan response data
   * @param {number} [scanDurationMs] - How long the scan took
   */
  TravianAccountHealthMonitor.prototype.recordScan = function(gameState, scanDurationMs) {
    var nullFields = [];
    if (gameState) {
      var criticalFields = ['resources', 'loggedIn', 'page'];
      for (var i = 0; i < criticalFields.length; i++) {
        if (gameState[criticalFields[i]] == null) {
          nullFields.push(criticalFields[i]);
        }
      }
    }

    this._scanResults.push({
      success: gameState != null,
      nullFields: nullFields,
      timestamp: Date.now()
    });
    if (this._scanResults.length > MAX_HISTORY) this._scanResults.shift();

    // Response time tracking
    if (typeof scanDurationMs === 'number' && scanDurationMs > 0) {
      this._responseTimes.push({ ms: scanDurationMs, timestamp: Date.now() });
      if (this._responseTimes.length > MAX_HISTORY) this._responseTimes.shift();
    }

    // Consecutive null tracking
    if (!gameState || nullFields.length > 0) {
      this._consecutiveNullScans++;
    } else {
      this._consecutiveNullScans = 0;
    }
  };

  /**
   * Record a login check result.
   * @param {boolean} loggedIn
   */
  TravianAccountHealthMonitor.prototype.recordLoginCheck = function(loggedIn) {
    if (!loggedIn) {
      this._loginFailures++;
    } else {
      this._loginFailures = 0;
    }
  };

  /**
   * Record a task execution outcome (for error rate calculation).
   * @param {boolean} success
   */
  TravianAccountHealthMonitor.prototype.recordTaskOutcome = function(success) {
    this._totalActions++;
    if (!success) this._totalErrors++;
  };

  /**
   * Record a DOM selector failure (known selector returned null).
   * @param {string} selectorName - Identifier for the selector
   */
  TravianAccountHealthMonitor.prototype.recordSelectorFailure = function(selectorName) {
    this._selectorFailures[selectorName] = (this._selectorFailures[selectorName] || 0) + 1;
  };

  /**
   * Record a DOM selector success (resets consecutive failure count).
   * @param {string} selectorName
   */
  TravianAccountHealthMonitor.prototype.recordSelectorSuccess = function(selectorName) {
    if (this._selectorFailures[selectorName]) {
      delete this._selectorFailures[selectorName];
    }
  };

  /**
   * Calculate error rate over the last 30 minutes.
   * Based on scan success rate.
   * @returns {number} 0.0 to 1.0
   */
  TravianAccountHealthMonitor.prototype.getErrorRate30Min = function() {
    var cutoff = Date.now() - 1800000; // 30 min
    var total = 0;
    var failures = 0;
    for (var i = 0; i < this._scanResults.length; i++) {
      if (this._scanResults[i].timestamp < cutoff) continue;
      total++;
      if (!this._scanResults[i].success || this._scanResults[i].nullFields.length > 0) {
        failures++;
      }
    }
    if (total === 0) return 0;
    return failures / total;
  };

  /**
   * Calculate anomaly score (0-15) from:
   * - Consecutive null scans (0-5)
   * - Slow response times (0-5)
   * - Selector failures (0-5)
   * @returns {number}
   */
  TravianAccountHealthMonitor.prototype.getAnomalyScore = function() {
    var score = 0;

    // Consecutive nulls: 1 point each, max 5
    score += Math.min(5, this._consecutiveNullScans);

    // Slow responses: check average of last 5 scans
    if (this._responseTimes.length >= 3) {
      var recentTimes = this._responseTimes.slice(-5);
      var avgMs = 0;
      for (var i = 0; i < recentTimes.length; i++) avgMs += recentTimes[i].ms;
      avgMs /= recentTimes.length;
      if (avgMs > 10000) score += 5;
      else if (avgMs > 5000) score += 3;
      else if (avgMs > 3000) score += 1;
    }

    // Selector failures: 1 point per persistently failed selector (3+ consecutive), max 5
    var failedSelectors = 0;
    for (var key in this._selectorFailures) {
      if (this._selectorFailures[key] >= 3) failedSelectors++;
    }
    score += Math.min(5, failedSelectors);

    return Math.min(15, score);
  };

  /**
   * Detect game maintenance from scan data.
   * @param {object|null} gameState
   * @returns {boolean}
   */
  TravianAccountHealthMonitor.prototype.detectMaintenance = function(gameState) {
    if (!gameState) return false;
    if (gameState.page === 'maintenance') return true;
    if (gameState.error && typeof gameState.error === 'string') {
      var errorLower = gameState.error.toLowerCase();
      if (errorLower.indexOf('maintenance') !== -1) return true;
      if (errorLower.indexOf('update') !== -1 && errorLower.indexOf('server') !== -1) return true;
    }
    return false;
  };

  /**
   * Detect potential account ban indicators.
   * @param {object|null} gameState
   * @returns {boolean}
   */
  TravianAccountHealthMonitor.prototype.detectBanIndicators = function(gameState) {
    if (!gameState) return false;
    if (gameState.error && typeof gameState.error === 'string') {
      var errorLower = gameState.error.toLowerCase();
      if (errorLower.indexOf('banned') !== -1) return true;
      if (errorLower.indexOf('suspended') !== -1) return true;
      if (errorLower.indexOf('violation') !== -1) return true;
    }
    return false;
  };

  /** @returns {number} consecutive login failures */
  TravianAccountHealthMonitor.prototype.getLoginFailures = function() {
    return this._loginFailures;
  };

  /** @returns {number} consecutive null/incomplete scans */
  TravianAccountHealthMonitor.prototype.getConsecutiveNullScans = function() {
    return this._consecutiveNullScans;
  };

  // ---- Serialization ----

  TravianAccountHealthMonitor.prototype.serialize = function() {
    return {
      scanResults: this._scanResults.slice(-20),
      responseTimes: this._responseTimes.slice(-20),
      loginFailures: this._loginFailures,
      consecutiveNullScans: this._consecutiveNullScans,
      selectorFailures: this._selectorFailures,
      totalActions: this._totalActions,
      totalErrors: this._totalErrors
    };
  };

  TravianAccountHealthMonitor.prototype.deserialize = function(data) {
    if (!data) return;
    if (data.scanResults) this._scanResults = data.scanResults;
    if (data.responseTimes) this._responseTimes = data.responseTimes;
    if (typeof data.loginFailures === 'number') this._loginFailures = data.loginFailures;
    if (typeof data.consecutiveNullScans === 'number') this._consecutiveNullScans = data.consecutiveNullScans;
    if (data.selectorFailures) this._selectorFailures = data.selectorFailures;
    if (typeof data.totalActions === 'number') this._totalActions = data.totalActions;
    if (typeof data.totalErrors === 'number') this._totalErrors = data.totalErrors;
  };

  // Export
  root.TravianAccountHealthMonitor = TravianAccountHealthMonitor;

})(typeof window !== 'undefined' ? window : self);
