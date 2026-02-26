# Popup UI v3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rewrite the Chrome extension popup from a 4-tab 420x580 layout to a 3-tab 520x650 Feature-Card layout that's faster to configure.

**Architecture:** Replace all three popup files (index.html, styles.css, popup.js) in-place. The new UI uses collapsible Feature Cards on the Automation tab, each card combining a feature toggle with its config. Bulk upgrade actions solve the painful 40-slot-by-slot configuration. No backend/service-worker changes needed — all chrome.runtime.sendMessage types remain identical.

**Tech Stack:** Plain HTML/CSS/JS (no build tools, no frameworks). Chrome Extension Manifest V3 popup.

**Design doc:** `docs/plans/2026-02-27-popup-ui-v3-design.md`

---

## Context for the implementer

### Key files
- `popup/index.html` — 397 lines, full rewrite
- `popup/styles.css` — 1310 lines, full rewrite (keep CSS variables + theme)
- `popup/popup.js` — 1964 lines, heavy refactor (keep all business logic, rewrite DOM refs + rendering)

### What MUST stay the same
- All `chrome.runtime.sendMessage` types: `START_BOT`, `STOP_BOT`, `PAUSE_BOT`, `EMERGENCY_STOP`, `GET_STATUS`, `GET_LOGS`, `GET_QUEUE`, `GET_STRATEGY`, `SAVE_CONFIG`, `CLEAR_QUEUE`, `SWITCH_VILLAGE`, `REQUEST_SCAN`, `GET_SERVERS`, `SCAN_FARM_TARGETS`
- Config object shape from `collectConfig()` — backward compatible with saved configs
- `populateForm(config)` — must handle old config shapes
- Server detection + selector logic
- Control bar (Start/Pause/Stop/Emergency)
- 2-second polling via `fullRefresh()`

### What changes
- Body size: 420x580 to 520x650
- Tabs: 4 (Dash/Config/AI/Logs) to 3 (Overview/Automation/Activity)
- Dashboard stats, resources, build queue, AI insight merged into Overview tab
- Feature toggles + all config merged into Automation tab as Feature Cards
- Task queue + logs merged into Activity tab
- NEW: Collapsible Feature Card component
- NEW: Bulk upgrade actions ("All Resources to Lv [input] [Apply]")
- REMOVED: Troop summary section, Quest section, separate AI Strategy tab

### innerHTML usage note
This Chrome extension popup only processes data from its own service worker via `chrome.runtime.sendMessage`. The data pipeline is:
- Service worker scans Travian DOM and serializes game state
- Popup receives JSON data and renders it
- No user-generated HTML is ever inserted

Existing code uses innerHTML for strategy dashboard rendering (with `escapeHtml()` sanitization) and upgrade list rendering (creating DOM elements programmatically). The same patterns continue in v3.

---

## Task 1: HTML — New 3-Tab Skeleton

**Files:**
- Rewrite: `popup/index.html`

**Step 1: Write the new HTML structure**

Replace the entire `popup/index.html` with the new 3-tab layout. Key structural changes:

1. Tab bar: 3 buttons (overview/automation/activity) instead of 4 (dash/config/ai/logs)
2. Overview tab (`panelOverview`): resources, build queue, current task, stats strip, AI insight
3. Automation tab (`panelAutomation`): 7 Feature Cards with toggle+config, bulk action bars, save button
4. Activity tab (`panelActivity`): task queue + activity log

Each Feature Card follows this HTML pattern:
```
div.feature-card[data-feature="xxx"]
  div.feature-card-header[data-collapse-toggle]
    span.feature-card-icon
    span.feature-card-name
    span.feature-card-summary#summaryXxx
    label.feature-toggle > input[type=checkbox]#togXxx + span.toggle-slider
  div.feature-card-body
    (config form fields)
```

The resource bars now use emoji icons instead of text labels:
- Wood: tree emoji
- Clay: brick emoji
- Iron: pick emoji
- Crop: wheat emoji

Upgrade targets are split into two lists:
- `#resourceUpgradeList` inside Card 1 (Resource Upgrade)
- `#buildingUpgradeList` inside Card 2 (Building Upgrade)

Each has its own Scan button and Bulk Action bar.

Farming card uses `<details>` elements for Advanced sections (Farm Target Scanner, Manual Targets) — native HTML collapse without JS.

Timing & Safety card has class `feature-card--always` and its body has `feature-card-body--open` — always visible, no collapse.

All element IDs from the old HTML are preserved where the element still exists. Changed IDs:
- `upgradeList` split into `resourceUpgradeList` + `buildingUpgradeList`
- `statsBar` (2x2 grid) replaced by `statsStrip` (single row)
- New IDs: `bulkResourceLevel`, `btnBulkResourceApply`, `bulkBuildingLevel`, `btnBulkBuildingApply`, `btnScanResources`, `summaryResourceUpgrade`, `summaryBuildingUpgrade`, `summaryTroopTraining`, `summaryTrapTraining`, `summaryFarming`, `summaryHeroAdventure`, `aiInsightSection`

Removed IDs (sections removed from UI):
- `troopSummary`, `troopDisplay` (troop summary removed)
- `questSection`, `questDisplay` (quest progress removed)
- `statRate` (actions/hr stat card removed, replaced by stats strip)

**Step 2: Verify the HTML loads**

Open Chrome extensions page, reload extension, click popup icon.
Expected: Popup opens with new structure visible. Console may show errors from popup.js until Task 3 updates the JS.

**Step 3: Commit**

```bash
git add popup/index.html
git commit -m "feat(popup): new 3-tab HTML skeleton for v3 redesign

Replaces 4-tab layout (Dash/Config/AI/Logs) with 3-tab layout
(Overview/Automation/Activity). Adds Feature Card structure on
Automation tab with bulk upgrade bars. Splits upgrade list into
resource and building lists."
```

---

## Task 2: CSS — New Layout + Feature Card Styles

**Files:**
- Rewrite: `popup/styles.css`

**Step 1: Write the new CSS**

Key changes from current CSS:

1. `body { width: 520px; height: 650px; }` (from 420x580)

2. Keep UNCHANGED:
   - `:root` CSS variables block (all color/spacing vars)
   - Scrollbar styles
   - Header styles
   - Server bar styles
   - Village bar styles
   - Tab bar styles (flex layout works with 3 tabs automatically)
   - Tab content + panel styles
   - Cards & sections base styles
   - Current task + progress bar styles
   - Toggle pill styles
   - Queue list styles
   - All button styles
   - Control bar styles
   - Form element styles
   - Farm target styles
   - Upgrade list styles (including upgrade-row, upgrade-group-title, upgrade-empty, upgrade-building-select)
   - Log viewer styles
   - Strategy dashboard styles (all strategy-* classes)
   - Build queue styles
   - AI scoring reason styles

3. ADD NEW:
   - `.feature-card` component (background, border-left for ON/OFF state, margin, overflow, transitions)
   - `.feature-card.is-on` (cyan left border)
   - `.feature-card.is-off` (gray border, 0.7 opacity)
   - `.feature-card-header` (flex row, cursor pointer, hover background)
   - `.feature-card-icon` (16px emoji)
   - `.feature-card-name` (13px bold)
   - `.feature-card-summary` (flex:1, muted text, ellipsis)
   - `.feature-card-body` (max-height:0, overflow:hidden, CSS transition 0.3s)
   - `.feature-card-body.is-expanded` (max-height:800px, padding, border-top)
   - `.feature-card-body--open` (max-height:none, always visible for Timing card)
   - `.feature-toggle` (36x20 slide switch container)
   - `.toggle-slider` (the sliding track + circle)
   - `.feature-toggle input:checked + .toggle-slider` (primary color glow)
   - `.bulk-action-bar` (flex row, input border, prominent styling)
   - `.bulk-input` (50px wide, centered text)
   - `.stats-strip` (flex row, space-between, compact)
   - `.stats-strip-item` (inline-flex, small text)
   - `.stats-strip-right` (margin-left:auto, primary color)
   - `.advanced-section` (border-top, padding)
   - `.advanced-toggle` (summary element, no list marker)
   - `.advanced-body` (padding-top)
   - `.ai-scoring-row` (padding)
   - `.form-group--quarter` (flex: 0.5 or 25% width)

4. REMOVE:
   - `.stats-grid` (2x2 grid — replaced by stats strip)
   - `.stat-card` and all stat-card variants (replaced by stats strip)
   - `.toggle-grid` (Feature Cards replace the toggle grid)
   - `.troop-grid`, `.troop-item`, `.troop-name`, `.troop-count` (troop summary removed)
   - `.quest-list`, `.quest-item`, `.quest-progress`, `.quest-progress-fill`, `.quest-item-pct` (quest removed)
   - `.info-strip`, `.info-strip-item`, `.info-strip-icon` (replaced by stats strip)
   - `.res-label` text styles (replaced by emoji icons)

5. MODIFY:
   - `.resource-row` grid-template-columns: `28px 1fr 52px 52px` (icon column narrower, was 36px for text label)

**Step 2: Verify CSS renders**

Reload extension, open popup. Check: 520x650 size, Feature Cards visible with borders, collapse/expand works visually.

**Step 3: Commit**

```bash
git add popup/styles.css
git commit -m "feat(popup): CSS for 520x650 layout with Feature Card components

New popup dimensions. Feature Card styles with collapse/expand
CSS transitions, toggle switches, bulk action bars, compact
stats strip. Dark neon theme CSS variables unchanged."
```

---

## Task 3: popup.js — DOM Refs + Tab Navigation + Core Infrastructure

**Files:**
- Modify: `popup/popup.js`

This task updates the JS infrastructure. The business logic (sendMessage, collectConfig, populateForm, refreshStatus, etc.) stays mostly unchanged.

**Step 1: Replace the `dom` object (lines 12-138)**

Update all getElementById calls for the new HTML. Key changes:
- Remove: `troopDisplay`, `questSection`, `questDisplay`, `statRate`
- Add: `resourceUpgradeList`, `buildingUpgradeList`, `btnScanResources`
- Add: `bulkResourceLevel`, `btnBulkResourceApply`, `bulkBuildingLevel`, `btnBulkBuildingApply`
- Add: `summaryResourceUpgrade`, `summaryBuildingUpgrade`, `summaryTroopTraining`, `summaryTrapTraining`, `summaryFarming`, `summaryHeroAdventure`
- Keep all other refs (same IDs in new HTML)

**Step 2: Update `TAB_PANEL_MAP` (line 147)**

From: `{ dash: 'panelDash', config: 'panelConfig', ai: 'panelAI', logs: 'panelLogs' }`
To: `{ overview: 'panelOverview', automation: 'panelAutomation', activity: 'panelActivity' }`

`switchTab()` function unchanged — it uses `btn.dataset.tab` and the map.

**Step 3: Add Feature Card collapse/expand system**

Add after tab navigation section:
- `initFeatureCards()` — binds click-to-collapse on headers, stop toggle clicks from bubbling
- `updateCardOnOffState(card, toggle)` — add/remove `is-on`/`is-off` classes
- `updateCardSummaries()` — update summary text in each card header

**Step 4: Remove obsolete functions**

Delete entirely:
- `updateTroopSummary()` (troop summary removed)
- `updateQuestDisplay()` (quest section removed)

Simplify `updateStats()` — remove `statRate` ref, keep `statCompleted`, `statFailed`, `statUptime`.

**Step 5: Update `refreshStatus()` (lines 1372-1429)**

Remove calls to `updateTroopSummary()` and `updateQuestDisplay()`. Everything else stays.

**Step 6: Split `renderUpgradeList()` into two containers**

Old: renders everything into `dom.upgradeList`
New: resources into `dom.resourceUpgradeList`, buildings into `dom.buildingUpgradeList`

`createUpgradeRow()` and `createEmptySlotRow()` stay unchanged — they return DOM elements.

**Step 7: Update `collectUpgradeTargets()` to read from both lists**

Query `.upgrade-row` from both `resourceUpgradeList` and `buildingUpgradeList`.

**Step 8: Add bulk upgrade action handlers in `bindEvents()`**

- `btnBulkResourceApply` click: set all resource upgrade rows to checked + target level
- `btnBulkBuildingApply` click: set all building upgrade rows (non-empty) to checked + target level
- `btnScanResources` click: calls same `scanBuildings()` function

**Step 9: Update `scanBuildings()` to handle both scan buttons**

Disable/enable both `btnScanResources` and `btnScanBuildings`, update both lists on failure.

**Step 10: Update toggle immediate-save in `bindEvents()`**

Replace the hardcoded `toggles` array with a querySelectorAll on `.feature-card .feature-toggle input` and `.toggle-pill input`.

**Step 11: Update initialization**

In `DOMContentLoaded` handler, after `bindEvents()`:
1. Call `initFeatureCards()`
2. After `loadConfig()` → `populateForm()` → call `updateCardSummaries()` and update card ON/OFF states

**Step 12: Update `populateForm()` tail**

At the end of `populateForm()`, add:
```javascript
updateCardSummaries();
document.querySelectorAll('.feature-card[data-feature]').forEach(function (card) {
  var toggle = card.querySelector('.feature-toggle input');
  updateCardOnOffState(card, toggle);
});
```

**Step 13: Verify the full popup works**

Reload extension, open popup. Verify:
- 3 tabs switch correctly
- Feature Cards collapse/expand
- Toggles change card ON/OFF visual state
- Scan works (both resource and building)
- Bulk Apply sets all targets
- Config saves and loads
- Control bar works
- No console errors

**Step 14: Commit**

```bash
git add popup/popup.js
git commit -m "feat(popup): migrate popup.js to v3 3-tab Feature Card layout

Updated DOM refs, tab navigation (3 tabs), Feature Card collapse/
expand with ON/OFF states, split upgrade lists, bulk upgrade
actions, card summaries. Removed troop summary and quest display.
All message types and config shape unchanged."
```

---

## Task 4: Resource Bar Color Coding

**Files:**
- Modify: `popup/popup.js` (`updateResources` function)
- Modify: `popup/styles.css`

**Step 1: Add color classes in updateResources()**

After calculating `pct` for each resource bar, add/remove CSS classes:
- `res-green` when pct < 60
- `res-yellow` when 60 <= pct < 80
- `res-red` when pct >= 80

The existing per-resource gradient colors (`.res-fill-wood`, etc.) become the default. The new classes override for high-fill states.

**Step 2: Add CSS for color states**

```css
.res-bar-fill.res-red { background: linear-gradient(90deg, var(--danger-dim), var(--danger)) !important; }
.res-bar-fill.res-yellow { background: linear-gradient(90deg, #aa7700, var(--warning)) !important; }
```

Green state keeps the per-resource colors (no override needed).

**Step 3: Commit**

```bash
git add popup/popup.js popup/styles.css
git commit -m "feat(popup): color-coded resource bars by fill percentage

Green <60%, yellow 60-80%, red >80%. Adds visual urgency when
resources are near overflow."
```

---

## Task 5: Integration Testing

Manual testing checklist. No code to write — just verify everything works.

**Overview Tab:**
- [ ] Resource bars: icons, values, production rates, color coding
- [ ] Resource bars pulse when >90%
- [ ] Build queue with countdown timers
- [ ] Current task with AI reason and progress bar
- [ ] Stats strip: completed/failed/uptime/raids/traps/next timer
- [ ] AI Insight: phase badge, recommendations, refresh button

**Automation Tab:**
- [ ] 7 Feature Cards visible
- [ ] Each card collapses/expands on header click
- [ ] Toggle switches work (ON = cyan border, OFF = gray + dimmed)
- [ ] Card summaries update when collapsed
- [ ] Resource Upgrade: Scan works, bulk Apply sets all targets
- [ ] Building Upgrade: Scan works, bulk Apply sets all targets
- [ ] Troop Training: Type, batch, min res inputs
- [ ] Trap Training: Batch size input
- [ ] Farming: All inputs + toggles + advanced sections expand
- [ ] Hero Adventure: Min health input
- [ ] Timing & Safety: Always visible, all inputs
- [ ] AI Scoring toggle
- [ ] Save button shows "Saved!" feedback

**Activity Tab:**
- [ ] Task queue with count badge and clear button
- [ ] Activity log with level filter and clear
- [ ] Log auto-scrolls to bottom

**Cross-cutting:**
- [ ] Server selector switches servers
- [ ] Village selector works
- [ ] Control bar: Start/Pause/Stop/Emergency
- [ ] 2-second polling updates all sections
- [ ] Config persists across popup close/reopen
- [ ] Config backward compatible with old saves
- [ ] No console errors

Fix any issues found, commit each fix separately.

---

## Task 6: Polish + Documentation Update

**Files:**
- Modify: `popup/styles.css` (visual tweaks)
- Modify: `popup/popup.js` (edge cases)
- Modify: `CLAUDE.md` (update Popup UI Architecture section)

**Step 1: Visual polish pass**

- Smooth transitions on all animations
- Readable text at 520x650
- Scrolling works on Automation tab (longest content)
- Feature Card glow effects when ON
- Consistent spacing between cards

**Step 2: Update CLAUDE.md**

Update the "Popup UI Architecture" section to describe the new 3-tab layout, Feature Cards pattern, and bulk upgrade actions.

Update the "Pitfalls" section:
- Change popup size reference from 420x580 to 520x650
- Note that Feature Card toggles are now inside cards, not a separate section

**Step 3: Commit**

```bash
git add -A
git commit -m "chore(popup): polish v3 UI and update documentation"
```

---

## Expected commits (5-6 total):

1. `feat(popup): new 3-tab HTML skeleton for v3 redesign`
2. `feat(popup): CSS for 520x650 layout with Feature Card components`
3. `feat(popup): migrate popup.js to v3 3-tab Feature Card layout`
4. `feat(popup): color-coded resource bars by fill percentage`
5. `fix(popup): integration fixes from v3 testing` (if needed)
6. `chore(popup): polish v3 UI and update documentation`

## NOT in scope:

- Service worker changes (none needed)
- Content script changes (none needed)
- New message types (none needed)
- Resource Intelligence pressure indicators (separate follow-up)
- Config migration script (populateForm already handles old shapes)
