# AI Bot Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix critical bugs and incrementally add a Hybrid AI scoring engine to the Travian Bot Chrome Extension.

**Architecture:** Layered scoring on existing engine — new `ActionScorer` and `GameStateCollector` modules sit on top of the existing `DecisionEngine`, `TaskQueue`, and `BotEngine`. Bug fixes come first, then scoring layer, then new features.

**Tech Stack:** Plain JavaScript (no ES modules), Chrome Extension Manifest V3, IIFE pattern for utils, `self.ClassName` exports for core modules.

---

## Task 1: Fix Duplicate Building — BuildQueueGuard in TaskQueue

**Files:**
- Modify: `travian-bot/core/taskQueue.js` (lines 83–100, `add()` method)
- Modify: `travian-bot/core/decisionEngine.js` (lines 605, 619, 658 — `hasTaskOfType` calls)

**Problem:**
1. `taskQueue.add()` has NO dedup — relies entirely on DecisionEngine's `hasTaskOfType()`
2. `hasTaskOfType('upgrade_building')` called without villageId → misses tasks with real villageId
3. Cranny rule at line 605 and `_evaluateNewBuilds` at line 619/658 both have this bug

**Step 1: Add dedup guard to `taskQueue.add()`**

In `taskQueue.js`, modify the `add()` method (around line 83) to check for duplicates before adding:

```javascript
add(type, params = {}, priority = 5, villageId = null, scheduledFor = null) {
  // BUILD QUEUE GUARD: prevent duplicate build tasks for same slot/field
  if (['upgrade_resource', 'upgrade_building', 'build_new'].includes(type)) {
    const targetKey = params.fieldId || params.slot || params.gid || null;
    if (targetKey) {
      const isDuplicate = this.queue.some(t =>
        t.type === type &&
        t.status !== 'completed' && t.status !== 'failed' &&
        (t.params.fieldId === targetKey || t.params.slot === targetKey)
      );
      if (isDuplicate) {
        TravianLogger.log('DEBUG', `[TaskQueue] Skipped duplicate ${type} for target ${targetKey}`);
        return null;
      }
    }
  }

  // FARM GUARD: prevent duplicate farm tasks
  if (type === 'send_farm') {
    const hasPendingFarm = this.queue.some(t =>
      t.type === 'send_farm' &&
      t.status !== 'completed' && t.status !== 'failed'
    );
    if (hasPendingFarm) {
      TravianLogger.log('DEBUG', '[TaskQueue] Skipped duplicate send_farm');
      return null;
    }
  }

  // ... existing add logic continues
```

**Step 2: Fix `hasTaskOfType` calls in DecisionEngine**

In `decisionEngine.js`, fix all `hasTaskOfType` calls to pass consistent villageId:

At line ~605 (cranny rule):
```javascript
// BEFORE:
if (taskQueue.hasTaskOfType('upgrade_building')) return null;
// AFTER:
if (taskQueue.hasTaskOfType('upgrade_building', null) ||
    taskQueue.hasTaskOfType('upgrade_building', gameState.currentVillageId)) return null;
```

At line ~619 and ~658 (_evaluateNewBuilds):
```javascript
// BEFORE:
if (taskQueue.hasTaskOfType('build_new')) return null;
// AFTER:
if (taskQueue.hasTaskOfType('build_new', null) ||
    taskQueue.hasTaskOfType('build_new', gameState.currentVillageId)) return null;
```

**Step 3: Fix malformed CSS selector in domScanner.js**

In `domScanner.js` at line ~644, fix the broken selector:
```javascript
// BEFORE:
if (qs('.plusFeature.active') || qs('.gold_club') || qs('.a]2') || qs('.finishNow')) {
// AFTER:
if (qs('.plusFeature.active') || qs('.gold_club') || qs('.a2') || qs('.finishNow')) {
```

**Step 4: Verify**

Test manually: Start the bot with an active build queue → confirm it does NOT try to upgrade the same building that's already being built. Check the logs for "Skipped duplicate" messages.

**Step 5: Commit**
```bash
git add travian-bot/core/taskQueue.js travian-bot/core/decisionEngine.js travian-bot/content/domScanner.js
git commit -m "fix: prevent duplicate build tasks with BuildQueueGuard

- Add slot/field dedup in taskQueue.add() for build tasks
- Fix hasTaskOfType villageId mismatch in decisionEngine
- Fix malformed CSS selector .a]2 in domScanner getConstructionQueue"
```

---

## Task 2: Fix Farm Sending Duplicates — FarmCooldownTracker

**Files:**
- Modify: `travian-bot/core/botEngine.js` (lines 361–389 `send_farm` execution, line 387 `lastFarmTime`)
- Modify: `travian-bot/core/decisionEngine.js` (lines 452–498 `evaluateFarming`)

**Problem:**
- `lastFarmTime` written to in-memory `gameState` object (line 387)
- But `gameState` is OVERWRITTEN every loop by fresh SCAN from content script (line 233)
- SCAN never includes `lastFarmTime` → it resets to 0 every cycle → farm triggers every loop
- Only protection is in-memory cooldown map, which is lost on service worker restart

**Step 1: Move `lastFarmTime` to persistent state in BotEngine**

In `botEngine.js`, add `lastFarmTime` to the BotEngine instance state (not gameState):

After `send_farm` success (around line 387):
```javascript
// BEFORE:
this.gameState.lastFarmTime = Date.now();
this.stats.farmRaidsSent++;

// AFTER:
this._lastFarmTime = Date.now();
this.stats.farmRaidsSent++;
```

In `saveState()` method, add `lastFarmTime`:
```javascript
// Add to the state object being saved:
lastFarmTime: this._lastFarmTime || 0,
```

In `start()` method, load it back from saved state:
```javascript
// After loading saved state:
this._lastFarmTime = savedState.lastFarmTime || 0;
```

**Step 2: Pass `lastFarmTime` to DecisionEngine**

In `mainLoop()`, before calling `evaluate()`, inject `lastFarmTime` into gameState:
```javascript
// Around line 260, after SCAN completes:
this.gameState.lastFarmTime = this._lastFarmTime || 0;
```

**Step 3: Add outgoing-raid check in evaluateFarming**

In `decisionEngine.js` `evaluateFarming()` (around line 457):
```javascript
// AFTER the existing lastFarmTime interval check:
// Skip if raids are already out
const outgoing = state.troopMovements?.outgoing || 0;
if (outgoing > 0) {
  TravianLogger.log('DEBUG', `[DecisionEngine] Skipping farm — ${outgoing} raids still out`);
  return null;
}
```

**Step 4: Verify**

Test: Start bot → farms once → check that it waits for the configured interval before farming again. Check logs for "Skipping farm" messages. Restart the service worker → verify farm doesn't trigger immediately.

**Step 5: Commit**
```bash
git add travian-bot/core/botEngine.js travian-bot/core/decisionEngine.js
git commit -m "fix: prevent duplicate farm sends with persistent cooldown

- Move lastFarmTime from gameState to BotEngine instance + persistent state
- Add outgoing raid check in evaluateFarming
- Farm cooldown survives service worker restarts"
```

---

## Task 3: Fix Hero Resource Claim

**Files:**
- Modify: `travian-bot/core/botEngine.js` (lines 961–1074, `_tryClaimHeroResources`)
- Modify: `travian-bot/content/actionExecutor.js` (verify selectors match)

**Problem:**
1. Hero not in village → claim navigates but fails silently
2. Transfer amount defaults to max capacity if not calculated correctly
3. Nested success check in scanResult can allow bad data through

**Step 1: Add hero-at-home pre-check**

In `_tryClaimHeroResources()` (around line 970), add:
```javascript
async _tryClaimHeroResources(failedTask) {
  try {
    // Pre-check: hero must be at home
    const heroStatus = this.gameState?.hero;
    if (heroStatus && (heroStatus.isAway || heroStatus.isDead)) {
      TravianLogger.log('INFO', '[BotEngine] Hero not available for resource claim — skipping');
      return false;
    }
```

**Step 2: Fix scanResult data extraction**

Around line 1005, make the data extraction more robust:
```javascript
// BEFORE:
const items = scanResult.data.items || [];

// AFTER:
const rawData = scanResult.data || {};
const items = rawData.items || (rawData.data && rawData.data.items) || [];
if (items.length === 0) {
  TravianLogger.log('WARN', '[BotEngine] Hero inventory scan returned no items');
  return false;
}
```

**Step 3: Calculate exact transfer amount**

In the resource claim loop (around line 1040), ensure exact amount is passed:
```javascript
// Calculate exact amount needed for THIS resource type
const deficit = this._calcResourceDeficit(failedTask);
if (!deficit) {
  TravianLogger.log('WARN', '[BotEngine] Cannot calculate resource deficit');
  return false;
}

// For each matching resource item:
const resourceTypeMap = { 145: 'wood', 146: 'clay', 147: 'iron', 148: 'crop' };
const itemResourceType = resourceTypeMap[item.itemType];
const needed = deficit[itemResourceType] || 0;
if (needed <= 0) continue;

const transferAmount = Math.min(needed, parseInt(item.count) || 0);
if (transferAmount <= 0) continue;

TravianLogger.log('INFO', `[BotEngine] Claiming ${transferAmount} ${itemResourceType} from hero`);
```

**Step 4: Verify**

Test: Trigger a building upgrade that needs more resources than available → verify hero claim transfers the EXACT amount needed, not max. Check logs for the claim amount.

**Step 5: Commit**
```bash
git add travian-bot/core/botEngine.js
git commit -m "fix: hero resource claim — exact amounts, hero-at-home check

- Pre-check hero isAway/isDead before attempting claim
- Robust scanResult data extraction for nested response
- Calculate exact deficit per resource type, transfer only what's needed"
```

---

## Task 4: ActionScorer Module — New Scoring Engine

**Files:**
- Create: `travian-bot/core/actionScorer.js`
- Modify: `travian-bot/background/service-worker.js` (add to importScripts)

**Step 1: Create `actionScorer.js`**

```javascript
// core/actionScorer.js — Hybrid AI Action Scoring Engine
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class ActionScorer {
    constructor() {
      this.gameData = root.TravianGameData ? new root.TravianGameData() : null;
      this.buildOptimizer = root.TravianBuildOptimizer ? new root.TravianBuildOptimizer() : null;
    }

    /**
     * Score all possible actions given current game state
     * @param {Object} gameState - Full game state from scan
     * @param {Object} config - Bot configuration
     * @param {Object} taskQueue - Current task queue instance
     * @returns {Array<{type, params, score, reason}>} Sorted by score descending
     */
    scoreAll(gameState, config, taskQueue) {
      const actions = [];

      // Collect candidates from each category
      if (config.autoResourceUpgrade || config.autoUpgradeResources) {
        actions.push(...this._scoreResourceUpgrades(gameState, config));
      }
      if (config.autoBuildingUpgrade || config.autoUpgradeBuildings) {
        actions.push(...this._scoreBuildingUpgrades(gameState, config));
      }
      if (config.autoTroopTraining) {
        actions.push(...this._scoreTroopTraining(gameState, config));
      }
      if (config.autoFarming) {
        actions.push(...this._scoreFarming(gameState, config));
      }
      if (config.autoHeroAdventure) {
        actions.push(...this._scoreHeroAdventure(gameState, config));
      }

      // Quest bonus: boost actions that align with quest goals
      if (gameState.quests) {
        this._applyQuestBonuses(actions, gameState.quests);
      }

      // Filter out infeasible actions
      const feasible = actions.filter(a => a.score > 0);

      // Sort by score descending
      feasible.sort((a, b) => b.score - a.score);

      return feasible;
    }

    _scoreResourceUpgrades(state, config) {
      const actions = [];
      const fields = state.resourceFields || [];
      const resources = state.resources || {};
      const capacity = state.resourceCapacity || {};

      for (const field of fields) {
        if (field.upgrading) continue;

        const gidMap = { wood: 1, clay: 2, iron: 3, crop: 4 };
        const gid = gidMap[field.type] || 0;
        if (!gid) continue;

        // Check target level from config
        const targetKey = `${field.type}Target`;
        const targetLevel = config.upgradeTargets?.[targetKey] || config[targetKey] || 10;
        if (field.level >= targetLevel) continue;

        // Base value: production gain per hour
        let baseValue = 5; // default
        if (this.gameData) {
          const currentProd = this.gameData.getProduction(gid, field.level);
          const nextProd = this.gameData.getProduction(gid, field.level + 1);
          baseValue = (nextProd - currentProd) || 5;
        }

        // Urgency: boost if this resource is lowest
        const resValues = [resources.wood || 0, resources.clay || 0, resources.iron || 0, resources.crop || 0];
        const minRes = Math.min(...resValues);
        const thisRes = resources[field.type] || 0;
        const urgency = thisRes <= minRes * 1.1 ? 1.5 : 1.0;

        // Warehouse urgency: boost if near capacity
        const warehouseCap = field.type === 'crop' ? (capacity.granary || 10000) : (capacity.warehouse || 10000);
        const fillRatio = thisRes / warehouseCap;
        const overflowUrgency = fillRatio > 0.9 ? 0.5 : 1.0; // penalize if near full (waste)

        const score = baseValue * urgency * overflowUrgency;

        actions.push({
          type: 'upgrade_resource',
          params: { fieldId: field.id, type: field.type, level: field.level },
          score,
          reason: `${field.type} lv${field.level}→${field.level+1} +${baseValue}/hr`
        });
      }

      return actions;
    }

    _scoreBuildingUpgrades(state, config) {
      const actions = [];
      const buildings = state.buildings || [];
      const buildQueue = state.constructionQueue || { count: 0 };

      if (buildQueue.count >= (buildQueue.maxCount || 1)) return actions;

      for (const bld of buildings) {
        if (bld.empty || bld.upgrading) continue;

        const gid = bld.id || bld.gid;
        const targetLevel = config.buildingTargets?.[`b${gid}`] || null;
        if (targetLevel && bld.level >= targetLevel) continue;

        // Score by building utility
        let baseValue = 10;
        if (gid === 10) baseValue = 15; // Warehouse — high utility
        if (gid === 11) baseValue = 15; // Granary
        if (gid === 15) baseValue = 12; // Main Building — build speed
        if (gid === 19) baseValue = 8;  // Barracks
        if (gid === 17) baseValue = 7;  // Marketplace
        if (gid === 23) baseValue = 6;  // Cranny
        if (gid === 36 || gid === 31 || gid === 33) baseValue = 5; // Wall

        const score = baseValue * (1 + (10 - bld.level) * 0.1); // lower levels = higher priority

        actions.push({
          type: 'upgrade_building',
          params: { slot: bld.slot, gid, level: bld.level },
          score,
          reason: `${bld.name || 'building'} lv${bld.level}→${bld.level+1}`
        });
      }

      return actions;
    }

    _scoreTroopTraining(state, config) {
      const actions = [];
      const troops = state.troops || {};
      const totalTroops = Object.values(troops).reduce((sum, n) => sum + (parseInt(n) || 0), 0);

      // Simple: if below minimum troops, train more
      const minTroops = config.minTroops || 50;
      if (totalTroops >= minTroops && !config.alwaysTrain) return actions;

      const troopType = config.troopType || 't1';
      const trainCount = config.trainCount || 5;

      // Crop awareness: don't train if free crop is very low
      const freeCrop = state.freeCrop || 0;
      const cropPenalty = freeCrop < 10 ? 0.3 : freeCrop < 50 ? 0.7 : 1.0;

      const score = 8 * cropPenalty;

      actions.push({
        type: 'train_troops',
        params: { troopType, count: trainCount },
        score,
        reason: `Train ${trainCount}x ${troopType} (troops: ${totalTroops})`
      });

      return actions;
    }

    _scoreFarming(state, config) {
      const actions = [];
      const farmConfig = config.farmConfig || config;

      if (!farmConfig.autoFarming && !config.autoFarming) return actions;

      // Base farming score
      const lastFarm = state.lastFarmTime || 0;
      const elapsed = Date.now() - lastFarm;
      const interval = (farmConfig.farmInterval || 300) * 1000;

      if (elapsed < interval) return actions;

      // Check outgoing raids
      const outgoing = state.troopMovements?.outgoing || 0;
      if (outgoing > 0) return actions;

      const score = 20; // farming is generally high value

      actions.push({
        type: 'send_farm',
        params: { useRallyPointFarmList: farmConfig.useRallyPointFarmList !== false },
        score,
        reason: `Farm raid (${Math.floor(elapsed/1000)}s since last)`
      });

      return actions;
    }

    _scoreHeroAdventure(state, config) {
      const actions = [];
      const hero = state.hero || {};

      if (!hero.hasAdventure || hero.isAway || hero.isDead) return actions;
      if ((hero.health || 0) < (config.minHeroHealth || 30)) return actions;

      actions.push({
        type: 'send_hero_adventure',
        params: {},
        score: 25, // adventures are high value (XP + items)
        reason: `Hero adventure available (health: ${hero.health}%)`
      });

      return actions;
    }

    _applyQuestBonuses(actions, quests) {
      for (const quest of quests) {
        if (!quest.progress || !quest.total) continue;
        const progressPct = quest.progress / quest.total;

        // Find actions that help complete this quest
        for (const action of actions) {
          if (this._actionMatchesQuest(action, quest)) {
            const bonus = progressPct > 0.9 ? 2.0 : progressPct > 0.7 ? 1.5 : 1.2;
            action.score *= bonus;
            action.reason += ` [quest×${bonus}]`;
          }
        }
      }
    }

    _actionMatchesQuest(action, quest) {
      const title = (quest.title || '').toLowerCase();
      if (action.type === 'upgrade_resource') {
        if (title.includes(action.params.type)) return true;
        if (title.includes('population') || title.includes('ประชากร')) return true;
        if (title.includes('culture') || title.includes('วัฒนธรรม')) return true;
      }
      if (action.type === 'upgrade_building' || action.type === 'build_new') {
        if (title.includes('population') || title.includes('ประชากร')) return true;
        if (title.includes('culture') || title.includes('วัฒนธรรม')) return true;
      }
      if (action.type === 'train_troops' && (title.includes('troop') || title.includes('ทหาร'))) return true;
      return false;
    }
  }

  root.TravianActionScorer = ActionScorer;
})();
```

**Step 2: Add to importScripts in service-worker.js**

In `service-worker.js` around line 24, add BEFORE `decisionEngine.js`:
```javascript
'../core/actionScorer.js',     // TravianActionScorer
```

**Step 3: Verify**

Reload extension → check no errors in service worker console. ActionScorer is loaded but not yet integrated into decision flow (that's Task 5).

**Step 4: Commit**
```bash
git add travian-bot/core/actionScorer.js travian-bot/background/service-worker.js
git commit -m "feat: add ActionScorer module — hybrid AI scoring engine

- Score all possible actions by ROI, urgency, feasibility
- Quest bonus multiplier for near-completion quests
- Crop-aware troop training penalty
- Farm cooldown and outgoing raid checks"
```

---

## Task 5: Integrate ActionScorer into DecisionEngine

**Files:**
- Modify: `travian-bot/core/decisionEngine.js`

**Step 1: Add ActionScorer to DecisionEngine constructor**

Around line 10:
```javascript
constructor() {
  // ... existing initialization
  this.actionScorer = root.TravianActionScorer ? new root.TravianActionScorer() : null;
}
```

**Step 2: Add scoring path to `evaluate()`**

In `evaluate()` around line 65, add a scoring branch:
```javascript
evaluate(gameState, config, taskQueue) {
  const tasks = [];

  // ... existing safety checks (captcha, error) stay at top

  // If ActionScorer is available, use hybrid scoring
  if (this.actionScorer && config.useAIScoring !== false) {
    const scoredActions = this.actionScorer.scoreAll(gameState, config, taskQueue);

    if (scoredActions.length > 0) {
      // Take the top-scored action
      const best = scoredActions[0];
      TravianLogger.log('INFO', `[AI] Best action: ${best.type} (score: ${best.score.toFixed(1)}) — ${best.reason}`);

      // Check if this task type is already in queue
      if (!taskQueue.hasTaskOfType(best.type, null) &&
          !taskQueue.hasTaskOfType(best.type, gameState.currentVillageId)) {
        tasks.push({
          type: best.type,
          params: best.params,
          priority: Math.max(1, 10 - Math.floor(best.score / 5)),
          villageId: gameState.currentVillageId || null
        });
      }

      // Log runner-up for transparency
      if (scoredActions.length > 1) {
        const second = scoredActions[1];
        TravianLogger.log('DEBUG', `[AI] Runner-up: ${second.type} (score: ${second.score.toFixed(1)}) — ${second.reason}`);
      }
    }

    return tasks;
  }

  // ... existing rule-based logic as fallback
```

**Step 3: Verify**

Start bot → check logs for `[AI] Best action:` messages. Verify the bot picks reasonable actions based on scoring.

**Step 4: Commit**
```bash
git add travian-bot/core/decisionEngine.js
git commit -m "feat: integrate ActionScorer into DecisionEngine

- Hybrid scoring path in evaluate() when ActionScorer available
- Falls back to rule-based logic if scoring disabled
- Logs best action + runner-up for transparency"
```

---

## Task 6: GameStateCollector — Multi-Page Scan

**Files:**
- Create: `travian-bot/core/gameStateCollector.js`
- Modify: `travian-bot/core/botEngine.js` (use collector in mainLoop)
- Modify: `travian-bot/background/service-worker.js` (importScripts)

**Step 1: Create `gameStateCollector.js`**

```javascript
// core/gameStateCollector.js — Enriched multi-page game state
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class GameStateCollector {
    constructor() {
      this._fullScanInterval = 5; // do full scan every N cycles
      this._cycleCount = 0;
      this._cachedExtras = {}; // quest data, trap info, etc.
    }

    /**
     * Determine if this cycle should do a full multi-page scan
     */
    shouldDoFullScan() {
      this._cycleCount++;
      return this._cycleCount >= this._fullScanInterval;
    }

    /**
     * Reset full scan counter after completing one
     */
    resetFullScanCounter() {
      this._cycleCount = 0;
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

    /**
     * Get the list of pages to scan in a full scan cycle
     * Returns array of {page, scanAction} to execute in order
     */
    getFullScanSequence() {
      return [
        { page: 'dorf1', action: 'fullScan', description: 'Resources + troops + queue' },
        { page: 'dorf2', action: 'fullScan', description: 'Buildings' },
        // These are optional scans — only when needed
        // { page: 'tasks', action: 'scanQuests', description: 'Quest progress' },
        // { page: 'heroInventory', action: 'scanHeroInventory', description: 'Hero items' },
      ];
    }
  }

  root.TravianGameStateCollector = GameStateCollector;
})();
```

**Step 2: Add to importScripts**

In `service-worker.js`, add before `botEngine.js`:
```javascript
'../core/gameStateCollector.js', // TravianGameStateCollector
```

**Step 3: Use in BotEngine**

In `botEngine.js` constructor:
```javascript
this.stateCollector = new root.TravianGameStateCollector();
```

In `mainLoop()`, after SCAN and before DecisionEngine:
```javascript
// Enrich gameState with cached extras
this.gameState = this.stateCollector.enrichGameState(this.gameState);
this.gameState.lastFarmTime = this._lastFarmTime || 0;
```

**Step 4: Commit**
```bash
git add travian-bot/core/gameStateCollector.js travian-bot/core/botEngine.js travian-bot/background/service-worker.js
git commit -m "feat: add GameStateCollector for enriched game state

- Multi-page scan cycle counter (full scan every N cycles)
- Cached quest/trapper/hero data merged into gameState
- Foundation for quest automation and trapper features"
```

---

## Task 7: Quest Scanner in DomScanner

**Files:**
- Modify: `travian-bot/content/domScanner.js`

**Step 1: Add `scanQuests()` method**

Add after the existing `getAdventureList()` method:
```javascript
scanQuests() {
  try {
    if (!window.location.pathname.includes('/tasks')) return null;

    const tasks = document.querySelectorAll('.task');
    if (!tasks.length) return [];

    return [...tasks].map(t => {
      const title = t.querySelector('.title')?.textContent?.trim() || '';
      const rewardEl = t.querySelector('.rewards');
      const progressEl = t.querySelector('.progress');

      // Extract silver reward
      const silverText = rewardEl?.querySelector('.iconValueBoxWrapper')?.textContent?.trim() || '0';
      const silver = parseInt(silverText.replace(/[^\d]/g, '')) || 0;

      // Extract progress text like "102/150" or "5/6 เป็นเลเวล 5"
      const progressText = progressEl?.textContent?.trim() || '';
      const progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
      const progress = progressMatch ? parseInt(progressMatch[1]) : 0;
      const total = progressMatch ? parseInt(progressMatch[2]) : 1;

      return { title, silver, progress, total, progressPct: progress / total };
    });
  } catch (e) {
    return null;
  }
}
```

**Step 2: Add to fullScan() page detection**

In `getFullState()`, add quest scanning when on tasks page:
```javascript
if (page === 'tasks' || window.location.pathname.includes('/tasks')) {
  state.quests = this.scanQuests();
}
```

**Step 3: Commit**
```bash
git add travian-bot/content/domScanner.js
git commit -m "feat: add quest scanner to domScanner

- scanQuests() reads .task elements for title, silver reward, progress
- Integrated into getFullState() on tasks page"
```

---

## Task 8: Trapper + Wall Auto-Build

**Files:**
- Modify: `travian-bot/content/domScanner.js` (add `getTrapperInfo()`)
- Modify: `travian-bot/content/actionExecutor.js` (add `trainTraps` action)
- Modify: `travian-bot/core/actionScorer.js` (add trap scoring)

**Step 1: Add `getTrapperInfo()` to domScanner**

```javascript
getTrapperInfo() {
  try {
    // Only works on trapper building page (gid=36)
    if (!window.location.href.includes('gid=36')) return null;

    // Read trap counts from the description area
    const descText = document.querySelector('#build .description, #build .buildingDetails')?.textContent || '';
    const currentMatch = descText.match(/(\d+)\s*อัน.*?ขณะนี้/);
    const maxMatch = descText.match(/สูงสุด.*?(\d+)\s*อัน/);

    // Check training form
    const trainInput = document.querySelector('input[name="t1"]');
    const canTrain = trainInput && !trainInput.disabled;
    const maxTrain = trainInput ? parseInt(trainInput.max || '0') : 0;

    return {
      currentTraps: currentMatch ? parseInt(currentMatch[1]) : 0,
      maxTraps: maxMatch ? parseInt(maxMatch[1]) : 0,
      canTrain,
      maxTrain,
      isUpgrading: maxTrain === 0 && canTrain === false
    };
  } catch (e) {
    return null;
  }
}
```

**Step 2: Add `trainTraps` action to actionExecutor**

```javascript
// In the execute() dispatch, add:
case 'trainTraps':
  return await this.trainTraps(params.count);

// New method:
async trainTraps(count) {
  try {
    const input = await awaitSelector('input[name="t1"]', 3000);
    if (!input) return { success: false, reason: 'button_not_found', message: 'Trap training input not found' };

    if (input.disabled || input.max === '0') {
      return { success: false, reason: 'queue_full', message: 'Cannot train traps (building upgrading?)' };
    }

    await fillInput('input[name="t1"]', String(count));
    await humanDelay(300, 600);

    const trainBtn = trySelectors([
      '.textButtonV1.green',
      'button[type="submit"].green',
      '.section1 button.green'
    ]);
    if (!trainBtn) return { success: false, reason: 'button_not_found', message: 'Train button not found' };

    await simulateHumanClick(trainBtn);
    return { success: true };
  } catch (e) {
    return { success: false, reason: 'button_not_found', message: e.message };
  }
}
```

**Step 3: Add trap and wall scoring to ActionScorer**

Add new method `_scoreTrapperAndWall()` and call it from `scoreAll()`:
```javascript
_scoreTrapperAndWall(state, config) {
  const actions = [];
  const trapper = state.trapperInfo;

  // Trap training
  if (trapper && trapper.canTrain && trapper.maxTrain > 0) {
    const deficit = trapper.maxTraps - trapper.currentTraps;
    if (deficit > 0) {
      const threatLevel = state.defenseReports?.recentAttacks > 0 ? 2.0 : 1.0;
      const score = (deficit / trapper.maxTraps) * 15 * threatLevel;
      actions.push({
        type: 'build_traps',
        params: { count: Math.min(deficit, trapper.maxTrain, 10) },
        score,
        reason: `Train traps (${trapper.currentTraps}/${trapper.maxTraps})`
      });
    }
  }

  // Wall upgrade — scored as normal building but with defense boost
  const buildings = state.buildings || [];
  const wall = buildings.find(b => [31, 33, 36].includes(b.id || b.gid));
  if (wall && !wall.upgrading && wall.level < 20) {
    const score = 8 + (state.defenseReports?.recentAttacks > 0 ? 10 : 0);
    actions.push({
      type: 'upgrade_building',
      params: { slot: wall.slot, gid: wall.id || wall.gid, level: wall.level },
      score,
      reason: `Wall lv${wall.level}→${wall.level+1}`
    });
  }

  return actions;
}
```

**Step 4: Commit**
```bash
git add travian-bot/content/domScanner.js travian-bot/content/actionExecutor.js travian-bot/core/actionScorer.js
git commit -m "feat: add Trapper auto-train and Wall auto-upgrade

- getTrapperInfo() in domScanner reads trap counts + training status
- trainTraps action in actionExecutor fills form + clicks train
- ActionScorer scores traps by deficit + threat level"
```

---

## Task 9: Remove Dead Code + Clean Up

**Files:**
- Modify: `travian-bot/core/botEngine.js` (remove dead alarm listener at lines 1191–1206)

**Step 1: Remove dead alarm handler**

Delete the `chrome.alarms.onAlarm.addListener` block at lines 1191–1206 that references `self._botEngineInstance` (which is never set). The real alarm handling is done in `service-worker.js`.

**Step 2: Commit**
```bash
git add travian-bot/core/botEngine.js
git commit -m "chore: remove dead alarm listener in botEngine

The chrome.alarms.onAlarm listener referenced self._botEngineInstance
which is never assigned. Real alarm handling is in service-worker.js."
```

---

## Implementation Order Summary

```
Task 1: BuildQueueGuard      — Fix duplicate building    [Bug fix]
Task 2: FarmCooldownTracker   — Fix farm repeats          [Bug fix]
Task 3: Hero Claim Fix        — Fix hero resource claim   [Bug fix]
Task 4: ActionScorer Module   — New scoring engine        [New module]
Task 5: Integrate ActionScorer — Wire into DecisionEngine [Integration]
Task 6: GameStateCollector    — Multi-page scan           [New module]
Task 7: Quest Scanner         — DomScanner addition       [New feature]
Task 8: Trapper + Wall Auto   — Gaul-specific features    [New feature]
Task 9: Dead Code Cleanup     — Remove unused code        [Cleanup]
```

Each task is independently committable and testable. Tasks 1–3 can be done in any order. Tasks 4–5 depend on each other. Tasks 6–8 build on 4–5 but can be done in any order after that.
