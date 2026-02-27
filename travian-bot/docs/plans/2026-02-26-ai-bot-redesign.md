# AI Bot Redesign — Hybrid Goal-Driven Scoring Engine

**Date:** 2026-02-26
**Scope:** Incremental refactor of Chrome Extension (`travian-bot/`)
**Approach:** Layered scoring on existing engine (Approach A)

## Context

Surveyed all game pages on ts4.x1.asia.travian.com (Asia 4) via Chrome MCP:
- Player: KRG, Gaul, Level 7 hero, 1 village at (61,120), pop 183
- Buildings: Barracks lv3, Trapper lv6, Wall lv6, Main Building lv6, 6 empty slots
- Farm list: 23 targets, distances 2.2–9.2 tiles
- Hero inventory: 22749/23710/23711/24825 resource pools
- Quests: 7+ village tasks with silver+XP rewards, progress tracking

## Problem Statement

Three critical bugs and four missing features:

### Bugs
1. **Duplicate building** — Bot queues upgrade for buildings already in build queue
2. **Duplicate farming** — Farm list sent repeatedly to same targets without cooldown
3. **Hero claim failure** — Wrong selectors, default max amount, fire-and-forget race condition

### Root cause
Bot lacks **state awareness** — it doesn't check current build queue, troop movements, or hero location before acting.

### Missing features
- Quest automation (reading quest progress, aligning actions with quest goals)
- Oasis farming (raiding nearby oasis for resources)
- Trapper/Wall auto (Gaul trap training, wall upgrades based on threat)
- Cross-village training (future: multi-village troop management)

---

## Design

### Phase 1: Bug Fixes — State Awareness Layer

#### 1.1 BuildQueueGuard (in TaskQueue)

Before adding `upgrade_resource` / `upgrade_building` / `build_new` tasks:
- Check `gameState.buildQueue` for matching slot/field ID
- Check `gameState.resourceFields[].upgrading` and `gameState.buildings[].upgrading`
- If already building → skip, log "already in build queue"
- Also dedup within TaskQueue itself: no two tasks for same slot

**Files:** `core/taskQueue.js`

#### 1.2 FarmCooldownTracker (in BotEngine)

After `startFarmList` succeeds:
- Record timestamp in `farmState.lastSentAt`
- Before next send → check elapsed time >= `minFarmInterval`
- `minFarmInterval` = max distance in farm list × 2 × travel_time_per_tile (configurable)
- Also check `gameState.troopMovements.outgoing` — if raids are still out, skip

**Files:** `core/botEngine.js`

#### 1.3 Hero Claim Fix (in BotEngine + ActionExecutor)

- Use identical selectors in `scanHeroInventory` and `useHeroItem` (`.heroItems .heroItem[data-tier="consumable"]`)
- Calculate exact amount needed: `needed = buildCost[resourceType] - currentResources[resourceType]`
- Set dialog input to `Math.min(needed, item.count)` instead of default
- `await _tryClaimHeroResources()` — never fire-and-forget
- Pre-check: hero must be in village (no outgoing hero movement)

**Files:** `core/botEngine.js`, `content/actionExecutor.js`

---

### Phase 2: ActionScorer — Scoring Engine

New module `core/actionScorer.js` (exported as `self.TravianActionScorer`).

#### Score Formula

```
score = baseValue × urgencyMultiplier × feasibilityBonus - riskPenalty
```

| Factor | Description | Examples |
|--------|-------------|---------|
| baseValue | Intrinsic value of the action | production gain/hr, quest silver reward, loot estimate |
| urgencyMultiplier | Time pressure (1.0–3.0) | warehouse >90% full = ×3, traps <50% = ×2 |
| feasibilityBonus | Can do now? (0.0–1.5) | resources sufficient = ×1.5, need to wait = ×0.5 |
| riskPenalty | Downside risk (0–50) | farm target had losses = -30, oasis with animals = -20 |

#### Scored Action Types

```javascript
// Resource & Building
{ type: 'upgrade_resource', scorer: productionROI × urgency }
{ type: 'upgrade_building', scorer: utilityGain × urgency }
{ type: 'build_new',        scorer: utilityScore }

// Military & Defense
{ type: 'train_troops',     scorer: troopNeed × cropAwareness }
{ type: 'build_traps',      scorer: trapDeficit × threatLevel }
{ type: 'upgrade_wall',     scorer: defenseGain × threatLevel }

// Economy
{ type: 'send_farm',        scorer: expectedLoot / travelTime }
{ type: 'farm_oasis',       scorer: oasisLoot × successProbability }
{ type: 'claim_hero_res',   scorer: resourceNeed × 0.8 }

// Progression
{ type: 'complete_quest',   scorer: questReward × nearCompletionBonus }
{ type: 'send_adventure',   scorer: fixedHighScore if available }
```

#### Integration with DecisionEngine

DecisionEngine is modified to call ActionScorer instead of hardcoded priority:

```
Before:  safety checks → resources → buildings → troops → farm (fixed order)
After:   ActionScorer.scoreAll(gameState) → sort by score → pick top action
```

Safety checks (warehouse overflow, hero adventure) remain as urgency multipliers, not hardcoded priority.

**Files:** `core/actionScorer.js` (new), `core/decisionEngine.js` (modify)

---

### Phase 3: GameStateCollector

New module `core/gameStateCollector.js` — enriches basic scan data with additional context.

Currently, `domScanner.fullScan()` returns resources, buildings, troops, build queue. The collector adds:

| Data | Source | How |
|------|--------|-----|
| Quest progress | `/tasks` page | Navigate → scan `.task` elements |
| Raid reports summary | `/report` page | Navigate → scan latest raid reports for loot/losses |
| Hero inventory | `/hero/inventory` | Navigate → scan `.heroItem` elements |
| Trapper status | `/build.php?id=37` | Navigate → scan trap count + training form |
| Farm list status | `/build.php?id=39&tt=99` | Navigate → scan `.farmListWrapper` |
| Troop movements | dorf1 `.troopMovement` | Already in scan (incoming/outgoing) |

The collector runs a **full scan cycle** periodically (every N cycles, configurable) that visits multiple pages. Normal cycles use the fast dorf1+dorf2 scan.

**Files:** `core/gameStateCollector.js` (new)

---

### Phase 4: New Features

#### 4.1 Quest Automation

`core/questEvaluator.js` (new):

- Reads quest data from GameStateCollector
- For each quest, checks if any scored action matches the quest goal
- Applies `questBonus` multiplier to matching actions:
  - Progress >70%: ×1.5 (almost done, worth finishing)
  - Progress >90%: ×2.0 (so close, definitely finish)
  - Quest reward / remaining effort ratio used for new quests

No new action executor needed — quests are completed by normal actions (build, train, etc.) that happen to match quest requirements.

**Files:** `core/questEvaluator.js` (new), `content/domScanner.js` (add `scanQuests()`)

#### 4.2 Oasis Farming

New action type `farm_oasis`:

- Pre-calculate oasis positions around village (radius 3–7 tiles)
- Score each oasis: estimated resources / travel time
- Execute via Rally Point "send troops" form:
  - Navigate to `/build.php?id=39&tt=2` (send troops tab)
  - Fill coordinates (x, y) + troop count + select "Raid"
  - Submit form

Requires: knowledge of oasis positions (can be extracted from map page or hardcoded as offsets).

**Files:** `content/actionExecutor.js` (add `farmOasis` action), `core/actionScorer.js` (add oasis scoring)

#### 4.3 Trapper + Wall Auto

**Trapper (`build_traps` action):**
- DomScanner: add `getTrapperInfo()` → `{ currentTraps, maxTraps, canTrain, isUpgrading }`
- Selector: Trapper page at `/build.php?id=37` (gid=36)
- Training form: same pattern as barracks (`input[name="t1"]`)
- Guard: cannot train while Trapper building is upgrading (max=0)
- Score: `(maxTraps - currentTraps) × threatMultiplier`

**Wall (`upgrade_wall` action):**
- Already handled by `upgrade_building` — just needs to be included as candidate
- Wall slot is always aid=40, gid=36(Gaul)/31(Roman)/33(Teuton)
- Score boost when defense reports show incoming attacks

**Files:** `content/domScanner.js` (add trap scanning), `content/actionExecutor.js` (add trap training)

#### 4.4 Cross-Village Training (Design Only)

Deferred to when player has 2+ villages. Design:
- InstanceManager already supports multi-server; extend for multi-village
- Each village gets its own gameState + scoring
- Global coordinator picks which village to act on next
- Training commands route to the village with most idle resources

---

## Implementation Order

```
Phase 1: Bug Fixes (3 tasks)           ← Start here
  1.1 BuildQueueGuard
  1.2 FarmCooldownTracker
  1.3 Hero Claim Fix

Phase 2: Scoring Engine (2 tasks)
  2.1 ActionScorer module
  2.2 DecisionEngine integration

Phase 3: GameStateCollector (1 task)
  3.1 Multi-page scan cycle

Phase 4: New Features (4 tasks)
  4.1 Quest Automation
  4.2 Oasis Farming
  4.3 Trapper + Wall Auto
  4.4 Cross-Village (design only)
```

## Files Changed

| File | Change |
|------|--------|
| `core/taskQueue.js` | Add BuildQueueGuard dedup |
| `core/botEngine.js` | Add FarmCooldownTracker, fix hero claim await |
| `content/actionExecutor.js` | Fix hero selectors, add trap training, add oasis raid |
| `content/domScanner.js` | Add `scanQuests()`, `getTrapperInfo()`, `getFarmListStatus()` |
| `core/actionScorer.js` | **New** — scoring engine |
| `core/gameStateCollector.js` | **New** — multi-page state collector |
| `core/questEvaluator.js` | **New** — quest-action matching |
| `core/decisionEngine.js` | Refactor to use ActionScorer |
| `background/service-worker.js` | Import new modules |
| `manifest.json` | No changes needed (content scripts already include all needed files) |

## Verified DOM Selectors (from Chrome MCP survey)

| Feature | Selector | Notes |
|---------|----------|-------|
| Build queue | `.buildDuration > .timer` | parent `<li>`, name in `.name`, level in `.lvl` |
| Farm list wrapper | `.farmListWrapper` | class `expanded` when open |
| Farm start button | `button.startFarmList` | text "เริ่ม (N)" |
| Farm start all | `button.startAllFarmLists` | at page bottom |
| Farm target rows | `table.slots tbody tr.slot` | 8 columns |
| Quest tasks | `.task` | children: `.title`, `.rewards`, `.progress` |
| Quest tabs | Tab links at `/tasks` | `?t=village` and `?t=general` |
| Trapper info | `/build.php?id=37` (gid=36) | trap count in description area |
| Trapper train form | `input[name="t1"]` on trapper page | same pattern as barracks |
| Hero inventory | `.heroItems .heroItem[data-tier="consumable"]` | `.count` for amount |
| Troop movements | dorf1 `.troopMovement .in` / `.out` | incoming/outgoing counts |
| Building gid in dorf2 | CSS class `g{N}` on `.buildingSlot` | e.g. `g36` = Water Ditch |
| Rally Point tabs | `/build.php?id=39&tt=N` | tt=2=send, tt=99=farm lists |
| Marketplace merchants | `.merchantInfo, .traderCount` | free/total count |
