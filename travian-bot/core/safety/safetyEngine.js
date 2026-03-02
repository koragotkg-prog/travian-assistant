/**
 * SafetyEngine — Central orchestrator for the Safety Guardrail System.
 *
 * Implements 4 hooks called by BotEngine:
 *   1. onPostScan(gameState, config, queueSize)  — health + risk evaluation
 *   2. onPostDecide(tasks, gameState, config)     — policy-based task filtering
 *   3. onPreExecute(task, gameState)              — final gate before execution
 *   4. onPostExecute(task, response, gameState)   — record outcome for monitoring
 *
 * Sub-components:
 *   RateLimiter, ActivityMonitor, RiskEvaluator,
 *   ExecutionPolicyManager, SafeModeController, AccountHealthMonitor
 *
 * Persists to: bot_safety__<serverKey> via TravianStorage
 *
 * Exported: self.TravianSafetyEngine
 */
(function(root) {
  'use strict';

  var Logger = (typeof TravianLogger !== 'undefined') ? TravianLogger : { log: function() {} };
  var Storage = root.TravianStorage || null;

  var SAFETY_STATE_VERSION = 1;

  function TravianSafetyEngine(serverKey, eventBus) {
    this._serverKey = serverKey;
    this._eventBus = eventBus;
    this._dirty = false;

    // Sub-components
    this.rateLimiter = new root.TravianRateLimiter();
    this.activityMonitor = new root.TravianActivityMonitor();
    this.riskEvaluator = new root.TravianRiskEvaluator();
    this.policyManager = new root.TravianExecutionPolicyManager();
    this.safeModeController = new root.TravianSafeModeController();
    this.healthMonitor = new root.TravianAccountHealthMonitor();

    // Auto-pause escalation state
    this._autoPauseCount = 0;
    this._lastRiskResult = null;
  }

  // ---- Storage key ----

  TravianSafetyEngine.prototype._storageKey = function() {
    return 'bot_safety__' + this._serverKey;
  };

  // ---- Load / Save (async, called during BotEngine.start()) ----

  TravianSafetyEngine.prototype.load = async function() {
    if (!Storage) return;
    try {
      var data = await Storage.get(this._storageKey(), null);
      if (data && data.version === SAFETY_STATE_VERSION) {
        this.deserialize(data);
        Logger.log('INFO', '[Safety] Restored state for ' + this._serverKey +
          ' (risk: ' + this.riskEvaluator.currentLevel + ')');
      }
    } catch (err) {
      Logger.log('WARN', '[Safety] Failed to load state: ' + (err.message || err));
    }
  };

  TravianSafetyEngine.prototype.save = async function() {
    if (!Storage) return;
    try {
      var data = this.serialize();
      await Storage.set(this._storageKey(), data);
      this._dirty = false;
    } catch (err) {
      Logger.log('WARN', '[Safety] Failed to save state: ' + (err.message || err));
    }
  };

  // ---- Serialize / Deserialize (synchronous, for inline state persistence) ----

  TravianSafetyEngine.prototype.serialize = function() {
    return {
      version: SAFETY_STATE_VERSION,
      savedAt: Date.now(),
      rateLimiter: this.rateLimiter.serialize(),
      activityMonitor: this.activityMonitor.serialize(),
      riskEvaluator: this.riskEvaluator.serialize(),
      safeMode: this.safeModeController.serialize(),
      healthMonitor: this.healthMonitor.serialize(),
      autoPauseCount: this._autoPauseCount
    };
  };

  TravianSafetyEngine.prototype.deserialize = function(data) {
    if (!data || data.version !== SAFETY_STATE_VERSION) return;
    this.rateLimiter.deserialize(data.rateLimiter);
    this.activityMonitor.deserialize(data.activityMonitor);
    this.riskEvaluator.deserialize(data.riskEvaluator);
    this.safeModeController.deserialize(data.safeMode);
    this.healthMonitor.deserialize(data.healthMonitor);
    if (typeof data.autoPauseCount === 'number') this._autoPauseCount = data.autoPauseCount;
  };

  // ════════════════════════════════════════════════
  //  HOOK 1: Post-scan, pre-decide
  // ════════════════════════════════════════════════

  /**
   * Called after SCAN succeeds and gameState is populated.
   * Runs: health checks → activity analysis → risk evaluation → escalation.
   *
   * @param {object} gameState
   * @param {object} config
   * @param {number} [queueSize=0] - Current pending task count
   * @returns {{ block: boolean, action?: string, reason?: string, cooldownMs?: number }}
   */
  TravianSafetyEngine.prototype.onPostScan = function(gameState, config, queueSize) {
    // 1. Health monitoring
    this.healthMonitor.recordScan(gameState, gameState ? gameState._scanDurationMs : null);
    if (gameState) {
      this.healthMonitor.recordLoginCheck(!!gameState.loggedIn);
    }

    // 2. Ban detection — emergency stop
    if (this.healthMonitor.detectBanIndicators(gameState)) {
      Logger.log('ERROR', '[Safety] Account ban indicators detected — emergency stop');
      return { block: true, action: 'emergency', reason: 'Account ban indicators detected' };
    }

    // 3. Maintenance detection — pause
    if (this.healthMonitor.detectMaintenance(gameState)) {
      Logger.log('WARN', '[Safety] Game maintenance detected — pausing');
      return { block: true, action: 'pause', reason: 'Game maintenance detected' };
    }

    // 4. Activity analysis (updates violations)
    this.activityMonitor.checkAll();

    // 5. Risk evaluation
    var risk = this.riskEvaluator.evaluate(
      this.rateLimiter,
      this.activityMonitor,
      this.healthMonitor
    );
    this._lastRiskResult = risk;

    // 6. Safe mode auto-recovery check
    if (this.safeModeController.active) {
      if (this.safeModeController.checkAutoRecovery(risk.consecutiveLow)) {
        Logger.log('INFO', '[Safety] Safe mode auto-recovered (LOW x' + risk.consecutiveLow + ')');
        this._notify('Safe Mode Ended', 'Risk returned to LOW — normal operation resumed');
        this._dirty = true;
      }
    }

    // 7. Escalation based on risk level
    if (risk.level === 'CRITICAL') {
      this._dirty = true;
      return this._autoPauseEscalation();
    }

    if (risk.level === 'HIGH' && !this.safeModeController.active) {
      this.safeModeController.enter('risk_high');
      this._notify('Safe Mode [HIGH]', 'Risk score ' + risk.score + ' — restricted to builds');
      Logger.log('WARN', '[Safety] Safe mode (HIGH risk: ' + risk.score + ')');
      this._dirty = true;
    }

    if (risk.level === 'MEDIUM' && !this.safeModeController.active) {
      this.safeModeController.enter('risk_medium');
      Logger.log('WARN', '[Safety] Safe mode (MEDIUM risk: ' + risk.score + ')');
      this._dirty = true;
    }

    // 8. Global rate limit check
    var rateLimitCheck = this.rateLimiter.check(queueSize || 0);
    if (!rateLimitCheck.allowed) {
      // Check for session expiry specifically
      for (var i = 0; i < rateLimitCheck.violations.length; i++) {
        if (rateLimitCheck.violations[i].indexOf('session') !== -1) {
          Logger.log('WARN', '[Safety] Session duration limit reached');
          return { block: true, action: 'pause', reason: 'Session duration limit reached' };
        }
      }
      // Other rate limit violations inform risk scoring but don't block the cycle
    }

    // 9. Reset auto-pause count when risk is LOW
    if (risk.level === 'LOW' && this._autoPauseCount > 0) {
      this._autoPauseCount = 0;
      this._dirty = true;
    }

    return { block: false };
  };

  // ════════════════════════════════════════════════
  //  HOOK 2: Post-decide, pre-queue
  // ════════════════════════════════════════════════

  /**
   * Filter tasks through the policy engine before they enter the queue.
   *
   * @param {Array} tasks - Generated by DecisionEngine
   * @param {object} gameState
   * @param {object} config
   * @returns {Array} Filtered tasks (blocked tasks silently dropped)
   */
  TravianSafetyEngine.prototype.onPostDecide = function(tasks, gameState, config) {
    if (!tasks || tasks.length === 0) return tasks;

    var context = {
      riskLevel: this.riskEvaluator.currentLevel,
      safeMode: this.safeModeController.active,
      quietHours: config && config.safetyConfig ? config.safetyConfig.quietHours : null
    };

    var filtered = this.policyManager.filterTasks(tasks, context);

    if (filtered.length < tasks.length) {
      Logger.log('DEBUG', '[Safety] Filtered ' + (tasks.length - filtered.length) +
        '/' + tasks.length + ' tasks (risk: ' + this.riskEvaluator.currentLevel + ')');
    }

    return filtered;
  };

  // ════════════════════════════════════════════════
  //  HOOK 3: Pre-execute
  // ════════════════════════════════════════════════

  /**
   * Final gate before task execution.
   *
   * @param {object} task
   * @param {object} gameState
   * @returns {{ block: boolean, reason?: string }}
   */
  TravianSafetyEngine.prototype.onPreExecute = function(task, gameState) {
    // 1. Safe mode action filter
    if (!this.safeModeController.isAllowed(task.type)) {
      return { block: true, reason: 'safe_mode:' + task.type };
    }

    // 2. Action-specific rate limits
    if (this.rateLimiter.isActionBlocked(task.type)) {
      return { block: true, reason: 'rate_limit:' + task.type };
    }

    // 3. Policy evaluation
    var context = {
      actionType: task.type,
      riskLevel: this.riskEvaluator.currentLevel,
      safeMode: this.safeModeController.active,
      actionRateLimited: false // already checked above
    };
    var policyResult = this.policyManager.evaluate(context);
    if (!policyResult.allowed) {
      return { block: true, reason: 'policy:' + policyResult.policy };
    }

    return { block: false };
  };

  // ════════════════════════════════════════════════
  //  HOOK 4: Post-execute
  // ════════════════════════════════════════════════

  /**
   * Record execution outcome for monitoring and rate scoring.
   *
   * @param {object} task
   * @param {object} response - { success, reason?, message? }
   * @param {object} gameState
   */
  TravianSafetyEngine.prototype.onPostExecute = function(task, response, gameState) {
    var success = response && response.success;

    // Record in activity monitor
    this.activityMonitor.recordAction(task.type, task.params);

    // Record in rate limiter
    if (success) {
      this.rateLimiter.recordAction(task.type);
    } else {
      this.rateLimiter.recordRetry();
      this.activityMonitor.recordRetry();
    }

    // Record in health monitor
    this.healthMonitor.recordTaskOutcome(!!success);

    // Track farm list hits
    if (task.type === 'send_farm' && success && task.params) {
      var listId = task.params.listId || task.params.farmListId;
      if (listId) this.activityMonitor.recordFarmListHit(listId);
    }

    this._dirty = true;
  };

  // ════════════════════════════════════════════════
  //  Auto-pause escalation
  // ════════════════════════════════════════════════

  TravianSafetyEngine.prototype._autoPauseEscalation = function() {
    this._autoPauseCount++;

    // Escalation ladder: 5min → 15min → 45min → 2h
    var cooldowns = [300000, 900000, 2700000, 7200000];
    var level = Math.min(this._autoPauseCount - 1, cooldowns.length - 1);
    var cooldownMs = cooldowns[level];

    this._notify(
      'Auto-Paused [' + this._serverKey.split('.')[0] + ']',
      'Risk CRITICAL (score: ' + this.riskEvaluator.currentScore +
        '). Cooldown: ' + Math.round(cooldownMs / 60000) + 'min'
    );

    Logger.log('ERROR', '[Safety] Auto-pause level ' + this._autoPauseCount +
      ' — cooldown ' + (cooldownMs / 60000) + 'min');

    return {
      block: true,
      action: 'pause',
      reason: 'risk_critical_level_' + this._autoPauseCount,
      cooldownMs: cooldownMs
    };
  };

  // ════════════════════════════════════════════════
  //  User actions
  // ════════════════════════════════════════════════

  /** User manually exits safe mode via popup */
  TravianSafetyEngine.prototype.exitSafeMode = function() {
    this.safeModeController.exit('user_override');
    Logger.log('INFO', '[Safety] Safe mode exited (user override)');
    this._dirty = true;
  };

  /** Reset auto-pause counter (called on successful bot restart) */
  TravianSafetyEngine.prototype.resetAutoPause = function() {
    this._autoPauseCount = 0;
    this._dirty = true;
  };

  /** Update rate limits from user config */
  TravianSafetyEngine.prototype.updateLimits = function(safetyConfig) {
    if (!safetyConfig) return;
    var limits = this.rateLimiter.limits;
    if (safetyConfig.maxActionsPerHour) limits.actionsPerHour = safetyConfig.maxActionsPerHour;
    if (safetyConfig.maxActionsPerDay) limits.actionsPerDay = safetyConfig.maxActionsPerDay;
    if (safetyConfig.maxSessionHours) {
      limits.maxSessionDurationMs = safetyConfig.maxSessionHours * 3600000;
    }
    if (safetyConfig.maxFarmRaidsPerHour) limits.farmRaidsPerHour = safetyConfig.maxFarmRaidsPerHour;
    if (safetyConfig.maxTrainCommandsPerHour) {
      limits.trainCommandsPerHour = safetyConfig.maxTrainCommandsPerHour;
    }
  };

  /** Mark session start for duration tracking */
  TravianSafetyEngine.prototype.onBotStart = function() {
    this.rateLimiter.startSession();
  };

  /** Clear session timer */
  TravianSafetyEngine.prototype.onBotStop = function() {
    this.rateLimiter.endSession();
  };

  // ════════════════════════════════════════════════
  //  Status (for popup display)
  // ════════════════════════════════════════════════

  /** Get comprehensive safety status for popup/dashboard */
  TravianSafetyEngine.prototype.getStatus = function() {
    return {
      riskScore: this.riskEvaluator.currentScore,
      riskLevel: this.riskEvaluator.currentLevel,
      riskComponents: this._lastRiskResult ? this._lastRiskResult.components : null,
      riskTrend: this._lastRiskResult ? this._lastRiskResult.trend : 'stable',
      safeMode: this.safeModeController.active,
      safeModeReason: this.safeModeController.reason,
      safeModeEnteredAt: this.safeModeController.enteredAt,
      safeModeRemaining: this.safeModeController.getRemainingMinDuration(),
      violations: this.activityMonitor.violations,
      autoPauseCount: this._autoPauseCount,
      rateLimits: {
        actionsPerMinute: this.rateLimiter.actionsPerMinute.count(),
        actionsPerHour: this.rateLimiter.actionsPerHour.count(),
        actionsPerDay: this.rateLimiter.actionsPerDay.count(),
        farmRaidsPerHour: this.rateLimiter.farmRaidsPerHour.count(),
        trainCommandsPerHour: this.rateLimiter.trainCommandsPerHour.count()
      },
      limits: this.rateLimiter.limits,
      healthScore: 15 - this.healthMonitor.getAnomalyScore()
    };
  };

  /** @returns {boolean} true if state needs persistence */
  TravianSafetyEngine.prototype.isDirty = function() {
    return this._dirty;
  };

  // ════════════════════════════════════════════════
  //  Notification helper
  // ════════════════════════════════════════════════

  TravianSafetyEngine.prototype._notify = function(title, message) {
    if (typeof chrome === 'undefined' || !chrome.notifications) return;
    try {
      chrome.notifications.create('safety_' + this._serverKey + '_' + Date.now(), {
        type: 'basic',
        iconUrl: '../icons/icon48.png',
        title: title,
        message: message,
        priority: 2
      });
    } catch (_) {
      // Notifications not available — silently ignore
    }
  };

  // Export
  root.TravianSafetyEngine = TravianSafetyEngine;

})(typeof window !== 'undefined' ? window : self);
