// core/gameStateCollector.js — Enriched multi-page game state
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class GameStateCollector {
    constructor() {
      this._cachedExtras = {}; // quest data, trap info, etc.
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

  }

  root.TravianGameStateCollector = GameStateCollector;
})();
