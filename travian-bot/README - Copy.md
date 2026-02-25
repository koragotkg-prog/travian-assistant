# Travian Bot - Chrome Extension

Private Travian Legends gameplay automation assistant. Chrome Extension (Manifest V3) with AI-powered strategy analysis.

## Features

- **Auto Resource Upgrade** - Automatically upgrades resource fields (wood, clay, iron, crop)
- **Auto Building Upgrade** - Upgrades buildings based on configurable target levels
- **Auto Troop Training** - Queues troops at barracks/stable/workshop
- **Auto Farming** - Sends farm lists from rally point, or legacy coordinate-based raids
- **Auto Hero Adventure** - Sends hero on adventures when available
- **Hero Inventory Fallback** - Claims resource items from hero inventory when resources are insufficient
- **AI Strategy Engine** - Analyzes game state and recommends optimal build orders, troop compositions, and expansion timing
- **Multi-Server Support** - Independent config and bot instances per server (e.g. run S4 and S5 simultaneously)
- **Smart Error Handling** - Structured error codes with appropriate cooldowns (queue full, insufficient resources, etc.)
- **Human-like Behavior** - Random delays, simulated mouse events, rate limiting

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer Mode** (toggle in top-right)
4. Click **Load unpacked** and select the `travian-bot/` folder
5. Open any Travian Legends page - the extension icon appears in the toolbar

No build steps. No npm. No dependencies. Plain JavaScript.

## Usage

1. Open a Travian Legends page in Chrome
2. Click the extension icon to open the dashboard
3. The **Server** dropdown auto-detects which server you're on
4. Go to **Config** tab to set up features:
   - Toggle features on/off (resource upgrade, building upgrade, etc.)
   - Click **Scan** to load your current buildings and set upgrade targets
   - Configure farm lists, troop training, delays
5. Go back to **Dash** tab and click **Start**
6. Monitor progress via dashboard (resources, build queue, troops, task queue)
7. Check **AI** tab for strategic recommendations
8. Check **Logs** tab for detailed activity history

## Multi-Server

Each Travian server gets its own independent configuration and bot instance:

- Open `ts5.x1.asia.travian.com` in one tab, configure and start the bot
- Open `ts20.x1.europe.travian.com` in another tab - it has separate settings
- Both bots run simultaneously without interfering with each other
- The popup auto-detects which server's tab you're on and shows that server's config

Config is stored per server under `bot_config__<hostname>` in Chrome storage.

## Architecture

```
travian-bot/
  background/
    service-worker.js     # Orchestrates bot instances, message routing, alarms
  content/
    domScanner.js         # Reads game state from Travian DOM
    actionExecutor.js     # Executes actions (click upgrade, train troops, etc.)
  core/
    botEngine.js          # Main bot loop: scan -> decide -> execute
    decisionEngine.js     # Rule-based decision making (what to do next)
    taskQueue.js          # Priority queue with retry logic
    scheduler.js          # Timing with jitter for human-like behavior
    instanceManager.js    # Manages multiple BotEngine instances (one per server)
  strategy/
    gameData.js           # Travian constants, formulas, production tables
    buildOptimizer.js     # Build order ROI calculator
    militaryPlanner.js    # Troop efficiency, farm scoring, defense assessment
    strategyEngine.js     # AI orchestrator: phase detection, recommendations
  utils/
    delay.js              # Random delays, element waiting
    logger.js             # Logging with levels (DEBUG/INFO/WARN/ERROR)
    storage.js            # Chrome storage wrapper, per-server config, migration
  popup/
    index.html            # Dashboard UI
    popup.js              # Dashboard controller
    styles.css            # Gaming dashboard dark theme
```

### Execution Contexts

The extension runs across three isolated contexts:

| Context | Global | DOM? | Files |
|---------|--------|------|-------|
| **Service Worker** | `self` | No | `background/`, `core/`, `strategy/`, `utils/` |
| **Content Script** | `window` | Yes (Travian page) | `content/`, `utils/` |
| **Popup** | `window` | Yes (popup panel) | `popup/` |

Communication: Service Worker <-> Content Script via `chrome.tabs.sendMessage`. Popup <-> Service Worker via `chrome.runtime.sendMessage`.

### Bot Loop

```
Chrome alarm (1 min heartbeat)
  -> BotEngine.mainLoop()
    -> Rate limit check
    -> SCAN (content script reads DOM)
    -> DecisionEngine (analyze game state, pick action)
    -> TaskQueue (prioritize, check retries)
    -> EXECUTE (content script clicks buttons)
    -> Save state
```

## Reloading After Changes

| What changed | How to reload |
|-------------|---------------|
| Service worker / core / utils | Click reload on `chrome://extensions` |
| Content scripts | Reload extension AND refresh the Travian tab |
| Popup UI | Close and reopen the popup |

## Supported Browsers

Any Chromium-based browser: Chrome, Edge, Brave, Opera, Arc.

## Disclaimer

This is a private automation tool for personal use. Use at your own risk. Automating gameplay may violate Travian's Terms of Service.
