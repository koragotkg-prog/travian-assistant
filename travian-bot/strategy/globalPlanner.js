/**
 * GlobalPlanner — Competitive Meta Strategy Layer for Travian Bot
 *
 * Provides multi-cycle strategic direction on top of the reactive
 * DecisionEngine + ActionScorer pipeline. Detects game phase, manages
 * strategic modes with hysteresis, maintains meta build orders, and
 * returns score multipliers that bias ActionScorer toward the current
 * strategic goal.
 *
 * Design principles:
 *   - Deterministic, no randomness (reproducible decisions)
 *   - Computationally cheap (runs every bot cycle)
 *   - Plain JavaScript, service worker compatible (no DOM, no window)
 *   - Enhances DecisionEngine, never replaces it
 *   - Anti-oscillation via phase locks, mode hysteresis, plan persistence
 *
 * Runs in service worker context. Exported via self.TravianGlobalPlanner.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Phase & Mode Constants
// ─────────────────────────────────────────────────────────────────────────────

var PHASES = ['BOOTSTRAP', 'EARLY_ECON', 'EXPANSION_WINDOW', 'MILITARY_BUILDUP', 'POWER_SPIKE', 'DEFENSIVE_STABILIZE'];

var MODES = {
  ECON_FOCUS:     'ECON_FOCUS',
  EXPAND_FOCUS:   'EXPAND_FOCUS',
  MILITARY_FOCUS: 'MILITARY_FOCUS',
  DEFENSE_FOCUS:  'DEFENSE_FOCUS',
  BALANCE_MODE:   'BALANCE_MODE'
};

// Phase → default mode mapping
var PHASE_DEFAULT_MODE = {
  BOOTSTRAP:            MODES.ECON_FOCUS,
  EARLY_ECON:           MODES.ECON_FOCUS,
  EXPANSION_WINDOW:     MODES.EXPAND_FOCUS,
  MILITARY_BUILDUP:     MODES.MILITARY_FOCUS,
  POWER_SPIKE:          MODES.MILITARY_FOCUS,
  DEFENSIVE_STABILIZE:  MODES.DEFENSE_FOCUS
};

// ─────────────────────────────────────────────────────────────────────────────
// Score Multiplier Tables (mode → action type → multiplier)
// ─────────────────────────────────────────────────────────────────────────────

var MODE_MULTIPLIERS = {
  ECON_FOCUS: {
    upgrade_resource: 1.5,
    upgrade_building: 1.2,
    train_troops:     0.3,
    send_farm:        1.2,
    build_new:        1.0,
    send_hero_adventure: 1.0,
    build_traps:      0.8
  },
  EXPAND_FOCUS: {
    upgrade_resource: 0.8,
    upgrade_building: 1.5,
    train_troops:     0.5,
    send_farm:        1.0,
    build_new:        1.5,
    send_hero_adventure: 0.8,
    build_traps:      0.5
  },
  MILITARY_FOCUS: {
    upgrade_resource: 0.5,
    upgrade_building: 0.7,
    train_troops:     2.0,
    send_farm:        1.5,
    build_new:        0.8,
    send_hero_adventure: 1.2,
    build_traps:      0.5
  },
  DEFENSE_FOCUS: {
    upgrade_resource: 0.5,
    upgrade_building: 1.5,
    train_troops:     1.5,
    send_farm:        0.5,
    build_new:        0.8,
    send_hero_adventure: 0.5,
    build_traps:      2.0
  },
  BALANCE_MODE: {
    upgrade_resource: 1.0,
    upgrade_building: 1.0,
    train_troops:     1.0,
    send_farm:        1.0,
    build_new:        1.0,
    send_hero_adventure: 1.0,
    build_traps:      1.0
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Meta Build Order Templates
// ─────────────────────────────────────────────────────────────────────────────
// GID Reference (from shared/constants.js):
//   1=Woodcutter, 2=Clay Pit, 3=Iron Mine, 4=Crop Field
//   10=Warehouse, 11=Granary, 13=Armoury, 15=Main Building
//   16=Rally Point, 19=Barracks, 20=Stable, 22=Academy
//   23=Cranny, 25=Residence, 33=Palisade (Gaul wall)
//
// Plan steps specify WHAT to build, not WHICH specific field/slot.
// gid is used to match. When multiple fields match, pick lowest-level one.

var PLAN_TEMPLATES = {};

PLAN_TEMPLATES['gaul_x1_capital'] = {
  name: 'gaul_x1_capital',
  tribe: 'gaul',
  steps: [
    // ── Day 1-2: Bootstrap (pop 0→30) ──
    { type: 'upgrade_resource', gid: 4, targetLevel: 2, desc: 'Crop to 2' },
    { type: 'upgrade_resource', gid: 1, targetLevel: 2, desc: 'Wood to 2' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 2, desc: 'Clay to 2' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 2, desc: 'Iron to 2' },
    { type: 'upgrade_building', gid: 15, targetLevel: 1, desc: 'Main Building 1' },
    { type: 'upgrade_building', gid: 23, targetLevel: 1, desc: 'Cranny 1' },

    // ── Day 2-4: Early Econ (pop 30→80) ──
    { type: 'upgrade_resource', gid: 1, targetLevel: 4, desc: 'Wood to 4' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 4, desc: 'Clay to 4' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 4, desc: 'Iron to 4' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 4, desc: 'Crop to 4' },
    { type: 'upgrade_building', gid: 10, targetLevel: 3, desc: 'Warehouse 3' },
    { type: 'upgrade_building', gid: 11, targetLevel: 3, desc: 'Granary 3' },
    { type: 'upgrade_building', gid: 15, targetLevel: 3, desc: 'Main Building 3' },

    // ── Day 4-6: Expansion Prep (pop 80→150) ──
    { type: 'upgrade_resource', gid: 1, targetLevel: 6, desc: 'Wood to 6' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 6, desc: 'Clay to 6' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 6, desc: 'Iron to 6' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 6, desc: 'Crop to 6' },
    { type: 'upgrade_building', gid: 23, targetLevel: 5, desc: 'Cranny 5' },
    { type: 'upgrade_building', gid: 15, targetLevel: 5, desc: 'Main Building 5' },
    { type: 'upgrade_building', gid: 25, targetLevel: 1, desc: 'Residence 1' },

    // ── Day 6-8: Settler Rush ──
    { type: 'upgrade_building', gid: 25, targetLevel: 10, desc: 'Residence 10' },
    { type: 'upgrade_building', gid: 10, targetLevel: 5, desc: 'Warehouse 5' },
    { type: 'upgrade_building', gid: 11, targetLevel: 5, desc: 'Granary 5' },

    // ── Day 8-10: Military Foundation ──
    // Prerequisites: Barracks needs MB 3 + Rally Point 1
    //                Academy needs MB 3 + Barracks 3
    //                Stable needs Academy 5 + Barracks 3
    { type: 'upgrade_building', gid: 16, targetLevel: 1, desc: 'Rally Point 1' },
    { type: 'upgrade_building', gid: 19, targetLevel: 3, desc: 'Barracks 3' },
    { type: 'upgrade_building', gid: 22, targetLevel: 5, desc: 'Academy 5' },
    { type: 'upgrade_building', gid: 20, targetLevel: 1, desc: 'Stable 1' },
    { type: 'upgrade_building', gid: 20, targetLevel: 5, desc: 'Stable 5' },
  ]
};

PLAN_TEMPLATES['roman_x1_capital'] = {
  name: 'roman_x1_capital',
  tribe: 'roman',
  steps: [
    // ── Day 1-2: Bootstrap — Romans benefit from early MB (double build queue) ──
    { type: 'upgrade_resource', gid: 4, targetLevel: 2, desc: 'Crop to 2' },
    { type: 'upgrade_resource', gid: 1, targetLevel: 2, desc: 'Wood to 2' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 2, desc: 'Clay to 2' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 2, desc: 'Iron to 2' },
    { type: 'upgrade_building', gid: 15, targetLevel: 3, desc: 'Main Building 3 (unlocks double queue)' },
    { type: 'upgrade_building', gid: 23, targetLevel: 1, desc: 'Cranny 1' },

    // ── Day 2-4: Early Econ — leverage double queue to push resources + MB together ──
    { type: 'upgrade_resource', gid: 1, targetLevel: 4, desc: 'Wood to 4' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 4, desc: 'Clay to 4' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 4, desc: 'Iron to 4' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 4, desc: 'Crop to 4' },
    { type: 'upgrade_building', gid: 10, targetLevel: 3, desc: 'Warehouse 3' },
    { type: 'upgrade_building', gid: 11, targetLevel: 3, desc: 'Granary 3' },
    { type: 'upgrade_building', gid: 15, targetLevel: 5, desc: 'Main Building 5 (faster builds)' },

    // ── Day 4-6: Military Foundation — Romans use Legionnaire (infantry) for defense ──
    { type: 'upgrade_building', gid: 16, targetLevel: 1, desc: 'Rally Point 1' },
    { type: 'upgrade_building', gid: 19, targetLevel: 3, desc: 'Barracks 3' },
    { type: 'upgrade_building', gid: 22, targetLevel: 5, desc: 'Academy 5' },
    { type: 'upgrade_resource', gid: 1, targetLevel: 6, desc: 'Wood to 6' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 6, desc: 'Clay to 6' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 6, desc: 'Iron to 6' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 6, desc: 'Crop to 6' },

    // ── Day 6-8: Expansion Prep — Roman villages grow fast with double queue ──
    { type: 'upgrade_building', gid: 23, targetLevel: 5, desc: 'Cranny 5' },
    { type: 'upgrade_building', gid: 25, targetLevel: 1, desc: 'Residence 1' },
    { type: 'upgrade_building', gid: 25, targetLevel: 10, desc: 'Residence 10' },
    { type: 'upgrade_building', gid: 10, targetLevel: 5, desc: 'Warehouse 5' },
    { type: 'upgrade_building', gid: 11, targetLevel: 5, desc: 'Granary 5' },

    // ── Day 8-10: Cavalry — Equites Imperatoris for farming ──
    { type: 'upgrade_building', gid: 20, targetLevel: 1, desc: 'Stable 1' },
    { type: 'upgrade_building', gid: 20, targetLevel: 5, desc: 'Stable 5' },
  ]
};

PLAN_TEMPLATES['teuton_x1_capital'] = {
  name: 'teuton_x1_capital',
  tribe: 'teuton',
  steps: [
    // ── Day 1-2: Aggressive Bootstrap — rush Barracks for Clubswinger farming ──
    { type: 'upgrade_resource', gid: 4, targetLevel: 2, desc: 'Crop to 2' },
    { type: 'upgrade_resource', gid: 1, targetLevel: 2, desc: 'Wood to 2' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 2, desc: 'Clay to 2' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 2, desc: 'Iron to 2' },
    { type: 'upgrade_building', gid: 15, targetLevel: 1, desc: 'Main Building 1' },
    { type: 'upgrade_building', gid: 16, targetLevel: 1, desc: 'Rally Point 1' },
    { type: 'upgrade_building', gid: 19, targetLevel: 1, desc: 'Barracks 1 (Clubswinger ASAP)' },

    // ── Day 2-3: Economy + Cranny (Teutons are targets too) ──
    { type: 'upgrade_resource', gid: 1, targetLevel: 4, desc: 'Wood to 4' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 4, desc: 'Clay to 4' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 4, desc: 'Iron to 4' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 4, desc: 'Crop to 4' },
    { type: 'upgrade_building', gid: 23, targetLevel: 1, desc: 'Cranny 1' },
    { type: 'upgrade_building', gid: 10, targetLevel: 3, desc: 'Warehouse 3' },
    { type: 'upgrade_building', gid: 11, targetLevel: 3, desc: 'Granary 3' },

    // ── Day 3-5: Military Push — Barracks 3 for better troops, Academy for research ──
    { type: 'upgrade_building', gid: 15, targetLevel: 3, desc: 'Main Building 3' },
    { type: 'upgrade_building', gid: 19, targetLevel: 3, desc: 'Barracks 3' },
    { type: 'upgrade_building', gid: 22, targetLevel: 5, desc: 'Academy 5' },
    { type: 'upgrade_resource', gid: 1, targetLevel: 6, desc: 'Wood to 6' },
    { type: 'upgrade_resource', gid: 2, targetLevel: 6, desc: 'Clay to 6' },
    { type: 'upgrade_resource', gid: 3, targetLevel: 6, desc: 'Iron to 6' },
    { type: 'upgrade_resource', gid: 4, targetLevel: 6, desc: 'Crop to 6' },

    // ── Day 5-7: Expansion Prep — Teutons settle early to expand raiding reach ──
    { type: 'upgrade_building', gid: 15, targetLevel: 5, desc: 'Main Building 5' },
    { type: 'upgrade_building', gid: 23, targetLevel: 5, desc: 'Cranny 5' },
    { type: 'upgrade_building', gid: 25, targetLevel: 1, desc: 'Residence 1' },
    { type: 'upgrade_building', gid: 25, targetLevel: 10, desc: 'Residence 10' },
    { type: 'upgrade_building', gid: 10, targetLevel: 5, desc: 'Warehouse 5' },
    { type: 'upgrade_building', gid: 11, targetLevel: 5, desc: 'Granary 5' },

    // ── Day 7-9: Cavalry — Paladin for tanking, TK for raiding ──
    { type: 'upgrade_building', gid: 20, targetLevel: 1, desc: 'Stable 1' },
    { type: 'upgrade_building', gid: 20, targetLevel: 5, desc: 'Stable 5' },
  ]
};

// ─────────────────────────────────────────────────────────────────────────────
// Resource field type → GID mapping
// ─────────────────────────────────────────────────────────────────────────────
var FIELD_TYPE_TO_GID = { wood: 1, clay: 2, iron: 3, crop: 4 };

// ─────────────────────────────────────────────────────────────────────────────
// Hysteresis & Anti-Oscillation Constants
// ─────────────────────────────────────────────────────────────────────────────
var HYSTERESIS_CYCLES = 3;          // Consecutive cycles before mode switch
var MODE_LOCK_DURATION = 5 * 60000; // 5 minutes after mode switch
var PLAN_STEP_BONUS = 1.8;          // Score multiplier for matching plan step
var EXPANSION_LOCK_INDEX = 2;       // PHASES index of EXPANSION_WINDOW — no regression past this


// ═══════════════════════════════════════════════════════════════════════════════
// TravianGlobalPlanner Class
// ═══════════════════════════════════════════════════════════════════════════════

class TravianGlobalPlanner {

  constructor() {
    /** @type {string} Current strategic phase */
    this.phase = 'BOOTSTRAP';

    /** @type {string} Current strategic mode */
    this.mode = MODES.ECON_FOCUS;

    /** @type {number} Timestamp — prevent mode flipping until this time */
    this.modeLockUntil = 0;

    /** @type {number} Consecutive cycles the pending mode has been signaled */
    this.modeSignalCount = 0;

    /** @type {string|null} Mode being evaluated for hysteresis */
    this.pendingMode = null;

    /** @type {object|null} Active MetaPlan (tribe build order template) */
    this.activePlan = null;

    /** @type {number} Current step index in activePlan.steps */
    this.planStepIndex = 0;

    /** @type {number} Total bot cycles observed */
    this.cycleCount = 0;

    /** @type {Object<string, string>} Village role assignments {villageId: role} */
    this.villageRoles = {};

    /** @type {string[]} History of phase transitions for anti-regression */
    this.phaseHistory = [];

    /** @type {string|null} Emergency override: 'CROP_CRISIS'|'UNDER_ATTACK'|null */
    this.emergencyOverride = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main Entry Point
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Called once per bot cycle BEFORE ActionScorer.
   * Returns a MetaContext with score multipliers and strategic advice.
   *
   * @param {object} gameState - Current game state from content script scan
   * @param {object} config - Bot configuration
   * @returns {object} MetaContext
   */
  advise(gameState, config) {
    this.cycleCount++;

    // 1. Check emergencies (bypass all hysteresis)
    this.emergencyOverride = this._checkEmergency(gameState, config);

    // 2. Detect phase
    var prevPhase = this.phase;
    this.phase = this._detectPhase(gameState, config);
    if (this.phase !== prevPhase) {
      this.phaseHistory.push(this.phase);
      this._log('INFO', 'Phase transition: ' + prevPhase + ' → ' + this.phase);
    }

    // 3. Evaluate mode (with hysteresis)
    if (this.emergencyOverride) {
      this._applyEmergency(this.emergencyOverride);
    } else {
      this._evaluateMode(gameState, config);
    }

    // 3.5. Assign village roles (idempotent — only assigns unrecognized villages)
    this._assignVillageRoles(gameState);

    // 4. Select/advance plan
    this._ensureActivePlan(config);
    this._advancePlan(gameState);

    // 5. Build multipliers
    var currentStep = this._getCurrentPlanStep();
    var multipliers = this._buildMultipliers(this.mode, currentStep);

    // 6. Build advice string
    var planProgress = this.activePlan
      ? (this.planStepIndex + '/' + this.activePlan.steps.length)
      : 'No plan';
    var stepDesc = currentStep ? currentStep.desc : 'plan complete';
    var advice = 'Phase: ' + this.phase + ' | Mode: ' + this.mode
      + ' | Plan: ' + planProgress + ' — ' + stepDesc;
    if (this.emergencyOverride) {
      advice = '⚠ EMERGENCY: ' + this.emergencyOverride + ' | ' + advice;
    }

    return {
      phase: this.phase,
      mode: this.mode,
      multipliers: multipliers,
      planStep: currentStep,
      planProgress: planProgress,
      emergency: this.emergencyOverride,
      villageRole: this._getCurrentVillageRole(gameState),
      advice: advice
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase Detection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Score-based phase detection with anti-regression.
   * Never regresses past EXPANSION_WINDOW except for DEFENSIVE_STABILIZE.
   */
  _detectPhase(gameState, config) {
    var pop = this._estimatePop(gameState);
    var avgField = this._avgResourceFieldLevel(gameState);
    var villageCount = (gameState.villages || []).length || 1;
    var armySize = this._countArmy(gameState);
    var hasCranny = this._hasBuilding(gameState, 23);
    var hasAcademy = this._hasBuilding(gameState, 22);
    var hasStable = this._hasBuilding(gameState, 20);
    var threatLevel = config.threatLevel || 0;

    // Score each phase candidate
    var scores = {};

    // BOOTSTRAP: very early game, no cranny yet
    scores.BOOTSTRAP = (pop < 50 && !hasCranny) ? 100 : 0;

    // EARLY_ECON: fields below level 5 on average
    scores.EARLY_ECON = (pop < 200 && avgField < 5) ? (80 - avgField * 10) : 0;

    // EXPANSION_WINDOW: enough economy, need more villages
    scores.EXPANSION_WINDOW = (pop >= 100 && villageCount < 3) ? (70 + (pop > 150 ? 20 : 0)) : 0;

    // MILITARY_BUILDUP: have academy, army still small relative to pop
    scores.MILITARY_BUILDUP = (hasAcademy && armySize < pop * 0.5) ? (60 + (pop > 200 ? 20 : 0)) : 0;

    // POWER_SPIKE: army is significant
    scores.POWER_SPIKE = (armySize > pop * 0.5) ? (50 + (armySize > 100 ? 20 : 0)) : 0;

    // DEFENSIVE_STABILIZE: under threat
    scores.DEFENSIVE_STABILIZE = (threatLevel > 5) ? 90 : 0;

    // Anti-regression: phase can only advance forward, never regress.
    // Exception: DEFENSIVE_STABILIZE can activate from any phase.
    var currentIdx = PHASES.indexOf(this.phase);
    var lockIdx = currentIdx; // Only consider phases at or beyond current

    var best = this.phase;
    var bestScore = 0;

    for (var i = 0; i < PHASES.length; i++) {
      var phase = PHASES[i];
      var score = scores[phase] || 0;

      // Allow this phase if:
      // (a) it's at or beyond our lock index, OR
      // (b) it's DEFENSIVE_STABILIZE (emergency can always fire)
      if (score > bestScore && (i >= lockIdx || phase === 'DEFENSIVE_STABILIZE')) {
        best = phase;
        bestScore = score;
      }
    }

    return best;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mode Evaluation with Hysteresis
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates strategic mode. Mode only changes after N consecutive cycles
   * signal the same new mode, preventing rapid oscillation.
   */
  _evaluateMode(gameState, config) {
    var candidateMode = this._suggestMode(gameState, config);

    // Same as current → reset hysteresis counter
    if (candidateMode === this.mode) {
      this.modeSignalCount = 0;
      this.pendingMode = null;
      return;
    }

    // Mode lock — recently switched, reject change
    if (Date.now() < this.modeLockUntil) {
      return;
    }

    // Hysteresis: accumulate signals
    if (candidateMode === this.pendingMode) {
      this.modeSignalCount++;
      if (this.modeSignalCount >= HYSTERESIS_CYCLES) {
        // Sustained signal — switch mode
        var prevMode = this.mode;
        this.mode = candidateMode;
        this.pendingMode = null;
        this.modeSignalCount = 0;
        this.modeLockUntil = Date.now() + MODE_LOCK_DURATION;
        this._log('INFO', 'Mode switch: ' + prevMode + ' → ' + this.mode + ' (locked ' + (MODE_LOCK_DURATION / 1000) + 's)');
      }
    } else {
      // New candidate — start counting
      this.pendingMode = candidateMode;
      this.modeSignalCount = 1;
    }
  }

  /**
   * Suggests what mode SHOULD be, based on phase + context signals.
   * This is the "raw signal" before hysteresis filtering.
   */
  _suggestMode(gameState, config) {
    // Default: follow phase mapping
    var suggested = PHASE_DEFAULT_MODE[this.phase] || MODES.BALANCE_MODE;

    // Contextual overrides:
    // If crop production is very low but not negative, bias toward econ
    var cropProd = this._getCropProduction(gameState);
    if (cropProd >= 0 && cropProd < 10 && this.phase !== 'BOOTSTRAP') {
      suggested = MODES.ECON_FOCUS;
    }

    // If many villages exist and army is tiny, push military
    var villageCount = (gameState.villages || []).length || 1;
    var armySize = this._countArmy(gameState);
    if (villageCount >= 3 && armySize < 20) {
      suggested = MODES.MILITARY_FOCUS;
    }

    return suggested;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Emergency Handling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check for emergency conditions that bypass hysteresis.
   * Returns override type string or null.
   */
  _checkEmergency(gameState, config) {
    // Crop negative → immediate crisis
    var cropProd = this._getCropProduction(gameState);
    if (cropProd < 0) {
      return 'CROP_CRISIS';
    }

    // Incoming attacks
    if (gameState.incomingAttacks && gameState.incomingAttacks.length > 0) {
      return 'UNDER_ATTACK';
    }

    return null;
  }

  /**
   * Apply emergency override — bypasses hysteresis, forces mode.
   */
  _applyEmergency(override) {
    var targetMode = this.mode;

    if (override === 'CROP_CRISIS') {
      targetMode = MODES.ECON_FOCUS;
    } else if (override === 'UNDER_ATTACK') {
      targetMode = MODES.DEFENSE_FOCUS;
    }

    if (targetMode !== this.mode) {
      this._log('WARN', 'Emergency override: ' + override + ' → forcing ' + targetMode);
      this.mode = targetMode;
      this.pendingMode = null;
      this.modeSignalCount = 0;
      // No lock — emergency can be overridden by another emergency
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Meta Build Order Management
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ensure we have an active plan for the current tribe.
   * Only selects a plan if none is active.
   */
  _ensureActivePlan(config) {
    if (this.activePlan) return;

    var tribe = (config.tribe || 'gaul').toLowerCase();
    var speed = config.serverSpeed || 1;
    var planKey = tribe + '_x' + speed + '_capital';

    if (PLAN_TEMPLATES[planKey]) {
      this.activePlan = PLAN_TEMPLATES[planKey];
      this.planStepIndex = 0;
      this._log('INFO', 'Activated plan: ' + planKey);
    }
    // No plan available for this tribe/speed — that's OK, planner
    // still provides phase/mode multipliers without a build order.
  }

  /**
   * Advance planStepIndex past completed steps.
   * A step is complete when any field/building of matching gid has reached targetLevel.
   */
  _advancePlan(gameState) {
    if (!this.activePlan) return;

    var steps = this.activePlan.steps;
    var advanced = false;

    while (this.planStepIndex < steps.length) {
      var step = steps[this.planStepIndex];
      if (this._isStepComplete(step, gameState)) {
        this.planStepIndex++;
        advanced = true;
      } else {
        break;
      }
    }

    if (advanced) {
      var remaining = steps.length - this.planStepIndex;
      this._log('DEBUG', 'Plan advanced to step ' + this.planStepIndex + '/' + steps.length
        + ' (' + remaining + ' remaining)');
    }
  }

  /**
   * Check if a single plan step is satisfied by current game state.
   */
  _isStepComplete(step, gameState) {
    if (step.type === 'upgrade_resource') {
      var fields = gameState.resourceFields || [];
      // Check if the LOWEST-level field of this type has reached targetLevel.
      // This ensures all fields of that resource type are upgraded before advancing.
      var matchingLevels = [];
      for (var i = 0; i < fields.length; i++) {
        var fGid = FIELD_TYPE_TO_GID[fields[i].type] || 0;
        if (fGid === step.gid) {
          matchingLevels.push(fields[i].level || 0);
        }
      }
      if (matchingLevels.length === 0) return false;
      var minLevel = Math.min.apply(null, matchingLevels);
      return minLevel >= step.targetLevel;
    }

    if (step.type === 'upgrade_building') {
      var buildings = gameState.buildings || [];
      for (var j = 0; j < buildings.length; j++) {
        // buildings[j].id IS the building type GID (per CLAUDE.md)
        if (buildings[j].id === step.gid && (buildings[j].level || 0) >= step.targetLevel) {
          return true;
        }
      }
      return false;
    }

    // One-shot steps (train_settlers, train_troops) — mark done after one cycle
    // The planner doesn't re-queue these; they're guidance, not commands
    return true;
  }

  /**
   * Get current plan step (or null if plan complete / no plan).
   */
  _getCurrentPlanStep() {
    if (!this.activePlan) return null;
    if (this.planStepIndex >= this.activePlan.steps.length) return null;
    return this.activePlan.steps[this.planStepIndex];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Score Multiplier Builder
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build the multiplier map for the current mode.
   * If there's an active plan step, add a bonus for matching actions.
   *
   * @param {string} mode - Current strategic mode
   * @param {object|null} planStep - Current plan step or null
   * @returns {object} Map of {actionType: multiplier}
   */
  _buildMultipliers(mode, planStep) {
    var base = MODE_MULTIPLIERS[mode] || MODE_MULTIPLIERS.BALANCE_MODE;
    // Clone so we don't mutate the constant
    var result = {};
    for (var key in base) {
      result[key] = base[key];
    }

    // Plan step bonus is applied in DecisionEngine per-action,
    // not here — we just pass the plan step in MetaContext
    // so DecisionEngine can check action.params.gid match.

    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Village Role Assignment
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Assign roles to villages based on characteristics.
   * For now, simple: first village = capital, rest = feeder.
   */
  _assignVillageRoles(gameState) {
    var villages = gameState.villages || [];
    if (villages.length === 0) return;

    for (var i = 0; i < villages.length; i++) {
      var vid = villages[i].id || villages[i].villageId || i;
      if (!this.villageRoles[vid]) {
        this.villageRoles[vid] = i === 0 ? 'capital' : 'feeder';
      }
    }
  }

  /**
   * Get role for the currently active village.
   */
  _getCurrentVillageRole(gameState) {
    var vid = gameState.currentVillageId;
    return vid ? (this.villageRoles[vid] || 'capital') : 'capital';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper Functions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Estimate total population from resource fields and buildings.
   */
  _estimatePop(gameState) {
    // Prefer direct value if available
    if (gameState.totalPopulation) return gameState.totalPopulation;

    // Rough estimate: sum of all field/building levels
    var pop = 0;
    var fields = gameState.resourceFields || [];
    for (var i = 0; i < fields.length; i++) {
      pop += fields[i].level || 0;
    }
    var buildings = gameState.buildings || [];
    for (var j = 0; j < buildings.length; j++) {
      pop += buildings[j].level || 0;
    }
    return pop;
  }

  /**
   * Average level of all resource fields.
   */
  _avgResourceFieldLevel(gameState) {
    var fields = gameState.resourceFields || [];
    if (fields.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < fields.length; i++) {
      sum += fields[i].level || 0;
    }
    return sum / fields.length;
  }

  /**
   * Count total army size from troop counts.
   */
  _countArmy(gameState) {
    var total = 0;
    var troops = gameState.troops;
    if (troops && typeof troops === 'object') {
      for (var k in troops) {
        total += troops[k] || 0;
      }
    }
    return total;
  }

  /**
   * Check if a building with given GID exists (any level).
   */
  _hasBuilding(gameState, gid) {
    var buildings = gameState.buildings || [];
    for (var i = 0; i < buildings.length; i++) {
      if (buildings[i].id === gid && (buildings[i].level || 0) > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get building level for a GID (highest if multiple exist).
   */
  _getBuildingLevel(gameState, gid) {
    var best = 0;
    var buildings = gameState.buildings || [];
    for (var i = 0; i < buildings.length; i++) {
      if (buildings[i].id === gid) {
        best = Math.max(best, buildings[i].level || 0);
      }
    }
    return best;
  }

  /**
   * Get crop production from gameState.
   */
  _getCropProduction(gameState) {
    var prod = gameState.production || gameState.resourceProduction || {};
    return prod.crop || prod[3] || 0;
  }

  /**
   * Structured logging via TravianLogger.
   */
  _log(level, message) {
    var Logger = typeof TravianLogger !== 'undefined' ? TravianLogger : null;
    if (Logger && Logger.log) {
      Logger.log(level, '[GlobalPlanner] ' + message);
    } else {
      console.log('[GlobalPlanner][' + level + '] ' + message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Persistence (Serialize / Deserialize)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Serialize planner state for chrome.storage persistence.
   * @returns {object} Plain object safe for JSON serialization
   */
  serialize() {
    return {
      phase: this.phase,
      mode: this.mode,
      modeLockUntil: this.modeLockUntil,
      modeSignalCount: this.modeSignalCount,
      pendingMode: this.pendingMode,
      planStepIndex: this.planStepIndex,
      planName: this.activePlan ? this.activePlan.name : null,
      cycleCount: this.cycleCount,
      villageRoles: this.villageRoles,
      phaseHistory: this.phaseHistory.slice(-20), // keep last 20 entries
      emergencyOverride: this.emergencyOverride,
      savedAt: Date.now()
    };
  }

  /**
   * Restore planner from saved state.
   * @param {object} data - Previously serialized state
   * @returns {TravianGlobalPlanner} Restored instance
   */
  static deserialize(data) {
    var p = new TravianGlobalPlanner();
    if (!data || typeof data !== 'object') return p;

    p.phase = data.phase || 'BOOTSTRAP';
    p.mode = data.mode || MODES.ECON_FOCUS;
    p.modeLockUntil = data.modeLockUntil || 0;
    p.modeSignalCount = data.modeSignalCount || 0;
    p.pendingMode = data.pendingMode || null;
    p.planStepIndex = data.planStepIndex || 0;
    p.cycleCount = data.cycleCount || 0;
    p.villageRoles = data.villageRoles || {};
    p.phaseHistory = data.phaseHistory || [];
    p.emergencyOverride = data.emergencyOverride || null;

    // Restore plan template by name
    if (data.planName && PLAN_TEMPLATES[data.planName]) {
      p.activePlan = PLAN_TEMPLATES[data.planName];
    }

    return p;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Export (IIFE-compatible, dual context)
// ─────────────────────────────────────────────────────────────────────────────
// Expose PLAN_STEP_BONUS on the class for DecisionEngine to reference
TravianGlobalPlanner.PLAN_STEP_BONUS = PLAN_STEP_BONUS;

(typeof self !== 'undefined' ? self
  : typeof window !== 'undefined' ? window
  : typeof global !== 'undefined' ? global
  : {}).TravianGlobalPlanner = TravianGlobalPlanner;
