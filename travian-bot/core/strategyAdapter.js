/**
 * StrategyAdapter — Translates StrategyEngine analysis output into
 * ActionCandidate[] format compatible with ActionScorer's scoring pipeline.
 *
 * The StrategyEngine produces rich analysis (buildRanking, risk assessment,
 * troop plans, expansion readiness) but this data was previously display-only.
 * This adapter bridges the gap: it converts actionable analysis items into
 * task candidates that DecisionEngine can feed into the scoring/selection loop.
 *
 * Candidates from the adapter get a 0.8× score discount so direct ActionScorer
 * results take precedence, while strategy still influences priority ordering.
 *
 * Exported via self.TravianStrategyAdapter
 *
 * Dependencies:
 *   - self.TravianGameData (optional, for GID-to-key lookups)
 */
(function (root) {
  'use strict';

  /** Score multiplier applied to strategy-derived candidates */
  var STRATEGY_DISCOUNT = 0.8;

  function TravianStrategyAdapter() {}

  // ── Main Translation Method ────────────────────────────────────────

  /**
   * Translate StrategyEngine.analyze() output into ActionCandidate[].
   * Consumes structured analysis data (buildRanking, riskAssessment, troopStrategy)
   * and produces candidates in the same format ActionScorer outputs.
   *
   * @param {Object} analysis - Output from StrategyEngine.analyze()
   * @param {Object} gameState - Current game state from scan
   * @param {Object} config - Bot config
   * @param {Object} taskQueue - TaskQueue instance for dedup checks
   * @returns {Array<{type, params, score, reason, source}>}
   */
  TravianStrategyAdapter.prototype.translateRecommendations = function (
    analysis, gameState, config, taskQueue
  ) {
    if (!analysis) return [];

    var candidates = [];

    // 1. Build ranking → upgrade candidates
    if (Array.isArray(analysis.buildRanking)) {
      candidates = candidates.concat(
        this._buildCandidatesFromRanking(analysis.buildRanking, gameState, taskQueue)
      );
    }

    // 2. Risk assessment → defense candidates
    if (analysis.riskAssessment) {
      candidates = candidates.concat(
        this._defenseCandidates(analysis.riskAssessment, gameState, taskQueue)
      );
    }

    // 3. Troop strategy → training candidates
    if (analysis.troopStrategy && config.tribe) {
      candidates = candidates.concat(
        this._troopCandidates(analysis.troopStrategy, config, gameState, taskQueue)
      );
    }

    return candidates;
  };

  // ── Build Candidates ───────────────────────────────────────────────

  /**
   * Convert buildRanking items into upgrade task candidates.
   * Only includes affordable items not already in the queue.
   */
  TravianStrategyAdapter.prototype._buildCandidatesFromRanking = function (
    buildRanking, gameState, taskQueue
  ) {
    var candidates = [];

    for (var i = 0; i < buildRanking.length && i < 5; i++) {
      var item = buildRanking[i];
      if (!item || !item.affordable) continue;
      if (!item.slot && item.slot !== 0) continue;

      var taskType = item.type; // 'upgrade_resource' or 'upgrade_building'
      if (taskType !== 'upgrade_resource' && taskType !== 'upgrade_building') continue;

      // Dedup: skip if same type+slot already queued
      var hasPending = taskQueue.queue.some(function (t) {
        return t.type === taskType &&
          t.params && t.params.slot === item.slot &&
          t.status !== 'completed' && t.status !== 'failed';
      });
      if (hasPending) continue;

      // For upgrade_resource, params use fieldId; for upgrade_building, params use slot
      var params = taskType === 'upgrade_resource'
        ? { fieldId: item.slot }
        : { slot: item.slot };

      candidates.push({
        type: taskType,
        params: params,
        score: (item.score || 0) * STRATEGY_DISCOUNT,
        reason: 'strategy: ' + (item.reason || item.buildingKey + ' Lv.' + item.fromLevel),
        source: 'strategy_engine'
      });
    }

    return candidates;
  };

  // ── Defense Candidates ─────────────────────────────────────────────

  /**
   * When risk is HIGH or CRITICAL, produce wall/cranny upgrade candidates.
   */
  TravianStrategyAdapter.prototype._defenseCandidates = function (
    risk, gameState, taskQueue
  ) {
    if (!risk || (risk.riskLevel !== 'HIGH' && risk.riskLevel !== 'CRITICAL')) {
      return [];
    }

    var candidates = [];
    var buildings = gameState.buildings || [];

    // Find wall (GID 31=Earth Wall/Gauls, 32=City Wall/Romans, 33=Palisade/Teutons)
    var wallSlot = null;
    var wallLevel = -1;
    for (var i = 0; i < buildings.length; i++) {
      var gid = buildings[i].gid || buildings[i].id;
      if (gid >= 31 && gid <= 33 && (buildings[i].level || 0) > wallLevel) {
        wallSlot = buildings[i].slot;
        wallLevel = buildings[i].level || 0;
      }
    }

    if (wallSlot !== null && wallLevel < 20) {
      var hasPendingWall = taskQueue.queue.some(function (t) {
        return t.type === 'upgrade_building' &&
          t.params && t.params.slot === wallSlot &&
          t.status !== 'completed' && t.status !== 'failed';
      });

      if (!hasPendingWall) {
        var urgency = risk.riskLevel === 'CRITICAL' ? 80 : 40;
        candidates.push({
          type: 'upgrade_building',
          params: { slot: wallSlot },
          score: urgency * STRATEGY_DISCOUNT,
          reason: 'strategy: defense — ' + risk.riskLevel + ' risk, wall Lv.' + wallLevel,
          source: 'strategy_engine'
        });
      }
    }

    return candidates;
  };

  // ── Troop Candidates ───────────────────────────────────────────────

  /**
   * Produce troop training candidates from strategy troop plan.
   */
  TravianStrategyAdapter.prototype._troopCandidates = function (
    troopStrategy, config, gameState, taskQueue
  ) {
    if (!troopStrategy || !troopStrategy.primaryUnit || !troopStrategy.affordableCount) {
      return [];
    }

    // Skip if already have a pending train_troops task
    var hasPendingTroop = taskQueue.queue.some(function (t) {
      return t.type === 'train_troops' &&
        t.status !== 'completed' && t.status !== 'failed';
    });
    if (hasPendingTroop) return [];

    // Resolve tN input name from unit key
    var GD = root.TravianGameData || null;
    var inputName = (GD && GD.getInputName)
      ? GD.getInputName(config.tribe, troopStrategy.primaryUnit)
      : null;
    if (!inputName) return [];

    // Determine building from unit key
    var building = 'barracks';
    if (GD && GD.TROOP_BUILDINGS && GD.TROOP_BUILDINGS[troopStrategy.primaryUnit]) {
      building = GD.TROOP_BUILDINGS[troopStrategy.primaryUnit];
    }

    var score = 30; // Base troop score
    if (troopStrategy.phase === 'late') score = 50; // Higher priority in late game

    return [{
      type: 'train_troops',
      params: {
        troopType: inputName,
        buildingType: building,
        count: Math.min(troopStrategy.affordableCount, 10)
      },
      score: score * STRATEGY_DISCOUNT,
      reason: 'strategy: train ' + troopStrategy.primaryUnit +
        ' (' + (troopStrategy.reasoning || []).join('; ') + ')',
      source: 'strategy_engine'
    }];
  };

  // ── Export ──────────────────────────────────────────────────────────

  var target = (typeof self !== 'undefined') ? self :
               (typeof window !== 'undefined') ? window :
               (typeof global !== 'undefined') ? global : {};
  target.TravianStrategyAdapter = TravianStrategyAdapter;

})(typeof window !== 'undefined' ? window : self);
