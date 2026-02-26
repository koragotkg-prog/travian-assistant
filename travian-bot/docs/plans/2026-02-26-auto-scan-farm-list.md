# Auto-Scan Farm List — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-scan Travian's `/map.sql` to find inactive villages and unoccupied oases near the player, then add them to the rally point farm list.

**Architecture:** A new `core/mapScanner.js` module (service worker context) fetches and parses `/map.sql`, filters candidates by distance/population/alliance. A new `addToFarmList` action in the content script adds targets via DOM. The popup gets a "Farm Target Scanner" config section with a "Scan Now" button. A new `SCAN_FARM_TARGETS` message type wires popup → service worker → content script.

**Tech Stack:** Plain JavaScript (no dependencies), Chrome Extension Manifest V3, `importScripts()` for service worker modules.

---

## Task 1: MapScanner Module — Parse map.sql

Create the core module that fetches and parses `/map.sql` from a Travian server.

**Files:**
- Create: `travian-bot/core/mapScanner.js`

**Step 1: Create `core/mapScanner.js` with fetch + parse**

```javascript
/**
 * MapScanner - Fetches and parses /map.sql to find farm targets.
 * Runs in service worker context (no DOM, no window).
 * Exported via self.TravianMapScanner
 */
(function () {
  'use strict';

  var Logger = typeof TravianLogger !== 'undefined' ? TravianLogger : {
    log: function () { console.log.apply(console, arguments); },
    info: function () { console.log.apply(console, arguments); },
    warn: function () { console.warn.apply(console, arguments); },
    error: function () { console.error.apply(console, arguments); }
  };

  /**
   * Parse a map.sql string into an array of tile objects.
   * Each INSERT line: VALUES (tileId, x, y, tribe, playerId, villageName, userId, playerName, allianceId, allianceName, population, NULL, isCapital, NULL, NULL, NULL);
   *
   * @param {string} sqlText - Raw SQL text from /map.sql
   * @returns {Array<{tileId:number, x:number, y:number, tribe:number, playerId:number, villageName:string, userId:number, playerName:string, allianceId:number, allianceName:string, population:number, isCapital:number}>}
   */
  function parseSql(sqlText) {
    var tiles = [];
    // Match each VALUES(...) tuple. The regex captures everything inside parens.
    var regex = /VALUES\s*\(([^)]+)\)/gi;
    var match;
    while ((match = regex.exec(sqlText)) !== null) {
      var raw = match[1];
      // Split by comma, but respect quoted strings
      var fields = [];
      var current = '';
      var inQuote = false;
      for (var i = 0; i < raw.length; i++) {
        var ch = raw[i];
        if (ch === "'" && (i === 0 || raw[i - 1] !== '\\')) {
          inQuote = !inQuote;
          current += ch;
        } else if (ch === ',' && !inQuote) {
          fields.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
      if (current.trim()) fields.push(current.trim());

      // Need at least 13 fields
      if (fields.length < 13) continue;

      // Strip quotes from string fields
      function stripQuotes(s) {
        if (s && s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
          return s.slice(1, -1).replace(/\\'/g, "'");
        }
        return s || '';
      }

      tiles.push({
        tileId: parseInt(fields[0], 10) || 0,
        x: parseInt(fields[1], 10) || 0,
        y: parseInt(fields[2], 10) || 0,
        tribe: parseInt(fields[3], 10) || 0,
        playerId: parseInt(fields[4], 10) || 0,
        villageName: stripQuotes(fields[5]),
        userId: parseInt(fields[6], 10) || 0,
        playerName: stripQuotes(fields[7]),
        allianceId: parseInt(fields[8], 10) || 0,
        allianceName: stripQuotes(fields[9]),
        population: parseInt(fields[10], 10) || 0,
        isCapital: parseInt(fields[12], 10) || 0
      });
    }
    return tiles;
  }

  /**
   * Calculate Euclidean distance between two coordinates.
   */
  function distance(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Fetch /map.sql from a Travian server and parse it.
   *
   * @param {string} serverUrl - Base URL like "https://ts5.x1.asia.travian.com"
   * @returns {Promise<Array>} Parsed tile array
   */
  async function fetchAndParse(serverUrl) {
    // Ensure URL ends without trailing slash
    var baseUrl = serverUrl.replace(/\/+$/, '');
    var mapUrl = baseUrl + '/map.sql';

    Logger.log('INFO', '[MapScanner] Fetching ' + mapUrl);
    var response = await fetch(mapUrl);
    if (!response.ok) {
      throw new Error('map.sql fetch failed: ' + response.status);
    }
    var sqlText = await response.text();
    Logger.log('INFO', '[MapScanner] Fetched map.sql: ' + Math.round(sqlText.length / 1024) + 'KB');

    var tiles = parseSql(sqlText);
    Logger.log('INFO', '[MapScanner] Parsed ' + tiles.length + ' tiles');
    return tiles;
  }

  /**
   * Scan for farm targets near a village.
   *
   * @param {string} serverUrl - Base server URL
   * @param {object} options
   * @param {number} options.myX - Player village X coordinate
   * @param {number} options.myY - Player village Y coordinate
   * @param {number} options.myUserId - Player's userId (to skip own villages)
   * @param {number} [options.scanRadius=10] - Max tile distance
   * @param {number} [options.maxPop=50] - Max population to include
   * @param {boolean} [options.includeOases=true] - Include unoccupied oases
   * @param {boolean} [options.skipAlliance=true] - Skip players in alliances
   * @param {Array} [options.existingCoords=[]] - Array of {x,y} already in farm list
   * @returns {Promise<Array<{x,y,villageName,playerName,population,distance,tribe,type}>>}
   */
  async function scanForTargets(serverUrl, options) {
    var tiles = await fetchAndParse(serverUrl);

    var myX = options.myX;
    var myY = options.myY;
    var myUserId = options.myUserId || 0;
    var scanRadius = options.scanRadius || 10;
    var maxPop = options.maxPop || 50;
    var includeOases = options.includeOases !== false;
    var skipAlliance = options.skipAlliance !== false;

    // Build a Set of existing coordinates for O(1) lookup
    var existingSet = {};
    if (options.existingCoords && options.existingCoords.length > 0) {
      for (var e = 0; e < options.existingCoords.length; e++) {
        existingSet[options.existingCoords[e].x + ',' + options.existingCoords[e].y] = true;
      }
    }

    var candidates = [];

    for (var i = 0; i < tiles.length; i++) {
      var t = tiles[i];

      // Skip own villages
      if (t.userId === myUserId && myUserId > 0) continue;

      // Calculate distance
      var dist = distance(myX, myY, t.x, t.y);
      if (dist > scanRadius) continue;

      // Skip if already in farm list
      if (existingSet[t.x + ',' + t.y]) continue;

      // Categorize the tile
      var type = null;

      // Unoccupied oasis: tribe=4 (Nature), population=0
      if (t.tribe === 4 && t.population === 0) {
        if (includeOases) {
          type = 'oasis';
        } else {
          continue;
        }
      }
      // Inactive village: has population > 0, pop <= maxPop
      else if (t.population > 0 && t.population <= maxPop) {
        // Skip players with alliance if configured
        if (skipAlliance && t.allianceId > 0) continue;
        // Skip Natar (tribe 5) — they defend
        if (t.tribe === 5) continue;
        type = 'village';
      }
      else {
        // Empty tile (pop=0, not nature) or too big — skip
        continue;
      }

      candidates.push({
        x: t.x,
        y: t.y,
        villageName: t.villageName,
        playerName: t.playerName,
        population: t.population,
        distance: Math.round(dist * 10) / 10,
        tribe: t.tribe,
        allianceId: t.allianceId,
        allianceName: t.allianceName,
        type: type
      });
    }

    // Sort by distance (nearest first)
    candidates.sort(function (a, b) { return a.distance - b.distance; });

    Logger.log('INFO', '[MapScanner] Found ' + candidates.length + ' candidates within radius ' + scanRadius);
    return candidates;
  }

  // Export
  var MapScanner = {
    parseSql: parseSql,
    fetchAndParse: fetchAndParse,
    scanForTargets: scanForTargets,
    distance: distance
  };

  if (typeof self !== 'undefined') self.TravianMapScanner = MapScanner;
  if (typeof window !== 'undefined') window.TravianMapScanner = MapScanner;
})();
```

**Step 2: Commit**

```bash
git add travian-bot/core/mapScanner.js
git commit -m "feat: add MapScanner module — fetch and parse map.sql for farm targets"
```

---

## Task 2: Register MapScanner in Service Worker

Add the new module to the service worker's `importScripts()` so it's available in the bot engine context.

**Files:**
- Modify: `travian-bot/background/service-worker.js:14-29`

**Step 1: Add `mapScanner.js` to importScripts**

In `service-worker.js`, add `'../core/mapScanner.js'` to the `importScripts()` call. Place it after `gameStateCollector.js` and before `botEngine.js`:

```javascript
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
  '../core/actionScorer.js',
  '../core/decisionEngine.js',
  '../core/gameStateCollector.js',
  '../core/mapScanner.js',           // <-- ADD THIS LINE
  '../core/botEngine.js',
  '../core/instanceManager.js'
);
```

**Step 2: Commit**

```bash
git add travian-bot/background/service-worker.js
git commit -m "feat: register MapScanner in service worker importScripts"
```

---

## Task 3: Add `addToFarmList` Action in Content Script

Add a content script action that adds a target to a farm list by navigating to a coordinate on the map and clicking "add to farm list".

**Files:**
- Modify: `travian-bot/content/actionExecutor.js`

**Step 1: Add `addToFarmList` function**

Add this function inside the actionExecutor IIFE, after the existing `selectiveFarmSend` function. The function:
1. Finds the farm list form on the rally point farm list page
2. Fills in coordinates and submits

The approach: On the farm list page (tt=99), Travian has an "add to list" form. Find the coordinate inputs, fill x/y, and click add.

```javascript
  /**
   * Add a target to a farm list by coordinates.
   * Must be called while on the rally point farm list page (tt=99).
   *
   * Strategy: Find the add-to-list input row at the bottom of a farm list,
   * fill in x/y coordinates, and click the add button.
   *
   * @param {object} params
   * @param {number} params.x - Target X coordinate
   * @param {number} params.y - Target Y coordinate
   * @param {number} [params.listIndex=0] - Which farm list to add to (0-based)
   * @returns {Promise<{success:boolean, message:string}>}
   */
  async function addToFarmList(params) {
    var x = params.x;
    var y = params.y;
    var listIndex = params.listIndex || 0;

    Logger.log('Adding to farm list: (' + x + '|' + y + ') list=' + listIndex);

    // Find all farm list wrappers
    var lists = qsa('.farmListWrapper');
    if (lists.length === 0) {
      return { success: false, reason: 'no_farm_list', message: 'No farm list found on page' };
    }

    var targetList = lists[listIndex] || lists[0];

    // Look for the coordinate input fields in the add row
    // Travian farm list has inputs: input[name="x"] and input[name="y"] or similar
    var xInput = trySelectors([
      'input[name="x"]',
      'input.coordinateX',
      '.addSlot input[name="x"]',
      '.farmListAdd input[name="x"]'
    ], targetList) || trySelectors([
      'input[name="x"]',
      'input.coordinateX',
      '.addSlot input[name="x"]'
    ]);

    var yInput = trySelectors([
      'input[name="y"]',
      'input.coordinateY',
      '.addSlot input[name="y"]',
      '.farmListAdd input[name="y"]'
    ], targetList) || trySelectors([
      'input[name="y"]',
      'input.coordinateY',
      '.addSlot input[name="y"]'
    ]);

    if (!xInput || !yInput) {
      return { success: false, reason: 'no_input', message: 'Cannot find coordinate inputs on farm list page' };
    }

    // Fill in coordinates
    xInput.value = String(x);
    xInput.dispatchEvent(new Event('input', { bubbles: true }));
    xInput.dispatchEvent(new Event('change', { bubbles: true }));
    await humanDelay(100, 250);

    yInput.value = String(y);
    yInput.dispatchEvent(new Event('input', { bubbles: true }));
    yInput.dispatchEvent(new Event('change', { bubbles: true }));
    await humanDelay(100, 250);

    // Find and click the add button
    var addBtn = trySelectors([
      '.addSlot button',
      '.farmListAdd button',
      'button.addSlot',
      '.farmListWrapper button.green:not(.startFarmList)',
      'button[type="submit"]'
    ], targetList) || trySelectors([
      '.addSlot button',
      'button.addSlot'
    ]);

    if (!addBtn) {
      return { success: false, reason: 'button_not_found', message: 'Cannot find add button on farm list' };
    }

    await simulateHumanClick(addBtn);
    Logger.log('Added target (' + x + '|' + y + ') to farm list');

    return { success: true, message: 'Added (' + x + '|' + y + ') to farm list' };
  }
```

**Step 2: Register the action in the dispatch switch**

In the `EXECUTE` message handler switch statement (around line 1838), add a new case:

```javascript
            case 'addToFarmList':
              actionResult = await addToFarmList(params);
              break;
```

**Step 3: Commit**

```bash
git add travian-bot/content/actionExecutor.js
git commit -m "feat: add addToFarmList action in content script"
```

---

## Task 4: Add `SCAN_FARM_TARGETS` Message Handler in Service Worker

Wire the full flow: popup → service worker → MapScanner → content script (add targets).

**Files:**
- Modify: `travian-bot/background/service-worker.js:128-484` (message handler switch)

**Step 1: Add `SCAN_FARM_TARGETS` case**

Add this case inside the `switch (type)` block, before the `default:` case (around line 472):

```javascript
        // ---- Scan map.sql for farm targets ----
        case 'SCAN_FARM_TARGETS': {
          var scanFarmInst = resolveInstance(message, sender) || (serverKey ? manager.getOrCreate(serverKey) : null);
          if (!scanFarmInst) {
            sendResponse({ success: false, error: 'No bot instance found' });
            break;
          }

          // Need gameState for player coordinates and userId
          var gs = scanFarmInst.engine.gameState;
          var cfg = scanFarmInst.engine.config;
          var farmScanConfig = (cfg && cfg.farmConfig) || {};

          // Get player village coordinates from gameState
          // Villages array has {id, name, x, y, isCapital}
          var myVillage = null;
          if (gs && gs.villages && gs.villages.length > 0) {
            // Use active village or first village
            var activeVillageId = cfg && cfg.activeVillage;
            if (activeVillageId) {
              myVillage = gs.villages.find(function(v) { return String(v.id) === String(activeVillageId); });
            }
            if (!myVillage) myVillage = gs.villages[0];
          }

          if (!myVillage || myVillage.x == null || myVillage.y == null) {
            sendResponse({ success: false, error: 'Cannot determine village coordinates. Run a scan first.' });
            break;
          }

          // Get server base URL
          var scanTab = null;
          if (scanFarmInst.tabId) {
            scanTab = await chrome.tabs.get(scanFarmInst.tabId).catch(function() { return null; });
          }
          if (!scanTab || !scanTab.url) {
            sendResponse({ success: false, error: 'No active Travian tab found' });
            break;
          }

          var serverBaseUrl = new URL(scanTab.url).origin;

          try {
            // Step 1: Scan map.sql for candidates
            var candidates = await self.TravianMapScanner.scanForTargets(serverBaseUrl, {
              myX: myVillage.x,
              myY: myVillage.y,
              myUserId: myVillage.userId || 0,
              scanRadius: farmScanConfig.scanRadius || 10,
              maxPop: farmScanConfig.scanMaxPop || 50,
              includeOases: farmScanConfig.scanIncludeOases !== false,
              skipAlliance: farmScanConfig.scanSkipAlliance !== false,
              existingCoords: [] // Will be populated from farm list scan
            });

            if (candidates.length === 0) {
              sendResponse({ success: true, data: { found: 0, added: 0, message: 'No targets found within radius' } });
              break;
            }

            // Step 2: Navigate to farm list page and get existing slots
            var tabId = scanFarmInst.tabId;

            // Navigate to rally point
            await new Promise(function(resolve, reject) {
              var timeout = setTimeout(function() {
                chrome.tabs.onUpdated.removeListener(listener);
                reject(new Error('Navigation timeout'));
              }, 10000);
              function listener(updatedTabId, changeInfo) {
                if (updatedTabId === tabId && changeInfo.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  clearTimeout(timeout);
                  setTimeout(function() { resolve(); }, 500);
                }
              }
              chrome.tabs.onUpdated.addListener(listener);
              var rallyUrl = serverBaseUrl + '/build.php?id=39&tt=99';
              chrome.tabs.update(tabId, { url: rallyUrl });
            });

            // Wait for content script to be ready after navigation
            await new Promise(function(r) { setTimeout(r, 2000); });

            // Get existing farm list slots to avoid duplicates
            var existingResp = null;
            for (var retries = 0; retries < 3; retries++) {
              try {
                existingResp = await new Promise(function(resolve, reject) {
                  chrome.tabs.sendMessage(tabId, {
                    type: 'EXECUTE', action: 'scanFarmListSlots', params: {}
                  }, function(r) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(r);
                  });
                });
                if (existingResp) break;
              } catch (err) {
                if (retries === 2) throw err;
                await new Promise(function(r) { setTimeout(r, 1000); });
              }
            }

            // Extract existing slot coordinates (if name contains coords, parse them)
            // For now, existingCoords is best-effort from the farm list scan
            var existingSlots = (existingResp && existingResp.slots) || [];
            var existingCount = existingSlots.length;

            // Farm list has max 100 slots
            var maxSlots = 100;
            var availableSlots = maxSlots - existingCount;
            if (availableSlots <= 0) {
              sendResponse({ success: true, data: {
                found: candidates.length, added: 0,
                message: 'Farm list is full (' + existingCount + '/' + maxSlots + ')'
              }});
              break;
            }

            // Step 3: Add targets one by one with human-like delays
            var toAdd = candidates.slice(0, availableSlots);
            var added = 0;
            var failed = 0;

            for (var ci = 0; ci < toAdd.length; ci++) {
              var target = toAdd[ci];
              try {
                var addResp = await new Promise(function(resolve, reject) {
                  chrome.tabs.sendMessage(tabId, {
                    type: 'EXECUTE', action: 'addToFarmList', params: {
                      x: target.x, y: target.y, listIndex: 0
                    }
                  }, function(r) {
                    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                    else resolve(r);
                  });
                });

                if (addResp && addResp.success) {
                  added++;
                } else {
                  failed++;
                  logger.warn('Failed to add (' + target.x + '|' + target.y + '): ' + (addResp ? addResp.message : 'no response'));
                }
              } catch (addErr) {
                failed++;
                logger.warn('Error adding target: ' + addErr.message);
              }

              // Human-like delay between each add (1-3 seconds)
              if (ci < toAdd.length - 1) {
                await new Promise(function(r) { setTimeout(r, 1000 + Math.random() * 2000); });
              }
            }

            logger.info('[MapScanner] Scan complete: found=' + candidates.length + ' added=' + added + ' failed=' + failed);
            sendResponse({ success: true, data: {
              found: candidates.length,
              added: added,
              failed: failed,
              message: 'Found ' + candidates.length + ' targets, added ' + added + ' to farm list'
            }});

          } catch (scanErr) {
            logger.error('[MapScanner] Scan error: ' + scanErr.message);
            sendResponse({ success: false, error: scanErr.message });
          }
          break;
        }
```

**Step 2: Commit**

```bash
git add travian-bot/background/service-worker.js
git commit -m "feat: add SCAN_FARM_TARGETS message handler in service worker"
```

---

## Task 5: Popup UI — Farm Target Scanner Section

Add the scanner config UI and "Scan Now" button to the popup's Config tab.

**Files:**
- Modify: `travian-bot/popup/index.html:247-261` (inside farmSection, after smartFarmConfig)
- Modify: `travian-bot/popup/popup.js` (DOM refs, collectConfig, populateForm, event handler)

**Step 1: Add scanner UI to index.html**

In `popup/index.html`, **after** the `farmListInfo` div (line 250) and **before** the `farmTargets` div (line 251), add:

```html
        <!-- Farm Target Scanner -->
        <div class="farm-scanner-section" style="margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.06);">
          <h4 class="section-subtitle">Farm Target Scanner</h4>
          <div class="form-row">
            <div class="form-group form-group--half">
              <label class="form-label">Scan Radius</label>
              <input type="number" id="scanRadius" value="10" min="1" max="50">
            </div>
            <div class="form-group form-group--half">
              <label class="form-label">Max Population</label>
              <input type="number" id="scanMaxPop" value="50" min="1" max="500">
            </div>
          </div>
          <div class="form-row" style="margin-top:4px">
            <div class="form-group form-group--half">
              <label class="toggle-pill"><input type="checkbox" id="togScanOases" checked><span>Include Oases</span></label>
            </div>
            <div class="form-group form-group--half">
              <label class="toggle-pill"><input type="checkbox" id="togScanSkipAlliance" checked><span>Skip Alliance</span></label>
            </div>
          </div>
          <button id="btnScanFarmTargets" class="btn-small btn-glow" style="margin-top:6px; width:100%;">Scan Map for Targets</button>
          <div id="scanFarmResult" class="info-text" style="margin-top:4px">--</div>
        </div>
```

**Step 2: Add DOM refs in popup.js**

In the `dom` object (around line 67, after the `togSkipLosses` ref), add:

```javascript
  scanRadius: document.getElementById('scanRadius'),
  scanMaxPop: document.getElementById('scanMaxPop'),
  togScanOases: document.getElementById('togScanOases'),
  togScanSkipAlliance: document.getElementById('togScanSkipAlliance'),
  btnScanFarmTargets: document.getElementById('btnScanFarmTargets'),
  scanFarmResult: document.getElementById('scanFarmResult'),
```

**Step 3: Update `collectConfig()` — add scanner fields to farmConfig**

In the `farmConfig` object inside `collectConfig()` (around line 1097, after `skipLosses`), add:

```javascript
      scanRadius: parseInt(dom.scanRadius ? dom.scanRadius.value : '10', 10) || 10,
      scanMaxPop: parseInt(dom.scanMaxPop ? dom.scanMaxPop.value : '50', 10) || 50,
      scanIncludeOases: dom.togScanOases ? dom.togScanOases.checked : true,
      scanSkipAlliance: dom.togScanSkipAlliance ? dom.togScanSkipAlliance.checked : true,
```

**Step 4: Update `populateForm()` — restore scanner fields**

In the `farmConfig` section of `populateForm()` (around line 1203, after the `skipLosses` block), add:

```javascript
    if (config.farmConfig.scanRadius !== undefined && dom.scanRadius) {
      dom.scanRadius.value = config.farmConfig.scanRadius;
    }
    if (config.farmConfig.scanMaxPop !== undefined && dom.scanMaxPop) {
      dom.scanMaxPop.value = config.farmConfig.scanMaxPop;
    }
    if (config.farmConfig.scanIncludeOases !== undefined && dom.togScanOases) {
      dom.togScanOases.checked = config.farmConfig.scanIncludeOases;
    }
    if (config.farmConfig.scanSkipAlliance !== undefined && dom.togScanSkipAlliance) {
      dom.togScanSkipAlliance.checked = config.farmConfig.scanSkipAlliance;
    }
```

**Step 5: Add "Scan Now" button click handler**

At the bottom of the event-listener section in `popup.js` (near other button handlers like `btnScanBuildings`), add:

```javascript
// Farm Target Scanner
if (dom.btnScanFarmTargets) {
  dom.btnScanFarmTargets.addEventListener('click', async function () {
    if (!currentServerKey) {
      dom.scanFarmResult.textContent = 'No server selected';
      return;
    }

    // Save config first so scanner uses latest settings
    try {
      var config = collectConfig();
      await sendMessage({ type: 'SAVE_CONFIG', config: config });
    } catch (_) {}

    dom.scanFarmResult.textContent = 'Scanning map.sql...';
    dom.btnScanFarmTargets.disabled = true;

    try {
      var resp = await sendMessage({ type: 'SCAN_FARM_TARGETS' });
      if (resp && resp.success && resp.data) {
        dom.scanFarmResult.textContent = resp.data.message || ('Found ' + resp.data.found + ', added ' + resp.data.added);
      } else {
        dom.scanFarmResult.textContent = 'Error: ' + ((resp && resp.error) || 'Unknown error');
      }
    } catch (err) {
      dom.scanFarmResult.textContent = 'Error: ' + err.message;
    } finally {
      dom.btnScanFarmTargets.disabled = false;
    }
  });
}
```

**Step 6: Commit**

```bash
git add travian-bot/popup/index.html travian-bot/popup/popup.js
git commit -m "feat: add Farm Target Scanner UI in popup config"
```

---

## Task 6: Wire Village Coordinates into GameState

The scanner needs `myX`, `myY`, and `myUserId` from the game state. The `domScanner.js` already scans village sidebar, but we need to verify coordinates are captured. If not, add coordinate extraction.

**Files:**
- Modify: `travian-bot/content/domScanner.js` (if coordinates not already captured in village scan)

**Step 1: Check and enhance village scanning**

Look at the existing `getVillages()` in domScanner. If it doesn't capture `x`, `y` coordinates, add extraction from the village link's `href` which typically contains coordinates.

In `domScanner.js`, in the `getVillages()` function, ensure each village object includes `x` and `y` by parsing the village link href or the sidebar tooltip:

```javascript
// Inside the village scanning loop, add coordinate extraction:
// Village links often have href like "/karte.php?x=61&y=120"
// Or data attributes with coordinates
var coordLink = qs('a[href*="karte.php"]', villageEl);
if (coordLink) {
  var href = coordLink.getAttribute('href') || '';
  var xMatch = href.match(/x=(-?\d+)/);
  var yMatch = href.match(/y=(-?\d+)/);
  if (xMatch) village.x = parseInt(xMatch[1], 10);
  if (yMatch) village.y = parseInt(yMatch[1], 10);
}
```

Also, extract userId from the page. In the `getFullState()` function, add:

```javascript
// Extract own userId from page source or meta tag
// Travian pages often have: Travian.Game.player.id or data in a <script> tag
try {
  var bodyHtml = document.body ? document.body.innerHTML : '';
  var uidMatch = bodyHtml.match(/playerId['":\s]+(\d+)/);
  if (uidMatch) state.myUserId = parseInt(uidMatch[1], 10);
} catch (e) {}
```

**Step 2: Commit**

```bash
git add travian-bot/content/domScanner.js
git commit -m "feat: extract village coordinates and userId in domScanner"
```

---

## Task 7: Discovery — Find the Actual Farm List Add UI Selectors

Before the content script `addToFarmList` function can work reliably, we need to discover the real DOM selectors on a live Travian farm list page.

**Files:** No files modified — this is a discovery/verification step.

**Step 1: Inspect the farm list page**

On a live Travian tab at `build.php?id=39&tt=99`, use the browser DevTools (or MCP) to find:

1. How new targets are added to a farm list — look for:
   - Input fields for coordinates (x, y)
   - An "add" button near those inputs
   - Or a different mechanism (e.g., a dialog, link click)

2. Take note of exact selectors for:
   - The x coordinate input
   - The y coordinate input
   - The add/submit button
   - Any list selector if there are multiple farm lists

3. Also check: is `Travian.api()` available for farm list operations? Try `Travian.api("farm-list")` patterns.

**Step 2: Update `addToFarmList` selectors**

Based on discovery, update the selectors in `actionExecutor.js`'s `addToFarmList` function to match the actual page DOM.

**Step 3: Commit**

```bash
git add travian-bot/content/actionExecutor.js
git commit -m "fix: update addToFarmList selectors based on live DOM inspection"
```

---

## Task 8: End-to-End Test

Verify the complete flow works on a live Travian server.

**Step 1: Reload extension**

Go to `chrome://extensions`, click reload on the Travian Bot extension.

**Step 2: Open popup, go to Config tab**

Verify:
- "Farm Target Scanner" section appears below Smart Farming
- Scan Radius default = 10
- Max Population default = 50
- Include Oases and Skip Alliance checkboxes are checked

**Step 3: Run a full scan first**

Click "Scan" in the Upgrade Targets section to populate gameState with village data (needed for coordinates).

**Step 4: Click "Scan Map for Targets"**

Watch the result text update:
- Should show "Scanning map.sql..."
- Then show something like "Found 32 targets, added 18 to farm list"

**Step 5: Verify on the Travian page**

Navigate to the rally point farm list tab and check that new entries were added.

**Step 6: Check for errors**

Open Logs tab in popup and look for any ERROR entries related to MapScanner or farm list operations.
