/**
 * BrowserManager — Puppeteer lifecycle management
 *
 * Handles: launch, close, headed/headless toggle, cookie injection.
 * Replaces the Chrome extension's reliance on the user's own browser.
 */
const puppeteer = require('puppeteer');

class BrowserManager {
  constructor() {
    this.browser = null;
    this.headless = false; // default: show browser window
  }

  /**
   * Launch Chromium.
   * @param {Object} [options]
   * @param {boolean} [options.headless] - Override default headless setting
   * @returns {Promise<Browser>}
   */
  async launch(options = {}) {
    if (this.browser) {
      console.log('[BrowserManager] Browser already running');
      return this.browser;
    }

    const headless = options.headless !== undefined ? options.headless : this.headless;

    this.browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
      ],
      defaultViewport: { width: 1280, height: 800 },
    });

    // Handle unexpected browser close
    this.browser.on('disconnected', () => {
      console.log('[BrowserManager] Browser disconnected');
      this.browser = null;
    });

    console.log(`[BrowserManager] Launched (headless: ${headless})`);
    return this.browser;
  }

  /**
   * Close Chromium and cleanup.
   */
  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      console.log('[BrowserManager] Closed');
    }
  }

  /**
   * Open a new browser tab (page).
   * Launches browser if not already running.
   * @returns {Promise<Page>}
   */
  async newPage() {
    if (!this.browser) await this.launch();
    const page = await this.browser.newPage();

    // Stealth: override navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    return page;
  }

  /**
   * Set headless preference. Takes effect on next launch.
   * @param {boolean} headless
   */
  setHeadless(headless) {
    this.headless = headless;
    console.log(`[BrowserManager] Headless preference: ${headless}`);
  }

  /**
   * Inject cookies into a page (for auto-login).
   * @param {Page} page
   * @param {Array} cookies - Array of cookie objects { name, value, domain, path }
   */
  async setCookies(page, cookies) {
    if (!cookies || cookies.length === 0) return;
    await page.setCookie(...cookies);
    console.log(`[BrowserManager] Set ${cookies.length} cookies`);
  }

  /**
   * Get all pages (tabs) currently open.
   * @returns {Promise<Page[]>}
   */
  async getPages() {
    if (!this.browser) return [];
    return this.browser.pages();
  }

  isRunning() {
    return this.browser !== null;
  }
}

module.exports = BrowserManager;
