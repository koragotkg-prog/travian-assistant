/**
 * Travian CTRL — Popup Controller (Mission Control)
 *
 * Maps getStatus() data (15+ fields) to the Mission Control UI.
 * Polls every 1 s.  No external dependencies beyond shared/*.js.
 */

const Popup = {

  /* ── Cached DOM refs ──────────────────────────── */
  dom: {},

  /* ── Internal state ───────────────────────────── */
  serverKey: null,
  pollTimer: null,

  /* ═══════════════════════════════════════════════ */
  /*  BOOT                                          */
  /* ═══════════════════════════════════════════════ */

  init() {
    this.cacheDom();
    this.bindEvents();
    this.detectServer().then(() => this.startPolling());
  },

  cacheDom() {
    const id = (s) => document.getElementById(s);
    this.dom = {
      serverLabel:  id('serverLabel'),
      statusDot:    id('statusDot'),
      heroSection:  id('heroSection'),
      heroState:    id('heroState'),
      heroCycle:    id('heroCycle'),
      heroTask:     id('heroTask'),
      heroAI:       id('heroAI'),
      errBanner:    id('errBanner'),
      errText:      id('errText'),
      // Resource bars
      barWood:  id('barWood'),  pctWood:  id('pctWood'),  prodWood:  id('prodWood'),
      barClay:  id('barClay'),  pctClay:  id('pctClay'),  prodClay:  id('prodClay'),
      barIron:  id('barIron'),  pctIron:  id('pctIron'),  prodIron:  id('prodIron'),
      barCrop:  id('barCrop'),  pctCrop:  id('pctCrop'),  prodCrop:  id('prodCrop'),
      // Stats
      statTasks:  id('statTasks'),
      statFarms:  id('statFarms'),
      statQueue:  id('statQueue'),
      statUptime: id('statUptime'),
      // Next action
      nextTask:   id('nextTask'),
      nextTimer:  id('nextTimer'),
      // Controls
      btnStart:     id('btnStart'),
      btnPause:     id('btnPause'),
      btnResume:    id('btnResume'),
      btnStop:      id('btnStop'),
      btnEmergency: id('btnEmergency'),
      btnDashboard: id('btnDashboard'),
    };
  },

  bindEvents() {
    const d = this.dom;
    d.btnStart.addEventListener('click', () => this.action('start'));
    d.btnStop.addEventListener('click', () => this.action('stop'));
    d.btnPause.addEventListener('click', () => this.action('pause'));
    d.btnResume.addEventListener('click', () => this.action('resume'));
    d.btnEmergency.addEventListener('click', () => this.action('emergency'));
    d.btnDashboard.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
    });
  },

  /* ═══════════════════════════════════════════════ */
  /*  SERVER DETECTION                              */
  /* ═══════════════════════════════════════════════ */

  async detectServer() {
    try {
      // 1. Active tab hostname
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('travian')) {
        try { this.serverKey = new URL(tab.url).hostname; return; } catch (_) {}
      }
      // 2. Background fallback
      const resp = await UIClient.getServers();
      if (resp && resp.data) {
        const { instances, registry } = resp.data;
        if (instances && instances.length > 0) {
          this.serverKey = instances[0].serverKey;
        } else if (registry) {
          const keys = Object.keys(registry);
          if (keys.length > 0) this.serverKey = keys[0];
        }
      }
    } catch (e) {
      console.warn('[Popup] detectServer failed', e);
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  POLLING                                       */
  /* ═══════════════════════════════════════════════ */

  startPolling() {
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), 1000);
  },

  async poll() {
    try {
      const resp = await UIClient.getStatus(this.serverKey);
      if (resp && resp.success && resp.data) {
        this.render(resp.data);
      } else {
        this.renderOffline();
      }
    } catch (_) {
      this.renderOffline();
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — MAIN                                 */
  /* ═══════════════════════════════════════════════ */

  render(s) {
    const d = this.dom;
    const state = deriveBotState(s);   // 'running' | 'paused' | 'stopped'

    // ── Server label ──
    d.serverLabel.textContent = this.serverKey
      ? formatServerLabel(this.serverKey) : '--';

    // ── Status dot ──
    d.statusDot.className = 'hdr-dot ' + state;

    // ── Hero state ──
    this.renderHeroState(s, state);

    // ── Error banner ──
    this.renderError(s);

    // ── Resources ──
    this.renderResources(s);

    // ── Stats strip ──
    this.renderStats(s);

    // ── Next action ──
    this.renderNextAction(s);

    // ── Control buttons ──
    this.renderControls(state);
  },

  renderOffline() {
    const d = this.dom;
    d.statusDot.className = 'hdr-dot';
    d.heroState.textContent = 'OFFLINE';
    d.heroState.className = 'hero-state';
    d.heroCycle.textContent = '--';
    d.heroTask.textContent = 'No connection';
    d.heroAI.textContent = '';
    d.errBanner.classList.add('hidden');

    // Show only start
    this.showBtn('btnStart', true);
    this.showBtn('btnPause', false);
    this.showBtn('btnResume', false);
    this.showBtn('btnStop', false);
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — HERO STATUS SECTION                  */
  /* ═══════════════════════════════════════════════ */

  renderHeroState(s, state) {
    const d = this.dom;

    // State label
    if (s.emergencyStopped) {
      d.heroState.textContent = 'EMERGENCY';
      d.heroState.className = 'hero-state emergency';
    } else if (state === 'running') {
      // Show granular FSM state if available
      const fsm = s.botState || 'RUNNING';
      const label = FSM_LABELS[fsm] || fsm;
      d.heroState.textContent = label.toUpperCase();
      d.heroState.className = 'hero-state running';
    } else if (state === 'paused') {
      d.heroState.textContent = 'PAUSED';
      d.heroState.className = 'hero-state paused';
    } else {
      d.heroState.textContent = 'STOPPED';
      d.heroState.className = 'hero-state stopped';
    }

    // Cycle
    d.heroCycle.textContent = s.cycleId ? 'CYCLE ' + s.cycleId : '--';

    // Current task
    if (s.taskQueue && s.taskQueue.running && s.taskQueue.running.length > 0) {
      const task = s.taskQueue.running[0];
      const name = TASK_TYPE_NAMES[task.type] || task.type;
      d.heroTask.textContent = name;
    } else if (state === 'running') {
      d.heroTask.textContent = s.botState ? FSM_LABELS[s.botState] || s.botState : 'Active';
    } else {
      d.heroTask.textContent = state === 'paused' ? 'Paused' : 'No active task';
    }

    // AI reason
    if (s.lastAIAction && s.lastAIAction.reason) {
      var aiText = s.lastAIAction.reason;
      if (s.lastAIAction.score != null) {
        aiText = '[' + s.lastAIAction.score + '] ' + aiText;
      }
      d.heroAI.textContent = aiText;
    } else {
      d.heroAI.textContent = '';
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — ERROR BANNER                         */
  /* ═══════════════════════════════════════════════ */

  renderError(s) {
    const d = this.dom;
    if (s.emergencyStopped && s.emergencyReason) {
      d.errText.textContent = s.emergencyReason;
      d.errBanner.classList.remove('hidden');
    } else if (s.consecutiveFailures && s.consecutiveFailures >= 3) {
      d.errText.textContent = 'Circuit breaker: ' + s.consecutiveFailures + ' consecutive failures';
      d.errBanner.classList.remove('hidden');
    } else {
      d.errBanner.classList.add('hidden');
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — RESOURCES                            */
  /* ═══════════════════════════════════════════════ */

  renderResources(s) {
    const gs = s.gameState;
    if (!gs || !gs.resources) return;

    const res = gs.resources;         // { wood, clay, iron, crop }
    const cap = gs.capacity || {};    // { warehouse, granary }
    const prod = gs.production || {}; // { wood, clay, iron, crop }

    const wh = cap.warehouse || 1;
    const gr = cap.granary || 1;

    this._setRes('Wood', res.wood || 0, wh, prod.wood || 0);
    this._setRes('Clay', res.clay || 0, wh, prod.clay || 0);
    this._setRes('Iron', res.iron || 0, wh, prod.iron || 0);
    this._setRes('Crop', res.crop || 0, gr, prod.crop || 0);
  },

  _setRes(name, amount, capacity, production) {
    const d = this.dom;
    var pct = Math.min(100, Math.round((amount / capacity) * 100));
    var bar  = d['bar' + name];
    var pctE = d['pct' + name];
    var prodE = d['prod' + name];

    bar.style.width = pct + '%';
    pctE.textContent = pct + '%';
    prodE.textContent = formatNumber(production) + '/h';

    // Overflow warning at 90%+
    if (pct >= 90) {
      bar.classList.add('overflow');
      pctE.style.color = 'var(--red)';
    } else {
      bar.classList.remove('overflow');
      pctE.style.color = '';
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — STATS                                */
  /* ═══════════════════════════════════════════════ */

  renderStats(s) {
    const d = this.dom;
    const stats = s.stats || {};

    d.statTasks.textContent = stats.tasksCompleted || 0;
    d.statFarms.textContent = stats.farmRaidsSent || 0;

    // Queue count
    var queueCount = 0;
    if (s.taskQueue) {
      queueCount = s.taskQueue.pending || 0;
      if (typeof queueCount !== 'number' && Array.isArray(s.taskQueue.pending)) {
        queueCount = s.taskQueue.pending.length;
      }
    }
    d.statQueue.textContent = queueCount;

    // Uptime
    if (stats.startTime) {
      d.statUptime.textContent = formatUptime(Date.now() - stats.startTime);
    } else {
      d.statUptime.textContent = '--';
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — NEXT ACTION                          */
  /* ═══════════════════════════════════════════════ */

  renderNextAction(s) {
    const d = this.dom;

    // Pending task from queue
    if (s.taskQueue && s.taskQueue.tasks && s.taskQueue.tasks.length > 0) {
      // Find first pending task
      var next = null;
      for (var i = 0; i < s.taskQueue.tasks.length; i++) {
        if (s.taskQueue.tasks[i].status === 'pending') { next = s.taskQueue.tasks[i]; break; }
      }
      if (next) {
        d.nextTask.textContent = TASK_TYPE_NAMES[next.type] || next.type;
      } else {
        d.nextTask.textContent = 'Queue empty';
      }
    } else {
      d.nextTask.textContent = '--';
    }

    // Countdown
    if (s.nextActionTime) {
      var remaining = s.nextActionTime - Date.now();
      d.nextTimer.textContent = remaining > 0 ? formatCountdown(remaining) : 'NOW';
    } else {
      d.nextTimer.textContent = '--:--';
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  RENDER — CONTROLS                             */
  /* ═══════════════════════════════════════════════ */

  renderControls(state) {
    if (state === 'running') {
      this.showBtn('btnStart', false);
      this.showBtn('btnPause', true);
      this.showBtn('btnResume', false);
      this.showBtn('btnStop', true);
    } else if (state === 'paused') {
      this.showBtn('btnStart', false);
      this.showBtn('btnPause', false);
      this.showBtn('btnResume', true);
      this.showBtn('btnStop', true);
    } else {
      this.showBtn('btnStart', true);
      this.showBtn('btnPause', false);
      this.showBtn('btnResume', false);
      this.showBtn('btnStop', false);
    }
  },

  showBtn(key, visible) {
    if (this.dom[key]) {
      this.dom[key].classList.toggle('hidden', !visible);
    }
  },

  /* ═══════════════════════════════════════════════ */
  /*  ACTIONS                                       */
  /* ═══════════════════════════════════════════════ */

  async action(type) {
    var key = this.serverKey;
    try {
      switch (type) {
        case 'start':     await UIClient.start(key); break;
        case 'stop':      await UIClient.stop(key); break;
        case 'pause':
        case 'resume':    await UIClient.togglePause(key); break;
        case 'emergency': await UIClient.emergencyStop(key, 'User emergency stop'); break;
      }
      this.poll();
    } catch (e) {
      console.error('[Popup] Action error:', type, e);
    }
  }
};

/* ── Boot ──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => Popup.init());
