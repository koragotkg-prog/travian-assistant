/**
 * FarmManager — Farm cycle orchestration FSM
 * Part of the 4-layer Farm Stack: FarmManager → FarmScheduler → FarmIntelligence → Storage
 *
 * Owns ALL farm orchestration logic, replacing the 140-line procedural block in BotEngine.
 * Uses a formal state machine with persisted cycle state for service worker recovery.
 * Content script DOM functions (actionExecutor.js) are orchestrated but NOT modified.
 *
 * Exported via self.TravianFarmManager
 *
 * Dependencies:
 *   - self.TravianFarmIntelligence  (core/farmIntelligence.js)
 *   - self.TravianFarmScheduler     (core/farmScheduler.js)
 *   - self.TravianLogger            (utils/logger.js)
 *   - self.TravianStorage           (utils/storage.js)
 *   - self.TravianDelay             (utils/delay.js)
 */
(function() {
  'use strict';

  var Logger = (typeof self !== 'undefined' && self.TravianLogger) || { log: function() {} };
  var Storage = (typeof self !== 'undefined' && self.TravianStorage) || null;
  var Delay = (typeof self !== 'undefined' && self.TravianDelay) || null;
  var LOG_TAG = '[FarmMgr]';

  // ── FSM States ───────────────────────────────────────────────────────

  var STATES = Object.freeze({
    IDLE:           'IDLE',
    NAV_RALLY:      'NAV_RALLY',
    CLICK_TAB:      'CLICK_TAB',
    WAIT_TAB:       'WAIT_TAB',
    SEND_LISTS:     'SEND_LISTS',
    SCAN_RERAID:    'SCAN_RERAID',
    SEND_RERAID:    'SEND_RERAID',
    NAV_HOME:       'NAV_HOME',
    RECOVERING:     'RECOVERING',
    FAILED:         'FAILED'
  });

  var TRANSITIONS = Object.freeze({
    IDLE:           ['NAV_RALLY'],
    NAV_RALLY:      ['CLICK_TAB', 'RECOVERING'],
    CLICK_TAB:      ['WAIT_TAB', 'RECOVERING'],
    WAIT_TAB:       ['SEND_LISTS', 'RECOVERING'],
    SEND_LISTS:     ['SCAN_RERAID', 'NAV_HOME', 'RECOVERING'],
    SCAN_RERAID:    ['SEND_RERAID', 'NAV_HOME', 'RECOVERING'],
    SEND_RERAID:    ['NAV_HOME', 'RECOVERING'],
    NAV_HOME:       ['IDLE', 'RECOVERING'],
    RECOVERING:     ['IDLE', 'FAILED'],
    FAILED:         ['IDLE']
  });

  // Max cycle duration before auto-recovery (2 minutes)
  var CYCLE_TIMEOUT_MS = 120000;

  // ── FarmManager Class ────────────────────────────────────────────────

  function FarmManager(serverKey, intelligence, scheduler) {
    this._serverKey = serverKey;
    this._intelligence = intelligence;
    this._scheduler = scheduler;
    this._state = STATES.IDLE;
    this._cycle = null;   // Active cycle data
  }

  // ── State Machine ────────────────────────────────────────────────────

  FarmManager.prototype._transition = function(newState) {
    var allowed = TRANSITIONS[this._state];
    if (!allowed || allowed.indexOf(newState) === -1) {
      Logger.log('WARN', LOG_TAG + ' Invalid transition: ' + this._state + ' → ' + newState);
      return false;
    }
    Logger.log('DEBUG', LOG_TAG + ' ' + this._state + ' → ' + newState);
    this._state = newState;
    if (this._cycle) {
      this._cycle.state = newState;
      this._cycle.lastStepAt = Date.now();
    }
    return true;
  };

  // ── Persistence ──────────────────────────────────────────────────────

  FarmManager.prototype._persistCycle = async function() {
    if (!Storage || !this._serverKey || !this._cycle) return;
    try {
      var key = 'farm_cycle__' + this._serverKey;
      await Storage.set(key, this._cycle);
    } catch (err) {
      Logger.log('WARN', LOG_TAG + ' Persist failed: ' + (err.message || err));
    }
  };

  FarmManager.prototype._loadCycle = async function() {
    if (!Storage || !this._serverKey) return null;
    try {
      var key = 'farm_cycle__' + this._serverKey;
      return await Storage.get(key, null);
    } catch (err) {
      return null;
    }
  };

  FarmManager.prototype._clearCycle = async function() {
    this._cycle = null;
    // Note: state is NOT set here — caller must use _transition() before calling _clearCycle
    if (!Storage || !this._serverKey) return;
    try {
      var key = 'farm_cycle__' + this._serverKey;
      await Storage.set(key, null);
    } catch (err) {
      // best effort
    }
  };

  // ── Content Script Helpers ───────────────────────────────────────────

  /**
   * Wait for content script to be ready (ping-pong).
   * Mirrors BotEngine._waitForContentScript logic but uses the passed sendFn.
   */
  FarmManager.prototype._waitForCS = async function(sendFn, maxWaitMs) {
    maxWaitMs = maxWaitMs || 15000;
    var start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        var pong = await sendFn({ type: 'GET_STATE', params: { property: 'page' } });
        if (pong && pong.success) return true;
      } catch (_) {
        // Not ready yet
      }
      await new Promise(function(r) { setTimeout(r, 1500); });
    }
    return false;
  };

  /**
   * Human-like random delay
   */
  FarmManager.prototype._humanDelay = async function(min, max) {
    if (Delay && Delay.humanDelay) {
      await Delay.humanDelay(min || 1500, max || 3000);
    } else {
      var ms = (min || 1500) + Math.random() * ((max || 3000) - (min || 1500));
      await new Promise(function(r) { setTimeout(r, ms); });
    }
  };

  // ── Main Entry Point ─────────────────────────────────────────────────

  /**
   * Execute a farm cycle. Re-entrant: resumes from persisted state if SW was killed.
   *
   * @param {Object} config — full bot config (contains farmConfig)
   * @param {Object} gameState — current game state
   * @param {Function} sendFn — BotEngine.sendToContentScript bound method
   * @param {Function} waitFn — BotEngine._waitForContentScript bound method
   * @returns {Promise<{success, sent, reRaidSent, recovered}>}
   */
  FarmManager.prototype.executeFarmCycle = async function(config, gameState, sendFn, waitFn) {
    // Store waitFn for use in steps (BotEngine's _waitForContentScript has tab awareness)
    this._waitFnExternal = waitFn || null;

    // 1. Check for persisted interrupted cycle
    var persisted = await this._loadCycle();
    if (persisted && persisted.state && persisted.state !== STATES.IDLE && persisted.state !== STATES.FAILED) {
      // Check if stale
      var age = Date.now() - (persisted.lastStepAt || 0);
      if (age > (persisted.timeoutMs || CYCLE_TIMEOUT_MS)) {
        Logger.log('WARN', LOG_TAG + ' Stale cycle detected (age=' + Math.round(age / 1000) + 's), recovering...');
        this._state = persisted.state;
        this._cycle = persisted;
        await this._recover(sendFn);
        return { success: false, sent: 0, reRaidSent: 0, recovered: true };
      }
      // Resume from persisted state
      Logger.log('INFO', LOG_TAG + ' Resuming interrupted cycle from state: ' + persisted.state);
      this._state = persisted.state;
      this._cycle = persisted;
      return await this._resumeCycle(sendFn);
    }

    // 2. Start fresh cycle
    var farmCfg = (config && config.farmConfig) || {};
    this._cycle = {
      state: STATES.IDLE,
      startedAt: Date.now(),
      config: {
        smartFarming: farmCfg.smartFarming !== false,
        minLoot: farmCfg.minLoot || 30,
        skipLosses: farmCfg.skipLosses !== false,
        enableReRaid: !!farmCfg.enableReRaid,
        reRaidMinLoot: (farmCfg.reRaidMinLoot != null) ? farmCfg.reRaidMinLoot : 100,
        reRaidTroopType: farmCfg.reRaidTroopType || 't4',
        reRaidTroopCount: (farmCfg.reRaidTroopCount != null) ? farmCfg.reRaidTroopCount : 5,
        reRaidTroopSpeed: farmCfg.reRaidTroopSpeed || 19, // tiles/hour (TT default)
        reRaidCarryPerUnit: farmCfg.reRaidCarryPerUnit || 150, // carry capacity per unit
        villageX: (config && config.villageX != null) ? config.villageX : null,
        villageY: (config && config.villageY != null) ? config.villageY : null,
        serverSpeed: (config && config.serverSpeed) || 1,
        farmListId: null  // Set from task params if specific list
      },
      listSendResult: null,
      reRaidTargets: [],
      reRaidCursor: 0,
      reRaidSent: 0,
      reRaidFailed: 0,
      lastStepAt: Date.now(),
      timeoutMs: CYCLE_TIMEOUT_MS
    };

    // Check task params for specific farm list ID
    // (passed through config.farmConfig._taskFarmListId by BotEngine)
    if (farmCfg._taskFarmListId != null) {
      this._cycle.config.farmListId = farmCfg._taskFarmListId;
    }

    this._state = STATES.IDLE;
    Logger.log('INFO', LOG_TAG + ' Starting farm cycle (smart=' + this._cycle.config.smartFarming +
      ' reRaid=' + this._cycle.config.enableReRaid + ')');

    return await this._runCycle(sendFn);
  };

  // ── Cycle Execution ──────────────────────────────────────────────────

  FarmManager.prototype._runCycle = async function(sendFn) {
    try {
      return await this._stepNavRally(sendFn);
    } catch (err) {
      Logger.log('ERROR', LOG_TAG + ' Cycle error: ' + (err.message || err));
      await this._recover(sendFn);
      return { success: false, sent: 0, reRaidSent: 0, error: err.message };
    }
  };

  /**
   * Resume an interrupted cycle from its persisted state.
   */
  FarmManager.prototype._resumeCycle = async function(sendFn) {
    try {
      switch (this._state) {
        case STATES.NAV_RALLY:
          return await this._stepNavRally(sendFn);
        case STATES.CLICK_TAB:
          return await this._stepClickTab(sendFn);
        case STATES.WAIT_TAB:
          return await this._stepWaitTab(sendFn);
        case STATES.SEND_LISTS:
          return await this._stepSendLists(sendFn);
        case STATES.SCAN_RERAID:
          return await this._stepScanReRaid(sendFn);
        case STATES.SEND_RERAID:
          // Resume re-raid from cursor position
          return await this._stepSendReRaid(sendFn);
        case STATES.NAV_HOME:
          return await this._stepNavHome(sendFn);
        default:
          Logger.log('WARN', LOG_TAG + ' Unknown resume state: ' + this._state + ', recovering');
          await this._recover(sendFn);
          return { success: false, sent: 0, reRaidSent: 0, recovered: true };
      }
    } catch (err) {
      Logger.log('ERROR', LOG_TAG + ' Resume error: ' + (err.message || err));
      await this._recover(sendFn);
      return { success: false, sent: 0, reRaidSent: 0, error: err.message };
    }
  };

  // ── Step Functions ───────────────────────────────────────────────────
  // Each step: transition → persist → execute → advance to next step

  /**
   * Step 1: Navigate to rally point
   */
  FarmManager.prototype._stepNavRally = async function(sendFn) {
    if (this._state !== STATES.NAV_RALLY) { this._transition(STATES.NAV_RALLY); await this._persistCycle(); }

    await sendFn({ type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' } });
    await this._humanDelay(2000, 4000);
    var ready = await this._waitForCSWrapped(sendFn, 15000);

    if (!ready) {
      Logger.log('WARN', LOG_TAG + ' Rally point navigation timeout');
      return await this._handleFailure(sendFn, 'nav_rally_timeout');
    }

    return await this._stepClickTab(sendFn);
  };

  /**
   * Step 2: Click farm list tab (tt=99) — causes page reload
   */
  FarmManager.prototype._stepClickTab = async function(sendFn) {
    if (this._state !== STATES.CLICK_TAB) { this._transition(STATES.CLICK_TAB); await this._persistCycle(); }

    await sendFn({ type: 'EXECUTE', action: 'clickFarmListTab', params: {} });
    await this._humanDelay(2000, 3500);

    return await this._stepWaitTab(sendFn);
  };

  /**
   * Step 3: Wait for content script re-injection after farm tab page reload
   */
  FarmManager.prototype._stepWaitTab = async function(sendFn) {
    if (this._state !== STATES.WAIT_TAB) { this._transition(STATES.WAIT_TAB); await this._persistCycle(); }

    var ready = await this._waitForCSWrapped(sendFn, 15000);
    if (!ready) {
      Logger.log('WARN', LOG_TAG + ' Farm tab reload timeout');
      return await this._handleFailure(sendFn, 'farm_tab_timeout');
    }

    return await this._stepSendLists(sendFn);
  };

  /**
   * Step 4: Send farm lists (smart selective / single / sendAll)
   */
  FarmManager.prototype._stepSendLists = async function(sendFn) {
    if (this._state !== STATES.SEND_LISTS) { this._transition(STATES.SEND_LISTS); await this._persistCycle(); }

    var cfg = this._cycle.config;
    var response = null;

    var rawResponse = null;

    if (cfg.smartFarming) {
      // Smart farming: selective checkbox toggle per farm list slot
      Logger.log('INFO', LOG_TAG + ' Sending smart farm (minLoot=' + cfg.minLoot + ' skipLosses=' + cfg.skipLosses + ')');
      rawResponse = await sendFn({
        type: 'EXECUTE', action: 'selectiveFarmSend', params: {
          minLoot: cfg.minLoot,
          skipLosses: cfg.skipLosses
        }
      });
    } else if (cfg.farmListId != null) {
      // Send a specific farm list
      Logger.log('INFO', LOG_TAG + ' Sending farm list: ' + cfg.farmListId);
      rawResponse = await sendFn({
        type: 'EXECUTE', action: 'sendFarmList', params: { farmListId: cfg.farmListId }
      });
    } else {
      // Legacy: send all farm lists
      Logger.log('INFO', LOG_TAG + ' Sending all farm lists');
      rawResponse = await sendFn({
        type: 'EXECUTE', action: 'sendAllFarmLists', params: {}
      });
    }

    // FIX: Unwrap bridge response — ContentScriptBridge wraps all results in
    // { success: !!actionResult, data: actualResult }. The wrapper's .success
    // is always true for object results (even { success: false }), and domain
    // fields (sent, skipped, total) live inside .data, not at the top level.
    response = (rawResponse && rawResponse.data && typeof rawResponse.data === 'object')
      ? rawResponse.data : rawResponse;

    if (response && response.sent != null) {
      Logger.log('INFO', LOG_TAG + ' Smart farm result: sent=' + response.sent + ' skipped=' + response.skipped + ' total=' + response.total);
    } else if (response && response.started != null) {
      Logger.log('INFO', LOG_TAG + ' Farm send result: started=' + response.started + ' total=' + response.total);
    }

    // Store result (now using unwrapped response with correct .success and counts)
    this._cycle.listSendResult = response && response.success ? {
      success: true,
      sent: response.sent || response.started || 1,
      skipped: response.skipped || 0,
      total: response.total || 1
    } : { success: false, sent: 0, skipped: 0, total: 0 };
    await this._persistCycle();

    // If send failed, still navigate home
    if (!response || !response.success) {
      Logger.log('WARN', LOG_TAG + ' Farm list send failed: ' + (response && response.message || 'unknown'));
      return await this._stepNavHome(sendFn);
    }

    // Check if re-raid is enabled
    if (cfg.enableReRaid) {
      return await this._stepScanReRaid(sendFn);
    }

    return await this._stepNavHome(sendFn);
  };

  /**
   * Step 5: Scan for re-raid targets (bounty-full after farm send)
   */
  FarmManager.prototype._stepScanReRaid = async function(sendFn) {
    if (this._state !== STATES.SCAN_RERAID) { this._transition(STATES.SCAN_RERAID); await this._persistCycle(); }

    // Wait for UI to update after farm send (AJAX-based, needs time for icons to refresh)
    await this._humanDelay(2000, 3500);
    await this._waitForCSWrapped(sendFn, 10000);

    var cfg = this._cycle.config;

    // ── Feed FarmIntelligence with results from ALL farm list slots ────────
    // scanFarmListSlots returns every slot with raidStatus, bountyLevel, lastLoot
    // and (now) coordinates.  We record observed results for any previously-sent
    // raids so intelligence can auto-blacklist lossy targets and compute scores.
    if (this._intelligence) {
      try {
        var slotScanRaw = await sendFn({
          type: 'EXECUTE', action: 'scanFarmListSlots', params: {}
        });
        // FIX: Unwrap bridge response — .slots lives in .data
        var slotScan = (slotScanRaw && slotScanRaw.data && typeof slotScanRaw.data === 'object')
          ? slotScanRaw.data : slotScanRaw;
        var allSlots = (slotScan && slotScan.success && slotScan.slots) || [];
        var recorded = 0;
        for (var si = 0; si < allSlots.length; si++) {
          var s = allSlots[si];
          if (s.x == null || s.y == null) continue;
          if (s.raidStatus === 'unknown') continue; // No prior raid data

          // Ensure target exists in intelligence (may have been sent via farm list, not tracked)
          if (!this._intelligence.getTarget(s.x, s.y)) {
            this._intelligence.recordRaidSent(s.x, s.y, {}, Date.now() - 60000, 'farmList');
          }

          // Map farm list status to recordRaidResult format
          var troopsLost = {};
          if (s.raidStatus === 'lost') {
            troopsLost = { _total: 1 }; // Signal losses occurred (exact count unknown)
          } else if (s.raidStatus === 'won_with_losses') {
            troopsLost = { _partial: 1 }; // Partial losses
          }

          this._intelligence.recordRaidResult(s.x, s.y, {
            loot: {
              wood: Math.round(s.lastLoot / 4),
              clay: Math.round(s.lastLoot / 4),
              iron: Math.round(s.lastLoot / 4),
              crop: Math.round(s.lastLoot / 4)
            },
            troopsLost: troopsLost,
            bountyFull: s.bountyLevel === 'full'
          });

          // Also update target metadata (name, population, distance)
          this._intelligence.updateTargetInfo(s.x, s.y, {
            name: s.name || undefined,
            population: s.population || undefined,
            distance: s.distance || undefined
          });
          recorded++;
        }
        if (recorded > 0) {
          Logger.log('DEBUG', LOG_TAG + ' Intelligence: recorded results for ' + recorded + '/' + allSlots.length + ' farm slots');
        }
      } catch (intErr) {
        Logger.log('WARN', LOG_TAG + ' Intelligence feed error: ' + intErr.message);
      }
    }

    Logger.log('INFO', LOG_TAG + ' Scanning for re-raid targets (minLoot=' + cfg.reRaidMinLoot + ')');

    var scanResultRaw = await sendFn({
      type: 'EXECUTE', action: 'scanReRaidTargets', params: { minLoot: cfg.reRaidMinLoot }
    });
    // FIX: Unwrap bridge response — .targets lives in .data
    var scanResult = (scanResultRaw && scanResultRaw.data && typeof scanResultRaw.data === 'object')
      ? scanResultRaw.data : scanResultRaw;

    if (!scanResult || !scanResult.success || !scanResult.targets || scanResult.targets.length === 0) {
      Logger.log('DEBUG', LOG_TAG + ' No re-raid targets found');
      return await this._stepNavHome(sendFn);
    }

    var targets = scanResult.targets;

    // Filter through intelligence (skip blacklisted/paused)
    if (this._scheduler) {
      targets = this._scheduler.filterDueTargets(targets);
    }

    if (targets.length === 0) {
      Logger.log('DEBUG', LOG_TAG + ' All re-raid targets filtered by intelligence');
      return await this._stepNavHome(sendFn);
    }

    // Prioritize using MilitaryPlanner (strategic scoring) or fall back to scheduler
    var MilPlanner = (typeof self !== 'undefined' && self.TravianMilitaryPlanner) ? self.TravianMilitaryPlanner : null;
    if (MilPlanner && cfg.villageX != null && cfg.villageY != null) {
      try {
        var planner = new MilPlanner();
        var origin = { x: cfg.villageX, y: cfg.villageY };
        var troops = {
          speed: cfg.reRaidTroopSpeed || 19, // Default TT speed
          count: cfg.reRaidTroopCount || 5,
          carryPerUnit: cfg.reRaidCarryPerUnit || 150
        };
        var scored = planner.planRaids(targets, origin, troops, targets.length, cfg.serverSpeed || 1);
        if (scored.length > 0) {
          targets = scored.map(function(s) { return s.target; });
          Logger.log('DEBUG', LOG_TAG + ' MilitaryPlanner ranked ' + targets.length +
            ' targets (top: ' + (targets[0] ? targets[0].name : 'none') +
            ' score=' + (scored[0] ? scored[0].score : 0) + ')');
        }
      } catch (mpErr) {
        Logger.log('WARN', LOG_TAG + ' MilitaryPlanner scoring failed, using scheduler: ' + mpErr.message);
        if (this._scheduler) {
          targets = this._scheduler.prioritizeTargets(targets);
        }
      }
    } else if (this._scheduler) {
      targets = this._scheduler.prioritizeTargets(targets);
    }

    // Store targets for the re-raid loop
    this._cycle.reRaidTargets = targets;
    this._cycle.reRaidCursor = 0;
    this._cycle.reRaidSent = 0;
    this._cycle.reRaidFailed = 0;
    await this._persistCycle();

    Logger.log('INFO', LOG_TAG + ' Re-raid: ' + targets.length + ' targets, sending ' +
      cfg.reRaidTroopCount + 'x ' + cfg.reRaidTroopType + ' each');

    return await this._stepSendReRaid(sendFn);
  };

  /**
   * Step 6: Send re-raid attacks (TT via rally point, one per target)
   * Loop with cursor persistence for SW recovery.
   */
  FarmManager.prototype._stepSendReRaid = async function(sendFn) {
    if (this._state !== STATES.SEND_RERAID) {
      this._transition(STATES.SEND_RERAID);
      await this._persistCycle();  // Persist immediately so SW death here doesn't re-run scan
    }

    var targets = this._cycle.reRaidTargets;
    var cfg = this._cycle.config;

    for (var i = this._cycle.reRaidCursor; i < targets.length; i++) {
      var target = targets[i];

      // Persist cursor BEFORE executing (so SW death resumes at this target)
      this._cycle.reRaidCursor = i;
      this._cycle.lastStepAt = Date.now();
      await this._persistCycle();

      Logger.log('DEBUG', LOG_TAG + ' Re-raid [' + (i + 1) + '/' + targets.length + ']: (' +
        target.x + '|' + target.y + ') ' + target.name + ' loot=' + target.lastLoot);

      // Step A: Navigate to rally point send tab (tt=2)
      await sendFn({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPointSend' }
      });
      await this._humanDelay(1500, 3000);
      var ready = await this._waitForCSWrapped(sendFn, 15000);

      if (!ready) {
        Logger.log('WARN', LOG_TAG + ' Re-raid: rally point nav timeout for target ' + (i + 1));
        this._cycle.reRaidFailed++;
        continue;
      }

      // Step B: Fill attack form and submit
      var troops = {};
      troops[cfg.reRaidTroopType] = cfg.reRaidTroopCount;
      var sendResult = await sendFn({
        type: 'EXECUTE', action: 'sendAttack', params: {
          target: { x: target.x, y: target.y },
          troops: troops,
          opts: { eventType: 4 } // 4 = raid
        }
      });

      if (!sendResult || !sendResult.success) {
        Logger.log('WARN', LOG_TAG + ' Re-raid: sendAttack failed for (' + target.x + '|' + target.y + '): ' +
          (sendResult && sendResult.message || 'unknown'));
        this._cycle.reRaidFailed++;
        continue;
      }

      // Step C: Wait for confirmation page reload, then confirm
      await this._humanDelay(2000, 4000);
      await this._waitForCSWrapped(sendFn, 15000);

      var confirmResult = await sendFn({
        type: 'EXECUTE', action: 'confirmAttack', params: {}
      });

      if (confirmResult && confirmResult.success) {
        this._cycle.reRaidSent++;
        Logger.log('INFO', LOG_TAG + ' Re-raid: sent to (' + target.x + '|' + target.y + ') ' + target.name);

        // Record in intelligence
        if (this._intelligence) {
          this._intelligence.recordRaidSent(target.x, target.y, troops, Date.now(), 'reRaid');
        }
      } else {
        this._cycle.reRaidFailed++;
        Logger.log('WARN', LOG_TAG + ' Re-raid: confirm failed for (' + target.x + '|' + target.y + '): ' +
          (confirmResult && confirmResult.message || 'unknown'));
      }

      // Persist after each target completion
      this._cycle.reRaidCursor = i + 1;
      await this._persistCycle();

      // Human-like delay between targets
      if (i < targets.length - 1) {
        await this._humanDelay(2000, 5000);
      }
    }

    Logger.log('INFO', LOG_TAG + ' Re-raid complete: sent=' + this._cycle.reRaidSent +
      ' failed=' + this._cycle.reRaidFailed + ' total=' + targets.length);

    return await this._stepNavHome(sendFn);
  };

  /**
   * Step 7: Navigate back to dorf1
   */
  FarmManager.prototype._stepNavHome = async function(sendFn) {
    if (this._state !== STATES.NAV_HOME) { this._transition(STATES.NAV_HOME); await this._persistCycle(); }

    try {
      await sendFn({ type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' } });
      await this._waitForCSWrapped(sendFn, 10000);
    } catch (err) {
      Logger.log('WARN', LOG_TAG + ' Navigate home failed: ' + (err.message || err));
      // Not a cycle failure — we'll end up on the wrong page but next scan will handle it
    }

    // Cycle complete — build result
    var listResult = this._cycle.listSendResult;
    var result = {
      success: !!(listResult && listResult.success),
      sent: (listResult && listResult.sent) || 0,
      skipped: (listResult && listResult.skipped) || 0,
      reRaidSent: this._cycle.reRaidSent || 0,
      reRaidFailed: this._cycle.reRaidFailed || 0,
      durationMs: Date.now() - this._cycle.startedAt,
      // Include message for BotEngine error reporting when send failed
      message: (listResult && !listResult.success) ? 'Farm list send failed (sent=0)' : undefined
    };

    Logger.log('INFO', LOG_TAG + ' Cycle complete: sent=' + result.sent + ' reRaid=' + result.reRaidSent +
      ' duration=' + Math.round(result.durationMs / 1000) + 's');

    // Clear persisted cycle state
    this._transition(STATES.IDLE);
    await this._clearCycle();

    return result;
  };

  // ── Recovery ─────────────────────────────────────────────────────────

  /**
   * Recover from a stuck state by navigating to dorf1 and resetting.
   */
  FarmManager.prototype._recover = async function(sendFn) {
    Logger.log('WARN', LOG_TAG + ' Recovering from stuck state: ' + this._state);

    // Force transition to RECOVERING (bypass guard since we might be in any state)
    this._state = STATES.RECOVERING;
    if (this._cycle) this._cycle.state = STATES.RECOVERING;

    try {
      await sendFn({ type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' } });
      await this._waitForCSWrapped(sendFn, 10000);
      Logger.log('INFO', LOG_TAG + ' Recovery successful — back to IDLE');
    } catch (err) {
      Logger.log('ERROR', LOG_TAG + ' Recovery navigation failed: ' + (err.message || err));
    }

    // Always reset to IDLE regardless of recovery success
    this._state = STATES.IDLE;
    await this._clearCycle();
  };

  /**
   * Handle a step failure — attempt recovery.
   */
  FarmManager.prototype._handleFailure = async function(sendFn, reason) {
    Logger.log('WARN', LOG_TAG + ' Step failed: ' + reason);
    await this._recover(sendFn);
    return {
      success: false,
      sent: 0,
      reRaidSent: 0,
      failureReason: reason,
      recovered: true
    };
  };

  // ── Wait Helper ──────────────────────────────────────────────────────

  /**
   * Wait for content script — prefer BotEngine's method if available (has tab awareness),
   * fall back to our own ping-based implementation.
   */
  FarmManager.prototype._waitForCSWrapped = async function(sendFn, maxWaitMs) {
    if (this._waitFnExternal) {
      try {
        return await this._waitFnExternal(maxWaitMs);
      } catch (_) {
        // Fall through to own implementation
      }
    }
    return await this._waitForCS(sendFn, maxWaitMs);
  };

  // ── Export ───────────────────────────────────────────────────────────

  var exportTarget = (typeof self !== 'undefined') ? self :
               (typeof window !== 'undefined') ? window :
               (typeof global !== 'undefined') ? global : {};
  exportTarget.TravianFarmManager = FarmManager;

})();
