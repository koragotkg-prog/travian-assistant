/**
 * HeroManager — Encapsulates all hero resource claiming logic.
 * Extracted from BotEngine to reduce God Class complexity.
 *
 * Handles:
 *   - Proactive hero resource claiming (when resources are critically low)
 *   - Reactive hero resource claiming (when a task fails due to insufficient resources)
 *   - Resource deficit calculation for building/upgrade tasks
 *   - V2 bulk transfer claim path (post-Changelog-367)
 *   - Claim cooldown management
 *
 * Runs in service worker context (no DOM, no window).
 * Exported via self.TravianHeroManager
 *
 * Dependencies (must be loaded before this file):
 *   - self.TravianContentScriptBridge (core/contentScriptBridge.js)
 *   - self.TravianGameData (strategy/gameData.js) — optional, for cost lookups
 */
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  // Resolve TravianLogger — may not be available yet at parse time,
  // so we look it up lazily on each call.
  function _getLogger() {
    return (typeof self !== 'undefined' && self.TravianLogger) ||
           (typeof window !== 'undefined' && window.TravianLogger) ||
           { log: function() {} };
  }

  class HeroManager {
    /**
     * @param {ContentScriptBridge} bridge - Bridge for content script communication
     * @param {Function} [logger] - Logging function with signature (level, message, data)
     * @param {Function} [delayFn] - Random delay function that returns a Promise (for human-like pauses)
     */
    constructor(bridge, logger, delayFn) {
      this._bridge = bridge;
      this._log = logger || function() {};
      this._delayFn = delayFn || function() {
        // Default: 2–5s random delay
        var ms = Math.floor(Math.random() * 3001) + 2000;
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      };

      // Cooldown: prevents spamming hero claim attempts
      this._claimCooldown = 0;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Check if hero resources should be proactively claimed.
     * Triggers when any resource is below threshold % of warehouse capacity,
     * hero is at home, and cooldown has elapsed.
     *
     * @param {object} gameState - Current game state (hero, resources, resourceCapacity)
     * @param {object} [heroConfig] - Optional hero config from popup (claimThreshold, claimFillTarget, etc.)
     * @returns {boolean} true if proactive claim should be attempted
     */
    shouldProactivelyClaim(gameState, heroConfig) {
      // Cooldown check
      if (this._claimCooldown && Date.now() < this._claimCooldown) return false;

      // Hero must be home
      var hero = gameState && gameState.hero;
      if (hero && (hero.isAway || hero.isDead)) return false;

      var res = gameState && gameState.resources;
      var cap = gameState && gameState.resourceCapacity;
      if (!res || !cap) return false;

      var wCap = cap.warehouse || 0;
      var gCap = cap.granary || wCap;
      if (wCap === 0) return false;

      // Read threshold from config (default 20%)
      var thresholdPct = (heroConfig && heroConfig.claimThreshold != null) ? heroConfig.claimThreshold : 20;
      var threshold = thresholdPct / 100;
      return (res.wood || 0) < wCap * threshold ||
             (res.clay || 0) < wCap * threshold ||
             (res.iron || 0) < wCap * threshold ||
             (res.crop || 0) < gCap * threshold;
    }

    /**
     * Proactively claim hero resources to fill low resource types.
     * Navigates to hero inventory, scans items, and transfers resources
     * for any type below fillTarget % of warehouse capacity.
     *
     * @param {object} gameState - Current game state
     * @param {object} [heroConfig] - Optional hero config from popup (claimFillTarget, etc.)
     * @returns {Promise<boolean>} true if any resources were claimed
     */
    async proactiveClaim(gameState, heroConfig) {
      try {
        var res = gameState.resources;
        var cap = gameState.resourceCapacity;
        var wCap = cap.warehouse || 800;
        var gCap = cap.granary || wCap;
        // Read fill target from config (default 50%)
        var fillPct = (heroConfig && heroConfig.claimFillTarget != null) ? heroConfig.claimFillTarget : 50;
        var targetFill = fillPct / 100;

        // Calculate how much of each resource we need to reach targetFill
        var deficit = {
          wood: Math.max(0, Math.floor(wCap * targetFill) - (res.wood || 0)),
          clay: Math.max(0, Math.floor(wCap * targetFill) - (res.clay || 0)),
          iron: Math.max(0, Math.floor(wCap * targetFill) - (res.iron || 0)),
          crop: Math.max(0, Math.floor(gCap * targetFill) - (res.crop || 0))
        };

        var totalDeficit = deficit.wood + deficit.clay + deficit.iron + deficit.crop;
        if (totalDeficit <= 0) return false;

        _getLogger().log('DEBUG', '[HeroManager] Proactive hero claim deficit: ' + JSON.stringify(deficit));

        // Navigate directly to hero inventory (single step)
        await this._bridge.send({
          type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
        });
        await this._delayFn();
        var invReady = await this._bridge.waitForReady(15000);
        if (!invReady) {
          _getLogger().log('WARN', '[HeroManager] Hero inventory did not load for proactive claim');
          return false;
        }

        // Verify we actually landed on the hero page (not login/error redirect)
        var pageOk = await this._bridge.verifyPage('hero');
        if (!pageOk) {
          _getLogger().log('WARN', '[HeroManager] Navigation to hero inventory failed — wrong page');
          return false;
        }

        // Scan inventory (also detects UI version)
        var scanResult = await this._bridge.send({
          type: 'EXECUTE', action: 'scanHeroInventory', params: {}
        });
        if (!scanResult || !scanResult.success || !scanResult.data) {
          _getLogger().log('WARN', '[HeroManager] No hero inventory data for proactive claim');
          return false;
        }
        var rawData = scanResult.data || {};
        var items = rawData.items || (rawData.data && rawData.data.items) || [];
        var uiVersion = rawData.uiVersion || (rawData.data && rawData.data.uiVersion) || 'v1';
        var usableResources = items.filter(function(item) { return item.isResource && item.hasUseButton; });
        if (usableResources.length === 0) {
          _getLogger().log('INFO', '[HeroManager] No hero resource items for proactive claim');
          return false;
        }

        // Route to V1 or V2 claim path
        _getLogger().log('INFO', '[HeroManager] Proactive claim using ' + uiVersion + ' path');
        if (uiVersion === 'v2') {
          return await this._claimResourcesV2(deficit, usableResources);
        }
        return await this._claimResourcesV1(deficit, usableResources);
      } catch (err) {
        _getLogger().log('WARN', '[HeroManager] Proactive hero claim error: ' + err.message);
        return false;
      }
    }

    /**
     * When an upgrade fails due to insufficient resources, try claiming
     * hero inventory resource items as a fallback.
     *
     * @param {object} failedTask - The task that failed
     * @param {object} gameState - Current game state
     * @returns {Promise<boolean>} true if resources were claimed
     */
    async tryClaimForTask(failedTask, gameState) {
      try {
        // Pre-check: hero must be at home (not on adventure or dead)
        var heroStatus = gameState && gameState.hero;
        if (heroStatus && (heroStatus.isAway || heroStatus.isDead)) {
          _getLogger().log('INFO', '[HeroManager] Hero not available for resource claim — skipping');
          return false;
        }

        _getLogger().log('INFO', '[HeroManager] Attempting to claim hero inventory resources...');

        // Calculate deficit: what resources are we short of?
        // Must know the exact deficit BEFORE navigating — if we can't calculate it,
        // skip entirely to avoid the dialog default (fills warehouse to max capacity).
        var deficit = this.calcResourceDeficit(failedTask, gameState);
        if (!deficit) {
          _getLogger().log('WARN', '[HeroManager] Cannot calculate resource deficit — skipping hero claim to avoid waste');
          return false;
        }
        _getLogger().log('DEBUG', '[HeroManager] Resource deficit: ' + JSON.stringify(deficit));

        // Navigate directly to hero inventory (single step)
        await this._bridge.send({
          type: 'EXECUTE', action: 'navigateTo', params: { page: 'heroInventory' }
        });
        await this._delayFn();
        var invReady = await this._bridge.waitForReady(15000);
        if (!invReady) {
          _getLogger().log('WARN', '[HeroManager] Hero inventory page did not load in time');
          return false;
        }

        // Verify we actually landed on the hero page (not login/error redirect)
        var pageOk = await this._bridge.verifyPage('hero');
        if (!pageOk) {
          _getLogger().log('WARN', '[HeroManager] Navigation to hero inventory failed — wrong page');
          return false;
        }

        // Scan inventory items (also detects UI version)
        var scanResult = await this._bridge.send({
          type: 'EXECUTE', action: 'scanHeroInventory', params: {}
        });

        if (!scanResult || !scanResult.success || !scanResult.data) {
          _getLogger().log('WARN', '[HeroManager] No hero inventory data');
          return false;
        }

        // Robust data extraction: scanResult.data may contain items directly
        // or nested under scanResult.data.data (double-wrapped response)
        var rawData = scanResult.data || {};
        var items = rawData.items || (rawData.data && rawData.data.items) || [];
        var uiVersion = rawData.uiVersion || (rawData.data && rawData.data.uiVersion) || 'v1';

        if (items.length === 0) {
          _getLogger().log('WARN', '[HeroManager] Hero inventory scan returned no items');
          return false;
        }

        var usableResources = items.filter(function(item) { return item.isResource && item.hasUseButton; });

        if (usableResources.length === 0) {
          _getLogger().log('INFO', '[HeroManager] No claimable resource items in hero inventory');
          return false;
        }

        // V2 bulk transfer (post-Changelog-367) — only path since V1 was removed
        return await this._claimResourcesV2(deficit, usableResources);

      } catch (err) {
        _getLogger().log('WARN', '[HeroManager] Hero resource claim failed: ' + err.message);
        return false;
      }
    }

    /**
     * Calculate how much of each resource we're short of for a failed task.
     * Uses TravianGameData to look up building costs and compares with current resources.
     *
     * @param {object} task - The failed task
     * @param {object} gameState - Current game state
     * @returns {object|null} { wood, clay, iron, crop } deficit (positive = need more), or null if can't calculate
     */
    calcResourceDeficit(task, gameState) {
      try {
        var GameData = (typeof self !== 'undefined' && self.TravianGameData) ||
                       (typeof window !== 'undefined' && window.TravianGameData);
        if (!GameData || !gameState || !gameState.resources) return null;

        var current = gameState.resources;
        var cost = null;

        if (task.type === 'build_new' && task.params && task.params.gid) {
          // New building: level 0 -> 1
          var key = GameData.gidToKey(Number(task.params.gid));
          if (key) cost = GameData.getUpgradeCost(key, 0);

        } else if (task.type === 'upgrade_resource' && task.params) {
          // Upgrade resource field: params have { fieldId } — look up from gameState
          // Note: domScanner.getResourceFields returns { id, type, level } but no gid.
          // We map type back to gid: wood->1, clay->2, iron->3, crop->4.
          var resTypeToGid = { wood: 1, clay: 2, iron: 3, crop: 4 };
          var fieldId = task.params.fieldId || task.params.slot;
          var gid = task.params.gid; // may exist in some cases
          var level = task.params.level || 0;

          // Look up field in gameState.resourceFields (from domScanner.getFullState)
          var fieldArray = gameState.resourceFields || gameState.resources_fields || [];
          if (!gid && fieldId && fieldArray.length > 0) {
            var field = fieldArray.find(function(f) {
              return f.id == fieldId || f.position == fieldId;
            });
            if (field) {
              // field.type is "wood"/"clay"/"iron"/"crop", convert to gid
              gid = field.gid || resTypeToGid[field.type] || null;
              level = field.level || 0;
            }
          }

          if (gid) {
            var keyR = GameData.gidToKey(Number(gid));
            if (keyR) cost = GameData.getUpgradeCost(keyR, level);
          }

        } else if (task.type === 'upgrade_building' && task.params) {
          // Upgrade building: params have { slot } — look up gid from gameState
          var slot = task.params.slot || task.params.buildingSlot;
          var gidB = task.params.gid || task.params.buildingGid;
          var levelB = task.params.level || task.params.currentLevel || 0;

          if (!gidB && slot && gameState.buildings) {
            // Note: domScanner.getBuildings returns { id: gid, slot: slotId }
            // where 'id' is the building type (gid), not the slot number.
            // Match by slot only to avoid false matches.
            var building = gameState.buildings.find(function(b) {
              return b.slot == slot;
            });
            if (building) {
              gidB = building.id; // building.id IS the gid (building type)
              levelB = building.level || 0;
            }
          }

          if (gidB) {
            var keyB = GameData.gidToKey(Number(gidB));
            if (keyB) cost = GameData.getUpgradeCost(keyB, levelB);
          }
        }

        if (!cost) {
          // Fallback: when we can't look up the exact cost, use a capacity-based
          // deficit instead of returning null (which would block the claim entirely).
          // Fill each resource to 50% of warehouse capacity — enough for most upgrades.
          _getLogger().log('WARN', '[HeroManager] calcResourceDeficit: could not determine cost for ' + task.type + ' ' + JSON.stringify(task.params) + ' — using capacity-based fallback');
          var capFb = gameState.resourceCapacity || {};
          var wCapFb = capFb.warehouse || 8000;
          var gCapFb = capFb.granary || wCapFb;
          var targetFillFb = 0.5;
          return {
            wood: Math.max(0, Math.floor(wCapFb * targetFillFb) - (current.wood || 0)),
            clay: Math.max(0, Math.floor(wCapFb * targetFillFb) - (current.clay || 0)),
            iron: Math.max(0, Math.floor(wCapFb * targetFillFb) - (current.iron || 0)),
            crop: Math.max(0, Math.floor(gCapFb * targetFillFb) - (current.crop || 0))
          };
        }

        var deficit = {
          wood: Math.max(0, (cost.wood || 0) - (current.wood || 0)),
          clay: Math.max(0, (cost.clay || 0) - (current.clay || 0)),
          iron: Math.max(0, (cost.iron || 0) - (current.iron || 0)),
          crop: Math.max(0, (cost.crop || 0) - (current.crop || 0))
        };
        _getLogger().log('DEBUG', '[HeroManager] calcResourceDeficit: cost=' + JSON.stringify(cost) + ' current=' + JSON.stringify(current) + ' deficit=' + JSON.stringify(deficit));
        return deficit;
      } catch (e) {
        _getLogger().log('WARN', '[HeroManager] calcResourceDeficit error: ' + e.message);
        // Even on exception, try capacity-based fallback
        try {
          var current2 = (gameState && gameState.resources) || {};
          var cap2 = (gameState && gameState.resourceCapacity) || {};
          var wCap2 = cap2.warehouse || 8000;
          var gCap2 = cap2.granary || wCap2;
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
     * Set the claim cooldown timestamp.
     * @param {number} ms - Cooldown duration in milliseconds from now
     */
    setCooldown(ms) {
      this._claimCooldown = Date.now() + ms;
    }

    /**
     * Get the current cooldown expiry timestamp.
     * @returns {number} Epoch milliseconds when cooldown expires
     */
    getCooldown() {
      return this._claimCooldown;
    }

    // -----------------------------------------------------------------------
    // Private: V1 and V2 claim paths
    // -----------------------------------------------------------------------

    /**
     * Bulk transfer hero resources using the V2 unified dialog.
     * (Post-Changelog-367 — transfers all 4 resource types at once)
     * @private
     */
    async _claimResourcesV2(deficit, usableResources) {
      var itemClassToRes = {
        item145: 'wood', item176: 'wood',
        item146: 'clay', item177: 'clay',
        item147: 'iron', item178: 'iron',
        item148: 'crop', item179: 'crop'
      };

      // Build amounts map: for each resource type, min(deficit, available)
      var amounts = { wood: 0, clay: 0, iron: 0, crop: 0 };
      for (var i = 0; i < usableResources.length; i++) {
        var item = usableResources[i];
        var resType = null;
        var cls = item.itemClass || '';
        var entries = Object.entries(itemClassToRes);
        for (var j = 0; j < entries.length; j++) {
          if (cls.indexOf(entries[j][0]) !== -1) { resType = entries[j][1]; break; }
        }
        if (!resType) continue;

        var needed = deficit[resType] || 0;
        if (needed <= 0) continue;

        var available = parseInt(item.count) || 0;
        var transferAmount = Math.min(Math.ceil(needed), available);
        if (transferAmount <= 0) continue;

        // Accumulate (in case multiple items map to same resource type)
        amounts[resType] = Math.max(amounts[resType], transferAmount);
      }

      var totalTransfer = amounts.wood + amounts.clay + amounts.iron + amounts.crop;
      if (totalTransfer <= 0) {
        _getLogger().log('INFO', '[HeroManager] V2: no resources to transfer');
        return false;
      }

      _getLogger().log('INFO', '[HeroManager] V2 bulk transfer: ' + JSON.stringify(amounts));

      var bulkResult = await this._bridge.send({
        type: 'EXECUTE', action: 'useHeroItemBulk',
        params: { amounts: amounts }
      });

      if (bulkResult && bulkResult.success) {
        _getLogger().log('INFO', '[HeroManager] V2 bulk hero resource claim successful');
        return true;
      } else {
        // Bulk transfer failed — no fallback available
        var reason = (bulkResult && bulkResult.reason) || 'unknown';
        _getLogger().log('WARN', '[HeroManager] V2 bulk transfer failed: ' + reason);
        return false;
      }
    }
  }

  root.TravianHeroManager = HeroManager;
})();
