/**
 * NavigationManager — Handles dorf1/dorf2 navigation and building cache management.
 *
 * Extracted from BotEngine to centralize:
 *   - Building cache state (_cachedBuildings, _buildingsScanCycle, _buildQueueEarliestFinish)
 *   - _shouldRefreshBuildings() heuristic
 *   - Dorf2 scan-and-return logic (navigate to dorf2, scan, cache, navigate back)
 *   - navigateAndWait() — the repeated 3-step pattern: send navigate → delay → waitForReady
 *
 * Dependencies (must be loaded before this file):
 *   - self.TravianContentScriptBridge (core/contentScriptBridge.js)
 *
 * Runs in service worker context (no DOM, no window).
 */
(function() {
  'use strict';
  var root = typeof window !== 'undefined' ? window : self;

  class NavigationManager {
    /**
     * @param {object} bridge - ContentScriptBridge instance (send, waitForReady)
     * @param {function} logger - Structured log function: logger(level, message, meta)
     */
    constructor(bridge, logger) {
      this._bridge = bridge;
      this._log = logger || function() {};

      // Cached buildings data from dorf2 scans.
      // getBuildings() only works on dorf2 but the bot rests on dorf1.
      // We cache the last dorf2 scan and refresh when a build timer expires or after max staleness.
      this._cachedBuildings = null;
      this._buildingsScanCycle = 0;       // last cycle that scanned dorf2
      this._buildQueueEarliestFinish = 0; // ms epoch: when the earliest queued build completes
    }

    // -------------------------------------------------------------------------
    // Navigation helpers
    // -------------------------------------------------------------------------

    /**
     * Navigate to a page, wait for a human-like delay, then wait for content script ready.
     *
     * Wraps the repeated 3-step pattern found throughout BotEngine and task handlers:
     *   1. Send navigateTo EXECUTE message
     *   2. Wait a random delay (caller-provided delayFn)
     *   3. Wait for content script to be ready after page reload
     *
     * @param {string} page - Page name for navigateTo (e.g., 'dorf1', 'dorf2', 'barracks')
     * @param {function} [delayFn] - Async function that provides a human-like delay
     * @param {number} [waitMs=15000] - Max time to wait for content script ready
     * @returns {Promise<void>}
     */
    async navigateAndWait(page, delayFn, waitMs) {
      await this._bridge.send({
        type: 'EXECUTE', action: 'navigateTo', params: { page: page }
      });
      if (delayFn) await delayFn();
      await this._bridge.waitForReady(waitMs || 15000);
    }

    // -------------------------------------------------------------------------
    // Building cache heuristics
    // -------------------------------------------------------------------------

    /**
     * Decide whether to refresh cached buildings from dorf2.
     * Event-driven: triggers when a build queue timer has expired since the last
     * scan, or after a maximum staleness window (20 cycles) as a safety net.
     *
     * @param {number} cycleCounter - Current bot cycle counter
     * @param {object} gameState - Current game state (for constructionQueue check)
     * @returns {boolean}
     */
    shouldRefreshBuildings(cycleCounter, gameState) {
      // Always scan if we have no cache at all
      if (!this._cachedBuildings) return true;

      // Check if any build queue timer has expired since last scan.
      // _buildQueueEarliestFinish is an absolute ms-epoch timestamp captured
      // when we last scanned dorf2's construction queue.
      if (this._buildQueueEarliestFinish > 0 && Date.now() >= this._buildQueueEarliestFinish) {
        return true;
      }

      // Also check the live constructionQueue from the most recent dorf1 scan —
      // it may have been updated more recently than the cached dorf2 value.
      var queue = gameState && gameState.constructionQueue;
      if (queue && queue.earliestFinishTime > 0 && Date.now() >= queue.earliestFinishTime) {
        return true;
      }

      // Fallback: max staleness of 20 cycles (~5-10 min at typical intervals)
      var staleness = cycleCounter - this._buildingsScanCycle;
      return staleness >= 20;
    }

    // -------------------------------------------------------------------------
    // Dorf2 scan + cache
    // -------------------------------------------------------------------------

    /**
     * Navigate to dorf2, scan buildings, cache the result, and navigate back to dorf1.
     * This is the full dorf2 scan cycle used during the main loop.
     *
     * @param {number} cycleCounter - Current bot cycle counter
     * @param {object} gameState - Game state to update with dorf2 constructionQueue
     * @param {function} delayFn - Async function that provides a human-like delay
     * @returns {Promise<void>}
     */
    async scanBuildings(cycleCounter, gameState, delayFn) {
      try {
        this._log('DEBUG', 'Scanning dorf2 for buildings data');

        await this.navigateAndWait('dorf2', delayFn);

        var dorf2Scan = await this._bridge.send({ type: 'SCAN' });
        if (dorf2Scan && dorf2Scan.success && dorf2Scan.data &&
            dorf2Scan.data.buildings && dorf2Scan.data.buildings.length > 0) {
          this._cachedBuildings = dorf2Scan.data.buildings;
          this._buildingsScanCycle = cycleCounter;
          this._log('INFO', 'Cached ' + this._cachedBuildings.length + ' buildings from dorf2');

          // Also update construction queue from dorf2 (more accurate)
          if (dorf2Scan.data.constructionQueue) {
            gameState.constructionQueue = dorf2Scan.data.constructionQueue;
            // Capture earliest finish time so shouldRefreshBuildings() can
            // trigger the next scan when a build completes.
            this._buildQueueEarliestFinish = dorf2Scan.data.constructionQueue.earliestFinishTime || 0;
          } else {
            this._buildQueueEarliestFinish = 0;
          }
        }
      } catch (e) {
        this._log('WARN', 'Dorf2 buildings scan failed: ' + e.message);
      } finally {
        // Always navigate back to dorf1, even if scan failed
        try {
          await this._bridge.send({
            type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf1' }
          });
          await this._bridge.waitForReady(10000);
        } catch (_) { /* best effort */ }
      }
    }

    /**
     * Navigate to dorf2, scan buildings, cache the result (no navigate-back).
     * Used by _returnHome after building tasks — caller handles the final navigation.
     *
     * @param {number} cycleCounter - Current bot cycle counter
     * @param {function} delayFn - Async function that provides a human-like delay
     * @returns {Promise<void>}
     */
    async refreshBuildingsDetour(cycleCounter, delayFn) {
      if (delayFn) await delayFn();
      await this._bridge.send({
        type: 'EXECUTE', action: 'navigateTo', params: { page: 'dorf2' }
      });
      await this._bridge.waitForReady(10000);
      var dorf2Resp = await this._bridge.send({ type: 'SCAN' });
      if (dorf2Resp && dorf2Resp.success && dorf2Resp.data &&
          dorf2Resp.data.buildings && dorf2Resp.data.buildings.length > 0) {
        this._cachedBuildings = dorf2Resp.data.buildings;
        this._buildingsScanCycle = cycleCounter;
        // Update earliest finish time for event-driven scan trigger
        if (dorf2Resp.data.constructionQueue) {
          this._buildQueueEarliestFinish = dorf2Resp.data.constructionQueue.earliestFinishTime || 0;
        }
      }
    }

    // -------------------------------------------------------------------------
    // Cache accessors
    // -------------------------------------------------------------------------

    /**
     * Get the cached buildings array from the last dorf2 scan.
     * @returns {Array|null}
     */
    getCachedBuildings() {
      return this._cachedBuildings;
    }

    /**
     * Merge cached buildings into gameState if the current scan didn't get them.
     * Call this after the main scan to ensure gameState.buildings is populated.
     *
     * @param {object} gameState - Game state to patch
     */
    mergeCachedBuildings(gameState) {
      if (this._cachedBuildings && (!gameState.buildings || gameState.buildings.length === 0)) {
        gameState.buildings = this._cachedBuildings;
      }
    }
  }

  root.TravianNavigationManager = NavigationManager;
})();
