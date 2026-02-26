# Smart Farming System — Detailed Design

**Date:** 2026-02-25
**Status:** Draft
**Related:** `2026-02-25-mac-standalone-app-design.md` (Feature 5.3)

---

## 1. Problem Analysis

ระบบ farming ปัจจุบันทำได้แค่:
- กด "Start All" ใน Farm List ทุก 5 นาที
- ส่งไปบ้านเดิมๆ ซ้ำๆ ไม่ว่าจะปล้นได้หรือเสียทหาร
- **ไม่อ่าน report** → ไม่รู้ว่าเป้าไหนโดนป้องกัน
- **ไม่เลือกทหาร** → ส่งแบบเดิมไม่ว่าเป้าใกล้/ไกล
- **ไม่คำนวณ timing** → ส่งพร้อมกันหมด ไม่ว่า travel time จะต่างกัน
- `militaryPlanner.scoreFarmTarget()` เขียนไว้แล้วแต่ไม่มีใครใช้

ผู้เล่นระดับเซียนต้องการ:
1. ปล้นแล้วได้ resources สูงสุด
2. เสียทหารน้อยที่สุด (ถ้าเสีย 2 ครั้ง → หยุดส่งไปเป้านั้น)
3. ส่งทหารเร็วไปเป้าใกล้ ส่งทหารถูกไปเป้าเสี่ยง
4. Wave timing ที่ดี — ให้เป้าสะสม resources ก่อนส่งรอบถัดไป
5. สอดแนม (scout) ก่อนถ้าไม่แน่ใจ

---

## 2. Architecture

```
FarmManager (new module — sidecar/strategy/farm-manager.js)
│
├── TargetTracker ── เก็บประวัติแต่ละเป้า (profit, loss, timing)
│
├── WaveScheduler ── คำนวณเวลาส่งแต่ละ wave ให้ optimal
│
├── TroopRouter ── เลือกทหารที่เหมาะกับแต่ละเป้า
│
└── ReportAnalyzer ── อ่าน raid report แล้ว update TargetTracker
```

### Data Flow

```
DecisionEngine.evaluateFarming()
    │
    │  mode === 'smart'?
    ▼
FarmManager.planNextWave(gameState, config)
    │
    ├── 1. ReportAnalyzer.scan() → อ่าน report ใหม่
    │       ↓
    │   TargetTracker.update(reports) → update profit/loss per target
    │
    ├── 2. TargetTracker.getActiveTargets() → กรอง targets ที่ยังดี
    │       ↓
    │   MilitaryPlanner.planRaids(targets, origin, troops) → score + rank
    │
    ├── 3. WaveScheduler.schedule(rankedTargets, travelTimes)
    │       ↓
    │   return { actions: [{type, target, troops, sendAt}], nextWaveAt }
    │
    └── 4. TroopRouter.assign(targets, availableTroops, config)
            ↓
        return troopAssignment per target
```

---

## 3. Three Farming Modes

### Mode 1: `farmList` (default — same as current)
- กด Start All ใน Farm List ทุก N วินาที
- ไม่ต้องเปลี่ยนอะไร เหมือนเดิม
- ดีสำหรับคนที่จัด farm list เอง

### Mode 2: `smart` (ใหม่ — recommended)
- อ่าน report → track แต่ละเป้า
- Auto-score + auto-skip เป้าที่เสียทหาร
- เลือกทหารเองตาม distance/risk
- Wave timing ตาม travel time
- ยังใช้ Farm List เดิม แต่ **เพิ่ม intelligence ข้างบน**

### Mode 3: `manual` (existing — coordinate targets)
- ส่งไปพิกัดที่ user กำหนดเอง
- ใช้ `sendAttack()` แทน farm list

---

## 4. Core Components

### 4.1 ReportAnalyzer (dom-scanner addition)

**New method:** `domScanner.scanRaidReports()`

ต้อง:
1. Navigate ไปหน้า Reports: `berichte.php` หรือ `build.php?gid=16&tt=1`
2. Filter เฉพาะ raid reports (icon = green/yellow/red sword)
3. Parse แต่ละ report:
   - เป้า: ชื่อ + พิกัด (x|y)
   - Resources gained: wood, clay, iron, crop
   - Troop losses: จำนวนทหารที่เสีย (per type)
   - Carry: ได้เต็ม capacity หรือยัง (bounty full/partial)
   - Time: เวลาที่ report ถูกสร้าง

**DOM Selectors (Travian Legends, Feb 2025):**
```
Report list:   #reportsTable tbody tr
Report type:   .reportIcon img (class contains 'attack' or 'raid')
                หรือ .iReport (color class: green = no loss, yellow = some, red = full)
Target name:   .troopHeadline a (link to target village)
Resources:     .resourcesContainer .resources span (wood, clay, iron, crop)
Bounty:        .bounty .carry (ค่า current/max)
Troop losses:  .troopsTable .dead (จำนวนทหารที่ตาย)
Report time:   .time (timestamp)
```

**Return format:**
```javascript
{
  reports: [
    {
      targetName: "Natars Village",
      targetCoords: { x: 42, y: -15 },
      timestamp: 1740000000000,
      resourcesGained: { wood: 500, clay: 300, iron: 200, crop: 100 },
      totalLoot: 1100,
      carryUsed: 1100,
      carryMax: 1500,
      bountyFull: false,
      troopLosses: { legionnaire: 0, imperatoris: 0 },
      totalLosses: 0,
      reportType: "raid",    // 'raid' | 'attack'
      resultColor: "green"   // 'green' | 'yellow' | 'red'
    }
  ]
}
```

### 4.2 TargetTracker

**ข้อมูลที่เก็บต่อเป้า:**
```javascript
{
  // Key = "x|y" e.g. "42|-15"
  "42|-15": {
    name: "Natars Village",
    coords: { x: 42, y: -15 },
    distance: 12.5,           // from origin, calculated once

    // History (rolling window, last 20 raids)
    raidHistory: [
      { timestamp, loot: 1100, carry: 1500, losses: 0, color: "green" },
      { timestamp, loot: 800, carry: 1500, losses: 0, color: "green" },
      { timestamp, loot: 0, carry: 1500, losses: 3, color: "red" }
    ],

    // Aggregated stats
    totalRaids: 20,
    totalLoot: 15000,
    avgLootPerRaid: 750,
    totalLosses: 3,
    consecutiveLosses: 1,     // reset to 0 when a green raid happens
    lastRaidTime: 1740000000,
    lastLootAmount: 800,

    // Status
    status: "active",         // 'active' | 'paused' | 'blacklisted'
    pauseReason: null,        // 'losses' | 'empty' | 'manual'
    pauseUntil: null,         // resume timestamp

    // Scoring (updated each cycle)
    score: 85,
    recommendation: "SAFE"
  }
}
```

**Auto-management rules:**
| Condition | Action |
|---|---|
| `consecutiveLosses >= maxLossesBeforeSkip` | `status = 'blacklisted'` |
| `avgLootPerRaid < minProfitRatio * carryCapacity` | `status = 'paused'`, try again after 2 hours |
| Bounty always full (carry < loot available) | Flag "send more troops" |
| Bounty always empty (< 10% carry used) | `status = 'paused'` (empty target) |
| Green raid after being paused | `status = 'active'` |

### 4.3 WaveScheduler

**Problem:** ถ้าส่งทุกเป้าพร้อมกัน → ทหารกลับพร้อมกัน → ต้องรอ cooldown ก่อนส่งรอบถัดไป

**Solution:** Stagger waves ตาม travel time

```
Wave 1 (T=0):     ส่งไปเป้า A (travel 20min) + เป้า B (travel 45min)
Wave 2 (T=40min):  ทหารกลับจาก A → ส่งไปเป้า C (travel 30min)
Wave 3 (T=90min):  ทหารกลับจาก B → ส่งไปเป้า A อีกครั้ง
```

**Algorithm:**
```
1. Sort targets by score (descending)
2. For each target:
   a. Calculate travel time (roundTrip = distance / speed * 2)
   b. Calculate optimal re-raid interval:
      reRaidInterval = max(roundTrip, targetRegenTime)
      targetRegenTime = estimatedProduction * hoursToFillCarry
   c. Schedule: sendAt = lastRaidTime + reRaidInterval
3. Return sorted by sendAt (earliest first)
4. Limit to maxConcurrentRaids (don't send all troops at once)
```

**Config:**
```javascript
{
  maxConcurrentRaids: 5,       // max targets raided simultaneously
  minTroopsReserve: 20,        // keep 20 troops at home for defense
  reRaidBufferMinutes: 5,      // add 5 min buffer to avoid "empty raid" timing
}
```

### 4.4 TroopRouter

**เลือกทหารตามเป้า:**

| เป้า | ทหาร | เหตุผล |
|---|---|---|
| ใกล้ (< 5 tiles) | Cavalry (fastest) | เร็วที่สุด กลับมาส่งรอบถัดไปได้เร็ว |
| ไกล (5-15 tiles) | Infantry + mixed | ถูกกว่า carry ได้มาก |
| ไกลมาก (> 15 tiles) | ไม่ส่ง | ไม่คุ้ม travel time |
| เสี่ยง (yellow report) | ส่งน้อยลง + เร็ว | ลด damage ถ้าโดนป้องกัน |
| ใหม่ (ไม่เคยส่ง) | Scout ก่อน | ถ้ามี scouts |

**Algorithm:**
```javascript
function assignTroops(target, availableTroops, config, tribe) {
  const ranked = militaryPlanner.rankTroops(tribe, 'raiding');
  // ranked = sorted by raidScore (carry * speed / cost)

  if (target.distance < 5) {
    // Use fastest troops (cavalry)
    return pickFromRanked(ranked, { preferFast: true, count: estimateNeeded(target) });
  }
  if (target.risk > 0.3) {
    // Risky target — send fewer, expendable troops
    return pickFromRanked(ranked, { preferCheap: true, count: Math.min(10, available) });
  }
  // Normal — use best raid score
  return pickFromRanked(ranked, { count: estimateNeeded(target) });
}

function estimateNeeded(target) {
  // Estimate how many troops to send based on expected loot
  const expectedLoot = target.avgLootPerRaid || target.estimatedLoot;
  const carryPerTroop = 50; // varies by troop type
  return Math.ceil(expectedLoot / carryPerTroop);
}
```

---

## 5. New DOM Scanner Methods

### `scanRaidReports(maxReports = 10)`

**Where to scan:** Reports page → filter for raid/attack type

**Execution flow (from BotEngine):**
```
1. navigate to 'reports' page (berichte.php)
2. filter for raid reports (click tab/filter if available)
3. page.evaluate(() => TravianScanner.scanRaidReports(10))
4. return array of parsed reports
```

**Important:** This is a READ-ONLY scan. Don't click into individual reports (causes page navigation). Parse from the report list view where loot amounts are shown in the preview row.

### `scanNeighborhood(radius = 10)` (future / optional)

**For target discovery:**
- Open map view centered on village
- Scan for gray/inactive players within radius
- Return potential new farm targets

---

## 6. FarmManager Integration

### New file: `sidecar/strategy/farm-manager.js`

```javascript
class FarmManager {
  constructor(storage, militaryPlanner) {
    this.storage = storage;       // for persisting target data
    this.planner = militaryPlanner;
    this.targets = new Map();     // coordKey -> targetData
    this.lastReportScan = 0;
  }

  // --- Core API ---

  async planNextWave(gameState, config) {
    // 1. Check if we should scan reports (every 10 minutes)
    const shouldScanReports = Date.now() - this.lastReportScan > 600000;

    // 2. Get active targets
    const activeTargets = this.getActiveTargets();

    // 3. Score targets using existing MilitaryPlanner
    const origin = config.origin || this._extractOrigin(gameState);
    const troops = this._getAvailableTroops(gameState, config);
    const scored = this.planner.planRaids(activeTargets, origin, troops, config.farmConfig.maxConcurrentRaids || 5);

    // 4. Schedule waves
    const waves = this.scheduleWaves(scored, troops, config);

    // 5. Assign troops per target
    for (const wave of waves) {
      wave.troopAssignment = this.assignTroops(wave.target, troops, config);
    }

    return {
      shouldScanReports,
      waves,
      nextWaveAt: waves.length > 0 ? waves[0].sendAt : null,
      stats: this.getStats()
    };
  }

  // --- Report Processing ---

  processReports(reports) {
    for (const report of reports) {
      const key = report.targetCoords.x + '|' + report.targetCoords.y;

      if (!this.targets.has(key)) {
        this.targets.set(key, this._createTarget(report));
      }

      const target = this.targets.get(key);
      this._updateTarget(target, report);
      this._evaluateTargetStatus(target);
    }

    this.lastReportScan = Date.now();
    this._persist();
  }

  // --- Target Management ---

  getActiveTargets() {
    return [...this.targets.values()]
      .filter(t => t.status === 'active')
      .map(t => ({
        x: t.coords.x,
        y: t.coords.y,
        population: t.estimatedPopulation || 10,
        lastLoot: t.lastLootAmount,
        lastRaidTime: t.lastRaidTime,
        wallLevel: t.estimatedWallLevel || 0,
        losses: t.totalLosses
      }));
  }

  // --- Stats for Dashboard ---

  getStats() {
    const all = [...this.targets.values()];
    return {
      totalTargets: all.length,
      activeTargets: all.filter(t => t.status === 'active').length,
      blacklisted: all.filter(t => t.status === 'blacklisted').length,
      paused: all.filter(t => t.status === 'paused').length,
      totalLoot: all.reduce((sum, t) => sum + t.totalLoot, 0),
      totalLosses: all.reduce((sum, t) => sum + t.totalLosses, 0),
      avgLootPerRaid: all.reduce((sum, t) => sum + t.avgLootPerRaid, 0) / Math.max(all.length, 1),
    };
  }
}
```

---

## 7. Decision Engine Changes

### Modified `evaluateFarming()` in decision-engine.js

```javascript
evaluateFarming(state, config) {
  if (!config.farmConfig) return null;
  const mode = config.farmConfig.mode || 'farmList';

  // --- Mode: farmList (existing, unchanged) ---
  if (mode === 'farmList') {
    return this._farmListMode(state, config);
  }

  // --- Mode: smart (NEW) ---
  if (mode === 'smart') {
    return this._smartFarmMode(state, config);
  }

  // --- Mode: manual (existing, unchanged) ---
  if (mode === 'manual') {
    return this._manualFarmMode(state, config);
  }
}

_smartFarmMode(state, config) {
  if (!this.farmManager) {
    this.farmManager = new FarmManager(/* storage, planner */);
  }

  const plan = this.farmManager.planNextWave(state, config);
  const tasks = [];

  // Task 1: Scan reports if needed
  if (plan.shouldScanReports) {
    tasks.push({
      type: 'scan_raid_reports',
      params: { maxReports: 10 },
      priority: 8, // low priority, informational
      villageId: state.currentVillageId
    });
  }

  // Task 2: Send raids for due waves
  for (const wave of plan.waves) {
    if (wave.sendAt <= Date.now()) {
      if (wave.useFarmList) {
        // Use existing farm list mechanism
        tasks.push({
          type: 'send_farm',
          params: { farmListId: wave.farmListId },
          priority: 7,
          villageId: state.currentVillageId
        });
      } else {
        // Send individual attack with specific troops
        tasks.push({
          type: 'send_attack',
          params: {
            target: wave.target,
            troops: wave.troopAssignment
          },
          priority: 7,
          villageId: state.currentVillageId
        });
      }
    }
  }

  return tasks.length > 0 ? tasks : null;
}
```

---

## 8. New Task Types

| Task Type | Action | Notes |
|---|---|---|
| `scan_raid_reports` | Navigate to reports → scan | Returns reports to FarmManager |
| `scout_target` | Send scouts to coords | Optional, for unknown targets |
| `send_farm` (existing) | Click farm list start button | Unchanged |
| `send_attack` (existing) | Fill rally point form + send | Now with smart troop selection |

### BotEngine additions for `scan_raid_reports`:

```javascript
case 'scan_raid_reports':
  // Navigate to reports page
  await this.sendToContentScript({
    type: 'EXECUTE', action: 'navigateTo', params: { page: 'reports' }
  });
  await this._randomDelay();
  // Scan reports
  response = await this.sendToContentScript({
    type: 'EXECUTE', action: 'scanRaidReports',
    params: { maxReports: task.params.maxReports || 10 }
  });
  // Feed reports to farm manager
  if (response && response.success && response.data) {
    this.decisionEngine.farmManager.processReports(response.data.reports);
  }
  break;
```

---

## 9. Config Options

```javascript
farmConfig: {
  // Mode selection
  mode: 'farmList' | 'manual' | 'smart',

  // Farm list mode (existing)
  intervalMs: 300000,          // 5 min between farm list sends
  useRallyPointFarmList: true,

  // Smart mode (NEW)
  maxConcurrentRaids: 5,       // max simultaneous raids
  minTroopsReserve: 20,        // keep N troops at home
  maxLossesBeforeSkip: 2,      // blacklist after N consecutive losses
  minProfitRatio: 0.3,         // skip if avg loot < 30% of carry capacity
  maxRaidDistance: 15,          // don't raid beyond 15 tiles
  preferFastTroops: true,      // use cavalry for close targets
  reportScanInterval: 600000,  // scan reports every 10 min
  reRaidBufferMinutes: 5,      // add buffer before re-raiding
  autoBlacklistOnLoss: true,   // auto-skip targets with losses

  // Manual mode (existing)
  targets: [],                 // coordinate targets
  defaultTroops: null
}
```

---

## 10. Dashboard Farm Tab

```
┌─────────────────────────────────────────────────────────┐
│  FARM MODE: [Farm List ▾] [Smart ▾] [Manual ▾]          │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📊 FARM STATS                                          │
│  ┌──────────┬──────────┬──────────┬──────────┐          │
│  │ Active   │ Paused   │ Blocked  │ Total    │          │
│  │   12     │    3     │    2     │   17     │          │
│  └──────────┴──────────┴──────────┴──────────┘          │
│  Total Loot: 158,420 res  |  Losses: 3 troops           │
│  Avg Loot/Raid: 720 res   |  Efficiency: A              │
│                                                         │
│  📋 TARGETS                   Score  Last Raid  Status   │
│  ├ Natars (42|-15)    dist:5   95    2 min ago  ● Active │
│  ├ EmptyVille (10|3)  dist:8   82    15 min ago ● Active │
│  ├ BigFarm (-5|20)    dist:12  71    8 min ago  ● Active │
│  ├ Risky (30|-30)     dist:20  --    1 hr ago   ○ Paused │
│  └ DefKing (50|10)    dist:35  --    2 hrs ago  ✕ Blocked│
│                                                         │
│  🕐 NEXT WAVE                                           │
│  Wave 1 (in 3 min):  Natars → 15 Imperatoris            │
│  Wave 2 (in 12 min): EmptyVille → 30 Legionnaires       │
│  Wave 3 (in 25 min): BigFarm → 20 Equites Imperatoris   │
│                                                         │
│  ⚙ SETTINGS                                             │
│  Max concurrent raids: [5]                               │
│  Min troops at home: [20]                                │
│  Max losses before skip: [2]                             │
│  Max raid distance: [15] tiles                           │
│  [✓] Auto-blacklist on loss                             │
│  [✓] Prefer fast troops for close targets               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 11. Implementation Priority

| Order | Component | Effort | Impact |
|---|---|---|---|
| 1 | `scanRaidReports()` in dom-scanner | Medium | High — foundation for everything |
| 2 | FarmManager (target tracker + report processing) | Medium | High — target intelligence |
| 3 | Connect `MilitaryPlanner.planRaids()` to decision engine | Small | High — already exists, just wire it |
| 4 | WaveScheduler | Medium | Medium — timing optimization |
| 5 | TroopRouter | Medium | Medium — troop selection |
| 6 | Farm tab UI | Medium | High — user visibility |
| 7 | Scout integration | Small | Low — nice to have |
