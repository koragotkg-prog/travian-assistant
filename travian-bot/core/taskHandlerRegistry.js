/**
 * TaskHandlerRegistry — Declarative task handler registry with page metadata.
 *
 * Wraps the existing TravianTaskHandlers flat dispatch table with structured
 * metadata: requiredPage, batchable flag, and precondition checks. This enables
 * page-aware task batching (Task 2.2) without rewriting existing handlers.
 *
 * Each registered handler definition:
 *   {
 *     type: string,              // 'upgrade_resource'
 *     requiredPage: string,      // 'dorf1', 'dorf2', 'building', 'any', etc.
 *     batchable: boolean,        // can run multiple without returning home
 *     execute: async function,   // handler from TravianTaskHandlers
 *   }
 *
 * Backward compatibility: BotEngine checks registry first, falls back to
 * TravianTaskHandlers[type] if not registered.
 */
(function(root) {
  'use strict';

  function TaskHandlerRegistry() {
    /** @type {Object.<string, {type: string, requiredPage: string, batchable: boolean, execute: Function}>} */
    this._handlers = {};
  }

  /**
   * Register a handler definition.
   * @param {Object} definition
   */
  TaskHandlerRegistry.prototype.register = function(definition) {
    if (!definition || !definition.type) {
      console.warn('[TaskHandlerRegistry] Cannot register handler without type');
      return;
    }
    this._handlers[definition.type] = definition;
  };

  /**
   * Get handler definition by task type.
   * @param {string} type
   * @returns {Object|null}
   */
  TaskHandlerRegistry.prototype.get = function(type) {
    return this._handlers[type] || null;
  };

  /**
   * Get the required page for a task type.
   * @param {string} type
   * @returns {string|null} - Page name or null if unknown
   */
  TaskHandlerRegistry.prototype.getRequiredPage = function(type) {
    var h = this._handlers[type];
    return h ? h.requiredPage : null;
  };

  /**
   * Check if a task type can be batched with others on the same page.
   * @param {string} type
   * @returns {boolean}
   */
  TaskHandlerRegistry.prototype.isBatchable = function(type) {
    var h = this._handlers[type];
    return h ? !!h.batchable : false;
  };

  /**
   * Group tasks by their required page context.
   * Tasks sharing a page can be batched together (navigate once, execute all).
   *
   * @param {Array} tasks - Array of task objects with .type
   * @returns {Object.<string, Array>} - { 'dorf1': [task1, task2], 'building': [task3] }
   */
  TaskHandlerRegistry.prototype.groupByPage = function(tasks) {
    var groups = {};
    for (var i = 0; i < tasks.length; i++) {
      var page = this.getRequiredPage(tasks[i].type) || 'unknown';
      if (!groups[page]) groups[page] = [];
      groups[page].push(tasks[i]);
    }
    return groups;
  };

  /**
   * Get all registered task types.
   * @returns {string[]}
   */
  TaskHandlerRegistry.prototype.getTypes = function() {
    return Object.keys(this._handlers);
  };

  // ── Static factory: build registry from TravianTaskHandlers ─────────────

  /**
   * Auto-register all handlers from the flat TravianTaskHandlers object
   * with appropriate page metadata.
   *
   * @param {Object} handlers - TravianTaskHandlers object
   * @returns {TaskHandlerRegistry} - Populated registry
   */
  TaskHandlerRegistry.fromHandlers = function(handlers) {
    var registry = new TaskHandlerRegistry();
    if (!handlers) return registry;

    // Page metadata for each handler type.
    // requiredPage: which page the handler navigates to first
    //   - 'dorf1': resource overview
    //   - 'dorf2': village overview
    //   - 'building': specific build.php page (varies per task)
    //   - 'rallyPoint': rally point page
    //   - 'heroAdventures': hero adventures page
    //   - 'tasks': quest page
    //   - 'any': no specific page needed (can execute from anywhere)
    //
    // batchable: can run multiple tasks of this type without returning home?
    //   Most handlers navigate to a specific field/slot (different URL per task),
    //   so they're NOT batchable. Only train_troops on the SAME building is batchable.

    var metadata = {
      upgrade_resource: { requiredPage: 'dorf1',          batchable: false },
      upgrade_building: { requiredPage: 'dorf2',          batchable: false },
      train_troops:     { requiredPage: 'building',       batchable: true  },
      send_farm:        { requiredPage: 'any',            batchable: false },
      build_traps:      { requiredPage: 'dorf2',          batchable: false },
      send_hero_adventure: { requiredPage: 'heroAdventures', batchable: false },
      claim_quest:      { requiredPage: 'tasks',          batchable: true  },
      build_new:        { requiredPage: 'dorf2',          batchable: false },
      send_attack:      { requiredPage: 'rallyPoint',     batchable: false },
      switch_village:   { requiredPage: 'any',            batchable: false },
      navigate:         { requiredPage: 'any',            batchable: false },
      npc_trade:        { requiredPage: 'marketplace',    batchable: false },
      dodge_troops:     { requiredPage: 'rallyPoint',     batchable: false },
      parse_battle_reports: { requiredPage: 'reports',    batchable: false }
    };

    for (var type in handlers) {
      if (typeof handlers[type] !== 'function') continue;
      var meta = metadata[type] || { requiredPage: 'unknown', batchable: false };
      registry.register({
        type: type,
        requiredPage: meta.requiredPage,
        batchable: meta.batchable,
        execute: handlers[type]
      });
    }

    return registry;
  };

  root.TravianTaskHandlerRegistry = TaskHandlerRegistry;
})(typeof window !== 'undefined' ? window : self);
