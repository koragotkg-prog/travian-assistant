# Upgrade Targets UX Redesign

## Context

User feedback: "ตอนนี้มันใช้ยาก ช่วยออกแบบหน่อยได้ไหม ให้ใช้ได้ง่ายกว่านี้" — current Upgrade Targets is a long flat list that's hard to use.

Three improvements requested:
1. **Resource fields grouped by type** (Wood/Clay/Iron/Crop) instead of flat list
2. **Buildings show prerequisites** — select a building, see what needs to be built first (backend DFS auto-resolves already, just need to show it in UI)
3. **Per-village targets** — currently global per-server, need separate targets per village

## Files to Modify

| File | Changes |
|------|---------|
| `popup/popup.js` | Rewrite `renderUpgradeList()`, add resource grouping, prereq display, per-village cache, `BUILDING_PREREQS` constant |
| `popup/styles.css` | Add resource type headers, prereq indicator, collapse/expand styles |
| `popup/index.html` | Add village scope indicator in upgrade section |

**No changes needed:** `decisionEngine.js`, `botEngine.js`, `service-worker.js` — backend reads `config.upgradeTargets` which stays unchanged.

## UI Layout (420px width)

```
+-- Upgrade Targets ---------- [Scan] --+
| Targets for: Capital Village          |  <- village scope label
| 4 targets active  ⚠ Res OFF [All][None]
|                                        |
| ▸ 🟫 WOOD (4)   avg Lv.7  -> [_10_]  |  <- type header + batch target
|   [x] F1  Lv.7  -> [10]              |  <- individual fields (collapsed by default)
|   [x] F3  Lv.7  -> [10]              |
|   [ ] F14 Lv.5  -> [10]              |
|   [ ] F17 Lv.6  -> [10]              |
| ▸ 🟧 CLAY (4)   avg Lv.6  -> [_10_]  |
| ▸ ⬜ IRON (4)   avg Lv.5  -> [_10_]  |
| ▸ 🟨 CROP (6)   avg Lv.4  -> [_10_]  |
|                                        |
| BUILDINGS                              |
| [x] Main Building   Lv.8 -> [15]     |
| [x] Warehouse       Lv.6 -> [10]     |
| [x] Stable          Lv.0 -> [5]      |
|     ↳ Academy Lv.5 (need 2), Bks OK  |  <- prereq line
|                                        |
| EMPTY SLOTS (3)                        |
| [ ] Slot 24  [-- Select --]  -> [1]  |
|     ↳ needs: MB 3, Rally Pt 1        |  <- dynamic prereq preview
+----------------------------------------+
```

## Implementation Steps

### Step 1: Add BUILDING_PREREQS constant to popup.js

Copy from `strategy/gameData.js` lines 230-247. Small static map (~15 entries):

```js
const BUILDING_PREREQS = {
  5:  [{gid: 15, level: 5}, {gid: 1, level: 10}],  // Sawmill
  6:  [{gid: 15, level: 5}, {gid: 2, level: 10}],  // Brickyard
  7:  [{gid: 15, level: 5}, {gid: 3, level: 10}],  // Iron Foundry
  8:  [{gid: 15, level: 5}, {gid: 4, level: 5}],   // Grain Mill
  9:  [{gid: 15, level: 5}, {gid: 8, level: 5}, {gid: 4, level: 10}], // Bakery
  17: [{gid: 15, level: 1}, {gid: 10, level: 1}, {gid: 11, level: 1}], // Marketplace
  18: [{gid: 15, level: 1}],                        // Embassy
  19: [{gid: 15, level: 3}, {gid: 16, level: 1}],  // Barracks
  20: [{gid: 22, level: 5}, {gid: 19, level: 3}],  // Stable
  21: [{gid: 15, level: 5}, {gid: 22, level: 10}], // Workshop
  22: [{gid: 15, level: 3}, {gid: 19, level: 3}],  // Academy
  24: [{gid: 15, level: 10}, {gid: 22, level: 10}],// Town Hall
  25: [{gid: 15, level: 5}],                        // Residence
  26: [{gid: 15, level: 5}, {gid: 18, level: 1}],  // Palace
  28: [{gid: 15, level: 10}, {gid: 17, level: 20}, {gid: 20, level: 10}], // Trade Office
  37: [{gid: 15, level: 3}, {gid: 16, level: 1}],  // Hero Mansion
};
```

**Location:** After `GID_NAMES` constant (~line 215).

### Step 2: Per-village target cache

Add variables and helpers:

```js
let currentVillageId = null;
let villageTargetCache = {};
// Shape: { "villageId": { upgradeTargets: {...}, scannedRes: [...], scannedBld: [...] } }
```

Three new functions:
- **`saveCurrentVillageTargets()`** — saves `upgradeTargets`, `scannedResources`, `scannedBuildings` into `villageTargetCache[currentVillageId]`
- **`loadVillageTargets(villageId)`** — loads from cache into working variables, or initializes empty. Sets `currentVillageId = villageId`.
- **`migrateGlobalTargets(config)`** — one-time migration: if `config.villageTargets` is absent but `config.upgradeTargets` exists, move old targets into `villageTargets[config.activeVillage || 'default']`

### Step 3: Rewrite `renderUpgradeList()` — grouped layout

Replace flat rendering (~lines 851-901) with three sub-renderers:

**`renderResourceFieldGroups()`:**
- Group `scannedResources` by GID (1=Wood, 2=Clay, 3=Iron, 4=Crop)
- Render type header per group: `[check-all] [color-dot] TYPE (N) avg Lv.X -> [batch-target] [▸]`
- Below each header: individual field rows (same `createUpgradeRow()`)
- Type headers start collapsed by default
- "Check-all" toggles all fields of that type
- "Batch target" input sets target for all fields of that type

**`renderBuildingsList(existingBuildings)`:**
- Same as current: sorted by level ascending, `createUpgradeRow(item)` per building
- **NEW:** After each row, if `BUILDING_PREREQS[item.gid]` exists, append a `createPrereqLine(item.gid)`

**`renderEmptySlots(emptySlots)`:**
- Same as current: `createEmptySlotRow(item)` per empty slot
- **NEW:** When building dropdown changes, dynamically append/update `createPrereqLine(selectedGid)` below the row

### Step 4: New function — `createResourceTypeHeader(gid, fields)`

Returns DOM element:
```
[check-all-cb] [color-dot] WOOD (4)  avg Lv.7  -> [batch-input] [▸]
```

- Color dots: Wood=#8bc34a, Clay=#ff7043, Iron=#78909c, Crop=#ffd54f (match dashboard)
- Check-all checkbox: toggles all field checkboxes of this type + updates `upgradeTargets`
- Batch target input: on change, updates all individual field target inputs of this type
- Chevron: click toggles `.collapsed` class on the fields container below

### Step 5: New function — `createPrereqLine(gid)`

Returns DOM element (or null if no prereqs):
```
↳ Academy Lv.5 (need 2 more), Barracks Lv.3 ✓
```

- Looks up `BUILDING_PREREQS[gid]`
- For each prereq, finds current level from `scannedBuildings` (by matching gid) or `scannedResources` (for gid 1-4)
- Color-coded: green = met, amber = partially met (shows "need X more"), red = not built
- Small font (10px), indented under the parent row

### Step 6: Update village scope indicator in HTML

In `index.html`, add after `targetSummary`:
```html
<div id="villageScope" class="village-scope" style="display:none">
  Targets for: <span id="villageScopeName">—</span>
</div>
```

In JS, update `villageScopeName` text whenever village changes.

### Step 7: Update `collectConfig()` and `populateForm()`

**`collectConfig()`** (~line 1180):
- Call `saveCurrentVillageTargets()` before collecting
- Add `villageTargets: villageTargetCache` to returned config
- Keep `upgradeTargets: collectUpgradeTargets()` for backward compat (decision engine reads this)

**`populateForm(config)`** (~line 1282):
- Load `config.villageTargets` into `villageTargetCache`
- Run `migrateGlobalTargets(config)` if needed
- Set `currentVillageId` from `config.activeVillage`
- `loadVillageTargets(currentVillageId)` then `renderUpgradeList()`

### Step 8: Wire village selector to target switching

Update village change handler (~line 2046):
```js
dom.villageSelect.addEventListener('change', () => {
  const villageId = dom.villageSelect.value;
  if (villageId) {
    saveCurrentVillageTargets();      // save old village
    loadVillageTargets(villageId);    // load new village
    renderUpgradeList();              // re-render targets
    updateVillageScope();             // update scope label
    sendMessage({ type: 'SWITCH_VILLAGE', villageId }).catch(console.warn);
  }
});
```

### Step 9: CSS for new components (~60 lines in styles.css)

```css
/* Resource type group header */
.res-type-header { display: flex; align-items: center; gap: 4px; padding: 4px 2px; cursor: pointer; }
.res-type-dot { width: 10px; height: 10px; border-radius: 2px; flex-shrink: 0; }
.res-type-label { flex: 1; font-size: 11px; font-weight: 600; }
.res-type-avg { font-size: 10px; color: var(--text-muted); }
.res-type-batch { width: 38px; /* same as upgrade-target */ }
.res-type-chevron { transition: transform 0.15s; }
.res-type-chevron.expanded { transform: rotate(90deg); }
.res-type-fields { padding-left: 16px; }
.res-type-fields.collapsed { display: none; }

/* Prerequisite indicator */
.prereq-line { font-size: 10px; padding: 1px 0 3px 20px; color: var(--text-muted); }
.prereq-met { color: var(--success); }
.prereq-partial { color: var(--warning); }
.prereq-missing { color: var(--error); }

/* Village scope */
.village-scope { font-size: 10px; color: var(--text-muted); margin-bottom: 4px; }
```

## Backward Compatibility

- `config.upgradeTargets` (flat object) stays unchanged — decision engine reads only this
- `collectConfig()` outputs active village's targets as `upgradeTargets` (same contract)
- New `config.villageTargets` is popup-only storage, backend never reads it
- First load: if `villageTargets` absent, `migrateGlobalTargets()` copies old `upgradeTargets` into the active village's entry

## Verification

1. `node -c popup.js` — syntax check
2. Load extension, open popup on Travian tab
3. **Resource grouping**: Click Scan → resources appear in 4 color-coded groups (Wood/Clay/Iron/Crop). Collapse/expand works. Batch target updates all fields of that type.
4. **Prereqs**: Enable a building with prerequisites (e.g., Stable) → prereq line shows "Academy Lv.5 (need X more), Barracks Lv.3 ✓". Select a building in empty slot dropdown → prereq preview updates.
5. **Per-village**: Switch village in dropdown → targets change. Switch back → old targets restored. Save → close popup → reopen → per-village targets persisted.
6. **Backward compat**: Bot still upgrades based on `config.upgradeTargets` correctly.
7. Popup fits within 420×580px, no overflow.
