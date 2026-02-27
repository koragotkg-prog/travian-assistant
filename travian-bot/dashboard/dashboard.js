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
      var registry = resp.data.registry || {};
      var select = document.getElementById('serverSelect');
      select.innerHTML = '';

      var keys = Object.keys(registry);
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
      case 'config':      if (!this.configLoaded && s.config) { this.bindConfig(s.config); this.configLoaded = true; } break;
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
    if (!gs || !gs.resources) return;

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
    }
  },

  _setOvRes(name, amount, capacity, production) {
    var pct = Math.min(100, Math.round((amount / capacity) * 100));
    var bar = document.getElementById('ovBar' + name);
    var val = document.getElementById('ovVal' + name);
    var prod = document.getElementById('ovProd' + name);

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
    } else {
      score.textContent = '--';
      type.textContent = '--';
      reason.textContent = 'No decision yet';
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

    // Phase
    if (s.config && s.config._currentPhase) {
      id('stratPhase').textContent = s.config._currentPhase;
      var descs = { early: 'Focus on resource production and basic infrastructure', mid: 'Military buildup and expansion', late: 'Endgame strategy and alliances' };
      id('stratPhaseDesc').textContent = descs[s.config._currentPhase] || 'Phase active';
    } else {
      id('stratPhase').textContent = '--';
      id('stratPhaseDesc').textContent = 'Phase not detected';
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
    if (!this.status || !this.status.config) return;
    var cfg = JSON.parse(JSON.stringify(this.status.config));

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
