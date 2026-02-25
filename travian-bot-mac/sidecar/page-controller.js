/**
 * PageController — Manages Puppeteer page interactions for a single Travian tab.
 *
 * Replaces Chrome extension content script messaging:
 *   SCAN    → page.evaluate(() => TravianScanner.fullScan())
 *   EXECUTE → page.evaluate((a,p) => TravianExecutor.execute(a,p))
 *
 * Content scripts are injected via page.addScriptTag() on every navigation.
 */
const path = require('path');

class PageController {
  constructor(page) {
    this.page = page;
    this.scriptsInjected = false;

    // Content script paths (these run in the browser context, not Node.js)
    this.contentScripts = [
      path.join(__dirname, 'content', 'dom-scanner.js'),
      path.join(__dirname, 'content', 'action-executor.js'),
    ];

    // Re-inject scripts on every navigation
    this.page.on('load', () => {
      this.scriptsInjected = false; // Mark stale
    });
  }

  /**
   * Inject content scripts into the page if not already done.
   */
  async _injectScripts() {
    try {
      // Also inject delay.js (needed by actionExecutor)
      await this.page.addScriptTag({
        path: path.join(__dirname, 'utils', 'delay.js'),
      });
      for (const scriptPath of this.contentScripts) {
        await this.page.addScriptTag({ path: scriptPath });
      }
      this.scriptsInjected = true;
    } catch (err) {
      console.warn('[PageController] Script injection failed:', err.message);
      this.scriptsInjected = false;
    }
  }

  /**
   * Ensure scripts are injected before any operation.
   */
  async _ensureScripts() {
    if (!this.scriptsInjected) {
      await this._injectScripts();
    }
  }

  /**
   * Send a SCAN command.
   * Equivalent to: chrome.tabs.sendMessage(tabId, {type: 'SCAN'})
   * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
   */
  async scan() {
    await this._ensureScripts();
    try {
      const result = await this.page.evaluate(() => {
        if (typeof window.TravianScanner === 'undefined') {
          return { success: false, error: 'Scanner not loaded' };
        }
        try {
          var data = window.TravianScanner.fullScan();
          return { success: true, data: data };
        } catch (e) {
          return { success: false, error: e.message };
        }
      });
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Send an EXECUTE command.
   * Equivalent to: chrome.tabs.sendMessage(tabId, {type: 'EXECUTE', action, params})
   * @param {string} action - Action name (e.g., 'upgradeBuilding', 'sendFarmList')
   * @param {Object} params - Action parameters
   * @returns {Promise<{success: boolean, error?: string, reason?: string}>}
   */
  async execute(action, params = {}) {
    await this._ensureScripts();
    try {
      const result = await this.page.evaluate((action, params) => {
        if (typeof window.TravianExecutor === 'undefined') {
          return { success: false, error: 'Executor not loaded' };
        }
        try {
          return window.TravianExecutor.execute(action, params);
        } catch (e) {
          return { success: false, error: e.message };
        }
      }, action, params);
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Navigate to a Travian page.
   * @param {string} url - Full URL to navigate to
   * @param {Object} [options]
   */
  async navigateTo(url, options = {}) {
    const waitUntil = options.waitUntil || 'networkidle2';
    const timeout = options.timeout || 15000;
    await this.page.goto(url, { waitUntil, timeout });
    // Scripts will be re-injected on next scan/execute via _ensureScripts
  }

  /**
   * Get current page URL.
   * @returns {string}
   */
  getUrl() {
    return this.page.url();
  }

  /**
   * Wait for navigation to complete after a click.
   * @param {number} [timeout=15000]
   */
  async waitForNavigation(timeout = 15000) {
    await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout });
  }

  /**
   * Check if we're on a Travian game page.
   * @returns {Promise<boolean>}
   */
  async isTravianPage() {
    const url = this.getUrl();
    return url.includes('travian.com') && !url.includes('lobby');
  }
}

module.exports = PageController;
