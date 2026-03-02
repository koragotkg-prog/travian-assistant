/**
 * ExecutionPolicyManager — Priority-sorted rule engine for action control.
 *
 * Policies are evaluated in priority order (lower = higher priority).
 * First matching policy determines the outcome (allow/block).
 *
 * Default policies:
 *   P1: CRITICAL risk blocks all
 *   P2: Safe mode blocks farming/troops/hero
 *   P3: HIGH/MEDIUM risk blocks offensive actions
 *   P4: Action-specific rate limits
 *   P5: Quiet hours (optional)
 *   P10: Default allow
 *
 * Exported: self.TravianExecutionPolicyManager
 */
(function(root) {
  'use strict';

  function TravianExecutionPolicyManager() {
    this._policies = [];
    this._loadDefaultPolicies();
  }

  /** Load the built-in policy ruleset */
  TravianExecutionPolicyManager.prototype._loadDefaultPolicies = function() {
    this._policies = [
      // Priority 1: Emergency blocks
      {
        name: 'block_on_critical_risk',
        priority: 1,
        condition: function(ctx) { return ctx.riskLevel === 'CRITICAL'; },
        effect: 'block',
        message: 'Risk level CRITICAL'
      },

      // Priority 2: Safe mode restrictions
      {
        name: 'safe_mode_block_farming',
        priority: 2,
        condition: function(ctx) { return ctx.safeMode && ctx.actionType === 'send_farm'; },
        effect: 'block',
        message: 'Farming blocked in safe mode'
      },
      {
        name: 'safe_mode_block_troops',
        priority: 2,
        condition: function(ctx) {
          return ctx.safeMode &&
            (ctx.actionType === 'train_troops' || ctx.actionType === 'train_traps');
        },
        effect: 'block',
        message: 'Troop training blocked in safe mode'
      },
      {
        name: 'safe_mode_block_hero',
        priority: 2,
        condition: function(ctx) {
          return ctx.safeMode && ctx.actionType === 'send_hero_adventure';
        },
        effect: 'block',
        message: 'Hero adventures blocked in safe mode'
      },

      // Priority 3: Risk-based throttling
      {
        name: 'high_risk_block_offensive',
        priority: 3,
        condition: function(ctx) {
          if (ctx.riskLevel !== 'HIGH') return false;
          var offensive = ['train_troops', 'train_traps', 'send_farm', 'send_hero_adventure'];
          return offensive.indexOf(ctx.actionType) !== -1;
        },
        effect: 'block',
        message: 'Offensive actions blocked at HIGH risk'
      },
      {
        name: 'medium_risk_block_farming',
        priority: 3,
        condition: function(ctx) {
          return ctx.riskLevel === 'MEDIUM' && ctx.actionType === 'send_farm';
        },
        effect: 'block',
        message: 'Farming throttled at MEDIUM risk'
      },

      // Priority 4: Rate limit enforcement
      {
        name: 'rate_limit_specific',
        priority: 4,
        condition: function(ctx) { return ctx.actionRateLimited === true; },
        effect: 'block',
        message: 'Rate limit reached for action type'
      },

      // Priority 5: Quiet hours (optional, only active if configured)
      {
        name: 'quiet_hours',
        priority: 5,
        condition: function(ctx) {
          if (!ctx.quietHours || !ctx.quietHours.enabled) return false;
          var hour = new Date().getHours();
          var start = ctx.quietHours.start;
          var end = ctx.quietHours.end;
          // Handle overnight ranges (e.g., 23-6)
          if (start <= end) {
            return hour >= start && hour < end;
          } else {
            return hour >= start || hour < end;
          }
        },
        effect: 'block',
        message: 'Quiet hours active'
      },

      // Priority 10: Default allow
      {
        name: 'default_allow',
        priority: 10,
        condition: function() { return true; },
        effect: 'allow',
        message: 'Allowed by default'
      }
    ];

    this._sortPolicies();
  };

  /** Sort policies by priority (ascending) */
  TravianExecutionPolicyManager.prototype._sortPolicies = function() {
    this._policies.sort(function(a, b) { return a.priority - b.priority; });
  };

  /**
   * Evaluate policies for a given action context.
   * First matching policy wins.
   *
   * @param {object} context - { actionType, riskLevel, safeMode, actionRateLimited, quietHours }
   * @returns {{ allowed: boolean, policy: string, message: string }}
   */
  TravianExecutionPolicyManager.prototype.evaluate = function(context) {
    for (var i = 0; i < this._policies.length; i++) {
      var policy = this._policies[i];
      try {
        if (policy.condition(context)) {
          return {
            allowed: policy.effect === 'allow',
            policy: policy.name,
            message: policy.message
          };
        }
      } catch (e) {
        // Policy evaluation error — skip this policy safely
        continue;
      }
    }
    // Fallthrough (should never reach here due to default_allow)
    return { allowed: true, policy: 'fallthrough', message: 'No policy matched' };
  };

  /**
   * Filter a list of new tasks through policy evaluation.
   * Tasks that fail policy are silently dropped (re-evaluated next cycle).
   *
   * @param {Array} tasks - Tasks from DecisionEngine
   * @param {object} context - Base context (risk, safeMode, etc.)
   * @returns {Array} Allowed tasks
   */
  TravianExecutionPolicyManager.prototype.filterTasks = function(tasks, context) {
    var allowed = [];
    for (var i = 0; i < tasks.length; i++) {
      var taskCtx = {};
      // Copy base context properties
      for (var key in context) {
        if (context.hasOwnProperty(key)) taskCtx[key] = context[key];
      }
      taskCtx.actionType = tasks[i].type;
      var result = this.evaluate(taskCtx);
      if (result.allowed) {
        allowed.push(tasks[i]);
      }
    }
    return allowed;
  };

  /**
   * Add a custom policy rule (inserted by priority order).
   * @param {{ name: string, priority: number, condition: function, effect: string, message: string }} policy
   */
  TravianExecutionPolicyManager.prototype.addPolicy = function(policy) {
    this._policies.push(policy);
    this._sortPolicies();
  };

  /**
   * Remove a custom policy by name.
   * @param {string} name
   */
  TravianExecutionPolicyManager.prototype.removePolicy = function(name) {
    this._policies = this._policies.filter(function(p) { return p.name !== name; });
  };

  // Policies are always reloaded from code — no serialization needed
  TravianExecutionPolicyManager.prototype.serialize = function() { return {}; };
  TravianExecutionPolicyManager.prototype.deserialize = function() {
    this._loadDefaultPolicies();
  };

  // Export
  root.TravianExecutionPolicyManager = TravianExecutionPolicyManager;

})(typeof window !== 'undefined' ? window : self);
