# Travian Bot — Mac Standalone App Design

**Date:** 2026-02-25
**Status:** Draft
**Approach:** Tauri + Puppeteer Sidecar (Approach A)

---

## 1. Overview

Convert the Chrome Extension into a standalone macOS app (.dmg) using Tauri.
Bot runs without Chrome — uses a bundled Chromium via Puppeteer.
Includes all existing features + 5 new game-play improvements.

---

## 2. Architecture

```
Tauri Mac App (.dmg)
├── Frontend (WebView) ── Full-size Gaming Dashboard (HTML/CSS/JS)
│         │
│         │ Tauri IPC (invoke / listen)
│         ▼
├── Rust Backend ── App lifecycle, tray, menus, cookie import, config I/O
│         │
│         │ stdin/stdout JSON-RPC
│         ▼
├── Node.js Sidecar ── Bot engine, strategy, Puppeteer control
│         │
│         │ Chrome DevTools Protocol
│         ▼
└── Chromium ── Loads Travian pages (headed or headless, toggleable)
```

### Chrome Extension → Mac App Mapping

| Chrome Extension | Mac App |
|---|---|
| `chrome.storage.local` | JSON files in `~/Library/Application Support/TravianBot/` |
| `chrome.tabs.sendMessage({type:'SCAN'})` | `page.evaluate(() => TravianScanner.fullScan())` |
| `chrome.tabs.sendMessage({type:'EXECUTE'})` | `page.evaluate((action) => TravianExecutor.execute(action))` |
| Content script auto-injection | `page.addScriptTag({path: 'domScanner.js'})` on every navigation |
| `chrome.alarms` (1 min heartbeat) | `setInterval` in Node.js (persistent, never dies) |
| Service worker (can die anytime) | Node.js sidecar (persistent process, no state loss) |
| Popup window (420×580 fixed) | Full Tauri window (resizable, min 800×600) |
| `chrome.cookies` | Read Chrome's `Cookies` SQLite DB directly |
| `chrome.notifications` | macOS native notifications via Tauri |

---

## 3. Project Structure

```
travian-bot-mac/
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Tauri app entry
│   │   ├── commands.rs            # IPC command handlers
│   │   ├── cookies.rs             # Chrome cookie import (SQLite)
│   │   ├── config.rs              # JSON config read/write
│   │   ├── tray.rs                # System tray + menu bar
│   │   └── sidecar.rs             # Spawn/manage Node.js process
│   ├── Cargo.toml
│   └── tauri.conf.json
│
├── src/                           # Frontend (Tauri WebView)
│   ├── index.html                 # Full dashboard (adapted from popup)
│   ├── styles.css                 # Gaming theme (adapted, full-size)
│   └── app.js                     # Dashboard controller (adapted from popup.js)
│
├── sidecar/                       # Node.js bot engine
│   ├── package.json               # puppeteer dependency
│   ├── index.js                   # Sidecar entry — JSON-RPC over stdin/stdout
│   ├── browser-manager.js         # Puppeteer launch/close, headed/headless toggle
│   ├── page-controller.js         # Navigate, inject scripts, evaluate
│   │
│   ├── core/                      # Reused from extension (adapted)
│   │   ├── bot-engine.js          # Main orchestrator (no chrome.* APIs)
│   │   ├── decision-engine.js     # Rule-based decisions (reuse as-is)
│   │   ├── task-queue.js          # Priority queue (reuse as-is)
│   │   ├── scheduler.js           # Timing with jitter (reuse as-is)
│   │   └── instance-manager.js    # Multi-server instances (adapted)
│   │
│   ├── content/                   # Injected into Chromium pages
│   │   ├── dom-scanner.js         # DOM scanner (reuse as-is)
│   │   └── action-executor.js     # Action executor (reuse as-is)
│   │
│   ├── strategy/                  # AI strategy (reuse as-is)
│   │   ├── game-data.js
│   │   ├── build-optimizer.js
│   │   ├── military-planner.js
│   │   └── strategy-engine.js
│   │
│   └── utils/
│       ├── delay.js               # Reuse as-is
│       ├── logger.js              # Adapted: no chrome.storage, write to file
│       └── storage.js             # Adapted: JSON file I/O instead of chrome.storage
│
└── README.md
```

---

## 4. Communication Flow

```
Frontend (WebView)
    │
    │  tauri.invoke('start_bot', {serverKey})
    ▼
Rust Backend
    │
    │  sidecar.send({"method": "startBot", "params": {serverKey}})
    ▼
Node.js Sidecar
    │
    │  puppeteer: page.goto(travianUrl)
    │  puppeteer: page.addScriptTag('dom-scanner.js')
    │  puppeteer: page.evaluate(() => TravianScanner.fullScan())
    ▼
Chromium (Travian page)
    │
    │  returns gameState JSON
    ▼
Node.js Sidecar
    │
    │  stdout: {"event": "statusUpdate", "data": {...}}
    ▼
Rust Backend
    │
    │  tauri::emit("bot-status", data)
    ▼
Frontend (WebView)
    │
    │  listen('bot-status', (event) => updateDashboard(event.payload))
```

### JSON-RPC Protocol (Rust ↔ Node.js)

**Rust → Sidecar (requests):**
```json
{"id": 1, "method": "startBot", "params": {"serverKey": "ts5.x1.asia.travian.com", "cookies": [...]}}
{"id": 2, "method": "stopBot", "params": {"serverKey": "..."}}
{"id": 3, "method": "getStatus", "params": {"serverKey": "..."}}
{"id": 4, "method": "saveConfig", "params": {"serverKey": "...", "config": {...}}}
{"id": 5, "method": "toggleBrowser", "params": {"headless": true}}
```

**Sidecar → Rust (responses + events):**
```json
{"id": 1, "result": {"success": true}}
{"event": "statusUpdate", "data": {"serverKey": "...", "state": "running", "stats": {...}}}
{"event": "log", "data": {"level": "INFO", "message": "...", "timestamp": "..."}}
{"event": "gameState", "data": {"resources": {...}, "buildings": [...]}}
```

---

## 5. New Game Features

### 5.1 Crop-Aware Troop Training

**Problem:** Bot trains troops without checking if the village can sustain them. Crop goes negative → troops starve.

**Solution:** Before training, calculate crop balance:

```
cropBalance = currentCropProduction - currentCropConsumption - (newTroops × cropPerTroop)
```

**Rules:**
- If `cropBalance` would drop below configurable threshold (default: -5/hr), **skip training**
- If crop fields are low level, **prioritize upgrading crop fields first**
- Show crop balance indicator in dashboard UI (green/yellow/red)
- Config option: `cropSafetyMargin` (default: 50 crop/hr buffer)

**Changes:**
- `decision-engine.js`: Add crop check before `train_troops` decision
- `game-data.js`: Add troop crop consumption table (already partially there)
- Dashboard UI: Add crop balance metric

### 5.2 Trapper Support (Gaul Tribe)

**Problem:** Gaul tribe has Trapper (GID 36) for passive defense but bot ignores it.

**Solution:**
- Detect player tribe from game page (Gaul/Roman/Teuton)
- Add Trapper to buildable buildings list
- Decision engine rule: if tribe is Gaul AND incoming raids detected → prioritize trapper upgrade
- Config: `autoTrapper: true/false`, `trapperTargetLevel: 20`

**Changes:**
- `dom-scanner.js`: Add tribe detection (scan hero page or profile)
- `decision-engine.js`: Add trapper priority rule
- `game-data.js`: Add trapper capacity per level (10, 22, 36, 52, 70, 90, 112, 136, 162, 190...)
- Config UI: Add trapper toggle (show only for Gaul)

### 5.3 Smart Farming System

**Problem:** Current farming is basic — sends troops to coordinates or clicks farm lists. No intelligence.

**Solution — Multi-layer farming:**

**Layer 1: Farm List Integration (existing, improved)**
- Navigate to Rally Point → Farm List tab
- Click "Start" on each list
- Track last send time per list
- Respect cooldown intervals

**Layer 2: Smart Target Management**
- Track raid reports: profit per target, losses
- Auto-remove targets that caused losses
- Score targets: `profit / distance / risk`
- Suggest new targets from neighborhood scan

**Layer 3: Troop Selection**
- Use fastest troops for close targets (cavalry)
- Use cheapest troops for risky targets
- Reserve minimum troops for defense (configurable)
- Don't send if troops below minimum threshold

**Config options:**
```
farmConfig: {
  mode: 'farmList' | 'manual' | 'smart',
  minTroopsHome: 20,        // keep 20 troops for defense
  maxLossesBeforeSkip: 2,   // skip target after 2 losses
  raidInterval: 300,         // seconds between waves
  preferFastTroops: true,
  minProfitRatio: 0.5        // skip if profit < 50% of capacity
}
```

**Changes:**
- `dom-scanner.js`: Add raid report scanning
- `decision-engine.js`: Smart farming priority with target scoring
- New: `farm-manager.js` module for target tracking and scoring
- Config UI: Farm mode selector, loss tolerance, min troops

### 5.4 Quest System

**Problem:** In-game quests give free resources, items, and progression bonuses. Bot ignores them.

**Solution:**
- Scan quest list (quest master NPC dialog)
- Detect completed-but-unclaimed quests
- Auto-claim completed quests for rewards
- Prioritize quests that align with current build strategy

**Quest types to handle:**
- Build/upgrade quests (already doing these naturally)
- Training quests (train X troops → claim reward)
- Adventure quests (send hero → claim reward)
- Resource collection quests (auto-claimed)

**Changes:**
- `dom-scanner.js`: Add quest scanner (quest dialog DOM selectors)
- `action-executor.js`: Add `claim_quest` action
- `decision-engine.js`: Add quest-check step after each cycle
- Task type: `claim_quest` with params `{questId}`

### 5.5 Better Build & Resource UX

**Problem:** Current build UI (scan → checklist with target levels) is confusing. Empty slots are hard to use.

**Solution — Full-Size Dashboard Redesign:**

**Resource Fields Panel:**
- Visual grid showing all 18 resource field positions
- Color-coded by type (wood=brown, clay=red, iron=gray, crop=green)
- Click to set target level
- Show production rate per field
- "Upgrade all crop to level X" quick button

**Buildings Panel:**
- Visual ring layout (like in-game village view) or sorted list
- Categories: Infrastructure, Military, Economy, Defense
- Empty slots highlighted with "Build here" dropdown
- Build cost preview before committing
- Build time estimate

**Build Queue Preview:**
- Show not just active queue but planned sequence
- Estimated completion time for full queue
- Resource requirement timeline (when can you afford next build?)

**Changes:**
- Dashboard HTML/CSS: New resource field grid, building categories
- `app.js`: New renderers for visual layouts
- Build optimizer integration: Show AI-recommended next builds

---

## 6. Cookie Import System

**How Chrome stores cookies on macOS:**
```
~/Library/Application Support/Google/Chrome/Default/Cookies
```
This is a SQLite database. Cookies are AES-encrypted with a key stored in macOS Keychain.

**Import flow:**
1. User clicks "Import from Chrome" in app settings
2. Rust backend reads Chrome's `Cookies` SQLite file
3. Decrypt using key from Keychain (`Chrome Safe Storage`)
4. Filter for `*.travian.com` domains
5. Pass to Node.js sidecar → set cookies in Puppeteer browser
6. Navigate to Travian → user is logged in

**Fallback:** If cookie import fails (Chrome locked, different profile), open headed browser and let user login manually.

---

## 7. Dashboard UI (Full-Size)

Adapted from Gaming Dashboard v2 popup, expanded to full window:

```
┌────────────────────────────────────────────────────────────┐
│  [icon] TRAVIAN BOT          Server: [ts5 ▾]    ● Running │
├────────────────────────────────────────────────────────────┤
│  [Dashboard] [Config] [Strategy] [Farm] [Logs] [Settings] │
├────────────┬───────────────────────────────────────────────┤
│            │                                               │
│  Resource  │  Main Content Area                            │
│  Sidebar   │                                               │
│            │  Dashboard: stats, queue, task, toggles       │
│  Wood ████ │  Config: builds, troops, timing               │
│  Clay ████ │  Strategy: AI recommendations                 │
│  Iron ████ │  Farm: targets, reports, settings              │
│  Crop ████ │  Logs: filterable log viewer                   │
│            │  Settings: cookies, browser mode, schedule     │
│  Troops    │                                               │
│  ──────    │                                               │
│  Legion 45 │                                               │
│  Imper  20 │                                               │
│            │                                               │
│  Crop Bal  │                                               │
│  +120/hr   │                                               │
│            │                                               │
├────────────┴───────────────────────────────────────────────┤
│  [▶ Start]  [⏸ Pause]  [⏹ Stop]  [⚠ Emergency]  [👁 Show] │
└────────────────────────────────────────────────────────────┘
```

**New tabs vs popup:**
- **Farm tab** (new): Farm targets, raid reports, loss tracker
- **Settings tab** (new): Cookie import, browser headed/headless toggle, schedule
- **Resource sidebar** (new): Always visible, shows resources + troops + crop balance
- All existing tabs expanded to use full width

---

## 8. System Tray

When app window is closed, bot continues running in system tray:

```
[Tray icon] → Show Dashboard
              ──────────
              ts5 (Asia) - Running
              ts3 (EU) - Paused
              ──────────
              Stop All
              Quit
```

---

## 9. Reuse Plan

**Reuse as-is (no changes):**
- `content/dom-scanner.js` — injected into Puppeteer pages
- `content/action-executor.js` — injected into Puppeteer pages
- `core/task-queue.js` — pure logic, no Chrome APIs
- `core/scheduler.js` — pure logic
- `core/decision-engine.js` — pure logic (add new rules)
- `strategy/*` — all 4 modules, no Chrome dependencies

**Adapt (minor changes):**
- `core/bot-engine.js` — replace `chrome.tabs.sendMessage` with Puppeteer calls
- `core/instance-manager.js` — remove chrome tab tracking
- `utils/logger.js` — write to file + emit to frontend
- `utils/storage.js` — JSON file I/O instead of chrome.storage
- `popup/*` → `src/*` — adapt for full-size window + Tauri IPC

**New code:**
- `src-tauri/` — entire Rust backend
- `sidecar/index.js` — JSON-RPC server
- `sidecar/browser-manager.js` — Puppeteer lifecycle
- `sidecar/page-controller.js` — script injection + evaluation
- `sidecar/farm-manager.js` — smart farming (new feature)
- Dashboard: farm tab, settings tab, resource sidebar

---

## 10. Key Technical Decisions

1. **Puppeteer over Playwright** — lighter, Chromium-only focus, well-documented
2. **JSON-RPC over stdin/stdout** — simple, no TCP port conflicts, Tauri sidecar standard
3. **JSON files for config** — simpler than SQLite, human-readable, easy debug
4. **Bundled Chromium** — Puppeteer downloads its own, ~170MB but guaranteed compatibility
5. **No ES modules in sidecar** — keep `require()` for max compat with existing IIFE code
6. **Content scripts injected per navigation** — Puppeteer `page.on('load')` handler
