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
 *   - self.TravianContentScriptBridge (core/contentScriptBridge.js)
 *   - self.TravianNavigationManager (core/navigationManager.js)
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

    // Event-driven architecture (Phase 2)
    this.eventBus = self.TravianEventBus ? new self.TravianEventBus() : null;
    this.stateAnalyzer = (self.TravianStateAnalyzer && this.eventBus)
      ? new self.TravianStateAnalyzer(this.eventBus, this.decisionEngine.buildOptimizer || null)
      : null;

    // Task handler registry with page metadata (Phase 2 — enables batching)
    this._handlerRegistry = (self.TravianTaskHandlerRegistry && self.TravianTaskHandlers)
      ? self.TravianTaskHandlerRegistry.fromHandlers(self.TravianTaskHandlers)
      : null;
    this._batchMode = false; // True during _executeBatch to suppress per-task _returnHome

    // Current state
    this.gameState = null;
    this.config = null;
    this._activeTabId = null;
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

    // Content script communication — delegated to ContentScriptBridge.
    // Bridge owns adaptive timeout, request dedup, retry logic, and ping/wait helpers.
    this._bridge = new (self.TravianContentScriptBridge)(
      (...args) => this._slog(...args)
    );

    // Hero resource claiming — delegated to HeroManager.
    // Owns proactive/reactive claim logic, deficit calculation, V1/V2 paths, and cooldown.
    if (!self.TravianHeroManager) {
      console.error('[BotEngine] TravianHeroManager not loaded — hero resource claiming disabled');
    }
    this._heroManager = new (self.TravianHeroManager || Object)(
      this._bridge,
      (...args) => this._slog(...args),
      () => this._randomDelay()
    );

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

    // Navigation & building cache management — delegated to NavigationManager.
    // Owns dorf2 scan/cache heuristics, navigateAndWait(), and building cache state.
    this._navigationManager = new (self.TravianNavigationManager)(
      this._bridge,
      (...args) => this._slog(...args)
    );
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

  // activeTabId getter/setter — keeps ContentScriptBridge in sync.
  // service-worker.js sets engine.activeTabId directly in many places,
  // so the setter transparently propagates to the bridge.
  get activeTabId() { return this._activeTabId; }
  set activeTabId(id) {
    this._activeTabId = id;
    if (this._bridge) this._bridge.setTabId(id);
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

    this.activeTabId = tabId; // setter also updates this._bridge

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
                const newId = this.taskQueue.add(
                  task.type,
                  task.params || {},
                  task.priority || 5,
                  task.villageId || null,
                  task.scheduledFor || null
                );
                // Preserve retry metadata so tasks don't re-exhaust retries after SW restart
                if (newId && task.retries > 0) {
                  const restored = this.taskQueue.queue.find(t => t.id === newId);
                  if (restored) {
                    restored.retries = task.retries;
                    restored.maxRetries = task.maxRetries || this.taskQueue.maxRetries;
                  }
                }
                restoredCount++;
              }
            }
            if (restoredCount > 0) {
              console.log('[BotEngine] Restored ' + restoredCount + ' pending tasks from saved state');
            }
          }

          // Restore stats (farmRaidsSent, etc.) so counters survive SW restarts
          if (savedState.stats) {
            this.stats.farmRaidsSent = savedState.stats.farmRaidsSent || 0;
            this.stats.tasksCompleted = savedState.stats.tasksCompleted || 0;
            this.stats.tasksFailed = savedState.stats.tasksFailed || 0;
            console.log('[BotEngine] Restored stats: farmRaidsSent=' + this.stats.farmRaidsSent);
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

    // Restore GlobalPlanner state from chrome.storage
    if (this.serverKey && this.decisionEngine && this.decisionEngine.globalPlanner
        && typeof chrome !== 'undefined' && chrome.storage) {
      try {
        const plannerKey = 'bot_planner__' + this.serverKey;
        const result = await new Promise(resolve => {
          chrome.storage.local.get(plannerKey, r => resolve(r));
        });
        if (result[plannerKey]) {
          this.decisionEngine.globalPlanner = self.TravianGlobalPlanner.deserialize(result[plannerKey]);
          console.log('[BotEngine] Restored GlobalPlanner: phase=' + this.decisionEngine.globalPlanner.phase
            + ' mode=' + this.decisionEngine.globalPlanner.mode
            + ' planStep=' + this.decisionEngine.globalPlanner.planStepIndex);
        }
      } catch (err) {
        console.warn('[BotEngine] Could not restore planner state:', err);
      }
    }

    // Initialize Farm Stack (Intelligence → Scheduler → Manager)
    if (this.serverKey && self.TravianFarmIntelligence) {
      try {
        var farmIntel = new self.TravianFarmIntelligence(this.serverKey);
        await farmIntel.load();
        var farmSched = new self.TravianFarmScheduler(farmIntel);
        this._farmManager = new self.TravianFarmManager(this.serverKey, farmIntel, farmSched);
        this._farmIntelligence = farmIntel;
        if (this.decisionEngine) this.decisionEngine._farmIntelligence = farmIntel;
      } catch (err) {
        console.warn('[BotEngine] Farm stack init failed (will retry on first farm task):', err);
      }
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
      }).catch(() => {});
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
  async stop() {
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
    await this.saveState();

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
  async emergencyStop(reason) {
    console.error(`[BotEngine] EMERGENCY STOP: ${reason}`);

    // ST-5 FIX: Flush logs BEFORE stopping — emergency stop may precede SW death
    if (typeof self.TravianLogger !== 'undefined' && typeof self.TravianLogger.flush === 'function') {
      self.TravianLogger.flush();
    }

    this._emergencyReason = reason; // SAF-5 FIX: store for getStatus()
    this._transition(BOT_STATES.EMERGENCY, reason);
    await this.stop(); // EMERGENCY → STOPPED — must await to ensure saveState() completes

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
      type: 'EXECUTE',
      action: 'NOTIFY',
      params: {
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

    // Tag logger with this engine's server key so logs are namespaced
    if (TravianLogger.setServerKey) TravianLogger.setServerKey(this.serverKey);

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
            await this.emergencyStop('Captcha detected (scan failed but captcha confirmed)');
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

      // ── Dorf2 buildings scan (event-driven, delegated to NavigationManager) ──
      // getBuildings() only returns data on dorf2 pages. Since the bot rests
      // on dorf1, buildings[] is always empty unless we navigate to dorf2.
      // NavigationManager handles scan heuristics, caching, and navigation.
      var needBuildingScan = (this.config.autoUpgradeBuildings || this.config.autoBuildingUpgrade) &&
        this._navigationManager.shouldRefreshBuildings(this._cycleCounter, this.gameState);

      if (needBuildingScan) {
        await this._navigationManager.scanBuildings(
          this._cycleCounter, this.gameState, () => this._randomDelay()
        );
      }

      // Merge cached buildings into gameState if current scan didn't get them
      this._navigationManager.mergeCachedBuildings(this.gameState);

      // State: DECIDING (scan complete)
      this._cycleLock = 'deciding';
      this._transition(BOT_STATES.DECIDING, 'scan complete');

      // Enrich gameState with cached extras
      this.gameState = this.stateCollector.enrichGameState(this.gameState);

      // Inject persistent lastFarmTime so DecisionEngine sees it
      this.gameState.lastFarmTime = this._lastFarmTime || 0;

      // Inject farm intelligence summary for ActionScorer dynamic scoring
      if (this._farmIntelligence) {
        try {
          var activeTargets = this._farmIntelligence.getActiveTargets();
          var stats = this._farmIntelligence.getStats();
          var gs = stats && stats.globalStats;
          var avgLoot = 0;
          if (gs && gs.totalRaids > 0) {
            var totalLoot = gs.totalLoot || {};
            avgLoot = ((totalLoot.wood || 0) + (totalLoot.clay || 0) +
                       (totalLoot.iron || 0) + (totalLoot.crop || 0)) / gs.totalRaids;
          }
          this.gameState.farmIntelligence = {
            readyCount: activeTargets.length,
            avgLootPerRaid: avgLoot
          };
        } catch (_) {
          // FarmIntelligence may not be loaded yet — safe to skip
        }
      }

      // 3b. Post-scan state analysis → emit events for urgent conditions
      //     Runs before DecisionEngine so subscribers (e.g., notifications) react early.
      if (this.stateAnalyzer) {
        try {
          this.stateAnalyzer.analyze(this.gameState, this.config);
        } catch (saErr) {
          console.warn('[BotEngine] StateAnalyzer error:', saErr.message);
        }
      }

      // 4. Safety checks - captcha / errors
      if (this.gameState.captcha) {
        await this.emergencyStop('Captcha detected on page');
        return;
      }

      if (this.gameState.error) {
        // Log details before stopping — helps debug false positives
        var errorDetail = typeof this.gameState.error === 'string'
          ? this.gameState.error : 'isErrorPage=true';
        TravianLogger.log('ERROR', '[BotEngine] Error page detected: ' + errorDetail +
          ' | page=' + (this.gameState.page || 'unknown') +
          ' | url=' + (this.gameState.url || 'unknown'));
        await this.emergencyStop('Game error detected: ' + errorDetail);
        return;
      }

      if (!this.gameState.loggedIn) {
        // SAF-1 FIX: Escalating not-logged-in detection.
        // Old code just returned silently — session expiry created an infinite
        // skip loop where bot appeared running but did nothing.
        this._notLoggedInCount++;
        this._slog('WARN', 'Not logged in (count: ' + this._notLoggedInCount + '/' + this._notLoggedInMaxCount + ')');
        if (this._notLoggedInCount >= this._notLoggedInMaxCount) {
          await this.emergencyStop('Session expired — not logged in for ' + this._notLoggedInCount + ' consecutive cycles');
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
          await this.emergencyStop(task.params.reason);
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

      // 5a. Persist GlobalPlanner state after decision cycle
      //     Survives service worker death and Chrome restarts.
      if (this.decisionEngine.globalPlanner && this.serverKey
          && typeof chrome !== 'undefined' && chrome.storage) {
        try {
          const plannerKey = 'bot_planner__' + this.serverKey;
          const plannerData = this.decisionEngine.globalPlanner.serialize();
          chrome.storage.local.set({ [plannerKey]: plannerData });
        } catch (_planErr) {
          console.warn('[BotEngine] Failed to persist planner state:', _planErr.message);
        }
      }

      // 5b. Proactive hero resource claim: if resources are critically low
      //     and hero is home with resource items, claim before executing upgrades
      var heroConfig = (this.config && this.config.heroConfig) || {};
      if (this._heroManager && this._heroManager.shouldProactivelyClaim &&
          this._heroManager.shouldProactivelyClaim(this.gameState, heroConfig)) {
        TravianLogger.log('INFO', '[BotEngine] Resources critically low — attempting proactive hero claim');
        const claimed = await this._heroManager.proactiveClaim(this.gameState, heroConfig);
        // FIX: Navigate back home after hero claim — otherwise next SCAN reads hero inventory page
        try {
          await this.sendToContentScript({ type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' } });
          await this._bridge.waitForReady(10000);
          await this._randomDelay();
        } catch (_navErr) { /* best effort */ }
        // Read cooldown values from config (minutes → ms), fallback to defaults
        var cdSuccessMin = (heroConfig.claimCooldownSuccess != null) ? heroConfig.claimCooldownSuccess : 5;
        var cdFailMin = (heroConfig.claimCooldownFail != null) ? heroConfig.claimCooldownFail : 2;
        if (claimed) {
          this._heroManager.setCooldown(cdSuccessMin * 60000);
          return; // skip this cycle, let resources update
        }
        // Even if failed, set cooldown so we don't spam attempts
        this._heroManager.setCooldown(cdFailMin * 60000);
      }

      // 6. Circuit breaker check — pause if too many consecutive failures
      // SAF-3 FIX: Exponential backoff + max trips → emergency stop
      if (this._consecutiveFailures >= this._circuitBreakerThreshold) {
        this._circuitBreakerTrips++;
        this._consecutiveFailures = 0; // reset so resume doesn't immediately re-trip

        // After max trips → emergency stop (don't keep oscillating)
        if (this._circuitBreakerTrips >= this._circuitBreakerMaxTrips) {
          await this.emergencyStop(
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

      // 7. Execute tasks from queue
      // Phase 2: Batch execution groups tasks by required page for 3-5x throughput.
      // Falls back to single-task execution when registry is unavailable.
      if (this._handlerRegistry && this.taskQueue.size() > 1) {
        var batchCount = await this._executeBatch();
        if (batchCount === 0) {
          this._adjustLoopInterval('idle');
          return;
        }
      } else {
        const nextTask = this.taskQueue.getNext();
        if (!nextTask) {
          this._adjustLoopInterval('idle');
          return;
        }
        await this.executeTask(nextTask);
      }

      // Adjust loop interval back to active pace
      this._adjustLoopInterval('active');

    } catch (err) {
      console.error('[BotEngine] Error in main loop:', err);
    } finally {
      // Return to IDLE if still in an active processing state
      const s = this._botState;
      if (s === BOT_STATES.SCANNING || s === BOT_STATES.DECIDING ||
          s === BOT_STATES.EXECUTING || s === BOT_STATES.COOLDOWN) {
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

      // Dispatch to TaskHandlerRegistry (extracted from former switch statement)
      const handler = self.TravianTaskHandlers && self.TravianTaskHandlers[task.type];
      if (handler) {
        response = await handler(this, task);
      } else {
        // Fallback: send task type directly as an EXECUTE action to content script
        response = await this.sendToContentScript({
          type: 'EXECUTE', action: task.type, params: task.params
        });
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
              (task.type === 'upgrade_resource' || task.type === 'upgrade_building' || task.type === 'build_new') &&
              this._heroManager && this._heroManager.tryClaimForTask) {
            const claimed = await this._heroManager.tryClaimForTask(task, this.gameState);
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

          // FIX: Check task.status (set by markFailed) instead of manual retries+1 calc.
          // markFailed() already incremented task.retries — adding +1 double-counts,
          // causing premature "permanently failed" logging on the 2nd of 3 retries.
          if (task.status === 'failed') {
            this.stats.tasksFailed++;
            this._slog('ERROR', 'Task permanently failed: ' + task.type, { taskId: task.id, error: errorMsg, duration_ms: Date.now() - _taskStart });
          } else {
            this._slog('WARN', 'Task failed, will retry: ' + task.type, { taskId: task.id, error: errorMsg, retries: task.retries });
          }
        }
      }

    } catch (err) {
      const errorMsg = err.message || 'Exception during task execution';
      this.taskQueue.markFailed(task.id, errorMsg);
      this._consecutiveFailures++; // Circuit breaker: increment on exception

      // FIX: Check task.status (set by markFailed) instead of manual retries+1 calc
      if (task.status === 'failed') {
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
    // Phase 2: Skip return-home in batch mode — _executeBatch handles it once after all tasks.
    if (!this._batchMode) {
      try {
        this._cycleLock = 'returning';
        await this._returnHome(task.type);
      } finally {
        // _cycleLock is cleared in mainLoop's finally — NOT here.
        // This ensures the entire cycle (scan→decide→execute→return) is atomic.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Batch Execution (Phase 2 — Throughput Optimization)
  // ---------------------------------------------------------------------------

  /**
   * Execute multiple tasks grouped by required page context.
   *
   * Instead of: execute-one → return-home → next-cycle (60s gap)
   * We do:      group-by-page → navigate-once → execute-all → return-home
   *
   * Safety rules:
   * 1. Max 5 tasks per batch (prevents suspiciously fast execution)
   * 2. Human-like delay (1-3s) between batched tasks
   * 3. Quick liveness check between tasks
   * 4. Hopeless failures skip but don't abort the batch
   * 5. Any navigation or content script failure aborts remaining batch
   *
   * @returns {number} Number of tasks executed
   */
  async _executeBatch() {
    if (!this._handlerRegistry) return 0;

    // Pull up to 5 tasks from the queue
    var batch = [];
    var MAX_BATCH = 5;
    while (batch.length < MAX_BATCH) {
      var next = this.taskQueue.getNext();
      if (!next) break;
      batch.push(next);
    }

    if (batch.length === 0) return 0;

    // If only 1 task, use the proven single-task path (no regression risk)
    if (batch.length === 1) {
      await this.executeTask(batch[0]);
      return 1;
    }

    // Group tasks by required page
    var groups = this._handlerRegistry.groupByPage(batch);
    var executed = 0;
    var lastTaskType = null;

    this._slog('INFO', 'Batch execution: ' + batch.length + ' tasks in ' +
      Object.keys(groups).length + ' page groups');

    for (var page in groups) {
      var pageTasks = groups[page];

      for (var i = 0; i < pageTasks.length; i++) {
        var task = pageTasks[i];
        lastTaskType = task.type;

        // Quick liveness check between batched tasks (skip for first task)
        if (executed > 0) {
          try {
            var alive = await this.sendToContentScript({
              type: 'GET_STATE', params: { property: 'page' }
            });
            if (!alive || !alive.success) {
              this._slog('WARN', 'Batch interrupted — content script unresponsive after task ' + executed);
              // Put remaining tasks back as pending
              this._requeue(pageTasks.slice(i));
              break;
            }
          } catch (_) {
            this._slog('WARN', 'Batch interrupted — content script unreachable');
            this._requeue(pageTasks.slice(i));
            break;
          }

          // Human-like delay between batched tasks (1-3s)
          await this._randomDelay(1000, 3000);
        }

        // Execute the task via the full executeTask path (handles village checks, retries, etc.)
        // But suppress _returnHome — we handle that once after the batch.
        this._batchMode = true;
        try {
          await this.executeTask(task);
          executed++;
        } catch (execErr) {
          this._slog('WARN', 'Batch task failed: ' + task.type + ' — ' + execErr.message);
          executed++;
          // Continue batch — hopeless failures are handled inside executeTask
        } finally {
          this._batchMode = false;
        }
      }
    }

    // Return home once after entire batch (using last task type for nav hints)
    if (executed > 0 && lastTaskType) {
      try {
        this._cycleLock = 'returning';
        // Check if any building task in batch warrants a dorf2 detour
        var hadBuildingTask = batch.some(function(t) {
          return t.type === 'upgrade_building' || t.type === 'build_new';
        });
        if (hadBuildingTask) {
          await this._returnHome('upgrade_building');
        } else {
          await this._returnHome(lastTaskType);
        }
      } catch (_) {
        // Non-critical
      }
    }

    this._slog('INFO', 'Batch complete: ' + executed + '/' + batch.length + ' tasks executed');
    return executed;
  }

  /**
   * Put tasks back into the queue (when batch is interrupted mid-execution).
   * @param {Array} tasks - Remaining tasks to re-queue
   */
  _requeue(tasks) {
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      // Reset to pending WITHOUT consuming retry budget — these tasks were
      // never attempted, they were just waiting in the batch when an earlier
      // task failed. markFailed() would increment retries and eventually
      // permanently kill innocent tasks.
      var queued = this.taskQueue.queue.find(function(q) { return q.id === t.id; });
      if (queued) {
        queued.status = 'pending';
        queued.error = 'batch_interrupted';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Content Script Communication
  // ---------------------------------------------------------------------------

  /**
   * Send a message to the content script running in the active tab.
   * Delegates to ContentScriptBridge.send() which handles retry, adaptive timeout,
   * request dedup, and ghost callback prevention.
   *
   * Kept as a thin wrapper so task handlers can continue calling engine.sendToContentScript().
   *
   * @param {object} message - The message to send
   * @returns {Promise<object>} The response from the content script
   */
  async sendToContentScript(message) {
    return this._bridge.send(message);
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
      plannerState: this.decisionEngine ? this.decisionEngine.getPlannerState() : null,
      prereqResolutions: this.decisionEngine ? this.decisionEngine.lastPrereqResolutions : [],
      executionLocked: this._executionLocked,
      cycleLock: this._cycleLock,
      consecutiveFailures: this._consecutiveFailures,
      farmCycle: this._farmManager ? this._farmManager.getCycleStatus() : null
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
  // Page State Assertion (FIX 9) — delegates to ContentScriptBridge
  // ---------------------------------------------------------------------------

  /**
   * Verify the browser is on the expected page type after navigation.
   * Delegates to ContentScriptBridge.verifyPage().
   *
   * Kept as a thin wrapper so task handlers can continue calling engine._verifyNavigation().
   *
   * @param {string} expectedPage - Expected value from domScanner.detectPage()
   * @returns {Promise<boolean>} true if on correct page
   */
  async _verifyNavigation(expectedPage) {
    return this._bridge.verifyPage(expectedPage);
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
   * Delegates to ContentScriptBridge.waitForReady().
   *
   * Kept as a thin wrapper so task handlers can continue calling engine._waitForContentScript().
   *
   * @param {number} maxWaitMs - Maximum time to wait (default 10000ms)
   * @returns {Promise<boolean>} true if content script responded, false if timed out
   */
  async _waitForContentScript(maxWaitMs) {
    return this._bridge.waitForReady(maxWaitMs);
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
    // Tasks that already end on or near dorf1 — no need to navigate.
    // FIX: Removed 'upgrade_resource' — after clicking upgrade on a resource field,
    // the browser stays on build.php?id=XX. Without navigating home, the next scan
    // reads that build page instead of dorf1, missing all resourceFields data.
    const skipTypes = ['navigate', 'switch_village'];
    if (skipTypes.indexOf(taskType) !== -1) {
      await this._randomDelay();
      return;
    }

    try {
      // For building tasks, detour through dorf2 to refresh cached buildings
      if (taskType === 'upgrade_building' || taskType === 'build_new') {
        await this._navigationManager.refreshBuildingsDetour(
          this._cycleCounter, () => this._randomDelay()
        );
      }

      await this._randomDelay();
      await this.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
      });
      await this._bridge.waitForReady(10000);
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
      'no_amount',          // No amount to transfer (hero dialog)
      'page_mismatch',      // FIX 9: page assertion failed — navigation problem
      'wrong_page',         // On wrong page for this action
      'slot_occupied',      // Slot already has building — can't build new
      'prerequisites_not_met', // Building prereqs unmet — DFS resolver should handle
      'input_not_found',    // Troop input missing — wrong building or troop unavailable
      'input_disabled',     // Troop input disabled — building level too low
      'duplicate'           // Duplicate action — retrying same action is pointless
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

  // Hero resource claiming methods (_tryClaimHeroResources, _claimHeroResourcesV1,
  // _claimHeroResourcesV2, _shouldProactivelyClaimHero, _proactiveHeroClaim,
  // _calcResourceDeficit) have been extracted to core/heroManager.js

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
