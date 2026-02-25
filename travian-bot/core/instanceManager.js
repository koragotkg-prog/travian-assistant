/**
 * Travian Bot - Instance Manager
 *
 * Manages multiple BotEngine instances, one per Travian server.
 * Each instance is bound to a specific server (by hostname) and tab.
 * Runs in the service worker context.
 */

(function () {
  'use strict';

  class TravianInstanceManager {
    constructor() {
      // Map<serverKey, { engine: TravianBotEngine, tabId: number, serverKey: string }>
      this.instances = new Map();
    }

    /**
     * Get or create a bot instance for a server.
     * @param {string} serverKey - Server hostname
     * @returns {{ engine: TravianBotEngine, tabId: number, serverKey: string }}
     */
    getOrCreate(serverKey) {
      if (this.instances.has(serverKey)) {
        return this.instances.get(serverKey);
      }

      var engine = new self.TravianBotEngine();
      engine.serverKey = serverKey;

      var instance = {
        engine: engine,
        tabId: null,
        serverKey: serverKey
      };

      this.instances.set(serverKey, instance);
      console.log('[InstanceManager] Created instance for ' + serverKey);
      return instance;
    }

    /**
     * Find an instance by its bound tab ID.
     * @param {number} tabId
     * @returns {{ engine, tabId, serverKey }|null}
     */
    getByTabId(tabId) {
      for (var inst of this.instances.values()) {
        if (inst.tabId === tabId) return inst;
      }
      return null;
    }

    /**
     * Get an instance by server key.
     * @param {string} serverKey
     * @returns {{ engine, tabId, serverKey }|null}
     */
    get(serverKey) {
      return this.instances.get(serverKey) || null;
    }

    /**
     * Remove and stop an instance.
     * @param {string} serverKey
     */
    remove(serverKey) {
      var instance = this.instances.get(serverKey);
      if (!instance) return;

      if (instance.engine.running) {
        instance.engine.stop();
      }

      // Clear per-server alarm
      try {
        if (typeof chrome !== 'undefined' && chrome.alarms) {
          chrome.alarms.clear('botHeartbeat__' + serverKey);
        }
      } catch (_) {}

      this.instances.delete(serverKey);
      console.log('[InstanceManager] Removed instance for ' + serverKey);
    }

    /**
     * List all active instances for popup display.
     * @returns {Array<{ serverKey, tabId, running, paused, stats }>}
     */
    listActive() {
      var list = [];
      for (var inst of this.instances.values()) {
        list.push({
          serverKey: inst.serverKey,
          tabId: inst.tabId,
          running: inst.engine.running,
          paused: inst.engine.paused,
          stats: inst.engine.stats
        });
      }
      return list;
    }

    /**
     * Stop all running instances.
     */
    stopAll() {
      for (var inst of this.instances.values()) {
        if (inst.engine.running) {
          inst.engine.stop();
        }
      }
      console.log('[InstanceManager] All instances stopped');
    }

    /**
     * Get count of active (running) instances.
     * @returns {number}
     */
    runningCount() {
      var count = 0;
      for (var inst of this.instances.values()) {
        if (inst.engine.running) count++;
      }
      return count;
    }
  }

  // Export for service worker
  var _global = typeof window !== 'undefined' ? window : self;
  _global.TravianInstanceManager = TravianInstanceManager;
})();
