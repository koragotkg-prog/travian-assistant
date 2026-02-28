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
  '../strategy/globalPlanner.js',   // TravianGlobalPlanner — strategic phase/mode/plan layer
  '../core/actionScorer.js',     // TravianActionScorer
  '../core/decisionEngine.js',
  '../core/gameStateCollector.js', // TravianGameStateCollector
  '../core/mapScanner.js',
  '../core/farmIntelligence.js',  // Farm stack: intelligence layer
  '../core/farmScheduler.js',     // Farm stack: timing/priority layer
  '../core/farmManager.js',       // Farm stack: orchestration FSM
  '../core/contentScriptBridge.js', // ContentScriptBridge — messaging, retry, adaptive timeout
  '../core/navigationManager.js',  // NavigationManager — dorf2 scan/cache, navigateAndWait
  '../core/heroManager.js',        // HeroManager — hero resource claiming, deficit calculation
  '../core/taskHandlers.js',      // Task handler registry (extracted from BotEngine.executeTask)
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
// 5b. Oasis animal checker — uses tile-details API
// ---------------------------------------------------------------------------

/**
 * Check if an oasis has nature troops (animals) by calling the tile-details API.
 * Returns { hasAnimals: boolean, troops: [{unit, count}] }
 *
 * Uses POST /api/v1/map/tile-details with session cookies.
 * The response HTML contains #troop_info table with .unit.u31-.u40 for nature troops.
 *
 * @param {string} serverOrigin - e.g. "https://ts4.x1.asia.travian.com"
 * @param {number} x - tile X coordinate
 * @param {number} y - tile Y coordinate
 * @param {string} cookieHeader - pre-built "name=val; name2=val2" cookie string
 * @returns {Promise<{hasAnimals:boolean, troops:Array}>}
 */
async function checkOasisAnimals(serverOrigin, x, y, cookieHeader) {
  try {
    var resp = await fetch(serverOrigin + '/api/v1/map/tile-details', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader
      },
      body: JSON.stringify({ x: x, y: y })
    });

    if (!resp.ok) {
      logger.warn('[OasisCheck] HTTP ' + resp.status + ' for (' + x + '|' + y + ')');
      return { hasAnimals: true, troops: [] }; // assume dangerous on error
    }

    var json = await resp.json();
    var html = json.html || '';

    // Parse HTML for nature troop units (u31-u40)
    // Pattern: class="unit u31" ... followed by count in the same row
    var troopRegex = /class="unit u(3[0-9]|40)"/g;
    var match;
    var troops = [];
    while ((match = troopRegex.exec(html)) !== null) {
      troops.push({ unit: parseInt(match[1], 10) });
    }

    return { hasAnimals: troops.length > 0, troops: troops };
  } catch (err) {
    logger.warn('[OasisCheck] Error checking (' + x + '|' + y + '): ' + err.message);
    return { hasAnimals: true, troops: [] }; // assume dangerous on error
  }
}

/**
 * Build Cookie header string for a Travian server hostname.
 * Requires "cookies" permission in manifest.json.
 * @param {string} hostname - e.g. "ts4.x1.asia.travian.com"
 * @returns {Promise<string>} Cookie header value
 */
async function buildCookieHeader(hostname) {
  var cookies = await chrome.cookies.getAll({ domain: hostname });
  return cookies.map(function (c) { return c.name + '=' + c.value; }).join('; ');
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
          // Send registry.servers (the actual server map), not the full registry wrapper
          var serverMap = (registry && registry.servers) ? registry.servers : {};
          sendResponse({ success: true, data: { instances: servers, registry: serverMap } });
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
            // No instance for this server yet — load saved config from storage
            var savedConfig = null;
            if (serverKey) {
              try {
                savedConfig = await self.TravianStorage.getServerConfig(serverKey);
              } catch (e) { console.warn(LOG_TAG, 'Failed to load config for idle status:', e); }
            }
            sendResponse({
              success: true,
              data: {
                running: false, paused: false, emergencyStopped: false,
                activeTabId: null, serverKey: serverKey,
                stats: { tasksCompleted: 0, tasksFailed: 0, startTime: null, lastAction: null, farmRaidsSent: 0 },
                actionsThisHour: 0, taskQueue: { total: 0, pending: 0, tasks: [] },
                gameState: null, config: savedConfig, nextActionTime: null
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
            await emergInst.engine.emergencyStop(reason);
            notify('EMERGENCY STOP', reason + ' (' + emergInst.serverKey + ')');
            sendResponse({ success: true, data: emergInst.engine.getStatus() });
          } else {
            // Stop all as safety fallback
            await manager.stopAll();
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

        case 'ADD_TASK': {
          var atInst = resolveInstance(message, sender);
          if (atInst && atInst.engine.taskQueue) {
            var tType = message.taskType || (data && data.taskType);
            var tParams = message.params || (data && data.params) || {};
            var tPrio = message.priority || (data && data.priority) || 5;
            var tVid = message.villageId || (data && data.villageId) || null;
            
            if (tType) {
              var newId = atInst.engine.taskQueue.add(tType, tParams, tPrio, tVid);
              sendResponse({ success: true, data: { taskId: newId } });
            } else {
              sendResponse({ success: false, error: 'Missing taskType' });
            }
          } else {
            sendResponse({ success: false, error: 'No instance found' });
          }
          break;
        }

        case 'REMOVE_TASK': {
          var rtInst = resolveInstance(message, sender);
          var rTaskId = message.taskId || (data && data.taskId);
          if (rtInst && rtInst.engine.taskQueue && rTaskId) {
            var removed = rtInst.engine.taskQueue.remove(rTaskId);
            sendResponse({ success: removed });
          } else {
            sendResponse({ success: false, error: 'No instance or taskId' });
          }
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
          var plannerState = (strInst && strInst.engine.decisionEngine) ? strInst.engine.decisionEngine.getPlannerState() : null;
          sendResponse({ success: true, data: { analysis: analysis, phase: phase, planner: plannerState } });
          break;
        }

        // ---- Farm Intelligence (per-server) ----
        case 'GET_FARM_INTEL': {
          var fiInst = resolveInstance(message, sender);
          var intel = fiInst && fiInst.engine._farmIntelligence;
          if (!intel) {
            sendResponse({ success: true, data: {
              stats: { targetCount: 0, active: 0, paused: 0, blacklisted: 0, globalStats: { totalRaids: 0, totalLoot: { wood: 0, clay: 0, iron: 0, crop: 0 }, totalTroopLosses: 0 } },
              profit: { loot: { wood: 0, clay: 0, iron: 0, crop: 0 }, raids: 0, losses: 0 },
              targets: []
            }});
            break;
          }
          var fiStats = intel.getStats();
          var fiProfit = intel.getProfitReport(86400000);
          // Get ALL targets (active + paused + blacklisted), sorted by score desc
          var fiKeys = Object.keys(intel._targets || {});
          var fiAll = fiKeys.map(function(k) { return intel._targets[k]; });
          fiAll.sort(function(a, b) { return (b.score || 0) - (a.score || 0); });
          var fiSlim = fiAll.map(function(t) {
            return {
              coordKey: t.coordKey, coords: t.coords, name: t.name,
              status: t.status, score: t.score, distance: t.distance,
              population: t.population, pauseReason: t.pauseReason,
              metrics: t.metrics
            };
          });
          sendResponse({ success: true, data: { stats: fiStats, profit: fiProfit, targets: fiSlim } });
          break;
        }

        // ---- Scan Result (legacy placeholder — scan data handled internally by BotEngine._cycle) ----
        case 'SCAN_RESULT': {
          // No-op: content scripts never send SCAN_RESULT; BotEngine processes scan responses
          // directly during its cycle. Kept as a safe no-op for forward compatibility.
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

        // ---- Farm list API call (delegated from content script) ----
        case 'FARM_LIST_API_CALL': {
          var apiOrigin = message.serverOrigin;
          var apiOpts = message.opts || {};
          if (!apiOrigin || !apiOpts.listId) {
            sendResponse({ ok: false, error: 'Missing serverOrigin or listId' });
            break;
          }

          try {
            // Read session cookies for the Travian server
            var url = new URL(apiOrigin);
            var cookieHeader = await buildCookieHeader(url.hostname);

            var apiUrl = apiOrigin + '/api/v1/farm-list/slot';
            var apiBody = JSON.stringify({
              slots: [{
                listId: apiOpts.listId,
                x: apiOpts.x,
                y: apiOpts.y,
                units: apiOpts.units || {},
                active: true,
                abandoned: false
              }]
            });

            var apiResp = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*',
                'X-Version': apiOpts.gameVersion || '347.6',
                'X-Requested-With': 'XMLHttpRequest',
                'Cookie': cookieHeader
              },
              body: apiBody
            });

            if (apiResp.ok) {
              sendResponse({ ok: true });
            } else {
              var errBody = null;
              try { errBody = await apiResp.json(); } catch (e) { /* ignore */ }
              sendResponse({ ok: false, error: (errBody && errBody.error) || 'HTTP ' + apiResp.status });
            }
          } catch (apiErr) {
            logger.warn('[FARM_LIST_API_CALL] Error: ' + apiErr.message);
            sendResponse({ ok: false, error: apiErr.message });
          }
          break;
        }

        // ---- Switch Village (from popup) ----
        case 'SWITCH_VILLAGE': {
          var svInst = resolveInstance(message, sender);
          var villageId = message.villageId || (data && data.villageId);
          if (svInst && villageId) {
            // Update config with active village
            if (svInst.engine.config) {
              svInst.engine.config.activeVillage = villageId;
            }
            // Save to storage
            if (serverKey) {
              var svCfg = await self.TravianStorage.getServerConfig(serverKey);
              if (svCfg) {
                svCfg.activeVillage = villageId;
                await self.TravianStorage.saveServerConfig(serverKey, svCfg);
              }
            }
            logger.info('Village switched to ' + villageId + ' for ' + (serverKey || 'unknown'));
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'No instance or villageId' });
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

        // ---- Scan map.sql for farm targets ----
        case 'SCAN_FARM_TARGETS': {
          var scanFarmInst = resolveInstance(message, sender) || (serverKey ? manager.getOrCreate(serverKey) : null);
          if (!scanFarmInst) {
            sendResponse({ success: false, error: 'No bot instance found' });
            break;
          }

          var gs = scanFarmInst.engine.gameState;
          var cfg = scanFarmInst.engine.config;
          var farmScanCfg = (cfg && cfg.farmConfig) || {};

          // Get player village coordinates — prefer manual config, fallback to gameState
          var myVillage = null;
          if (farmScanCfg.scanMyX != null && farmScanCfg.scanMyY != null) {
            // Manual coordinates from config — most reliable for multi-server
            myVillage = { x: farmScanCfg.scanMyX, y: farmScanCfg.scanMyY };
            logger.info('[MapScanner] Using manual coordinates (' + myVillage.x + '|' + myVillage.y + ')');
          } else if (gs && gs.villages && gs.villages.length > 0) {
            // Fallback: auto-detected from gameState
            var activeVid = cfg && cfg.activeVillage;
            if (activeVid) {
              myVillage = gs.villages.find(function(v) { return String(v.id) === String(activeVid); });
            }
            if (!myVillage) myVillage = gs.villages[0];
            if (myVillage) {
              logger.info('[MapScanner] Using auto-detected coordinates (' + myVillage.x + '|' + myVillage.y + ')');
            }
          }

          if (!myVillage || myVillage.x == null || myVillage.y == null) {
            sendResponse({ success: false, error: 'Village coordinates not set. Enter your X,Y in the Farm Scanner config and Save.' });
            break;
          }

          // Get server base URL from tab
          var farmScanTab = null;
          if (scanFarmInst.tabId) {
            farmScanTab = await chrome.tabs.get(scanFarmInst.tabId).catch(function() { return null; });
          }
          if (!farmScanTab || !farmScanTab.url) {
            sendResponse({ success: false, error: 'No active Travian tab found' });
            break;
          }

          var farmServerUrl = farmScanTab.url.match(/^https?:\/\/[^\/]+/);
          if (!farmServerUrl) {
            sendResponse({ success: false, error: 'Cannot parse server URL from tab' });
            break;
          }
          farmServerUrl = farmServerUrl[0];

          try {
            // Step 1: Scan map.sql for candidates
            logger.info('[MapScanner] Starting scan from (' + myVillage.x + '|' + myVillage.y + ') radius=' + (farmScanCfg.scanRadius || 20) + ' maxPop=' + (farmScanCfg.scanMaxPop || 50));
            var candidates = await self.TravianMapScanner.scanForTargets(farmServerUrl, {
              myX: myVillage.x,
              myY: myVillage.y,
              myUserId: myVillage.userId || gs.myUserId || 0,
              scanRadius: farmScanCfg.scanRadius || 20,
              maxPop: farmScanCfg.scanMaxPop || 50,
              includeOases: farmScanCfg.scanIncludeOases !== false,
              skipAlliance: farmScanCfg.scanSkipAlliance !== false,
              existingCoords: []
            });

            if (candidates.length === 0) {
              sendResponse({ success: true, data: { found: 0, added: 0, failed: 0, message: 'No targets found within radius' } });
              break;
            }

            // Step 1b: Filter oases with animals (if enabled)
            var emptyOasesOnly = farmScanCfg.scanEmptyOasesOnly !== false; // default true
            var oasisCandidates = candidates.filter(function(c) { return c.type === 'oasis'; });
            var villageCandidates = candidates.filter(function(c) { return c.type !== 'oasis'; });

            if (emptyOasesOnly && oasisCandidates.length > 0) {
              logger.info('[MapScanner] Checking ' + oasisCandidates.length + ' oases for animals...');
              var oasisUrl = new URL(farmServerUrl);
              var oasisCookies = await buildCookieHeader(oasisUrl.hostname);
              var emptyOases = [];
              var animalOases = 0;

              for (var oi = 0; oi < oasisCandidates.length; oi++) {
                var oasis = oasisCandidates[oi];
                var check = await checkOasisAnimals(farmServerUrl, oasis.x, oasis.y, oasisCookies);
                if (check.hasAnimals) {
                  animalOases++;
                  logger.debug('[MapScanner] Oasis (' + oasis.x + '|' + oasis.y + ') has animals — skipped');
                } else {
                  emptyOases.push(oasis);
                  logger.debug('[MapScanner] Oasis (' + oasis.x + '|' + oasis.y + ') is empty — keeping');
                }
                // Small delay between API calls to avoid rate limiting
                if (oi < oasisCandidates.length - 1) {
                  await new Promise(function(r) { setTimeout(r, 300); });
                }
              }

              logger.info('[MapScanner] Oasis check: ' + emptyOases.length + ' empty, ' + animalOases + ' with animals');
              candidates = villageCandidates.concat(emptyOases);
              // Re-sort by distance
              candidates.sort(function(a, b) { return a.distance - b.distance; });

              if (candidates.length === 0) {
                sendResponse({ success: true, data: { found: oasisCandidates.length + villageCandidates.length, added: 0, failed: 0,
                  message: 'All ' + animalOases + ' oases have animals. No valid targets.' } });
                break;
              }
            }

            // Step 2: Navigate to farm list page
            var farmTabId = scanFarmInst.tabId;
            var farmListUrl = farmServerUrl + '/build.php?id=39&tt=99';

            await new Promise(function(resolve, reject) {
              var navTimeout = setTimeout(function() {
                chrome.tabs.onUpdated.removeListener(navListener);
                reject(new Error('Navigation timeout'));
              }, 15000);
              function navListener(updatedTabId, changeInfo) {
                if (updatedTabId === farmTabId && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(navListener);
                  clearTimeout(navTimeout);
                  setTimeout(function() { resolve(); }, 1000);
                }
              }
              chrome.tabs.onUpdated.addListener(navListener);
              chrome.tabs.update(farmTabId, { url: farmListUrl });
            });

            // Step 3: Wait for content script and get existing slots
            await new Promise(function(r) { setTimeout(r, 2000); });

            var existingSlots = [];
            for (var scanRetry = 0; scanRetry < 3; scanRetry++) {
              try {
                var slotResp = await new Promise(function(resolve, reject) {
                  chrome.tabs.sendMessage(farmTabId, {
                    type: 'EXECUTE', action: 'scanFarmListSlots', params: {}
                  }, function(r) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(r);
                  });
                });
                if (slotResp && slotResp.slots) {
                  existingSlots = slotResp.slots;
                  break;
                }
              } catch (slotErr) {
                if (scanRetry === 2) logger.warn('[MapScanner] Could not scan existing slots: ' + slotErr.message);
                await new Promise(function(r) { setTimeout(r, 1500); });
              }
            }

            // Check farm list capacity (max 100 slots)
            var existingCount = existingSlots.length;
            var maxSlots = 100;
            var available = maxSlots - existingCount;

            if (available <= 0) {
              sendResponse({ success: true, data: {
                found: candidates.length, added: 0, failed: 0,
                message: 'Farm list full (' + existingCount + '/' + maxSlots + '). Found ' + candidates.length + ' targets.'
              }});
              break;
            }

            // Step 4: Add targets one by one with human-like delays
            // Build troops object from config (e.g., {t1: 5} or {t3: 10})
            var troopSlot = farmScanCfg.scanTroopSlot || 't1';
            var troopCount = farmScanCfg.scanTroopCount || 1;
            var scanTroops = {};
            scanTroops[troopSlot] = troopCount;
            logger.info('[MapScanner] Troops per target: ' + troopSlot + '=' + troopCount);

            var toAdd = candidates.slice(0, available);
            var addedCount = 0;
            var failedCount = 0;

            for (var ci = 0; ci < toAdd.length; ci++) {
              var target = toAdd[ci];
              try {
                var addResp = await new Promise(function(resolve, reject) {
                  chrome.tabs.sendMessage(farmTabId, {
                    type: 'EXECUTE', action: 'addToFarmList', params: {
                      x: target.x, y: target.y, troops: scanTroops, listIndex: 0
                    }
                  }, function(r) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(r);
                  });
                });

                if (addResp && addResp.success) {
                  addedCount++;
                } else {
                  failedCount++;
                  logger.warn('[MapScanner] Failed to add (' + target.x + '|' + target.y + '): ' + (addResp ? (addResp.error || addResp.message || JSON.stringify(addResp)) : 'no response'));
                  // If we get 'no_input' or 'button_not_found', the selectors may be wrong — stop trying
                  if (addResp && (addResp.reason === 'no_input' || addResp.reason === 'button_not_found')) {
                    logger.error('[MapScanner] Stopping: farm list add UI not found. Selectors may need updating.');
                    break;
                  }
                }
              } catch (addErr) {
                failedCount++;
                logger.warn('[MapScanner] Error adding target: ' + addErr.message);
              }

              // Human-like delay between adds (1-3 seconds)
              if (ci < toAdd.length - 1) {
                await new Promise(function(r) { setTimeout(r, 1000 + Math.random() * 2000); });
              }
            }

            var resultMsg = 'Found ' + candidates.length + ' targets, added ' + addedCount;
            if (failedCount > 0) resultMsg += ' (' + failedCount + ' failed)';
            logger.info('[MapScanner] ' + resultMsg);

            sendResponse({ success: true, data: {
              found: candidates.length,
              added: addedCount,
              failed: failedCount,
              message: resultMsg
            }});

          } catch (farmScanErr) {
            logger.error('[MapScanner] Scan error: ' + farmScanErr.message);
            sendResponse({ success: false, error: farmScanErr.message });
          }
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

  // FIX 3: Block tab reassignment whenever the bot is running — not just during execution.
  // The old guard only checked _executionLocked (true during a single task). Between tasks,
  // the flag is false and a second tab opening the same server would steal the instance,
  // causing the bot to send commands to the wrong tab on the next cycle.
  if (inst.tabId && inst.tabId !== tabId && inst.engine.running) {
    logger.warn('Tab reassignment BLOCKED for ' + serverKey + ' (tab ' + inst.tabId + ' → ' + tabId + ') — bot is running');
    return;
  }

  // TQ-8 FIX: For stopped bots, only reassign tabId if the old tab is gone.
  // Prevents accidental tab stealing when user navigates multiple Travian tabs
  // after stopping the bot (e.g., browsing S4 on tab 2 while S4 bot was on tab 1).
  if (inst.tabId && inst.tabId !== tabId && !inst.engine.running) {
    chrome.tabs.get(inst.tabId).then(function () {
      // Old tab still exists — don't steal
      logger.debug('Tab reassignment skipped for stopped ' + serverKey + ' — original tab ' + inst.tabId + ' still open');
    }).catch(function () {
      // Old tab is gone — allow reassignment
      logger.info('Server ' + serverKey + ' moved from closed tab ' + inst.tabId + ' to ' + tabId);
      inst.tabId = tabId;
      inst.engine.activeTabId = tabId;
    });
    return;
  }

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
    // Await stop() to ensure saveState() completes before SW can die
    inst.engine.stop().then(function() {
      notify('Tab Closed', 'Tab closed for ' + inst.serverKey + '. Bot stopped.');
    }).catch(function(err) {
      console.error('[SW] Error stopping bot on tab close:', err);
      notify('Tab Closed', 'Tab closed for ' + inst.serverKey + '. Bot stopped (with errors).');
    });
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

    // SAF-2 FIX: Auto-restart bot after service worker death.
    // When SW restarts, engine.running is false but savedState.wasRunning is true.
    // The old code just exited here — bot was permanently dead until user clicked Start.
    if (!inst.engine.running) {
      var savedState = await self.TravianStorage.getServerState(inst.serverKey);
      if (savedState && savedState.wasRunning && inst.tabId) {
        try {
          await chrome.tabs.get(inst.tabId);
          logger.info('Auto-restarting bot for ' + inst.serverKey + ' after SW restart');
          notify('Auto-Restart', 'Bot resuming on ' + inst.serverKey);
          await inst.engine.start(inst.tabId);
        } catch (_) {
          // Tab gone — clear zombie alarm
          logger.warn('Tab gone for ' + inst.serverKey + ' — clearing zombie alarm');
          chrome.alarms.clear(alarm.name);
        }
      } else if (!savedState || !savedState.wasRunning) {
        // Not supposed to run — clear zombie alarm
        chrome.alarms.clear(alarm.name);
      }
      return;
    }

    if (!inst.engine.paused) {
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
