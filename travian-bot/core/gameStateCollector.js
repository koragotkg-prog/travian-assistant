// core/gameStateCollector.js — Enriched multi-page game state with per-village snapshots
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class GameStateCollector {
    constructor() {
      this._cachedExtras = {}; // quest data, trap info, etc.
      this._villageSnapshots = {}; // keyed by villageId → last known state
    }

    /**
     * Merge cached extras into basic gameState
     */
    enrichGameState(gameState) {
      return {
        ...gameState,
        quests: this._cachedExtras.quests || null,
        trapperInfo: this._cachedExtras.trapperInfo || null,
        farmListStatus: this._cachedExtras.farmListStatus || null,
        heroInventory: this._cachedExtras.heroInventory || null,
      };
    }

    /**
     * Store scanned extras from full scan
     */
    updateExtras(extras) {
      this._cachedExtras = { ...this._cachedExtras, ...extras };
    }

    /**
     * Store a snapshot of village-specific state after a scan.
     * Used to remember resource/building state when cycling between villages.
     * @param {string} villageId
     * @param {object} gameState - Full scan result
     */
    storeVillageSnapshot(villageId, gameState) {
      if (!villageId) return;
      this._villageSnapshots[villageId] = {
        resources: gameState.resources,
        resourceCapacity: gameState.resourceCapacity,
        resourceProduction: gameState.resourceProduction,
        resourceFields: gameState.resourceFields,
        buildings: gameState.buildings,
        constructionQueue: gameState.constructionQueue,
        troops: gameState.troops,
        timestamp: Date.now()
      };
    }

    /**
     * Get the last known state for a village.
     * @param {string} villageId
     * @returns {object|null}
     */
    getVillageSnapshot(villageId) {
      return this._villageSnapshots[villageId] || null;
    }

    /**
     * Get all village IDs that have snapshots.
     * @returns {string[]}
     */
    getKnownVillages() {
      return Object.keys(this._villageSnapshots);
    }

    /**
     * Check if a village snapshot is older than maxAgeMs.
     * @param {string} villageId
     * @param {number} maxAgeMs
     * @returns {boolean}
     */
    isStale(villageId, maxAgeMs) {
      var snap = this._villageSnapshots[villageId];
      if (!snap) return true;
      return (Date.now() - snap.timestamp) > maxAgeMs;
    }

  }

  root.TravianGameStateCollector = GameStateCollector;
})();
