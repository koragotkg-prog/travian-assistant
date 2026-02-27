// core/gameStateCollector.js — Enriched multi-page game state
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class GameStateCollector {
    constructor() {
      this._fullScanInterval = 5; // do full scan every N cycles
      this._cycleCount = 0;
      this._cachedExtras = {}; // quest data, trap info, etc.
    }

    /**
     * Determine if this cycle should do a full multi-page scan
     */
    shouldDoFullScan() {
      this._cycleCount++;
      return this._cycleCount >= this._fullScanInterval;
    }

    /**
     * Reset full scan counter after completing one
     */
    resetFullScanCounter() {
      this._cycleCount = 0;
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
     * Get the list of pages to scan in a full scan cycle
     * Returns array of {page, scanAction} to execute in order
     */
    getFullScanSequence() {
      return [
        { page: 'dorf1', action: 'fullScan', description: 'Resources + troops + queue' },
        { page: 'dorf2', action: 'fullScan', description: 'Buildings' },
        // These are optional scans — only when needed
        // { page: 'tasks', action: 'scanQuests', description: 'Quest progress' },
        // { page: 'heroInventory', action: 'scanHeroInventory', description: 'Hero items' },
      ];
    }
  }

  root.TravianGameStateCollector = GameStateCollector;
})();
