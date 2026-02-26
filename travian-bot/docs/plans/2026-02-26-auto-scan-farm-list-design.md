# Auto-Scan Farm List — Design

## Goal

Bot auto-scans the Travian map to find inactive villages and unoccupied oases near the player's village, then adds them to the rally point farm list automatically.

## Data Source: map.sql

Travian servers publicly expose `/map.sql` (~970KB) containing every tile on the map.

**URL**: `https://{server}/map.sql` (no auth required, accessible via `fetch()`)

**SQL format**:
```sql
INSERT INTO `x_world` VALUES (tileId, x, y, tribe, playerId, villageName, userId, playerName, allianceId, allianceName, population, NULL, isCapital, NULL, NULL, NULL);
```

**Key fields for filtering**:
- `x, y` — tile coordinates (distance calculation)
- `tribe` — 1=Roman, 2=Teuton, 3=Gaul, 4=Nature, 5=Natar; 0=empty
- `population` — village size indicator (low pop = likely inactive)
- `allianceId` — 0 = no alliance (likely inactive)
- `userId` / `playerName` — identify owner (skip self)

## Architecture

```
map.sql (public) ──fetch──> MapScanner (parse + filter) ──targets──> FarmListManager (add via API/DOM)
                                  |                                         |
                           Config (radius, maxPop)                 Travian farm list
```

### Module: MapScanner (new: `core/mapScanner.js`)

Runs in service worker context. Responsibilities:
1. `fetch('/map.sql')` from the active Travian server
2. Parse INSERT statements via regex into tile objects
3. Calculate distance from player's village: `sqrt((x2-x1)^2 + (y2-y1)^2)`
4. Filter by configurable criteria
5. Return ranked candidate list

**Filter criteria** (all configurable):
- `distance <= scanRadius` (default: 10)
- `population <= maxPop` (default: 50) — small = likely inactive
- `population > 0` — has a village (not empty tile)
- `allianceId === 0` — no alliance = likely inactive
- `userId !== ownUserId` — skip own villages
- Not already in existing farm list

**Oasis detection**: `tribe === 4` (Nature) with `population === 0` = unoccupied oasis with raidable resources.

### Module: FarmListManager (new: `content/farmListManager.js`)

Runs in content script context. Responsibilities:
1. Read existing farm list slots (reuse `domScanner.scanFarmListSlots()`)
2. Add new targets to farm list

**Add method — primary: Travian.api()**

Travian's internal API pattern discovered:
- Remove: `Travian.api("village/{villageId}/remove-from-farm-lists", {data:{}, success:fn})`
- Add: likely `Travian.api("farm-list/{listId}/add", {data:{x, y}, success:fn})` or similar

Content script calls `Travian.api()` through page context bridge (`window.postMessage`).

**Add method — fallback: DOM simulation**

If API endpoint not found or fails:
1. Navigate to `karte.php?x=X&y=Y`
2. Click "add to farm list" button in village popup
3. Select target farm list
4. Confirm

### BotEngine Integration

New task type: `scan_farm_targets`

```javascript
case 'scan_farm_targets':
  // 1. Fetch and parse map.sql
  // 2. Filter candidates
  // 3. Navigate to farm list tab
  // 4. Read existing slots
  // 5. Add new targets via content script
  break;
```

Triggered by:
- User clicking "Scan Now" button in popup
- Auto-scan on bot start (if `autoScanFarmTargets` enabled)
- Periodic re-scan (configurable interval, default: disabled)

### Config

```javascript
farmConfig: {
  // ... existing fields ...
  autoScanFarmTargets: false,     // auto-scan on bot start
  scanRadius: 10,                 // map tiles radius
  scanMaxPop: 50,                 // max population to consider
  scanIncludeOases: true,         // include unoccupied oases
  scanAllianceOnly: false,        // true = skip players with alliance
}
```

### Popup UI

Added to Farming section in Config tab:

```html
<h4>Farm Target Scanner</h4>
[Scan Radius]  10    [Max Population]  50
[x] Include Oases    [x] Skip players with alliance
[Scan Now] button
<div id="scanResult">--</div>
```

"Scan Now" sends `SCAN_FARM_TARGETS` message to service worker.
Result displays: "Found 32 targets, 18 new, added 18 to KRG1"

### Constraints

- map.sql updates every ~5 minutes on Travian servers
- Farm list has max 100 slots (shown at bottom: "รายการเมืองปล้น: 1/100")
- Don't add targets that would exceed the 100-slot limit
- Rate limit: add targets with human-like delays between each

### Verified Data Points

- **S4**: KRG's village at (61, 120), pop 180, userId 9034 — confirmed in map (1).sql
- **S5**: KRGz at (79, -73), pop 55 — confirmed in map.sql
- **map.sql URL**: `/map.sql` returns 200 OK, ~970KB, no auth needed
- **Farm list limit**: 100 slots per village (visible in UI footer)
- **Existing farm list**: KRG1 with 26/100 slots used
