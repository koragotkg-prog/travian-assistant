# Popup UI v3 — Feature-Centric Redesign

## Problem

The current popup (420×580px, 4 tabs) is hard to use:
- **Config tab is too long** — 7 sections, requires excessive scrolling
- **Upgrade setup is painful** — scan → set target for each of 40 slots one-by-one, takes minutes
- **Feature toggles separated from config** — toggles on Dashboard tab, settings on Config tab
- **Resource Intelligence (new) has no UI** — pressure, forecast, crop safety invisible
- **AI Strategy wastes a whole tab** — shows only one card

## Solution

Redesign around **Feature Cards** with a bigger popup and 3 tabs.

## Layout

- **Popup size:** 520 × 650px (from 420×580)
- **Tabs:** 3 (from 4): Overview / Automation / Activity
- **Key pattern:** Collapsible Feature Cards — each card = toggle + config together

```
┌─────────────────────────────────────────────┐
│ ⚡ TRAVIAN BOT          ● Running  [▼ srv] │  Header
│ [▼ Village: 01 — Capital]                   │  Village bar
├─────────────────────────────────────────────┤
│  📊 Overview    ⚙ Automation    📋 Activity │  3 Tabs
├─────────────────────────────────────────────┤
│  (scrollable tab content)                   │
├─────────────────────────────────────────────┤
│ [▶ Start] [⏸ Pause] [⏹ Stop]    [⚠]      │  Control bar
└─────────────────────────────────────────────┘
```

## Tab 1: Overview

At-a-glance status. No config here — just monitor.

### Components (top to bottom):

1. **Resource Bars** — 4 rows: icon + bar + value + production rate (+580/h)
   - Bar color-coded: green (<60%), yellow (60-80%), red (>80%)
   - NEW: Crop safety warning line when net crop < 0

2. **Build Queue** — compact list of active constructions with timer
   - Same as current but more compact

3. **Current Task** — what bot is doing right now + progress bar
   - AI reason shown below (from AI Scoring)

4. **Stats Strip** — single compact row
   - ⚡32 done · ✕2 fail · ⏱1h24m · ⚔14 raids · 🪤45 traps
   - Next action timer on the right

5. **AI Insight** — moved from separate tab
   - Phase badge (Early/Mid/Late) + Focus
   - Top 3 recommendations
   - ResourceIntel data: overflow warnings, crop safety
   - Refresh button

### Removed from Overview (moved to other tabs):
- Feature toggles → Automation tab
- Task queue → Activity tab
- Troop summary → removed (low value, data in game)

## Tab 2: Automation

Each feature = **one collapsible card** with toggle switch + its config.

### Card Pattern:

```
┌─────────────────────────────────────────┐
│ [icon] Feature Name          [ON/OFF ●] │  ← Header (always visible)
│  ▸ Summary: key values when collapsed   │  ← Mini summary
├─────────────────────────────────────────┤
│ (expanded config when clicked)          │  ← Collapsible body
└─────────────────────────────────────────┘
```

- **Collapsed:** header + 1-line summary of current settings
- **Expanded:** full config fields
- **OFF features:** dimmed appearance, still expandable

### Cards (in order):

#### Card 1: Resource Upgrade
- Toggle: autoUpgradeResources
- **NEW: Bulk action bar** — "All Resources → Lv [input] [Apply]"
- Scan button
- Compact grid of resource fields (after scan): checkbox + name + current level + target input
- Group by type: Wood / Clay / Iron / Crop headers

#### Card 2: Building Upgrade
- Toggle: autoUpgradeBuildings
- **NEW: Bulk action bar** — "All → Lv [input] [Apply]" / "All +[N] levels [Apply]"
- Scan button
- Compact list of buildings: checkbox + name + current → target
- Empty slots shown with building selector dropdown

#### Card 3: Troop Training
- Toggle: autoTrainTroops
- Type selector, Batch size, Min resources
- Compact: 1 row layout

#### Card 4: Trap Training
- Toggle: autoTrainTraps
- Batch size only
- Very compact

#### Card 5: Farming
- Toggle: autoFarm
- Row 1: Interval (sec) + Min Troops
- Row 2: toggles — Use Farm Lists / Smart Farming
- Conditional: Smart Farming sub-settings (min loot, skip losses)
- **Advanced (collapsed):** Farm Target Scanner — coordinates, radius, population, oases, troop slot
- **Advanced (collapsed):** Manual Targets — X/Y/Name add form

#### Card 6: Hero Adventure
- Toggle: autoHeroAdventure
- Min Health slider or input
- Very compact

#### Card 7: Timing & Safety
- No toggle (always applies)
- Row: Min Delay / Max Delay / Max Actions per hour
- Always visible, not collapsible

### Bottom: Save Button
- Sticky at bottom of Automation tab
- "💾 Save All Settings"

## Tab 3: Activity

Queue + Logs combined.

### Components:

1. **Task Queue** — top section
   - Header with count badge + clear button
   - Scrollable list (max 150px)
   - Same content as current queue

2. **Activity Log** — bottom section
   - Level filter dropdown (All / Info / Warn / Error)
   - Clear button
   - Scrollable log area (fills remaining space)
   - Same formatting as current

## Visual Design

### Theme: Keep dark neon theme
- Same color variables (--primary: cyan, --success: green, --danger: red)
- Same neon glow effects on active elements
- Cards have subtle border glow when feature is ON
- Smooth transitions on expand/collapse (CSS max-height transition)

### Feature Card States:
- **ON + Collapsed:** subtle cyan left-border, normal text
- **ON + Expanded:** cyan left-border + expanded body
- **OFF + Collapsed:** dimmed text, gray left-border
- **OFF + Expanded:** dimmed header, normal body

### Upgrade Bulk Actions:
- Prominent action bar with input + button
- "Apply All" button uses primary glow style
- Individual items smaller/compact — checkbox + name + level

## Data Flow

### No backend changes needed — all data comes from existing messages:
- `GET_STATUS` → resources, build queue, current task, stats
- `GET_QUEUE` → task queue
- `GET_LOGS` → activity log
- `GET_STRATEGY` → AI recommendations
- `SAVE_CONFIG` → save automation settings
- `REQUEST_SCAN` → scan buildings

### New data displayed from existing backend:
- Resource pressure → from `GET_STATUS` response (DecisionEngine already computes this)
- Crop safety → from `GET_STATUS` response
- AI recommendations already include ResourceIntel warnings

## Migration Notes

### HTML changes:
- `popup/index.html` — rewrite with new structure
- All existing element IDs preserved OR mapped in popup.js

### CSS changes:
- `popup/styles.css` — rewrite with new layout + card components
- Keep CSS variable system
- Add collapsible card styles

### JS changes:
- `popup/popup.js` — update DOM refs, add collapse/expand logic, add bulk actions
- Message types unchanged — no service worker changes needed
- New: bulk target setter logic (iterate all upgrade inputs)

### What stays the same:
- Service worker (no changes)
- Content scripts (no changes)
- Core modules (no changes)
- All chrome.runtime.sendMessage types
- Control bar (Start/Pause/Stop/Emergency)

## Constraints

- Chrome extension popup max practical size: ~800×600
- No external dependencies (no React, no build tools)
- Plain CSS + JS only
- All existing popup.js functionality must work
- Backward compatible with saved configs
