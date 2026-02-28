/**
 * BotEngine - Main bot engine that ties together TaskQueue, Scheduler, and DecisionEngine
 * Runs in service worker context (no DOM, no window)
 * Exported via self.TravianBotEngine
 *
 * Dependencies (must be loaded before this file):
 *   - self.TravianTaskQueue   (core/taskQueue.js)
 *   - self.TravianScheduler   (core/scheduler.js)
 *   - self.TravianDecisionEngine (core/decisionEngine.js)
 *   - self.TravianGameStateCollector (core/gameStateCollector.js)
 */

// ---------------------------------------------------------------------------
// Bot State Machine — valid states and transitions
// ---------------------------------------------------------------------------
const BOT_STATES = Object.freeze({
  STOPPED:   'STOPPED',
  SCANNING:  'SCANNING',
  DECIDING:  'DECIDING',
  EXECUTING: 'EXECUTING',
  COOLDOWN:  'COOLDOWN',
  IDLE:      'IDLE',
  PAUSED:    'PAUSED',
  EMERGENCY: 'EMERGENCY'
});

/** Valid transitions: from → [allowed targets] */
const BOT_TRANSITIONS = Object.freeze({
  STOPPED:   ['SCANNING', 'IDLE'],
  SCANNING:  ['DECIDING', 'IDLE', 'PAUSED', 'EMERGENCY', 'STOPPED'],
  DECIDING:  ['EXECUTING', 'IDLE', 'PAUSED', 'EMERGENCY', 'STOPPED'],
  EXECUTING: ['COOLDOWN', 'IDLE', 'SCANNING', 'PAUSED', 'EMERGENCY', 'STOPPED'],
  COOLDOWN:  ['SCANNING', 'IDLE', 'PAUSED', 'EMERGENCY', 'STOPPED'],
  IDLE:      ['SCANNING', 'PAUSED', 'EMERGENCY', 'STOPPED'],
  PAUSED:    ['IDLE', 'SCANNING', 'EMERGENCY', 'STOPPED'],
  EMERGENCY: ['STOPPED']
});

class BotEngine {
  constructor() {
    // State machine: single source of truth
    this._botState = BOT_STATES.STOPPED;

    // Backward-compatible boolean flags (kept as writable for external callers)
    // Internal code should use _transition() but external callers may still set these.
    this._running = false;
    this._paused = false;
    this._emergencyStopped = false;
    this._emergencyReason = null; // SAF-5 FIX: remember WHY we emergency-stopped

    // Core subsystems
    this.taskQueue = new self.TravianTaskQueue();
    this.scheduler = new self.TravianScheduler();
    this.decisionEngine = new self.TravianDecisionEngine();
    this.stateCollector = new self.TravianGameStateCollector();

    // Current state
    this.gameState = null;
    this.config = null;
    this.activeTabId = null;
    this.serverKey = null; // Set by InstanceManager

    // Statistics
    this.stats = {
      tasksCompleted: 0,
      tasksFailed: 0,
      startTime: null,
      lastAction: null,
      farmRaidsSent: 0
    };

    // Next action scheduling
    this.nextActionTime = null;

    // Persistent farm cooldown (survives gameState overwrites)
    this._lastFarmTime = 0;

    // Rate limiting
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // Content script communication timeout (ms)
    // TQ-6 FIX: Increased base from 15s to 30s. Chrome throttles background tabs
    // with minimum 1s setTimeout — content scripts can take 20-30s under heavy throttle.
    // At 15s the timeout would fire → reject → retry → duplicate click.
    this._messageTimeout = 30000;
    this._messageTimeoutBase = 30000;   // Reset target after success
    this._messageTimeoutMax = 60000;    // Cap for throttled tabs
    this._messageTimeoutStep = 10000;   // Increase per consecutive timeout

    // TQ-6 FIX: Request deduplication counter.
    // Each EXECUTE message gets a unique requestId so the content script can
    // detect and discard duplicate requests from timeout→retry sequences.
    this._requestIdCounter = 0;

    // FIX-P3: Unified cycle lock replaces _mainLoopRunning + _executionLocked.
    // Values: null (free), 'scanning', 'deciding', 'executing', 'returning'
    // Any non-null value blocks concurrent mainLoop entry.
    this._cycleLock = null;

    // Backward compat aliases (read-only, derived from _cycleLock)
    // _mainLoopRunning: true when any cycle phase is active
    // _executionLocked: true only during executing/returning phases
    Object.defineProperty(this, '_mainLoopRunning', {
      get: () => this._cycleLock !== null,
      set: (v) => { if (!v) this._cycleLock = null; }, // legacy clear
      configurable: true
    });
    Object.defineProperty(this, '_executionLocked', {
      get: () => this._cycleLock === 'executing' || this._cycleLock === 'returning',
      set: (v) => { /* no-op, controlled by _cycleLock */ },
      configurable: true
    });

    // Circuit breaker: consecutive failure protection
    this._consecutiveFailures = 0;
    this._circuitBreakerThreshold = 5;
    this._circuitBreakerCooldownMs = 5 * 60 * 1000; // 5 minutes
    this._circuitBreakerTrips = 0;      // SAF-3 FIX: trip counter for escalation
    this._circuitBreakerMaxTrips = 3;   // SAF-3 FIX: emergency stop after N trips

    // SAF-1 FIX: Not-logged-in consecutive counter.
    // Session expiry makes loggedIn=false every cycle, but old code just skipped
    // with return — no counter, no escalation, no notification.
    // Bot appeared "running" but did nothing forever.
    this._notLoggedInCount = 0;
    this._notLoggedInMaxCount = 5; // emergency stop after 5 consecutive not-logged-in

    // Structured logging: cycle counter
    this._cycleCounter = 0;
    this._currentCycleId = null;

    // Cached buildings data from dorf2 scans.
    // getBuildings() only works on dorf2 but the bot rests on dorf1.
    // We cache the last dorf2 scan and refresh every N cycles.
    this._cachedBuildings = null;
    this._buildingsScanCycle = 0;       // last cycle that scanned dorf2
    this._buildingsScanInterval = 3;    // rescan dorf2 every N cycles
  }

  // ---------------------------------------------------------------------------
  // State Machine
  // ---------------------------------------------------------------------------

  /**
   * Attempt a state transition. Logs all transitions and rejects invalid ones.
   * @param {string} newState - Target state from BOT_STATES
   * @param {string} [reason] - Optional reason for the transition
   * @returns {boolean} True if transition succeeded
   */
  _transition(newState, reason) {
    const oldState = this._botState;

    // Same state — no-op
    if (oldState === newState) return true;

    const allowed = BOT_TRANSITIONS[oldState];
    if (!allowed || allowed.indexOf(newState) === -1) {
      console.warn(`[BotEngine][SM] REJECTED transition ${oldState} → ${newState}` + (reason ? ` (${reason})` : ''));
      return false;
    }

    this._botState = newState;

    // Sync backward-compatible flags
    this._running = newState !== BOT_STATES.STOPPED && newState !== BOT_STATES.EMERGENCY;
    this._paused = newState === BOT_STATES.PAUSED;
    // FIX-P1: Preserve _emergencyStopped when transitioning EMERGENCY → STOPPED.
    // Previously, emergencyStop() called stop() which set _emergencyStopped=false,
    // making the emergency invisible to popup getStatus() within ~0ms.
    if (newState === BOT_STATES.EMERGENCY) {
      this._emergencyStopped = true;
    } else if (!(newState === BOT_STATES.STOPPED && oldState === BOT_STATES.EMERGENCY)) {
      this._emergencyStopped = false;
    }

    console.log(`[BotEngine][SM] ${oldState} → ${newState}` + (reason ? ` (${reason})` : ''));
    return true;
  }

  // FIX 5: Read-only property accessors — derived from state machine.
  // Previously, these were writable setters that could mutate _botState directly,
  // bypassing _transition() validation. Any external code doing `engine.running = false`
  // would silently corrupt the FSM (skip EMERGENCY → STOPPED, lose audit trail).
  // Now: getters derive from FSM state, setters warn + redirect through proper methods.
  get running() { return this._running; }
  set running(v) {
    console.warn('[BotEngine][SM] Direct set of .running is deprecated — use start()/stop() instead');
    if (!v && this._botState !== BOT_STATES.STOPPED && this._botState !== BOT_STATES.EMERGENCY) {
      this._transition(BOT_STATES.STOPPED, 'legacy .running=false');
    }
  }

  get paused() { return this._paused; }
  set paused(v) {
    console.warn('[BotEngine][SM] Direct set of .paused is deprecated — use pause()/resume() instead');
    if (v) {
      this._transition(BOT_STATES.PAUSED, 'legacy .paused=true');
    } else if (this._botState === BOT_STATES.PAUSED) {
      this._transition(BOT_STATES.IDLE, 'legacy .paused=false');
    }
  }

  get emergencyStopped() { return this._emergencyStopped; }
  set emergencyStopped(v) {
    console.warn('[BotEngine][SM] Direct set of .emergencyStopped is deprecated — use emergencyStop() instead');
    if (v) {
      this._transition(BOT_STATES.EMERGENCY, 'legacy .emergencyStopped=true');
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the bot engine.
   * Loads config, starts the scheduler, sets up the main loop and heartbeat alarm.
   *
   * @param {number} tabId - The Chrome tab ID running the Travian content script
   */
  async start(tabId) {
    // FIX-P1: Allow restart after emergency stop by clearing emergency state first
    if (this._emergencyStopped && this._botState === BOT_STATES.STOPPED) {
      this.clearEmergency();
    }

    if (this._botState !== BOT_STATES.STOPPED) {
      console.warn('[BotEngine] Cannot start — current state: ' + this._botState);
      return;
    }

    this.activeTabId = tabId;

    // Load configuration from storage
    await this.loadConfig();

    if (!this.config) {
      console.error('[BotEngine] Failed to load config, cannot start');
      return;
    }

    this._transition(BOT_STATES.IDLE, 'started');
    this.stats.startTime = Date.now();
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();

    // FIX 2: Restore persistent state (lastFarmTime, task queue, stats) from chrome.storage.
    // The service worker can be killed at any time. Without this, all pending tasks,
    // farm timing, and action counters are lost on restart — causing the bot to
    // re-evaluate everything from scratch and miss scheduled tasks.
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && typeof self.TravianStorage !== 'undefined') {
        const savedState = this.serverKey
          ? await self.TravianStorage.getServerState(this.serverKey)
          : null;
        if (savedState) {
          this._lastFarmTime = savedState.lastFarmTime || 0;
          console.log('[BotEngine] Restored lastFarmTime: ' + this._lastFarmTime);

          // Restore task queue: re-add pending tasks that survived the worker death
          if (savedState.taskQueue && Array.isArray(savedState.taskQueue) && savedState.taskQueue.length > 0) {
            let restoredCount = 0;
            for (const task of savedState.taskQueue) {
              // Only restore tasks that were pending or running (running gets reset to pending)
              if (task.status === 'pending' || task.status === 'running') {
                this.taskQueue.add(
                  task.type,
                  task.params || {},
                  task.priority || 5,
                  task.villageId || null,
                  task.scheduledFor || null
                );
                restoredCount++;
              }
            }
            if (restoredCount > 0) {
              console.log('[BotEngine] Restored ' + restoredCount + ' pending tasks from saved state');
            }
          }

          // Restore action counter to maintain rate limiting across restarts
          if (savedState.actionsThisHour != null && savedState.hourResetTime) {
            const elapsed = Date.now() - savedState.hourResetTime;
            if (elapsed < 3600000) { // less than 1 hour ago
              this.actionsThisHour = savedState.actionsThisHour;
              this.hourResetTime = savedState.hourResetTime;
              console.log('[BotEngine] Restored rate limit: ' + this.actionsThisHour + ' actions this hour');
            }
          }
        }
      }
    } catch (err) {
      console.warn('[BotEngine] Could not restore saved state:', err);
    }

    // Start the scheduler
    this.scheduler.start();

    // Schedule the hourly rate-limit counter reset
    this.scheduler.scheduleCycle('hourly_reset', () => {
      this.resetHourlyCounter();
    }, 3600000, 0); // Exactly every hour

    // Periodic state persistence: save state every 60s as a safety net.
    // If the service worker is killed, at most 1 minute of state is lost.
    // FIX-P5: Also flushes immediately when taskQueue reports dirty mutations.
    this.scheduler.scheduleCycle('state_persistence', () => {
      this.saveState().then(() => {
        // Mark task queue clean after successful persistence
        if (this.taskQueue && this.taskQueue.dirtyAt > 0) {
          this.taskQueue.markClean();
        }
      });
    }, 60000, 5000); // 60s base, +/-5s jitter

    // Schedule the main decision/execution loop
    const loopInterval = this._getLoopInterval();
    this.scheduler.scheduleCycle('main_loop', () => {
      this.mainLoop();
    }, loopInterval, Math.floor(loopInterval * 0.2)); // 20% jitter

    // Set up a chrome.alarms heartbeat as a fallback
    // Service workers can go to sleep; alarms wake them back up
    try {
      if (typeof chrome !== 'undefined' && chrome.alarms) {
        var alarmName = this.serverKey ? 'botHeartbeat__' + this.serverKey : 'botHeartbeat';
        chrome.alarms.create(alarmName, { periodInMinutes: 1 });
      }
    } catch (err) {
      console.warn('[BotEngine] Could not create chrome.alarms heartbeat:', err);
    }

    console.log('[BotEngine] Started for tab ' + tabId + (this.serverKey ? ' (server: ' + this.serverKey + ')' : ''));

    // Run the first loop immediately
    this.mainLoop();
  }

  /**
   * Stop the bot engine. Saves state and clears all timers.
   */
  stop() {
    this._transition(BOT_STATES.STOPPED, 'stopped');

    // Stop scheduler (clears all timers and cycles)
    this.scheduler.stop();

    // Clear heartbeat alarm
    try {
      if (typeof chrome !== 'undefined' && chrome.alarms) {
        var alarmName = this.serverKey ? 'botHeartbeat__' + this.serverKey : 'botHeartbeat';
        chrome.alarms.clear(alarmName);
      }
    } catch (err) {
      // Ignore
    }

    // Save state before fully stopping
    this.saveState();

    // ST-5 FIX: Flush logs immediately on stop to prevent loss on SW death.
    // The 30s setInterval flush may never fire if the SW is killed soon after.
    if (typeof self.TravianLogger !== 'undefined' && typeof self.TravianLogger.flush === 'function') {
      self.TravianLogger.flush();
    }

    console.log('[BotEngine] Stopped');
  }

  /**
   * Pause the bot. The main loop keeps running but skips actions.
   */
  pause() {
    if (!this.running) return;
    this._transition(BOT_STATES.PAUSED, 'user paused');
  }

  /**
   * Resume the bot from a paused state.
   */
  resume() {
    if (!this.running) return;
    this._transition(BOT_STATES.IDLE, 'user resumed');
  }

  /**
   * Heartbeat — called by chrome.alarms every ~1 minute.
   * Detects if the scheduler's main_loop cycle died (service worker sleep)
   * and resurrects it. Also triggers a mainLoop() as safety fallback.
   */
  async heartbeat() {
    if (!this.running || this.emergencyStopped) return;

    // Check if the main_loop cycle still exists in the scheduler
    if (!this.scheduler.isScheduled('main_loop')) {
      console.warn('[BotEngine] Heartbeat: main_loop cycle is DEAD — resurrecting');

      // Ensure scheduler is running (it may have been stopped by worker death)
      if (!this.scheduler.running) {
        this.scheduler.start();
      }

      // Recreate the main_loop cycle
      const loopInterval = this._getLoopInterval();
      this.scheduler.scheduleCycle('main_loop', () => {
        this.mainLoop();
      }, loopInterval, Math.floor(loopInterval * 0.2));

      // Also resurrect hourly_reset if missing
      if (!this.scheduler.isScheduled('hourly_reset')) {
        this.scheduler.scheduleCycle('hourly_reset', () => {
          this.resetHourlyCounter();
        }, 3600000, 0);
      }
    }

    // Safety fallback: trigger an immediate mainLoop cycle
    // (the mutex guard in mainLoop prevents double-execution)
    try {
      await this.mainLoop();
    } catch (err) {
      console.error('[BotEngine] Heartbeat mainLoop error:', err);
    }
  }

  /**
   * Emergency stop. Immediately halts all activity and records the reason.
   * @param {string} reason - Why the emergency stop was triggered
   */
  emergencyStop(reason) {
    console.error(`[BotEngine] EMERGENCY STOP: ${reason}`);

    // ST-5 FIX: Flush logs BEFORE stopping — emergency stop may precede SW death
    if (typeof self.TravianLogger !== 'undefined' && typeof self.TravianLogger.flush === 'function') {
      self.TravianLogger.flush();
    }

    this._emergencyReason = reason; // SAF-5 FIX: store for getStatus()
    this._transition(BOT_STATES.EMERGENCY, reason);
    this.stop(); // EMERGENCY → STOPPED

    // Persist the emergency stop reason
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({
          'bot_emergency_stop': {
            reason: reason,
            timestamp: Date.now()
          }
        });
      }
    } catch (err) {
      console.error('[BotEngine] Failed to persist emergency stop:', err);
    }

    // Attempt to notify the user via the content script
    this.sendToContentScript({
      action: 'NOTIFY',
      data: {
        type: 'emergency',
        message: `Bot emergency stop: ${reason}`
      }
    }).catch(() => {});
  }

  /**
   * FIX-P1: Clear the emergency stop state so the bot can be restarted.
   * Called when user clicks "Start" after an emergency stop.
   */
  clearEmergency() {
    if (!this._emergencyStopped) return;
    this._emergencyStopped = false;
    this._emergencyReason = null;
    this._consecutiveFailures = 0;
    this._circuitBreakerTrips = 0;
    this._notLoggedInCount = 0;
    console.log('[BotEngine] Emergency state cleared — ready to restart');
  }

  // ---------------------------------------------------------------------------
  // Main Loop
  // ---------------------------------------------------------------------------

  /**
   * The core main loop. Runs on each scheduler cycle.
   *
   * Steps:
   *  1. Check if running and not paused
   *  2. Check rate limits
   *  3. Request game state scan from content script
   *  4. Check for captcha/errors -> emergency stop
   *  5. Run decision engine to generate new tasks
   *  6. Get next task from queue
   *  7. Execute the task
   *  8. Adjust loop interval based on activity
   */
  async mainLoop() {
    // 1. Check running state
    if (!this.running || this.paused || this.emergencyStopped) {
      return;
    }

    // FIX-P3: Unified lock check — replaces separate _mainLoopRunning + _executionLocked guards
    if (this._cycleLock) {
      console.log('[BotEngine] Cycle locked (' + this._cycleLock + '), skipping concurrent call');
      return;
    }

    this._cycleLock = 'scanning';

    // FIX 8: Cycle tracking for structured logging
    this._cycleCounter++;
    this._currentCycleId = 'c' + this._cycleCounter;
    const _cycleStart = Date.now();

    try {
      // State: SCANNING
      this._transition(BOT_STATES.SCANNING, 'cycle ' + this._currentCycleId);

      // 2. Check rate limits
      if (!this.checkRateLimit()) {
        console.log('[BotEngine] Rate limit reached, skipping this cycle');
        return;
      }

      // 3. Scan game state via content script
      const scanResponse = await this.sendToContentScript({
        type: 'SCAN'
      });

      if (!scanResponse || !scanResponse.success) {
        // SAF-4 FIX: On scan failure, try a lightweight captcha check before
        // falling into circuit breaker. Captcha overlay may block normal scan
        // but the captcha elements themselves are still queryable.
        try {
          var captchaCheck = await this.sendToContentScript({
            type: 'SCAN', params: { property: 'captcha' }
          }).catch(() => null);
          if (captchaCheck && captchaCheck.success && captchaCheck.data === true) {
            this.emergencyStop('Captcha detected (scan failed but captcha confirmed)');
            return;
          }
        } catch (_) { /* lightweight check failed too — fall through to circuit breaker */ }

        // FIX 4: Count scan failures in circuit breaker.
        this._consecutiveFailures++;
        this._slog('WARN', 'Failed to get game state scan (failures: ' + this._consecutiveFailures + '/' + this._circuitBreakerThreshold + ')', { duration_ms: Date.now() - _cycleStart });
        return;
      }

      // FIX: Scan success no longer resets the circuit breaker.
      // Previously this masked all task failures because scans almost always succeed.
      // The counter now only resets on TASK success (line in executeTask).
      // Scan failures still increment it (above), so a dead content script still triggers the breaker.

      this.gameState = scanResponse.data;

      // FIX-P4: Detect game version changes that may break DOM selectors
      if (this.gameState.gameVersion) {
        if (!this._knownGameVersion) {
          this._knownGameVersion = this.gameState.gameVersion;
          this._slog('INFO', 'Travian version detected: ' + this._knownGameVersion);
        } else if (this._knownGameVersion !== this.gameState.gameVersion) {
          this._slog('WARN', 'Travian version CHANGED: ' + this._knownGameVersion + ' → ' + this.gameState.gameVersion + ' — DOM selectors may break');
          this._knownGameVersion = this.gameState.gameVersion;
        }
      }

      // ── Dorf2 buildings scan (cached, refreshed every N cycles) ──
      // getBuildings() only returns data on dorf2 pages. Since the bot rests
      // on dorf1, buildings[] is always empty unless we navigate to dorf2.
      // We do this periodically (every _buildingsScanInterval cycles) and
      // cache the result so the decision engine can create upgrade_building tasks.
      var needBuildingScan = (this.config.autoUpgradeBuildings || this.config.autoBuildingUpgrade) &&
        (!this._cachedBuildings || (this._cycleCounter - this._buildingsScanCycle) >= this._buildingsScanInterval);

      if (needBuildingScan) {
        try {
          this._slog('DEBUG', 'Scanning dorf2 for buildings data');
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          var dorf2Scan = await this.sendToContentScript({ type: 'SCAN' });
          if (dorf2Scan && dorf2Scan.success && dorf2Scan.data && dorf2Scan.data.buildings && dorf2Scan.data.buildings.length > 0) {
            this._cachedBuildings = dorf2Scan.data.buildings;
            this._buildingsScanCycle = this._cycleCounter;
            this._slog('INFO', 'Cached ' + this._cachedBuildings.length + ' buildings from dorf2');
            // Also update construction queue from dorf2 (more accurate)
            if (dorf2Scan.data.constructionQueue) {
              this.gameState.constructionQueue = dorf2Scan.data.constructionQueue;
            }
          }
          // Navigate back to dorf1
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._waitForContentScript(10000);
        } catch (e) {
          this._slog('WARN', 'Dorf2 buildings scan failed: ' + e.message);
        }
      }

      // Merge cached buildings into gameState if current scan didn't get them
      if (this._cachedBuildings && (!this.gameState.buildings || this.gameState.buildings.length === 0)) {
        this.gameState.buildings = this._cachedBuildings;
      }

      // State: DECIDING (scan complete)
      this._cycleLock = 'deciding';
      this._transition(BOT_STATES.DECIDING, 'scan complete');

      // Enrich gameState with cached extras
      this.gameState = this.stateCollector.enrichGameState(this.gameState);

      // Inject persistent lastFarmTime so DecisionEngine sees it
      this.gameState.lastFarmTime = this._lastFarmTime || 0;

      // 4. Safety checks - captcha / errors
      if (this.gameState.captcha) {
        this.emergencyStop('Captcha detected on page');
        return;
      }

      if (this.gameState.error) {
        // Log details before stopping — helps debug false positives
        var errorDetail = typeof this.gameState.error === 'string'
          ? this.gameState.error : 'isErrorPage=true';
        TravianLogger.log('ERROR', '[BotEngine] Error page detected: ' + errorDetail +
          ' | page=' + (this.gameState.page || 'unknown') +
          ' | url=' + (this.gameState.url || 'unknown'));
        this.emergencyStop('Game error detected: ' + errorDetail);
        return;
      }

      if (!this.gameState.loggedIn) {
        // SAF-1 FIX: Escalating not-logged-in detection.
        // Old code just returned silently — session expiry created an infinite
        // skip loop where bot appeared running but did nothing.
        this._notLoggedInCount++;
        this._slog('WARN', 'Not logged in (count: ' + this._notLoggedInCount + '/' + this._notLoggedInMaxCount + ')');
        if (this._notLoggedInCount >= this._notLoggedInMaxCount) {
          this.emergencyStop('Session expired — not logged in for ' + this._notLoggedInCount + ' consecutive cycles');
        }
        return;
      }
      // Reset counter on successful login
      this._notLoggedInCount = 0;

      // 5. Run decision engine to produce new tasks
      const newTasks = this.decisionEngine.evaluate(
        this.gameState,
        this.config,
        this.taskQueue
      );

      // Check if decision engine flagged an emergency
      for (const task of newTasks) {
        if (task.type === 'emergency_stop') {
          this.emergencyStop(task.params.reason);
          return;
        }
      }

      // Add new tasks to the queue
      for (const task of newTasks) {
        this.taskQueue.add(
          task.type,
          task.params,
          task.priority,
          task.villageId,
          task.scheduledFor || null
        );
      }

      // 5b. Proactive hero resource claim: if resources are critically low
      //     and hero is home with resource items, claim before executing upgrades
      if (this._shouldProactivelyClaimHero()) {
        TravianLogger.log('INFO', '[BotEngine] Resources critically low — attempting proactive hero claim');
        const claimed = await this._proactiveHeroClaim();
        if (claimed) {
          this._heroClaimCooldown = Date.now() + 300000; // 5 min cooldown
          return; // skip this cycle, let resources update
        }
        // Even if failed, set cooldown so we don't spam attempts
        this._heroClaimCooldown = Date.now() + 120000; // 2 min cooldown on failure
      }

      // 6. Circuit breaker check — pause if too many consecutive failures
      // SAF-3 FIX: Exponential backoff + max trips → emergency stop
      if (this._consecutiveFailures >= this._circuitBreakerThreshold) {
        this._circuitBreakerTrips++;
        this._consecutiveFailures = 0; // reset so resume doesn't immediately re-trip

        // After max trips → emergency stop (don't keep oscillating)
        if (this._circuitBreakerTrips >= this._circuitBreakerMaxTrips) {
          this.emergencyStop(
            'Circuit breaker: ' + this._circuitBreakerTrips + ' trips — persistent failures, stopping bot'
          );
          return;
        }

        // Exponential backoff: 5min → 10min → 20min
        var cooldownMs = this._circuitBreakerCooldownMs * Math.pow(2, this._circuitBreakerTrips - 1);
        this._slog('ERROR', 'Circuit breaker TRIPPED (trip ' + this._circuitBreakerTrips + '/' + this._circuitBreakerMaxTrips + '). Pausing for ' + (cooldownMs / 1000) + 's');
        this._transition(BOT_STATES.PAUSED, 'circuit breaker trip ' + this._circuitBreakerTrips);

        // Schedule auto-resume after cooldown
        this.scheduler.scheduleOnce('circuit_breaker_resume', () => {
          if (this.running && this.paused) {
            this._slog('INFO', 'Circuit breaker cooldown expired — auto-resuming (trip ' + this._circuitBreakerTrips + ')');
            this._transition(BOT_STATES.IDLE, 'circuit breaker cooldown');
          }
        }, cooldownMs);
        return;
      }

      // 7. Get next task from queue
      const nextTask = this.taskQueue.getNext();
      if (!nextTask) {
        // No tasks ready - adjust to idle interval
        this._adjustLoopInterval('idle');
        return;
      }

      // 8. Execute the task
      await this.executeTask(nextTask);

      // Adjust loop interval back to active pace
      this._adjustLoopInterval('active');

    } catch (err) {
      console.error('[BotEngine] Error in main loop:', err);
    } finally {
      // Return to IDLE if still in an active processing state
      const s = this._botState;
      if (s === BOT_STATES.SCANNING || s === BOT_STATES.DECIDING || s === BOT_STATES.COOLDOWN) {
        this._transition(BOT_STATES.IDLE, 'cycle end');
      }
      this._cycleLock = null; // FIX-P3: Release unified cycle lock
      this._currentCycleId = null;

      // ST-5/PERF-4 FIX: Flush logs after each cycle to minimize loss on SW death.
      // This replaces sole reliance on the 30s setInterval which doesn't keep SW alive.
      if (typeof self.TravianLogger !== 'undefined' && typeof self.TravianLogger.flush === 'function') {
        self.TravianLogger.flush();
      }

      // FIX-P5: Eager state flush when task queue has pending mutations.
      // Don't wait for the 60s persistence cycle — save immediately.
      if (this.taskQueue && this.taskQueue.dirtyAt > 0) {
        this.saveState().then(() => {
          this.taskQueue.markClean();
        }).catch(() => {});
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Task Execution
  // ---------------------------------------------------------------------------

  /**
   * Execute a single task by dispatching commands to the content script.
   *
   * @param {object} task - The task object from the queue
   */
  async executeTask(task) {
    this._slog('INFO', 'Executing task: ' + task.type, { taskId: task.id, taskPriority: task.priority });

    // FIX-P3: Set unified lock to 'executing' phase
    this._cycleLock = 'executing';
    this._transition(BOT_STATES.EXECUTING, task.type + ':' + task.id);
    const _taskStart = Date.now();

    try {
      // SAF-8 FIX: Lightweight liveness check before multi-step execution.
      // Uses GET_STATE with property:'page' (just reads URL) to confirm
      // the content script is alive. Fails fast instead of failing mid-task.
      try {
        var liveness = await this.sendToContentScript({
          type: 'GET_STATE', params: { property: 'page' }
        });
        if (!liveness || !liveness.success) {
          this._slog('WARN', 'Content script liveness check failed — will retry task', { taskId: task.id });
          this.taskQueue.markFailed(task.id, 'Content script not responsive (liveness)');
          return;
        }
      } catch (liveErr) {
        this._slog('WARN', 'Content script unreachable before execution — will retry task', {
          taskId: task.id, error: liveErr.message
        });
        this.taskQueue.markFailed(task.id, 'Content script unreachable: ' + (liveErr.message || 'unknown'));
        return;
      }

      // TQ-3 FIX: Refresh activeVillageId before village mismatch check.
      // User may have manually switched villages in-game since the last scan.
      // A quick GET_STATE villages call is much cheaper than a full SCAN.
      if (task.villageId && this.gameState) {
        try {
          var villageCheck = await this.sendToContentScript({
            type: 'GET_STATE', params: { property: 'villages' }
          });
          if (villageCheck && villageCheck.success && villageCheck.data) {
            var vList = villageCheck.data;
            for (var vi = 0; vi < vList.length; vi++) {
              if (vList[vi].active) {
                this.gameState.activeVillageId = vList[vi].id;
                break;
              }
            }
          }
        } catch (_) { /* non-critical — fall through to stale check */ }
      }

      // FIX 9: Village context assertion — ensure correct village before executing
      if (task.villageId && this.gameState && this.gameState.activeVillageId &&
          task.villageId !== this.gameState.activeVillageId) {
        this._slog('WARN', 'Village mismatch — auto-switching', {
          taskId: task.id, taskVillage: task.villageId,
          currentVillage: this.gameState.activeVillageId
        });
        await this.sendToContentScript({
          type: 'EXECUTE', action: 'switchVillage',
          params: { villageId: task.villageId }
        });
        await this._randomDelay();
        await this._waitForContentScript(15000);
      }

      let response;

      // All tasks are sent as EXECUTE messages to the content script's message handler
      switch (task.type) {
        case 'upgrade_resource':
          // Step 1: Navigate to dorf1 (resource view)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._randomDelay();
          // Wait for page reload and new content script injection
          await this._waitForContentScript(15000);
          // FIX 9: Verify navigation to dorf1
          if (!await this._verifyNavigation('resources')) {
            response = { success: false, reason: 'page_mismatch', message: 'Not on dorf1 after navigation' };
            break;
          }
          // Step 2: Click the resource field (navigates to /build.php?id=XX)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickResourceField', params: { fieldId: task.params.fieldId }
          });
          await this._randomDelay();
          // Step 2b: Wait for content script re-injection after page navigation
          await this._waitForContentScript(15000);
          // Step 3: Click upgrade button
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'upgrade_building':
          // Step 1: Navigate to dorf2 (village view)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          // Wait for page reload and new content script injection
          await this._waitForContentScript(15000);
          // FIX 9: Verify navigation to dorf2
          if (!await this._verifyNavigation('village')) {
            response = { success: false, reason: 'page_mismatch', message: 'Not on dorf2 after navigation' };
            break;
          }
          // Step 2: Click the building slot (navigates to /build.php?id=XX)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          await this._randomDelay();
          // Step 2b: Wait for content script re-injection after page navigation
          await this._waitForContentScript(15000);
          // Step 3: Click upgrade button (green = affordable, no button = can't afford)
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
          });
          break;

        case 'train_troops':
          // Navigate to the barracks/stable page and train
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: task.params.buildingType || 'barracks' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'trainTroops', params: {
              troopType: task.params.troopType,
              count: task.params.count
            }
          });
          break;

        case 'send_farm':
          // Step 1: Navigate to rally point
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          // Step 2: Click the farm list tab (tt=99) - causes page reload
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickFarmListTab', params: {}
          });
          await this._randomDelay();
          // Wait for content script to re-inject after page reload
          await this._waitForContentScript(15000);
          // Step 3: Send farm lists (smart selective or legacy send-all)
          var farmCfg = this.config && this.config.farmConfig;
          var smartFarming = farmCfg && farmCfg.smartFarming !== false; // default ON when field missing
          if (smartFarming) {
            // Smart farming: only send to profitable targets
            var minLoot = (this.config.farmConfig && this.config.farmConfig.minLoot) || 30;
            var skipLosses = this.config.farmConfig.skipLosses !== false;
            TravianLogger.log('INFO', '[BotEngine] Smart farming: minLoot=' + minLoot + ' skipLosses=' + skipLosses);
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'selectiveFarmSend', params: {
                minLoot: minLoot,
                skipLosses: skipLosses
              }
            });
            if (response && response.sent != null) {
              TravianLogger.log('INFO', '[BotEngine] Smart farm result: sent=' + response.sent + ' skipped=' + response.skipped + ' total=' + response.total);
            }
          } else if (task.params.farmListId != null) {
            // Send a specific farm list
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendFarmList', params: {
                farmListId: task.params.farmListId
              }
            });
          } else {
            // Legacy: Send all farm lists on the page
            response = await this.sendToContentScript({
              type: 'EXECUTE', action: 'sendAllFarmLists', params: {}
            });
          }
          // Update last farm time (persistent, not on gameState which gets overwritten)
          this._lastFarmTime = Date.now();
          this.stats.farmRaidsSent++;
          break;

        case 'build_traps':
          // Step 1: Find trapper building slot from gameState (gid=36, slot != 40 which is wall)
          var trapperSlot = null;
          if (this.gameState && this.gameState.buildings) {
            var trapperBld = this.gameState.buildings.find(function(b) {
              return (b.id === 36 || b.gid === 36) && b.slot !== 40;
            });
            if (trapperBld) trapperSlot = trapperBld.slot;
          }
          if (!trapperSlot) {
            response = { success: false, reason: 'building_not_available', message: 'Trapper building not found' };
            break;
          }
          // Step 2: Navigate to dorf2
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          // Step 3: Click the trapper building slot (navigates to /build.php?id=XX)
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: trapperSlot }
          });
          await this._randomDelay();
          // Step 4: Wait for content script re-injection after page navigation
          await this._waitForContentScript(15000);
          // Step 5: Train traps
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'trainTraps', params: { count: task.params.count || 10 }
          });
          break;

        case 'send_hero_adventure':
          // Navigate to hero adventures page and send hero
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroAdventures' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'sendHeroAdventure', params: {}
          });
          break;

        case 'claim_hero_resources':
          // Navigate to hero page and claim resource items
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'hero' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'useHeroItem', params: { itemIndex: task.params.itemIndex || 0 }
          });
          break;

        case 'build_new':
          // Navigate to empty slot in dorf2 and build a new building
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
          });
          await this._randomDelay();
          // Wait for page reload and new content script injection
          await this._waitForContentScript(15000);
          // FIX 9: Verify navigation to dorf2
          if (!await this._verifyNavigation('village')) {
            response = { success: false, reason: 'page_mismatch', message: 'Not on dorf2 after navigation for build_new' };
            break;
          }
          // Click the empty building slot to open build menu
          var slotClick = await this.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
          });
          if (!slotClick || slotClick === false || (slotClick && slotClick.success === false)) {
            response = { success: false, reason: 'button_not_found', message: 'Empty slot ' + task.params.slot + ' not found on dorf2' };
            break;
          }
          // Clicking empty slot navigates to build.php — wait for new page + content script
          await this._randomDelay();
          await this._waitForContentScript(15000);
          // Try to build in current tab first
          console.log('[BotEngine] build_new: trying GID ' + task.params.gid + ' in default tab');
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
          });
          // If slot is occupied or prerequisites not met, no point trying other tabs
          if (response && (response.reason === 'slot_occupied' || response.reason === 'prerequisites_not_met')) {
            console.log('[BotEngine] build_new: ' + response.reason + ' — skipping tab switching');
            break;
          }
          // If building not in current tab, try switching tabs (each click causes page reload)
          // Tab switching must happen at botEngine level because page reloads kill content script
          if (response && response.reason === 'building_not_in_tab') {
            console.log('[BotEngine] build_new: GID ' + task.params.gid + ' not in default tab, trying other tabs');
            for (var tabIdx = 0; tabIdx < 3; tabIdx++) {
              var tabClick = await this.sendToContentScript({
                type: 'EXECUTE', action: 'clickBuildTab', params: { tabIndex: tabIdx }
              });
              if (tabClick && tabClick.success) {
                // Tab was clicked — page reloads, wait for new content script
                await this._randomDelay();
                await this._waitForContentScript(15000);
              } else {
                // Tab already active or not found — still retry buildNewByGid
                // (the first attempt might have raced with page load)
                await this._randomDelay();
              }
              // Try buildNewByGid again
              response = await this.sendToContentScript({
                type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
              });
              console.log('[BotEngine] build_new: tab ' + tabIdx + ' result:', response && response.reason || (response && response.success ? 'OK' : 'fail'));
              if (!response || response.reason !== 'building_not_in_tab') break;
            }
          }
          break;

        case 'send_attack':
          // Navigate to rally point and send attack to coordinates
          await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
          });
          await this._randomDelay();
          await this._waitForContentScript(15000);
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'sendAttack', params: {
              target: task.params.target,
              troops: task.params.troops || {}
            }
          });
          // Update last farm time (persistent, not on gameState which gets overwritten)
          this._lastFarmTime = Date.now();
          break;

        case 'switch_village':
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'switchVillage', params: {
              villageId: task.params.targetVillageId
            }
          });
          break;

        case 'navigate':
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: 'navigateTo', params: {
              page: task.params.page
            }
          });
          break;

        default:
          response = await this.sendToContentScript({
            type: 'EXECUTE', action: task.type, params: task.params
          });
          break;
      }

      // Process response — with smart error handling
      if (response && response.success) {
        this.taskQueue.markCompleted(task.id);
        this.stats.tasksCompleted++;
        this.stats.lastAction = Date.now();
        this.actionsThisHour++;
        this._consecutiveFailures = 0; // Circuit breaker: reset on success
        this._circuitBreakerTrips = 0; // SAF-3 FIX: reset trip counter on success

        // Set per-slot cooldown to avoid spamming the same slot
        // Other slots of the same type remain available for upgrades
        const cooldownMs = this._getCooldownForType(task.type);
        this.decisionEngine.setCooldown(this._getCooldownKey(task), cooldownMs);

        this._slog('INFO', 'Task completed: ' + task.type, { taskId: task.id, duration_ms: Date.now() - _taskStart });
      } else {
        // FIX: actionExecutor returns {message:} not {error:} — read both
        const errorMsg = (response && (response.error || response.message)) || 'Unknown error from content script';
        const reason = (response && response.reason) || '';

        this._consecutiveFailures++; // Circuit breaker: increment on failure

        // Smart handling: some failures should NOT retry
        if (this._isHopelessFailure(reason, task.type)) {
          // Force permanent failure — don't waste 3 cycles retrying
          // FIX-P7: Set to maxRetries - 1 because markFailed() will increment once more.
          // This ensures final retries === maxRetries (not maxRetries + 1).
          task.retries = task.maxRetries - 1;
          this.taskQueue.markFailed(task.id, errorMsg);
          this.stats.tasksFailed++;

          // Set failure cooldown so decision engine doesn't recreate immediately.
          // FIX: queue_full and insufficient_resources affect ALL slots of the same type,
          // not just this slot — use type-level cooldown to prevent cycling through every slot.
          const failCooldown = this._getFailCooldownForReason(reason, task.type);
          if (reason === 'queue_full' || reason === 'insufficient_resources') {
            // Type-level cooldown: blocks ALL upgrade_resource or upgrade_building tasks
            this.decisionEngine.setCooldown(task.type, failCooldown);
          } else {
            // Per-slot cooldown: only blocks this specific slot
            this.decisionEngine.setCooldown(this._getCooldownKey(task), failCooldown);
          }

          this._slog('WARN', 'Task skipped (' + reason + '): ' + task.type, { taskId: task.id, reason, duration_ms: Date.now() - _taskStart });

          // Special: if insufficient resources, try claiming hero inventory
          if (reason === 'insufficient_resources' &&
              (task.type === 'upgrade_resource' || task.type === 'upgrade_building' || task.type === 'build_new')) {
            const claimed = await this._tryClaimHeroResources(task);
            if (claimed) {
              // Re-queue the same task so it retries after hero item was used
              this.taskQueue.add(task.type, task.params, task.priority, task.villageId);
              this.decisionEngine.setCooldown(this._getCooldownKey(task), 15000); // 15 sec retry
              TravianLogger.log('INFO', '[BotEngine] Re-queued ' + task.type + ' after hero resource claim');
            }
          }
        } else {
          // Normal retry logic
          this.taskQueue.markFailed(task.id, errorMsg);

          if (task.retries + 1 >= task.maxRetries) {
            this.stats.tasksFailed++;
            this._slog('ERROR', 'Task permanently failed: ' + task.type, { taskId: task.id, error: errorMsg, duration_ms: Date.now() - _taskStart });
          } else {
            this._slog('WARN', 'Task failed, will retry: ' + task.type, { taskId: task.id, error: errorMsg, retries: task.retries + 1 });
          }
        }
      }

    } catch (err) {
      const errorMsg = err.message || 'Exception during task execution';
      this.taskQueue.markFailed(task.id, errorMsg);
      this._consecutiveFailures++; // Circuit breaker: increment on exception

      if (task.retries + 1 >= task.maxRetries) {
        this.stats.tasksFailed++;
      }

      this._slog('ERROR', 'Exception executing task ' + task.type, { taskId: task.id, error: err.message, duration_ms: Date.now() - _taskStart });
    } finally {
      // Transition from EXECUTING state (but keep tab lock held — _returnHome needs it)
      if (this._botState === BOT_STATES.EXECUTING) {
        this._transition(BOT_STATES.COOLDOWN, 'task done');
      }
    }

    // Navigate back to dorf1 (resource overview) after every task
    // so the next scan gets fresh data and the page looks natural.
    // FIX-P3: _cycleLock='returning' keeps tab locked during navigation.
    try {
      this._cycleLock = 'returning';
      await this._returnHome(task.type);
    } finally {
      // _cycleLock is cleared in mainLoop's finally — NOT here.
      // This ensures the entire cycle (scan→decide→execute→return) is atomic.
    }
  }

  // ---------------------------------------------------------------------------
  // Content Script Communication
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the content script running in the active tab.
   * Wraps chrome.tabs.sendMessage with a timeout.
   *
   * @param {object} message - The message to send
   * @returns {Promise<object>} The response from the content script
   */
  async sendToContentScript(message) {
    if (!this.activeTabId) {
      throw new Error('No active tab ID set');
    }

    // TQ-6 FIX: Stamp EXECUTE messages with a unique requestId for dedup.
    // Content script tracks last seen requestId and ignores duplicates.
    if (message && message.type === 'EXECUTE') {
      this._requestIdCounter++;
      message._requestId = this._requestIdCounter;
    }

    // MP-1 FIX: Retry wrapper for transient "Receiving end does not exist" errors.
    // Content script may not be injected yet after page navigation.
    var maxRetries = 2;
    var lastErr = null;
    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this._sendMessageOnce(message);
      } catch (err) {
        lastErr = err;
        var isConnectionError = err.message && (
          err.message.indexOf('Receiving end does not exist') !== -1 ||
          err.message.indexOf('Could not establish connection') !== -1
        );
        if (!isConnectionError || attempt >= maxRetries) throw err;
        // Wait before retry — content script may be loading
        var retryDelay = 1000 * (attempt + 1); // 1s, 2s
        this._slog('WARN', 'Content script not ready, retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + retryDelay + 'ms');
        await new Promise(r => setTimeout(r, retryDelay));
      }
    }
    throw lastErr;
  }

  /**
   * Internal: send a single message to content script (no retry).
   * Separated from sendToContentScript to support MP-1 retry wrapper.
   */
  async _sendMessageOnce(message) {
    return new Promise((resolve, reject) => {
      // FIX 1: "settled" flag prevents ghost actions from the timeout/callback race.
      // When the timeout fires first, we reject — but chrome.tabs.sendMessage callback
      // can still arrive later. Without this flag, both resolve AND reject would fire,
      // or the late callback would trigger side-effects on an already-abandoned promise.
      let settled = false;

      const currentTimeout = this._messageTimeout;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        // Adaptive timeout: increase for next attempt (Chrome may be throttling)
        if (this._messageTimeout < this._messageTimeoutMax) {
          this._messageTimeout = Math.min(this._messageTimeout + this._messageTimeoutStep, this._messageTimeoutMax);
          console.log(`[BotEngine] Timeout → adaptive increase to ${this._messageTimeout}ms`);
        }
        reject(new Error(`Content script message timed out after ${currentTimeout}ms`));
      }, currentTimeout);

      try {
        chrome.tabs.sendMessage(this.activeTabId, message, (response) => {
          if (settled) {
            // Ghost callback — timeout already fired. Log and discard.
            console.warn('[BotEngine] Ghost callback after timeout for:', message.type || message.action);
            return;
          }
          settled = true;
          clearTimeout(timeoutId);

          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          // Adaptive timeout: reset to base after successful response
          if (this._messageTimeout > this._messageTimeoutBase) {
            this._messageTimeout = this._messageTimeoutBase;
          }

          resolve(response);
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(err);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Rate Limiting
  // ---------------------------------------------------------------------------

  /**
   * Check if the bot is within the rate limit for actions per hour.
   * @returns {boolean} True if within limits, false if rate limit reached
   */
  checkRateLimit() {
    const maxActions = (this.config && this.config.safetyConfig && this.config.safetyConfig.maxActionsPerHour) || 60;

    // Check if we need to reset the counter (hour has passed)
    if (Date.now() - this.hourResetTime >= 3600000) {
      this.resetHourlyCounter();
    }

    return this.actionsThisHour < maxActions;
  }

  /**
   * Reset the hourly action counter
   */
  resetHourlyCounter() {
    this.actionsThisHour = 0;
    this.hourResetTime = Date.now();
    console.log('[BotEngine] Hourly action counter reset');
  }

  // ---------------------------------------------------------------------------
  // Status & Persistence
  // ---------------------------------------------------------------------------

  /**
   * Get the full bot status for UI display
   * @returns {object} Status object
   */
  getStatus() {
    return {
      running: this.running,
      paused: this.paused,
      emergencyStopped: this.emergencyStopped,
      emergencyReason: this._emergencyReason, // SAF-5 FIX
      botState: this._botState,
      cycleId: this._currentCycleId,
      activeTabId: this.activeTabId,
      serverKey: this.serverKey,
      stats: { ...this.stats },
      actionsThisHour: this.actionsThisHour,
      taskQueue: {
        total: this.taskQueue.getAll().length,
        pending: this.taskQueue.size(),
        tasks: this.taskQueue.getAll()
      },
      scheduler: this.scheduler.getStatus(),
      gameState: this.gameState,
      config: this.config,
      nextActionTime: this.nextActionTime,
      lastAIAction: this.decisionEngine ? this.decisionEngine.lastAIAction : null,
      cooldowns: this.decisionEngine ? Object.fromEntries(this.decisionEngine.cooldowns) : {},
      currentPhase: this.decisionEngine ? this.decisionEngine.currentPhase : null,
      prereqResolutions: this.decisionEngine ? this.decisionEngine.lastPrereqResolutions : [],
      executionLocked: this._executionLocked,
      cycleLock: this._cycleLock,
      consecutiveFailures: this._consecutiveFailures
    };
  }

  /**
   * Load bot configuration from chrome.storage.local
   */
  async loadConfig() {
    try {
      // Per-server config when serverKey is set
      if (this.serverKey && typeof self.TravianStorage !== 'undefined' && self.TravianStorage.getServerConfig) {
        this.config = this._validateConfig(await self.TravianStorage.getServerConfig(this.serverKey));
        console.log('[BotEngine] Config loaded + validated for server: ' + this.serverKey);
        return;
      }

      // Fallback to legacy single-key config
      if (typeof chrome === 'undefined' || !chrome.storage) {
        console.warn('[BotEngine] chrome.storage not available, using default config');
        this.config = this._getDefaultConfig();
        return;
      }

      return new Promise((resolve) => {
        chrome.storage.local.get(['bot_config'], (result) => {
          if (chrome.runtime.lastError) {
            console.error('[BotEngine] Error loading config:', chrome.runtime.lastError.message);
            this.config = this._getDefaultConfig();
            resolve();
            return;
          }

          if (result.bot_config) {
            this.config = this._validateConfig(result.bot_config);
            console.log('[BotEngine] Config loaded + validated from storage');
          } else {
            this.config = this._getDefaultConfig();
            console.log('[BotEngine] No saved config found, using defaults');
          }
          resolve();
        });
      });
    } catch (err) {
      console.error('[BotEngine] Failed to load config:', err);
      this.config = this._getDefaultConfig();
    }
  }

  /**
   * Persist current bot state to chrome.storage.local
   */
  async saveState() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;

      const state = {
        stats: this.stats,
        taskQueue: this.taskQueue.getAll(),
        actionsThisHour: this.actionsThisHour,
        hourResetTime: this.hourResetTime,
        lastFarmTime: this._lastFarmTime || 0,
        wasRunning: this.running,
        savedAt: Date.now()
      };

      // Per-server state when serverKey is set
      if (this.serverKey && typeof self.TravianStorage !== 'undefined' && self.TravianStorage.saveServerState) {
        await self.TravianStorage.saveServerState(this.serverKey, state);
        console.log('[BotEngine] State saved for server: ' + this.serverKey);
        return;
      }

      // Fallback to legacy single key
      return new Promise((resolve) => {
        chrome.storage.local.set({ 'bot_state': state }, () => {
          if (chrome.runtime.lastError) {
            console.error('[BotEngine] Error saving state:', chrome.runtime.lastError.message);
          } else {
            console.log('[BotEngine] State saved');
          }
          resolve();
        });
      });
    } catch (err) {
      console.error('[BotEngine] Failed to save state:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Structured Logging (FIX 8)
  // ---------------------------------------------------------------------------

  /**
   * Structured log — enriches TravianLogger entries with correlation context.
   * @param {string} level - DEBUG/INFO/WARN/ERROR
   * @param {string} message - Human-readable message
   * @param {object} [meta] - Additional metadata (taskId, duration_ms, etc.)
   */
  _slog(level, message, meta) {
    const entry = {
      component: 'BotEngine',
      cycleId: this._currentCycleId,
      serverKey: this.serverKey,
      state: this._botState
    };
    if (meta) Object.assign(entry, meta);

    // Serialize meta into message string so logs don't show "[object Object]".
    // Chrome extension log viewers and the popup log panel stringify the data arg
    // as [object Object]. Appending key fields to the message ensures readability.
    var suffix = '';
    if (meta) {
      var parts = [];
      for (var k in meta) {
        if (meta.hasOwnProperty(k) && meta[k] != null) {
          parts.push(k + '=' + meta[k]);
        }
      }
      if (parts.length) suffix = ' {' + parts.join(', ') + '}';
    }
    TravianLogger.log(level, message + suffix, entry);
  }

  // ---------------------------------------------------------------------------
  // Page State Assertion (FIX 9)
  // ---------------------------------------------------------------------------

  /**
   * Verify the browser is on the expected page type after navigation.
   * Sends a lightweight SCAN and compares the page type.
   * @param {string} expectedPage - Expected value from domScanner.detectPage()
   * @returns {Promise<boolean>} true if on correct page
   */
  async _verifyNavigation(expectedPage) {
    try {
      const resp = await this.sendToContentScript({ type: 'SCAN' });
      if (!resp || !resp.success || !resp.data) return false;
      const actual = resp.data.page || 'unknown';
      if (actual === expectedPage) return true;
      this._slog('WARN', 'Page assertion failed: expected ' + expectedPage + ', got ' + actual, {
        expectedPage, actualPage: actual
      });
      return false;
    } catch (e) {
      this._slog('WARN', 'Page assertion error: ' + e.message);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get default bot configuration
   * @returns {object}
   */
  _getDefaultConfig() {
    return {
      // Feature toggles
      autoUpgradeResources: true,
      autoUpgradeBuildings: false,
      autoTrainTroops: false,
      autoFarm: false,

      // Resource upgrade settings
      resourceConfig: {
        maxLevel: 10
      },

      // Building upgrade settings
      buildingConfig: {
        maxLevel: 10,
        priorityList: ['granary', 'warehouse', 'barracks', 'marketplace']
      },

      // Troop training settings
      troopConfig: {
        defaultTroopType: 'infantry',
        trainCount: 5,
        trainingBuilding: 'barracks',
        minResourceThreshold: {
          wood: 500,
          clay: 500,
          iron: 500,
          crop: 300
        }
      },

      // Farming settings
      farmConfig: {
        intervalMs: 300000,  // 5 minutes
        minTroops: 10,
        useRallyPointFarmList: true,  // Use rally point farm lists (tt=99)
        targets: []                   // Legacy coordinate targets
      },

      // Safety settings
      safetyConfig: {
        maxActionsPerHour: 60
      },

      // Delay settings (milliseconds)
      delays: {
        minActionDelay: 2000,   // Minimum delay between actions
        maxActionDelay: 8000,   // Maximum delay between actions
        loopActiveMs: 45000,    // Loop interval when active (30-120s range with jitter)
        loopIdleMs: 180000      // Loop interval when idle (60-300s range with jitter)
      }
    };
  }

  /**
   * ST-2 FIX: Validate and sanitize loaded config against defaults.
   * Ensures numeric fields are numbers, booleans are booleans, and missing
   * fields get default values. Prevents NaN/undefined from corrupted storage.
   */
  _validateConfig(cfg) {
    var defaults = this._getDefaultConfig();
    if (!cfg || typeof cfg !== 'object') return defaults;

    // Type coercion helpers
    function ensureNum(val, fallback) {
      var n = Number(val);
      return (isNaN(n) || !isFinite(n)) ? fallback : n;
    }
    function ensureBool(val, fallback) {
      if (typeof val === 'boolean') return val;
      if (val === 'true') return true;
      if (val === 'false') return false;
      return fallback;
    }

    // Top-level booleans
    cfg.autoUpgradeResources = ensureBool(cfg.autoUpgradeResources || cfg.autoResourceUpgrade, defaults.autoUpgradeResources);
    cfg.autoUpgradeBuildings = ensureBool(cfg.autoUpgradeBuildings || cfg.autoBuildingUpgrade, defaults.autoUpgradeBuildings);
    cfg.autoTrainTroops = ensureBool(cfg.autoTrainTroops || cfg.autoTroopTraining, defaults.autoTrainTroops);
    cfg.autoFarm = ensureBool(cfg.autoFarm || cfg.autoFarming, defaults.autoFarm);
    cfg.autoHeroAdventure = ensureBool(cfg.autoHeroAdventure, false);
    cfg.useAIScoring = ensureBool(cfg.useAIScoring, true);
    cfg.autoTrapTraining = ensureBool(cfg.autoTrapTraining, false);

    // Safety config
    if (!cfg.safetyConfig || typeof cfg.safetyConfig !== 'object') cfg.safetyConfig = {};
    cfg.safetyConfig.maxActionsPerHour = ensureNum(cfg.safetyConfig.maxActionsPerHour, defaults.safetyConfig.maxActionsPerHour);

    // Delay settings
    if (!cfg.delays || typeof cfg.delays !== 'object') cfg.delays = {};
    cfg.delays.minActionDelay = ensureNum(cfg.delays.minActionDelay, defaults.delays.minActionDelay);
    cfg.delays.maxActionDelay = ensureNum(cfg.delays.maxActionDelay, defaults.delays.maxActionDelay);
    cfg.delays.loopActiveMs = ensureNum(cfg.delays.loopActiveMs, defaults.delays.loopActiveMs);
    cfg.delays.loopIdleMs = ensureNum(cfg.delays.loopIdleMs, defaults.delays.loopIdleMs);

    // Farm config
    if (!cfg.farmConfig || typeof cfg.farmConfig !== 'object') cfg.farmConfig = {};
    cfg.farmConfig.intervalMs = ensureNum(cfg.farmConfig.intervalMs, defaults.farmConfig.intervalMs);
    cfg.farmConfig.minTroops = ensureNum(cfg.farmConfig.minTroops, defaults.farmConfig.minTroops);
    if (!Array.isArray(cfg.farmConfig.targets)) cfg.farmConfig.targets = [];

    // Resource config
    if (!cfg.resourceConfig || typeof cfg.resourceConfig !== 'object') cfg.resourceConfig = {};
    cfg.resourceConfig.maxLevel = ensureNum(cfg.resourceConfig.maxLevel, defaults.resourceConfig.maxLevel);

    return cfg;
  }

  /**
   * Wait until the content script in the active tab is ready and responding.
   * Used after page-reload navigations (clicking links that cause full page load)
   * to avoid sending messages before the new content script has registered.
   *
   * Uses a direct chrome.tabs.sendMessage ping (bypasses sendToContentScript's
   * own retry layer which would eat the timeout budget with 3s inner retries).
   *
   * @param {number} maxWaitMs - Maximum time to wait (default 10000ms)
   * @returns {Promise<boolean>} true if content script responded, false if timed out
   */
  async _waitForContentScript(maxWaitMs) {
    maxWaitMs = maxWaitMs || 10000;
    var start = Date.now();
    var attempts = 0;
    var tabId = this.activeTabId;

    if (!tabId) {
      console.warn('[BotEngine] _waitForContentScript: no activeTabId');
      return false;
    }

    // First, check if the tab still exists and is loading/complete
    try {
      var tabInfo = await new Promise(function (resolve) {
        chrome.tabs.get(tabId, function (tab) {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(tab);
        });
      });
      if (!tabInfo) {
        console.warn('[BotEngine] _waitForContentScript: tab ' + tabId + ' no longer exists');
        return false;
      }
      if (tabInfo.status === 'loading') {
        // Tab is still loading — give extra time for document_idle content script injection
        console.log('[BotEngine] Tab is still loading, waiting for document_idle...');
      }
    } catch (e) {
      // Non-critical — proceed with polling
    }

    while (Date.now() - start < maxWaitMs) {
      attempts++;
      try {
        // Direct lightweight ping — bypass sendToContentScript's retry wrapper
        // to avoid wasting timeout budget on inner 1s+2s retries.
        var ping = await new Promise(function (resolve) {
          var timeoutId = setTimeout(function () {
            resolve(null);
          }, 1500); // 1.5s per ping attempt max

          try {
            chrome.tabs.sendMessage(tabId, {
              type: 'GET_STATE', params: { property: 'page' }
            }, function (response) {
              clearTimeout(timeoutId);
              if (chrome.runtime.lastError) {
                // "Receiving end does not exist" = content script not injected yet
                resolve(null);
              } else {
                resolve(response);
              }
            });
          } catch (e) {
            clearTimeout(timeoutId);
            resolve(null);
          }
        });

        if (ping && ping.success) {
          if (attempts > 1) {
            console.log('[BotEngine] Content script ready after ' + attempts + ' attempts (' + (Date.now() - start) + 'ms)');
          }
          return true;
        }
      } catch (e) {
        // Unexpected error — continue polling
      }

      // Short wait between attempts — more frequent polling = faster detection
      var elapsed = Date.now() - start;
      if (elapsed >= maxWaitMs) break;
      var waitMs = Math.min(800, maxWaitMs - elapsed);
      await new Promise(function (r) { setTimeout(r, waitMs); });
    }

    console.warn('[BotEngine] Content script not ready after ' + maxWaitMs + 'ms (' + attempts + ' attempts)');
    return false;
  }

  /**
   * Wait a random delay between configured min and max.
   * Simulates human-like pauses between actions.
   * @returns {Promise<void>}
   */
  _randomDelay() {
    const minDelay = (this.config && this.config.delays && this.config.delays.minActionDelay) || 2000;
    const maxDelay = (this.config && this.config.delays && this.config.delays.maxActionDelay) || 8000;

    // RND-5 FIX: Session fatigue simulation.
    // Real humans get slower over time. After 1 hour, delays increase by up to 50%.
    // Formula: fatigueFactor = 1 + min(0.5, sessionHours * 0.15)
    var fatigue = 1;
    if (this.stats && this.stats.startTime) {
      var sessionHours = (Date.now() - this.stats.startTime) / 3600000;
      fatigue = 1 + Math.min(0.5, sessionHours * 0.15);
    }
    var adjustedMin = Math.round(minDelay * fatigue);
    var adjustedMax = Math.round(maxDelay * fatigue);

    const delay = Math.floor(Math.random() * (adjustedMax - adjustedMin + 1)) + adjustedMin;

    return new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Get the appropriate cooldown duration for a task type.
   * Prevents the decision engine from re-creating the same task too quickly.
   *
   * @param {string} taskType
   * @returns {number} Cooldown in milliseconds
   */
  /**
   * Build a per-slot cooldown key for build-type tasks.
   * Returns 'type:slot' for build tasks (so only that slot is blocked),
   * or just 'type' for non-build tasks.
   * @param {object} task
   * @returns {string}
   */
  _getCooldownKey(task) {
    if (['upgrade_resource', 'upgrade_building', 'build_new'].includes(task.type)) {
      const slotKey = task.params.fieldId || task.params.slot || '';
      if (slotKey) return task.type + ':' + slotKey;
    }
    return task.type;
  }

  _getCooldownForType(taskType) {
    switch (taskType) {
      case 'upgrade_resource':
      case 'upgrade_building':
        return 60000;     // 1 minute cooldown after building/resource upgrade
      case 'train_troops':
        return 120000;    // 2 minutes cooldown after troop training
      case 'build_traps':
        return 120000;    // 2 minutes cooldown after trap building
      case 'send_farm':
      case 'send_attack':
        return 300000;    // 5 minutes cooldown after farm/attack send
      case 'send_hero_adventure':
        return 180000;    // 3 minutes cooldown after hero adventure
      default:
        return 30000;     // 30 seconds default cooldown
    }
  }

  /**
   * Get the main loop interval based on config.
   * @returns {number} Interval in milliseconds
   */
  _getLoopInterval() {
    return (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
  }

  /**
   * Navigate back to dorf1 (resource overview) after completing a task.
   * Skips if the task already ends on dorf1, or if task is just navigation.
   *
   * @param {string} taskType - The task type that just finished
   */
  async _returnHome(taskType) {
    // Tasks that already end on or near dorf1 — no need to navigate
    const skipTypes = ['upgrade_resource', 'navigate', 'switch_village'];
    if (skipTypes.indexOf(taskType) !== -1) {
      await this._randomDelay();
      return;
    }

    try {
      // For building tasks, detour through dorf2 to refresh cached buildings
      if (taskType === 'upgrade_building' || taskType === 'build_new') {
        await this._randomDelay();
        await this.sendToContentScript({
          type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
        });
        await this._waitForContentScript(10000);
        var dorf2Resp = await this.sendToContentScript({ type: 'SCAN' });
        if (dorf2Resp && dorf2Resp.success && dorf2Resp.data && dorf2Resp.data.buildings && dorf2Resp.data.buildings.length > 0) {
          this._cachedBuildings = dorf2Resp.data.buildings;
          this._buildingsScanCycle = this._cycleCounter;
        }
      }

      await this._randomDelay();
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
      });
      console.log('[BotEngine] Returned to dorf1');
    } catch (err) {
      // Non-critical — just log and continue
      console.warn('[BotEngine] Failed to return to dorf1:', err.message);
    }
  }

  /**
   * Check if a failure reason means retrying is hopeless.
   * @param {string} reason - Error reason code from content script
   * @returns {boolean}
   */
  _isHopelessFailure(reason, taskType) {
    const hopeless = [
      'no_adventure',       // No adventures available, won't change by retrying
      'hero_unavailable',   // Hero is away/dead
      'insufficient_resources', // Can't afford — retrying immediately won't help
      'queue_full',         // Build queue full — must wait for current build
      'building_not_available', // Building doesn't exist for this tribe/level
      'no_items',           // No hero items to use
      'page_mismatch',      // FIX 9: page assertion failed — navigation problem
      'slot_occupied',      // Slot already has building — can't build new
      'prerequisites_not_met', // Building prereqs unmet — DFS resolver should handle
      'input_not_found',    // Troop input missing — wrong building or troop unavailable
      'input_disabled'      // Troop input disabled — building level too low
    ];
    if (hopeless.indexOf(reason) !== -1) return true;

    // NOTE: build_new + button_not_found is NO LONGER hopeless.
    // Previously this was treated as permanent failure, but it can be:
    // - Transient page load / lazy rendering issue
    // - Tab switching race condition
    // Allow normal retries (3 attempts) before giving up.

    return false;
  }

  /**
   * Get a longer cooldown when a task fails for a known reason.
   * Prevents decision engine from recreating the same failing task.
   * @param {string} reason
   * @param {string} taskType
   * @returns {number} Cooldown in ms
   */
  _getFailCooldownForReason(reason, taskType) {
    switch (reason) {
      case 'no_adventure':
        return 600000;   // 10 min — adventures reset slowly
      case 'hero_unavailable':
        return 300000;   // 5 min — hero may return
      case 'insufficient_resources':
        return 180000;   // 3 min — wait for production
      case 'queue_full':
        return 120000;   // 2 min — wait for current build
      case 'building_not_available':
        return 300000;   // 5 min — might be timing issue, retry
      case 'page_mismatch':
        return 30000;    // 30 sec — navigation issue, retry soon
      case 'button_not_found':
        return 300000;   // 5 min — slot/building genuinely not found
      case 'slot_occupied':
        return 600000;   // 10 min — slot already built, decision engine will rescan
      case 'prerequisites_not_met':
        return 300000;   // 5 min — DFS resolver should create prereq tasks
      case 'input_not_found':
        return 300000;   // 5 min — troop type not on this page
      case 'input_disabled':
        return 300000;   // 5 min — building level too low
      default:
        return 60000;    // 1 min default
    }
  }

  /**
   * When an upgrade fails due to insufficient resources, try claiming
   * hero inventory resource items as a fallback.
   * @param {object} failedTask - The task that failed
   */
  async _tryClaimHeroResources(failedTask) {
    try {
      // Pre-check: hero must be at home (not on adventure or dead)
      const heroStatus = this.gameState?.hero;
      if (heroStatus && (heroStatus.isAway || heroStatus.isDead)) {
        TravianLogger.log('INFO', '[BotEngine] Hero not available for resource claim — skipping');
        return false;
      }

      TravianLogger.log('INFO', '[BotEngine] Attempting to claim hero inventory resources...');

      // Calculate deficit: what resources are we short of?
      // Must know the exact deficit BEFORE navigating — if we can't calculate it,
      // skip entirely to avoid the dialog default (fills warehouse to max capacity).
      const deficit = this._calcResourceDeficit(failedTask);
      if (!deficit) {
        TravianLogger.log('WARN', '[BotEngine] Cannot calculate resource deficit — skipping hero claim to avoid waste');
        return false;
      }
      TravianLogger.log('DEBUG', '[BotEngine] Resource deficit: ' + JSON.stringify(deficit));

      // Navigate directly to hero inventory (single step — old code did
      // hero → heroInventory which wasted ~15s on a redundant page reload).
      // navigateTo('heroInventory') tries a[href="/hero/inventory"] first (which
      // won't match because hero tabs have no href), then falls back to
      // window.location.href = '/hero/inventory' which works reliably.
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
      });
      await this._randomDelay();
      var invReady = await this._waitForContentScript(15000);
      if (!invReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory page did not load in time');
        return false;
      }

      // Scan inventory items (also detects UI version)
      const scanResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'scanHeroInventory', params: {}
      });

      if (!scanResult || !scanResult.success || !scanResult.data) {
        TravianLogger.log('WARN', '[BotEngine] No hero inventory data');
        return false;
      }

      // Robust data extraction: scanResult.data may contain items directly
      // or nested under scanResult.data.data (double-wrapped response)
      const rawData = scanResult.data || {};
      const items = rawData.items || (rawData.data && rawData.data.items) || [];
      const uiVersion = rawData.uiVersion || (rawData.data && rawData.data.uiVersion) || 'v1';

      if (items.length === 0) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory scan returned no items');
        return false;
      }

      const usableResources = items.filter(item => item.isResource && item.hasUseButton);

      if (usableResources.length === 0) {
        TravianLogger.log('INFO', '[BotEngine] No claimable resource items in hero inventory');
        return false;
      }

      // ── Route: V2 bulk transfer (post-Changelog-367) vs V1 one-at-a-time ──
      if (uiVersion === 'v2') {
        return await this._claimHeroResourcesV2(deficit, usableResources);
      }
      return await this._claimHeroResourcesV1(deficit, usableResources);

    } catch (err) {
      TravianLogger.log('WARN', '[BotEngine] Hero resource claim failed: ' + err.message);
      return false;
    }
  }

  /**
   * V1 hero resource claim: one resource at a time via per-item dialog.
   * (Pre-Changelog-367 legacy path)
   */
  async _claimHeroResourcesV1(deficit, usableResources) {
    const itemClassToRes = {
      item145: 'wood', item176: 'wood',
      item146: 'clay', item177: 'clay',
      item147: 'iron', item178: 'iron',
      item148: 'crop', item179: 'crop'
    };

    let claimed = false;
    for (const item of usableResources) {
      // Determine resource type from itemClass
      let resType = null;
      const cls = item.itemClass || '';
      for (const [pattern, type] of Object.entries(itemClassToRes)) {
        if (cls.indexOf(pattern) !== -1) { resType = type; break; }
      }
      if (!resType) continue;

      // Calculate exact amount needed for THIS resource type
      const needed = deficit[resType] || 0;
      if (needed <= 0) {
        TravianLogger.log('DEBUG', `[BotEngine] Skipping ${resType} — not short`);
        continue;
      }

      // Cap at available amount (don't try to transfer more than hero has)
      const available = parseInt(item.count) || 0;
      const transferAmount = Math.min(Math.ceil(needed), available);
      if (transferAmount <= 0) {
        TravianLogger.log('DEBUG', `[BotEngine] Skipping ${resType} — hero has none available`);
        continue;
      }

      TravianLogger.log('INFO', `[BotEngine] V1 claiming ${transferAmount} ${resType} from hero (deficit=${Math.ceil(needed)}, heroHas=${available})`);

      const useResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'useHeroItem',
        params: { itemIndex: item.index, amount: transferAmount }
      });

      if (useResult && useResult.success) {
        TravianLogger.log('INFO', `[BotEngine] ${resType} claimed (${transferAmount} resources)`);
        claimed = true;
      } else {
        TravianLogger.log('WARN', `[BotEngine] Failed to claim ${resType} from hero`);
      }

      await this._randomDelay();
    }

    if (claimed) {
      TravianLogger.log('INFO', '[BotEngine] V1 hero resource(s) claimed successfully');
    }
    return claimed;
  }

  /**
   * V2 hero resource claim: bulk transfer all resources in one action.
   * (Post-Changelog-367 — transfers all 4 resource types at once)
   */
  async _claimHeroResourcesV2(deficit, usableResources) {
    const itemClassToRes = {
      item145: 'wood', item176: 'wood',
      item146: 'clay', item177: 'clay',
      item147: 'iron', item178: 'iron',
      item148: 'crop', item179: 'crop'
    };

    // Build amounts map: for each resource type, min(deficit, available)
    const amounts = { wood: 0, clay: 0, iron: 0, crop: 0 };
    for (const item of usableResources) {
      let resType = null;
      const cls = item.itemClass || '';
      for (const [pattern, type] of Object.entries(itemClassToRes)) {
        if (cls.indexOf(pattern) !== -1) { resType = type; break; }
      }
      if (!resType) continue;

      const needed = deficit[resType] || 0;
      if (needed <= 0) continue;

      const available = parseInt(item.count) || 0;
      const transferAmount = Math.min(Math.ceil(needed), available);
      if (transferAmount <= 0) continue;

      // Accumulate (in case multiple items map to same resource type)
      amounts[resType] = Math.max(amounts[resType], transferAmount);
    }

    const totalTransfer = amounts.wood + amounts.clay + amounts.iron + amounts.crop;
    if (totalTransfer <= 0) {
      TravianLogger.log('INFO', '[BotEngine] V2: no resources to transfer');
      return false;
    }

    TravianLogger.log('INFO', `[BotEngine] V2 bulk transfer: ${JSON.stringify(amounts)}`);

    const bulkResult = await this.sendToContentScript({
      type: 'EXECUTE', action: 'useHeroItemBulk',
      params: { amounts: amounts }
    });

    if (bulkResult && bulkResult.success) {
      TravianLogger.log('INFO', '[BotEngine] V2 bulk hero resource claim successful');
      return true;
    } else {
      // V2 detected but bulk transfer failed — V1 won't work on the new UI either
      // (old .heroConsumablesPopup dialog no longer exists on V2 servers)
      const reason = (bulkResult && bulkResult.reason) || 'unknown';
      TravianLogger.log('WARN', '[BotEngine] V2 bulk transfer failed: ' + reason);
      return false;
    }
  }

  /**
   * Check if hero resources should be proactively claimed.
   * Triggers when any resource is below 5% of warehouse capacity,
   * hero is at home, and cooldown has elapsed.
   */
  _shouldProactivelyClaimHero() {
    // Cooldown check
    if (this._heroClaimCooldown && Date.now() < this._heroClaimCooldown) return false;

    // Hero must be home
    const hero = this.gameState && this.gameState.hero;
    if (hero && (hero.isAway || hero.isDead)) return false;

    const res = this.gameState && this.gameState.resources;
    const cap = this.gameState && this.gameState.resourceCapacity;
    if (!res || !cap) return false;

    const wCap = cap.warehouse || 0;
    const gCap = cap.granary || wCap;
    if (wCap === 0) return false;

    // Check if any resource is below 20% of capacity (raised from 5% —
    // at 5% of 7800 = 390, resources rarely drop that low, so the old
    // threshold almost never triggered proactive claiming).
    var threshold = 0.20;
    return (res.wood || 0) < wCap * threshold ||
           (res.clay || 0) < wCap * threshold ||
           (res.iron || 0) < wCap * threshold ||
           (res.crop || 0) < gCap * threshold;
  }

  /**
   * Proactively claim hero resources to fill low resource types.
   * Navigates to hero inventory, scans items, and transfers resources
   * for any type below 50% of warehouse capacity.
   * @returns {boolean} true if any resources were claimed
   */
  async _proactiveHeroClaim() {
    try {
      const res = this.gameState.resources;
      const cap = this.gameState.resourceCapacity;
      const wCap = cap.warehouse || 800;
      const gCap = cap.granary || wCap;
      const targetFill = 0.50; // fill to 50% of capacity (raised from 25%
      // so each proactive claim is substantial enough to fund upgrades)

      // Calculate how much of each resource we need to reach targetFill
      const deficit = {
        wood: Math.max(0, Math.floor(wCap * targetFill) - (res.wood || 0)),
        clay: Math.max(0, Math.floor(wCap * targetFill) - (res.clay || 0)),
        iron: Math.max(0, Math.floor(wCap * targetFill) - (res.iron || 0)),
        crop: Math.max(0, Math.floor(gCap * targetFill) - (res.crop || 0))
      };

      const totalDeficit = deficit.wood + deficit.clay + deficit.iron + deficit.crop;
      if (totalDeficit <= 0) return false;

      TravianLogger.log('DEBUG', '[BotEngine] Proactive hero claim deficit: ' + JSON.stringify(deficit));

      // Navigate directly to hero inventory (single step)
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
      });
      await this._randomDelay();
      var invReady = await this._waitForContentScript(15000);
      if (!invReady) {
        TravianLogger.log('WARN', '[BotEngine] Hero inventory did not load for proactive claim');
        return false;
      }

      // Scan inventory (also detects UI version)
      const scanResult = await this.sendToContentScript({
        type: 'EXECUTE', action: 'scanHeroInventory', params: {}
      });
      if (!scanResult || !scanResult.success || !scanResult.data) {
        TravianLogger.log('WARN', '[BotEngine] No hero inventory data for proactive claim');
        return false;
      }
      const rawData = scanResult.data || {};
      const items = rawData.items || (rawData.data && rawData.data.items) || [];
      const uiVersion = rawData.uiVersion || (rawData.data && rawData.data.uiVersion) || 'v1';
      const usableResources = items.filter(item => item.isResource && item.hasUseButton);
      if (usableResources.length === 0) {
        TravianLogger.log('INFO', '[BotEngine] No hero resource items for proactive claim');
        return false;
      }

      // Step 4: Route to V1 or V2 claim (shared with _tryClaimHeroResources)
      TravianLogger.log('INFO', `[BotEngine] Proactive claim using ${uiVersion} path`);
      if (uiVersion === 'v2') {
        return await this._claimHeroResourcesV2(deficit, usableResources);
      }
      return await this._claimHeroResourcesV1(deficit, usableResources);
    } catch (err) {
      TravianLogger.log('WARN', '[BotEngine] Proactive hero claim error: ' + err.message);
      return false;
    }
  }

  /**
   * Calculate how much of each resource we're short of for a failed task.
   * Uses TravianGameData to look up building costs and compares with current resources.
   * @param {object} task - The failed task
   * @returns {object|null} { wood, clay, iron, crop } deficit (positive = need more), or null if can't calculate
   */
  _calcResourceDeficit(task) {
    try {
      const GameData = typeof self !== 'undefined' && self.TravianGameData;
      if (!GameData || !this.gameState || !this.gameState.resources) return null;

      const current = this.gameState.resources;
      let cost = null;

      if (task.type === 'build_new' && task.params && task.params.gid) {
        // New building: level 0 → 1
        const key = GameData.gidToKey(Number(task.params.gid));
        if (key) cost = GameData.getUpgradeCost(key, 0);

      } else if (task.type === 'upgrade_resource' && task.params) {
        // Upgrade resource field: params have { fieldId } — look up from gameState
        // Note: domScanner.getResourceFields returns { id, type, level } but no gid.
        // We map type back to gid: wood→1, clay→2, iron→3, crop→4.
        const resTypeToGid = { wood: 1, clay: 2, iron: 3, crop: 4 };
        const fieldId = task.params.fieldId || task.params.slot;
        let gid = task.params.gid; // may exist in some cases
        let level = task.params.level || 0;

        // Look up field in gameState.resourceFields (from domScanner.getFullState)
        const fieldArray = this.gameState.resourceFields || this.gameState.resources_fields || [];
        if (!gid && fieldId && fieldArray.length > 0) {
          const field = fieldArray.find(function (f) {
            return f.id == fieldId || f.position == fieldId;
          });
          if (field) {
            // field.type is "wood"/"clay"/"iron"/"crop", convert to gid
            gid = field.gid || resTypeToGid[field.type] || null;
            level = field.level || 0;
          }
        }

        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }

      } else if (task.type === 'upgrade_building' && task.params) {
        // Upgrade building: params have { slot } — look up gid from gameState
        const slot = task.params.slot || task.params.buildingSlot;
        let gid = task.params.gid || task.params.buildingGid;
        let level = task.params.level || task.params.currentLevel || 0;

        if (!gid && slot && this.gameState.buildings) {
          // Note: domScanner.getBuildings returns { id: gid, slot: slotId }
          // where 'id' is the building type (gid), not the slot number.
          // Match by slot only to avoid false matches.
          const building = this.gameState.buildings.find(function (b) {
            return b.slot == slot;
          });
          if (building) {
            gid = building.id; // building.id IS the gid (building type)
            level = building.level || 0;
          }
        }

        if (gid) {
          const key = GameData.gidToKey(Number(gid));
          if (key) cost = GameData.getUpgradeCost(key, level);
        }
      }

      if (!cost) {
        // Fallback: when we can't look up the exact cost, use a capacity-based
        // deficit instead of returning null (which would block the claim entirely).
        // Fill each resource to 50% of warehouse capacity — enough for most upgrades.
        TravianLogger.log('WARN', '[BotEngine] _calcResourceDeficit: could not determine cost for ' + task.type + ' ' + JSON.stringify(task.params) + ' — using capacity-based fallback');
        const cap = this.gameState.resourceCapacity || {};
        const wCap = cap.warehouse || 8000;
        const gCap = cap.granary || wCap;
        const targetFill = 0.5;
        return {
          wood: Math.max(0, Math.floor(wCap * targetFill) - (current.wood || 0)),
          clay: Math.max(0, Math.floor(wCap * targetFill) - (current.clay || 0)),
          iron: Math.max(0, Math.floor(wCap * targetFill) - (current.iron || 0)),
          crop: Math.max(0, Math.floor(gCap * targetFill) - (current.crop || 0))
        };
      }

      const deficit = {
        wood: Math.max(0, (cost.wood || 0) - (current.wood || 0)),
        clay: Math.max(0, (cost.clay || 0) - (current.clay || 0)),
        iron: Math.max(0, (cost.iron || 0) - (current.iron || 0)),
        crop: Math.max(0, (cost.crop || 0) - (current.crop || 0))
      };
      TravianLogger.log('DEBUG', '[BotEngine] _calcResourceDeficit: cost=' + JSON.stringify(cost) + ' current=' + JSON.stringify(current) + ' deficit=' + JSON.stringify(deficit));
      return deficit;
    } catch (e) {
      TravianLogger.log('WARN', '[BotEngine] _calcResourceDeficit error: ' + e.message);
      // Even on exception, try capacity-based fallback
      try {
        const current2 = (this.gameState && this.gameState.resources) || {};
        const cap2 = (this.gameState && this.gameState.resourceCapacity) || {};
        const wCap2 = cap2.warehouse || 8000;
        const gCap2 = cap2.granary || wCap2;
        return {
          wood: Math.max(0, Math.floor(wCap2 * 0.5) - (current2.wood || 0)),
          clay: Math.max(0, Math.floor(wCap2 * 0.5) - (current2.clay || 0)),
          iron: Math.max(0, Math.floor(wCap2 * 0.5) - (current2.iron || 0)),
          crop: Math.max(0, Math.floor(gCap2 * 0.5) - (current2.crop || 0))
        };
      } catch (_) {
        return null;
      }
    }
  }

  /**
   * Adjust the main loop interval based on current activity level.
   * @param {'active'|'idle'} mode
   */
  _adjustLoopInterval(mode) {
    const activeMs = (this.config && this.config.delays && this.config.delays.loopActiveMs) || 45000;
    const idleMs = (this.config && this.config.delays && this.config.delays.loopIdleMs) || 180000;

    const targetMs = mode === 'idle' ? idleMs : activeMs;

    // Track when the next action will happen (for UI countdown)
    this.nextActionTime = Date.now() + targetMs;

    // Only reschedule if the interval actually changed
    const currentStatus = this.scheduler.getStatus();
    const mainLoop = currentStatus['main_loop'];
    if (mainLoop && mainLoop.intervalMs !== targetMs) {
      this.scheduler.reschedule('main_loop', targetMs);
    }
  }
}

// Export for service worker context
self.TravianBotEngine = BotEngine;
