# Resource Intelligence System — Design Document

**Date:** 2026-02-26
**Status:** Design
**Branch:** claude/charming-kalam → feat/ai-bot-scoring-engine

---

## Problem Statement

The bot currently makes upgrade decisions based on ROI scores without considering resource dynamics. This leads to:

1. **Resource overflow** — production fills warehouse/granary while waiting for expensive upgrades
2. **Blind scheduling** — no prediction of when resources will be available for the next task
3. **No farm income modeling** — farm loot arrives unpredictably, creating resource spikes that go wasted
4. **No pressure awareness** — the bot doesn't accelerate spending when storage is nearly full

The `BuildOptimizer.detectOverflow()` method already calculates hours-until-full, but it's a **one-shot snapshot** that the DecisionEngine never uses for decision timing.

---

## Solution: Resource Intelligence Module

A new `strategy/resourceIntel.js` module following the existing strategy module pattern:

- IIFE with multi-context export (`self.TravianResourceIntel`)
- Depends only on `TravianGameData` (same as BuildOptimizer)
- Stateless core — pure functions, same input → same output
- Consumed by DecisionEngine alongside BuildOptimizer and MilitaryPlanner

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│              strategy/resourceIntel.js                │
│                                                       │
│  TravianResourceIntel                                 │
│  ├── forecast(snapshot, horizonMs) → Timeline         │
│  ├── pressure(snapshot) → PressureReport              │
│  ├── policy(pressureReport, candidates) → Reranked    │
│  ├── recordFarmLoot(farmId, loot, ts)   [Phase 2]     │
│  └── predictFarmLoot(farmId) → Loot     [Phase 2]     │
│                                                       │
│  Dependency: TravianGameData (PRODUCTION table)       │
│  Storage: chrome.storage (farm history) [Phase 2]     │
└─────────────────────────────────────────────────────┘
```

### Integration Points (3 touch points)

```
DecisionEngine.constructor()
  → new TravianResourceIntel() (like BuildOptimizer)

DecisionEngine.evaluate()
  → resourceIntel.pressure(gameState) before upgrade evaluation

DecisionEngine._strategyUpgrade()
  → resourceIntel.policy(pressure, candidates) to re-rank when pressure > 30
```

No changes to mainLoop. No new SCAN calls. No new scheduler cycles.

---

## Data Shapes

### Input: ResourceSnapshot

Built from existing `gameState` fields — no new data collection needed.

```js
{
  resources:  { wood: 5000, clay: 3200, iron: 4100, crop: 2800 },
  capacity:   { warehouse: 8780, granary: 8780 },
  production: { wood: 280, clay: 200, iron: 375, crop: 145 },
  queueTimeRemainingMs: 1800000,  // current build queue ETA
  timestamp: Date.now()
}
```

### Output: ResourceForecast

```js
{
  wood: { current: 5000, projected: 7800, overflow: false, overflowMs: null,   msToFull: 48857 },
  clay: { current: 3200, projected: 5200, overflow: false, overflowMs: null,   msToFull: 100800 },
  iron: { current: 4100, projected: 7850, overflow: false, overflowMs: null,   msToFull: 44960 },
  crop: { current: 2800, projected: 4250, overflow: false, overflowMs: 148965, msToFull: 148965 },
  horizonMs: 7200000,
  firstOverflowMs: 148965   // earliest overflow across all resources (null if none)
}
```

### Output: PressureReport

```js
{
  overall: 72,
  perResource: { wood: 85, clay: 40, iron: 78, crop: 65 },
  urgentAction: 'spend_resources',   // or 'upgrade_storage' | null
  overflowRisk: { wood: true, clay: false, iron: true, crop: false },
  firstOverflowMs: 5400000,
  level: 'high'                      // 'low' | 'medium' | 'high' | 'critical'
}
```

---

## Core Algorithms

### 1. Resource Forecast Engine

Deterministic linear projection with capacity capping:

```
projected(r, T) = min(capacity[r], current[r] + production[r] * T / 3600000)

overflowMs(r) = (capacity[r] - current[r]) / production[r] * 3600000
                if production[r] > 0 and current[r] < capacity[r]
                else null
```

Horizon defaults to 7200000ms (2 hours). For each resource:
- `projected`: amount at horizon time
- `overflow`: true if projected >= capacity
- `overflowMs`: ms until this resource hits cap
- `msToFull`: same as overflowMs (alias for clarity)

**Build queue awareness:** When `queueTimeRemainingMs > 0`, the forecast notes that a build slot will open at that time. This is informational — the forecast doesn't model costs of the next build (that's the policy layer's job).

### 2. Pressure Model

Pressure per resource (0-100):

```
pressure(r) = clamp(0, 100,
    w_fill * fillRatio(r)
  + w_overflow * overflowUrgency(r)
  + w_imbalance * imbalancePenalty(r)
)

where:
  fillRatio(r)       = current[r] / capacity[r]                     weight: 40
  overflowUrgency(r) = max(0, 1 - msToFull[r] / (4 * 3600000))     weight: 40
  imbalancePenalty(r) = |ratio[r] - 0.25| / 0.25                    weight: 20

  ratio[r] = production[r] / totalProduction

Overall pressure = max(perResource pressures)
```

Thresholds:
| Range | Level    | Behavior                                    |
|-------|----------|---------------------------------------------|
| 0-30  | low      | Normal ROI-based decisions                  |
| 30-60 | medium   | Prefer affordable upgrades                  |
| 60-80 | high     | Re-rank by pressure relief                  |
| 80-100| critical | Force storage upgrade or dump resources      |

### 3. Action Policy

Re-ranks existing upgrade candidates based on pressure:

```
policy(pressureReport, candidates):
  if pressure.overall < 30:
    return candidates  // unchanged — ROI drives

  if pressure.overall >= 30:
    for each candidate:
      reliefScore = Σ(candidate.cost[r] * pressure.perResource[r]) / totalCost
      candidate.adjustedScore = candidate.score * (1 + reliefScore * pressureMult)
    sort by adjustedScore descending

  if pressure.overall >= 60:
    filter to affordable only
    inject storage upgrade if not present and storage is bottleneck

  if pressure.overall >= 80:
    if storage below max → force storage upgrade to top
    else → pick highest-cost affordable (resource dump)

  return reranked candidates
```

`pressureMult`:
- 30-60: 0.3 (mild boost)
- 60-80: 0.6 (strong boost)
- 80-100: 1.0 (override ROI)

---

## Safety Rules

1. **No loops**: Pressure-driven upgrades use existing cooldown system. Failed storage upgrade → normal cooldown.
2. **No bursts**: Policy re-ranks but DecisionEngine still picks ONE task per cycle.
3. **Idempotent**: `forecast()` and `pressure()` are pure functions. No side effects.
4. **Dedup**: Uses existing `taskQueue.hasTaskOfType()`. No change needed.
5. **Overflow guard**: If pressure=100 and no affordable action exists, log warning. Never panic-create tasks.
6. **No new SCAN calls**: Uses existing gameState from current cycle's SCAN.

---

## Multi-Village Design

`TravianResourceIntel` is **stateless** — each call receives a snapshot and returns analysis. Village switching is handled by BotEngine passing the correct village's gameState. No per-village instances needed.

```js
const intel = new TravianResourceIntel();
const reportA = intel.pressure(villageASnapshot);
const reportB = intel.pressure(villageBSnapshot);
// Each call is independent — no state carried between villages
```

---

## Implementation Phases

### Phase 1 (This PR)
- New file: `strategy/resourceIntel.js`
  - `forecast()` — deterministic projection
  - `pressure()` — scoring model
  - `policy()` — candidate re-ranking
  - `buildSnapshot()` — helper to extract snapshot from gameState
- DecisionEngine integration (3 touch points)
- `importScripts()` addition in service-worker.js manifest

### Phase 2 (Future)
- Farm loot prediction (EMA with chrome.storage persistence)
- Build cost simulation in forecast (model resource drain at build completion)
- Hero resource claim integration with pressure model
- Popup display: pressure gauge and overflow warnings

---

## File Changes Summary

### New Files
- `strategy/resourceIntel.js` — ~200 lines

### Modified Files
- `core/decisionEngine.js` — constructor + evaluate() + _strategyUpgrade()
- `background/service-worker.js` — add importScripts entry

### No Changes To
- `core/botEngine.js` — no mainLoop changes
- `content/domScanner.js` — no new selectors
- `content/actionExecutor.js` — no new actions
- Popup files — Phase 2
