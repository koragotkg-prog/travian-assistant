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

      // Wire EventBus → Chrome notifications for critical events
      this._wireNotifications(engine, serverKey);

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
    async remove(serverKey) {
      var instance = this.instances.get(serverKey);
      if (!instance) return;

      if (instance.engine.running) {
        await instance.engine.stop();
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
    async stopAll() {
      var stopPromises = [];
      for (var inst of this.instances.values()) {
        if (inst.engine.running) {
          stopPromises.push(inst.engine.stop());
        }
      }
      await Promise.allSettled(stopPromises);
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

    /**
     * Wire Chrome notifications to EventBus events.
     * Shows desktop alerts for time-critical events (attacks, crop crisis).
     *
     * @param {TravianBotEngine} engine
     * @param {string} serverKey
     */
    _wireNotifications(engine, serverKey) {
      if (!engine.eventBus) return;
      if (typeof chrome === 'undefined' || !chrome.notifications) return;

      var Events = self.TravianEventBus ? self.TravianEventBus.Events : {};
      var shortKey = serverKey.split('.')[0] || serverKey; // e.g., 'ts5' from 'ts5.x1.asia.travian.com'

      // ── Incoming attack notification ──────────────────────
      if (Events.ATTACK_INCOMING) {
        engine.eventBus.on(Events.ATTACK_INCOMING, function(data) {
          var count = data.count || 1;
          var soonest = data.soonest;
          var timeStr = soonest && soonest.timer ? soonest.timer : 'unknown';
          var attacker = soonest && soonest.attackerName ? soonest.attackerName : 'Unknown';

          var title = '⚔️ INCOMING ATTACK! [' + shortKey + ']';
          var message = count + (count === 1 ? ' attack' : ' attacks') + ' incoming!\n' +
            'Attacker: ' + attacker + '\n' +
            'Arrives in: ' + timeStr;

          try {
            chrome.notifications.create('attack_' + serverKey + '_' + Date.now(), {
              type: 'basic',
              iconUrl: '../icons/icon48.png',
              title: title,
              message: message,
              priority: 2, // max urgency
              requireInteraction: true // don't auto-dismiss
            });
          } catch (e) {
            console.warn('[InstanceManager] Notification failed:', e.message);
          }
        }, { priority: 1 }); // highest priority
      }

      // ── Crop crisis notification ──────────────────────────
      if (Events.CROP_CRISIS) {
        engine.eventBus.on(Events.CROP_CRISIS, function(data) {
          try {
            chrome.notifications.create('crop_' + serverKey + '_' + Date.now(), {
              type: 'basic',
              iconUrl: '../icons/icon48.png',
              title: '🌾 CROP CRISIS! [' + shortKey + ']',
              message: 'Free crop: ' + (data.freeCrop || 0) +
                '\nTroops may start dying. Upgrade croplands or sell troops!',
              priority: 2,
              requireInteraction: true
            });
          } catch (e) {
            console.warn('[InstanceManager] Notification failed:', e.message);
          }
        }, { priority: 1 });
      }
    }
  }

  // Export for service worker
  var _global = typeof window !== 'undefined' ? window : self;
  _global.TravianInstanceManager = TravianInstanceManager;
})();
