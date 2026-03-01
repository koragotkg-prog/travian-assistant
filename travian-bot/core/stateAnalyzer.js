/**
 * StateAnalyzer — Post-scan state analysis and event emission.
 *
 * Called after every SCAN in BotEngine, before DecisionEngine.evaluate().
 * Inspects gameState for urgent conditions and emits EventBus events
 * so that any subscriber (DecisionEngine, NotificationManager, etc.)
 * can react without direct coupling.
 *
 * This is the "sensory cortex" — it doesn't decide what to DO about
 * attacks or overflows, it just notices them and yells about it.
 */
(function(root) {
  'use strict';

  var Logger = (typeof TravianLogger !== 'undefined') ? TravianLogger : { log: function() {} };
  var Events = null; // Resolved lazily

  function _getEvents() {
    if (Events) return Events;
    var Bus = (typeof root.TravianEventBus !== 'undefined') ? root.TravianEventBus : null;
    Events = Bus ? Bus.Events : {};
    return Events;
  }

  /**
   * @param {TravianEventBus} eventBus
   * @param {TravianBuildOptimizer} [buildOptimizer] - For overflow detection
   */
  function TravianStateAnalyzer(eventBus, buildOptimizer) {
    this._eventBus = eventBus;
    this._buildOptimizer = buildOptimizer || null;

    // Debounce: don't fire the same event type more than once per 5 minutes
    this._lastEmitTime = {};
    this._DEBOUNCE_MS = 5 * 60 * 1000;
  }

  /**
   * Run all checks against the current game state.
   * Call this after every successful SCAN, before evaluate().
   *
   * @param {Object} gameState - Full state from domScanner.getFullState()
   * @param {Object} [config] - Bot config for thresholds
   */
  TravianStateAnalyzer.prototype.analyze = function(gameState, config) {
    if (!gameState || !this._eventBus) return;

    this._checkOverflow(gameState);
    this._checkIncomingAttacks(gameState);
    this._checkClaimableQuests(gameState);
    this._checkCropCrisis(gameState);

    // Always emit scan:complete so subscribers know fresh data arrived
    this._eventBus.emit(_getEvents().SCAN_COMPLETE || 'scan:complete', {
      timestamp: gameState.timestamp || Date.now(),
      page: gameState.page,
      villageId: gameState.currentVillageId || null
    });
  };

  // ── Overflow detection ──────────────────────────────────────────

  TravianStateAnalyzer.prototype._checkOverflow = function(gameState) {
    if (!this._buildOptimizer) return;
    if (this._isDebounced('overflow')) return;

    // Build villageState in the format detectOverflow expects
    var storage = this._extractStorage(gameState);
    var villageState = {
      resources: gameState.resources || {},
      production: gameState.resourceProduction || gameState.production || {},
      storage: storage
    };

    var overflow = this._buildOptimizer.detectOverflow(villageState);
    if (!overflow) return;

    // Find worst resource
    var worst = null;
    var worstHours = Infinity;
    var types = ['wood', 'clay', 'iron', 'crop'];
    for (var i = 0; i < types.length; i++) {
      var t = types[i];
      if (overflow[t] && overflow[t].critical && overflow[t].hoursUntilFull < worstHours) {
        worst = t;
        worstHours = overflow[t].hoursUntilFull;
      }
    }

    if (worst) {
      this._debounceEmit('overflow', _getEvents().OVERFLOW_IMMINENT || 'overflow:imminent', {
        overflow: overflow,
        worstResource: worst,
        hoursUntilFull: worstHours
      });
    }
  };

  // ── Incoming attack detection ──────────────────────────────────

  TravianStateAnalyzer.prototype._checkIncomingAttacks = function(gameState) {
    var attacks = gameState.incomingAttacks;
    if (!Array.isArray(attacks) || attacks.length === 0) return;

    // Emit once per attack batch (debounced to 5 min)
    if (this._isDebounced('attack')) return;

    // Sort by arrival time (soonest first)
    var sorted = attacks.slice().sort(function(a, b) {
      return (a.arrivalTime || Infinity) - (b.arrivalTime || Infinity);
    });

    this._debounceEmit('attack', _getEvents().ATTACK_INCOMING || 'attack:incoming', {
      attacks: sorted,
      count: sorted.length,
      soonest: sorted[0],
      timeUntilImpact: sorted[0].arrivalTime ? sorted[0].arrivalTime - Date.now() : null
    });

    Logger.log('WARN', '[StateAnalyzer] Incoming attack detected! Count: ' + sorted.length);
  };

  // ── Claimable quests ───────────────────────────────────────────

  TravianStateAnalyzer.prototype._checkClaimableQuests = function(gameState) {
    var quests = gameState.quests;
    if (!Array.isArray(quests)) return;

    var claimable = quests.filter(function(q) { return q.claimable === true; });
    if (claimable.length === 0) return;
    if (this._isDebounced('quest')) return;

    this._debounceEmit('quest', _getEvents().QUEST_CLAIMABLE || 'quest:claimable', {
      quests: claimable,
      count: claimable.length
    });
  };

  // ── Crop crisis ────────────────────────────────────────────────

  TravianStateAnalyzer.prototype._checkCropCrisis = function(gameState) {
    // Free crop = crop production minus troop upkeep
    // If negative or near zero, troops will start dying
    var freeCrop = gameState.freeCrop;
    if (typeof freeCrop !== 'number') return;
    if (freeCrop >= 5) return; // safe
    if (this._isDebounced('crop')) return;

    this._debounceEmit('crop', _getEvents().CROP_CRISIS || 'crop:crisis', {
      freeCrop: freeCrop,
      cropProduction: (gameState.resourceProduction && gameState.resourceProduction.crop) || 0
    });

    Logger.log('WARN', '[StateAnalyzer] Crop crisis! Free crop: ' + freeCrop);
  };

  // ── Helpers ────────────────────────────────────────────────────

  /**
   * Extract storage building levels from gameState.
   * Same logic as DecisionEngine._extractStorage() — duplicated here
   * to keep StateAnalyzer independent (no class inheritance needed).
   */
  TravianStateAnalyzer.prototype._extractStorage = function(state) {
    var warehouse = 1, granary = 1;
    if (state.buildings) {
      for (var i = 0; i < state.buildings.length; i++) {
        var b = state.buildings[i];
        var gid = b.gid || b.id;
        if (gid === 10 && (b.level || 0) > warehouse) warehouse = b.level;
        if (gid === 11 && (b.level || 0) > granary) granary = b.level;
      }
    }
    if (state.storage) {
      if (state.storage.warehouse) warehouse = state.storage.warehouse;
      if (state.storage.granary) granary = state.storage.granary;
    }
    return { warehouse: warehouse, granary: granary };
  };

  /** Check if we emitted this event type too recently */
  TravianStateAnalyzer.prototype._isDebounced = function(key) {
    var last = this._lastEmitTime[key] || 0;
    return (Date.now() - last) < this._DEBOUNCE_MS;
  };

  /** Emit with debounce tracking */
  TravianStateAnalyzer.prototype._debounceEmit = function(key, event, data) {
    this._lastEmitTime[key] = Date.now();
    this._eventBus.emit(event, data);
  };

  root.TravianStateAnalyzer = TravianStateAnalyzer;
})(typeof window !== 'undefined' ? window : self);
