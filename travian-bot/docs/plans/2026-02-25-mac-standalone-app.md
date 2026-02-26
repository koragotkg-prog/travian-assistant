# Travian Bot Mac Standalone App — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert the Chrome Extension into a standalone macOS app (.dmg) using Tauri + Puppeteer sidecar, with 5 new game features.

**Architecture:** Tauri (Rust backend + WebView frontend) communicates via JSON-RPC stdin/stdout with a Node.js sidecar that controls Puppeteer/Chromium. Existing bot logic (decision engine, task queue, scheduler, strategy, DOM scanner, action executor) is reused with minimal changes.

**Tech Stack:** Tauri 2.x, Rust, Node.js 20+, Puppeteer, HTML/CSS/JS (no framework)

**Design Doc:** `docs/plans/2026-02-25-mac-standalone-app-design.md`

---

## Phase 1: Foundation (Sidecar + Adapted Modules)

### Task 1: Create project scaffold

**Files:**
- Create: `travian-bot-mac/sidecar/package.json`
- Create: `travian-bot-mac/sidecar/index.js`
- Create: `travian-bot-mac/src-tauri/` (via `npm create tauri-app`)
- Create: `travian-bot-mac/src/index.html` (placeholder)

**Step 1: Initialize the sidecar Node.js project**

```bash
mkdir -p travian-bot-mac/sidecar
cd travian-bot-mac/sidecar
```

Create `package.json`:
```json
{
  "name": "travian-bot-sidecar",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "puppeteer": "^23.0.0"
  }
}
```

**Step 2: Install Puppeteer**

```bash
cd travian-bot-mac/sidecar && npm install
```
Expected: `node_modules/` created, `puppeteer` installed with bundled Chromium (~170MB)

**Step 3: Create sidecar entry stub**

Create `travian-bot-mac/sidecar/index.js`:
```javascript
/**
 * Sidecar Entry Point — JSON-RPC server over stdin/stdout
 * Communicates with Tauri Rust backend
 */
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
const handlers = {};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emit(event, data) {
  send({ event, data });
}

rl.on('line', async (line) => {
  try {
    const msg = JSON.parse(line);
    const { id, method, params } = msg;
    const handler = handlers[method];
    if (!handler) {
      send({ id, error: { code: -32601, message: `Unknown method: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      send({ id, result });
    } catch (err) {
      send({ id, error: { code: -32000, message: err.message } });
    }
  } catch (parseErr) {
    send({ error: { code: -32700, message: 'Parse error' } });
  }
});

// Register method handlers
handlers.ping = async () => ({ pong: true, timestamp: Date.now() });

emit('ready', { version: '1.0.0' });

module.exports = { handlers, send, emit };
```

**Step 4: Initialize Tauri project**

```bash
cd travian-bot-mac
npm create tauri-app@latest . -- --template vanilla --manager npm
```

After scaffolding, verify `src-tauri/` directory exists with `Cargo.toml` and `tauri.conf.json`.

**Step 5: Create minimal frontend placeholder**

Create `travian-bot-mac/src/index.html`:
```html
<!DOCTYPE html>
<html>
<head><title>Travian Bot</title></head>
<body><h1>Travian Bot — Loading...</h1></body>
</html>
```

**Step 6: Verify project builds**

```bash
cd travian-bot-mac && npm install && cd src-tauri && cargo build
```
Expected: Rust compilation succeeds

**Step 7: Commit**

```bash
git add travian-bot-mac/
git commit -m "feat: scaffold Tauri + Node.js sidecar project structure"
```

---

### Task 2: Adapt storage.js — JSON file I/O

**Files:**
- Create: `travian-bot-mac/sidecar/utils/storage.js`
- Reference: `travian-bot/utils/storage.js` (389 lines)

**What changes:** Replace all `chrome.storage.local.get/set` with `fs.readFileSync/writeFileSync` operating on JSON files in `~/Library/Application Support/TravianBot/`.

**Step 1: Create adapted storage module**

```javascript
/**
 * Travian Bot — File-based Storage (replaces chrome.storage.local)
 *
 * API-compatible with the Chrome extension's TravianStorage.
 * Stores data as JSON files in ~/Library/Application Support/TravianBot/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'TravianBot');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function _filePath(key) {
  // Sanitize key for filesystem (replace dots/colons with underscores)
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, safe + '.json');
}

async function get(key, defaultValue = null) {
  try {
    const fp = _filePath(key);
    if (!fs.existsSync(fp)) return defaultValue;
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[Storage] get() error:', err.message);
    return defaultValue;
  }
}

async function set(key, value) {
  try {
    const fp = _filePath(key);
    fs.writeFileSync(fp, JSON.stringify(value, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Storage] set() error:', err.message);
    throw err;
  }
}

// ... (rest follows same pattern as original storage.js)
// All functions: getConfig, saveConfig, getServerConfig, saveServerConfig,
// getServerRegistry, getServerState, saveServerState, extractServerKey,
// migrateIfNeeded, getVillageConfig, saveVillageConfig, getFarmTargets, saveFarmTargets
// Keep EXACT same API, just swap chrome.storage calls with get/set above.
```

Key differences from original:
- `get(key)` → reads `~/Library/Application Support/TravianBot/{key}.json`
- `set(key, value)` → writes JSON file atomically
- `getDefaultConfig()` → identical (copy as-is)
- `getServerConfig()` → identical logic, calls adapted `get()`
- `saveServerConfig()` → identical logic, calls adapted `set()`
- `extractServerKey()` → identical (pure function, no chrome API)
- Remove IIFE wrapper, use `module.exports` instead of `window.TravianStorage`

**Step 2: Write test for storage round-trip**

Create `travian-bot-mac/sidecar/utils/storage.test.js`:
```javascript
const Storage = require('./storage');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function testRoundTrip() {
  const testKey = 'test_roundtrip_' + Date.now();
  await Storage.set(testKey, { hello: 'world', count: 42 });
  const result = await Storage.get(testKey);
  console.assert(result.hello === 'world', 'String value mismatch');
  console.assert(result.count === 42, 'Number value mismatch');
  // Cleanup
  const fp = path.join(os.homedir(), 'Library', 'Application Support', 'TravianBot',
    testKey.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json');
  fs.unlinkSync(fp);
  console.log('PASS: storage round-trip');
}

async function testServerConfig() {
  const key = 'test.server.com';
  await Storage.saveServerConfig(key, { autoResourceUpgrade: false });
  const cfg = await Storage.getServerConfig(key);
  console.assert(cfg.autoResourceUpgrade === false, 'Config override failed');
  console.assert(cfg.autoTroopTraining === false, 'Default merge failed');
  console.log('PASS: server config merge');
}

(async () => {
  await testRoundTrip();
  await testServerConfig();
  console.log('All storage tests passed');
})();
```

**Step 3: Run test**

```bash
cd travian-bot-mac/sidecar && node utils/storage.test.js
```
Expected: "All storage tests passed"

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/utils/
git commit -m "feat: adapt storage.js for file-based I/O (replaces chrome.storage)"
```

---

### Task 3: Adapt logger.js — file + event emission

**Files:**
- Create: `travian-bot-mac/sidecar/utils/logger.js`
- Reference: `travian-bot/utils/logger.js` (217 lines)

**What changes:** Replace `chrome.storage.local` flush with writing to a log file. Add `emit` callback for sending log events to Rust/frontend via JSON-RPC.

**Step 1: Create adapted logger**

Key differences:
- `flush()` → writes to `~/Library/Application Support/TravianBot/bot_logs.json`
- Add `setEmitter(fn)` — when set, each log entry also calls `fn('log', entry)` for real-time forwarding to frontend
- Remove IIFE, use `module.exports`
- Keep exact same API: `log(level, msg, data)`, `debug/info/warn/error`, `getLogs(level, count)`, `clear()`, `flush()`

**Step 2: Write test**

```javascript
const Logger = require('./logger');
Logger.info('Test message', { foo: 'bar' });
Logger.warn('Warning test');
const logs = Logger.getLogs('INFO', 5);
console.assert(logs.length >= 2, 'Should have 2+ logs');
console.assert(logs[0].level === 'INFO', 'First log should be INFO');
Logger.flush();
console.log('PASS: logger tests');
```

**Step 3: Run test**

```bash
node utils/logger.test.js
```
Expected: "PASS: logger tests"

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/utils/logger.js travian-bot-mac/sidecar/utils/logger.test.js
git commit -m "feat: adapt logger.js for file output + event emission"
```

---

### Task 4: Copy pure-logic modules (no changes needed)

**Files:**
- Copy: `travian-bot/utils/delay.js` → `travian-bot-mac/sidecar/utils/delay.js`
- Copy: `travian-bot/core/taskQueue.js` → `travian-bot-mac/sidecar/core/task-queue.js`
- Copy: `travian-bot/core/scheduler.js` → `travian-bot-mac/sidecar/core/scheduler.js`
- Copy: `travian-bot/core/decisionEngine.js` → `travian-bot-mac/sidecar/core/decision-engine.js`
- Copy: `travian-bot/strategy/gameData.js` → `travian-bot-mac/sidecar/strategy/game-data.js`
- Copy: `travian-bot/strategy/buildOptimizer.js` → `travian-bot-mac/sidecar/strategy/build-optimizer.js`
- Copy: `travian-bot/strategy/militaryPlanner.js` → `travian-bot-mac/sidecar/strategy/military-planner.js`
- Copy: `travian-bot/strategy/strategyEngine.js` → `travian-bot-mac/sidecar/strategy/strategy-engine.js`
- Copy: `travian-bot/content/domScanner.js` → `travian-bot-mac/sidecar/content/dom-scanner.js`
- Copy: `travian-bot/content/actionExecutor.js` → `travian-bot-mac/sidecar/content/action-executor.js`

**Step 1: Copy all pure-logic files**

These modules use IIFE pattern attaching to `typeof window !== 'undefined' ? window : self`. In Node.js sidecar context, `self` and `window` are undefined but the content scripts (domScanner, actionExecutor) run inside Puppeteer's page context where `window` exists. Core/strategy modules run in Node.js where we pre-set `global.self = global` before loading.

```bash
mkdir -p travian-bot-mac/sidecar/{core,strategy,content,utils}
cp travian-bot/utils/delay.js travian-bot-mac/sidecar/utils/delay.js
cp travian-bot/core/taskQueue.js travian-bot-mac/sidecar/core/task-queue.js
cp travian-bot/core/scheduler.js travian-bot-mac/sidecar/core/scheduler.js
cp travian-bot/core/decisionEngine.js travian-bot-mac/sidecar/core/decision-engine.js
cp travian-bot/strategy/gameData.js travian-bot-mac/sidecar/strategy/game-data.js
cp travian-bot/strategy/buildOptimizer.js travian-bot-mac/sidecar/strategy/build-optimizer.js
cp travian-bot/strategy/militaryPlanner.js travian-bot-mac/sidecar/strategy/military-planner.js
cp travian-bot/strategy/strategyEngine.js travian-bot-mac/sidecar/strategy/strategy-engine.js
cp travian-bot/content/domScanner.js travian-bot-mac/sidecar/content/dom-scanner.js
cp travian-bot/content/actionExecutor.js travian-bot-mac/sidecar/content/action-executor.js
```

**Step 2: Create module loader for Node.js context**

Create `travian-bot-mac/sidecar/core/load-modules.js`:
```javascript
/**
 * Load IIFE modules into Node.js global scope.
 * Mimics how service-worker.js uses importScripts().
 *
 * Core/strategy modules attach to `self`, so we alias global.self = global.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Make IIFE modules find `self` as global
global.self = global;

const ROOT = path.join(__dirname, '..');

function loadScript(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

// Load in dependency order (same as service-worker.js importScripts)
loadScript('utils/delay.js');
// storage and logger are loaded separately as Node modules
loadScript('core/task-queue.js');
loadScript('core/scheduler.js');
loadScript('strategy/game-data.js');
loadScript('strategy/build-optimizer.js');
loadScript('strategy/military-planner.js');
loadScript('strategy/strategy-engine.js');
loadScript('core/decision-engine.js');

module.exports = {
  TravianTaskQueue: global.TravianTaskQueue,
  TravianScheduler: global.TravianScheduler,
  TravianDecisionEngine: global.TravianDecisionEngine,
  TravianGameData: global.TravianGameData,
  TravianBuildOptimizer: global.TravianBuildOptimizer,
  TravianMilitaryPlanner: global.TravianMilitaryPlanner,
  TravianStrategyEngine: global.TravianStrategyEngine,
  TravianDelay: global.TravianDelay,
};
```

**Step 3: Test module loading**

```bash
cd travian-bot-mac/sidecar && node -e "
const m = require('./core/load-modules');
console.assert(m.TravianTaskQueue, 'TaskQueue not loaded');
console.assert(m.TravianDecisionEngine, 'DecisionEngine not loaded');
console.assert(m.TravianGameData, 'GameData not loaded');
console.log('PASS: all modules loaded');
"
```
Expected: "PASS: all modules loaded"

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/core/ travian-bot-mac/sidecar/strategy/ travian-bot-mac/sidecar/content/ travian-bot-mac/sidecar/utils/delay.js
git commit -m "feat: copy pure-logic modules + create Node.js module loader"
```

---

### Task 5: Browser Manager — Puppeteer lifecycle

**Files:**
- Create: `travian-bot-mac/sidecar/browser-manager.js`

**Step 1: Implement browser manager**

```javascript
/**
 * BrowserManager — Puppeteer lifecycle management
 *
 * Handles: launch, close, headed/headless toggle, cookie injection
 */
const puppeteer = require('puppeteer');

class BrowserManager {
  constructor() {
    this.browser = null;
    this.headless = false; // default: show browser
  }

  async launch(options = {}) {
    if (this.browser) {
      console.log('[BrowserManager] Browser already running');
      return this.browser;
    }

    const headless = options.headless !== undefined ? options.headless : this.headless;

    this.browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800'
      ],
      defaultViewport: { width: 1280, height: 800 }
    });

    console.log(`[BrowserManager] Launched (headless: ${headless})`);
    return this.browser;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('[BrowserManager] Closed');
    }
  }

  async newPage() {
    if (!this.browser) await this.launch();
    return this.browser.newPage();
  }

  async toggleHeadless(headless) {
    this.headless = headless;
    // Full toggle requires relaunch — save pages, close, relaunch, restore
    // For now, just record preference. Actual toggle requires bot restart.
    console.log(`[BrowserManager] Headless preference set to: ${headless}`);
  }

  async setCookies(page, cookies) {
    if (!cookies || cookies.length === 0) return;
    await page.setCookie(...cookies);
    console.log(`[BrowserManager] Set ${cookies.length} cookies`);
  }

  isRunning() {
    return this.browser !== null;
  }
}

module.exports = BrowserManager;
```

**Step 2: Test browser launch**

```javascript
const BrowserManager = require('./browser-manager');
(async () => {
  const bm = new BrowserManager();
  await bm.launch({ headless: true });
  const page = await bm.newPage();
  await page.goto('https://example.com');
  const title = await page.title();
  console.assert(title.includes('Example'), 'Page title mismatch');
  await bm.close();
  console.log('PASS: browser manager');
})();
```

**Step 3: Run test**

```bash
cd travian-bot-mac/sidecar && node browser-manager.test.js
```
Expected: "PASS: browser manager"

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/browser-manager.js
git commit -m "feat: add BrowserManager for Puppeteer lifecycle"
```

---

### Task 6: Page Controller — script injection + page.evaluate

**Files:**
- Create: `travian-bot-mac/sidecar/page-controller.js`

**Step 1: Implement page controller**

This replaces `chrome.tabs.sendMessage({type:'SCAN'})` and `{type:'EXECUTE'}` with Puppeteer equivalents.

```javascript
/**
 * PageController — Manages Puppeteer page interactions
 *
 * Replaces Chrome extension content script messaging:
 * - SCAN → page.evaluate(() => TravianScanner.fullScan())
 * - EXECUTE → page.evaluate((action, params) => TravianExecutor.execute(action, params))
 */
const fs = require('fs');
const path = require('path');

class PageController {
  constructor(page) {
    this.page = page;
    this.scriptsInjected = false;

    // Content script paths
    this.contentScripts = [
      path.join(__dirname, 'content', 'dom-scanner.js'),
      path.join(__dirname, 'content', 'action-executor.js'),
    ];

    // Re-inject scripts on every navigation
    this.page.on('load', async () => {
      await this._injectScripts();
    });
  }

  async _injectScripts() {
    try {
      for (const scriptPath of this.contentScripts) {
        await this.page.addScriptTag({ path: scriptPath });
      }
      this.scriptsInjected = true;
    } catch (err) {
      console.warn('[PageController] Script injection failed:', err.message);
      this.scriptsInjected = false;
    }
  }

  /**
   * Send a SCAN command — equivalent to chrome.tabs.sendMessage({type: 'SCAN'})
   */
  async scan() {
    if (!this.scriptsInjected) await this._injectScripts();

    try {
      const result = await this.page.evaluate(() => {
        if (typeof window.TravianScanner === 'undefined') {
          return { success: false, error: 'Scanner not loaded' };
        }
        try {
          const data = window.TravianScanner.fullScan();
          return { success: true, data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Send an EXECUTE command — equivalent to chrome.tabs.sendMessage({type: 'EXECUTE', action, params})
   */
  async execute(action, params = {}) {
    if (!this.scriptsInjected) await this._injectScripts();

    try {
      const result = await this.page.evaluate((action, params) => {
        if (typeof window.TravianExecutor === 'undefined') {
          return { success: false, error: 'Executor not loaded' };
        }
        try {
          return window.TravianExecutor.execute(action, params);
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, action, params);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /** Navigate to a Travian page */
  async navigateTo(url) {
    await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
  }

  /** Get current page URL */
  getUrl() {
    return this.page.url();
  }
}

module.exports = PageController;
```

**Step 2: Commit**

```bash
git add travian-bot-mac/sidecar/page-controller.js
git commit -m "feat: add PageController for Puppeteer script injection + evaluate"
```

---

### Task 7: Adapt BotEngine — Puppeteer instead of chrome.tabs

**Files:**
- Create: `travian-bot-mac/sidecar/core/bot-engine.js`
- Reference: `travian-bot/core/botEngine.js` (1210 lines)

**What changes:**
1. `sendToContentScript(msg)` → delegates to `PageController.scan()` or `PageController.execute()`
2. Remove `chrome.alarms` (use `setInterval` instead — Node.js never dies)
3. Remove `chrome.storage` references in `loadConfig()` / `saveState()` → use adapted Storage
4. Remove `chrome.tabs.sendMessage` wrapper
5. Change export from `self.TravianBotEngine` to `module.exports`
6. `activeTabId` concept → `pageController` reference

**Step 1: Create adapted bot engine**

Copy `travian-bot/core/botEngine.js` and apply these changes:

Lines to change:
- **Constructor** (line 25): Replace `this.activeTabId = null` → `this.pageController = null`
- **start()** (lines 61-113): Remove `chrome.alarms.create()`, use `setInterval` for heartbeat
- **stop()** (lines 118-139): Remove `chrome.alarms.clear()`, use `clearInterval`
- **emergencyStop()** (lines 163-191): Remove `chrome.storage.local.set`, use Storage module
- **sendToContentScript()** (lines 581-607): Replace entire method:
  ```javascript
  async sendToContentScript(message) {
    if (!this.pageController) throw new Error('No page controller set');
    if (message.type === 'SCAN') {
      return this.pageController.scan();
    }
    if (message.type === 'EXECUTE') {
      return this.pageController.execute(message.action, message.params);
    }
    return { success: false, error: 'Unknown message type' };
  }
  ```
- **loadConfig()** (lines 669-708): Use `Storage.getServerConfig()` directly
- **saveState()** (lines 713-747): Use `Storage.saveServerState()` directly
- **Export** (line 1209): `module.exports = BotEngine` instead of `self.TravianBotEngine = BotEngine`
- Remove chrome.alarms listener at bottom (lines 1191-1206)

Keep everything else identical (mainLoop, executeTask, rate limiting, cooldowns, hero resource claiming, etc.)

**Step 2: Commit**

```bash
git add travian-bot-mac/sidecar/core/bot-engine.js
git commit -m "feat: adapt BotEngine for Puppeteer (replaces chrome.tabs messaging)"
```

---

### Task 8: Adapt InstanceManager — no Chrome tabs

**Files:**
- Create: `travian-bot-mac/sidecar/core/instance-manager.js`
- Reference: `travian-bot/core/instanceManager.js` (133 lines)

**What changes:**
- Replace `tabId` tracking → `page` (Puppeteer Page object) + `pageController`
- Remove `chrome.alarms.clear()` calls
- Change export to `module.exports`

**Step 1: Create adapted instance manager**

```javascript
const BotEngine = require('./bot-engine');
const PageController = require('../page-controller');

class InstanceManager {
  constructor() {
    this.instances = new Map();
  }

  getOrCreate(serverKey) {
    if (this.instances.has(serverKey)) return this.instances.get(serverKey);

    const engine = new BotEngine();
    engine.serverKey = serverKey;

    const instance = { engine, page: null, pageController: null, serverKey };
    this.instances.set(serverKey, instance);
    return instance;
  }

  get(serverKey) { return this.instances.get(serverKey) || null; }

  async remove(serverKey) {
    const inst = this.instances.get(serverKey);
    if (!inst) return;
    if (inst.engine.running) inst.engine.stop();
    if (inst.page) await inst.page.close().catch(() => {});
    this.instances.delete(serverKey);
  }

  listActive() {
    return [...this.instances.values()].map(inst => ({
      serverKey: inst.serverKey,
      running: inst.engine.running,
      paused: inst.engine.paused,
      stats: inst.engine.stats
    }));
  }

  stopAll() {
    for (const inst of this.instances.values()) {
      if (inst.engine.running) inst.engine.stop();
    }
  }

  runningCount() {
    let count = 0;
    for (const inst of this.instances.values()) {
      if (inst.engine.running) count++;
    }
    return count;
  }
}

module.exports = InstanceManager;
```

**Step 2: Commit**

```bash
git add travian-bot-mac/sidecar/core/instance-manager.js
git commit -m "feat: adapt InstanceManager for Puppeteer pages (no Chrome tabs)"
```

---

### Task 9: Wire up sidecar JSON-RPC methods

**Files:**
- Modify: `travian-bot-mac/sidecar/index.js`

**Step 1: Implement all JSON-RPC methods**

The sidecar `index.js` becomes the equivalent of `service-worker.js`, handling:
- `startBot` → create instance, launch page, inject scripts, start engine
- `stopBot` → stop engine, optionally close page
- `getStatus` → return engine status
- `getServers` → list all instances
- `saveConfig` → save to file storage
- `getStrategy` → return decision engine analysis
- `getLogs` → return logger entries
- `getQueue` → return task queue
- `toggleBrowser` → headed/headless switch
- `requestScan` → manual scan from popup

Each method maps to the same logic as `service-worker.js` message handler (lines 126-482), but using Puppeteer instead of Chrome APIs.

**Step 2: Commit**

```bash
git add travian-bot-mac/sidecar/index.js
git commit -m "feat: wire JSON-RPC methods (equivalent of service-worker message handler)"
```

---

## Phase 2: Tauri Shell (Rust Backend + Frontend)

### Task 10: Rust backend — sidecar management + IPC commands

**Files:**
- Modify: `travian-bot-mac/src-tauri/src/main.rs`
- Create: `travian-bot-mac/src-tauri/src/sidecar.rs`
- Create: `travian-bot-mac/src-tauri/src/commands.rs`

**Step 1: Implement sidecar spawning**

`sidecar.rs`: Spawn `node sidecar/index.js` as a child process. Communicate via stdin/stdout JSON-RPC lines. Parse incoming events (statusUpdate, log, gameState) and emit them as Tauri events.

**Step 2: Implement IPC commands**

`commands.rs`: Tauri `#[tauri::command]` functions that the frontend calls:
- `start_bot(server_key)` → sends `{"method": "startBot"}` to sidecar
- `stop_bot(server_key)` → sends `{"method": "stopBot"}`
- `get_status(server_key)` → sends `{"method": "getStatus"}`
- `save_config(server_key, config)` → sends `{"method": "saveConfig"}`
- `get_servers()` → sends `{"method": "getServers"}`
- `toggle_browser(headless)` → sends `{"method": "toggleBrowser"}`
- `request_scan(server_key)` → sends `{"method": "requestScan"}`
- `get_logs()` → sends `{"method": "getLogs"}`
- `get_queue(server_key)` → sends `{"method": "getQueue"}`
- `get_strategy(server_key)` → sends `{"method": "getStrategy"}`

**Step 3: Wire up main.rs**

Register commands and start sidecar on app launch.

**Step 4: Commit**

```bash
git add travian-bot-mac/src-tauri/
git commit -m "feat: Rust backend — sidecar management + IPC commands"
```

---

### Task 11: Frontend dashboard — adapt popup to full-size Tauri window

**Files:**
- Create: `travian-bot-mac/src/index.html` (adapted from `travian-bot/popup/index.html`)
- Create: `travian-bot-mac/src/styles.css` (adapted from `travian-bot/popup/styles.css`)
- Create: `travian-bot-mac/src/app.js` (adapted from `travian-bot/popup/popup.js`)

**What changes:**
- Replace `chrome.runtime.sendMessage()` → `window.__TAURI__.invoke()`
- Replace `chrome.runtime.onMessage.addListener` → `window.__TAURI__.event.listen()`
- Remove 420x580 fixed size constraints → min 800x600, responsive
- Add resource sidebar (always visible)
- Add 2 new tabs: Farm, Settings
- Keep existing 4 tabs: Dashboard, Config, Strategy, Logs

**Step 1: Create adapted HTML**

Start from `popup/index.html` (311 lines). Changes:
- Remove `<meta name="viewport" content="width=420">` → use responsive
- Add left sidebar for resources/troops/crop balance
- Add Farm tab panel
- Add Settings tab panel (cookie import, browser toggle, schedule)
- Update tab bar to 6 tabs

**Step 2: Create adapted CSS**

Start from `popup/styles.css` (1245 lines). Changes:
- Remove `width: 420px; height: 580px` constraints on body
- Add `min-width: 800px; min-height: 600px`
- Add sidebar layout (CSS Grid: sidebar 200px + main auto)
- Add Farm tab styles
- Add Settings tab styles
- Keep gaming theme (dark background, neon accents, etc.)

**Step 3: Create adapted JS**

Start from `popup/popup.js` (1747 lines). Changes:
- Replace all `sendMessage(msg)` calls:
  ```javascript
  // Before (Chrome extension):
  chrome.runtime.sendMessage(msg, callback);

  // After (Tauri):
  const { invoke } = window.__TAURI__.core;
  const result = await invoke('get_status', { serverKey: currentServerKey });
  ```
- Replace server detection: instead of querying Chrome tabs, call `invoke('get_servers')`
- Add `listen('bot-status', (event) => {...})` for real-time updates from sidecar
- Add Farm tab logic
- Add Settings tab logic (cookie import, browser toggle)
- Update `TAB_PANEL_MAP` to include new tabs

**Step 4: Commit**

```bash
git add travian-bot-mac/src/
git commit -m "feat: full-size dashboard — adapted from popup with Tauri IPC"
```

---

### Task 12: System tray integration

**Files:**
- Create: `travian-bot-mac/src-tauri/src/tray.rs`
- Modify: `travian-bot-mac/src-tauri/src/main.rs`

**Step 1: Implement system tray**

Use Tauri's system tray API to show:
- Bot status per server (Running/Paused/Stopped)
- "Show Dashboard" to reopen window
- "Stop All" to stop all bots
- "Quit" to exit app

When main window is closed, app stays in tray. Bot continues running.

**Step 2: Commit**

```bash
git add travian-bot-mac/src-tauri/src/tray.rs
git commit -m "feat: system tray — bot runs in background when window closed"
```

---

## Phase 3: Cookie Import

### Task 13: Chrome cookie import

**Files:**
- Create: `travian-bot-mac/src-tauri/src/cookies.rs`
- Modify: `travian-bot-mac/src/app.js` (Settings tab)

**Step 1: Implement cookie reader in Rust**

`cookies.rs`:
- Read Chrome's SQLite cookie database: `~/Library/Application Support/Google/Chrome/Default/Cookies`
- Decrypt cookies using macOS Keychain key (`Chrome Safe Storage`)
- Filter for `*.travian.com` domains
- Return as JSON array

**Step 2: Add IPC command**

`commands.rs`: Add `import_chrome_cookies()` command.

**Step 3: Frontend integration**

In Settings tab, add "Import from Chrome" button. On click:
```javascript
const cookies = await invoke('import_chrome_cookies');
await invoke('start_bot', { serverKey, cookies });
```

Fallback: If import fails, show headed browser for manual login.

**Step 4: Commit**

```bash
git add travian-bot-mac/src-tauri/src/cookies.rs
git commit -m "feat: Chrome cookie import for auto-login"
```

---

## Phase 4: New Game Features

### Task 14: Crop-aware troop training

**Files:**
- Modify: `travian-bot-mac/sidecar/core/decision-engine.js` (copied in Task 4)
- Modify: `travian-bot-mac/sidecar/strategy/game-data.js` (if troop crop data missing)

**Step 1: Add crop balance check to `evaluateTroopTraining()`**

In `decision-engine.js`, before the `return` statement that creates a `train_troops` task, add:

```javascript
// Crop-awareness: check if village can sustain new troops
const cropProduction = (state.resourceProduction && state.resourceProduction.crop) || 0;
const cropConsumption = this._estimateCropConsumption(state);
const newTroopCrop = this._getTroopCropCost(finalTroopType, trainCount, config.tribe);
const cropBalance = cropProduction - cropConsumption - newTroopCrop;
const safetyMargin = (config.cropSafetyMargin !== undefined) ? config.cropSafetyMargin : 50;

if (cropBalance < -safetyMargin) {
  console.log(`[DecisionEngine] Skipping troop training: crop balance would be ${cropBalance}/hr (threshold: -${safetyMargin})`);
  return null; // Skip training
}
```

Add helper methods `_estimateCropConsumption(state)` and `_getTroopCropCost(troopType, count, tribe)`.

**Step 2: Add crop balance to dashboard**

In frontend sidebar, show crop balance indicator:
- Green: balance > 50/hr
- Yellow: 0 < balance < 50/hr
- Red: balance < 0/hr

**Step 3: Commit**

```bash
git add travian-bot-mac/sidecar/core/decision-engine.js
git commit -m "feat: crop-aware troop training — skip if crop goes negative"
```

---

### Task 15: Gaul Trapper support

**Files:**
- Modify: `travian-bot-mac/sidecar/core/decision-engine.js`
- Modify: `travian-bot-mac/sidecar/strategy/game-data.js`
- Modify: `travian-bot-mac/sidecar/content/dom-scanner.js`

**Step 1: Add tribe detection to dom-scanner**

In `dom-scanner.js`, add `detectTribe()` method that reads the player profile or hero page for tribe indicator. Add to `fullScan()` return data.

**Step 2: Add trapper data to game-data**

In `game-data.js`, add trapper (GID 36) capacity per level:
```javascript
TRAPPER: {
  gid: 36,
  tribe: 'gaul',
  capacityPerLevel: [0, 10, 22, 36, 52, 70, 90, 112, 136, 162, 190, 220, 252, 286, 322, 360, 400, 442, 486, 532, 580]
}
```

**Step 3: Add trapper priority rule to decision engine**

In `evaluate()`, after cranny rule, add:
```javascript
// Trapper rule (Gaul only): if incoming attacks detected, prioritize trapper
if (config.autoTrapper && state.tribe === 'gaul') {
  const trapperTask = this._evaluateTrapperRule(state, config, taskQueue);
  if (trapperTask) newTasks.push(trapperTask);
}
```

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/core/decision-engine.js travian-bot-mac/sidecar/strategy/game-data.js travian-bot-mac/sidecar/content/dom-scanner.js
git commit -m "feat: Gaul Trapper support — auto-upgrade trapper on incoming raids"
```

---

### Task 16: Smart farming system

**Files:**
- Create: `travian-bot-mac/sidecar/strategy/farm-manager.js`
- Modify: `travian-bot-mac/sidecar/core/decision-engine.js`
- Modify: `travian-bot-mac/sidecar/content/dom-scanner.js`

**Step 1: Create farm-manager module**

```javascript
/**
 * FarmManager — Smart farming target management
 *
 * Layer 1: Farm list integration (existing, improved timing)
 * Layer 2: Target scoring — profit / distance / risk
 * Layer 3: Troop selection — fast for close, cheap for risky
 */
class FarmManager {
  constructor() {
    this.targets = new Map(); // targetId -> { profit, losses, lastRaid, distance }
  }

  updateFromRaidReport(report) { /* track profit/loss per target */ }
  scoreTargets() { /* return sorted by profit/distance/risk */ }
  shouldSkipTarget(targetId) { /* true if losses > maxLossesBeforeSkip */ }
  selectTroops(target, availableTroops, config) { /* fastest/cheapest logic */ }
}
```

**Step 2: Add raid report scanning to dom-scanner**

In `dom-scanner.js`, add `scanRaidReports()`:
- Navigate to reports tab
- Parse last N raid reports
- Extract: target coords, resources gained, troop losses

**Step 3: Integrate farm manager into decision engine**

In `evaluateFarming()`, when `config.farmConfig.mode === 'smart'`:
- Use farm manager's scored targets instead of raw farm lists
- Apply min profit ratio filter
- Reserve minimum troops for defense

**Step 4: Add Farm tab UI**

In frontend, create Farm tab showing:
- Target list with scores
- Raid history (recent reports)
- Loss tracker
- Mode selector (Farm List / Manual / Smart)

**Step 5: Commit**

```bash
git add travian-bot-mac/sidecar/strategy/farm-manager.js
git commit -m "feat: smart farming system — target scoring, troop selection, loss tracking"
```

---

### Task 17: Quest system

**Files:**
- Modify: `travian-bot-mac/sidecar/content/dom-scanner.js`
- Modify: `travian-bot-mac/sidecar/content/action-executor.js`
- Modify: `travian-bot-mac/sidecar/core/decision-engine.js`

**Step 1: Add quest scanner to dom-scanner**

Add `scanQuests()`:
- Check quest indicator (quest master icon)
- Open quest dialog
- Parse quest list: completed/unclaimed, in-progress, available
- Return `{ quests: [{ id, status, type, reward }] }`

**Step 2: Add claim_quest action to action-executor**

Add `claimQuest(questId)`:
- Click completed quest in quest dialog
- Click "Collect Reward" button
- Return `{ success: true, reward: {...} }`

**Step 3: Add quest check to decision engine**

In `evaluate()`, after farming checks:
```javascript
// Quest system: auto-claim completed quests
if (config.autoClaimQuests !== false && !this.isCoolingDown('claim_quest')) {
  const questTask = this._evaluateQuests(state, config, taskQueue);
  if (questTask) newTasks.push(questTask);
}
```

**Step 4: Commit**

```bash
git add travian-bot-mac/sidecar/content/ travian-bot-mac/sidecar/core/decision-engine.js
git commit -m "feat: quest system — auto-detect and claim completed quests"
```

---

### Task 18: Better build & resource UX

**Files:**
- Modify: `travian-bot-mac/src/index.html`
- Modify: `travian-bot-mac/src/styles.css`
- Modify: `travian-bot-mac/src/app.js`

**Step 1: Resource fields visual grid**

In Dashboard or Config tab, add a 3×6 grid showing 18 resource field positions:
- Color-coded: wood=brown, clay=red, iron=gray, crop=green
- Show level number on each tile
- Click to set target level
- "Upgrade all crop to level X" quick action button

**Step 2: Buildings panel improvements**

- Categorize buildings: Infrastructure, Military, Economy, Defense
- Show production rate per field
- Build cost preview before committing
- Build time estimate

**Step 3: Build queue preview**

- Show planned sequence (not just active queue)
- Estimated completion time
- Resource requirement timeline

**Step 4: Commit**

```bash
git add travian-bot-mac/src/
git commit -m "feat: improved build & resource UX — visual grid, categories, queue preview"
```

---

## Phase 5: Integration & Testing

### Task 19: End-to-end integration test

**Step 1: Start sidecar manually and test JSON-RPC**

```bash
cd travian-bot-mac/sidecar && echo '{"id":1,"method":"ping","params":{}}' | node index.js
```
Expected: `{"id":1,"result":{"pong":true,...}}`

**Step 2: Build and run Tauri app**

```bash
cd travian-bot-mac && npm run tauri dev
```
Expected: App window opens with dashboard.

**Step 3: Test cookie import + bot start**

1. Click "Import from Chrome" in Settings tab
2. Verify cookies are extracted
3. Select a server and click Start
4. Verify Chromium window opens (headed mode)
5. Verify bot starts scanning and executing

**Step 4: Test headed/headless toggle**

1. Toggle to headless in Settings
2. Restart bot
3. Verify no browser window (bot runs in background)

**Step 5: Test system tray**

1. Close dashboard window
2. Verify tray icon shows bot status
3. Click "Show Dashboard" to reopen
4. Verify bot is still running

**Step 6: Commit**

```bash
git commit -m "test: end-to-end integration verified"
```

---

### Task 20: Build .dmg for distribution

**Step 1: Build release**

```bash
cd travian-bot-mac && npm run tauri build
```

**Step 2: Verify .dmg**

- Check `src-tauri/target/release/bundle/dmg/` for .dmg file
- Install on a clean Mac
- Verify app launches, sidecar starts, bot works

**Step 3: Commit final**

```bash
git add -A && git commit -m "feat: Travian Bot Mac standalone app — complete"
```

---

## Summary: Chrome Extension → Mac App API Mapping

| Chrome Extension API | Mac App Equivalent | Where |
|---|---|---|
| `chrome.storage.local.get/set` | `fs.readFileSync/writeFileSync` (JSON files) | `sidecar/utils/storage.js` |
| `chrome.tabs.sendMessage({type:'SCAN'})` | `page.evaluate(() => TravianScanner.fullScan())` | `sidecar/page-controller.js` |
| `chrome.tabs.sendMessage({type:'EXECUTE'})` | `page.evaluate((a,p) => TravianExecutor.execute(a,p))` | `sidecar/page-controller.js` |
| Content script auto-injection | `page.addScriptTag({path})` on every `load` event | `sidecar/page-controller.js` |
| `chrome.alarms` (1 min heartbeat) | `setInterval` in Node.js (persistent) | `sidecar/core/bot-engine.js` |
| Service worker (can die) | Node.js sidecar (persistent process) | `sidecar/index.js` |
| `chrome.runtime.sendMessage` (popup→SW) | `window.__TAURI__.invoke()` (frontend→Rust→sidecar) | `src/app.js` |
| `chrome.runtime.onMessage` (SW→popup) | `window.__TAURI__.event.listen()` | `src/app.js` |
| Popup (420×580 fixed) | Tauri window (resizable, min 800×600) | `src/index.html` |
| `chrome.notifications` | macOS native notifications via Tauri | `src-tauri/src/main.rs` |
| `chrome.cookies` | Read Chrome's SQLite DB + Keychain decrypt | `src-tauri/src/cookies.rs` |
