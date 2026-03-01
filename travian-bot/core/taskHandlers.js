/**
 * Task Handler Registry — extracted from BotEngine.executeTask()
 *
 * Each handler receives (engine, task) and returns {success, reason?, message?}
 * or the content script response. Handlers call engine methods for communication:
 *   engine.sendToContentScript(msg)
 *   engine._randomDelay()
 *   engine._waitForContentScript(ms)
 *   engine._verifyNavigation(page)
 *   engine._slog(level, msg, data)
 *
 * The pre-processing (liveness check, village context assertion) and
 * post-processing (success/failure handling, retry logic) remain in BotEngine.
 */
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  const TaskHandlers = {

    // -----------------------------------------------------------------------
    // upgrade_resource — Navigate to dorf1, click resource field, click upgrade
    // -----------------------------------------------------------------------
    upgrade_resource: async function(engine, task) {
      // Step 1: Navigate to dorf1 (resource view)
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
      });
      await engine._randomDelay();
      // Wait for page reload and new content script injection
      await engine._waitForContentScript(15000);
      // FIX 9: Verify navigation to dorf1
      if (!await engine._verifyNavigation('resources')) {
        return { success: false, reason: 'page_mismatch', message: 'Not on dorf1 after navigation' };
      }
      // Step 2: Click the resource field (navigates to /build.php?id=XX)
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickResourceField', params: { fieldId: task.params.fieldId }
      });
      await engine._randomDelay();
      // Step 2b: Wait for content script re-injection after page navigation
      await engine._waitForContentScript(15000);
      // Step 3: Click upgrade button
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
      });
    },

    // -----------------------------------------------------------------------
    // upgrade_building — Navigate to dorf2, click building slot, click upgrade
    // -----------------------------------------------------------------------
    upgrade_building: async function(engine, task) {
      // Step 1: Navigate to dorf2 (village view)
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
      });
      await engine._randomDelay();
      // Wait for page reload and new content script injection
      await engine._waitForContentScript(15000);
      // FIX 9: Verify navigation to dorf2
      if (!await engine._verifyNavigation('village')) {
        return { success: false, reason: 'page_mismatch', message: 'Not on dorf2 after navigation' };
      }
      // Step 2: Click the building slot (navigates to /build.php?id=XX)
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
      });
      await engine._randomDelay();
      // Step 2b: Wait for content script re-injection after page navigation
      await engine._waitForContentScript(15000);
      // Step 3: Click upgrade button (green = affordable, no button = can't afford)
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickUpgradeButton', params: {}
      });
    },

    // -----------------------------------------------------------------------
    // train_troops — Navigate to barracks/stable and train
    // -----------------------------------------------------------------------
    train_troops: async function(engine, task) {
      // Navigate to the barracks/stable page and train
      var buildingPage = task.params.buildingType || 'barracks';
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: buildingPage }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);
      // FIX: Verify navigation landed on a building page before training.
      // Without this, a failed nav wastes a retry sending trainTroops to the wrong page.
      if (!await engine._verifyNavigation('building')) {
        return { success: false, reason: 'page_mismatch', message: 'Not on building page after navigating to ' + buildingPage };
      }
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'trainTroops', params: {
          troopType: task.params.troopType,
          count: task.params.count
        }
      });
    },

    // -----------------------------------------------------------------------
    // send_farm — Delegate to FarmManager FSM (4-layer farm stack)
    // -----------------------------------------------------------------------
    send_farm: async function(engine, task) {
      // Delegate to FarmManager FSM (4-layer farm stack)
      if (!engine._farmManager) {
        // Reuse existing intelligence instance if available (e.g. from partial init)
        var farmIntel = engine._farmIntelligence || new self.TravianFarmIntelligence(engine.serverKey);
        if (!engine._farmIntelligence) await farmIntel.load();
        var farmSched = new self.TravianFarmScheduler(farmIntel);
        engine._farmManager = new self.TravianFarmManager(engine.serverKey, farmIntel, farmSched);
        engine._farmIntelligence = farmIntel;
        // Wire intelligence to DecisionEngine for all-blacklisted check
        if (engine.decisionEngine) engine.decisionEngine._farmIntelligence = farmIntel;
      }
      // Pass specific farm list ID through config if task specifies one
      if (task.params.farmListId != null) {
        if (!engine.config.farmConfig) engine.config.farmConfig = {};
        engine.config.farmConfig._taskFarmListId = task.params.farmListId;
      }
      var farmResult;
      try {
        farmResult = await engine._farmManager.executeFarmCycle(
          engine.config,
          engine.gameState,
          function(msg) { return engine.sendToContentScript(msg); },
          function(ms) { return engine._waitForContentScript(ms); }
        );
      } finally {
        // Always clean up task-specific param, even if executeFarmCycle throws
        if (engine.config.farmConfig) delete engine.config.farmConfig._taskFarmListId;
      }
      if (farmResult && (farmResult.success || farmResult.recovered)) {
        // Treat recovered cycles as soft success — don't eat retry budget
        engine._lastFarmTime = Date.now();
        engine.stats.farmRaidsSent += (farmResult.sent || 0) + (farmResult.reRaidSent || 0);
        if (farmResult.recovered) farmResult.success = true;  // Mark as success for task completion
      }
      // Persist intelligence after each cycle
      if (engine._farmIntelligence) {
        try { await engine._farmIntelligence.persist(); } catch (_) {}
      }

      // Adaptive farm list management: prune dead targets every 10 cycles
      if (engine._farmIntelligence && engine._farmIntelligence.adaptFarmList) {
        engine._farmAdaptCounter = (engine._farmAdaptCounter || 0) + 1;
        if (engine._farmAdaptCounter >= 10) {
          engine._farmAdaptCounter = 0;
          try {
            // Pass null for newTargets (MapScanner integration is done separately)
            var adaptResult = engine._farmIntelligence.adaptFarmList(null, { pruneAfterHours: 48 });
            if (adaptResult.pruned > 0) {
              engine._slog('INFO', 'Farm list adapted: pruned ' + adaptResult.pruned + ' dead targets');
            }
          } catch (e) {
            console.warn('[TaskHandlers] adaptFarmList error:', e.message);
          }
        }
      }

      return farmResult;
    },

    // -----------------------------------------------------------------------
    // build_traps — Find trapper, navigate to dorf2, click slot, train traps
    // -----------------------------------------------------------------------
    build_traps: async function(engine, task) {
      // Step 1: Find trapper building slot from gameState (gid=36, slot != 40 which is wall)
      var trapperSlot = null;
      if (engine.gameState && engine.gameState.buildings) {
        var trapperBld = engine.gameState.buildings.find(function(b) {
          return (b.id === 36 || b.gid === 36) && b.slot !== 40;
        });
        if (trapperBld) trapperSlot = trapperBld.slot;
      }
      if (!trapperSlot) {
        return { success: false, reason: 'building_not_available', message: 'Trapper building not found' };
      }
      // Step 2: Navigate to dorf2
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);
      // Step 3: Click the trapper building slot (navigates to /build.php?id=XX)
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: trapperSlot }
      });
      await engine._randomDelay();
      // Step 4: Wait for content script re-injection after page navigation
      await engine._waitForContentScript(15000);
      // Step 5: Train traps
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'trainTraps', params: { count: task.params.count || 10 }
      });
    },

    // -----------------------------------------------------------------------
    // send_hero_adventure — Navigate to hero adventures, send hero
    // -----------------------------------------------------------------------
    send_hero_adventure: async function(engine, task) {
      // Navigate to hero adventures page and send hero
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroAdventures' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'sendHeroAdventure', params: {}
      });
    },

    // -----------------------------------------------------------------------
    // claim_quest — Navigate to /tasks, claim first available reward
    // -----------------------------------------------------------------------
    claim_quest: async function(engine, task) {
      // Step 1: Navigate to /tasks page
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'tasks' }
      });
      await engine._randomDelay();
      // Wait for page reload and content script re-injection
      await engine._waitForContentScript(15000);
      // Step 2: Claim the first available quest reward
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'claimQuestReward', params: {}
      });
    },

    // -----------------------------------------------------------------------
    // build_new — Navigate to empty slot in dorf2, build new building
    // -----------------------------------------------------------------------
    build_new: async function(engine, task) {
      // Navigate to empty slot in dorf2 and build a new building
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
      });
      await engine._randomDelay();
      // Wait for page reload and new content script injection
      await engine._waitForContentScript(15000);
      // FIX 9: Verify navigation to dorf2
      if (!await engine._verifyNavigation('village')) {
        return { success: false, reason: 'page_mismatch', message: 'Not on dorf2 after navigation for build_new' };
      }
      // Click the empty building slot to open build menu
      var slotClick = await engine.sendToContentScript({
        type: 'EXECUTE', action: 'clickBuildingSlot', params: { slotId: task.params.slot }
      });
      if (!slotClick || slotClick === false || (slotClick && slotClick.success === false)) {
        return { success: false, reason: 'button_not_found', message: 'Empty slot ' + task.params.slot + ' not found on dorf2' };
      }
      // Clicking empty slot navigates to build.php — wait for new page + content script
      await engine._randomDelay();
      await engine._waitForContentScript(15000);
      // Try to build in current tab first
      console.log('[BotEngine] build_new: trying GID ' + task.params.gid + ' in default tab');
      var response = await engine.sendToContentScript({
        type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
      });
      // If slot is occupied or prerequisites not met, no point trying other tabs
      if (response && (response.reason === 'slot_occupied' || response.reason === 'prerequisites_not_met')) {
        console.log('[BotEngine] build_new: ' + response.reason + ' — skipping tab switching');
        return response;
      }
      // If building not in current tab, try switching tabs (each click causes page reload)
      // Tab switching must happen at botEngine level because page reloads kill content script
      if (response && response.reason === 'building_not_in_tab') {
        console.log('[BotEngine] build_new: GID ' + task.params.gid + ' not in default tab, trying other tabs');
        // FIX: Start at 1 — tab 0 (default) was already tried above. Starting at 0
        // wastes a full page-reload cycle (~5-10s) re-scanning the same tab.
        for (var tabIdx = 1; tabIdx < 3; tabIdx++) {
          var tabClick = await engine.sendToContentScript({
            type: 'EXECUTE', action: 'clickBuildTab', params: { tabIndex: tabIdx }
          });
          if (tabClick && tabClick.success) {
            // Tab was clicked — page reloads, wait for new content script
            await engine._randomDelay();
            await engine._waitForContentScript(15000);
          } else {
            // Tab already active or not found — still retry buildNewByGid
            // (the first attempt might have raced with page load)
            await engine._randomDelay();
          }
          // Try buildNewByGid again
          response = await engine.sendToContentScript({
            type: 'EXECUTE', action: 'buildNewByGid', params: { gid: task.params.gid }
          });
          console.log('[BotEngine] build_new: tab ' + tabIdx + ' result:', response && response.reason || (response && response.success ? 'OK' : 'fail'));
          if (!response || response.reason !== 'building_not_in_tab') break;
        }
      }
      return response;
    },

    // -----------------------------------------------------------------------
    // send_attack — Navigate to rally point, send attack
    // -----------------------------------------------------------------------
    send_attack: async function(engine, task) {
      // Navigate to rally point and send attack to coordinates
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);
      var response = await engine.sendToContentScript({
        type: 'EXECUTE', action: 'sendAttack', params: {
          target: task.params.target,
          troops: task.params.troops || {}
        }
      });
      // FIX: Only update farm time on success — failed attacks should retry sooner
      if (response && response.success) {
        engine._lastFarmTime = Date.now();
      }
      return response;
    },

    // -----------------------------------------------------------------------
    // switch_village — Switch to target village
    // -----------------------------------------------------------------------
    switch_village: async function(engine, task) {
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'switchVillage', params: {
          villageId: task.params.targetVillageId
        }
      });
    },

    // -----------------------------------------------------------------------
    // navigate — Navigate to a page
    // -----------------------------------------------------------------------
    navigate: async function(engine, task) {
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: {
          page: task.params.page
        }
      });
    },

    // -----------------------------------------------------------------------
    // npc_trade — Navigate to marketplace, redistribute resources via NPC
    // -----------------------------------------------------------------------
    npc_trade: async function(engine, task) {
      // Step 1: Find marketplace building slot (GID 17)
      var mpSlot = null;
      if (engine.gameState && engine.gameState.buildings) {
        var mpBld = engine.gameState.buildings.find(function(b) {
          return b.id === 17 || b.gid === 17;
        });
        if (mpBld) mpSlot = mpBld.slot;
      }
      if (!mpSlot) {
        return { success: false, reason: 'building_not_available', message: 'Marketplace not found' };
      }

      // Step 2: Navigate to marketplace page
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'marketplace' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);

      // Step 3: Execute NPC trade with calculated resource distribution
      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'npcTrade', params: {
          wood: task.params.wood || 0,
          clay: task.params.clay || 0,
          iron: task.params.iron || 0,
          crop: task.params.crop || 0
        }
      });
    },

    // -----------------------------------------------------------------------
    // parse_battle_reports — Navigate to reports, parse raid results, feed to FarmIntelligence
    // -----------------------------------------------------------------------
    parse_battle_reports: async function(engine, task) {
      // Step 1: Navigate to reports page
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'reports' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);

      // Step 2: Scan battle reports
      var scanResult = await engine.sendToContentScript({
        type: 'EXECUTE', action: 'scanBattleReports', params: {}
      });

      if (!scanResult || !scanResult.data || !Array.isArray(scanResult.data)) {
        return { success: false, reason: 'no_items', message: 'No battle reports found' };
      }

      var reports = scanResult.data;
      var processed = 0;

      // Step 3: Feed raid results into FarmIntelligence
      if (engine._farmIntelligence && reports.length > 0) {
        for (var i = 0; i < reports.length; i++) {
          var rpt = reports[i];
          if (rpt.type !== 'raid' || !rpt.defender || !rpt.defender.coords) continue;
          var coords = rpt.defender.coords;
          if (coords.x == null || coords.y == null) continue;

          engine._farmIntelligence.recordRaidResult(coords.x, coords.y, {
            loot: rpt.loot || { wood: 0, clay: 0, iron: 0, crop: 0 },
            troopsLost: rpt.troopsLost || {},
            bountyFull: !!rpt.bountyFull
          });
          processed++;
        }

        // Persist intelligence updates
        try { await engine._farmIntelligence.persist(); } catch (_) {}
      }

      engine._slog('INFO', 'Parsed ' + reports.length + ' reports, fed ' + processed + ' raid results to intelligence');
      return { success: true, message: processed + ' raid results recorded' };
    },

    // -----------------------------------------------------------------------
    // dodge_troops — Send troops to safe destination when attack incoming
    // -----------------------------------------------------------------------
    dodge_troops: async function(engine, task) {
      // Navigate to rally point and send troops to dodge destination
      await engine.sendToContentScript({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'rallyPoint' }
      });
      await engine._randomDelay();
      await engine._waitForContentScript(15000);

      // Send as reinforcement (eventType 2) to dodge destination
      var target = task.params.destination || { x: 0, y: 0 };
      var troops = task.params.troops || {};

      return await engine.sendToContentScript({
        type: 'EXECUTE', action: 'sendAttack', params: {
          target: target,
          troops: troops,
          opts: { eventType: 2 } // reinforcement, not attack
        }
      });
    }
  };

  root.TravianTaskHandlers = TaskHandlers;
})();
