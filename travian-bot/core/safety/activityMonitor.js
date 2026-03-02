/**
 * ActivityMonitor — Behavior pattern detection with 7 guardrails.
 *
 * Detects: infinite loops, rapid repetitive actions, navigation loops,
 * retry storms, state oscillation, decision oscillation, farm spam.
 * All checks are synchronous and operate on bounded ring buffers.
 *
 * Exported: self.TravianActivityMonitor
 */
(function(root) {
  'use strict';

  var MAX_LOG_SIZE = 200;

  function TravianActivityMonitor() {
    // Tracking buffers (ring buffers, trimmed to MAX_LOG_SIZE)
    this._actionLog = [];        // { type, hash, timestamp }
    this._navigationLog = [];    // { url, timestamp }
    this._stateTransitions = []; // { from, to, timestamp }
    this._taskAddRemove = [];    // { taskType, action:'add'|'remove', timestamp }
    this._farmListHits = [];     // { listId, timestamp }
    this._retryLog = [];         // { timestamp }

    // Active violations (recalculated on each checkAll)
    this.violations = [];

    // Configurable thresholds
    this.thresholds = {
      sameActionMax: 5,       sameActionWindowMs: 600000,   // 5x in 10 min
      rapidActionMax: 3,      rapidActionWindowMs: 30000,   // 3 in 30 sec
      navLoopMax: 4,          navLoopWindowMs: 300000,       // 4x same URL in 5 min
      retryStormMax: 10,      retryStormWindowMs: 300000,    // 10 retries in 5 min
      stateOscMax: 6,         stateOscWindowMs: 60000,       // 6 transitions in 1 min
      decisionOscMax: 3,      decisionOscWindowMs: 600000,   // 3 add/remove cycles in 10 min
      farmSpamMax: 3,         farmSpamWindowMs: 900000        // same list 3x in 15 min
    };
  }

  // ---- Recording methods ----

  /** Record an executed action (type + params hash for dedup detection) */
  TravianActivityMonitor.prototype.recordAction = function(type, params) {
    var hash = type + ':' + _hashParams(params);
    this._actionLog.push({ type: type, hash: hash, timestamp: Date.now() });
    _trimLog(this._actionLog);
  };

  /** Record a page navigation */
  TravianActivityMonitor.prototype.recordNavigation = function(url) {
    this._navigationLog.push({ url: url, timestamp: Date.now() });
    _trimLog(this._navigationLog);
  };

  /** Record an FSM state transition */
  TravianActivityMonitor.prototype.recordStateTransition = function(from, to) {
    this._stateTransitions.push({ from: from, to: to, timestamp: Date.now() });
    _trimLog(this._stateTransitions);
  };

  /** Record a task being added or removed from the queue */
  TravianActivityMonitor.prototype.recordTaskDecision = function(taskType, action) {
    this._taskAddRemove.push({ taskType: taskType, action: action, timestamp: Date.now() });
    _trimLog(this._taskAddRemove);
  };

  /** Record a farm list send */
  TravianActivityMonitor.prototype.recordFarmListHit = function(listId) {
    this._farmListHits.push({ listId: listId, timestamp: Date.now() });
    _trimLog(this._farmListHits);
  };

  /** Record a task retry */
  TravianActivityMonitor.prototype.recordRetry = function() {
    this._retryLog.push({ timestamp: Date.now() });
    _trimLog(this._retryLog);
  };

  // ---- Guardrail checks ----

  /**
   * Run all 7 guardrail checks. Returns array of active violations.
   * Called synchronously from SafetyEngine.onPostScan().
   * @returns {Array<{ type: string, detail: string, severity: string }>}
   */
  TravianActivityMonitor.prototype.checkAll = function() {
    this.violations = [];
    var now = Date.now();

    this._checkRepeatedPattern(now);
    this._checkRapidActions(now);
    this._checkNavLoops(now);
    this._checkRetryStorms(now);
    this._checkStateOscillation(now);
    this._checkDecisionOscillation(now);
    this._checkFarmSpam(now);

    return this.violations;
  };

  /**
   * Guardrail 1: Infinite loop detection.
   * Same action+params executed >N times in window.
   */
  TravianActivityMonitor.prototype._checkRepeatedPattern = function(now) {
    var cutoff = now - this.thresholds.sameActionWindowMs;
    var counts = {};
    for (var i = 0; i < this._actionLog.length; i++) {
      var entry = this._actionLog[i];
      if (entry.timestamp < cutoff) continue;
      counts[entry.hash] = (counts[entry.hash] || 0) + 1;
      if (counts[entry.hash] > this.thresholds.sameActionMax) {
        this.violations.push({
          type: 'infinite_loop',
          detail: entry.hash + ' x' + counts[entry.hash] + ' in ' +
            (this.thresholds.sameActionWindowMs / 60000) + 'min',
          severity: 'high'
        });
        return; // one violation per check is enough
      }
    }
  };

  /**
   * Guardrail 2: Rapid repetitive actions.
   * More than N actions within a short window.
   */
  TravianActivityMonitor.prototype._checkRapidActions = function(now) {
    var cutoff = now - this.thresholds.rapidActionWindowMs;
    var count = 0;
    for (var i = this._actionLog.length - 1; i >= 0; i--) {
      if (this._actionLog[i].timestamp < cutoff) break;
      count++;
    }
    if (count > this.thresholds.rapidActionMax) {
      this.violations.push({
        type: 'rapid_actions',
        detail: count + ' actions in ' + (this.thresholds.rapidActionWindowMs / 1000) + 's',
        severity: 'medium'
      });
    }
  };

  /**
   * Guardrail 3: Navigation loop detection.
   * Same URL visited >N times in window.
   */
  TravianActivityMonitor.prototype._checkNavLoops = function(now) {
    var cutoff = now - this.thresholds.navLoopWindowMs;
    var urlCounts = {};
    for (var i = 0; i < this._navigationLog.length; i++) {
      var entry = this._navigationLog[i];
      if (entry.timestamp < cutoff) continue;
      var url = entry.url;
      urlCounts[url] = (urlCounts[url] || 0) + 1;
      if (urlCounts[url] > this.thresholds.navLoopMax) {
        this.violations.push({
          type: 'nav_loop',
          detail: url + ' x' + urlCounts[url],
          severity: 'high'
        });
        return;
      }
    }
  };

  /**
   * Guardrail 4: Retry storm detection.
   * More than N retries in window.
   */
  TravianActivityMonitor.prototype._checkRetryStorms = function(now) {
    var cutoff = now - this.thresholds.retryStormWindowMs;
    var count = 0;
    for (var i = this._retryLog.length - 1; i >= 0; i--) {
      if (this._retryLog[i].timestamp < cutoff) break;
      count++;
    }
    if (count > this.thresholds.retryStormMax) {
      this.violations.push({
        type: 'retry_storm',
        detail: count + ' retries in ' + (this.thresholds.retryStormWindowMs / 60000) + 'min',
        severity: 'high'
      });
    }
  };

  /**
   * Guardrail 5: State oscillation.
   * Too many FSM transitions in a short window (indicates instability).
   */
  TravianActivityMonitor.prototype._checkStateOscillation = function(now) {
    var cutoff = now - this.thresholds.stateOscWindowMs;
    var count = 0;
    for (var i = this._stateTransitions.length - 1; i >= 0; i--) {
      if (this._stateTransitions[i].timestamp < cutoff) break;
      count++;
    }
    if (count > this.thresholds.stateOscMax) {
      this.violations.push({
        type: 'state_oscillation',
        detail: count + ' transitions in ' + (this.thresholds.stateOscWindowMs / 1000) + 's',
        severity: 'high'
      });
    }
  };

  /**
   * Guardrail 6: Decision oscillation.
   * Same task type added then removed >N times (indecisive decision engine).
   */
  TravianActivityMonitor.prototype._checkDecisionOscillation = function(now) {
    var cutoff = now - this.thresholds.decisionOscWindowMs;
    var typeEvents = {};
    for (var i = 0; i < this._taskAddRemove.length; i++) {
      var entry = this._taskAddRemove[i];
      if (entry.timestamp < cutoff) continue;
      if (!typeEvents[entry.taskType]) typeEvents[entry.taskType] = [];
      typeEvents[entry.taskType].push(entry.action);
    }
    for (var taskType in typeEvents) {
      var actions = typeEvents[taskType];
      var pairs = 0;
      for (var j = 0; j < actions.length - 1; j++) {
        if (actions[j] === 'add' && actions[j + 1] === 'remove') pairs++;
      }
      if (pairs >= this.thresholds.decisionOscMax) {
        this.violations.push({
          type: 'decision_oscillation',
          detail: taskType + ' oscillated ' + pairs + 'x',
          severity: 'medium'
        });
      }
    }
  };

  /**
   * Guardrail 7: Farm spam detection.
   * Same farm list hit >N times in window.
   */
  TravianActivityMonitor.prototype._checkFarmSpam = function(now) {
    var cutoff = now - this.thresholds.farmSpamWindowMs;
    var listCounts = {};
    for (var i = 0; i < this._farmListHits.length; i++) {
      var entry = this._farmListHits[i];
      if (entry.timestamp < cutoff) continue;
      listCounts[entry.listId] = (listCounts[entry.listId] || 0) + 1;
      if (listCounts[entry.listId] > this.thresholds.farmSpamMax) {
        this.violations.push({
          type: 'farm_spam',
          detail: 'List ' + entry.listId + ' x' + listCounts[entry.listId],
          severity: 'medium'
        });
        return;
      }
    }
  };

  // ---- Serialization ----

  TravianActivityMonitor.prototype.serialize = function() {
    return {
      actionLog: this._actionLog.slice(-50),
      navigationLog: this._navigationLog.slice(-30),
      stateTransitions: this._stateTransitions.slice(-30),
      taskAddRemove: this._taskAddRemove.slice(-30),
      farmListHits: this._farmListHits.slice(-30),
      retryLog: this._retryLog.slice(-30)
    };
  };

  TravianActivityMonitor.prototype.deserialize = function(data) {
    if (!data) return;
    if (data.actionLog) this._actionLog = data.actionLog;
    if (data.navigationLog) this._navigationLog = data.navigationLog;
    if (data.stateTransitions) this._stateTransitions = data.stateTransitions;
    if (data.taskAddRemove) this._taskAddRemove = data.taskAddRemove;
    if (data.farmListHits) this._farmListHits = data.farmListHits;
    if (data.retryLog) this._retryLog = data.retryLog;
  };

  // ---- Helpers ----

  /** Simple deterministic hash of task params for dedup detection */
  function _hashParams(params) {
    if (!params) return '';
    var keys = Object.keys(params).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(keys[i] + '=' + params[keys[i]]);
    }
    return parts.join('&');
  }

  /** Trim ring buffer to MAX_LOG_SIZE from the front */
  function _trimLog(arr) {
    if (arr.length > MAX_LOG_SIZE) arr.splice(0, arr.length - MAX_LOG_SIZE);
  }

  // Export
  root.TravianActivityMonitor = TravianActivityMonitor;

})(typeof window !== 'undefined' ? window : self);
