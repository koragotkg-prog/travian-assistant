# Intelligent Raiding System - Implementation Plan

## Context

Currently the bot sends 5 TT (Theutates Thunder) to abandoned villages via farm lists using `selectiveFarmSend()`. This is fire-and-forget — no re-raid logic, no report parsing, no scout intelligence. The user wants to:

1. **Re-raid bounty-full targets** — after farm lists return, targets with full bounty should be raided again with TT
2. **Future: Scout & Adapt** — send Pathfinders first, read scout reports to detect defenders/walls, then decide troop count

Reports are very numerous (frequent farming), so the system must be selective — only parse relevant reports, not scan all pages.

## Phase 1: Smart Re-Raid (bounty-based)

**Goal**: After a farm cycle, identify bounty-full targets on the farm list page and re-raid them.

### Design

Instead of modifying `selectiveFarmSend()`, add a **new step in the farm cycle** that runs AFTER the initial farm send:

1. BotEngine's farm cycle already navigates to farm list tab and calls `selectiveFarmSend()`
2. After `selectiveFarmSend()` returns, call `scanFarmListSlots()` to get per-slot bounty data
3. Filter for `bountyLevel === 'full'` and `raidStatus === 'won'` (no losses)
4. For each matching slot, check its checkbox and click the list's start button (re-send with the same troops already configured in the farm list)

This is the most stable approach because:
- Reuses existing farm list infrastructure (troops already configured per-slot)
- No need to calculate troop counts or navigate to rally point
- Just check/uncheck slots and click start — same pattern as `selectiveFarmSend()`

### Files to Modify

**`content/actionExecutor.js`** — Add `reRaidBountyFull(opts)` function:
```
reRaidBountyFull(opts):
  - Must be on farm list tab (tt=99)
  - For each farm list wrapper:
    - Uncheck all slots
    - Scan slots, check only where bountyLevel==='full' && raidStatus==='won'
    - Optionally filter by minLoot threshold
    - Click start button for that list
  - Returns { success, sent, skipped, total }
```

**`core/botEngine.js`** — Modify `_executeFarmCycle()` (or wherever farm tasks run):
- After `selectiveFarmSend()` completes successfully, wait 2-3 seconds for UI to update
- Call `reRaidBountyFull()` as a follow-up step
- Config toggle: `config.farmConfig.enableReRaid` (default: false)
- Config option: `config.farmConfig.reRaidMinLoot` (minimum last-loot to qualify, default: 100)

**`popup/popup.js` + `popup/index.html`** — Add toggle in farming config section:
- Checkbox: "Re-raid bounty-full targets"
- Number input: "Min loot for re-raid" (default 100)

### Key Detail: No New Task Type Needed

Re-raid happens inline during the existing `send_farm` task execution, NOT as a separate queued task. This avoids:
- Extra navigation (already on farm list page)
- Task queue complexity
- Race conditions between farm send and re-raid

Flow: `send_farm` task → navigate to farm tab → `selectiveFarmSend()` → wait 2s → `reRaidBountyFull()` → done.

---

## Phase 2: Report Intelligence (Future — outline only)

**Goal**: Parse raid report pages to build per-target intelligence. NOT implementing now, but designing the interface so Phase 1 is forward-compatible.

### Concept

- New module: `core/raidIntelligence.js` — stores per-target data in `chrome.storage`
- New domScanner function: `scanRaidReports()` — parses report list page for latest raid results
- New domScanner function: `scanReportDetail(reportId)` — parses a single report for defenders, walls, resources
- DecisionEngine trigger: after farm cycle, queue `scan_reports` task if enough time has passed
- Storage key: `raid_intel__<serverKey>` — Map of `{coordKey: {lastScout, defenders, wallLevel, resources, lastRaid, ...}}`

### Phase 3 (Future): Scout & Adaptive Raid

- Send Pathfinder (t3 for Gauls) to targets before TT
- Parse scout report: detect defender count, wall level, resource amounts
- Calculate optimal troop count:
  - 0 defenders, no wall → 5 TT
  - 0 defenders, wall → 8-10 TT (compensate for wall bonus losses)
  - Has defenders → skip or send larger force based on ROI
  - Heavily defended → blacklist target

### Phase 4 (Future): ROI Engine

- Track loot vs losses per target over time
- Calculate profit/hour per target
- Auto-adjust farming frequency and troop allocation

---

## Implementation Order (Phase 1 only)

### Step 1: `reRaidBountyFull()` in actionExecutor.js
- New function next to `selectiveFarmSend()`
- Same pattern: uncheck all, selectively check bounty-full + won targets, click start
- Params: `{ minLoot: 100 }`
- Returns: `{ success, sent, skipped, total }`

### Step 2: Integrate into BotEngine farm execution
- In the `send_farm` task handler in `_executeTask()` or `_executeFarmAction()`
- After `selectiveFarmSend()` succeeds, check `config.farmConfig.enableReRaid`
- If enabled, wait 2s, then call `reRaidBountyFull()` via content script message
- Log results

### Step 3: Config UI in popup
- Add "Re-raid" toggle and minLoot input in farming config section
- Wire up to `config.farmConfig.enableReRaid` and `config.farmConfig.reRaidMinLoot`

### Step 4: Test end-to-end
- Enable re-raid in config
- Run a farm cycle
- Verify: initial farm send runs, then re-raid checks bounty and sends again
- Check logs for re-raid results

## Critical Files

| File | Action | What |
|------|--------|------|
| `content/actionExecutor.js:1227` | Add function | `reRaidBountyFull()` next to `selectiveFarmSend()` |
| `core/botEngine.js` | Modify | Farm task execution: add re-raid step after selectiveFarmSend |
| `popup/index.html` | Modify | Add re-raid toggle + minLoot input in farming section |
| `popup/popup.js` | Modify | Wire re-raid config fields to save/load |

## Reusable Functions

- `scanFarmListSlots()` in domScanner.js:1323 — already returns `bountyLevel`, `raidStatus`, `lastLoot`
- `selectiveFarmSend()` pattern in actionExecutor.js:1227 — same check/uncheck/start flow
- `humanDelay()`, `simulateHumanClick()` in actionExecutor — for human-like behavior

## Verification

1. Load extension in Chrome, open Travian farm list page
2. Enable re-raid in popup config, set minLoot to 50
3. Start bot, trigger farm cycle
4. Check service worker logs for:
   - `selectiveFarmSend: done — sent=X skipped=Y`
   - `reRaidBountyFull: sent=Z` (bounty-full targets re-raided)
5. Verify on farm list page that bounty-full targets received a second raid
6. Disable re-raid toggle, verify farm cycle skips re-raid step
