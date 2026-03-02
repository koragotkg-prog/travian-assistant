/**
 * RateLimiter — Multi-tier sliding window rate limiting.
 *
 * Tracks action counts across configurable time windows using timestamp arrays.
 * Sliding windows give accurate counts at any moment (unlike fixed-window counters
 * that can miss bursts at boundaries).
 *
 * Exported: self.TravianRateLimiter
 */
(function(root) {
  'use strict';

  // ---- SlidingWindowCounter ----

  /**
   * Tracks event counts within a configurable time window.
   * Stores timestamps as a sorted array, pruned on each count/add.
   * Memory: ~8 bytes per timestamp, capped at maxSize.
   *
   * @param {number} windowMs - Window duration in milliseconds
   * @param {number} [maxSize=500] - Hard cap on stored timestamps
   */
  function SlidingWindowCounter(windowMs, maxSize) {
    this.windowMs = windowMs;
    this.maxSize = maxSize || 500;
    this.timestamps = [];
  }

  /** Record an event at current time */
  SlidingWindowCounter.prototype.add = function() {
    this.timestamps.push(Date.now());
    this._prune();
  };

  /** Count events within the current window */
  SlidingWindowCounter.prototype.count = function() {
    this._prune();
    return this.timestamps.length;
  };

  /** Remove entries older than the window + enforce hard cap */
  SlidingWindowCounter.prototype._prune = function() {
    var cutoff = Date.now() - this.windowMs;
    var i = 0;
    while (i < this.timestamps.length && this.timestamps[i] < cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
    if (this.timestamps.length > this.maxSize) {
      this.timestamps = this.timestamps.slice(-this.maxSize);
    }
  };

  /** Serialize for persistence */
  SlidingWindowCounter.prototype.serialize = function() {
    this._prune();
    return this.timestamps.slice();
  };

  /** Restore from persisted data */
  SlidingWindowCounter.prototype.deserialize = function(arr) {
    this.timestamps = Array.isArray(arr) ? arr.slice() : [];
    this._prune();
  };

  // ---- RateLimiter ----

  function TravianRateLimiter() {
    // Multi-tier sliding window counters
    this.actionsPerMinute = new SlidingWindowCounter(60000, 20);         // 1 min
    this.actionsPerHour = new SlidingWindowCounter(3600000, 200);        // 1 hour
    this.actionsPerDay = new SlidingWindowCounter(86400000, 1000);       // 24 hours
    this.navigationsPerWindow = new SlidingWindowCounter(300000, 50);    // 5 min
    this.retriesPerHour = new SlidingWindowCounter(3600000, 100);        // 1 hour
    this.farmRaidsPerHour = new SlidingWindowCounter(3600000, 100);      // 1 hour
    this.trainCommandsPerHour = new SlidingWindowCounter(3600000, 50);   // 1 hour

    // Configurable limits (with safe defaults)
    this.limits = {
      actionsPerMinute: 4,
      actionsPerHour: 60,
      actionsPerDay: 800,
      navigationsPerFiveMin: 20,
      retriesPerHour: 30,
      farmRaidsPerHour: 30,
      trainCommandsPerHour: 30,
      maxQueueSize: 50,
      maxSessionDurationMs: 8 * 3600000  // 8 hours
    };

    this.sessionStartTime = null;
  }

  /**
   * Record a successful action of a given type.
   * Updates global counters + type-specific counters.
   * @param {string} actionType
   */
  TravianRateLimiter.prototype.recordAction = function(actionType) {
    this.actionsPerMinute.add();
    this.actionsPerHour.add();
    this.actionsPerDay.add();

    if (actionType === 'send_farm') this.farmRaidsPerHour.add();
    if (actionType === 'train_troops' || actionType === 'train_traps') {
      this.trainCommandsPerHour.add();
    }
  };

  /** Record a page navigation */
  TravianRateLimiter.prototype.recordNavigation = function() {
    this.navigationsPerWindow.add();
  };

  /** Record a task retry */
  TravianRateLimiter.prototype.recordRetry = function() {
    this.retriesPerHour.add();
  };

  /** Mark session start (called when bot starts) */
  TravianRateLimiter.prototype.startSession = function() {
    if (!this.sessionStartTime) {
      this.sessionStartTime = Date.now();
    }
  };

  /** Clear session timer (called when bot stops) */
  TravianRateLimiter.prototype.endSession = function() {
    this.sessionStartTime = null;
  };

  /**
   * Check all rate limits.
   * @param {number} queueSize - Current pending task count
   * @returns {{ allowed: boolean, violations: string[] }}
   */
  TravianRateLimiter.prototype.check = function(queueSize) {
    var violations = [];

    if (this.actionsPerMinute.count() >= this.limits.actionsPerMinute) {
      violations.push('burst:' + this.actionsPerMinute.count() + '/' + this.limits.actionsPerMinute + '/min');
    }
    if (this.actionsPerHour.count() >= this.limits.actionsPerHour) {
      violations.push('hourly:' + this.actionsPerHour.count() + '/' + this.limits.actionsPerHour + '/hr');
    }
    if (this.actionsPerDay.count() >= this.limits.actionsPerDay) {
      violations.push('daily:' + this.actionsPerDay.count() + '/' + this.limits.actionsPerDay + '/day');
    }
    if (this.navigationsPerWindow.count() >= this.limits.navigationsPerFiveMin) {
      violations.push('nav:' + this.navigationsPerWindow.count() + '/' + this.limits.navigationsPerFiveMin + '/5min');
    }
    if (this.retriesPerHour.count() >= this.limits.retriesPerHour) {
      violations.push('retries:' + this.retriesPerHour.count() + '/' + this.limits.retriesPerHour + '/hr');
    }
    if (this.farmRaidsPerHour.count() >= this.limits.farmRaidsPerHour) {
      violations.push('farming:' + this.farmRaidsPerHour.count() + '/' + this.limits.farmRaidsPerHour + '/hr');
    }
    if (this.trainCommandsPerHour.count() >= this.limits.trainCommandsPerHour) {
      violations.push('training:' + this.trainCommandsPerHour.count() + '/' + this.limits.trainCommandsPerHour + '/hr');
    }
    if (typeof queueSize === 'number' && queueSize >= this.limits.maxQueueSize) {
      violations.push('queue:' + queueSize + '/' + this.limits.maxQueueSize);
    }
    if (this.sessionStartTime &&
        (Date.now() - this.sessionStartTime) >= this.limits.maxSessionDurationMs) {
      violations.push('session:expired');
    }

    return { allowed: violations.length === 0, violations: violations };
  };

  /**
   * Check if a specific action type is rate-limited.
   * @param {string} actionType
   * @returns {boolean}
   */
  TravianRateLimiter.prototype.isActionBlocked = function(actionType) {
    if (actionType === 'send_farm') {
      return this.farmRaidsPerHour.count() >= this.limits.farmRaidsPerHour;
    }
    if (actionType === 'train_troops' || actionType === 'train_traps') {
      return this.trainCommandsPerHour.count() >= this.limits.trainCommandsPerHour;
    }
    return false;
  };

  /** Serialize all counters for persistence */
  TravianRateLimiter.prototype.serialize = function() {
    return {
      actionsPerMinute: this.actionsPerMinute.serialize(),
      actionsPerHour: this.actionsPerHour.serialize(),
      actionsPerDay: this.actionsPerDay.serialize(),
      navigationsPerWindow: this.navigationsPerWindow.serialize(),
      retriesPerHour: this.retriesPerHour.serialize(),
      farmRaidsPerHour: this.farmRaidsPerHour.serialize(),
      trainCommandsPerHour: this.trainCommandsPerHour.serialize(),
      sessionStartTime: this.sessionStartTime,
      limits: this.limits
    };
  };

  /** Restore from persisted data */
  TravianRateLimiter.prototype.deserialize = function(data) {
    if (!data) return;
    if (data.actionsPerMinute) this.actionsPerMinute.deserialize(data.actionsPerMinute);
    if (data.actionsPerHour) this.actionsPerHour.deserialize(data.actionsPerHour);
    if (data.actionsPerDay) this.actionsPerDay.deserialize(data.actionsPerDay);
    if (data.navigationsPerWindow) this.navigationsPerWindow.deserialize(data.navigationsPerWindow);
    if (data.retriesPerHour) this.retriesPerHour.deserialize(data.retriesPerHour);
    if (data.farmRaidsPerHour) this.farmRaidsPerHour.deserialize(data.farmRaidsPerHour);
    if (data.trainCommandsPerHour) this.trainCommandsPerHour.deserialize(data.trainCommandsPerHour);
    if (typeof data.sessionStartTime === 'number') this.sessionStartTime = data.sessionStartTime;
    if (data.limits) Object.assign(this.limits, data.limits);
  };

  // Export
  root.TravianRateLimiter = TravianRateLimiter;
  // Also export SlidingWindowCounter for testing
  root.TravianSlidingWindowCounter = SlidingWindowCounter;

})(typeof window !== 'undefined' ? window : self);
