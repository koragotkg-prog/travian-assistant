/**
 * Sidecar Entry Point — JSON-RPC server over stdin/stdout
 * Communicates with Tauri Rust backend.
 *
 * Protocol: one JSON object per line, both directions.
 *
 * Incoming (from Rust):  { id: number, method: string, params: object }
 * Outgoing (to Rust):    { id: number, result: any } or { id: number, error: { code, message } }
 * Events (to Rust):      { event: string, data: any }
 */
const readline = require('readline');

// ── CRITICAL: Redirect all console output to stderr ─────────────────
// stdout is RESERVED for JSON-RPC IPC with Tauri.
// Any console.log/debug going to stdout would corrupt the protocol.
const _origLog = console.log;
const _origDebug = console.debug;
console.log   = console.error;
console.debug = console.error;

// ── Load all modules into global scope ───────────────────────────────
require('./core/load-modules');

const BrowserManager = require('./browser-manager');
const InstanceManager = require('./core/instance-manager');
const Storage = require('./utils/storage');
const Logger = require('./utils/logger');
const { importChromeCookies } = require('./utils/chrome-cookies');

// ── Singletons ───────────────────────────────────────────────────────
const browser = new BrowserManager();
const manager = new InstanceManager();

// ── JSON-RPC transport ───────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
const handlers = {};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emit(event, data) {
  send({ event, data });
}

// Forward all log entries to Rust as events
Logger.setEmitter((ev, entry) => {
  emit('log', entry);
});

// ── Request dispatcher ───────────────────────────────────────────────
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
      const result = await handler(params || {});
      send({ id, result });
    } catch (err) {
      send({ id, error: { code: -32000, message: err.message } });
    }
  } catch (parseErr) {
    send({ error: { code: -32700, message: 'Parse error' } });
  }
});

// ══════════════════════════════════════════════════════════════════════
//  HANDLERS
// ══════════════════════════════════════════════════════════════════════

// ── Ping ─────────────────────────────────────────────────────────────
handlers.ping = async () => ({ pong: true, timestamp: Date.now() });

// ── List all server instances + registry ─────────────────────────────
handlers.getServers = async () => {
  const instances = manager.listActive();
  const registry = await Storage.getServerRegistry();
  return { instances, registry };
};

// ── Get status for a specific server ─────────────────────────────────
handlers.getStatus = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  if (inst) {
    return inst.engine.getStatus();
  }
  // No instance yet — return default idle status
  return {
    running: false, paused: false, emergencyStopped: false,
    serverKey: serverKey || null,
    stats: { tasksCompleted: 0, tasksFailed: 0, startTime: null, lastAction: null, farmRaidsSent: 0 },
    actionsThisHour: 0,
    taskQueue: { total: 0, pending: 0, tasks: [] },
    gameState: null, config: null, nextActionTime: null
  };
};

// ── Start Bot ────────────────────────────────────────────────────────
handlers.startBot = async ({ serverKey, url }) => {
  if (!serverKey) throw new Error('No serverKey provided');

  const inst = manager.getOrCreate(serverKey);

  if (inst.engine.running && !inst.engine.paused) {
    throw new Error('Bot is already running for ' + serverKey);
  }

  // Set up emitter so engine status updates go to Rust
  inst.engine.setEmitter((event, data) => {
    emit('botEvent', { serverKey, event, data });
  });

  // If no page bound yet, open one
  if (!inst.page) {
    const page = await browser.newPage();
    manager.bindPage(serverKey, page);

    // Navigate to the server if URL provided
    const targetUrl = url || ('https://' + serverKey);
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    Logger.info('Navigated to ' + targetUrl);
  }

  // Start the engine with its page controller
  await inst.engine.start(inst.pageController);
  Logger.info('Bot started for ' + serverKey);

  return inst.engine.getStatus();
};

// ── Stop Bot ─────────────────────────────────────────────────────────
handlers.stopBot = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  if (inst && inst.engine.running) {
    inst.engine.stop();
    Logger.info('Bot stopped for ' + serverKey);
  }
  return inst ? inst.engine.getStatus() : null;
};

// ── Pause / Resume Toggle ────────────────────────────────────────────
handlers.pauseBot = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  if (!inst) throw new Error('No bot instance found for ' + serverKey);

  if (inst.engine.paused) {
    inst.engine.resume();
    return { paused: false };
  } else {
    inst.engine.pause();
    return { paused: true };
  }
};

// ── Emergency Stop ───────────────────────────────────────────────────
handlers.emergencyStop = async ({ serverKey, reason }) => {
  const stopReason = reason || 'User triggered emergency stop';

  if (serverKey) {
    const inst = manager.get(serverKey);
    if (inst) {
      inst.engine.emergencyStop(stopReason);
      Logger.error('EMERGENCY STOP: ' + stopReason + ' (' + serverKey + ')');
      return inst.engine.getStatus();
    }
  }

  // No serverKey or instance not found — stop all as safety fallback
  manager.stopAll();
  Logger.error('EMERGENCY STOP ALL: ' + stopReason);
  return { stopped: true };
};

// ── Save Config ──────────────────────────────────────────────────────
handlers.saveConfig = async ({ serverKey, config }) => {
  if (!config) throw new Error('No config data provided');

  if (serverKey) {
    await Storage.saveServerConfig(serverKey, config);
    // Hot-update running engine's config
    const inst = manager.get(serverKey);
    if (inst) inst.engine.config = config;
  } else {
    await Storage.set('bot_config', config);
  }

  Logger.info('Config saved' + (serverKey ? ' for ' + serverKey : ''));
  return { success: true };
};

// ── Get Config ───────────────────────────────────────────────────────
handlers.getConfig = async ({ serverKey }) => {
  if (serverKey) {
    return await Storage.getServerConfig(serverKey);
  }
  return await Storage.getConfig();
};

// ── Logs ─────────────────────────────────────────────────────────────
handlers.getLogs = async ({ level, limit }) => {
  let logs = Logger.getLogs();
  if (level) {
    logs = logs.filter(l => l.level === level.toUpperCase());
  }
  if (limit) {
    logs = logs.slice(-limit);
  }
  return logs;
};

handlers.clearLogs = async () => {
  Logger.clear();
  return { success: true };
};

// ── Task Queue ───────────────────────────────────────────────────────
handlers.getQueue = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  return (inst && inst.engine.taskQueue) ? inst.engine.taskQueue.getAll() : [];
};

handlers.clearQueue = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  if (inst && inst.engine.taskQueue) inst.engine.taskQueue.clear();
  return { success: true };
};

// ── Strategy Analysis ────────────────────────────────────────────────
handlers.getStrategy = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  const analysis = (inst && inst.engine.decisionEngine)
    ? inst.engine.decisionEngine.getLastAnalysis()
    : null;
  const phase = (inst && inst.engine.decisionEngine)
    ? inst.engine.decisionEngine.getPhase()
    : 'unknown';
  return { analysis, phase };
};

// ── Request Manual Scan ──────────────────────────────────────────────
handlers.requestScan = async ({ serverKey }) => {
  const inst = manager.get(serverKey);
  if (!inst || !inst.pageController) {
    throw new Error('No active page for ' + (serverKey || 'unknown'));
  }

  const pc = inst.pageController;
  const currentUrl = pc.getUrl();
  const baseUrl = currentUrl.replace(/\/[^/]*$/, '');

  const merged = {
    resourceFields: [],
    buildings: [],
    resources: null,
    resourceCapacity: null,
    resourceProduction: null,
    constructionQueue: { count: 0, maxCount: 1, items: [] },
    troops: null,
    villages: [],
    hero: null,
    loggedIn: false,
    page: 'merged'
  };

  // Step 1: Navigate to dorf1 and scan resources
  const dorf1Url = baseUrl + '/dorf1.php';
  if (!currentUrl.includes('dorf1.php')) {
    await pc.navigateTo(dorf1Url);
  }
  const scan1 = await pc.scan();
  if (scan1 && scan1.success && scan1.data) {
    merged.resourceFields = scan1.data.resourceFields || [];
    merged.resources = scan1.data.resources;
    merged.resourceCapacity = scan1.data.resourceCapacity;
    merged.resourceProduction = scan1.data.resourceProduction;
    merged.constructionQueue = scan1.data.constructionQueue || merged.constructionQueue;
    merged.troops = scan1.data.troops;
    merged.villages = scan1.data.villages || [];
    merged.hero = scan1.data.hero;
    merged.loggedIn = scan1.data.loggedIn;
  }

  // Step 2: Navigate to dorf2 and scan buildings
  const dorf2Url = baseUrl + '/dorf2.php';
  await pc.navigateTo(dorf2Url);
  const scan2 = await pc.scan();
  if (scan2 && scan2.success && scan2.data) {
    merged.buildings = scan2.data.buildings || [];
    if (scan2.data.constructionQueue && scan2.data.constructionQueue.count > 0) {
      merged.constructionQueue = scan2.data.constructionQueue;
    }
  }

  // Update the instance's game state
  inst.engine.gameState = merged;
  emit('gameState', { serverKey, data: merged });

  return merged;
};

// ── Browser Management ───────────────────────────────────────────────
handlers.toggleBrowser = async ({ headless }) => {
  // This takes effect on next browser launch
  const newMode = headless !== undefined ? headless : !browser.headless;
  browser.setHeadless(newMode);
  return { headless: newMode };
};

handlers.getBrowserStatus = async () => {
  return {
    running: browser.isRunning(),
    headless: browser.headless,
    pages: manager.listActive().length
  };
};

// ── Open a new page for a server (without starting the bot) ──────────
handlers.openPage = async ({ serverKey, url }) => {
  if (!serverKey) throw new Error('No serverKey provided');

  const inst = manager.getOrCreate(serverKey);

  // Set up emitter for future use
  inst.engine.setEmitter((event, data) => {
    emit('botEvent', { serverKey, event, data });
  });

  if (!inst.page) {
    const page = await browser.newPage();
    manager.bindPage(serverKey, page);
  }

  const targetUrl = url || ('https://' + serverKey);
  await inst.page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  Logger.info('Opened page for ' + serverKey);

  return { serverKey, url: inst.page.url() };
};

// ── Close a server page ──────────────────────────────────────────────
handlers.closePage = async ({ serverKey }) => {
  await manager.remove(serverKey);
  return { success: true };
};

// ── Chrome Cookie Import ──────────────────────────────────────────────
handlers.importChromeCookies = async ({ hostLike } = {}) => {
  const cookies = await importChromeCookies({ hostLike });
  Logger.info(`Imported ${cookies.length} Chrome cookies`);
  return { cookies, count: cookies.length };
};

// ── Set cookies on an active page ─────────────────────────────────────
handlers.setCookies = async ({ serverKey, cookies }) => {
  const inst = manager.get(serverKey);
  if (!inst || !inst.page) {
    throw new Error('No page open for ' + serverKey);
  }
  await browser.setCookies(inst.page, cookies);
  return { success: true, count: cookies.length };
};

// ── Village management ───────────────────────────────────────────────
handlers.getVillageConfig = async ({ serverKey, villageId }) => {
  return await Storage.getVillageConfig(serverKey, villageId);
};

handlers.saveVillageConfig = async ({ serverKey, villageId, config }) => {
  await Storage.saveVillageConfig(serverKey, villageId, config);
  return { success: true };
};

// ── Farm targets ─────────────────────────────────────────────────────
handlers.getFarmTargets = async ({ serverKey }) => {
  return await Storage.getFarmTargets(serverKey);
};

handlers.saveFarmTargets = async ({ serverKey, targets }) => {
  await Storage.saveFarmTargets(serverKey, targets);
  return { success: true };
};

// ── Shutdown the entire sidecar ──────────────────────────────────────
handlers.shutdown = async () => {
  Logger.info('Shutdown requested');
  manager.stopAll();
  await browser.close();
  Logger.flush();
  // Give time for the response to be sent
  setTimeout(() => process.exit(0), 200);
  return { success: true };
};

// ══════════════════════════════════════════════════════════════════════
//  INITIALIZATION
// ══════════════════════════════════════════════════════════════════════

(async function init() {
  // Logs are auto-restored on require('./utils/logger')
  Logger.info('[Sidecar] Process started (PID: ' + process.pid + ')');

  // Run storage migration if needed
  try {
    await Storage.migrateIfNeeded();
  } catch (err) {
    Logger.warn('Migration error: ' + err.message);
  }

  // Signal readiness to Rust backend
  emit('ready', {
    version: '1.0.0',
    pid: process.pid,
    methods: Object.keys(handlers)
  });
})();

// Graceful shutdown on SIGTERM/SIGINT
process.on('SIGTERM', async () => {
  Logger.info('[Sidecar] SIGTERM received, shutting down...');
  manager.stopAll();
  await browser.close();
  Logger.flush();
  process.exit(0);
});

process.on('SIGINT', async () => {
  Logger.info('[Sidecar] SIGINT received, shutting down...');
  manager.stopAll();
  await browser.close();
  Logger.flush();
  process.exit(0);
});

// Prevent unhandled rejections from crashing the sidecar
process.on('unhandledRejection', (reason) => {
  Logger.error('[Sidecar] Unhandled rejection: ' + (reason && reason.message || reason));
});

module.exports = { handlers, send, emit };
