/**
 * Travian Bot — Tauri Frontend Controller
 * Replaces chrome.runtime.sendMessage → window.__TAURI__.invoke()
 * Replaces chrome.runtime.onMessage  → window.__TAURI__.event.listen()
 */

const { invoke } = window.__TAURI__.core;
const { listen }  = window.__TAURI__.event;

// ── Sanitize helper (escape HTML entities before any innerHTML use) ──
function s(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── DOM refs ────────────────────────────────────────────────
const dom = {
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  btnStart: document.getElementById('btnStart'),
  btnStop: document.getElementById('btnStop'),
  btnPause: document.getElementById('btnPause'),
  btnEmergency: document.getElementById('btnEmergency'),
  serverSelect: document.getElementById('serverSelect'),
  villageSelect: document.getElementById('villageSelect'),
  togHeadless: document.getElementById('togHeadless'),
  statCompleted: document.getElementById('statCompleted'),
  statFailed: document.getElementById('statFailed'),
  statUptime: document.getElementById('statUptime'),
  statRate: document.getElementById('statRate'),
  nextActionTimer: document.getElementById('nextActionTimer'),
  farmRaidStats: document.getElementById('farmRaidStats'),
  taskInfo: document.getElementById('taskInfo'),
  taskProgressFill: document.getElementById('taskProgressFill'),
  togResourceUpgrade: document.getElementById('togResourceUpgrade'),
  togBuildingUpgrade: document.getElementById('togBuildingUpgrade'),
  togTroopTraining: document.getElementById('togTroopTraining'),
  togFarming: document.getElementById('togFarming'),
  togHeroAdventure: document.getElementById('togHeroAdventure'),
  queueCount: document.getElementById('queueCount'),
  taskQueueList: document.getElementById('taskQueueList'),
  btnClearQueue: document.getElementById('btnClearQueue'),
  btnScanBuildings: document.getElementById('btnScanBuildings'),
  upgradeList: document.getElementById('upgradeList'),
  troopType: document.getElementById('troopType'),
  troopBatch: document.getElementById('troopBatch'),
  troopMinRes: document.getElementById('troopMinRes'),
  delayMin: document.getElementById('delayMin'),
  delayMax: document.getElementById('delayMax'),
  maxActions: document.getElementById('maxActions'),
  heroMinHealth: document.getElementById('heroMinHealth'),
  btnSaveAll: document.getElementById('btnSaveAll'),
  farmInterval: document.getElementById('farmInterval'),
  farmMinTroops: document.getElementById('farmMinTroops'),
  togUseFarmList: document.getElementById('togUseFarmList'),
  farmX: document.getElementById('farmX'),
  farmY: document.getElementById('farmY'),
  farmName: document.getElementById('farmName'),
  btnAddFarm: document.getElementById('btnAddFarm'),
  farmTargetList: document.getElementById('farmTargetList'),
  logLevel: document.getElementById('logLevel'),
  logViewer: document.getElementById('logViewer'),
  btnClearLogs: document.getElementById('btnClearLogs'),
  strategyDashboard: document.getElementById('strategyDashboard'),
  btnRefreshStrategy: document.getElementById('btnRefreshStrategy'),
  btnToggleBrowser: document.getElementById('btnToggleBrowser'),
  browserModeText: document.getElementById('browserModeText'),
  btnImportCookies: document.getElementById('btnImportCookies'),
  cookieStatus: document.getElementById('cookieStatus'),
  sideResWood: document.getElementById('sideResWood'),
  sideResClay: document.getElementById('sideResClay'),
  sideResIron: document.getElementById('sideResIron'),
  sideResCrop: document.getElementById('sideResCrop'),
  sideProdWood: document.getElementById('sideProdWood'),
  sideProdClay: document.getElementById('sideProdClay'),
  sideProdIron: document.getElementById('sideProdIron'),
  sideProdCrop: document.getElementById('sideProdCrop'),
  sideCapWarehouse: document.getElementById('sideCapWarehouse'),
  sideCapGranary: document.getElementById('sideCapGranary'),
  sideTroops: document.getElementById('sideTroops'),
  sideBuildQueue: document.getElementById('sideBuildQueue'),
  // Task 18 — Resource field grid & build plan
  resourceFieldGrid: document.getElementById('resourceFieldGrid'),
  btnCropAll5:       document.getElementById('btnCropAll5'),
  btnCropAll10:      document.getElementById('btnCropAll10'),
  buildPlanPreview:  document.getElementById('buildPlanPreview'),
  buildPlanList:     document.getElementById('buildPlanList'),
  bldFilterTabs:     document.getElementById('bldFilterTabs'),
};

// ── State ────────────────────────────────────────────────────
let currentServerKey = null;
let currentLogs = [];
let farmTargets = [];
let upgradeTargets = {};
let scannedBuildings = [];
let refreshTimer = null;

const GID_NAMES = {
  1:'Woodcutter',2:'Clay Pit',3:'Iron Mine',4:'Crop Field',
  5:'Sawmill',6:'Brickyard',7:'Iron Foundry',8:'Grain Mill',9:'Bakery',
  10:'Warehouse',11:'Granary',13:'Armoury',14:'Tournament Square',
  15:'Main Building',16:'Rally Point',17:'Marketplace',18:'Embassy',
  19:'Barracks',20:'Stable',21:'Workshop',22:'Academy',23:'Cranny',
  24:'Town Hall',25:'Residence',26:'Palace',36:'Trapper',
  37:"Hero's Mansion",45:'Hospital',
};

// ── Tab Navigation ───────────────────────────────────────────
const TAB_PANEL_MAP = {
  dash:'panelDash', config:'panelConfig', ai:'panelAI',
  farm:'panelFarm', logs:'panelLogs', settings:'panelSettings',
};
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p =>
    p.classList.toggle('active', p.id === TAB_PANEL_MAP[name]));
  if (name === 'logs') renderLogs();
  if (name === 'ai' && currentServerKey) refreshStrategy();
}

// ── Invoke helper ────────────────────────────────────────────
async function call(cmd, args) {
  try {
    return await invoke(cmd, args || {});
  } catch (err) {
    console.error('[App] invoke error:', cmd, err);
    return null;
  }
}

// ── Status ───────────────────────────────────────────────────
function applyStatus(status) {
  if (!status) return;
  const { running, paused, emergencyStopped } = status;

  dom.statusDot.className = 'status-dot' +
    (emergencyStopped ? ' error' : running ? (paused ? ' paused' : ' running') : '');
  dom.statusText.textContent =
    emergencyStopped ? 'EMERGENCY' : running ? (paused ? 'Paused' : 'Running') : 'Stopped';

  dom.btnStart.disabled   = running && !paused;
  dom.btnPause.disabled   = !running;
  dom.btnStop.disabled    = !running;
  dom.btnPause.textContent = paused ? '▶ Resume' : '⏸ Pause';

  if (status.stats) {
    dom.statCompleted.textContent = status.stats.tasksCompleted || 0;
    dom.statFailed.textContent    = status.stats.tasksFailed || 0;
    dom.statRate.textContent      = status.actionsThisHour || 0;
    dom.farmRaidStats.textContent = status.stats.farmRaidsSent || 0;
    if (status.stats.startTime) {
      const mins = Math.floor((Date.now() - status.stats.startTime) / 60000);
      dom.statUptime.textContent = mins < 60 ? mins + 'm' : Math.floor(mins/60) + 'h' + (mins%60) + 'm';
    }
  }
  if (status.nextActionTime) {
    const diff = Math.max(0, Math.ceil((status.nextActionTime - Date.now()) / 1000));
    dom.nextActionTimer.textContent = diff + 's';
  }
  if (status.taskQueue) {
    dom.queueCount.textContent = '(' + (status.taskQueue.pending || 0) + ')';
    renderQueue(status.taskQueue.tasks || []);
  }
  if (status.gameState) applyGameState(status.gameState);
  if (status.config)    applyConfig(status.config);
}

// ── Game State → Sidebar ─────────────────────────────────────
function applyGameState(gs) {
  if (!gs) return;
  const fmt = n => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
  const r = gs.resources;
  const prod = gs.resourceProduction;
  const cap  = gs.resourceCapacity;

  if (r) {
    dom.sideResWood.textContent = fmt(r.wood);
    dom.sideResClay.textContent = fmt(r.clay);
    dom.sideResIron.textContent = fmt(r.iron);
    dom.sideResCrop.textContent = fmt(r.crop);
  }
  if (prod && prod.length >= 4) {
    dom.sideProdWood.textContent = '+' + prod[0] + '/h';
    dom.sideProdClay.textContent = '+' + prod[1] + '/h';
    dom.sideProdIron.textContent = '+' + prod[2] + '/h';
    dom.sideProdCrop.textContent = (prod[3] >= 0 ? '+' : '') + prod[3] + '/h';
  }
  if (cap) {
    dom.sideCapWarehouse.textContent = cap.warehouse || '--';
    dom.sideCapGranary.textContent   = cap.granary || '--';
  }

  // Troops — use textContent per element (no innerHTML with dynamic data)
  dom.sideTroops.textContent = '';
  if (gs.troops && gs.troops.length) {
    gs.troops.forEach(t => {
      const div = document.createElement('div');
      div.textContent = (t.name || 'T' + t.id) + ': ' + (t.count || 0);
      dom.sideTroops.appendChild(div);
    });
  } else {
    dom.sideTroops.textContent = 'No data';
  }

  // Build queue
  dom.sideBuildQueue.textContent = '';
  const cq = gs.constructionQueue;
  if (cq && cq.items && cq.items.length) {
    cq.items.forEach(item => {
      const div = document.createElement('div');
      div.textContent = '⛏ ' + (item.name || 'Building') + ' → Lv' + (item.targetLevel || '?');
      dom.sideBuildQueue.appendChild(div);
    });
  } else {
    dom.sideBuildQueue.textContent = 'Empty';
  }

  // Resource field grid (Task 18)
  if (gs.resourceFields && gs.resourceFields.length) {
    renderResourceFieldGrid(gs.resourceFields);
  }
}

// ── Queue render ─────────────────────────────────────────────
function renderQueue(tasks) {
  dom.taskQueueList.textContent = '';
  if (!tasks || !tasks.length) {
    const span = document.createElement('span');
    span.className = 'text-muted-italic';
    span.textContent = 'Queue empty';
    dom.taskQueueList.appendChild(span);
    return;
  }
  tasks.slice(0, 15).forEach(t => {
    const row = document.createElement('div');
    row.className = 'queue-item';

    const badge = document.createElement('span');
    badge.className = 'queue-badge';
    badge.textContent = t.type || 'task';

    const pri = document.createElement('span');
    pri.textContent = t.priority || 0;

    const st = document.createElement('span');
    st.style.cssText = 'color:var(--text-muted);font-size:10px';
    st.textContent = t.status || '';

    row.appendChild(badge);
    row.appendChild(pri);
    row.appendChild(st);
    dom.taskQueueList.appendChild(row);
  });

  // Build plan preview: show upgrade tasks with estimated cost/time (Task 18)
  renderBuildPlanPreview(tasks);
}

// ── Logs ─────────────────────────────────────────────────────
function renderLogs() {
  const level = dom.logLevel.value;
  const entries = level === 'all' ? currentLogs : currentLogs.filter(l => l.level === level);
  const show = entries.slice(-200);

  dom.logViewer.textContent = '';
  show.forEach(l => {
    const div = document.createElement('div');
    div.className = 'log-entry ' + (l.level || 'INFO');
    const t = new Date(l.timestamp).toTimeString().slice(0, 8);
    div.textContent = '[' + t + '] [' + (l.level || '') + '] ' + (l.message || '');
    dom.logViewer.appendChild(div);
  });
  dom.logViewer.scrollTop = dom.logViewer.scrollHeight;
}

// ── Config ───────────────────────────────────────────────────
function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.delayMin)          dom.delayMin.value = cfg.delayMin;
  if (cfg.delayMax)          dom.delayMax.value = cfg.delayMax;
  if (cfg.maxActionsPerHour) dom.maxActions.value = cfg.maxActionsPerHour;
  dom.togResourceUpgrade.checked = !!(cfg.autoResourceUpgrade ?? cfg.autoUpgradeResources ?? true);
  dom.togBuildingUpgrade.checked = !!(cfg.autoBuildingUpgrade ?? cfg.autoUpgradeBuildings ?? true);
  dom.togTroopTraining.checked   = !!(cfg.autoTroopTraining ?? false);
  dom.togFarming.checked         = !!(cfg.autoFarm ?? false);
  dom.togHeroAdventure.checked   = !!(cfg.autoAdventure ?? true);
  if (cfg.heroMinHealth) dom.heroMinHealth.value = cfg.heroMinHealth;
  if (cfg.troopType)     dom.troopType.value = cfg.troopType;
  if (cfg.troopBatch)    dom.troopBatch.value = cfg.troopBatch;
  if (cfg.farmInterval)  dom.farmInterval.value = Math.floor(cfg.farmInterval / 1000);
  if (cfg.farmMinTroops) dom.farmMinTroops.value = cfg.farmMinTroops;
  dom.togUseFarmList.checked = !!(cfg.useFarmList ?? true);
  if (cfg.upgradeTargets) upgradeTargets = cfg.upgradeTargets;
}

function collectConfig() {
  return {
    delayMin: parseInt(dom.delayMin.value) || 2000,
    delayMax: parseInt(dom.delayMax.value) || 8000,
    maxActionsPerHour: parseInt(dom.maxActions.value) || 60,
    autoResourceUpgrade: dom.togResourceUpgrade.checked,
    autoUpgradeResources: dom.togResourceUpgrade.checked,
    autoBuildingUpgrade: dom.togBuildingUpgrade.checked,
    autoUpgradeBuildings: dom.togBuildingUpgrade.checked,
    autoTroopTraining: dom.togTroopTraining.checked,
    autoFarm: dom.togFarming.checked,
    autoAdventure: dom.togHeroAdventure.checked,
    heroMinHealth: parseInt(dom.heroMinHealth.value) || 30,
    troopType: dom.troopType.value,
    troopBatch: parseInt(dom.troopBatch.value) || 5,
    farmInterval: (parseInt(dom.farmInterval.value) || 300) * 1000,
    farmMinTroops: parseInt(dom.farmMinTroops.value) || 10,
    useFarmList: dom.togUseFarmList.checked,
    upgradeTargets,
  };
}

// ── Strategy panel ───────────────────────────────────────────
async function refreshStrategy() {
  if (!currentServerKey) return;
  const res = await call('get_strategy', { serverKey: currentServerKey });
  if (!res) return;
  const { analysis, phase } = res;

  dom.strategyDashboard.textContent = '';

  if (!analysis) {
    const p = document.createElement('div');
    p.className = 'strategy-placeholder';
    p.textContent = 'No analysis yet — start bot to generate.';
    dom.strategyDashboard.appendChild(p);
    return;
  }

  // Phase header
  const phaseEl = document.createElement('div');
  phaseEl.className = 'strategy-phase';
  phaseEl.textContent = 'Phase: ' + (phase || 'Unknown');
  dom.strategyDashboard.appendChild(phaseEl);

  // Metrics grid — built with DOM (safe)
  const metricsData = [
    { label: 'Bottleneck', value: analysis.bottleneck || '--' },
    { label: 'Risk', value: analysis.riskLevel || '--' },
    { label: 'Expand', value: analysis.expandReady ? '✓' : '✗' },
  ];
  const grid = document.createElement('div');
  grid.className = 'strategy-metrics';
  metricsData.forEach(m => {
    const cell = document.createElement('div');
    cell.className = 'strategy-metric';
    const lbl = document.createElement('div'); lbl.className = 'metric-label'; lbl.textContent = m.label;
    const val = document.createElement('div'); val.className = 'metric-value'; val.textContent = m.value;
    cell.appendChild(lbl); cell.appendChild(val);
    grid.appendChild(cell);
  });
  dom.strategyDashboard.appendChild(grid);

  // Recommendations
  const recs = document.createElement('div');
  recs.className = 'strategy-recs';
  (analysis.recommendations || []).slice(0, 5).forEach(r => {
    const item = document.createElement('div');
    item.className = 'strategy-rec-item';
    item.textContent = '• ' + (r.action || r);
    recs.appendChild(item);
  });
  dom.strategyDashboard.appendChild(recs);
}

// ── Server list ──────────────────────────────────────────────
async function loadServers() {
  const res = await call('get_servers');
  if (!res) return;
  const { instances = [], registry = {} } = res;
  const prev = currentServerKey;

  // Merge registry + running instances
  const servers = { ...registry };
  instances.forEach(inst => {
    if (!servers[inst.serverKey]) servers[inst.serverKey] = { label: inst.serverKey };
  });

  dom.serverSelect.textContent = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '-- Select Server --';
  dom.serverSelect.appendChild(placeholder);

  Object.entries(servers).forEach(([key, info]) => {
    const running = instances.some(i => i.serverKey === key && i.running);
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = (info.label || key) + (running ? ' ●' : '');
    dom.serverSelect.appendChild(opt);
  });

  if (prev && dom.serverSelect.querySelector('option[value="' + prev + '"]')) {
    dom.serverSelect.value = prev;
  }
}

// ── Upgrade list — defined later with category filter support (Task 18) ──

function syncUpgradeTarget(slot) {
  const cb  = dom.upgradeList.querySelector('[data-slot="' + slot + '"]');
  const inp = dom.upgradeList.querySelector('[data-slot-level="' + slot + '"]');
  if (cb && inp) upgradeTargets[slot] = { enabled: cb.checked, targetLevel: parseInt(inp.value) || 20 };
}

// ── Resource Field Grid render (Task 18) ─────────────────────
const RF_ICON = { wood: '🪵', clay: '🧱', iron: '⛏', crop: '🌾' };

function renderResourceFieldGrid(fields) {
  if (!dom.resourceFieldGrid) return;
  dom.resourceFieldGrid.textContent = '';

  // Sort by field ID (position 1–18)
  const sorted = [...fields].sort((a, b) => (a.id || 0) - (b.id || 0));

  sorted.forEach(f => {
    const type = (f.type || '').toLowerCase();
    const level = f.level || 0;
    const upgrading = !!f.upgrading;
    const fieldId = f.id || '?';

    const tile = document.createElement('div');
    tile.className = 'rf-tile' + (upgrading ? ' upgrading' : '');
    tile.dataset.type = type;
    tile.title = (type || 'field') + ' #' + fieldId + ' Lv' + level + (upgrading ? ' (upgrading)' : '') +
                 '\nClick to set as upgrade target';

    const idSpan = document.createElement('span');
    idSpan.className = 'rf-tile-id';
    idSpan.textContent = fieldId;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'rf-tile-icon';
    iconSpan.textContent = RF_ICON[type] || '?';

    const lvSpan = document.createElement('span');
    lvSpan.className = 'rf-tile-level';
    lvSpan.textContent = level;

    tile.appendChild(idSpan);
    tile.appendChild(iconSpan);
    tile.appendChild(lvSpan);

    // Click: toggle upgrade target for this field
    tile.addEventListener('click', () => {
      const key = 'rf_' + fieldId;
      const existing = upgradeTargets[key];
      if (existing && existing.enabled) {
        upgradeTargets[key] = { enabled: false, targetLevel: 20 };
        tile.classList.remove('targeted');
      } else {
        upgradeTargets[key] = { enabled: true, targetLevel: 20, fieldId: fieldId, type: type };
        tile.classList.add('targeted');
      }
    });

    // Mark targeted fields
    if (upgradeTargets['rf_' + fieldId] && upgradeTargets['rf_' + fieldId].enabled) {
      tile.classList.add('targeted');
    }

    dom.resourceFieldGrid.appendChild(tile);
  });
}

// ── Build Plan Preview render (Task 18) ──────────────────────
const TASK_LABEL = {
  upgrade_resource: '🪵 Upgrade field',
  upgrade_building: '🏛 Upgrade building',
  build_new: '🔨 Build new',
  train_troops: '⚔ Train troops',
  send_farm: '⚔ Farm raid',
  claim_quest: '📜 Claim quest',
  send_hero_adventure: '🗡 Hero adventure',
};

function renderBuildPlanPreview(tasks) {
  if (!dom.buildPlanPreview || !dom.buildPlanList) return;
  const buildTasks = (tasks || []).filter(t =>
    ['upgrade_resource', 'upgrade_building', 'build_new'].includes(t.type)
  );
  if (!buildTasks.length) {
    dom.buildPlanPreview.style.display = 'none';
    return;
  }
  dom.buildPlanPreview.style.display = 'block';
  dom.buildPlanList.textContent = '';

  buildTasks.slice(0, 8).forEach((t, i) => {
    const item = document.createElement('div');
    item.className = 'build-plan-item';

    const seq = document.createElement('span');
    seq.className = 'build-plan-seq';
    seq.textContent = (i + 1) + '.';

    const name = document.createElement('span');
    name.className = 'build-plan-name';
    const label = TASK_LABEL[t.type] || t.type;
    const extra = t.params
      ? (t.params.buildingName ? ' ' + t.params.buildingName
        : t.params.troopType ? ' ' + t.params.troopType
        : t.params.slot ? ' slot ' + t.params.slot : '')
      : '';
    name.textContent = label + extra;

    const st = document.createElement('span');
    st.className = 'build-plan-eta';
    st.textContent = t.status || 'pending';

    item.appendChild(seq);
    item.appendChild(name);
    item.appendChild(st);
    dom.buildPlanList.appendChild(item);
  });
}

// ── Farm targets ─────────────────────────────────────────────
function renderFarmTargets() {
  dom.farmTargetList.textContent = '';
  farmTargets.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'queue-item';

    const coord = document.createElement('span');
    coord.textContent = '(' + t.x + '|' + t.y + ')';

    const name = document.createElement('span');
    name.style.flex = '1';
    name.textContent = t.name;

    const del = document.createElement('button');
    del.className = 'btn-icon';
    del.textContent = '✕';
    del.addEventListener('click', () => {
      farmTargets.splice(i, 1);
      renderFarmTargets();
    });

    row.appendChild(coord); row.appendChild(name); row.appendChild(del);
    dom.farmTargetList.appendChild(row);
  });
}

// ── Poll status ──────────────────────────────────────────────
async function pollStatus() {
  if (!currentServerKey) return;
  const status = await call('get_status', { serverKey: currentServerKey });
  if (status) applyStatus(status);
}

function startPolling() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(pollStatus, 2000);
}

// ── Real-time events ─────────────────────────────────────────
listen('sidecar:botEvent', e => {
  const { serverKey, event: ev, data } = e.payload || {};
  if (serverKey !== currentServerKey) return;
  if (ev === 'statusUpdate' && data) applyStatus(data);
});

listen('sidecar:log', e => {
  const entry = e.payload;
  if (!entry) return;
  currentLogs.push(entry);
  if (currentLogs.length > 500) currentLogs = currentLogs.slice(-500);
  const activeTab = document.querySelector('.tab-btn.active');
  if (activeTab && activeTab.dataset.tab === 'logs') renderLogs();
});

listen('sidecar:gameState', e => {
  const { data } = e.payload || {};
  if (data) applyGameState(data);
});

listen('sidecar:ready', () => {
  console.log('[App] Sidecar ready');
  loadServers();
});

// ── Button listeners ──────────────────────────────────────────
dom.serverSelect.addEventListener('change', async () => {
  currentServerKey = dom.serverSelect.value || null;
  if (!currentServerKey) return;
  await pollStatus();
  const cfg = await call('get_config', { serverKey: currentServerKey });
  if (cfg) applyConfig(cfg);
});

dom.btnStart.addEventListener('click', async () => {
  if (!currentServerKey) { alert('Select a server first'); return; }
  const res = await call('start_bot', { serverKey: currentServerKey });
  if (res) applyStatus(res);
});

dom.btnStop.addEventListener('click', async () => {
  if (!currentServerKey) return;
  const res = await call('stop_bot', { serverKey: currentServerKey });
  if (res) applyStatus(res);
});

dom.btnPause.addEventListener('click', async () => {
  if (!currentServerKey) return;
  await call('pause_bot', { serverKey: currentServerKey });
  await pollStatus();
});

dom.btnEmergency.addEventListener('click', async () => {
  if (!confirm('Emergency stop ALL bots?')) return;
  await call('emergency_stop', { reason: 'User triggered emergency stop' });
  location.reload();
});

dom.btnClearQueue.addEventListener('click', async () => {
  if (!currentServerKey) return;
  await call('clear_queue', { serverKey: currentServerKey });
  renderQueue([]);
  dom.queueCount.textContent = '(0)';
});

dom.btnSaveAll.addEventListener('click', async () => {
  if (!currentServerKey) { alert('Select a server first'); return; }
  await call('save_config', { serverKey: currentServerKey, config: collectConfig() });
  dom.btnSaveAll.textContent = '✓ Saved!';
  setTimeout(() => { dom.btnSaveAll.textContent = '💾 Save All Settings'; }, 2000);
});

dom.btnClearLogs.addEventListener('click', async () => {
  await call('clear_logs');
  currentLogs = [];
  renderLogs();
});

dom.logLevel.addEventListener('change', renderLogs);

dom.btnRefreshStrategy.addEventListener('click', refreshStrategy);

dom.btnScanBuildings.addEventListener('click', async () => {
  if (!currentServerKey) return;
  dom.btnScanBuildings.textContent = 'Scanning…';
  const gs = await call('request_scan', { serverKey: currentServerKey });
  dom.btnScanBuildings.textContent = 'Scan';
  if (!gs) return;
  scannedBuildings = gs.buildings || [];
  renderUpgradeList(scannedBuildings);
  if (gs) applyGameState(gs);
});

dom.btnToggleBrowser.addEventListener('click', async () => {
  const res = await call('toggle_browser', {});
  if (res) dom.browserModeText.textContent = res.headless ? 'Headless (hidden)' : 'Headed (visible)';
});

dom.togHeadless.addEventListener('change', async () => {
  const res = await call('toggle_browser', { headless: !dom.togHeadless.checked });
  if (res) dom.browserModeText.textContent = res.headless ? 'Headless (hidden)' : 'Headed (visible)';
});

dom.btnImportCookies.addEventListener('click', async () => {
  const sk = currentServerKey;
  if (!sk) {
    dom.cookieStatus.textContent = '⚠ Select a server first.';
    return;
  }
  dom.btnImportCookies.disabled = true;
  dom.cookieStatus.textContent = '⏳ Reading Chrome cookies…';
  try {
    // Step 1: read + decrypt cookies from Chrome's SQLite DB
    const res = await call('import_chrome_cookies', {});
    if (!res || !res.cookies || res.cookies.length === 0) {
      dom.cookieStatus.textContent = '⚠ No Travian cookies found in Chrome.';
      return;
    }
    // Step 2: inject into the active Puppeteer page for this server
    await call('set_cookies', { serverKey: sk, cookies: res.cookies });
    dom.cookieStatus.textContent = `✅ Imported ${res.count} cookies. Reload the bot page to log in.`;
  } catch (e) {
    dom.cookieStatus.textContent = '✕ Import failed: ' + (e.message || String(e));
  } finally {
    dom.btnImportCookies.disabled = false;
  }
});

dom.btnAddFarm.addEventListener('click', () => {
  const x = parseInt(dom.farmX.value);
  const y = parseInt(dom.farmY.value);
  if (isNaN(x) || isNaN(y)) return;
  const name = dom.farmName.value.trim() || '(' + x + '|' + y + ')';
  farmTargets.push({ x, y, name });
  dom.farmX.value = '';
  dom.farmY.value = '';
  dom.farmName.value = '';
  renderFarmTargets();
});

// ── Resource field quick-actions (Task 18) ───────────────────
// "Set all crop fields to level X" — updates upgradeTargets for all crop resource fields
function setAllCropTarget(level) {
  // Iterate tiles in the grid
  const tiles = dom.resourceFieldGrid ? dom.resourceFieldGrid.querySelectorAll('.rf-tile[data-type="crop"]') : [];
  tiles.forEach(tile => {
    const fieldId = tile.querySelector('.rf-tile-id') && tile.querySelector('.rf-tile-id').textContent;
    if (!fieldId) return;
    const key = 'rf_' + fieldId;
    upgradeTargets[key] = { enabled: true, targetLevel: level, fieldId: parseInt(fieldId), type: 'crop' };
    tile.classList.add('targeted');
  });
}

if (dom.btnCropAll5)  dom.btnCropAll5.addEventListener('click',  () => setAllCropTarget(5));
if (dom.btnCropAll10) dom.btnCropAll10.addEventListener('click', () => setAllCropTarget(10));

// ── Building category filter (Task 18) ───────────────────────
const BLD_CATEGORIES = {
  economy:        [5, 6, 7, 8, 9, 10, 11, 17],      // sawmill, brickyard, iron foundry, grain mill, bakery, warehouse, granary, marketplace
  military:       [14, 16, 19, 20, 21, 22, 37, 45],  // tournament sq, rally point, barracks, stable, workshop, academy, hero's mansion, hospital
  defense:        [36],                               // trapper (gaul)
  infrastructure: [15, 18, 24, 25, 26, 23],          // main building, embassy, town hall, residence, palace, cranny
};

function getCategoryForGid(gid) {
  for (const [cat, gids] of Object.entries(BLD_CATEGORIES)) {
    if (gids.includes(Number(gid))) return cat;
  }
  return 'infrastructure';  // default bucket
}

// Track active filter
let activeBldFilter = 'all';

if (dom.bldFilterTabs) {
  dom.bldFilterTabs.addEventListener('click', e => {
    const btn = e.target.closest('.bld-filter');
    if (!btn) return;
    dom.bldFilterTabs.querySelectorAll('.bld-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeBldFilter = btn.dataset.cat || 'all';
    renderUpgradeList(scannedBuildings);
  });
}

// Full renderUpgradeList with category filter and grouped headers
function renderUpgradeList(buildings) {
  dom.upgradeList.textContent = '';
  if (!buildings || !buildings.length) {
    const empty = document.createElement('div');
    empty.className = 'upgrade-empty';
    empty.textContent = 'No buildings found — click Scan on a Travian page.';
    dom.upgradeList.appendChild(empty);
    return;
  }

  // Filter by category if not 'all'
  let filtered = buildings;
  if (activeBldFilter !== 'all') {
    filtered = buildings.filter(b => getCategoryForGid(b.gid || b.id) === activeBldFilter);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'upgrade-empty';
      empty.textContent = 'No ' + activeBldFilter + ' buildings found.';
      dom.upgradeList.appendChild(empty);
      return;
    }
  }

  // Group by category and insert headers
  const groups = {};
  filtered.forEach(b => {
    const cat = getCategoryForGid(b.gid || b.id);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(b);
  });

  const catOrder = ['economy', 'military', 'defense', 'infrastructure'];
  const catLabel  = { economy: '💰 Economy', military: '⚔ Military', defense: '🛡 Defense', infrastructure: '🏗 Infrastructure' };

  const catsToShow = activeBldFilter === 'all'
    ? catOrder.filter(c => groups[c])
    : [activeBldFilter];

  catsToShow.forEach(cat => {
    if (!groups[cat]) return;

    if (activeBldFilter === 'all') {
      const hdr = document.createElement('div');
      hdr.className = 'upgrade-category-header';
      hdr.textContent = catLabel[cat] || cat;
      dom.upgradeList.appendChild(hdr);
    }

    groups[cat].forEach(b => {
      const slot   = b.slot !== undefined ? b.slot : (b.id || '?');
      const name   = b.name || GID_NAMES[b.gid || b.id] || 'Bld ' + slot;
      const level  = b.level || 0;
      const target = upgradeTargets[slot] || { enabled: false, targetLevel: 20 };

      const row = document.createElement('div');
      row.className = 'upgrade-row';

      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.slot = slot;
      cb.checked = !!target.enabled;
      cb.addEventListener('change', () => syncUpgradeTarget(slot));

      const label = document.createElement('label');
      label.textContent = name + ' (Lv' + level + ')';
      label.style.flex = '1';
      label.style.cursor = 'pointer';
      label.addEventListener('click', () => { cb.checked = !cb.checked; syncUpgradeTarget(slot); });

      const lvInput = document.createElement('input');
      lvInput.type = 'number';
      lvInput.dataset.slotLevel = slot;
      lvInput.value = target.targetLevel;
      lvInput.min = 1; lvInput.max = 20;
      lvInput.style.width = '55px';
      lvInput.addEventListener('change', () => syncUpgradeTarget(slot));

      row.appendChild(cb);
      row.appendChild(label);
      row.appendChild(lvInput);
      dom.upgradeList.appendChild(row);
    });
  });
}

// ── Init ─────────────────────────────────────────────────────
(async function init() {
  await loadServers();
  startPolling();
  const logs = await call('get_logs', {});
  if (logs) { currentLogs = logs; }
})();
