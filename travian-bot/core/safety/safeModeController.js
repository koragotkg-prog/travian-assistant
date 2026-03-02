/**
 * SafeModeController — Restricted operation state machine.
 *
 * When active:
 *   - Blocks: train_troops, train_traps, send_farm, send_hero_adventure
 *   - Allows: upgrade_resource, upgrade_building, build_new (with 2x cooldown)
 *   - Minimum duration: 15 minutes
 *   - Auto-recovery: risk LOW for 10 consecutive evaluations (after min duration)
 *   - Manual exit: user can override via popup
 *
 * Exported: self.TravianSafeModeController
 */
(function(root) {
  'use strict';

  var BLOCKED_ACTIONS = [
    'train_troops',
    'train_traps',
    'send_farm',
    'send_hero_adventure',
    'send_attack'
  ];

  function TravianSafeModeController() {
    this.active = false;
    this.enteredAt = null;
    this.reason = null;
    this.minDurationMs = 15 * 60 * 1000;     // 15 minutes
    this.autoRecoveryThreshold = 10;          // 10 consecutive LOW evaluations
  }

  /**
   * Enter safe mode.
   * @param {string} reason - Why safe mode was triggered
   */
  TravianSafeModeController.prototype.enter = function(reason) {
    if (this.active) return; // already in safe mode
    this.active = true;
    this.enteredAt = Date.now();
    this.reason = reason;
  };

  /**
   * Check if auto-recovery conditions are met.
   * Requires: min duration elapsed AND enough consecutive LOW risk readings.
   * @param {number} consecutiveLowCount - From RiskEvaluator
   * @returns {boolean} true if safe mode was exited
   */
  TravianSafeModeController.prototype.checkAutoRecovery = function(consecutiveLowCount) {
    if (!this.active) return false;

    var elapsed = Date.now() - this.enteredAt;
    if (elapsed < this.minDurationMs) return false;

    if (consecutiveLowCount >= this.autoRecoveryThreshold) {
      this.exit('auto_recovery');
      return true;
    }
    return false;
  };

  /**
   * Exit safe mode (manual or automatic).
   * @param {string} [reason] - Why we're exiting
   */
  TravianSafeModeController.prototype.exit = function(reason) {
    this.active = false;
    this.enteredAt = null;
    this.reason = null;
  };

  /**
   * Check if an action type is allowed in the current mode.
   * @param {string} actionType
   * @returns {boolean} true if allowed
   */
  TravianSafeModeController.prototype.isAllowed = function(actionType) {
    if (!this.active) return true;
    return BLOCKED_ACTIONS.indexOf(actionType) === -1;
  };

  /**
   * Get cooldown multiplier.
   * In safe mode, all actions run with 2x cooldown.
   * @returns {number} 1 (normal) or 2 (safe mode)
   */
  TravianSafeModeController.prototype.getCooldownMultiplier = function() {
    return this.active ? 2 : 1;
  };

  /**
   * Get remaining time in safe mode before auto-recovery is possible.
   * @returns {number} milliseconds remaining, or 0 if min duration passed
   */
  TravianSafeModeController.prototype.getRemainingMinDuration = function() {
    if (!this.active || !this.enteredAt) return 0;
    var elapsed = Date.now() - this.enteredAt;
    return Math.max(0, this.minDurationMs - elapsed);
  };

  // ---- Serialization ----

  TravianSafeModeController.prototype.serialize = function() {
    return {
      active: this.active,
      enteredAt: this.enteredAt,
      reason: this.reason
    };
  };

  TravianSafeModeController.prototype.deserialize = function(data) {
    if (!data) return;
    this.active = !!data.active;
    this.enteredAt = data.enteredAt || null;
    this.reason = data.reason || null;
  };

  // Export
  root.TravianSafeModeController = TravianSafeModeController;

})(typeof window !== 'undefined' ? window : self);
