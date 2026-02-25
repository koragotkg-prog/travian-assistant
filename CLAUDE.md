# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Travian Bot Chrome Extension (Manifest V3) located in `travian-bot/`. No build system, no npm dependencies — plain JavaScript loaded directly by Chrome. Supports **multiple Travian servers simultaneously** (e.g., S4 and S5 running in separate Chrome tabs).

## Development

**Loading the extension:** Go to `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select the `travian-bot/` directory.

**Reloading after changes:**
- Service worker / core / utils changes: Click the reload button on `chrome://extensions`
- Content script changes: Reload the extension AND refresh the Travian tab
- Popup changes: Close and reopen the popup

There are no build steps, linters, or test suites configured.

## Architecture

### Execution Contexts (critical to understand)

The extension runs across three isolated contexts that **cannot share variables directly**:

1. **Service Worker** (`background/service-worker.js`) — No DOM, no `window`. Uses `self` as global. Orchestrates bot instances via `importScripts()`.
2. **Content Scripts** (`content/domScanner.js`, `content/actionExecutor.js`) — Run in an isolated world on Travian pages. Have DOM access via `document` but `window.X` is NOT visible to page scripts. **Destroyed and re-injected on every page navigation.**
3. **Popup** (`popup/popup.js`, `popup/index.html`, `popup/styles.css`) — Gaming Dashboard UI with tab navigation. Communicates with service worker via `chrome.runtime.sendMessage()`.

### Module System

**No ES modules.** The service worker uses `importScripts()` — the manifest must NOT have `"type": "module"`.

- **Utils** (`utils/`): IIFE pattern, attach to `typeof window !== 'undefined' ? window : self` for dual-context compatibility.
- **Core modules** (`core/`): Classes exported via `self.ClassName` (e.g., `self.TravianBotEngine`).
- **Content scripts** (`content/`): Expose APIs via `window.` globals.

### Multi-Server Architecture

The bot uses **per-server isolation** so multiple Travian servers can run simultaneously:

- **Server key** = full hostname (e.g., `ts5.x1.asia.travian.com`) extracted via `TravianStorage.extractServerKey(url)`
- **InstanceManager** (`core/instanceManager.js`) holds `Map<serverKey, {engine, tabId}>` — one BotEngine per server
- **Config namespaced per server**: `bot_config__ts5.x1.asia.travian.com` in chrome.storage
- **State namespaced per server**: `bot_state__<serverKey>` in chrome.storage
- **Server registry**: `bot_config_registry` tracks all known servers with labels and `lastUsed` timestamps
- **Per-server alarms**: `botHeartbeat__<serverKey>` for independent heartbeats
- **Message routing**: Content script messages routed by `sender.tab.id` → `manager.getByTabId()`. Popup messages routed by `message.serverKey` → `manager.get()`.

### Communication Flow

```
Service Worker  ←→  Content Script    (chrome.tabs.sendMessage / chrome.runtime.sendMessage)
Service Worker  ←→  Popup             (chrome.runtime.sendMessage, polled every 2s)
```

Message types from service worker to content script: `{type: 'SCAN'}` and `{type: 'EXECUTE', action, params}`.

Popup → Service Worker message types: `START_BOT`, `STOP_BOT`, `PAUSE_BOT`, `EMERGENCY_STOP`, `GET_STATUS`, `GET_LOGS`, `GET_QUEUE`, `GET_STRATEGY`, `SAVE_CONFIG`, `CLEAR_QUEUE`, `SWITCH_VILLAGE`, `REQUEST_SCAN`, `GET_SERVERS`.

All popup messages include `serverKey` for multi-server routing.

### Main Loop

```
Chrome alarm heartbeat (1 min) → BotEngine cycle (configurable interval)
  → Rate limit check → SCAN content script → DecisionEngine → TaskQueue → EXECUTE content script
```

### Core Modules

| Module | Export | Role |
|--------|--------|------|
| `core/botEngine.js` | `self.TravianBotEngine` | Main orchestrator: start/stop/pause, rate limiting, content script communication, hero resource claiming |
| `core/decisionEngine.js` | `self.TravianDecisionEngine` | Rule-based decisions from game state (safety → build → troops → farm) |
| `core/taskQueue.js` | `self.TravianTaskQueue` | Priority queue with retry logic; task types: `upgrade_resource`, `upgrade_building`, `train_troops`, `send_farm`, `build_new`, etc. |
| `core/scheduler.js` | `self.TravianScheduler` | Timing with jitter for human-like behavior |
| `core/instanceManager.js` | `self.TravianInstanceManager` | Multi-server: `Map<serverKey, {engine, tabId}>`, routes by tabId or serverKey |

### Utilities

| Module | Global | Notes |
|--------|--------|-------|
| `utils/logger.js` | `TravianLogger` | `log(level, message, data)` — first arg MUST be a level string: DEBUG/INFO/WARN/ERROR |
| `utils/storage.js` | `TravianStorage` | Per-server config via `getServerConfig(key)` / `saveServerConfig(key, cfg)`. Legacy key `bot_config` for backward compat. |
| `utils/delay.js` | `TravianDelay` | `humanDelay(min, max)`, `waitForElement(selector, timeout)`, `jitter(base, variance)` |

## Key Conventions

- **Config field aliases**: DecisionEngine accepts dual names for backward compat (e.g., `autoResourceUpgrade` OR `autoUpgradeResources`). Maintain both when modifying config logic.
- **Defensive DOM queries**: All DOM accessors in `domScanner.js` return `null`/`[]` on failure, never throw. Wrap new selectors in try/catch.
- **Human-like behavior**: Action execution uses random delays and simulated mouse events (`mousedown` → delay → `mouseup` → `click`). Preserve this pattern.
- **Service worker mortality**: Chrome can kill the service worker at any time. State recovery is handled via `bot_state__<serverKey>` in chrome.storage. Any persistent data must go through `TravianStorage`, not in-memory variables.
- **Content script lifecycle**: Content scripts are destroyed on page navigation. Any multi-step action involving `<a>` link clicks that cause navigation MUST be split into separate EXECUTE commands from the service worker. Never do multiple awaits after a navigation click in a content script.
- **Structured error responses**: `actionExecutor.js` returns `{success: false, reason: 'code', message: '...'}` with reason codes: `no_adventure`, `hero_unavailable`, `insufficient_resources`, `queue_full`, `button_not_found`, `building_not_available`, `no_items`, `no_amount`.

## Data Shape Gotchas

These inconsistencies between modules have caused bugs — be aware of them:

- **Task params lack `gid`**: DecisionEngine creates `upgrade_resource` tasks with `{fieldId}` and `upgrade_building` with `{slot}` — neither includes `gid`. To look up building cost, you must resolve gid from `gameState.resourceFields` or `gameState.buildings`.
- **`domScanner.getResourceFields()`** returns `{id, type, level, upgrading, position}` — NO `gid` field. The `type` is a string: `"wood"`, `"clay"`, `"iron"`, `"crop"`. Map to gid: wood=1, clay=2, iron=3, crop=4.
- **`domScanner.getBuildings()`** returns `{id, slot, name, level, upgrading}` where `id` IS the building type GID (not a unique slot ID). Match buildings by `slot`, read type from `id`.
- **Hero resource items** are resource POOLS, not individual crates. `item.count` = total resource amount stored (e.g., 21909 wood). The dialog input asks for resource amount to transfer. Default fills warehouse to capacity — dangerous if not overridden.

## Verified DOM Selectors (Travian Legends, Feb 2025)

- Resources: `#l1`–`#l4`; Capacity: `.warehouse .capacity .value`, `.granary .capacity .value`
- Production: `#production .num` (4 elements)
- Resource fields (dorf1): `.resourceField[data-aid][data-gid]`
- Buildings (dorf2): `#villageContent .buildingSlot[data-aid]`, level in `.labelLayer`
- Empty slots (dorf2): `.buildingSlot[data-aid] a.emptyBuildingSlot`
- Troops: `#troops tbody tr` with `.un`/`.num` (`#troops` IS the table element)
- Build queue: `.buildDuration > .timer`, parent is `<li>` not `<tr>`
- Upgrade button: `.textButtonV1.green` in `.upgradeButtonsContainer .section1`
- Insufficient resources indicator: `.upgradeBlocked` (contains gold exchange button)
- Queue full indicator: gold builder button in `.section1` WITHOUT `.upgradeBlocked` present
- Village sidebar: `#sidebarBoxVillageList`
- Hero inventory items: `.heroItems .heroItem[data-tier="consumable"]` with child `.item.item{ID}` and `.count`
- Hero item dialog: `.heroConsumablesPopup` with input for transfer amount, confirm `.button.green`, cancel `.button.grey`
- Build new page: buildings by `#contract_building{GID}` wrapper (NO `a[href*="gid="]` links)
- Build new tabs: `.contentNavi a.tabItem`
- Farm list tab: `build.php?id=39&tt=99`

### Strategy Engine (`strategy/`)

AI-powered strategic decision-support system. Standalone modules with no Chrome dependencies — can run in service worker, browser, or Node.js.

| Module | Export | Role |
|--------|--------|------|
| `strategy/gameData.js` | `TravianGameData` | All Travian constants: production tables, building costs, troop stats, wall bonuses, formulas |
| `strategy/buildOptimizer.js` | `TravianBuildOptimizer` | Build order ROI calculator, overflow detection, bottleneck analysis |
| `strategy/militaryPlanner.js` | `TravianMilitaryPlanner` | Troop efficiency ranking, farm target scoring, defense assessment, risk analysis |
| `strategy/strategyEngine.js` | `TravianStrategyEngine` | Main orchestrator: phase detection, comprehensive analysis, forward simulation, build order comparison |

**Usage:** `new TravianStrategyEngine().analyze(input)` → returns ranked recommendations, build order, troop strategy, risk assessment, expansion timing, resource optimization.

**Dependency resolution:** Modules check `self` → `window` → `global` → `require()` for dependencies. In service worker, load via `importScripts()` in order: gameData → buildOptimizer → militaryPlanner → strategyEngine.

### Popup UI Architecture

The popup uses a **tab-based layout** (Gaming Dashboard v2) with 4 tabs:

- **Dashboard** (`panelDash`): Stats cards (2x2 grid), current task with progress bar, feature toggle pills, task queue
- **Config** (`panelConfig`): Upgrade targets, troop training, farming, timing/safety, hero adventure, save button
- **AI Strategy** (`panelAI`): Phase detection, metrics (bottleneck/risk/expand), AI recommendations
- **Logs** (`panelLogs`): Filterable log viewer (All/Info/Warn/Error)

Layout structure: fixed header (with server selector) → fixed tab bar → scrollable tab content → fixed control bar (Start/Pause/Stop/Emergency).

**Critical**: All popup element IDs are referenced by `popup.js` via the `dom` object (~44 refs). When modifying HTML, preserve all `id=""` attributes or update the `dom` object to match.

Tab switching uses `data-tab` attribute on buttons mapped to panel IDs via `TAB_PANEL_MAP`.

## Pitfalls

- `window.postMessage` works for page ↔ content script testing bridge; `CustomEvent.detail` does NOT cross the isolation boundary.
- When insufficient resources: `.upgradeBlocked` appears. When queue full: gold builder button in `.section1` but NO `.upgradeBlocked`. Check `.upgradeBlocked` BEFORE gold buttons to distinguish these states.
- `.notEnough` class does NOT exist on build-new or upgrade pages in current Travian version — use `.upgradeBlocked` instead.
- The popup is a fixed 420×580px panel; keep UI additions within this constraint.
- Popup body uses `display: flex; flex-direction: column; overflow: hidden` — only `.tab-content` scrolls, not the body itself.
- Build new page has NO `a[href*="gid="]` links — find buildings by `#contract_building{GID}` wrapper ID.
- Build page tab clicks cause FULL PAGE RELOAD — tab switching must be orchestrated from the service worker (BotEngine), not within content scripts.
- `_tryClaimHeroResources` in BotEngine MUST be awaited — fire-and-forget causes race conditions and task loss.
- Hero resource dialog default transfers enough to fill warehouse to max capacity. Always set a specific amount, or cancel the dialog if amount is unknown.
- `navigateTo('hero')` must use specific selectors (`#heroImageButton`, `a[href="/hero"]`) not `a[href*="/hero"]` which matches all hero sub-pages.
- Farm list tab click causes page reload — must be a separate execution step with delay before scanning farm lists.
