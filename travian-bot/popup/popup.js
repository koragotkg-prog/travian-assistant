/**
 * Travian Bot - Gaming Dashboard v2
 *
 * Popup controller with tab navigation. Communicates with the background
 * service worker via chrome.runtime.sendMessage, and persists
 * configuration to chrome.storage.local.
 */

// ============================================================
// DOM Element References
// ============================================================
const dom = {
  // Status
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),

  // Control buttons
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnPause: document.getElementById('btnPause'),
  btnEmergency: document.getElementById('btnEmergency'),

  // Stats
  statCompleted: document.getElementById('statCompleted'),
  statFailed: document.getElementById('statFailed'),
  statUptime: document.getElementById('statUptime'),
  statRate: document.getElementById('statRate'),

  // Current task
  taskInfo: document.getElementById('taskInfo'),
  taskProgressTrack: document.getElementById('taskProgressTrack'),
  taskProgressFill: document.getElementById('taskProgressFill'),

  // Server selector
  serverSelect: document.getElementById('serverSelect'),

  // Village selector
  villageSelect: document.getElementById('villageSelect'),

  // Feature toggles
  togResourceUpgrade: document.getElementById('togResourceUpgrade'),
  togBuildingUpgrade: document.getElementById('togBuildingUpgrade'),
  togTroopTraining: document.getElementById('togTroopTraining'),
  togFarming: document.getElementById('togFarming'),
  togHeroAdventure: document.getElementById('togHeroAdventure'),
  togAIScoring: document.getElementById('togAIScoring'),
  togTrapTraining: document.getElementById('togTrapTraining'),
  heroMinHealth: document.getElementById('heroMinHealth'),
  trapBatchSize: document.getElementById('trapBatchSize'),

  // Upgrade targets
  btnScanBuildings: document.getElementById('btnScanBuildings'),
  upgradeList: document.getElementById('upgradeList'),

  // Troop training
  troopType: document.getElementById('troopType'),
  troopBatch: document.getElementById('troopBatch'),
  troopMinRes: document.getElementById('troopMinRes'),

  // Farming
  farmInterval: document.getElementById('farmInterval'),
  farmMinTroops: document.getElementById('farmMinTroops'),
  togUseFarmList: document.getElementById('togUseFarmList'),
  togSmartFarming: document.getElementById('togSmartFarming'),
  farmMinLoot: document.getElementById('farmMinLoot'),
  togSkipLosses: document.getElementById('togSkipLosses'),
  scanMyX: document.getElementById('scanMyX'),
  scanMyY: document.getElementById('scanMyY'),
  scanRadius: document.getElementById('scanRadius'),
  scanMaxPop: document.getElementById('scanMaxPop'),
  togScanOases: document.getElementById('togScanOases'),
  togScanEmptyOases: document.getElementById('togScanEmptyOases'),
  togScanSkipAlliance: document.getElementById('togScanSkipAlliance'),
  scanTroopSlot: document.getElementById('scanTroopSlot'),
  scanTroopCount: document.getElementById('scanTroopCount'),
  btnScanFarmTargets: document.getElementById('btnScanFarmTargets'),
  scanFarmResult: document.getElementById('scanFarmResult'),
  farmX: document.getElementById('farmX'),
  farmY: document.getElementById('farmY'),
  btnAddFarm: document.getElementById('btnAddFarm'),
  farmTargetList: document.getElementById('farmTargetList'),

  // Delays
  delayMin: document.getElementById('delayMin'),
  delayMax: document.getElementById('delayMax'),
  maxActions: document.getElementById('maxActions'),

  // Queue
  queueCount: document.getElementById('queueCount'),
  taskQueueList: document.getElementById('taskQueueList'),
  btnClearQueue: document.getElementById('btnClearQueue'),

  // Logs
  logLevel: document.getElementById('logLevel'),
  logViewer: document.getElementById('logViewer'),
  btnClearLogs: document.getElementById('btnClearLogs'),

  // Strategy Dashboard
  strategyDashboard: document.getElementById('strategyDashboard'),
  btnRefreshStrategy: document.getElementById('btnRefreshStrategy'),

  // Save
  btnSaveAll: document.getElementById('btnSaveAll'),

  // Tabs
  tabButtons: document.querySelectorAll('.tab-btn'),
  tabPanels: document.querySelectorAll('.tab-panel'),

  // Dashboard: Resources
  resBarWood: document.getElementById('resBarWood'),
  resBarClay: document.getElementById('resBarClay'),
  resBarIron: document.getElementById('resBarIron'),
  resBarCrop: document.getElementById('resBarCrop'),
  resValWood: document.getElementById('resValWood'),
  resValClay: document.getElementById('resValClay'),
  resValIron: document.getElementById('resValIron'),
  resValCrop: document.getElementById('resValCrop'),
  resProdWood: document.getElementById('resProdWood'),
  resProdClay: document.getElementById('resProdClay'),
  resProdIron: document.getElementById('resProdIron'),
  resProdCrop: document.getElementById('resProdCrop'),

  // Dashboard: Build Queue
  buildQueueDisplay: document.getElementById('buildQueueDisplay'),

  // Dashboard: Troops
  troopDisplay: document.getElementById('troopDisplay'),

  // Dashboard: Info Strip
  nextActionTimer: document.getElementById('nextActionTimer'),
  farmRaidStats: document.getElementById('farmRaidStats'),
  trapperStatus: document.getElementById('trapperStatus'),

  // Dashboard: AI + Quest
  taskAIReason: document.getElementById('taskAIReason'),
  questSection: document.getElementById('questSection'),
  questDisplay: document.getElementById('questDisplay'),
};

// ============================================================
// Tab Navigation
// ============================================================

/**
 * Switch to a tab by name (dash, config, ai, logs).
 */
const TAB_PANEL_MAP = { dash: 'panelDash', config: 'panelConfig', ai: 'panelAI', logs: 'panelLogs' };

function switchTab(tabName) {
  dom.tabButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  var targetPanel = TAB_PANEL_MAP[tabName];
  dom.tabPanels.forEach(panel => {
    panel.classList.toggle('active', panel.id === targetPanel);
  });
}

// ============================================================
// State
// ============================================================
let currentLogs = [];
let farmTargets = [];
let refreshInterval = null;
let currentServerKey = null; // Set on popup open from active tab URL

// GID → Building/Resource name mapping (Travian Legends)
const GID_NAMES = {
  1: 'Woodcutter', 2: 'Clay Pit', 3: 'Iron Mine', 4: 'Crop Field',
  5: 'Sawmill', 6: 'Brickyard', 7: 'Iron Foundry', 8: 'Grain Mill',
  9: 'Bakery', 10: 'Warehouse', 11: 'Granary', 13: 'Armoury',
  14: 'Tournament Square', 15: 'Main Building', 16: 'Rally Point',
  17: 'Marketplace', 18: 'Embassy', 19: 'Barracks', 20: 'Stable',
  21: 'Workshop', 22: 'Academy', 23: 'Cranny', 24: 'Town Hall',
  25: 'Residence', 26: 'Palace', 27: 'Treasury', 28: 'Trade Office',
  29: 'Great Barracks', 30: 'Great Stable',
  31: 'City Wall', 32: 'Earth Wall', 33: 'Palisade',
  34: 'Stonemason', 35: 'Brewery', 36: 'Trapper',
  37: "Hero's Mansion", 38: 'Great Warehouse', 39: 'Great Granary',
  40: 'Wonder', 41: 'Horse Drinking Trough', 42: 'Stone Wall',
  43: 'Command Center', 44: 'Waterworks', 45: 'Hospital'
};

// Scanned items and saved upgrade targets
let scannedResources = [];
let scannedBuildings = [];
let upgradeTargets = {};  // { "slot_number": { enabled: true, targetLevel: 10 } }

// ============================================================
// Communication with Background Service Worker
// ============================================================

/**
 * Send a message to the background service worker.
 * Returns a promise that resolves with the response.
 * Handles extension context invalidated errors gracefully.
 */
function sendMessage(message) {
  // Auto-inject serverKey into every message
  if (currentServerKey && !message.serverKey) {
    message.serverKey = currentServerKey;
  }
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Popup] Runtime error:', chrome.runtime.lastError.message);
          reject(chrome.runtime.lastError);
          return;
        }
        resolve(response);
      });
    } catch (err) {
      console.warn('[Popup] Failed to send message:', err.message);
      reject(err);
    }
  });
}

// ============================================================
// UI Update Functions
// ============================================================

/**
 * Update the status indicator dot, status text, and button states
 * based on the current bot state.
 */
function updateStatus(status) {
  if (!status) return;

  // Derive state from engine flags (running/paused/emergencyStopped)
  let state = status.state || 'stopped';
  if (!status.state) {
    if (status.emergencyStopped) state = 'stopped';
    else if (status.paused) state = 'paused';
    else if (status.running) state = 'running';
    else state = 'stopped';
  }

  // Update status dot class
  dom.statusDot.className = 'status-dot ' + state;

  // Update status text
  const stateLabels = {
    running: 'Running',
    stopped: 'Stopped',
    paused: 'Paused',
  };
  // SAF-5 FIX: Show emergency reason when stopped due to emergency
  if (state === 'stopped' && status.emergencyReason) {
    dom.statusText.textContent = 'Emergency: ' + status.emergencyReason;
    dom.statusText.title = status.emergencyReason; // full text on hover
  } else {
    dom.statusText.textContent = stateLabels[state] || state;
    dom.statusText.title = '';
  }

  // Update button states based on current bot state
  switch (state) {
    case 'running':
      dom.btnStart.disabled = true;
      dom.btnStop.disabled = false;
      dom.btnPause.disabled = false;
      dom.btnPause.textContent = 'Pause';
      break;
    case 'stopped':
      dom.btnStart.disabled = false;
      dom.btnStop.disabled = true;
      dom.btnPause.disabled = true;
      dom.btnPause.textContent = 'Pause';
      break;
    case 'paused':
      dom.btnStart.disabled = true;
      dom.btnStop.disabled = false;
      dom.btnPause.disabled = false;
      dom.btnPause.textContent = 'Resume';
      break;
  }

  // Update stats if provided
  if (status.stats) {
    updateStats(status.stats);
  }

  // Update current task if provided
  if (status.currentTask !== undefined) {
    updateTaskDisplay(status.currentTask);
  }

  // Update village list if provided
  if (status.villages) {
    updateVillageSelector(status.villages);
  }
}

/**
 * Update the stats bar with task counts, uptime, and action rate.
 */
function updateStats(stats) {
  if (!stats) return;

  dom.statCompleted.textContent = stats.completed || 0;
  dom.statFailed.textContent = stats.failed || 0;
  dom.statRate.textContent = stats.actionsPerHour || 0;

  // Calculate and format uptime
  if (stats.startTime) {
    const elapsed = Date.now() - stats.startTime;
    dom.statUptime.textContent = formatUptime(elapsed);
  } else if (stats.uptime) {
    dom.statUptime.textContent = formatUptime(stats.uptime);
  } else {
    dom.statUptime.textContent = '--';
  }
}

/**
 * Format milliseconds into a human-readable uptime string.
 */
function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Display the currently executing task in the task info panel with progress bar.
 */
function updateTaskDisplay(task) {
  if (!task || (typeof task === 'string' && task === '')) {
    dom.taskInfo.textContent = 'Idle';
    dom.taskProgressTrack.classList.remove('visible');
    return;
  }

  if (typeof task === 'string') {
    dom.taskInfo.textContent = task;
    dom.taskProgressTrack.classList.remove('visible');
    return;
  }

  // Task is an object with name, village, progress, etc.
  let text = task.name || 'Unknown task';
  if (task.village) {
    text += ` (${task.village})`;
  }
  if (task.progress !== undefined) {
    text += ` - ${task.progress}%`;
    dom.taskProgressTrack.classList.add('visible');
    dom.taskProgressFill.style.width = task.progress + '%';
  } else {
    dom.taskProgressTrack.classList.remove('visible');
  }
  dom.taskInfo.textContent = text;
}

/**
 * Populate the village dropdown selector.
 */
function updateVillageSelector(villages) {
  if (!villages || !Array.isArray(villages)) return;

  // Preserve current selection
  const currentValue = dom.villageSelect.value;

  // Clear existing options except the placeholder
  dom.villageSelect.innerHTML = '<option value="">-- Select --</option>';

  villages.forEach((village) => {
    const opt = document.createElement('option');
    opt.value = village.id || village.name;
    opt.textContent = village.name || village.id;
    if (village.isCapital) {
      opt.textContent += ' (Capital)';
    }
    dom.villageSelect.appendChild(opt);
  });

  // Restore selection
  if (currentValue) {
    dom.villageSelect.value = currentValue;
  }
}

/**
 * Render log entries in the log viewer with color coding by level.
 * Respects the currently selected log level filter.
 */
function updateLogs(logs) {
  if (!logs || !Array.isArray(logs)) return;

  currentLogs = logs;
  renderFilteredLogs();
}

/**
 * Render logs filtered by the current log level selection.
 */
function renderFilteredLogs() {
  const filter = dom.logLevel.value;
  const filtered =
    filter === 'all' ? currentLogs : currentLogs.filter((log) => log.level === filter);

  dom.logViewer.innerHTML = '';

  filtered.forEach((log) => {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${log.level || 'INFO'}`;

    const time = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
    const level = log.level || 'INFO';
    const msg = log.message || log.msg || String(log);

    entry.textContent = `[${time}] [${level}] ${msg}`;
    dom.logViewer.appendChild(entry);
  });

  // Auto-scroll to bottom
  dom.logViewer.scrollTop = dom.logViewer.scrollHeight;
}

/**
 * Render the task queue items.
 */
function updateQueue(tasks) {
  if (!tasks || !Array.isArray(tasks)) return;

  dom.queueCount.textContent = `(${tasks.length})`;
  dom.taskQueueList.innerHTML = '';

  if (tasks.length === 0) {
    dom.taskQueueList.textContent = 'Queue is empty';
    return;
  }

  tasks.forEach((task, index) => {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    const name = task.name || task.type || 'Unknown';
    const village = task.village ? ` @ ${task.village}` : '';
    entry.textContent = `${index + 1}. ${name}${village}`;
    dom.taskQueueList.appendChild(entry);
  });
}

/**
 * Render the farm target list with remove buttons.
 */
function updateFarmTargets(targets) {
  if (!targets) targets = [];
  farmTargets = targets;

  dom.farmTargetList.innerHTML = '';

  if (targets.length === 0) {
    dom.farmTargetList.innerHTML = '<div style="color:#666;font-size:12px;">No targets added</div>';
    return;
  }

  targets.forEach((target, index) => {
    const row = document.createElement('div');
    row.className = 'farm-target';

    const coords = document.createElement('span');
    const label = target.name ? `${target.name} (${target.x}|${target.y})` : `(${target.x}|${target.y})`;
    coords.textContent = label;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'farm-remove';
    removeBtn.textContent = '\u00D7';
    removeBtn.title = 'Remove target';
    removeBtn.addEventListener('click', () => removeFarmTarget(index));

    row.appendChild(coords);
    row.appendChild(removeBtn);
    dom.farmTargetList.appendChild(row);
  });
}

// ============================================================
// Dashboard: Resource Bars, Build Queue, Troops, Info Strip
// ============================================================

/**
 * Format a number compactly (e.g. 12345 → "12.3k").
 */
function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Update resource bars with current amounts, capacity, and production rates.
 */
function updateResources(gameState) {
  if (!gameState) return;

  var res = gameState.resources;
  var cap = gameState.resourceCapacity;
  var prod = gameState.resourceProduction;
  if (!res) return;

  var warehouse = (cap && cap.warehouse) || 800;
  var granary = (cap && cap.granary) || 800;

  var items = [
    { key: 'Wood', amount: res.wood || 0, capacity: warehouse, prod: prod ? prod.wood : 0 },
    { key: 'Clay',  amount: res.clay || 0,  capacity: warehouse, prod: prod ? prod.clay : 0 },
    { key: 'Iron', amount: res.iron || 0, capacity: warehouse, prod: prod ? prod.iron : 0 },
    { key: 'Crop', amount: res.crop || 0, capacity: granary,   prod: prod ? prod.crop : 0 },
  ];

  items.forEach(function (item) {
    var bar = dom['resBar' + item.key];
    var val = dom['resVal' + item.key];
    var prodEl = dom['resProd' + item.key];
    if (!bar || !val) return;

    var pct = item.capacity > 0 ? Math.min(100, Math.round((item.amount / item.capacity) * 100)) : 0;
    bar.style.width = pct + '%';

    // Add overflow pulse if > 90%
    if (pct >= 90) {
      bar.classList.add('res-overflow');
    } else {
      bar.classList.remove('res-overflow');
    }

    val.textContent = formatNumber(item.amount);
    val.title = item.amount + ' / ' + item.capacity;

    if (prodEl && item.prod) {
      prodEl.textContent = '+' + formatNumber(item.prod);
      prodEl.title = '+' + item.prod + '/hr';
    } else if (prodEl) {
      prodEl.textContent = '';
    }
  });
}

/**
 * Build queue countdown timer reference.
 */
var buildQueueTimerInterval = null;

/**
 * Update the build queue display with active construction items.
 */
function updateBuildQueue(constructionQueue) {
  if (!dom.buildQueueDisplay) return;

  if (!constructionQueue || !constructionQueue.items || constructionQueue.items.length === 0) {
    dom.buildQueueDisplay.innerHTML = '<span class="text-muted-italic">No active construction</span>';
    clearBuildQueueTimer();
    return;
  }

  dom.buildQueueDisplay.innerHTML = '';

  constructionQueue.items.forEach(function (item) {
    var div = document.createElement('div');
    div.className = 'build-queue-item';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'build-queue-name';
    nameSpan.textContent = item.name || 'Building';

    var timerSpan = document.createElement('span');
    timerSpan.className = 'build-queue-timer';
    if (item.finishTime) {
      timerSpan.dataset.finishTime = item.finishTime;
      timerSpan.textContent = formatCountdown(item.finishTime - Date.now());
    } else {
      timerSpan.textContent = '--:--';
    }

    div.appendChild(nameSpan);
    div.appendChild(timerSpan);
    dom.buildQueueDisplay.appendChild(div);
  });

  // Start countdown timer if not already running
  startBuildQueueTimer();
}

/**
 * Format milliseconds into mm:ss or hh:mm:ss countdown string.
 */
function formatCountdown(ms) {
  if (ms <= 0) return '0:00';
  var totalSec = Math.ceil(ms / 1000);
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  if (h > 0) {
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * Start a 1-second interval to update build queue countdown timers.
 */
function startBuildQueueTimer() {
  if (buildQueueTimerInterval) return;
  buildQueueTimerInterval = setInterval(function () {
    var timers = dom.buildQueueDisplay.querySelectorAll('.build-queue-timer[data-finish-time]');
    if (timers.length === 0) {
      clearBuildQueueTimer();
      return;
    }
    var now = Date.now();
    timers.forEach(function (el) {
      var finish = parseInt(el.dataset.finishTime, 10);
      var remaining = finish - now;
      el.textContent = remaining > 0 ? formatCountdown(remaining) : 'Done!';
    });
  }, 1000);
}

/**
 * Clear the build queue countdown timer.
 */
function clearBuildQueueTimer() {
  if (buildQueueTimerInterval) {
    clearInterval(buildQueueTimerInterval);
    buildQueueTimerInterval = null;
  }
}

/**
 * Update the troop summary display.
 */
function updateTroopSummary(troops) {
  if (!dom.troopDisplay) return;

  if (!troops || Object.keys(troops).length === 0) {
    dom.troopDisplay.innerHTML = '<span class="text-muted-italic">No troop data</span>';
    return;
  }

  dom.troopDisplay.innerHTML = '';

  Object.keys(troops).forEach(function (name) {
    var count = troops[name];
    if (count <= 0) return;

    var div = document.createElement('div');
    div.className = 'troop-item';

    var nameSpan = document.createElement('span');
    nameSpan.className = 'troop-name';
    nameSpan.textContent = name;

    var countSpan = document.createElement('span');
    countSpan.className = 'troop-count';
    countSpan.textContent = formatNumber(count);

    div.appendChild(nameSpan);
    div.appendChild(countSpan);
    dom.troopDisplay.appendChild(div);
  });
}

/**
 * Update the next action countdown timer.
 */
function updateNextAction(nextActionTime) {
  if (!dom.nextActionTimer) return;

  if (!nextActionTime) {
    dom.nextActionTimer.textContent = '--';
    return;
  }

  var remaining = nextActionTime - Date.now();
  if (remaining <= 0) {
    dom.nextActionTimer.textContent = 'Now';
  } else {
    dom.nextActionTimer.textContent = formatCountdown(remaining);
  }
}

/**
 * Update farm raid stats display.
 */
function updateFarmStats(stats) {
  if (!dom.farmRaidStats || !stats) return;
  dom.farmRaidStats.textContent = stats.farmRaidsSent || 0;
}

/**
 * Update trapper status display.
 */
function updateTrapperStatus(trapperInfo) {
  if (!dom.trapperStatus) return;
  if (!trapperInfo) {
    dom.trapperStatus.textContent = '--';
    return;
  }
  dom.trapperStatus.textContent = trapperInfo.currentTraps + '/' + trapperInfo.maxTraps;
}

/**
 * Update quest progress display (top 3 quests).
 */
function updateQuestDisplay(quests) {
  if (!dom.questSection || !dom.questDisplay) return;
  if (!quests || quests.length === 0) {
    dom.questSection.style.display = 'none';
    return;
  }
  dom.questSection.style.display = '';
  dom.questDisplay.innerHTML = '';
  var showCount = Math.min(quests.length, 3);
  for (var i = 0; i < showCount; i++) {
    var q = quests[i];
    var pct = q.total > 0 ? Math.round((q.progress / q.total) * 100) : 0;
    var item = document.createElement('div');
    item.className = 'quest-item';
    var titleSpan = document.createElement('span');
    titleSpan.className = 'quest-item-title';
    titleSpan.textContent = q.title || 'Quest';
    var progressDiv = document.createElement('div');
    progressDiv.className = 'quest-progress';
    var fillDiv = document.createElement('div');
    fillDiv.className = 'quest-progress-fill';
    fillDiv.style.width = pct + '%';
    progressDiv.appendChild(fillDiv);
    var pctSpan = document.createElement('span');
    pctSpan.className = 'quest-item-pct';
    pctSpan.textContent = pct + '%';
    item.appendChild(titleSpan);
    item.appendChild(progressDiv);
    item.appendChild(pctSpan);
    dom.questDisplay.appendChild(item);
  }
}

/**
 * Update AI scoring reason display below current task.
 */
function updateAIReason(lastAIAction) {
  if (!dom.taskAIReason) return;
  if (!lastAIAction) {
    dom.taskAIReason.textContent = '';
    return;
  }
  dom.taskAIReason.textContent = 'AI: ' + lastAIAction.reason + ' (score: ' + lastAIAction.score.toFixed(1) + ')';
}

// ============================================================
// Upgrade Targets - Scan & Render
// ============================================================

/**
 * Request a scan of the current Travian page from the background.
 */
function scanBuildings() {
  dom.btnScanBuildings.disabled = true;
  dom.btnScanBuildings.textContent = '...';

  sendMessage({ type: 'REQUEST_SCAN' })
    .then((response) => {
      if (response && response.success && response.data) {
        applyScannedState(response.data);
      } else {
        dom.upgradeList.innerHTML = '<div class="upgrade-empty">Scan failed. Make sure a Travian page is open.</div>';
      }
    })
    .catch(() => {
      dom.upgradeList.innerHTML = '<div class="upgrade-empty">Scan failed. Make sure a Travian page is open.</div>';
    })
    .finally(() => {
      dom.btnScanBuildings.disabled = false;
      dom.btnScanBuildings.textContent = 'Scan';
    });
}

/**
 * Apply scanned game state to the upgrade list.
 */
function applyScannedState(gameState) {
  scannedResources = (gameState.resourceFields || []).map(function (f) {
    return {
      slot: f.id || f.position,
      gid: f.gid || (f.type === 'wood' ? 1 : f.type === 'clay' ? 2 : f.type === 'iron' ? 3 : f.type === 'crop' ? 4 : 0),
      level: f.level || 0,
      upgrading: f.upgrading || false,
      name: f.type ? (f.type.charAt(0).toUpperCase() + f.type.slice(1)) : ('Field ' + f.id),
      isResource: true
    };
  });

  scannedBuildings = (gameState.buildings || []).map(function (b) {
    var isEmpty = b.empty || (b.id === 0 && (b.level || 0) === 0);
    return {
      slot: b.slot,
      gid: b.id || 0,
      level: b.level || 0,
      upgrading: b.upgrading || false,
      name: isEmpty ? '' : (GID_NAMES[b.id] || b.name || ('Building ' + b.id)),
      isResource: false,
      empty: isEmpty
    };
  });

  renderUpgradeList();
}

/**
 * Render the upgrade list UI from scanned data + saved targets.
 */
function renderUpgradeList() {
  dom.upgradeList.innerHTML = '';

  if (scannedResources.length === 0 && scannedBuildings.length === 0) {
    dom.upgradeList.innerHTML = '<div class="upgrade-empty">Click "Scan" while on a Travian page to load buildings.</div>';
    return;
  }

  // Resource fields
  if (scannedResources.length > 0) {
    var resTitle = document.createElement('div');
    resTitle.className = 'upgrade-group-title';
    resTitle.textContent = 'Resource Fields';
    dom.upgradeList.appendChild(resTitle);

    scannedResources.forEach(function (item) {
      dom.upgradeList.appendChild(createUpgradeRow(item));
    });
  }

  // Buildings (existing, non-empty)
  var existingBuildings = scannedBuildings.filter(function (b) { return !b.empty; });
  var emptySlots = scannedBuildings.filter(function (b) { return b.empty; });

  if (existingBuildings.length > 0) {
    var bldTitle = document.createElement('div');
    bldTitle.className = 'upgrade-group-title';
    bldTitle.textContent = 'Buildings';
    dom.upgradeList.appendChild(bldTitle);

    // Sort by level ascending
    var sorted = existingBuildings.slice().sort(function (a, b) { return a.level - b.level; });
    sorted.forEach(function (item) {
      dom.upgradeList.appendChild(createUpgradeRow(item));
    });
  }

  // Empty building slots — user can choose what to build
  if (emptySlots.length > 0) {
    var emptyTitle = document.createElement('div');
    emptyTitle.className = 'upgrade-group-title';
    emptyTitle.textContent = 'Empty Slots (' + emptySlots.length + ' available)';
    dom.upgradeList.appendChild(emptyTitle);

    emptySlots.forEach(function (item) {
      dom.upgradeList.appendChild(createEmptySlotRow(item));
    });
  }
}

/**
 * Create a single upgrade row element.
 */
function createUpgradeRow(item) {
  var key = String(item.slot);
  var saved = upgradeTargets[key] || {};
  var enabled = saved.enabled !== undefined ? saved.enabled : true;
  var targetLevel = saved.targetLevel || Math.min((item.level || 0) + 5, 20);

  var row = document.createElement('div');
  row.className = 'upgrade-row';

  // Checkbox
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = enabled;
  cb.dataset.slot = key;
  cb.addEventListener('change', function () {
    if (!upgradeTargets[key]) upgradeTargets[key] = {};
    upgradeTargets[key].enabled = cb.checked;
  });

  // Name
  var nameSpan = document.createElement('span');
  nameSpan.className = 'upgrade-name';
  nameSpan.textContent = item.name;
  nameSpan.title = 'Slot ' + item.slot + ' (GID ' + item.gid + ')';

  // Current level
  var levelSpan = document.createElement('span');
  levelSpan.className = 'upgrade-level';
  levelSpan.textContent = 'Lv.' + item.level;
  if (item.upgrading) {
    levelSpan.style.color = '#ffaa00';
    levelSpan.textContent += '+';
  }

  // Arrow
  var arrow = document.createElement('span');
  arrow.className = 'upgrade-arrow';
  arrow.textContent = '\u2192';

  // Target level input
  var targetInput = document.createElement('input');
  targetInput.type = 'number';
  targetInput.className = 'upgrade-target';
  targetInput.min = '0';
  targetInput.max = '20';
  targetInput.value = targetLevel;
  targetInput.dataset.slot = key;
  targetInput.addEventListener('change', function () {
    if (!upgradeTargets[key]) upgradeTargets[key] = {};
    upgradeTargets[key].targetLevel = parseInt(targetInput.value, 10) || 0;
  });

  // Init upgradeTargets entry
  if (!upgradeTargets[key]) {
    upgradeTargets[key] = { enabled: enabled, targetLevel: targetLevel };
  }

  row.appendChild(cb);
  row.appendChild(nameSpan);
  row.appendChild(levelSpan);
  row.appendChild(arrow);
  row.appendChild(targetInput);
  return row;
}

/**
 * Create an empty slot row with a building selector dropdown.
 */
function createEmptySlotRow(item) {
  var key = 'new_' + item.slot;
  var saved = upgradeTargets[key] || {};

  var row = document.createElement('div');
  row.className = 'upgrade-row upgrade-row-empty';

  // Checkbox (enable auto-build for this slot)
  var cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = saved.enabled || false;
  cb.dataset.slot = key;
  cb.addEventListener('change', function () {
    if (!upgradeTargets[key]) upgradeTargets[key] = {};
    upgradeTargets[key].enabled = cb.checked;
    upgradeTargets[key].buildGid = parseInt(select.value, 10) || 0;
    upgradeTargets[key].targetLevel = parseInt(targetInput.value, 10) || 1;
    upgradeTargets[key].isNewBuild = true;
    upgradeTargets[key].slot = item.slot;
  });

  // Slot label
  var slotLabel = document.createElement('span');
  slotLabel.className = 'upgrade-name';
  slotLabel.textContent = 'Slot ' + item.slot;
  slotLabel.style.color = '#888';

  // Building selector dropdown
  var select = document.createElement('select');
  select.className = 'upgrade-building-select';
  var defaultOpt = document.createElement('option');
  defaultOpt.value = '0';
  defaultOpt.textContent = '-- Select Building --';
  select.appendChild(defaultOpt);

  // Commonly buildable buildings (non-resource, non-unique)
  var buildableGids = [
    10, 11, 13, 14, 15, 17, 19, 20, 21, 22, 23, 24, 25,
    27, 28, 29, 30, 36, 37, 38, 39, 41
  ];
  buildableGids.forEach(function (gid) {
    var opt = document.createElement('option');
    opt.value = String(gid);
    opt.textContent = GID_NAMES[gid] || ('GID ' + gid);
    select.appendChild(opt);
  });
  if (saved.buildGid) select.value = String(saved.buildGid);

  select.addEventListener('change', function () {
    if (!upgradeTargets[key]) upgradeTargets[key] = {};
    upgradeTargets[key].buildGid = parseInt(select.value, 10) || 0;
    upgradeTargets[key].isNewBuild = true;
    upgradeTargets[key].slot = item.slot;
  });

  // Arrow
  var arrow = document.createElement('span');
  arrow.className = 'upgrade-arrow';
  arrow.textContent = '\u2192';

  // Target level input
  var targetInput = document.createElement('input');
  targetInput.type = 'number';
  targetInput.className = 'upgrade-target';
  targetInput.min = '1';
  targetInput.max = '20';
  targetInput.value = saved.targetLevel || 1;
  targetInput.dataset.slot = key;
  targetInput.addEventListener('change', function () {
    if (!upgradeTargets[key]) upgradeTargets[key] = {};
    upgradeTargets[key].targetLevel = parseInt(targetInput.value, 10) || 1;
  });

  // Init upgradeTargets entry
  if (saved.buildGid) {
    if (!upgradeTargets[key]) {
      upgradeTargets[key] = {
        enabled: saved.enabled || false,
        targetLevel: saved.targetLevel || 1,
        buildGid: saved.buildGid,
        isNewBuild: true,
        slot: item.slot
      };
    }
  }

  row.appendChild(cb);
  row.appendChild(slotLabel);
  row.appendChild(select);
  row.appendChild(arrow);
  row.appendChild(targetInput);
  return row;
}

/**
 * Collect current upgradeTargets from the rendered UI rows.
 */
function collectUpgradeTargets() {
  var rows = dom.upgradeList.querySelectorAll('.upgrade-row');
  var targets = {};
  rows.forEach(function (row) {
    var cb = row.querySelector('input[type="checkbox"]');
    var input = row.querySelector('input[type="number"]');
    var select = row.querySelector('select.upgrade-building-select');

    if (cb && input && cb.dataset.slot) {
      var entry = {
        enabled: cb.checked,
        targetLevel: parseInt(input.value, 10) || 0
      };

      // For empty slot rows: include building selection
      if (select) {
        var gid = parseInt(select.value, 10) || 0;
        entry.buildGid = gid;
        entry.isNewBuild = true;
        // Extract actual slot number from "new_XX" key
        var slotMatch = cb.dataset.slot.match(/new_(\d+)/);
        if (slotMatch) entry.slot = parseInt(slotMatch[1], 10);
      }

      targets[cb.dataset.slot] = entry;
    }
  });
  return targets;
}

// ============================================================
// Config Collection & Population
// ============================================================

/**
 * Collect all form values into a single config object.
 */
function collectConfig() {
  return {
    enabled: true,
    autoResourceUpgrade: dom.togResourceUpgrade.checked,
    autoBuildingUpgrade: dom.togBuildingUpgrade.checked,
    autoTroopTraining: dom.togTroopTraining.checked,
    autoFarming: dom.togFarming.checked,
    autoHeroAdventure: dom.togHeroAdventure.checked,
    useAIScoring: dom.togAIScoring ? dom.togAIScoring.checked : true,
    autoTrapTraining: dom.togTrapTraining ? dom.togTrapTraining.checked : false,
    activeVillage: dom.villageSelect.value,
    upgradeTargets: collectUpgradeTargets(),
    scannedItems: {
      resources: scannedResources,
      buildings: scannedBuildings
    },
    troopConfig: {
      defaultTroopType: dom.troopType.value,
      trainCount: parseInt(dom.troopBatch.value, 10) || 5,
      trainingBuilding: 'barracks',
      minResourceThreshold: {
        wood: parseInt(dom.troopMinRes.value, 10) || 1000,
        clay: parseInt(dom.troopMinRes.value, 10) || 1000,
        iron: parseInt(dom.troopMinRes.value, 10) || 1000,
        crop: Math.round((parseInt(dom.troopMinRes.value, 10) || 1000) * 0.6),
      },
    },
    farmConfig: {
      enabled: dom.togFarming.checked,
      intervalMs: (parseInt(dom.farmInterval.value, 10) || 300) * 1000, // convert seconds to ms
      minTroops: parseInt(dom.farmMinTroops.value, 10) || 10,
      useRallyPointFarmList: dom.togUseFarmList.checked,
      smartFarming: dom.togSmartFarming.checked,
      minLoot: parseInt(dom.farmMinLoot.value, 10) || 30,
      skipLosses: dom.togSkipLosses.checked,
      scanMyX: dom.scanMyX && dom.scanMyX.value !== '' ? parseInt(dom.scanMyX.value, 10) : null,
      scanMyY: dom.scanMyY && dom.scanMyY.value !== '' ? parseInt(dom.scanMyY.value, 10) : null,
      scanRadius: parseInt(dom.scanRadius ? dom.scanRadius.value : '20', 10) || 20,
      scanMaxPop: parseInt(dom.scanMaxPop ? dom.scanMaxPop.value : '50', 10) || 50,
      scanIncludeOases: dom.togScanOases ? dom.togScanOases.checked : true,
      scanEmptyOasesOnly: dom.togScanEmptyOases ? dom.togScanEmptyOases.checked : true,
      scanSkipAlliance: dom.togScanSkipAlliance ? dom.togScanSkipAlliance.checked : true,
      scanTroopSlot: dom.scanTroopSlot ? dom.scanTroopSlot.value : 't1',
      scanTroopCount: parseInt(dom.scanTroopCount ? dom.scanTroopCount.value : '1', 10) || 1,
      targets: [...farmTargets],       // [{x, y, name?}] for send_attack (legacy mode)
    },
    heroConfig: {
      minHealth: parseInt(dom.heroMinHealth.value, 10) || 30,
    },
    trapConfig: {
      batchSize: parseInt(dom.trapBatchSize ? dom.trapBatchSize.value : '10', 10) || 10,
    },
    delays: {
      min: parseInt(dom.delayMin.value, 10) || 2000,
      max: parseInt(dom.delayMax.value, 10) || 8000,
    },
    safetyConfig: {
      maxActionsPerHour: parseInt(dom.maxActions.value, 10) || 60,
    },
  };
}

/**
 * Populate all form fields from a config object loaded from storage.
 */
function populateForm(config) {
  if (!config) return;

  // Feature toggles
  if (config.autoResourceUpgrade !== undefined) {
    dom.togResourceUpgrade.checked = config.autoResourceUpgrade;
  }
  if (config.autoBuildingUpgrade !== undefined) {
    dom.togBuildingUpgrade.checked = config.autoBuildingUpgrade;
  }
  if (config.autoTroopTraining !== undefined) {
    dom.togTroopTraining.checked = config.autoTroopTraining;
  }
  if (config.autoFarming !== undefined) {
    dom.togFarming.checked = config.autoFarming;
  }
  if (config.autoHeroAdventure !== undefined) {
    dom.togHeroAdventure.checked = config.autoHeroAdventure;
  }
    if (config.useAIScoring !== undefined && dom.togAIScoring) {
      dom.togAIScoring.checked = config.useAIScoring;
    }
    if (config.autoTrapTraining !== undefined && dom.togTrapTraining) {
      dom.togTrapTraining.checked = config.autoTrapTraining;
    }

  // Village
  if (config.activeVillage) {
    dom.villageSelect.value = config.activeVillage;
  }

  // Upgrade targets + scanned items
  if (config.scannedItems) {
    scannedResources = config.scannedItems.resources || [];
    scannedBuildings = config.scannedItems.buildings || [];
  }
  if (config.upgradeTargets) {
    upgradeTargets = config.upgradeTargets;
  }
  if (scannedResources.length > 0 || scannedBuildings.length > 0) {
    renderUpgradeList();
  }

  // Troop config
  if (config.troopConfig) {
    var tc = config.troopConfig;
    if (tc.defaultTroopType || tc.type) dom.troopType.value = tc.defaultTroopType || tc.type;
    if (tc.trainCount || tc.trainBatchSize) dom.troopBatch.value = tc.trainCount || tc.trainBatchSize;
    if (tc.minResourceThreshold && tc.minResourceThreshold.wood) {
      dom.troopMinRes.value = tc.minResourceThreshold.wood;
    } else if (tc.minResources) {
      dom.troopMinRes.value = tc.minResources;
    }
  }

  // Hero config
  if (config.heroConfig) {
    if (config.heroConfig.minHealth !== undefined) dom.heroMinHealth.value = config.heroConfig.minHealth;
  }

    // Trap config
    if (config.trapConfig && dom.trapBatchSize) {
      if (config.trapConfig.batchSize) dom.trapBatchSize.value = config.trapConfig.batchSize;
    }

  // Farm config
  if (config.farmConfig) {
    if (config.farmConfig.intervalMs) {
      dom.farmInterval.value = Math.round(config.farmConfig.intervalMs / 1000); // ms to seconds
    } else if (config.farmConfig.interval) {
      dom.farmInterval.value = Math.round(config.farmConfig.interval / 1000);
    }
    if (config.farmConfig.minTroops) dom.farmMinTroops.value = config.farmConfig.minTroops;
    if (config.farmConfig.useRallyPointFarmList !== undefined) {
      dom.togUseFarmList.checked = config.farmConfig.useRallyPointFarmList;
    }
    if (config.farmConfig.smartFarming !== undefined) {
      dom.togSmartFarming.checked = config.farmConfig.smartFarming;
    }
    if (config.farmConfig.minLoot !== undefined) {
      dom.farmMinLoot.value = config.farmConfig.minLoot;
    }
    if (config.farmConfig.skipLosses !== undefined) {
      dom.togSkipLosses.checked = config.farmConfig.skipLosses;
    }
    if (config.farmConfig.scanMyX != null && dom.scanMyX) {
      dom.scanMyX.value = config.farmConfig.scanMyX;
    }
    if (config.farmConfig.scanMyY != null && dom.scanMyY) {
      dom.scanMyY.value = config.farmConfig.scanMyY;
    }
    if (config.farmConfig.scanRadius !== undefined && dom.scanRadius) {
      dom.scanRadius.value = config.farmConfig.scanRadius;
    }
    if (config.farmConfig.scanMaxPop !== undefined && dom.scanMaxPop) {
      dom.scanMaxPop.value = config.farmConfig.scanMaxPop;
    }
    if (config.farmConfig.scanIncludeOases !== undefined && dom.togScanOases) {
      dom.togScanOases.checked = config.farmConfig.scanIncludeOases;
    }
    if (config.farmConfig.scanEmptyOasesOnly !== undefined && dom.togScanEmptyOases) {
      dom.togScanEmptyOases.checked = config.farmConfig.scanEmptyOasesOnly;
    }
    if (config.farmConfig.scanSkipAlliance !== undefined && dom.togScanSkipAlliance) {
      dom.togScanSkipAlliance.checked = config.farmConfig.scanSkipAlliance;
    }
    if (config.farmConfig.scanTroopSlot && dom.scanTroopSlot) {
      dom.scanTroopSlot.value = config.farmConfig.scanTroopSlot;
    }
    if (config.farmConfig.scanTroopCount && dom.scanTroopCount) {
      dom.scanTroopCount.value = config.farmConfig.scanTroopCount;
    }
    if (config.farmConfig.targets) {
      updateFarmTargets(config.farmConfig.targets);
    }
  }

  // Delay settings
  if (config.delays) {
    if (config.delays.min) dom.delayMin.value = config.delays.min;
    if (config.delays.max) dom.delayMax.value = config.delays.max;
  }

  // Safety config
  if (config.safetyConfig) {
    if (config.safetyConfig.maxActionsPerHour) {
      dom.maxActions.value = config.safetyConfig.maxActionsPerHour;
    }
  }
}

// ============================================================
// Farm Target Management
// ============================================================

/**
 * Add a new farm target from the X/Y input fields.
 */
function addFarmTarget() {
  const x = parseInt(dom.farmX.value, 10);
  const y = parseInt(dom.farmY.value, 10);
  const nameEl = document.getElementById('farmName');
  const name = nameEl ? nameEl.value.trim() : '';

  if (isNaN(x) || isNaN(y)) {
    return; // Silently ignore invalid input
  }

  // Check for duplicates
  const exists = farmTargets.some((t) => t.x === x && t.y === y);
  if (exists) return;

  farmTargets.push({ x, y, name: name || ('Farm ' + x + '|' + y) });
  updateFarmTargets(farmTargets);

  // Clear input fields
  dom.farmX.value = '';
  dom.farmY.value = '';
  if (nameEl) nameEl.value = '';
}

/**
 * Remove a farm target by index.
 */
function removeFarmTarget(index) {
  farmTargets.splice(index, 1);
  updateFarmTargets(farmTargets);
}

// ============================================================
// Save & Load Configuration
// ============================================================

/**
 * Save the full config to chrome.storage.local and notify the background.
 */
function saveAllConfig() {
  const config = collectConfig();
  var storageKey = currentServerKey ? 'bot_config__' + currentServerKey : 'bot_config';

  chrome.storage.local.set({ [storageKey]: config }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[Popup] Failed to save config:', chrome.runtime.lastError.message);
      return;
    }

    // Also send config to background service worker
    sendMessage({ type: 'SAVE_CONFIG', config })
      .then(() => {
        dom.btnSaveAll.textContent = 'Saved!';
        setTimeout(() => {
          dom.btnSaveAll.textContent = 'Save All Settings';
        }, 1500);
      })
      .catch(() => {
        dom.btnSaveAll.textContent = 'Save All Settings';
      });
  });
}

/**
 * Load configuration from chrome.storage.local.
 */
function loadConfig() {
  var storageKey = currentServerKey ? 'bot_config__' + currentServerKey : 'bot_config';

  chrome.storage.local.get([storageKey, 'bot_config'], (result) => {
    if (chrome.runtime.lastError) {
      console.warn('[Popup] Failed to load config:', chrome.runtime.lastError.message);
      return;
    }

    // Try per-server config first, then legacy fallback
    var config = result[storageKey] || result['bot_config'];
    if (config) {
      populateForm(config);
    }
  });
}

// ============================================================
// Refresh / Polling
// ============================================================

/**
 * Request the current bot status from the background and update the UI.
 */
function refreshStatus() {
  sendMessage({ type: 'GET_STATUS' })
    .then((response) => {
      if (response && response.success && response.data) {
        // Map botEngine.getStatus() format to UI format
        const s = response.data;
        let state = 'stopped';
        if (s.running && !s.paused) state = 'running';
        else if (s.running && s.paused) state = 'paused';
        else if (s.emergencyStopped) state = 'stopped';

        updateStatus({
          state: state,
          emergencyReason: s.emergencyReason || null, // SAF-5 FIX
          stats: {
            completed: s.stats ? s.stats.tasksCompleted : 0,
            failed: s.stats ? s.stats.tasksFailed : 0,
            startTime: s.stats ? s.stats.startTime : null,
            actionsPerHour: s.actionsThisHour || 0,
          },
          currentTask: s.taskQueue && s.taskQueue.tasks
            ? s.taskQueue.tasks.find(t => t.status === 'running')
            : null,
          villages: s.gameState ? s.gameState.villages : null,
        });

        // Update queue display
        if (s.taskQueue && s.taskQueue.tasks) {
          updateQueue(s.taskQueue.tasks);
        }

        // Auto-populate upgrade list from gameState (if not yet populated)
        if (s.gameState && scannedResources.length === 0 && scannedBuildings.length === 0) {
          applyScannedState(s.gameState);
        }

        // --- Dashboard game-state displays ---
        if (s.gameState) {
          updateResources(s.gameState);
          updateBuildQueue(s.gameState.constructionQueue);
          updateTroopSummary(s.gameState.troops);
        }
        updateNextAction(s.nextActionTime);
        if (s.stats) {
          updateFarmStats(s.stats);
        }

        // AI + Trapper + Quest status
        if (s.gameState) {
          updateTrapperStatus(s.gameState.trapperInfo || null);
          updateQuestDisplay(s.gameState.quests || null);
        }
        updateAIReason(s.lastAIAction || null);
      }
    })
    .catch(() => {
      stopRefreshInterval();
    });
}

/**
 * Fetch logs from background and update the viewer.
 */
function refreshLogs() {
  sendMessage({ type: 'GET_LOGS' })
    .then((response) => {
      if (response && response.success && response.data) {
        updateLogs(response.data);
      }
    })
    .catch(() => {
      // Silently ignore
    });
}

/**
 * Fetch the task queue from background and update the display.
 */
function refreshQueue() {
  sendMessage({ type: 'GET_QUEUE' })
    .then((response) => {
      if (response && response.success && response.data) {
        updateQueue(response.data);
      }
    })
    .catch(() => {
      // Silently ignore
    });
}

// ============================================================
// Strategy Dashboard
// ============================================================

/**
 * Fetch strategy analysis from background and render the dashboard.
 */
function refreshStrategy() {
  sendMessage({ type: 'GET_STRATEGY' })
    .then(function (response) {
      if (response && response.success && response.data) {
        renderStrategyDashboard(response.data);
      }
    })
    .catch(function () {
      // Silently ignore
    });
}

/**
 * Render the AI strategy dashboard with analysis data.
 * @param {{ analysis: object|null, phase: string }} data
 */
function renderStrategyDashboard(data) {
  var container = dom.strategyDashboard;
  if (!container) return;

  var analysis = data.analysis;
  var phase = data.phase || 'unknown';

  if (!analysis) {
    container.innerHTML = '<div class="strategy-placeholder">No analysis yet — bot needs to run a cycle first.</div>';
    return;
  }

  var html = '';

  // --- Phase + Focus header ---
  var phaseInfo = analysis.phaseDetection || {};
  var strategyInfo = analysis.phaseStrategy || {};
  var phaseName = (phaseInfo.phase || phase).toUpperCase();
  var phaseClass = 'phase-' + (phaseInfo.phase || phase);
  var confidence = phaseInfo.confidence || 0;
  var focus = strategyInfo.focus || '';

  html += '<div class="strategy-header">';
  html += '<span class="strategy-phase ' + phaseClass + '">' + phaseName + ' GAME</span>';
  if (focus) {
    html += '<span class="strategy-focus">' + focus + '</span>';
  }
  html += '<span class="strategy-confidence">' + confidence + '% confidence</span>';
  html += '</div>';

  // --- Metrics row: Bottleneck / Risk / Expansion ---
  var bottleneck = analysis.resourceOptimization && analysis.resourceOptimization.bottleneck;
  var risk = analysis.riskAssessment || {};
  var expansion = analysis.expansionTiming || {};

  html += '<div class="strategy-metrics">';

  // Bottleneck
  var bnText = 'N/A';
  if (bottleneck && bottleneck.bottleneck) {
    var bnRes = bottleneck.bottleneck;
    var bnPct = bottleneck.ratios ? bottleneck.ratios[bnRes] : 0;
    bnText = bnRes.charAt(0).toUpperCase() + bnRes.slice(1) + ' (' + bnPct + '%)';
  }
  html += '<div class="strategy-metric">';
  html += '<span class="metric-label">Bottleneck</span>';
  html += '<span class="metric-value bottleneck">' + bnText + '</span>';
  html += '</div>';

  // Risk
  var riskLevel = (risk.riskLevel || 'LOW').toUpperCase();
  var riskClass = 'risk-' + riskLevel.toLowerCase();
  html += '<div class="strategy-metric">';
  html += '<span class="metric-label">Risk</span>';
  html += '<span class="metric-value ' + riskClass + '">' + riskLevel + '</span>';
  html += '</div>';

  // Expansion
  var expScore = expansion.readinessScore || 0;
  html += '<div class="strategy-metric">';
  html += '<span class="metric-label">Expand</span>';
  html += '<span class="metric-value expansion">' + expScore + '%</span>';
  html += '</div>';

  html += '</div>';

  // --- AI Recommendations ---
  var recs = analysis.recommendations || [];
  if (recs.length > 0) {
    html += '<div class="strategy-recs">';
    html += '<div class="strategy-recs-title">AI Recommendations</div>';

    var showCount = Math.min(recs.length, 5);
    for (var i = 0; i < showCount; i++) {
      var r = recs[i];
      var cat = (r.category || 'build').toLowerCase();
      var badgeClass = 'cat-' + cat;

      html += '<div class="strategy-rec">';
      html += '<span class="rec-rank">#' + r.rank + '</span>';
      html += '<span class="rec-badge ' + badgeClass + '">' + (r.category || 'build') + '</span>';
      html += '<div class="rec-body">';
      html += '<div class="rec-action">' + escapeHtml(r.action || '') + '</div>';
      html += '<div class="rec-reason">' + escapeHtml(r.reason || '') + '</div>';
      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
  }

  container.innerHTML = html;
}

/**
 * Escape HTML special characters.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Full refresh: status, logs, queue, and strategy.
 */
function fullRefresh() {
  refreshStatus();
  refreshLogs();
  refreshQueue();
  refreshStrategy();
}

/**
 * Start the periodic refresh interval (every 2 seconds).
 */
function startRefreshInterval() {
  if (refreshInterval) return;
  refreshInterval = setInterval(fullRefresh, 2000);
}

/**
 * Stop the periodic refresh interval.
 */
function stopRefreshInterval() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// ============================================================
// Event Handlers
// ============================================================

/**
 * Bind all event listeners to DOM elements.
 */
function bindEvents() {
  // --- Tab navigation ---
  dom.tabButtons.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // --- Control buttons ---

  dom.btnStart.addEventListener('click', () => {
    sendMessage({ type: 'START_BOT' })
      .then((response) => {
        if (response) updateStatus(response);
        // SAF-5 FIX: Clear emergency reason on fresh start
        chrome.storage.local.remove('bot_emergency_stop');
      })
      .catch(console.warn);
  });

  dom.btnStop.addEventListener('click', () => {
    sendMessage({ type: 'STOP_BOT' })
      .then((response) => {
        if (response) updateStatus(response);
      })
      .catch(console.warn);
  });

  dom.btnPause.addEventListener('click', () => {
    sendMessage({ type: 'PAUSE_BOT' })
      .then((response) => {
        if (response) updateStatus(response);
      })
      .catch(console.warn);
  });

  dom.btnEmergency.addEventListener('click', () => {
    const confirmed = confirm(
      'EMERGENCY STOP will immediately halt all bot operations. Continue?'
    );
    if (!confirmed) return;

    sendMessage({ type: 'EMERGENCY_STOP' })
      .then((response) => {
        if (response) updateStatus(response);
      })
      .catch(console.warn);
  });

  // --- Save buttons ---

  dom.btnSaveAll.addEventListener('click', () => {
    saveAllConfig();
  });

  // Scan buildings button
  dom.btnScanBuildings.addEventListener('click', () => {
    scanBuildings();
  });

  // --- Farm targets ---

  dom.btnAddFarm.addEventListener('click', () => {
    addFarmTarget();
  });

  // Farm Target Scanner button
  if (dom.btnScanFarmTargets) {
    dom.btnScanFarmTargets.addEventListener('click', async function () {
      if (!currentServerKey) {
        if (dom.scanFarmResult) dom.scanFarmResult.textContent = 'No server selected';
        return;
      }

      // Save config first so scanner uses latest settings
      try {
        var config = collectConfig();
        await sendMessage({ type: 'SAVE_CONFIG', config: config });
      } catch (_) {}

      if (dom.scanFarmResult) dom.scanFarmResult.textContent = 'Scanning map...';
      dom.btnScanFarmTargets.disabled = true;

      try {
        var resp = await sendMessage({ type: 'SCAN_FARM_TARGETS' });
        if (resp && resp.success && resp.data) {
          if (dom.scanFarmResult) dom.scanFarmResult.textContent = resp.data.message || ('Found ' + resp.data.found + ', added ' + resp.data.added);
        } else {
          if (dom.scanFarmResult) dom.scanFarmResult.textContent = 'Error: ' + ((resp && resp.error) || 'Unknown error');
        }
      } catch (err) {
        if (dom.scanFarmResult) dom.scanFarmResult.textContent = 'Error: ' + err.message;
      } finally {
        dom.btnScanFarmTargets.disabled = false;
      }
    });
  }

  // --- Queue ---

  dom.btnClearQueue.addEventListener('click', () => {
    sendMessage({ type: 'CLEAR_QUEUE' })
      .then(() => {
        updateQueue([]);
      })
      .catch(console.warn);
  });

  // --- Logs ---

  dom.btnClearLogs.addEventListener('click', () => {
    currentLogs = [];
    dom.logViewer.innerHTML = '';
  });

  dom.logLevel.addEventListener('change', () => {
    renderFilteredLogs();
  });

  // --- Strategy refresh button ---
  if (dom.btnRefreshStrategy) {
    dom.btnRefreshStrategy.addEventListener('click', function () {
      dom.btnRefreshStrategy.textContent = '...';
      refreshStrategy();
      setTimeout(function () { dom.btnRefreshStrategy.textContent = 'Refresh'; }, 1000);
    });
  }

  // --- Feature toggles: immediate save on change ---

  const toggles = [
    dom.togResourceUpgrade,
    dom.togBuildingUpgrade,
    dom.togTroopTraining,
    dom.togFarming,
    dom.togHeroAdventure,
    dom.togUseFarmList,
    dom.togSmartFarming,
    dom.togSkipLosses,
  ];

  toggles.forEach((toggle) => {
    toggle.addEventListener('change', () => {
      const config = collectConfig();
      var storageKey = currentServerKey ? 'bot_config__' + currentServerKey : 'bot_config';
      chrome.storage.local.set({ [storageKey]: config }, () => {
        if (chrome.runtime.lastError) {
          console.warn('[Popup] Failed to save toggle:', chrome.runtime.lastError.message);
          return;
        }
        sendMessage({ type: 'SAVE_CONFIG', config }).catch(console.warn);
      });
    });
  });

  // --- Village selector ---

  dom.villageSelect.addEventListener('change', () => {
    const villageId = dom.villageSelect.value;
    if (villageId) {
      sendMessage({ type: 'SWITCH_VILLAGE', villageId }).catch(console.warn);
    }
  });
}

// ============================================================
// Server Detection & Selector
// ============================================================

/**
 * Extract server key from a URL (same logic as TravianStorage.extractServerKey).
 */
function extractServerKey(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

/**
 * Format a server hostname for display.
 * e.g. "ts5.x1.asia.travian.com" → "ts5 (Asia)"
 */
function formatServerLabel(key) {
  if (!key) return 'Unknown';
  var parts = key.split('.');
  var serverName = parts[0] || key; // e.g. "ts5"
  // Try to extract region
  var region = '';
  if (key.indexOf('.asia.') !== -1) region = 'Asia';
  else if (key.indexOf('.europe.') !== -1 || key.indexOf('.de') !== -1) region = 'EU';
  else if (key.indexOf('.us') !== -1) region = 'US';
  else if (key.indexOf('.co.uk') !== -1) region = 'UK';
  else if (key.indexOf('.com.br') !== -1) region = 'BR';
  else if (key.indexOf('.co.id') !== -1) region = 'ID';

  return region ? serverName + ' (' + region + ')' : serverName;
}

/**
 * Populate the server selector dropdown with known servers.
 */
function populateServerSelector(registry, activeKey) {
  if (!dom.serverSelect) return;

  dom.serverSelect.innerHTML = '';

  var servers = registry && registry.servers ? registry.servers : {};
  var keys = Object.keys(servers);

  // Sort by lastUsed (most recent first)
  keys.sort(function (a, b) {
    return (servers[b].lastUsed || 0) - (servers[a].lastUsed || 0);
  });

  // Always include the active key even if not in registry yet
  if (activeKey && keys.indexOf(activeKey) === -1) {
    keys.unshift(activeKey);
  }

  if (keys.length === 0) {
    var noOpt = document.createElement('option');
    noOpt.value = '';
    noOpt.textContent = 'No Server';
    dom.serverSelect.appendChild(noOpt);
    return;
  }

  keys.forEach(function (key) {
    var opt = document.createElement('option');
    opt.value = key;
    var label = (servers[key] && servers[key].label && servers[key].label !== key)
      ? servers[key].label
      : formatServerLabel(key);
    opt.textContent = label;
    opt.title = key;
    dom.serverSelect.appendChild(opt);
  });

  if (activeKey) {
    dom.serverSelect.value = activeKey;
  }
}

/**
 * Switch to a different server — reload config and status.
 */
function switchServer(newServerKey) {
  currentServerKey = newServerKey;
  console.log('[Popup] Switched to server: ' + currentServerKey);

  // Reset UI state
  scannedResources = [];
  scannedBuildings = [];
  upgradeTargets = {};

  // Reload config and status for the new server
  loadConfig();
  refreshStatus();
  refreshLogs();
  refreshQueue();
  refreshStrategy();
}

// ============================================================
// Initialization
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // Step 1: Detect server from the currently active Chrome tab
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    if (tabs && tabs.length > 0 && tabs[0].url) {
      var key = extractServerKey(tabs[0].url);
      if (key && /travian\.(com|de|co\.uk|us|net|cl|com\.br|co\.id|asia)/i.test(tabs[0].url)) {
        currentServerKey = key;
        console.log('[Popup] Detected server: ' + currentServerKey);
      }
    }

    // Step 2: Populate server selector from registry
    sendMessage({ type: 'GET_SERVERS' })
      .then(function (resp) {
        if (resp && resp.success && resp.data) {
          populateServerSelector(resp.data.registry, currentServerKey);
        }
      })
      .catch(function () {
        // If GET_SERVERS fails (e.g. old service worker), populate manually
        if (currentServerKey && dom.serverSelect) {
          var opt = document.createElement('option');
          opt.value = currentServerKey;
          opt.textContent = formatServerLabel(currentServerKey);
          dom.serverSelect.innerHTML = '';
          dom.serverSelect.appendChild(opt);
        }
      });

    // Step 3: Load config, bind events, start polling
    loadConfig();
    bindEvents();
    refreshStatus();

    // SAF-5 FIX: Read emergency stop reason from storage as fallback
    // (in case service worker died and in-memory reason is lost)
    chrome.storage.local.get(['bot_emergency_stop'], function (result) {
      var es = result && result.bot_emergency_stop;
      if (es && es.reason) {
        // Only show if bot is currently stopped (not running)
        var dot = dom.statusDot;
        if (dot && dot.className.indexOf('running') === -1) {
          var age = Date.now() - (es.timestamp || 0);
          // Only show if emergency was recent (< 1 hour)
          if (age < 3600000) {
            dom.statusText.textContent = 'Emergency: ' + es.reason;
            dom.statusText.title = es.reason + ' (' + new Date(es.timestamp).toLocaleTimeString() + ')';
          }
        }
      }
    });

    refreshLogs();
    refreshQueue();
    refreshStrategy();
    startRefreshInterval();
    updateFarmTargets(farmTargets);

    // Server selector change handler
    if (dom.serverSelect) {
      dom.serverSelect.addEventListener('change', function () {
        switchServer(dom.serverSelect.value);
      });
    }
  });
});

// Clean up intervals when popup closes
window.addEventListener('unload', () => {
  stopRefreshInterval();
  clearBuildQueueTimer();
});
