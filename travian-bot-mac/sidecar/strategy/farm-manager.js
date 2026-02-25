'use strict';
/**
 * FarmManager — Smart farming target management (Task 16)
 *
 * Tracks per-target raid history to:
 *   - Score targets by net profit per trip (resources gained − troop losses)
 *   - Skip targets with loss rate above threshold
 *   - Select appropriate troop composition (fast for close, cheap for distant)
 *
 * Usage:
 *   const fm = new FarmManager(config);
 *   fm.updateFromRaidReport(report);
 *   const targets = fm.scoredTargets(availableTargets);
 */

const LOSS_SKIP_THRESHOLD = 3; // Skip target after N consecutive loss raids

class FarmManager {
  constructor(config = {}) {
    /** @type {Map<string, TargetStats>} */
    this.targets = new Map();

    this.config = {
      maxLossesBeforeSkip: config.maxLossesBeforeSkip || LOSS_SKIP_THRESHOLD,
      minProfitRatio:      config.minProfitRatio      || 0.2,  // 20% of possible loot
      reserveTroops:       config.reserveTroops        || 20,  // keep N troops home
    };
  }

  // ── Public API ──────────────────────────────────────────────────────

  /**
   * Update stats from a completed raid report.
   * @param {{ targetId: string, targetCoords: {x,y}, resourcesGained: number, troopsLost: number, troopsSent: number }} report
   */
  updateFromRaidReport(report) {
    if (!report || !report.targetId) return;
    const stats = this._getOrCreate(report.targetId);

    stats.totalRaids++;
    stats.totalResourcesGained += report.resourcesGained || 0;
    stats.totalTroopsLost      += report.troopsLost      || 0;
    stats.lastRaidTime = Date.now();

    if (report.coords) stats.coords = report.coords;

    const gained = report.resourcesGained || 0;
    const sent   = report.troopsSent      || 1;
    const lost   = report.troopsLost      || 0;

    // Track net value (resources gained - troop replacement cost estimate)
    const troopCost = lost * 200; // rough 200-res average per troop
    stats.lastNetValue = gained - troopCost;

    if (lost > 0) {
      stats.consecutiveLossRaids++;
    } else {
      stats.consecutiveLossRaids = 0;
    }

    // Exponential moving average of profit per trip
    const profit = gained / Math.max(1, sent);
    stats.avgProfitPerTroop = stats.avgProfitPerTroop === 0
      ? profit
      : stats.avgProfitPerTroop * 0.8 + profit * 0.2;
  }

  /**
   * Return targets sorted by score (highest first), filtering out bad targets.
   * @param {Array<{id: string, coords?: {x,y}, distance?: number}>} rawTargets
   * @returns {Array<{target, score, skip: boolean}>}
   */
  scoredTargets(rawTargets = []) {
    return rawTargets
      .map(t => {
        const stats = this.targets.get(t.id || String(t.x) + ',' + String(t.y));
        const skip  = stats ? this.shouldSkipTarget(stats) : false;
        const score = stats ? this._scoreTarget(stats, t.distance || 5) : 50; // default mid score
        return { target: t, score, skip, stats };
      })
      .filter(r => !r.skip)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Determine whether a target should be skipped based on loss history.
   * @param {TargetStats|string} targetOrId
   */
  shouldSkipTarget(targetOrId) {
    const stats = typeof targetOrId === 'string'
      ? this.targets.get(targetOrId)
      : targetOrId;
    if (!stats) return false;
    return stats.consecutiveLossRaids >= this.config.maxLossesBeforeSkip;
  }

  /**
   * Select optimal troops for a raid given available counts.
   *
   * Strategy:
   * - Short distance (< 5 fields): fastest cavalry
   * - Long distance (≥ 5 fields):  cheapest infantry (preserve cavalry)
   * - Risky target (prev losses):  minimum viable force
   *
   * @param {{ x: number, y: number }} targetCoords
   * @param {{ infantry: number, cavalry: number }} availableTroops
   * @param {object} config
   * @returns {{ type: 'infantry'|'cavalry', count: number }}
   */
  selectTroops(targetCoords, availableTroops, config = {}) {
    const distance = targetCoords
      ? this._calcDistance(targetCoords, config.homeCoords || { x: 0, y: 0 })
      : 10;

    const reserveInf = this.config.reserveTroops;
    const reserveCav = Math.ceil(this.config.reserveTroops / 2);

    const availInf = Math.max(0, (availableTroops.infantry || 0) - reserveInf);
    const availCav = Math.max(0, (availableTroops.cavalry  || 0) - reserveCav);

    // Short distance → prefer cavalry for speed
    if (distance < 5 && availCav >= 5) {
      const count = Math.min(availCav, config.farmBatchSize || 20);
      return { type: 'cavalry', count };
    }

    // Default → infantry
    const count = Math.min(availInf, config.farmBatchSize || 20);
    if (count < 5) return null; // Not enough troops

    return { type: 'infantry', count };
  }

  /** Serialize stats for storage */
  toJSON() {
    const obj = {};
    for (const [id, stats] of this.targets.entries()) {
      obj[id] = stats;
    }
    return obj;
  }

  /** Restore stats from persisted JSON */
  fromJSON(data = {}) {
    for (const [id, stats] of Object.entries(data)) {
      this.targets.set(id, stats);
    }
    return this;
  }

  // ── Internals ────────────────────────────────────────────────────────

  _getOrCreate(targetId) {
    if (!this.targets.has(targetId)) {
      this.targets.set(targetId, {
        totalRaids: 0,
        totalResourcesGained: 0,
        totalTroopsLost: 0,
        consecutiveLossRaids: 0,
        avgProfitPerTroop: 0,
        lastNetValue: 0,
        lastRaidTime: null,
        coords: null,
      });
    }
    return this.targets.get(targetId);
  }

  /**
   * Score 0-100. Higher = better target.
   * Factors: avg profit/troop, distance penalty, loss penalty.
   */
  _scoreTarget(stats, distance) {
    const profitScore   = Math.min(100, stats.avgProfitPerTroop / 5);
    const distPenalty   = Math.min(30, distance * 3);
    const lossPenalty   = stats.consecutiveLossRaids * 15;
    return Math.max(0, profitScore - distPenalty - lossPenalty);
  }

  /** Manhattan-style distance for speed estimate */
  _calcDistance({ x: tx, y: ty }, { x: hx, y: hy }) {
    return Math.abs(tx - hx) + Math.abs(ty - hy);
  }
}

module.exports = FarmManager;
