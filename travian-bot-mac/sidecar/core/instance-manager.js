/**
 * InstanceManager — Manages multiple BotEngine instances, one per Travian server.
 *
 * Adapted from Chrome extension:
 * - tabId → page (Puppeteer Page) + pageController
 * - No chrome.alarms
 * - Export via module.exports
 */
const BotEngine = require('./bot-engine');
const PageController = require('../page-controller');

class InstanceManager {
  constructor() {
    // Map<serverKey, { engine, page, pageController, serverKey }>
    this.instances = new Map();
  }

  /**
   * Get or create a bot instance for a server.
   * @param {string} serverKey - Server hostname
   * @returns {{ engine, page, pageController, serverKey }}
   */
  getOrCreate(serverKey) {
    if (this.instances.has(serverKey)) {
      return this.instances.get(serverKey);
    }

    const engine = new BotEngine();
    engine.serverKey = serverKey;

    const instance = {
      engine,
      page: null,
      pageController: null,
      serverKey,
    };

    this.instances.set(serverKey, instance);
    console.log('[InstanceManager] Created instance for ' + serverKey);
    return instance;
  }

  /**
   * Get an instance by server key.
   * @param {string} serverKey
   * @returns {{ engine, page, pageController, serverKey }|null}
   */
  get(serverKey) {
    return this.instances.get(serverKey) || null;
  }

  /**
   * Bind a Puppeteer page to an instance and create a PageController.
   * @param {string} serverKey
   * @param {Page} page - Puppeteer Page object
   * @returns {PageController}
   */
  bindPage(serverKey, page) {
    const instance = this.getOrCreate(serverKey);
    instance.page = page;
    instance.pageController = new PageController(page);
    instance.engine.pageController = instance.pageController;
    console.log('[InstanceManager] Bound page to ' + serverKey);
    return instance.pageController;
  }

  /**
   * Remove and stop an instance.
   * @param {string} serverKey
   */
  async remove(serverKey) {
    const inst = this.instances.get(serverKey);
    if (!inst) return;

    if (inst.engine.running) {
      inst.engine.stop();
    }
    if (inst.page) {
      await inst.page.close().catch(() => {});
    }

    this.instances.delete(serverKey);
    console.log('[InstanceManager] Removed instance for ' + serverKey);
  }

  /**
   * List all active instances for dashboard display.
   * @returns {Array<{ serverKey, running, paused, stats }>}
   */
  listActive() {
    return [...this.instances.values()].map(inst => ({
      serverKey: inst.serverKey,
      running: inst.engine.running,
      paused: inst.engine.paused,
      stats: inst.engine.stats,
    }));
  }

  /**
   * Stop all running instances.
   */
  stopAll() {
    for (const inst of this.instances.values()) {
      if (inst.engine.running) {
        inst.engine.stop();
      }
    }
    console.log('[InstanceManager] All instances stopped');
  }

  /**
   * Get count of running instances.
   * @returns {number}
   */
  runningCount() {
    let count = 0;
    for (const inst of this.instances.values()) {
      if (inst.engine.running) count++;
    }
    return count;
  }
}

module.exports = InstanceManager;
