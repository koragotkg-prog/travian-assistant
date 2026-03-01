/**
 * EventBus — Pub/sub event system for decoupled module communication.
 *
 * Modules emit events (e.g., "attack:incoming") and other modules subscribe
 * without direct coupling. Listeners are priority-sorted and error-isolated.
 *
 * Usage:
 *   var bus = new TravianEventBus();
 *   bus.on('attack:incoming', handler, {priority: 1});
 *   bus.emit('attack:incoming', {arrivalTime: ...});
 *   bus.off('attack:incoming', handler);
 */
(function(root) {
  'use strict';

  function TravianEventBus() {
    /** @type {Object.<string, Array<{handler: Function, priority: number, once: boolean}>>} */
    this._listeners = {};
    /** @type {Array<{event: string, data: *, timestamp: number}>} */
    this._history = [];
  }

  /**
   * Subscribe to an event.
   * @param {string} event - Event name (use TravianEventBus.Events constants)
   * @param {Function} handler - Callback receiving event data
   * @param {Object} [opts] - Options: {priority: number (lower = first), once: boolean}
   * @returns {TravianEventBus} - Chainable
   */
  TravianEventBus.prototype.on = function(event, handler, opts) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push({
      handler: handler,
      priority: (opts && opts.priority) || 10,
      once: !!(opts && opts.once)
    });
    // Keep sorted by priority (lower = runs first)
    this._listeners[event].sort(function(a, b) { return a.priority - b.priority; });
    return this;
  };

  /**
   * Subscribe to an event, auto-unsubscribe after first fire.
   * @param {string} event
   * @param {Function} handler
   * @param {Object} [opts]
   * @returns {TravianEventBus}
   */
  TravianEventBus.prototype.once = function(event, handler, opts) {
    return this.on(event, handler, Object.assign({}, opts, { once: true }));
  };

  /**
   * Emit an event to all subscribers.
   * @param {string} event - Event name
   * @param {*} data - Event payload
   */
  TravianEventBus.prototype.emit = function(event, data) {
    // Record in history (ring buffer of 50)
    this._history.push({ event: event, data: data, timestamp: Date.now() });
    if (this._history.length > 50) this._history.shift();

    var listeners = this._listeners[event];
    if (!listeners || listeners.length === 0) return;

    var toRemove = [];
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i].handler(data);
        if (listeners[i].once) toRemove.push(i);
      } catch (e) {
        // Never let a listener crash the event bus
        console.warn('[EventBus] Handler error for ' + event + ':', e);
      }
    }

    // Remove one-shot listeners in reverse order to preserve indices
    for (var j = toRemove.length - 1; j >= 0; j--) {
      listeners.splice(toRemove[j], 1);
    }
  };

  /**
   * Unsubscribe a specific handler from an event.
   * @param {string} event
   * @param {Function} handler - Must be the same reference passed to on()
   */
  TravianEventBus.prototype.off = function(event, handler) {
    var listeners = this._listeners[event];
    if (!listeners) return;
    this._listeners[event] = listeners.filter(function(l) {
      return l.handler !== handler;
    });
  };

  /**
   * Remove all listeners for an event (or all events if no arg).
   * @param {string} [event] - If omitted, clears everything
   */
  TravianEventBus.prototype.removeAll = function(event) {
    if (event) {
      delete this._listeners[event];
    } else {
      this._listeners = {};
    }
  };

  /**
   * Get recent event history for debugging.
   * @param {number} [count=10]
   * @returns {Array}
   */
  TravianEventBus.prototype.getHistory = function(count) {
    var n = count || 10;
    return this._history.slice(-n);
  };

  // ── Event type constants ──────────────────────────────────────────
  TravianEventBus.Events = Object.freeze({
    OVERFLOW_IMMINENT:  'overflow:imminent',   // storage about to fill
    ATTACK_INCOMING:    'attack:incoming',      // troops heading our way
    QUEST_CLAIMABLE:    'quest:claimable',      // free rewards available
    RESOURCES_LOW:      'resources:low',        // can't afford queued tasks
    TASK_COMPLETED:     'task:completed',       // a task finished
    TASK_FAILED:        'task:failed',          // a task failed
    SCAN_COMPLETE:      'scan:complete',        // DOM scan finished
    PHASE_CHANGED:      'phase:changed',        // strategy phase shifted
    CROP_CRISIS:        'crop:crisis'           // free crop dangerously low
  });

  root.TravianEventBus = TravianEventBus;
})(typeof window !== 'undefined' ? window : self);
