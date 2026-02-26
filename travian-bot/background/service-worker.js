/**
 * Travian Bot - Background Service Worker (Manifest V3)
 *
 * Orchestrates multiple bot instances (one per server) by importing core modules,
 * handling messages from popup/content scripts, managing tabs, alarms, and notifications.
 *
 * NOTE: This is a service worker — NO DOM access, NO `window`. Use `self`.
 * Uses importScripts() (not ES modules) so manifest must NOT have "type": "module".
 */

// ---------------------------------------------------------------------------
// 1. Import Core Modules (each attaches to `self`)
// ---------------------------------------------------------------------------
importScripts(
  '../utils/delay.js',
  '../utils/logger.js',
  '../utils/storage.js',
  '../core/taskQueue.js',
  '../core/scheduler.js',
  '../strategy/gameData.js',
  '../strategy/buildOptimizer.js',
  '../strategy/militaryPlanner.js',
  '../strategy/strategyEngine.js',
  '../core/actionScorer.js',     // TravianActionScorer
  '../core/decisionEngine.js',
  '../core/botEngine.js',
  '../core/instanceManager.js'
);

// ---------------------------------------------------------------------------
// 2. Globals
// ---------------------------------------------------------------------------
const LOG_TAG = '[ServiceWorker]';
const logger = self.TravianLogger;
const manager = new self.TravianInstanceManager();

// ---------------------------------------------------------------------------
// 3. Helper — find ALL open Travian tabs
// ---------------------------------------------------------------------------
const TRAVIAN_PATTERNS = [
  '*://*.travian.com/*',
  '*://*.travian.de/*',
  '*://*.travian.co.uk/*',
  '*://*.travian.us/*',
  '*://*.travian.net/*',
  '*://*.travian.cl/*',
  '*://*.travian.com.br/*',
  '*://*.travian.co.id/*',
  '*://*.travian.asia/*'
];

async function findAllTravianTabs() {
  var allTabs = [];
  for (var i = 0; i < TRAVIAN_PATTERNS.length; i++) {
    try {
      var tabs = await chrome.tabs.query({ url: TRAVIAN_PATTERNS[i] });
      if (tabs) allTabs.push.apply(allTabs, tabs);
    } catch (_) {}
  }
  // Deduplicate by tab ID
  var seen = {};
  return allTabs.filter(function (t) {
    if (seen[t.id]) return false;
    seen[t.id] = true;
    return true;
  });
}

async function findTravianTab() {
  var tabs = await findAllTravianTabs();
  return tabs.length > 0 ? tabs[0] : null;
}

// ---------------------------------------------------------------------------
// 4. Helper — resolve instance for a message
// ---------------------------------------------------------------------------
function resolveInstance(message, sender) {
  // Content script messages — route by tab ID
  if (sender && sender.tab) {
    var inst = manager.getByTabId(sender.tab.id);
    if (inst) return inst;

    // No instance yet — extract server key from tab URL and create
    if (sender.tab.url) {
      var serverKey = self.TravianStorage.extractServerKey(sender.tab.url);
      if (serverKey) {
        inst = manager.getOrCreate(serverKey);
        inst.tabId = sender.tab.id;
        inst.engine.activeTabId = sender.tab.id;
        return inst;
      }
    }
    return null;
  }

  // Popup messages — route by serverKey in message
  if (message && message.serverKey) {
    return manager.get(message.serverKey);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Notification helper
// ---------------------------------------------------------------------------
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: '../icons/icon128.png',
      title: 'Travian Bot — ' + title,
      message: String(message)
    }, function () {
      if (chrome.runtime.lastError) {
        logger.warn('Notification failed:', chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    logger.warn('notify() error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// 6. Message Handler (from popup, content scripts, etc.)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  (async function () {
    try {
      var type = message ? message.type : null;
      var data = message ? message.data : null;
      var msgConfig = message ? message.config : null;
      var serverKey = message ? message.serverKey : null;
      logger.debug(LOG_TAG + ' onMessage: ' + type + (serverKey ? ' [' + serverKey + ']' : ''));

      switch (type) {

        // ---- List all server instances ----
        case 'GET_SERVERS': {
          var servers = manager.listActive();
          var registry = await self.TravianStorage.getServerRegistry();
          sendResponse({ success: true, data: { instances: servers, registry: registry } });
          break;
        }

        // ---- Status (per-server) ----
        case 'GET_STATUS': {
          var inst = resolveInstance(message, sender);
          if (inst) {
            var status = inst.engine.getStatus();
            status.activeTabId = inst.tabId;
            sendResponse({ success: true, data: status });
          } else {
            // No instance for this server yet — return default idle status
            sendResponse({
              success: true,
              data: {
                running: false, paused: false, emergencyStopped: false,
                activeTabId: null, serverKey: serverKey,
                stats: { tasksCompleted: 0, tasksFailed: 0, startTime: null, lastAction: null, farmRaidsSent: 0 },
                actionsThisHour: 0, taskQueue: { total: 0, pending: 0, tasks: [] },
                gameState: null, config: null, nextActionTime: null
              }
            });
          }
          break;
        }

        // ---- Start Bot (per-server) ----
        case 'START_BOT': {
          if (!serverKey) {
            sendResponse({ success: false, error: 'No serverKey provided' });
            break;
          }
          var startInst = manager.getOrCreate(serverKey);

          if (startInst.engine.running && !startInst.engine.paused) {
            sendResponse({ success: false, error: 'Bot is already running for ' + serverKey });
            break;
          }

          // Find the tab for this server
          var startTab = null;
          if (startInst.tabId) {
            startTab = await chrome.tabs.get(startInst.tabId).catch(function () { return null; });
          }
          if (!startTab) {
            // Search all Travian tabs for one matching this server
            var allTabs = await findAllTravianTabs();
            for (var t = 0; t < allTabs.length; t++) {
              var tabKey = self.TravianStorage.extractServerKey(allTabs[t].url);
              if (tabKey === serverKey) {
                startTab = allTabs[t];
                break;
              }
            }
          }
          if (!startTab) {
            sendResponse({ success: false, error: 'No tab found for server ' + serverKey + '. Open it first.' });
            break;
          }

          startInst.tabId = startTab.id;
          startInst.engine.activeTabId = startTab.id;
          await startInst.engine.start(startTab.id);

          notify('Started', 'Bot running on ' + serverKey);
          sendResponse({ success: true, data: startInst.engine.getStatus() });
          break;
        }

        // ---- Stop Bot (per-server) ----
        case 'STOP_BOT': {
          var stopInst = resolveInstance(message, sender);
          if (stopInst && stopInst.engine.running) {
            stopInst.engine.stop();
            notify('Stopped', 'Bot stopped on ' + stopInst.serverKey);
          }
          sendResponse({ success: true, data: stopInst ? stopInst.engine.getStatus() : null });
          break;
        }

        // ---- Pause / Resume (per-server) ----
        case 'PAUSE_BOT': {
          var pauseInst = resolveInstance(message, sender);
          if (pauseInst) {
            if (pauseInst.engine.paused) {
              pauseInst.engine.resume();
              sendResponse({ success: true, data: { paused: false } });
            } else {
              pauseInst.engine.pause();
              sendResponse({ success: true, data: { paused: true } });
            }
          } else {
            sendResponse({ success: false, error: 'No bot instance found' });
          }
          break;
        }

        // ---- Emergency Stop (per-server) ----
        case 'EMERGENCY_STOP': {
          var emergInst = resolveInstance(message, sender);
          var reason = (data && data.reason) || 'User triggered emergency stop';
          if (emergInst) {
            emergInst.engine.emergencyStop(reason);
            notify('EMERGENCY STOP', reason + ' (' + emergInst.serverKey + ')');
            sendResponse({ success: true, data: emergInst.engine.getStatus() });
          } else {
            // Stop all as safety fallback
            manager.stopAll();
            sendResponse({ success: true });
          }
          break;
        }

        // ---- Save Config (per-server) ----
        case 'SAVE_CONFIG': {
          var configData = msgConfig || data;
          if (!configData) {
            sendResponse({ success: false, error: 'No config data provided' });
            break;
          }
          if (serverKey) {
            await self.TravianStorage.saveServerConfig(serverKey, configData);
            var cfgInst = manager.get(serverKey);
            if (cfgInst) cfgInst.engine.config = configData;
          } else {
            // Legacy fallback
            await self.TravianStorage.set('bot_config', configData);
          }
          logger.info('Config saved' + (serverKey ? ' for ' + serverKey : ''));
          sendResponse({ success: true });
          break;
        }

        // ---- Logs ----
        case 'GET_LOGS': {
          var logs = self.TravianLogger.getLogs ? self.TravianLogger.getLogs() : [];
          sendResponse({ success: true, data: logs });
          break;
        }

        // ---- Task Queue (per-server) ----
        case 'GET_QUEUE': {
          var qInst = resolveInstance(message, sender);
          var queue = (qInst && qInst.engine.taskQueue) ? qInst.engine.taskQueue.getAll() : [];
          sendResponse({ success: true, data: queue });
          break;
        }

        case 'CLEAR_QUEUE': {
          var cqInst = resolveInstance(message, sender);
          if (cqInst && cqInst.engine.taskQueue) cqInst.engine.taskQueue.clear();
          sendResponse({ success: true });
          break;
        }

        // ---- Strategy Analysis (per-server) ----
        case 'GET_STRATEGY': {
          var strInst = resolveInstance(message, sender);
          var analysis = (strInst && strInst.engine.decisionEngine) ? strInst.engine.decisionEngine.getLastAnalysis() : null;
          var phase = (strInst && strInst.engine.decisionEngine) ? strInst.engine.decisionEngine.getPhase() : 'unknown';
          sendResponse({ success: true, data: { analysis: analysis, phase: phase } });
          break;
        }

        // ---- Scan Result (from content script) ----
        case 'SCAN_RESULT': {
          var scanInst = resolveInstance(message, sender);
          if (scanInst && data && typeof scanInst.engine.updateGameState === 'function') {
            scanInst.engine.updateGameState(data);
            logger.debug('Game state updated for ' + scanInst.serverKey);
          }
          sendResponse({ success: true });
          break;
        }

        // ---- Request Scan (from popup) ----
        case 'REQUEST_SCAN': {
          var rsInst = null;
          var scanTabId = null;

          if (serverKey) {
            rsInst = manager.get(serverKey);
            if (rsInst && rsInst.tabId) {
              var rsTab = await chrome.tabs.get(rsInst.tabId).catch(function () { return null; });
              if (rsTab) scanTabId = rsTab.id;
            }
            if (!scanTabId) {
              // Find tab for this server
              var rsTabs = await findAllTravianTabs();
              for (var ri = 0; ri < rsTabs.length; ri++) {
                if (self.TravianStorage.extractServerKey(rsTabs[ri].url) === serverKey) {
                  scanTabId = rsTabs[ri].id;
                  break;
                }
              }
            }
          }

          if (!scanTabId) {
            // Fallback: find any Travian tab
            var anyTab = await findTravianTab();
            if (anyTab) scanTabId = anyTab.id;
          }

          if (!scanTabId) {
            sendResponse({ success: false, error: 'No Travian tab found' });
            break;
          }

          // Helper: send SCAN to content script with retries
          async function doScan(tabId, retries) {
            retries = retries || 3;
            for (var i = 0; i < retries; i++) {
              try {
                var resp = await new Promise(function (resolve, reject) {
                  chrome.tabs.sendMessage(tabId, { type: 'SCAN' }, function (r) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(r);
                  });
                });
                if (resp) return resp;
              } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(function (r) { setTimeout(r, 800); });
              }
            }
          }

          // Helper: navigate tab and wait for page load
          function navigateAndWait(tabId, url, timeoutMs) {
            return new Promise(function (resolve, reject) {
              var timeout = setTimeout(function () {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('Navigation timeout'));
              }, timeoutMs || 10000);

              function listener(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  clearTimeout(timeout);
                  setTimeout(function () { resolve(); }, 500);
                }
              }
              chrome.tabs.onUpdated.addListener(listener);
              chrome.tabs.update(tabId, { url: url });
            });
          }

          try {
            var scanTabInfo = await chrome.tabs.get(scanTabId);
            var tabUrl = scanTabInfo.url || '';
            var baseUrl = tabUrl.replace(/\/[^\/]*$/, '');
            var merged = {
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
            var dorf1Url = baseUrl + '/dorf1.php';
            if (tabUrl.indexOf('dorf1.php') === -1) {
              await navigateAndWait(scanTabId, dorf1Url, 10000);
            }
            var scan1 = await doScan(scanTabId);
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
            var dorf2Url = baseUrl + '/dorf2.php';
            await navigateAndWait(scanTabId, dorf2Url, 10000);
            var scan2 = await doScan(scanTabId);
            if (scan2 && scan2.success && scan2.data) {
              merged.buildings = scan2.data.buildings || [];
              if (scan2.data.constructionQueue && scan2.data.constructionQueue.count > 0) {
                merged.constructionQueue = scan2.data.constructionQueue;
              }
            }

            // Update the correct instance's game state
            if (rsInst) {
              rsInst.engine.gameState = merged;
            } else {
              var scanKey = self.TravianStorage.extractServerKey(tabUrl);
              if (scanKey) {
                var scanInstNew = manager.getOrCreate(scanKey);
                scanInstNew.tabId = scanTabId;
                scanInstNew.engine.activeTabId = scanTabId;
                scanInstNew.engine.gameState = merged;
              }
            }
            sendResponse({ success: true, data: merged });
          } catch (scanErr) {
            sendResponse({ success: false, error: scanErr.message });
          }
          break;
        }

        // ---- Content Script Ready ----
        case 'CONTENT_READY': {
          if (sender && sender.tab) {
            var readyKey = self.TravianStorage.extractServerKey(sender.tab.url);
            if (readyKey) {
              var readyInst = manager.getOrCreate(readyKey);
              readyInst.tabId = sender.tab.id;
              readyInst.engine.activeTabId = sender.tab.id;
              logger.info('Content script ready on tab ' + sender.tab.id + ' (' + readyKey + ')');
            }
          }
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type: ' + type });
      }
    } catch (err) {
      logger.error(LOG_TAG + ' onMessage error:', err);
      sendResponse({ success: false, error: err.message || String(err) });
    }
  })();

  // CRITICAL: return true to keep sendResponse channel open for async work.
  return true;
});

// ---------------------------------------------------------------------------
// 7. Tab Listeners — multi-instance aware
// ---------------------------------------------------------------------------

// Detect when a Travian page finishes loading
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;

  var serverKey = self.TravianStorage.extractServerKey(tab.url);
  if (!serverKey) return;

  // Only track Travian domains
  if (!/travian\.(com|de|co\.uk|us|net|cl|com\.br|co\.id|asia)/i.test(tab.url)) return;

  var inst = manager.getOrCreate(serverKey);

  // Warn if same server opens in a different tab
  if (inst.tabId && inst.tabId !== tabId) {
    logger.warn('Server ' + serverKey + ' moved from tab ' + inst.tabId + ' to ' + tabId);
  }

  inst.tabId = tabId;
  inst.engine.activeTabId = tabId;
  logger.debug('Travian tab updated: ' + tabId + ' → ' + serverKey);
});

// Stop bot only for the instance bound to the closed tab
chrome.tabs.onRemoved.addListener(function (tabId) {
  var inst = manager.getByTabId(tabId);
  if (!inst) return;

  logger.warn('Travian tab ' + tabId + ' closed (' + inst.serverKey + ')');
  inst.tabId = null;
  inst.engine.activeTabId = null;

  if (inst.engine.running) {
    inst.engine.stop();
    notify('Tab Closed', 'Tab closed for ' + inst.serverKey + '. Bot stopped.');
  }
});

// ---------------------------------------------------------------------------
// 8. Alarm System — per-server heartbeats
// ---------------------------------------------------------------------------
chrome.alarms.onAlarm.addListener(async function (alarm) {
  // Per-server heartbeat: "botHeartbeat__ts5.x1.asia.travian.com"
  if (alarm.name.indexOf('botHeartbeat') === 0) {
    var heartbeatKey = alarm.name.replace('botHeartbeat__', '');
    var inst = heartbeatKey ? manager.get(heartbeatKey) : null;

    // Legacy alarm without server key — try first running instance
    if (!inst && alarm.name === 'botHeartbeat') {
      var allInstances = manager.listActive();
      for (var i = 0; i < allInstances.length; i++) {
        if (allInstances[i].running) {
          inst = manager.get(allInstances[i].serverKey);
          break;
        }
      }
    }

    if (!inst) return;

    logger.debug('Heartbeat for ' + inst.serverKey);

    if (inst.engine.running && !inst.engine.paused) {
      // Verify tab still exists
      if (inst.tabId) {
        try {
          await chrome.tabs.get(inst.tabId);
        } catch (_) {
          logger.warn('Tab lost for ' + inst.serverKey + ' during heartbeat');
          inst.tabId = null;
          inst.engine.activeTabId = null;
          inst.engine.stop();
          notify('Tab Lost', 'Tab disappeared for ' + inst.serverKey + '. Bot stopped.');
          return;
        }
      }

      // Poke the engine
      if (typeof inst.engine.heartbeat === 'function') {
        try {
          await inst.engine.heartbeat();
        } catch (err) {
          logger.error('Heartbeat error for ' + inst.serverKey + ':', err);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Installation Handler — set default config
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async function (details) {
  logger.info('Extension installed/updated (reason: ' + details.reason + ')');

  // Run migration
  try {
    var tab = await findTravianTab();
    var detectedKey = tab && tab.url ? self.TravianStorage.extractServerKey(tab.url) : null;
    await self.TravianStorage.migrateIfNeeded(detectedKey);
  } catch (migErr) {
    logger.warn('Migration error:', migErr.message);
  }

  if (details.reason === 'install') {
    var defaultConfig = {
      delayMin: 2000, delayMax: 8000,
      idleMin: 30000, idleMax: 120000,
      maxActionsPerHour: 60, captchaAutoStop: true,
      errorAutoStop: true, maxRetries: 3,
      autoBuild: true, autoAdventure: true,
      autoFarm: false, autoTrade: false,
      notificationsEnabled: true, darkMode: true,
      firstRun: true
    };
    // Write to correct key
    await self.TravianStorage.set('bot_config', defaultConfig);
    logger.info('Default config written to storage');
  }
});

// ---------------------------------------------------------------------------
// 10. Startup — restore state (per-server)
// ---------------------------------------------------------------------------
(async function init() {
  logger.info(LOG_TAG + ' Service worker started');

  // Run migration if needed
  try {
    var tab = await findTravianTab();
    var detectedKey = tab && tab.url ? self.TravianStorage.extractServerKey(tab.url) : null;
    await self.TravianStorage.migrateIfNeeded(detectedKey);
  } catch (migErr) {
    logger.warn('Migration during init:', migErr.message);
  }

  // Find all Travian tabs and create instances
  try {
    var travianTabs = await findAllTravianTabs();
    var registry = await self.TravianStorage.getServerRegistry();

    for (var i = 0; i < travianTabs.length; i++) {
      var serverKey = self.TravianStorage.extractServerKey(travianTabs[i].url);
      if (!serverKey) continue;

      var inst = manager.getOrCreate(serverKey);
      inst.tabId = travianTabs[i].id;
      inst.engine.activeTabId = travianTabs[i].id;

      // Check if bot was running for this server
      var savedState = await self.TravianStorage.getServerState(serverKey);
      if (savedState && savedState.wasRunning) {
        logger.info('Bot was running on ' + serverKey + ' before restart — setting up heartbeat');
        chrome.alarms.create('botHeartbeat__' + serverKey, { periodInMinutes: 1 });
      }
    }

    // Also check legacy state key for backward compat
    var legacyState = await self.TravianStorage.get('bot_state');
    if (legacyState && legacyState.wasRunning && travianTabs.length > 0) {
      var legacyKey = self.TravianStorage.extractServerKey(travianTabs[0].url);
      if (legacyKey) {
        logger.info('Legacy state recovery for ' + legacyKey);
        chrome.alarms.create('botHeartbeat__' + legacyKey, { periodInMinutes: 1 });
      }
    }
  } catch (err) {
    logger.warn('State recovery failed:', err.message);
  }
})();

logger.info(LOG_TAG + ' Service worker script loaded');
