/**
 * TRAVIAN CTRL — Dashboard Controller (Mission Control)
 *
 * Full-page command centre.  Maps getStatus() to all views.
 * Polls every 1 s.  Depends on shared/{constants,formatters,ui-client}.js.
 */

const App = {
  /* ── State ──────────────────────────────────── */
  serverKey: null,
  status: null,
  logs: [],
  configLoaded: false,
  currentView: 'overview',
  pollTimer: null,
  lastLogFetch: 0,

  /* ═══════════════════════════════════════════════ */
  /*  BOOT                                          */
  /* ═══════════════════════════════════════════════ */

  async init() {
    window.onerror = (msg, url, line, col, err) => {
      console.error('[Dashboard] Global error:', msg, err);
      return false;
    };

    try {
      this.setupNav();
      this.setupControls();
      await this.detectServer();
      this.startPolling();
    } catch (err) {
      console.error('[Dashboard] Init failed', err);
      var banner = document.getElementById('fatalBanner');
      var msg = document.getElementById('fatalMsg');
      if (banner && msg) {
        banner.classList.remove('hidden');
        msg.textContent = err.message;
      }
    }
  },

  /* ── Navigation ─────────────────────────────── */
  setupNav() {
    var links = document.querySelectorAll('.sb-link');
    var self = this;
    links.forEach(function(link) {
      link.addEventListener('click', function(e) {
        e.preventDefault();
        self.navigate(this.dataset.view);
      });
    });

    // Card-level nav links
    document.querySelectorAll('[data-nav]').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.preventDefault();
        self.navigate(this.dataset.nav);
      });
    });
  },

  navigate(viewId) {
    document.querySelectorAll('.sb-link').forEach(function(el) { el.classList.remove('active'); });
    var activeLink = document.querySelector('.sb-link[data-view="' + viewId + '"]');
    if (activeLink) activeLink.classList.add('active');

    document.querySelectorAll('.view').forEach(function(el) { el.classList.remove('active'); });
    var activeView = document.getElementById('view-' + viewId);
    if (activeView) activeView.classList.add('active');

    this.currentView = viewId;
    if (viewId === 'logs') this.fetchLogs();
  },

  /* ── Controls ───────────────────────────────── */
  setupControls() {
    var self = this;
    var btn = function(id) { return document.getElementById(id); };

    btn('btnStart').addEventListener('click', function() { self.action('start'); });
    btn('btnStop').addEventListener('click', function() { self.action('stop'); });
    btn('btnPause').addEventListener('click', function() { self.action('pause'); });
    btn('btnResume').addEventListener('click', function() { self.action('resume'); });
    btn('btnEmergency').addEventListener('click', function() { self.action('emergency'); });
    btn('btnClearQueue').addEventListener('click', function() { self.action('clearQueue'); });
    btn('btnSaveConfig').addEventListener('click', function() { self.saveConfig(); });
    btn('btnRefreshLogs').addEventListener('click', function() { self.fetchLogs(); });

    // Farm interval slider
    var slider = document.getElementById('cfgFarmInterval');
    var sliderVal = document.getElementById('cfgFarmIntervalVal');
    if (slider && sliderVal) {
      slider.addEventListener('input', function() { sliderVal.textContent = this.value + ' min'; });
    }
  },

  /* ── Server detection ───────────────────────── */
  async detectServer() {
    try {
      var resp = await UIClient.getServers();
      if (!resp || !resp.success || !resp.data) return;

      var instances = resp.data.instances || [];
      var rawRegistry = resp.data.registry || {};
      // Defensive: handle both shapes — flat server map OR { servers: {...}, version }
      var registry = (rawRegistry.servers && typeof rawRegistry.servers === 'object')
        ? rawRegistry.servers : rawRegistry;
      var select = document.getElementById('serverSelect');
      select.innerHTML = '';

      var keys = Object.keys(registry).filter(function(k) {
        // Exclude internal wrapper keys like 'version', 'servers'
        return k !== 'version' && k !== 'servers';
      });
      if (keys.length === 0 && instances.length === 0) {
        select.innerHTML = '<option value="">No servers — open a Travian tab</option>';
        return;
      }

      keys.forEach(function(key) {
        var opt = document.createElement('option');
        opt.value = key;
        opt.textContent = formatServerLabel(key);
        select.appendChild(opt);
      });

      instances.forEach(function(inst) {
        if (keys.indexOf(inst.serverKey) === -1) {
          var opt = document.createElement('option');
          opt.value = inst.serverKey;
          opt.textContent = formatServerLabel(inst.serverKey);
          select.appendChild(opt);
        }
      });

      if (instances.length > 0) {
        this.serverKey = instances[0].serverKey;
      } else if (keys.length > 0) {
        this.serverKey = keys[0];
      }

      if (this.serverKey) select.value = this.serverKey;

      var self = this;
      select.onchange = function() {
        self.serverKey = this.value;
        self.configLoaded = false;
        self.poll();
      };
    } catch (e) {
      console.warn('[Dashboard] detectServer failed', e);
    }
  },

  /* ── Polling ────────────────────────────────── */
  startPolling() {
    var self = this;
    this.poll();
    this.pollTimer = setInterval(function() { self.poll(); }, 1000);
  },

  async poll() {
    if (!this.serverKey) { await this.detectServer(); return; }
    try {
      var resp = await UIClient.getStatus(this.serverKey);
      if (resp && resp.success && resp.data) {
        this.status = resp.data;
        this.render();
      }
    } catch (e) {
      console.error('[Dashboard] Poll failed', e);
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER DISPATCHER                             */
  /* ═══════════════════════════════════════════════ */

  render() {
    var s = this.status;
    if (!s) return;
    var state = deriveBotState(s);

    this.renderCmdBar(s, state);

    switch (this.currentView) {
      case 'overview':    this.renderOverview(s, state); break;
      case 'tasks':       this.renderTasks(s); break;
      case 'strategy':    this.renderStrategy(s); break;
      case 'config':
        if (!this.configLoaded && s.config) { this.bindConfig(s.config); this.configLoaded = true; }
        this.renderUpgradeTargets(s);
        break;
      case 'diagnostics': this.renderDiagnostics(s); break;
      case 'debug':       this.renderDebug(s); break;
    }

    // Nav badge
    var badge = document.getElementById('navQueueCount');
    var queueLen = 0;
    if (s.taskQueue && s.taskQueue.tasks) queueLen = s.taskQueue.tasks.length;
    badge.textContent = queueLen;

    // Throttled log fetch for overview/logs
    if ((this.currentView === 'overview' || this.currentView === 'logs') && Date.now() - this.lastLogFetch > 3000) {
      this.fetchLogs();
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  COMMAND BAR                                   */
  /* ═══════════════════════════════════════════════ */

  renderCmdBar(s, state) {
    var el = document.getElementById('globalStatus');
    var dot = el.querySelector('.cmd-dot');
    var label = el.querySelector('.cmd-state');

    el.className = 'cmd-status ' + state;

    if (s.emergencyStopped) {
      label.textContent = 'EMERGENCY STOP';
    } else if (state === 'running') {
      var fsm = FSM_LABELS[s.botState] || s.botState || 'Running';
      label.textContent = fsm;
    } else if (state === 'paused') {
      label.textContent = 'Paused';
    } else {
      label.textContent = 'Stopped';
    }

    // Buttons
    var show = function(id, v) { document.getElementById(id).classList.toggle('hidden', !v); };
    if (state === 'running') {
      show('btnStart', false); show('btnStop', true); show('btnPause', true); show('btnResume', false);
    } else if (state === 'paused') {
      show('btnStart', false); show('btnStop', true); show('btnPause', false); show('btnResume', true);
    } else {
      show('btnStart', true); show('btnStop', false); show('btnPause', false); show('btnResume', false);
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  OVERVIEW                                      */
  /* ═══════════════════════════════════════════════ */

  renderOverview(s, state) {
    var id = function(x) { return document.getElementById(x); };

    // Hero card
    if (s.emergencyStopped) {
      id('ovHeroTitle').textContent = 'Emergency Stop';
      id('ovHeroDesc').textContent = s.emergencyReason || 'Critical failure';
    } else if (state === 'running') {
      id('ovHeroTitle').textContent = 'Active — ' + (FSM_LABELS[s.botState] || s.botState);
      id('ovHeroDesc').textContent = s.cycleId ? 'Cycle ' + s.cycleId : 'Running...';
    } else if (state === 'paused') {
      id('ovHeroTitle').textContent = 'Paused';
      id('ovHeroDesc').textContent = 'Bot is paused';
    } else {
      id('ovHeroTitle').textContent = 'Bot is Idle';
      id('ovHeroDesc').textContent = 'Waiting for commands...';
    }

    // FSM detail
    if (s.botState && state === 'running') {
      id('ovHeroFSM').textContent = 'FSM: ' + s.botState + (s.executionLocked ? ' [LOCKED]' : '');
    } else {
      id('ovHeroFSM').textContent = '';
    }

    // Stats
    var stats = s.stats || {};
    id('ovUptime').textContent = stats.startTime ? formatUptime(Date.now() - stats.startTime) : '--';
    id('ovTasksDone').textContent = formatNumber(stats.tasksCompleted || 0);
    id('ovFarmsSent').textContent = formatNumber(stats.farmRaidsSent || 0);
    id('ovActionsHr').textContent = s.actionsThisHour || 0;

    // Next Action
    this.renderNextAction(s);

    // Resources
    this.renderResources(s);

    // AI Decision
    this.renderAICard(s);

    // Activity (from cached logs)
    this.renderRecentActivity();
  },

  renderNextAction(s) {
    var timer = document.getElementById('ovNextTimer');
    var desc = document.getElementById('ovNextDesc');
    var ring = document.getElementById('nextRing');

    if (s.nextActionTime && s.nextActionTime > Date.now()) {
      var remaining = s.nextActionTime - Date.now();
      timer.textContent = formatCountdown(remaining);
      desc.textContent = 'Next cycle';

      // Ring progress (assume max 5 min cycle)
      var maxMs = 300000;
      var pct = Math.max(0, Math.min(100, (1 - remaining / maxMs) * 100));
      ring.setAttribute('stroke-dasharray', pct + ', 100');
    } else if (s.running && !s.paused) {
      timer.textContent = 'NOW';
      desc.textContent = 'Processing...';
      ring.setAttribute('stroke-dasharray', '100, 100');
    } else {
      timer.textContent = '--:--';
      desc.textContent = 'No tasks scheduled';
      ring.setAttribute('stroke-dasharray', '0, 100');
    }
  },

  renderResources(s) {
    var gs = s.gameState;
    if (!gs || !gs.resources) {
      // No game state — show placeholder values
      this._setOvRes('Wood', 0, 1, 0);
      this._setOvRes('Clay', 0, 1, 0);
      this._setOvRes('Iron', 0, 1, 0);
      this._setOvRes('Crop', 0, 1, 0);
      document.getElementById('ovVillageName').textContent = 'No data — start bot';
      return;
    }

    var res = gs.resources;
    var cap = gs.capacity || {};
    var prod = gs.production || {};
    var wh = cap.warehouse || 1;
    var gr = cap.granary || 1;

    this._setOvRes('Wood', res.wood || 0, wh, prod.wood || 0);
    this._setOvRes('Clay', res.clay || 0, wh, prod.clay || 0);
    this._setOvRes('Iron', res.iron || 0, wh, prod.iron || 0);
    this._setOvRes('Crop', res.crop || 0, gr, prod.crop || 0);

    // Village name
    if (gs.villages) {
      var active = null;
      for (var i = 0; i < gs.villages.length; i++) {
        if (gs.villages[i].id === gs.activeVillageId) { active = gs.villages[i]; break; }
      }
      document.getElementById('ovVillageName').textContent = active ? active.name : '--';
    } else {
      document.getElementById('ovVillageName').textContent = '--';
    }
  },

  _setOvRes(name, amount, capacity, production) {
    var bar = document.getElementById('ovBar' + name);
    var val = document.getElementById('ovVal' + name);
    var prod = document.getElementById('ovProd' + name);

    if (capacity <= 1 && amount === 0) {
      // No data state
      bar.style.width = '0%';
      bar.classList.remove('overflow');
      val.textContent = '--';
      prod.textContent = '--';
      return;
    }

    var pct = Math.min(100, Math.round((amount / capacity) * 100));
    bar.style.width = pct + '%';
    if (pct >= 90) { bar.classList.add('overflow'); } else { bar.classList.remove('overflow'); }
    val.textContent = formatNumber(amount) + ' / ' + formatNumber(capacity);
    prod.textContent = formatNumber(production) + '/h';
  },

  renderAICard(s) {
    var score = document.getElementById('ovAiScore');
    var type = document.getElementById('ovAiType');
    var reason = document.getElementById('ovAiReason');

    if (s.lastAIAction) {
      score.textContent = s.lastAIAction.score != null ? s.lastAIAction.score : '--';
      type.textContent = TASK_TYPE_NAMES[s.lastAIAction.type] || s.lastAIAction.type || '--';
      reason.textContent = s.lastAIAction.reason || 'No reason given';
    } else if (!s.running) {
      score.textContent = '--';
      type.textContent = 'Idle';
      reason.textContent = 'Start bot to enable AI decisions';
    } else {
      score.textContent = '--';
      type.textContent = '--';
      reason.textContent = 'Waiting for first scan...';
    }
  },

  renderRecentActivity() {
    var container = document.getElementById('ovActivityList');
    var toShow = this.logs.slice(-6).reverse();
    if (toShow.length === 0) {
      container.innerHTML = '<div class="activity-empty">No activity yet</div>';
      return;
    }
    container.innerHTML = toShow.map(function(l) {
      var ts = new Date(l.timestamp).toLocaleTimeString();
      return '<div class="act-row">' +
        '<span class="act-ts">' + ts + '</span>' +
        '<span class="act-lvl ' + l.level + '">' + l.level + '</span>' +
        '<span class="act-msg">' + escapeHtml(l.message) + '</span>' +
        '</div>';
    }).join('');
  },

  /* ═══════════════════════════════════════════════ */
  /*  TASKS                                         */
  /* ═══════════════════════════════════════════════ */

  renderTasks(s) {
    var list = document.getElementById('taskList');
    var tasks = (s.taskQueue && s.taskQueue.tasks) ? s.taskQueue.tasks : [];

    if (tasks.length === 0) {
      list.innerHTML = '<div class="empty-state">No tasks queued</div>';
      return;
    }

    var self = this;
    list.innerHTML = tasks.map(function(t) {
      var name = TASK_TYPE_NAMES[t.type] || t.type;
      var meta = 'P' + t.priority;
      if (t.villageId) meta += ' &middot; Village ' + t.villageId;
      if (t.retries > 0) meta += ' &middot; Retry ' + t.retries;
      if (t.status === 'pending' && t.scheduledFor) {
        var rem = t.scheduledFor - Date.now();
        meta += ' &middot; ' + (rem > 0 ? formatCountdown(rem) : 'NOW');
      } else {
        meta += ' &middot; ' + t.status;
      }

      return '<div class="task-card ' + t.status + '">' +
        '<div style="flex:1">' +
          '<div class="task-name">' + escapeHtml(name) + '</div>' +
          '<div class="task-meta">' + meta + '</div>' +
          (t.error ? '<div class="task-meta" style="color:var(--red)">' + escapeHtml(t.error) + '</div>' : '') +
        '</div>' +
        '<button class="task-remove" data-task-id="' + t.id + '" title="Remove">&#x2715;</button>' +
        '</div>';
    }).join('');

    // Bind remove buttons
    list.querySelectorAll('.task-remove').forEach(function(btn) {
      btn.addEventListener('click', function() {
        self.removeTask(this.dataset.taskId);
      });
    });
  },

  async removeTask(taskId) {
    await UIClient.removeTask(this.serverKey, taskId);
    this.poll();
  },

  /* ═══════════════════════════════════════════════ */
  /*  AI STRATEGY                                   */
  /* ═══════════════════════════════════════════════ */

  renderStrategy(s) {
    var id = function(x) { return document.getElementById(x); };

    // Phase — GlobalPlanner is the single authority for phase detection.
    // Show detailed planner phase when available, fall back to legacy currentPhase.
    var planner = s.plannerState || null;
    var phase = s.currentPhase || null;
    if (planner && planner.phase) {
      // Show GlobalPlanner's detailed phase (e.g. EARLY_ECON, EXPANSION_WINDOW)
      var plannerPhase = planner.phase.replace(/_/g, ' ');
      id('stratPhase').textContent = plannerPhase;
      var plannerDescs = {
        'BOOTSTRAP': 'Initial setup — crannies, basic fields',
        'EARLY_ECON': 'Focus on resource production and infrastructure',
        'EXPANSION_WINDOW': 'Preparing for second village settlement',
        'MILITARY_BUILDUP': 'Building army and military infrastructure',
        'POWER_SPIKE': 'Army is significant — raiding and operations',
        'DEFENSIVE_STABILIZE': 'Under threat — prioritizing defense'
      };
      var modeStr = planner.mode ? ' [' + planner.mode.replace(/_/g, ' ') + ']' : '';
      id('stratPhaseDesc').textContent = (plannerDescs[planner.phase] || 'Phase active') + modeStr;
    } else if (phase) {
      id('stratPhase').textContent = phase.charAt(0).toUpperCase() + phase.slice(1);
      var descs = {
        early: 'Focus on resource production and basic infrastructure',
        mid: 'Military buildup and expansion',
        late: 'Endgame strategy and alliances'
      };
      id('stratPhaseDesc').textContent = descs[phase] || 'Phase active';
    } else {
      id('stratPhase').textContent = s.running ? 'Detecting...' : '--';
      id('stratPhaseDesc').textContent = s.running ? 'Analyzing game state' : 'Start bot to detect phase';
    }

    // Last decision
    if (s.lastAIAction) {
      id('stratScore').textContent = s.lastAIAction.score != null ? s.lastAIAction.score : '--';
      id('stratType').textContent = TASK_TYPE_NAMES[s.lastAIAction.type] || s.lastAIAction.type || '--';
      id('stratReason').textContent = s.lastAIAction.reason || 'No reason';
    }

    // Cooldowns
    var cdList = document.getElementById('cooldownList');
    if (s.cooldowns && typeof s.cooldowns === 'object') {
      var entries = Object.entries(s.cooldowns);
      var active = entries.filter(function(e) { return e[1] > Date.now(); });
      if (active.length > 0) {
        cdList.innerHTML = active.map(function(e) {
          var remaining = e[1] - Date.now();
          return '<div class="cd-item">' +
            '<span class="cd-type">' + escapeHtml(e[0]) + '</span>' +
            '<span class="cd-time">' + formatCountdown(remaining) + '</span>' +
            '</div>';
        }).join('');
      } else {
        cdList.innerHTML = '<div class="empty-state">No active cooldowns</div>';
      }
    }

    // Prerequisite resolution chains
    this.renderPrereqs(s);
  },

  renderPrereqs(s) {
    var container = document.getElementById('prereqList');
    var resolutions = s.prereqResolutions || [];

    if (resolutions.length === 0) {
      container.innerHTML = '<div class="empty-state">No active prerequisite chains</div>';
      return;
    }

    var html = resolutions.map(function(r) {
      var statusClass = r.status === 'resolving' ? 'resolved' : (r.status === 'blocked' ? 'blocked' : '');
      var statusLabel = r.status === 'resolving' ? 'RESOLVING' : (r.status === 'blocked' ? 'BLOCKED' : 'WAITING');
      var statusColor = r.status === 'resolving' ? 'ok' : (r.status === 'blocked' ? 'blocked' : 'pending');

      // Chain visualization: Target ← Dep1 ← Dep2
      var chainStr = r.chain.map(function(c) {
        return '<span>' + escapeHtml(c.name) + '</span>';
      }).join(' <span class="prereq-arrow">→</span> ');

      // Missing prereqs
      var missingStr = r.missing.map(function(m) {
        return escapeHtml(m.name) + ' (L' + m.have + '→L' + m.need + ')';
      }).join(', ');

      // Current action
      var actionStr = '';
      if (r.action) {
        var taskName = TASK_TYPE_NAMES[r.action.type] || r.action.type;
        actionStr = '<div style="font-size:10px;color:var(--green);margin-top:2px">▸ ' +
          escapeHtml(taskName) + ': ' + escapeHtml(r.action.name || '') +
          (r.action.slot ? ' slot #' + r.action.slot : '') +
          (r.action.fieldId ? ' field #' + r.action.fieldId : '') +
          '</div>';
      }

      return '<div class="prereq-item ' + statusClass + '">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600">' + escapeHtml(r.targetName) + ' <span style="color:var(--txt-dim)">(slot #' + r.slot + ')</span></div>' +
          '<div style="font-size:10px;color:var(--txt-dim);margin-top:2px">Chain: ' + chainStr + '</div>' +
          '<div style="font-size:10px;color:var(--amber);margin-top:2px">Need: ' + escapeHtml(missingStr) + '</div>' +
          (r.reason ? '<div style="font-size:10px;color:var(--txt-dim);margin-top:1px">Reason: ' + escapeHtml(r.reason) + '</div>' : '') +
          actionStr +
        '</div>' +
        '<span class="prereq-status ' + statusColor + '">' + statusLabel + '</span>' +
        '</div>';
    }).join('');

    container.innerHTML = html;
  },

  /* ═══════════════════════════════════════════════ */
  /*  CONFIG                                        */
  /* ═══════════════════════════════════════════════ */

  bindConfig(cfg) {
    var setVal = function(id, val) {
      var el = document.getElementById(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val != null ? val : '';
    };

    setVal('cfgAutoFarm', cfg.autoFarm);
    setVal('cfgAutoBuildings', cfg.autoUpgradeBuildings);
    setVal('cfgAutoResources', cfg.autoUpgradeResources);
    setVal('cfgAutoTroops', cfg.autoTrainTroops);

    if (cfg.farmConfig) {
      var min = (cfg.farmConfig.intervalMs || 300000) / 60000;
      setVal('cfgFarmInterval', min);
      var valEl = document.getElementById('cfgFarmIntervalVal');
      if (valEl) valEl.textContent = min + ' min';
      setVal('cfgFarmMinLoot', cfg.farmConfig.minLoot);
      setVal('cfgFarmSkipLosses', cfg.farmConfig.skipLosses);
    }

    if (cfg.buildingConfig) setVal('cfgBuildMaxLevel', cfg.buildingConfig.maxLevel);
    if (cfg.resourceConfig) setVal('cfgResMaxLevel', cfg.resourceConfig.maxLevel);

    if (cfg.troopConfig) {
      setVal('cfgTroopCount', cfg.troopConfig.trainCount);
      setVal('cfgTroopType', cfg.troopConfig.defaultTroopType);
    }

    if (cfg.safetyConfig) setVal('cfgMaxActions', cfg.safetyConfig.maxActionsPerHour);
    if (cfg.delays) {
      setVal('cfgMinDelay', cfg.delays.minActionDelay);
      setVal('cfgMaxDelay', cfg.delays.maxActionDelay);
    }
  },

  async saveConfig() {
    // Start from existing config or build a fresh one
    var base = (this.status && this.status.config) ? this.status.config : {};
    var cfg = JSON.parse(JSON.stringify(base));

    var getVal = function(id, type) {
      var el = document.getElementById(id);
      if (!el) return null;
      if (el.type === 'checkbox') return el.checked;
      if (type === 'number') return Number(el.value);
      return el.value;
    };

    cfg.autoFarm = getVal('cfgAutoFarm');
    cfg.autoUpgradeBuildings = getVal('cfgAutoBuildings');
    cfg.autoUpgradeResources = getVal('cfgAutoResources');
    cfg.autoTrainTroops = getVal('cfgAutoTroops');

    if (!cfg.farmConfig) cfg.farmConfig = {};
    cfg.farmConfig.intervalMs = Number(document.getElementById('cfgFarmInterval').value) * 60000;
    cfg.farmConfig.minLoot = getVal('cfgFarmMinLoot', 'number');
    cfg.farmConfig.skipLosses = getVal('cfgFarmSkipLosses');

    if (!cfg.buildingConfig) cfg.buildingConfig = {};
    cfg.buildingConfig.maxLevel = getVal('cfgBuildMaxLevel', 'number');
    if (!cfg.resourceConfig) cfg.resourceConfig = {};
    cfg.resourceConfig.maxLevel = getVal('cfgResMaxLevel', 'number');

    if (!cfg.troopConfig) cfg.troopConfig = {};
    cfg.troopConfig.trainCount = getVal('cfgTroopCount', 'number');
    cfg.troopConfig.defaultTroopType = getVal('cfgTroopType');

    if (!cfg.safetyConfig) cfg.safetyConfig = {};
    cfg.safetyConfig.maxActionsPerHour = getVal('cfgMaxActions', 'number');
    if (!cfg.delays) cfg.delays = {};
    cfg.delays.minActionDelay = getVal('cfgMinDelay', 'number');
    cfg.delays.maxActionDelay = getVal('cfgMaxDelay', 'number');

    // Collect per-slot upgrade targets
    cfg.upgradeTargets = this._collectUpgradeTargets();

    var resp = await UIClient.updateConfig(this.serverKey, cfg);
    if (resp && resp.success) {
      alert('Settings saved');
      this.configLoaded = false;
      this.poll();
    } else {
      alert('Failed to save');
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  UPGRADE TARGETS (Per-slot)                    */
  /* ═══════════════════════════════════════════════ */

  _lastTargetsKey: '',

  renderUpgradeTargets(s) {
    var gs = s.gameState;
    var cfg = s.config || {};
    var targets = cfg.upgradeTargets || {};

    // Build a stable key to avoid re-rendering every poll
    var stableKey = JSON.stringify(targets) + '|' + (gs ? (gs.resourceFields || []).length + ',' + (gs.buildings || []).length : '0');
    if (stableKey === this._lastTargetsKey) return;
    this._lastTargetsKey = stableKey;

    var resContainer = document.getElementById('targetResFields');
    var bldContainer = document.getElementById('targetBuildings');
    var emptyContainer = document.getElementById('targetEmptySlots');
    var emptySection = document.getElementById('targetEmptySection');
    var infoEl = document.getElementById('targetsInfo');

    // Resource fields from gameState (or show placeholder)
    var resFields = (gs && gs.resourceFields) ? gs.resourceFields : [];
    var buildings = (gs && gs.buildings) ? gs.buildings : [];

    if (resFields.length === 0 && buildings.length === 0) {
      infoEl.innerHTML = '<span class="targets-empty">No game state available — start the bot to scan village data, or edit targets in the fields below.</span>';
    } else {
      var activeTargets = Object.keys(targets).filter(function(k) { return targets[k].enabled; }).length;
      infoEl.innerHTML = '<span class="targets-empty">' + activeTargets + ' active target' + (activeTargets !== 1 ? 's' : '') + ' configured</span>';
    }

    // Render resource fields
    this._renderSlotList(resContainer, resFields, targets, 'res');

    // Separate occupied and empty building slots
    var occupied = [];
    var empty = [];
    buildings.forEach(function(b) {
      if (b.empty || (b.gid === 0 && b.id === 0) || (!b.gid && !b.id && !b.name)) {
        empty.push(b);
      } else {
        occupied.push(b);
      }
    });

    this._renderSlotList(bldContainer, occupied, targets, 'bld');

    // Empty slots (build new)
    if (empty.length > 0) {
      emptySection.style.display = '';
      this._renderEmptySlots(emptyContainer, empty, targets);
    } else {
      emptySection.style.display = 'none';
    }
  },

  _renderSlotList(container, items, targets, prefix) {
    if (items.length === 0) {
      container.innerHTML = '<div class="targets-empty">No data — scan needed</div>';
      return;
    }

    var html = items.map(function(item) {
      var slot = item.slot || item.id || item.position;
      var key = 'slot_' + slot;
      var tgt = targets[key] || {};
      var enabled = !!tgt.enabled;
      var targetLvl = tgt.targetLevel || '';

      // Determine name and current level
      var name, level;
      if (prefix === 'res') {
        // Resource field
        var resType = item.type || 'unknown';
        var gid = item.gid || RESOURCE_TYPE_GID[resType] || 0;
        name = GID_NAMES[gid] || resType;
        level = item.level || 0;
      } else {
        // Building
        var bGid = item.id || item.gid || 0;
        name = item.name || GID_NAMES[bGid] || ('GID ' + bGid);
        level = item.level || 0;
      }

      return '<div class="tgt-row' + (enabled ? ' enabled' : '') + '" data-slot="' + slot + '">' +
        '<input type="checkbox" class="tgt-chk" data-key="' + key + '"' + (enabled ? ' checked' : '') + '>' +
        '<span class="tgt-name">' + escapeHtml(name) + ' <span class="tgt-slot">#' + slot + '</span></span>' +
        '<span class="tgt-lvl">L' + level + (item.upgrading ? ' ↑' : '') + '</span>' +
        '<span style="color:var(--txt-dim);font-size:9px">→</span>' +
        '<input type="number" class="tgt-input" data-key="' + key + '" min="1" max="20" value="' + targetLvl + '" placeholder="--" title="Target level">' +
        '</div>';
    }).join('');
    container.innerHTML = html;
  },

  _renderEmptySlots(container, items, targets) {
    var html = items.map(function(item) {
      var slot = item.slot || item.id;
      var key = 'slot_' + slot;
      var tgt = targets[key] || {};
      var enabled = !!tgt.enabled;
      var selectedGid = tgt.buildGid || '';
      var targetLvl = tgt.targetLevel || '';

      // Build GID select options
      var opts = '<option value="">-- select --</option>';
      BUILDABLE_GIDS.forEach(function(gid) {
        var sel = (gid == selectedGid) ? ' selected' : '';
        opts += '<option value="' + gid + '"' + sel + '>' + (GID_NAMES[gid] || 'GID ' + gid) + '</option>';
      });

      return '<div class="tgt-row' + (enabled ? ' enabled' : '') + '" data-slot="' + slot + '">' +
        '<input type="checkbox" class="tgt-chk" data-key="' + key + '"' + (enabled ? ' checked' : '') + '>' +
        '<span class="tgt-name">Slot <span class="tgt-slot">#' + slot + '</span></span>' +
        '<select class="tgt-select" data-key="' + key + '">' + opts + '</select>' +
        '<span style="color:var(--txt-dim);font-size:9px">→ L</span>' +
        '<input type="number" class="tgt-input" data-key="' + key + '" min="1" max="20" value="' + targetLvl + '" placeholder="--">' +
        '</div>';
    }).join('');
    container.innerHTML = html;
  },

  /** Collect upgradeTargets from the per-slot UI elements */
  _collectUpgradeTargets() {
    var targets = {};

    // Collect from all three containers
    var containers = ['targetResFields', 'targetBuildings', 'targetEmptySlots'];
    var self = this;

    containers.forEach(function(containerId) {
      var container = document.getElementById(containerId);
      if (!container) return;

      container.querySelectorAll('.tgt-row').forEach(function(row) {
        var slot = Number(row.dataset.slot);
        if (!slot) return;
        var key = 'slot_' + slot;

        var chk = row.querySelector('.tgt-chk');
        var inp = row.querySelector('.tgt-input');
        var sel = row.querySelector('.tgt-select');

        var entry = {
          slot: slot,
          enabled: chk ? chk.checked : false,
          targetLevel: inp ? (Number(inp.value) || 0) : 0
        };

        // Empty slot with building selector
        if (sel && sel.value) {
          entry.isNewBuild = true;
          entry.buildGid = Number(sel.value);
        }

        if (entry.enabled || entry.targetLevel > 0 || entry.buildGid) {
          targets[key] = entry;
        }
      });
    });

    return targets;
  },

  /* ═══════════════════════════════════════════════ */
  /*  DIAGNOSTICS                                   */
  /* ═══════════════════════════════════════════════ */

  renderDiagnostics(s) {
    var id = function(x) { return document.getElementById(x); };

    // Circuit breaker
    var failures = s.consecutiveFailures || 0;
    id('diagFailures').textContent = failures;
    var threshold = 5;
    var failPct = Math.min(100, (failures / threshold) * 100);
    id('diagFailBar').style.width = failPct + '%';
    if (failures === 0) {
      id('diagCBStatus').textContent = 'OK — No failures';
      id('diagCBStatus').style.color = 'var(--green)';
    } else if (failures < threshold) {
      id('diagCBStatus').textContent = failures + '/' + threshold + ' until trip';
      id('diagCBStatus').style.color = 'var(--amber)';
    } else {
      id('diagCBStatus').textContent = 'TRIPPED — Circuit breaker active';
      id('diagCBStatus').style.color = 'var(--red)';
    }

    // Rate limiter
    var actHr = s.actionsThisHour || 0;
    var maxAct = (s.config && s.config.safetyConfig) ? s.config.safetyConfig.maxActionsPerHour || 60 : 60;
    id('diagActionsHr').textContent = actHr;
    id('diagRateBar').style.width = Math.min(100, (actHr / maxAct) * 100) + '%';
    id('diagRateStatus').textContent = actHr + ' / ' + maxAct + ' max';

    // Scheduler
    var schedEl = document.getElementById('diagScheduler');
    if (s.scheduler && Array.isArray(s.scheduler) && s.scheduler.length > 0) {
      schedEl.innerHTML = s.scheduler.map(function(item) {
        var remaining = item.remainingMs > 0 ? formatCountdown(item.remainingMs) : 'NOW';
        return '<div class="sched-item">' +
          '<span class="sched-name">' + escapeHtml(item.name || item.id || 'Timer') + '</span>' +
          '<span class="sched-next">' + remaining + '</span>' +
          '</div>';
      }).join('');
    } else {
      schedEl.innerHTML = '<div class="empty-state">No scheduled items</div>';
    }

    // Locks
    id('diagExecLock').textContent = s.executionLocked ? 'LOCKED' : 'FREE';
    id('diagExecLock').className = 'lock-val ' + (s.executionLocked ? 'warn' : 'ok');
    id('diagCycleLock').textContent = s.cycleLock ? 'LOCKED' : 'FREE';
    id('diagCycleLock').className = 'lock-val ' + (s.cycleLock ? 'warn' : 'ok');
    id('diagNotLoggedIn').textContent = (s._notLoggedInCount || 0) + ' / 5';
    id('diagNotLoggedIn').className = 'lock-val ' + ((s._notLoggedInCount || 0) > 0 ? 'warn' : 'ok');
  },

  /* ═══════════════════════════════════════════════ */
  /*  LOGS                                          */
  /* ═══════════════════════════════════════════════ */

  async fetchLogs() {
    this.lastLogFetch = Date.now();
    try {
      var resp = await UIClient.getLogs();
      if (resp && resp.data) {
        this.logs = resp.data;
        if (this.currentView === 'logs') this.renderLogs();
        if (this.currentView === 'overview') this.renderRecentActivity();
      }
    } catch (e) { /* silent */ }
  },

  renderLogs() {
    var container = document.getElementById('logContainer');
    var search = (document.getElementById('logSearch').value || '').toLowerCase();
    var filter = document.getElementById('logFilter').value;

    var filtered = this.logs.filter(function(l) {
      if (filter && l.level !== filter) return false;
      if (search && l.message && l.message.toLowerCase().indexOf(search) === -1) return false;
      return true;
    });

    var toShow = filtered.slice(-200).reverse();
    container.innerHTML = toShow.map(function(l) {
      return '<div class="log-row">' +
        '<span class="log-ts">' + new Date(l.timestamp).toLocaleTimeString() + '</span>' +
        '<span class="log-lvl ' + l.level + '">' + l.level + '</span>' +
        '<span class="log-msg">' + escapeHtml(l.message) + '</span>' +
        '</div>';
    }).join('');
  },

  /* ═══════════════════════════════════════════════ */
  /*  DEBUG                                         */
  /* ═══════════════════════════════════════════════ */

  renderDebug(s) {
    var el = document.getElementById('debugJson');
    if (!el) return;
    el.textContent = JSON.stringify(s || this.status, null, 2);
  },

  /* ═══════════════════════════════════════════════ */
  /*  ACTIONS                                       */
  /* ═══════════════════════════════════════════════ */

  async action(type) {
    var key = this.serverKey;
    if (!key && type !== 'start') return;
    try {
      switch (type) {
        case 'start':     await UIClient.start(key); break;
        case 'stop':      await UIClient.stop(key); break;
        case 'pause':
        case 'resume':    await UIClient.togglePause(key); break;
        case 'emergency': await UIClient.emergencyStop(key, 'User emergency stop from dashboard'); break;
        case 'clearQueue': await UIClient.clearQueue(key); break;
      }
      this.poll();
    } catch (e) {
      console.error('[Dashboard] Action error:', type, e);
    }
  }
};

/* ── Boot ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function() {
  window.App = App;
  App.init();
});
