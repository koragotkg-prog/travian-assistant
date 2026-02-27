/**
 * actionExecutor.js - Travian Action Executor
 *
 * Performs game actions (navigation, building, training, farming) with
 * human-like timing and behaviour. Communicates with the background script
 * via chrome.runtime.onMessage.
 *
 * Dependencies (expected on window):
 *   - window.TravianScanner  (domScanner.js)
 *   - window.DomHelpers      (domHelpers.js - Phase 4: FIX 10-13)
 *   - window.TravianDelay    (optional - falls back to internal helper)
 *   - window.TravianLogger   (optional - falls back to console)
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Internal helpers / fallbacks
  // ---------------------------------------------------------------------------

  /**
   * Logger - wraps TravianLogger if available, otherwise uses console.
   */
  var Logger = {
    log: function () {
      if (window.TravianLogger && typeof window.TravianLogger.info === 'function') {
        var msg = Array.from(arguments).map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
        window.TravianLogger.info('[Executor] ' + msg);
      } else {
        console.log.apply(console, ['[TravianExecutor]'].concat(Array.from(arguments)));
      }
    },
    warn: function () {
      if (window.TravianLogger && typeof window.TravianLogger.warn === 'function') {
        var msg = Array.from(arguments).map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
        window.TravianLogger.warn('[Executor] ' + msg);
      } else {
        console.warn.apply(console, ['[TravianExecutor]'].concat(Array.from(arguments)));
      }
    },
    error: function () {
      if (window.TravianLogger && typeof window.TravianLogger.error === 'function') {
        var msg = Array.from(arguments).map(function(a) { return typeof a === 'string' ? a : JSON.stringify(a); }).join(' ');
        window.TravianLogger.error('[Executor] ' + msg);
      } else {
        console.error.apply(console, ['[TravianExecutor]'].concat(Array.from(arguments)));
      }
    }
  };

  /**
   * Return a random integer between min (inclusive) and max (inclusive).
   */
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * RND-1 FIX: Gaussian random number using Box-Muller transform.
   * Returns a value centered on `mean` with standard deviation `stddev`.
   * Clamped to [min, max] to prevent extreme outliers.
   */
  function gaussianRandom(mean, stddev, min, max) {
    var u1 = Math.random();
    var u2 = Math.random();
    // Box-Muller: convert two uniform randoms → one Gaussian
    var z = Math.sqrt(-2.0 * Math.log(u1 || 0.0001)) * Math.cos(2.0 * Math.PI * u2);
    var value = mean + z * stddev;
    // Clamp to bounds
    if (min !== undefined && value < min) value = min;
    if (max !== undefined && value > max) value = max;
    return Math.round(value);
  }

  /**
   * Promise-based delay. Uses TravianDelay.wait() if available, else setTimeout.
   * @param {number} ms - milliseconds to wait
   * @returns {Promise<void>}
   */
  function delay(ms) {
    if (window.TravianDelay && typeof window.TravianDelay.wait === 'function') {
      return window.TravianDelay.wait(ms);
    }
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  /**
   * RND-1 FIX: Human-like delay using Gaussian distribution.
   * Most delays cluster around the midpoint (like real human reaction times)
   * instead of being uniformly spread across the range.
   */
  function humanDelay(minMs, maxMs) {
    var lo = minMs || 80;
    var hi = maxMs || 300;
    var mean = (lo + hi) / 2;
    var stddev = (hi - lo) / 6; // 99.7% of values within [lo, hi]
    var ms = gaussianRandom(mean, stddev, lo, hi);
    return delay(ms);
  }

  /**
   * Wait for a selector to appear in the DOM.
   * Delegates to DomHelpers.waitForElement (MutationObserver-based) if available,
   * otherwise falls back to polling (200ms interval).
   *
   * @param {string|string[]} selector - CSS selector(s)
   * @param {number} timeout - max ms to wait (default 5000)
   * @returns {Promise<Element|null>}
   */
  function awaitSelector(selector, timeout) {
    timeout = timeout || 5000;
    // FIX 10: Prefer MutationObserver-based wait
    if (window.DomHelpers && window.DomHelpers.waitForElement) {
      return window.DomHelpers.waitForElement(selector, { timeout: timeout });
    }
    // Legacy fallback: polling
    return new Promise(function (resolve) {
      var sel = Array.isArray(selector) ? selector[0] : selector;
      var el = document.querySelector(sel);
      if (el) return resolve(el);
      var elapsed = 0;
      var interval = setInterval(function () {
        el = document.querySelector(sel);
        elapsed += 200;
        if (el || elapsed >= timeout) {
          clearInterval(interval);
          resolve(el || null);
        }
      }, 200);
    });
  }

  /**
   * Safely query a single element. Returns null if not found.
   */
  function qs(selector, context) {
    try {
      return (context || document).querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  /**
   * Safely query all matching elements. Returns empty array.
   */
  function qsa(selector, context) {
    try {
      return Array.from((context || document).querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  /**
   * Try multiple selectors, return first match.
   */
  function trySelectors(selectors, context) {
    for (var i = 0; i < selectors.length; i++) {
      var el = qs(selectors[i], context);
      if (el) return el;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Farm list API helpers (bypass FormV2 via direct REST API)
  // ---------------------------------------------------------------------------

  /**
   * Extract game version from CDN URLs for X-Version header.
   * @returns {string} Game version like "347.6"
   */
  function _getGameVersion() {
    var link = document.querySelector('link[href*="gpack/"], script[src*="gpack/"]');
    if (link) {
      var href = link.getAttribute('href') || link.getAttribute('src') || '';
      var m = href.match(/gpack\/([0-9.]+)\//);
      if (m) return m[1];
    }
    return '347.6'; // fallback
  }

  /**
   * Get first farm list ID from DOM data attributes.
   * Farm list checkboxes have data-farm-list-id on the page.
   * @returns {number|null} Farm list ID, or null
   */
  function _getFarmListId() {
    // Primary: data-farm-list-id attribute on checkbox inputs
    var el = document.querySelector('[data-farm-list-id]');
    if (el) {
      var id = parseInt(el.getAttribute('data-farm-list-id'), 10);
      if (id > 0) {
        Logger.log('Detected farm list ID from DOM: ' + id);
        return id;
      }
    }
    Logger.warn('_getFarmListId: no data-farm-list-id found on page');
    return null;
  }

  /**
   * Call POST /api/v1/farm-list/slot via service worker (has host_permissions + cookies API).
   * Content scripts can't inject <script> (CSP blocks it) and content script fetch()
   * uses extension origin so session cookies aren't sent. Delegate to service worker.
   * @param {Object} opts - { listId, x, y, units, gameVersion }
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  function _callFarmListSlotApi(opts) {
    return new Promise(function (resolve) {
      var timeoutId = setTimeout(function () {
        resolve({ ok: false, error: 'Service worker timeout' });
      }, 15000);

      chrome.runtime.sendMessage({
        type: 'FARM_LIST_API_CALL',
        serverOrigin: window.location.origin,
        opts: opts
      }, function (response) {
        clearTimeout(timeoutId);
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'No response from service worker' });
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Core interaction primitives
  // ---------------------------------------------------------------------------

  /**
   * Simulate a human-like click on an element.
   * Dispatches mousedown -> mouseup -> click with a small random offset
   * and slight delay between events.
   *
   * @param {HTMLElement} element - Target DOM element
   * @returns {Promise<void>}
   */
  async function simulateHumanClick(element) {
    if (!element) {
      Logger.warn('simulateHumanClick called with null element');
      return;
    }

    // RND-2 FIX: Center-biased click position using Gaussian distribution.
    // Real users tend to click near the center of elements, not uniformly random.
    var rect = element.getBoundingClientRect();
    var centerX = rect.width / 2;
    var centerY = rect.height / 2;
    // Gaussian: mean=center, stddev=width/6 (99.7% within element bounds)
    var offsetX = gaussianRandom(centerX, Math.max(1, rect.width / 6), 2, Math.max(3, rect.width - 2));
    var offsetY = gaussianRandom(centerY, Math.max(1, rect.height / 6), 2, Math.max(3, rect.height - 2));
    var clientX = rect.left + offsetX;
    var clientY = rect.top + offsetY;

    // RND-7 FIX: screenX/screenY should account for browser chrome offset.
    // Real events have screenX = clientX + window.screenX + outerWidth-innerWidth padding.
    // Using window.screenX/screenY as the offset for a more realistic fingerprint.
    var screenOffsetX = (typeof window.screenX === 'number') ? window.screenX : 0;
    var screenOffsetY = (typeof window.screenY === 'number') ? window.screenY : 0;
    // Approximate browser chrome height (toolbar etc.)
    var chromeHeight = (typeof window.outerHeight === 'number' && typeof window.innerHeight === 'number')
      ? (window.outerHeight - window.innerHeight) : 80;

    var commonProps = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      screenX: clientX + screenOffsetX,
      screenY: clientY + screenOffsetY + chromeHeight,
      button: 0
    };

    // RND-4 FIX: Simulate mouse movement to element before clicking.
    // Real users always move their cursor to an element before clicking.
    // 1. mousemove — cursor approaches the element
    element.dispatchEvent(new MouseEvent('mousemove', commonProps));
    await delay(randomInt(15, 50));

    // 2. mouseover + mouseenter — cursor enters the element boundary
    element.dispatchEvent(new MouseEvent('mouseover', commonProps));
    element.dispatchEvent(new MouseEvent('mouseenter', { ...commonProps, bubbles: false }));
    await delay(randomInt(30, 120));

    // 3. mousedown
    element.dispatchEvent(new MouseEvent('mousedown', commonProps));
    await delay(randomInt(30, 90));

    // 4. mouseup
    element.dispatchEvent(new MouseEvent('mouseup', commonProps));
    await delay(randomInt(10, 40));

    // 5. click
    element.dispatchEvent(new MouseEvent('click', commonProps));

    Logger.log('Clicked element:', element.tagName, element.className || element.id || '');
  }

  /**
   * Find an element by selector (or array of selectors) and click it.
   * FIX 10: Enhanced with interactability checks and snapshot debugging (FIX 13).
   *
   * @param {string|string[]} selector
   * @returns {Promise<boolean>} true if clicked, false if element not found
   */
  async function clickElement(selector) {
    var el;
    if (Array.isArray(selector)) {
      el = trySelectors(selector);
    } else {
      el = qs(selector);
    }

    if (!el) {
      Logger.warn('clickElement: element not found for selector', selector);
      // FIX 13: capture snapshot on failure
      if (window.DomHelpers) {
        window.DomHelpers.captureAndLog({
          action: 'clickElement', selector: String(selector), reason: 'not_found'
        });
      }
      return false;
    }

    // FIX 10: Verify element is interactable before clicking
    if (window.DomHelpers && window.DomHelpers.checkInteractable) {
      var check = window.DomHelpers.checkInteractable(el);
      if (!check.ok) {
        Logger.warn('clickElement: element not interactable:', check.reason, selector);
        window.DomHelpers.captureAndLog({
          action: 'clickElement', selector: String(selector),
          reason: check.reason, element: el
        });
        return false;
      }
    }

    // Scroll element into view if needed
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(randomInt(100, 250));
    }

    await simulateHumanClick(el);
    return true;
  }

  /**
   * Focus an input, clear it, then type a value character by character
   * with random delays between keystrokes.
   *
   * @param {string|string[]} selector
   * @param {string|number} value
   * @returns {Promise<boolean>} true if filled, false if input not found
   */
  async function fillInput(selector, value) {
    var input;
    if (Array.isArray(selector)) {
      input = trySelectors(selector);
    } else {
      input = qs(selector);
    }

    if (!input) {
      Logger.warn('fillInput: input not found for selector', selector);
      return false;
    }

    // Scroll into view
    if (typeof input.scrollIntoView === 'function') {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await delay(randomInt(80, 200));
    }

    // Focus the input
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    await delay(randomInt(50, 150));

    // Select all existing text and delete it
    input.select();
    input.dispatchEvent(new Event('select', { bubbles: true }));
    await delay(randomInt(30, 80));

    // Clear via setting value and dispatching input event
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await delay(randomInt(30, 100));

    // Type value character by character
    var valueStr = String(value);
    for (var i = 0; i < valueStr.length; i++) {
      var char = valueStr[i];

      // keydown
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: char,
        code: 'Key' + char.toUpperCase(),
        bubbles: true,
        cancelable: true
      }));

      // Update value
      input.value += char;

      // input event
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // keyup
      input.dispatchEvent(new KeyboardEvent('keyup', {
        key: char,
        code: 'Key' + char.toUpperCase(),
        bubbles: true,
        cancelable: true
      }));

      // Random delay between keystrokes (50-200ms)
      await delay(randomInt(50, 200));
    }

    // Blur after typing (some forms validate on blur)
    await delay(randomInt(100, 300));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    Logger.log('Filled input:', selector, '-> value:', valueStr);
    return true;
  }

  // ---------------------------------------------------------------------------
  // TravianExecutor
  // ---------------------------------------------------------------------------

  var TravianExecutor = {

    // -----------------------------------------------------------------------
    // Navigation
    // -----------------------------------------------------------------------

    /**
     * Navigate to a game page by clicking the appropriate navigation link.
     * Does NOT change window.location - always simulates a click.
     *
     * @param {string} page - Target page: 'dorf1'|'resources'|'dorf2'|'village'|
     *                        'rallyPoint'|'barracks'|'stable'|'workshop'|
     *                        'marketplace'|'map'|'stats'|'reports'|'messages'
     * @returns {Promise<boolean>}
     */
    navigateTo: async function (page) {
      try {
        Logger.log('navigateTo:', page);

        var selectors = {
          dorf1:       ['a[href*="dorf1"]', '.village.resourceView a', '#navigation .village1 a', 'a.resourceView'],
          resources:   ['a[href*="dorf1"]', '.village.resourceView a', '#navigation .village1 a'],
          dorf2:       ['a[href*="dorf2"]', '.village.buildingView a', '#navigation .village2 a', 'a.buildingView'],
          village:     ['a[href*="dorf2"]', '.village.buildingView a', '#navigation .village2 a'],
          map:         ['a[href*="karte"]', 'a[href*="map"]', '#navigation .map a'],
          stats:       ['a[href*="statistiken"]', 'a[href*="statistics"]', '#navigation .statistics a'],
          reports:     ['a[href*="berichte"]', 'a[href*="report"]', '#navigation .reports a'],
          messages:    ['a[href*="nachrichten"]', 'a[href*="messages"]', '#navigation .messages a'],
          rallyPoint:  ['a[href*="build.php?id=39"]', 'a[href*="build.php?gid=16"]'],
          barracks:    ['a[href*="build.php?gid=19"]'],
          stable:      ['a[href*="build.php?gid=20"]'],
          workshop:    ['a[href*="build.php?gid=21"]'],
          marketplace: ['a[href*="build.php?gid=17"]'],
          heroAdventures: ['a[href*="/hero/adventures"]', 'a[href*="hero_adventure"]', '.adventure.attention'],
          hero:        ['#heroImageButton', '.heroImageButton', 'a[href="/hero"]', 'a[href="/hero/"]'],
          heroInventory: ['a[href="/hero/inventory"]', 'a[href*="hero/inventory"]']
        };

        var targetSelectors = selectors[page];
        if (!targetSelectors) {
          Logger.warn('navigateTo: unknown page', page);
          return false;
        }

        await humanDelay(200, 500);
        var clicked = await clickElement(targetSelectors);

        if (!clicked) {
          // Fallback: some pages (heroInventory, hero tabs) only have nav links
          // when already on the parent page. Use direct URL navigation instead.
          var directUrls = {
            heroInventory: '/hero/inventory',
            heroAdventures: '/hero/adventures',
            hero: '/hero',
            dorf1: '/dorf1.php',
            resources: '/dorf1.php',
            dorf2: '/dorf2.php',
            village: '/dorf2.php'
          };
          if (directUrls[page]) {
            Logger.log('navigateTo: selector not found, using direct URL for', page);
            window.location.href = directUrls[page];
            return true;
          }

          Logger.warn('navigateTo: could not find nav link for', page);
          // FIX 13: snapshot on navigation failure
          if (window.DomHelpers) {
            window.DomHelpers.captureAndLog({
              action: 'navigateTo', selector: targetSelectors[0], reason: 'nav_link_not_found'
            });
          }
          return false;
        }

        Logger.log('navigateTo: clicked link for', page);
        return true;
      } catch (e) {
        Logger.error('navigateTo error:', e);
        return false;
      }
    },

    /**
     * Switch to a different village by clicking its entry in the sidebar.
     *
     * @param {string} villageId - The village ID (from getVillageList)
     * @returns {Promise<boolean>}
     */
    switchVillage: async function (villageId) {
      try {
        Logger.log('switchVillage:', villageId);

        await humanDelay(150, 400);

        // Try to find the village link by ID in the sidebar
        var linkSelectors = [
          'a[href*="newdid=' + villageId + '"]',
          'a[href*="did=' + villageId + '"]',
          'a[href*="village=' + villageId + '"]',
          '#sidebarBoxVillageList a[href*="' + villageId + '"]',
          '#sidebarBoxVil498 a[href*="' + villageId + '"]',
          '.villageList a[href*="' + villageId + '"]',
          '#villageListLinks a[href*="' + villageId + '"]'
        ];

        var clicked = await clickElement(linkSelectors);

        if (!clicked) {
          // Try dropdown-based village switching
          var dropdown = trySelectors([
            'select[name="newdid"]',
            '#villageSwitcher',
            '.villageSwitch select'
          ]);

          if (dropdown) {
            dropdown.value = villageId;
            dropdown.dispatchEvent(new Event('change', { bubbles: true }));
            Logger.log('switchVillage: changed dropdown to', villageId);
            return true;
          }

          Logger.warn('switchVillage: could not find village link for ID', villageId);
          return false;
        }

        Logger.log('switchVillage: clicked village', villageId);
        return true;
      } catch (e) {
        Logger.error('switchVillage error:', e);
        return false;
      }
    },

    // -----------------------------------------------------------------------
    // Building Actions
    // -----------------------------------------------------------------------

    /**
     * Click a resource field in dorf1 by its field ID.
     *
     * @param {number} fieldId - Resource field ID (1-18 typically)
     * @returns {Promise<boolean>}
     */
    clickResourceField: async function (fieldId) {
      try {
        Logger.log('clickResourceField:', fieldId);
        await humanDelay(200, 500);

        var selectors = [
          'area[href*="build.php?id=' + fieldId + '"]',
          '#resourceFieldContainer .buildingSlot' + fieldId,
          'div.buildingSlot[data-aid="' + fieldId + '"]',
          'a[href*="build.php?id=' + fieldId + '"]',
          '#rx area[href*="id=' + fieldId + '"]'
        ];

        var clicked = await clickElement(selectors);

        if (!clicked) {
          Logger.warn('clickResourceField: field not found:', fieldId);
          return false;
        }

        Logger.log('clickResourceField: clicked field', fieldId);
        return true;
      } catch (e) {
        Logger.error('clickResourceField error:', e);
        return false;
      }
    },

    /**
     * Click a building slot in dorf2 by its slot ID.
     *
     * @param {number} slotId - Building slot ID (19-40 typically)
     * @returns {Promise<boolean>}
     */
    clickBuildingSlot: async function (slotId) {
      try {
        Logger.log('clickBuildingSlot:', slotId);
        await humanDelay(200, 500);

        var selectors = [
          '.buildingSlot[data-aid="' + slotId + '"] a',
          'area[href*="build.php?id=' + slotId + '"]',
          '#villageContent .buildingSlot' + slotId,
          'a[href*="build.php?id=' + slotId + '"]',
          '#levels area[href*="id=' + slotId + '"]'
        ];

        var clicked = await clickElement(selectors);

        if (!clicked) {
          // Fallback: empty building slots often have <a> with width:0/height:0
          // (Travian renders them via CSS background on parent, not <a> size).
          // Try finding the zero-size <a> and navigating via its href directly.
          var zeroSizeLink = trySelectors([
            '.buildingSlot[data-aid="' + slotId + '"] a',
            'a[href*="build.php?id=' + slotId + '"]'
          ]);
          if (zeroSizeLink && zeroSizeLink.href) {
            Logger.log('clickBuildingSlot: zero-size element found, using direct navigation for slot', slotId);
            window.location.href = zeroSizeLink.href;
            return true;
          }

          Logger.warn('clickBuildingSlot: slot not found:', slotId);
          return false;
        }

        Logger.log('clickBuildingSlot: clicked slot', slotId);
        return true;
      } catch (e) {
        Logger.error('clickBuildingSlot error:', e);
        return false;
      }
    },

    /**
     * Find and click the upgrade / level-up button on a building page.
     *
     * @returns {Promise<boolean>}
     */
    clickUpgradeButton: async function () {
      try {
        Logger.log('clickUpgradeButton');
        await humanDelay(300, 700);

        // Step 1: Try to find the GREEN upgrade button first (happy path)
        var greenBtn = trySelectors([
          '.upgradeButtonsContainer .section1 button.textButtonV1.green',
          '.upgradeButtonsContainer button.textButtonV1.green',
          '.section1 button.green.build',
          'button.green.build',
          '.upgradeButtonsContainer .section1 button.green',
          '.contractLink button.green',
          'button[value*="Upgrade"]',
          'button[value*="upgrade"]',
          '.build_details .section1 .green',
          '.section1 a.green',
          '#build button.green',
          '.upgradeButtonsContainer button.green'
        ]);

        if (greenBtn) {
          // Green button found — click it
          if (typeof greenBtn.scrollIntoView === 'function') {
            greenBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(randomInt(100, 250));
          }
          await simulateHumanClick(greenBtn);
          Logger.log('clickUpgradeButton: clicked upgrade');
          return true;
        }

        // Also try link-based green buttons
        var greenLink = trySelectors([
          '.section1 a.green.build',
          'a.green.build',
          '.contractLink a.green',
          '.build_details a.green'
        ]);
        if (greenLink) {
          if (typeof greenLink.scrollIntoView === 'function') {
            greenLink.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(randomInt(100, 250));
          }
          await simulateHumanClick(greenLink);
          Logger.log('clickUpgradeButton: clicked upgrade link');
          return true;
        }

        // Step 2: No green button — distinguish insufficient resources vs queue full.
        //
        // On Travian upgrade/build pages, when resources are insufficient:
        //   - .upgradeBlocked element appears (contains gold exchange button)
        //   - section1 gets gold.builder button (master builder premium)
        //   - .notEnough class may NOT be present
        //
        // When queue is full:
        //   - Only gold builder button in section1, no .upgradeBlocked
        //
        // Check .upgradeBlocked FIRST to correctly detect insufficient resources.

        var upgradeBlocked = qs('.upgradeBlocked');
        if (upgradeBlocked) {
          Logger.log('clickUpgradeButton: insufficient resources (upgradeBlocked found)');
          return { success: false, reason: 'insufficient_resources', message: 'Not enough resources for upgrade' };
        }

        // Also check legacy .notEnough indicators
        var costEls = qsa('.upgradeButtonsContainer .resources .notEnough, .inlineIcon .notEnough, .showCosts .notEnough');
        var notEnoughEl = trySelectors([
          '.upgradeButtonsContainer .section1 .notEnoughRes',
          '.contractLink .notNow',
          '.upgradeButtonsContainer .errorMessage'
        ]);

        if (notEnoughEl || (costEls && costEls.length > 0)) {
          Logger.warn('clickUpgradeButton: insufficient resources detected');
          return { success: false, reason: 'insufficient_resources', message: 'Not enough resources for upgrade' };
        }

        // Gold button without upgradeBlocked = queue full
        var goldBtn = trySelectors([
          '.upgradeButtonsContainer .section1 button.textButtonV1.gold',
          '.section1 button.gold.build',
          'button.gold.build',
          'button.textButtonV1.gold'
        ]);

        if (goldBtn) {
          Logger.warn('clickUpgradeButton: build queue full (only gold button, no green)');
          return { success: false, reason: 'queue_full', message: 'Build queue is full' };
        }

        // Step 4: Nothing found at all
        Logger.warn('clickUpgradeButton: upgrade button not found');
        // FIX 13: snapshot to help diagnose why button is missing
        if (window.DomHelpers) {
          window.DomHelpers.captureAndLog({
            action: 'clickUpgradeButton',
            selector: '.section1 button.green',
            reason: 'button_not_found'
          });
        }
        return { success: false, reason: 'button_not_found', message: 'Upgrade button not found on page' };
      } catch (e) {
        Logger.error('clickUpgradeButton error:', e);
        return false;
      }
    },

    /**
     * For empty building slots: select a building to construct by clicking
     * its tab / entry in the new building dialog.
     *
     * @param {string} buildingName - Name of the building to construct
     * @returns {Promise<boolean>}
     */
    clickNewBuildingTab: async function (buildingName) {
      try {
        Logger.log('clickNewBuildingTab:', buildingName);
        await humanDelay(200, 500);

        var nameLower = buildingName.toLowerCase();

        // Look through all building entries in the construction dialog
        var buildingEntries = qsa('.buildingWrapper') || [];
        if (buildingEntries.length === 0) {
          buildingEntries = qsa('.newBuilding .content');
        }
        if (buildingEntries.length === 0) {
          buildingEntries = qsa('#contract .buildingWrapper');
        }

        for (var i = 0; i < buildingEntries.length; i++) {
          var entry = buildingEntries[i];
          var nameEl = qs('.name', entry) || qs('h2', entry) || qs('.buildingName', entry);
          if (nameEl && nameEl.textContent.trim().toLowerCase().indexOf(nameLower) !== -1) {
            // Found the building, now click the build button inside it
            var buildBtn = qs('button.green', entry) || qs('a.green', entry) || qs('.contractLink button', entry);
            if (buildBtn) {
              await simulateHumanClick(buildBtn);
              Logger.log('clickNewBuildingTab: clicked build for', buildingName);
              return true;
            } else {
              // Click the entry itself to expand/select it
              await simulateHumanClick(entry);
              await humanDelay(300, 600);

              // Try to find and click the build button again
              buildBtn = qs('button.green', entry) || qs('a.green', entry);
              if (buildBtn) {
                await simulateHumanClick(buildBtn);
                Logger.log('clickNewBuildingTab: clicked build for', buildingName, '(after expand)');
                return true;
              }
            }
          }
        }

        // Alternative: look for tab navigation in the build dialog
        var tabs = qsa('.tabContainer .tab a') || qsa('.buildingCategoryTab a') || [];
        for (var j = 0; j < tabs.length; j++) {
          if (tabs[j].textContent.trim().toLowerCase().indexOf(nameLower) !== -1) {
            await simulateHumanClick(tabs[j]);
            Logger.log('clickNewBuildingTab: clicked tab for', buildingName);
            return true;
          }
        }

        Logger.warn('clickNewBuildingTab: building not found:', buildingName);
        return false;
      } catch (e) {
        Logger.error('clickNewBuildingTab error:', e);
        return false;
      }
    },

    // -----------------------------------------------------------------------
    // Troop Actions
    // -----------------------------------------------------------------------

    /**
     * Train troops by filling in the count and clicking the train button.
     *
     * @param {string} troopType - Troop type identifier (e.g., 't1', 't2', or input name)
     * @param {number} count - Number of troops to train
     * @returns {Promise<boolean>}
     */
    trainTroops: async function (troopType, count) {
      try {
        Logger.log('trainTroops:', troopType, 'x', count);

        if (!count || count <= 0) {
          Logger.warn('trainTroops: invalid count', count);
          return false;
        }

        await humanDelay(200, 500);

        // Find the input for this troop type
        var inputSelectors = [
          'input[name="' + troopType + '"]',
          'input[name="troops[' + troopType + ']"]',
          'input#' + troopType,
          '.troop input[name*="' + troopType + '"]',
          'input.troop' + troopType
        ];

        var filled = await fillInput(inputSelectors, count);

        if (!filled) {
          Logger.warn('trainTroops: input not found for troop type', troopType);
          return false;
        }

        // Small delay before clicking train
        await humanDelay(300, 700);

        // Click the train/start training button
        var trainSelectors = [
          'button.green.startTraining',
          'button[type="submit"].green',
          '#btn_train',
          '.startTraining button',
          'button[value="Train"]',
          'button[value="train"]',
          'input[type="submit"][value*="Train"]',
          '.trainButton',
          'form button.green'
        ];

        var clicked = await clickElement(trainSelectors);

        if (!clicked) {
          Logger.warn('trainTroops: train button not found');
          return false;
        }

        Logger.log('trainTroops: submitted training for', troopType, 'x', count);
        return true;
      } catch (e) {
        Logger.error('trainTroops error:', e);
        return false;
      }
    },

    /**
     * Train traps at the Trapper building (Gaul, gid=36).
     * Must already be on the trapper building page.
     *
     * @param {number} count - Number of traps to train
     * @returns {Promise<{success: boolean, reason?: string, message?: string}>}
     */
    trainTraps: async function (count) {
      try {
        Logger.log('trainTraps: training', count, 'traps');

        var input = await awaitSelector('input[name="t1"]', 3000);
        if (!input) {
          return { success: false, reason: 'button_not_found', message: 'Trap training input not found' };
        }

        if (input.disabled || input.max === '0') {
          return { success: false, reason: 'queue_full', message: 'Cannot train traps (building upgrading?)' };
        }

        var filled = await fillInput('input[name="t1"]', String(count));
        if (!filled) {
          return { success: false, reason: 'button_not_found', message: 'Failed to fill trap training input' };
        }

        await humanDelay(300, 600);

        var trainSelectors = [
          '.textButtonV1.green',
          'button[type="submit"].green',
          '.section1 button.green',
          'form button.green'
        ];

        var clicked = await clickElement(trainSelectors);
        if (!clicked) {
          return { success: false, reason: 'button_not_found', message: 'Train button not found' };
        }

        Logger.log('trainTraps: submitted training for', count, 'traps');
        return { success: true };
      } catch (e) {
        Logger.error('trainTraps error:', e);
        return { success: false, reason: 'button_not_found', message: e.message };
      }
    },

    // -----------------------------------------------------------------------
    // Farming / Rally Point
    // -----------------------------------------------------------------------

    /**
     * Click the farm list tab on the rally point page (tt=99).
     * Must already be on a rally point page (build.php?id=39).
     * This triggers a page navigation/reload.
     *
     * @returns {Promise<boolean>}
     */
    clickFarmListTab: async function () {
      try {
        Logger.log('clickFarmListTab');
        await humanDelay(200, 500);

        // Check if already on farm list tab
        if (window.location.href.indexOf('tt=99') !== -1) {
          Logger.log('clickFarmListTab: already on farm list tab');
          return true;
        }

        var tabSelectors = [
          'a[href*="tt=99"]',
          '.favorKey99 a',
          '.tabContainer a[href*="tt=99"]',
          '.contentNavi a[href*="tt=99"]',
          'nav a[href*="tt=99"]'
        ];

        var clicked = await clickElement(tabSelectors);

        if (!clicked) {
          Logger.warn('clickFarmListTab: farm list tab not found');
          return false;
        }

        Logger.log('clickFarmListTab: clicked farm list tab');
        return true;
      } catch (e) {
        Logger.error('clickFarmListTab error:', e);
        return false;
      }
    },

    /**
     * Click the start/send button on a specific farm list by ID or index.
     * Must already be on the rally point farm list tab (tt=99).
     *
     * @param {string} farmListId - Farm list data-listid, data-id, or numeric index
     * @returns {Promise<boolean>}
     */
    sendFarmList: async function (farmListId) {
      try {
        Logger.log('sendFarmList:', farmListId);
        await humanDelay(300, 600);

        // Find the specific farm list container (.farmListWrapper in Travian Legends)
        var allLists = qsa('.farmListWrapper, .raidList, .farmList');

        var listEl = null;

        // Try data-listid first
        listEl = trySelectors([
          '.farmListWrapper[data-listid="' + farmListId + '"]',
          '[data-listid="' + farmListId + '"]',
          '.raidList[data-id="' + farmListId + '"]'
        ]);

        // Fall back to index
        if (!listEl) {
          var idx = parseInt(farmListId, 10);
          if (!isNaN(idx) && idx >= 0 && idx < allLists.length) {
            listEl = allLists[idx];
          }
        }

        if (!listEl) {
          Logger.warn('sendFarmList: farm list not found:', farmListId);
          return false;
        }

        // Click the start button inside this farm list
        var startBtn = trySelectors([
          'button.startFarmList',
          '.farmListHeader button.green',
          'button.startButton',
          'button.green.startRaid',
          '.buttonsWrapper button.green'
        ], listEl);

        if (!startBtn) {
          Logger.warn('sendFarmList: start button not found in list:', farmListId);
          return false;
        }

        await simulateHumanClick(startBtn);
        Logger.log('sendFarmList: started farm list', farmListId);
        return true;
      } catch (e) {
        Logger.error('sendFarmList error:', e);
        return false;
      }
    },

    /**
     * Click the "Start all farm lists" button, or click start on each list individually.
     * Must already be on the rally point farm list tab (tt=99).
     *
     * @returns {Promise<{success: boolean, started: number, total: number}>}
     */
    sendAllFarmLists: async function () {
      try {
        Logger.log('sendAllFarmLists');
        await humanDelay(300, 600);

        // Preferred: Use the global "Start all farm lists" button if available
        var startAllBtn = qs('button.startAllFarmLists');
        if (startAllBtn) {
          await simulateHumanClick(startAllBtn);
          Logger.log('sendAllFarmLists: clicked startAllFarmLists button');
          return { success: true, started: 1, total: 1 };
        }

        // Fallback: Click start on each farm list individually
        var allLists = qsa('.farmListWrapper, .raidList, .farmList');

        if (allLists.length === 0) {
          Logger.warn('sendAllFarmLists: no farm lists found on page');
          return { success: false, started: 0, total: 0 };
        }

        var started = 0;

        for (var i = 0; i < allLists.length; i++) {
          var listEl = allLists[i];

          var startBtn = trySelectors([
            'button.startFarmList',
            '.farmListHeader button.green',
            'button.startButton',
            'button.green.startRaid',
            '.buttonsWrapper button.green'
          ], listEl);

          if (startBtn) {
            await simulateHumanClick(startBtn);
            started++;
            Logger.log('sendAllFarmLists: started list', i + 1, 'of', allLists.length);

            if (i < allLists.length - 1) {
              await humanDelay(800, 2000);
            }
          } else {
            Logger.warn('sendAllFarmLists: no start button in list', i);
          }
        }

        Logger.log('sendAllFarmLists: started', started, 'of', allLists.length, 'lists');
        return { success: started > 0, started: started, total: allLists.length };
      } catch (e) {
        Logger.error('sendAllFarmLists error:', e);
        return { success: false, started: 0, total: 0 };
      }
    },

    /**
     * Selective farm send: scan slots, uncheck bad targets, check good targets, then start.
     * Skips slots where troops were lost or loot is below threshold.
     *
     * @param {object} opts - { minLoot: number, skipLosses: boolean }
     * @returns {Promise<{ success, sent, skipped, total }>}
     */
    selectiveFarmSend: async function (opts) {
      try {
        opts = opts || {};
        var minLoot = opts.minLoot || 30;
        var skipLosses = opts.skipLosses !== false;

        Logger.log('selectiveFarmSend: minLoot=' + minLoot + ' skipLosses=' + skipLosses);
        await humanDelay(300, 600);

        // Must be on farm list tab
        if (window.location.href.indexOf('tt=99') === -1) {
          Logger.warn('selectiveFarmSend: not on farm list tab');
          return { success: false, sent: 0, skipped: 0, total: 0 };
        }

        var allLists = qsa('.farmListWrapper, .raidList, .farmList');
        if (allLists.length === 0) {
          Logger.warn('selectiveFarmSend: no farm lists found');
          return { success: false, sent: 0, skipped: 0, total: 0 };
        }

        var totalSent = 0;
        var totalSkipped = 0;
        var totalSlots = 0;

        for (var li = 0; li < allLists.length; li++) {
          var listEl = allLists[li];
          var slots = qsa('.slot', listEl);
          var sentThisList = 0;
          var skippedThisList = 0;

          // First: uncheck all by clicking "select all" twice (check then uncheck)
          var selectAllBox = qs('input[data-check-all="true"]', listEl);
          if (selectAllBox) {
            if (!selectAllBox.checked) {
              selectAllBox.click();
              await delay(100);
            }
            selectAllBox.click(); // uncheck all
            await delay(100);
          }

          // Now selectively check good targets
          for (var si = 0; si < slots.length; si++) {
            var slot = slots[si];
            var checkbox = qs('input[type="checkbox"][name="selectOne"]', slot);
            if (!checkbox) continue;
            totalSlots++;

            // Check if troops are already on the way (ongoing raid)
            var stateTd = qs('td.state', slot);
            var ongoingIcon = stateTd ? qs('i', stateTd) : null;
            var isOngoing = !!ongoingIcon; // any icon in td.state = troops on the way

            // Read raid status (last completed raid result)
            var raidIcon = qs('i.lastRaidState', slot);
            var raidClass = raidIcon ? (raidIcon.className || '') : '';
            var lost = raidClass.indexOf('attack_lost') !== -1;
            var withLosses = raidClass.indexOf('withLosses') !== -1;

            // Read last loot
            var bountyVal = qs('.lastRaidBounty .value', slot);
            var lastLoot = bountyVal ? (parseInt(bountyVal.textContent.replace(/[^\d]/g, ''), 10) || 0) : 0;

            // Decision: skip if ongoing, losses, or loot below threshold
            var skip = false;
            if (isOngoing) {
              skip = true; // troops already on the way — don't send again
            }
            if (skipLosses && (lost || withLosses)) {
              skip = true;
            }
            if (lastLoot > 0 && lastLoot < minLoot) {
              skip = true;
            }

            if (skip) {
              skippedThisList++;
              // Ensure unchecked (should be from the uncheck-all above)
              if (checkbox.checked) checkbox.click();
            } else {
              sentThisList++;
              // Check this target
              if (!checkbox.checked) checkbox.click();
              await delay(randomInt(30, 80));
            }
          }

          Logger.log('selectiveFarmSend: list ' + li + ' — sending ' + sentThisList + ', skipping ' + skippedThisList);

          // Click the per-list start button (sends only checked targets)
          if (sentThisList > 0) {
            var startBtn = trySelectors([
              '.farmListHeader button.startFarmList',
              'button.startFarmList',
              '.farmListHeader button.green'
            ], listEl);

            if (startBtn) {
              await humanDelay(200, 500);
              await simulateHumanClick(startBtn);
              Logger.log('selectiveFarmSend: clicked start for list ' + li);
            } else {
              Logger.warn('selectiveFarmSend: no start button for list ' + li);
            }
          }

          totalSent += sentThisList;
          totalSkipped += skippedThisList;

          if (li < allLists.length - 1) {
            await humanDelay(500, 1000);
          }
        }

        Logger.log('selectiveFarmSend: done — sent=' + totalSent + ' skipped=' + totalSkipped + ' total=' + totalSlots);
        return { success: totalSent > 0, sent: totalSent, skipped: totalSkipped, total: totalSlots };
      } catch (e) {
        Logger.error('selectiveFarmSend error:', e);
        return { success: false, sent: 0, skipped: 0, total: 0 };
      }
    },

    /**
     * Add a target to a farm list by coordinates using direct REST API.
     * Bypasses Travian FormV2 which blocks programmatic form submission.
     * Must be called while on the rally point farm list page (tt=99).
     *
     * @param {object} params
     * @param {number} params.x - Target X coordinate
     * @param {number} params.y - Target Y coordinate
     * @param {Object} [params.troops] - Troop map { t1: N, ... t10: N }, defaults to { t1: 1 }
     * @param {number} [params.listId] - Farm list ID (auto-detected from React fiber if omitted)
     * @returns {Promise<{success:boolean, reason?:string, message:string}>}
     */
    addToFarmList: async function (params) {
      var x = params.x;
      var y = params.y;
      var troops = params.troops || { t1: 1 };
      var listId = params.listId || null;

      Logger.log('Adding to farm list via API: (' + x + '|' + y + ')');

      if (window.location.href.indexOf('tt=99') === -1) {
        return { success: false, reason: 'wrong_page', message: 'Not on farm list page (tt=99)' };
      }

      // Auto-detect listId from React fiber if not provided
      if (!listId) {
        listId = await _getFarmListId();
      }
      if (!listId) {
        return { success: false, reason: 'building_not_available', message: 'Cannot detect farm list ID from page' };
      }

      // Build units map (t1..t10)
      var units = {};
      for (var ti = 1; ti <= 10; ti++) {
        units['t' + ti] = troops['t' + ti] || 0;
      }

      var gameVersion = _getGameVersion();
      Logger.log('Calling farm-list/slot API: listId=' + listId + ' (' + x + '|' + y + ') v' + gameVersion);

      try {
        var apiResult = await _callFarmListSlotApi({
          listId: listId,
          x: Number(x),
          y: Number(y),
          units: units,
          gameVersion: gameVersion
        });

        if (!apiResult.ok) {
          Logger.warn('farm-list/slot API error: ' + apiResult.error);
          if (apiResult.error === 'raidList.targetExists') {
            return { success: false, reason: 'duplicate', message: 'Target (' + x + '|' + y + ') already in farm list' };
          }
          return { success: false, reason: 'save_failed', message: 'API error: ' + apiResult.error };
        }

        Logger.log('farm-list/slot API success for (' + x + '|' + y + ')');
        return { success: true, message: 'Added (' + x + '|' + y + ') to farm list via API' };
      } catch (err) {
        Logger.error('farm-list/slot error: ' + err.message);
        return { success: false, reason: 'save_failed', message: 'Error: ' + err.message };
      }
    },

    /**
     * Fill in the rally point attack form and send an attack.
     *
     * @param {{ x: number, y: number }} target - Target coordinates
     * @param {Object} troops - Map of troop type/input name to count
     * @returns {Promise<boolean>}
     */
    sendAttack: async function (target, troops) {
      try {
        Logger.log('sendAttack: target', target, 'troops', troops);

        if (!target || target.x == null || target.y == null) {
          Logger.warn('sendAttack: invalid target', target);
          return false;
        }

        await humanDelay(300, 600);

        // Fill in target coordinates
        var xFilled = await fillInput(
          ['input[name="x"]', 'input#xCoordInput', 'input.coordinateX', '#xCoord'],
          target.x
        );
        await humanDelay(100, 300);

        var yFilled = await fillInput(
          ['input[name="y"]', 'input#yCoordInput', 'input.coordinateY', '#yCoord'],
          target.y
        );

        if (!xFilled || !yFilled) {
          Logger.warn('sendAttack: could not fill coordinate inputs');
          return false;
        }

        await humanDelay(200, 500);

        // Fill in troop counts
        var troopKeys = Object.keys(troops);
        for (var i = 0; i < troopKeys.length; i++) {
          var troopType = troopKeys[i];
          var troopCount = troops[troopType];

          if (troopCount > 0) {
            var troopInputSelectors = [
              'input[name="' + troopType + '"]',
              'input[name="troops[' + troopType + ']"]',
              'input#' + troopType,
              'input.troop' + troopType
            ];

            await fillInput(troopInputSelectors, troopCount);
            await humanDelay(150, 350);
          }
        }

        await humanDelay(300, 600);

        // Select attack mode (radio button)
        var attackRadio = trySelectors([
          'input[name="eventType"][value="4"]',  // attack/raid
          'input[name="c"][value="4"]',
          'input#attack',
          'input[value="attack"]',
          'label.attack input[type="radio"]'
        ]);

        if (attackRadio) {
          await simulateHumanClick(attackRadio);
          await humanDelay(200, 400);
        }

        // Click the send / confirm button
        var sendBtn = trySelectors([
          'button#btn_ok',
          'button.green[type="submit"]',
          'button.sendTroops',
          '#btn_ok',
          'input[type="submit"][name="ok"]',
          'button[value="ok"]'
        ]);

        if (!sendBtn) {
          Logger.warn('sendAttack: send button not found');
          return false;
        }

        await simulateHumanClick(sendBtn);
        Logger.log('sendAttack: first form submitted, waiting for confirmation');

        // Wait for confirmation page
        await humanDelay(800, 1500);

        // Click the confirm button on the confirmation page
        var confirmBtn = trySelectors([
          'button#btn_ok',
          'button.green[type="submit"]',
          'button.rallyPointConfirm',
          '#btn_ok',
          'input[type="submit"][name="s1"]',
          'button[value="Confirm"]'
        ]);

        if (confirmBtn) {
          await simulateHumanClick(confirmBtn);
          Logger.log('sendAttack: confirmed attack');
        } else {
          Logger.warn('sendAttack: confirmation button not found (attack may have been sent on first click)');
        }

        return true;
      } catch (e) {
        Logger.error('sendAttack error:', e);
        return false;
      }
    },

    // -----------------------------------------------------------------------
    // Hero Adventure
    // -----------------------------------------------------------------------

    /**
     * Send the hero on the first available adventure.
     * Must already be on /hero/adventures page.
     *
     * @returns {Promise<boolean>}
     */
    sendHeroAdventure: async function () {
      try {
        Logger.log('sendHeroAdventure');
        await humanDelay(300, 600);

        // Check if hero is away or dead (button area shows status)
        var heroAway = trySelectors([
          '.heroStatusMessage',
          '.heroState [class*="statusAway"]',
          '.heroState [class*="statusDead"]'
        ]);

        // Check if adventure list is empty
        var adventureRows = qsa('.adventureList tbody tr');
        if (!adventureRows || adventureRows.length === 0) {
          Logger.warn('sendHeroAdventure: no adventures available');
          return { success: false, reason: 'no_adventure', message: 'No adventures available' };
        }

        // Find the first adventure row with a send button
        var sendBtn = trySelectors([
          '.adventureList tbody tr td.button button.green',
          '.adventureList tbody tr td.button button',
          '.adventureList tbody tr td.button a.green',
          '#heroAdventure button.green',
          'button.textButtonV2.green'
        ]);

        if (!sendBtn) {
          // Buttons exist but are disabled = hero is away/dead
          var disabledBtn = trySelectors([
            '.adventureList tbody tr td.button button:disabled',
            '.adventureList tbody tr td.button button.disabled'
          ]);
          if (disabledBtn || heroAway) {
            Logger.warn('sendHeroAdventure: hero is away or dead');
            return { success: false, reason: 'hero_unavailable', message: 'Hero is away or dead' };
          }
          Logger.warn('sendHeroAdventure: no adventure send button found');
          return { success: false, reason: 'no_adventure', message: 'No send button found' };
        }

        await simulateHumanClick(sendBtn);
        Logger.log('sendHeroAdventure: clicked send on first adventure');

        // Wait for possible confirmation dialog
        await humanDelay(800, 1500);

        // Check for confirmation button (some versions ask for confirmation)
        var confirmBtn = trySelectors([
          '.dialogButtonOk',
          '.dialog button.green',
          '#ok',
          'button.green[type="submit"]'
        ]);

        if (confirmBtn) {
          await simulateHumanClick(confirmBtn);
          Logger.log('sendHeroAdventure: confirmed adventure');
        }

        return true;
      } catch (e) {
        Logger.error('sendHeroAdventure error:', e);
        return false;
      }
    },

    // -----------------------------------------------------------------------
    // Hero Inventory - Claim resource items
    // -----------------------------------------------------------------------

    // ── Hero UI Selectors (centralised for easy update after Travian patches) ──
    // V1 = pre-Changelog-367 (one-at-a-time dialog per resource)
    // V2 = post-Changelog-367 (bulk transfer: all 4 resources at once)
    // After inspecting the new DOM via MCP, update the V2 block below.
    _heroSelectors: {
      // ── V1 selectors (confirmed working pre-367) ──────────────────────
      v1: {
        // Item containers on /hero/inventory
        itemList:   '.heroItems .heroItem, .heroInventory .heroItem, #itemsToSale .heroItem, .inventoryContent .item',
        // Child element whose class contains the item ID (e.g. "item item145")
        itemChild:  '[class*="item item"]',
        // Resource item IDs regex (small: 145-148, large: 176-179)
        resourceIdPattern: /item14[5678]|item17[6789]/,
        // Count badge inside each item
        countChild: '.count',
        // Dialog that opens when clicking a resource item
        dialog:     '.heroConsumablesPopup, .dialogContent, .dialog.plain',
        // Input field inside the dialog to set transfer amount
        dialogInput: [
          '.heroConsumablesPopup input[type="text"]',
          '.dialog input[type="text"]',
          '.dialogContainer input[type="number"]',
          '.dialogContainer input',
          '.heroConsumablesPopup input'
        ],
        // Green confirm button in dialog
        dialogConfirm: [
          '.heroConsumablesPopup button.green',
          '.dialog button.green',
          '.dialogContainer button.green',
          '.dialogButtonOk',
          '#ok',
          'button.green[type="submit"]',
          'button.green[type="button"]'
        ],
        // Grey cancel button in dialog
        dialogCancel: '.heroConsumablesPopup button.grey, .dialog button.grey, button.textButtonV2.grey'
      },

      // ── V2 selectors (post-Changelog-367 bulk transfer UI) ────────────
      // TODO: Fill these in after MCP DOM inspection of the new hero inventory.
      // The new UI allows transferring all 4 resources at once with:
      //   - individual amount inputs per resource (or drag-to-select)
      //   - a "transfer max" button
      //   - a single confirm button for all resources
      v2: {
        // Container for the new bulk transfer panel (inspect DOM to find)
        bulkPanel:       null, // e.g. '.heroResourceTransfer', '.resourceTransferPanel'
        // Individual resource input fields inside the bulk panel
        // Keys: wood/clay/iron/crop, values: CSS selectors for input elements
        resourceInputs:  {
          wood: null, // e.g. '.resourceTransfer input[data-resource="wood"]'
          clay: null,
          iron: null,
          crop: null
        },
        // "Transfer max" / "Transfer all" button (per-resource or global)
        maxButton:       null, // e.g. '.transferMax', 'button.maxTransfer'
        // Green confirm/submit button for the bulk transfer
        confirmButton:   null, // e.g. '.resourceTransfer button.green', 'button.transferConfirm'
        // Cancel / close button
        cancelButton:    null, // e.g. '.resourceTransfer button.grey'
        // Item list (may be same as V1 or changed)
        itemList:        null, // e.g. same as v1.itemList or new selector
        // Resource count display (may have moved)
        countChild:      null, // e.g. same as v1.countChild or new selector
        // Item child class for resource type detection
        itemChild:       null,
        resourceIdPattern: null // may be same regex or new pattern
      }
    },

    /**
     * Detect which hero inventory UI version is active.
     * Called on /hero/inventory page. Returns 'v2' if new bulk transfer UI
     * is detected, otherwise 'v1' (legacy one-at-a-time dialog).
     *
     * After MCP inspection, update the v2 detection markers below.
     *
     * @returns {string} 'v1' or 'v2'
     */
    detectHeroUIVersion: function () {
      var sel = this._heroSelectors;

      // V2 detection: check for the new bulk transfer panel
      // TODO: Update these markers after MCP DOM inspection
      if (sel.v2.bulkPanel) {
        var bulkEl = qs(sel.v2.bulkPanel);
        if (bulkEl) {
          Logger.log('detectHeroUIVersion: V2 (bulk transfer) detected');
          return 'v2';
        }
      }

      // Heuristic fallback: look for common new-UI markers
      // Changelog says: "transfer all four resources at once", "drag with mouse to select amounts"
      // These hints suggest a multi-input panel (not a per-item popup dialog)
      var heuristicSelectors = [
        '.resourceTransferPanel',
        '.heroResourceTransfer',
        '.bulkTransfer',
        '.transferAll',
        '.resourceTransfer',
        '[class*="resourceTransfer"]',
        '[class*="bulkTransfer"]',
        '.heroConsumablesV2'
      ];
      for (var i = 0; i < heuristicSelectors.length; i++) {
        if (qs(heuristicSelectors[i])) {
          Logger.log('detectHeroUIVersion: V2 detected via heuristic (' + heuristicSelectors[i] + ')');
          return 'v2';
        }
      }

      // Default: V1 (legacy)
      Logger.log('detectHeroUIVersion: V1 (legacy) — no bulk transfer markers found');
      return 'v1';
    },

    /**
     * Use a hero inventory item (resource bucket, etc.) by index.
     * Must already be on /hero/inventory page.
     * Uses V1 (legacy one-at-a-time dialog) selectors.
     *
     * @param {number} itemIndex - Index of the item to use (0-based among all .heroItem elements)
     * @param {number} [amount] - Optional specific amount to transfer. If omitted, uses Travian default (fill warehouse).
     * @returns {Promise<object>}
     */
    useHeroItem: async function (itemIndex, amount) {
      try {
        Logger.log('useHeroItem: claiming item at index', itemIndex, 'amount:', amount || 'default');
        await humanDelay(300, 600);

        var sel = this._heroSelectors.v1;

        // In Travian Legends, hero items don't have "use" buttons.
        // You click the .heroItem element directly → a dialog opens → click green confirm button.
        // IMPORTANT: Must use same selectors as scanHeroInventory so indices match!
        var heroItems = qsa(sel.itemList);

        if (!heroItems || heroItems.length === 0) {
          Logger.warn('useHeroItem: no hero items found on page');
          return { success: false, reason: 'no_items', message: 'No hero items found on page' };
        }

        var idx = (itemIndex != null) ? itemIndex : 0;
        if (idx >= heroItems.length) {
          Logger.warn('useHeroItem: index ' + idx + ' out of range (' + heroItems.length + ' items)');
          return { success: false, reason: 'no_items', message: 'Item index out of range' };
        }

        // Click the item itself to open the consumable dialog
        await simulateHumanClick(heroItems[idx]);
        Logger.log('useHeroItem: clicked item at index', idx);

        // Wait for the consumable dialog to appear
        var dialogPopup = await awaitSelector(sel.dialog, 3000);
        if (!dialogPopup) {
          Logger.warn('useHeroItem: dialog did not appear after clicking item');
          return { success: false, reason: 'no_items', message: 'Item dialog did not open' };
        }
        await humanDelay(300, 600);

        // In Travian Legends, hero resource dialog asks for RESOURCE AMOUNT to transfer.
        // Default is auto-calculated to fill warehouse to capacity — which is wasteful!
        // SAFETY: If no amount specified, CANCEL dialog to avoid draining hero resources.
        if (!amount || amount <= 0) {
          Logger.warn('useHeroItem: no specific amount — cancelling dialog to avoid waste');
          var cancelBtn2 = qs(sel.dialogCancel);
          if (cancelBtn2) cancelBtn2.click();
          return { success: false, reason: 'no_amount', message: 'No transfer amount specified, cancelled to avoid waste' };
        }
        var useAmount = Math.ceil(amount);
        var filled = await fillInput(sel.dialogInput, useAmount);
        if (filled) {
          Logger.log('useHeroItem: set transfer amount to', useAmount);
        } else {
          // CRITICAL: If we can't set the amount, the dialog default may transfer everything!
          // Cancel instead of proceeding with unknown amount.
          Logger.warn('useHeroItem: could not set amount in input — cancelling to avoid waste');
          var cancelBtn3 = qs(sel.dialogCancel);
          if (cancelBtn3) cancelBtn3.click();
          return { success: false, reason: 'button_not_found', message: 'Could not set transfer amount' };
        }
        await humanDelay(200, 400);

        // Click the green confirm/transfer button in the dialog
        var confirmBtn = trySelectors(sel.dialogConfirm);
        if (confirmBtn) {
          await simulateHumanClick(confirmBtn);
          Logger.log('useHeroItem: confirmed transfer');
          await humanDelay(500, 1000);
          return { success: true };
        } else {
          // Dialog opened but no green button — close it
          var cancelBtn = qs(sel.dialogCancel);
          if (cancelBtn) cancelBtn.click();
          Logger.warn('useHeroItem: no confirm button found in dialog');
          return { success: false, reason: 'button_not_found', message: 'No confirm button in item dialog' };
        }
      } catch (e) {
        Logger.error('useHeroItem error:', e);
        return { success: false, reason: 'button_not_found', message: e.message };
      }
    },

    /**
     * [V2] Bulk-transfer hero resources using the new Changelog-367 UI.
     * Transfers multiple resource types in a single operation instead of
     * opening per-item dialogs one at a time.
     *
     * Must already be on /hero/inventory page with V2 UI active.
     *
     * @param {object} amounts - { wood: number, clay: number, iron: number, crop: number }
     *   Each value = amount to transfer (0 or omitted = skip that resource).
     * @returns {Promise<object>} { success, transferred: {wood,clay,iron,crop}, reason?, message? }
     */
    useHeroItemBulk: async function (amounts) {
      try {
        var sel = this._heroSelectors.v2;
        Logger.log('useHeroItemBulk: transferring', JSON.stringify(amounts));
        await humanDelay(300, 600);

        // ── Guard: V2 selectors must be configured ──
        if (!sel.bulkPanel) {
          Logger.warn('useHeroItemBulk: V2 selectors not configured — cannot proceed');
          return { success: false, reason: 'button_not_found', message: 'V2 hero selectors not configured. Run MCP inspection and update _heroSelectors.v2.' };
        }

        // ── Step 1: Verify bulk panel is visible ──
        var panel = await awaitSelector(sel.bulkPanel, 3000);
        if (!panel) {
          Logger.warn('useHeroItemBulk: bulk transfer panel not found');
          return { success: false, reason: 'button_not_found', message: 'Bulk transfer panel not found' };
        }

        // ── Step 2: Fill in amounts for each resource type ──
        var transferred = { wood: 0, clay: 0, iron: 0, crop: 0 };
        var resTypes = ['wood', 'clay', 'iron', 'crop'];
        for (var i = 0; i < resTypes.length; i++) {
          var resType = resTypes[i];
          var amt = amounts[resType] || 0;
          if (amt <= 0) continue;

          var inputSel = sel.resourceInputs[resType];
          if (!inputSel) {
            Logger.warn('useHeroItemBulk: no input selector for ' + resType);
            continue;
          }

          var inputEl = qs(inputSel, panel);
          if (!inputEl) {
            // Try outside panel scope
            inputEl = qs(inputSel);
          }
          if (!inputEl) {
            Logger.warn('useHeroItemBulk: input element not found for ' + resType);
            continue;
          }

          // Clear existing value and type new amount
          var useAmount = Math.ceil(amt);
          // Use nativeSetter for React-controlled inputs
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(inputEl, String(useAmount));
          } else {
            inputEl.value = String(useAmount);
          }
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          transferred[resType] = useAmount;
          Logger.log('useHeroItemBulk: set ' + resType + ' = ' + useAmount);
          await humanDelay(100, 250);
        }

        // ── Step 3: Click confirm button ──
        var hasAny = transferred.wood + transferred.clay + transferred.iron + transferred.crop > 0;
        if (!hasAny) {
          Logger.warn('useHeroItemBulk: no amounts to transfer');
          return { success: false, reason: 'no_amount', message: 'All transfer amounts are zero' };
        }
        await humanDelay(200, 400);

        var confirmBtn = qs(sel.confirmButton, panel) || qs(sel.confirmButton);
        if (!confirmBtn) {
          Logger.warn('useHeroItemBulk: confirm button not found');
          // Try to cancel to avoid stuck state
          var cancelBtn = qs(sel.cancelButton, panel) || qs(sel.cancelButton);
          if (cancelBtn) cancelBtn.click();
          return { success: false, reason: 'button_not_found', message: 'No confirm button in bulk transfer panel' };
        }

        await simulateHumanClick(confirmBtn);
        Logger.log('useHeroItemBulk: confirmed bulk transfer');
        await humanDelay(500, 1000);

        return { success: true, transferred: transferred };
      } catch (e) {
        Logger.error('useHeroItemBulk error:', e);
        return { success: false, reason: 'button_not_found', message: e.message };
      }
    },

    /**
     * Scan hero inventory and return items info.
     * Must be on hero page (/hero/inventory).
     * Auto-detects V1 vs V2 UI and includes uiVersion in result.
     *
     * @returns {Promise<object>}
     */
    scanHeroInventory: async function () {
      try {
        Logger.log('scanHeroInventory');
        await humanDelay(200, 400);

        // Detect UI version
        var uiVersion = this.detectHeroUIVersion();
        var sel = (uiVersion === 'v2' && this._heroSelectors.v2.itemList)
          ? this._heroSelectors.v2
          : this._heroSelectors.v1;
        var resPattern = sel.resourceIdPattern || this._heroSelectors.v1.resourceIdPattern;

        var items = [];
        // Hero inventory items - look for item containers
        var itemEls = qsa(sel.itemList || this._heroSelectors.v1.itemList);

        if (itemEls && itemEls.length > 0) {
          for (var i = 0; i < itemEls.length; i++) {
            var el = itemEls[i];
            var title = el.getAttribute('title') || '';
            var alt = (qs('img', el) || {}).alt || '';
            var cls = el.getAttribute('class') || '';
            var tier = el.getAttribute('data-tier') || '';

            // Detect resource items by child .item class (Travian item IDs):
            // Small crates: item145=wood, item146=clay, item147=iron, item148=crop
            // Large crates: item176=wood, item177=clay, item178=iron, item179=crop
            var childSel = sel.itemChild || this._heroSelectors.v1.itemChild;
            var itemChild = qs(childSel, el);
            var itemChildCls = itemChild ? (itemChild.className || '') : '';
            var isResourceByItemId = resPattern.test(itemChildCls);

            // Fallback: also check title/class for older Travian versions
            var isResourceByText = cls.indexOf('resource') !== -1 ||
                             title.toLowerCase().indexOf('resource') !== -1 ||
                             title.indexOf('ทรัพยากร') !== -1 ||
                             /wood|clay|iron|crop|lumber|brick|grain/i.test(title + alt) ||
                             /ไม้|ดิน|เหล็ก|ข้าว/i.test(title);

            var isResource = isResourceByItemId || isResourceByText;

            // Consumable items are usable by clicking them directly (opens dialog)
            // No "use button" exists on the item — the item itself is clickable
            var isConsumable = tier === 'consumable' || cls.indexOf('consumable') !== -1;

            // Read count from .count child element
            var countSel = sel.countChild || this._heroSelectors.v1.countChild;
            var countEl = qs(countSel, el);
            var count = countEl ? parseInt(countEl.textContent.trim(), 10) || 0 : 0;

            items.push({
              index: i,
              title: title || alt || ('Item ' + i),
              isResource: isResource,
              hasUseButton: isConsumable || isResource, // consumable items are clickable
              className: cls,
              itemClass: itemChildCls,
              count: count
            });
          }
        }

        Logger.log('scanHeroInventory: found', items.length, 'items, resources:', items.filter(function(x){return x.isResource;}).length, 'uiVersion:', uiVersion);
        return { success: true, items: items, uiVersion: uiVersion };
      } catch (e) {
        Logger.error('scanHeroInventory error:', e);
        return { success: false, items: [], uiVersion: 'v1' };
      }
    },

    // -----------------------------------------------------------------------
    // Build New Building by GID in empty slot
    // -----------------------------------------------------------------------

    /**
     * Build a new building in an empty slot by GID.
     * Must be on the empty slot page (build.php?id=XX where slot is empty).
     *
     * @param {number} gid - Building GID (e.g., 23 for Cranny)
     * @returns {Promise<boolean|object>}
     */
    buildNewByGid: async function (gid) {
      try {
        Logger.log('buildNewByGid: building GID', gid);

        // Wait for the build page to be ready (may have just navigated here).
        // IMPORTANT: Wait specifically for .buildingWrapper (= building list loaded).
        // Don't resolve early on .contentNavi .tabItem (tabs load before buildings).
        var targetWrapper = await awaitSelector('#contract_building' + gid, 5000);
        if (!targetWrapper) {
          // Target not found — try waiting for ANY .buildingWrapper to confirm the page loaded
          var anyWrapper = await awaitSelector('.buildingWrapper', 3000);
          if (!anyWrapper) {
            // Page might not be a build page at all, or still loading
            var tabsExist = qs('.contentNavi .tabItem');
            if (tabsExist) {
              // Tabs exist but no buildings → building is in a different tab
              Logger.log('buildNewByGid: tabs visible but no .buildingWrapper — may be in different tab');
            } else {
              Logger.warn('buildNewByGid: build page not ready (no tabs, no wrappers)');
              return { success: false, reason: 'button_not_found', message: 'Build page did not load' };
            }
          }
        }
        await humanDelay(300, 600);

        // Buildings are identified by wrapper id="contract_building{GID}"
        // e.g., #contract_building23 = Cranny, #contract_building10 = Warehouse
        // Each wrapper has inline .upgradeButtonsContainer with build button

        // Helper: try to find and click build button for the target GID
        function tryBuildInCurrentTab(targetGid) {
          var wrapper = qs('#contract_building' + targetGid);
          if (!wrapper) return null;

          // Found the building wrapper — check for green build button
          var buildBtn = qs('.section1 .textButtonV1.green', wrapper) ||
                         qs('.section1 button.green', wrapper) ||
                         qs('button.textButtonV1.green', wrapper);

          if (buildBtn) return { action: 'build', btn: buildBtn };

          // No green button — distinguish insufficient resources vs queue full.
          //
          // On the build-new page, when resources are insufficient:
          //   - .upgradeBlocked element appears (contains gold exchange button)
          //   - section1 gets gold.builder button (master builder premium)
          //   - .notEnough class is NOT present (unlike upgrade pages)
          //
          // When queue is full (upgrade pages):
          //   - Only gold builder button in section1, no .upgradeBlocked
          //
          // So check .upgradeBlocked FIRST to detect insufficient resources.

          var upgradeBlocked = qs('.upgradeBlocked', wrapper);
          if (upgradeBlocked) return { action: 'insufficient_resources' };

          // Also check .notEnough (used on upgrade pages for existing buildings)
          var notEnough = qsa('.notEnough', wrapper);
          if (notEnough && notEnough.length > 0) return { action: 'insufficient_resources' };

          // Gold button in section1 without upgradeBlocked = queue full
          var goldBtn = qs('.section1 .textButtonV1.gold', wrapper) ||
                        qs('.section1 button.gold', wrapper);
          if (goldBtn) return { action: 'queue_full' };

          return { action: 'no_button' };
        }

        // Scroll the target building into view BEFORE checking button state.
        // Travian lazy-renders button sections — buildings below the viewport
        // show .upgradeBlocked as a default placeholder until scrolled into view,
        // at which point Travian's JS updates to show the green build button.
        var preScrollWrapper = qs('#contract_building' + gid);
        if (preScrollWrapper) {
          preScrollWrapper.scrollIntoView({ behavior: 'instant', block: 'center' });
          await humanDelay(500, 800);
        }

        // Check current tab only — do NOT switch tabs here!
        // Tab clicks cause page reload which destroys content script mid-function.
        // Tab switching is handled by botEngine as separate steps.
        var result = tryBuildInCurrentTab(gid);

        if (!result) {
          Logger.log('buildNewByGid: building GID', gid, 'not found in current tab (will try other tabs)');
          // FIX 13: snapshot to diagnose missing building
          if (window.DomHelpers) {
            window.DomHelpers.captureAndLog({
              action: 'buildNewByGid',
              selector: '#contract_building' + gid,
              reason: 'building_not_in_tab'
            });
          }
          return { success: false, reason: 'building_not_in_tab', message: 'Building GID ' + gid + ' not in current tab' };
        }

        // Act on the result
        switch (result.action) {
          case 'build':
            await simulateHumanClick(result.btn);
            Logger.log('buildNewByGid: clicked build button for GID', gid);
            return true;

          case 'queue_full':
            Logger.warn('buildNewByGid: queue full (only gold builder available)');
            return { success: false, reason: 'queue_full', message: 'Build queue is full' };

          case 'insufficient_resources':
            Logger.log('buildNewByGid: insufficient resources for GID', gid);
            return { success: false, reason: 'insufficient_resources', message: 'Not enough resources to build' };

          default:
            Logger.warn('buildNewByGid: build button not found for GID', gid);
            return { success: false, reason: 'button_not_found', message: 'Build button not found' };
        }
      } catch (e) {
        Logger.error('buildNewByGid error:', e);
        return { success: false, reason: 'button_not_found', message: e.message };
      }
    },

    // -----------------------------------------------------------------------
    // Build Tab Navigation (for new building construction)
    // -----------------------------------------------------------------------

    /**
     * Click a build category tab on the empty slot page by index.
     * This causes a page reload — call from botEngine as a separate step.
     *
     * @param {number} tabIndex - 0-based tab index (0=Infrastructure, 1=Military, 2=Resources)
     * @returns {Promise<boolean>}
     */
    clickBuildTab: async function (tabIndex) {
      try {
        Logger.log('clickBuildTab: tab index', tabIndex);
        await humanDelay(200, 400);

        var tabs = qsa('.contentNavi a.tabItem');
        if (!tabs || tabs.length === 0) {
          Logger.warn('clickBuildTab: no tabs found');
          return false;
        }

        if (tabIndex >= tabs.length) {
          Logger.warn('clickBuildTab: tab index', tabIndex, 'out of range (', tabs.length, 'tabs)');
          return false;
        }

        // Skip if already active (return false so botEngine tries next tab)
        if (tabs[tabIndex].className.indexOf('active') !== -1) {
          Logger.log('clickBuildTab: tab', tabIndex, 'already active, skipping');
          return false;
        }

        await simulateHumanClick(tabs[tabIndex]);
        Logger.log('clickBuildTab: clicked tab', tabIndex, tabs[tabIndex].textContent.trim());
        return true;
      } catch (e) {
        Logger.error('clickBuildTab error:', e);
        return false;
      }
    },

    // -----------------------------------------------------------------------
    // Utility (exposed for external use)
    // -----------------------------------------------------------------------

    /**
     * Click an element by selector with human-like behaviour.
     * Exposed as a public method for flexible use.
     *
     * @param {string|string[]} selector
     * @returns {Promise<boolean>}
     */
    clickElement: async function (selector) {
      try {
        return await clickElement(selector);
      } catch (e) {
        Logger.error('clickElement error:', e);
        return false;
      }
    },

    /**
     * Fill an input with human-like typing.
     * Exposed as a public method for flexible use.
     *
     * @param {string|string[]} selector
     * @param {string|number} value
     * @returns {Promise<boolean>}
     */
    fillInput: async function (selector, value) {
      try {
        return await fillInput(selector, value);
      } catch (e) {
        Logger.error('fillInput error:', e);
        return false;
      }
    },

    /**
     * Simulate a human-like click on a given element.
     *
     * @param {HTMLElement} element
     * @returns {Promise<void>}
     */
    simulateHumanClick: async function (element) {
      try {
        await simulateHumanClick(element);
      } catch (e) {
        Logger.error('simulateHumanClick error:', e);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Message System - chrome.runtime.onMessage listener
  // ---------------------------------------------------------------------------

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      // We need to return true to indicate async response
      handleMessage(message).then(function (response) {
        sendResponse(response);
      }).catch(function (err) {
        sendResponse({
          success: false,
          data: null,
          error: err.message || String(err)
        });
      });

      // Return true to keep the message channel open for async sendResponse
      return true;
    });

    Logger.log('Message listener registered');
  } else {
    Logger.warn('chrome.runtime.onMessage not available - message system disabled');
  }

  /**
   * Handle an incoming message from the background script.
   *
   * @param {{ type: string, action?: string, params?: Object }} message
   * @returns {Promise<{ success: boolean, data: any, error: string|null }>}
   */
  // RC-5 FIX: Track page unload to ignore messages from dying content script.
  // When a page navigates, both old and new content scripts briefly coexist.
  // The old one must ignore messages to prevent duplicate action execution.
  var _pageUnloading = false;
  window.addEventListener('pagehide', function () { _pageUnloading = true; });
  window.addEventListener('beforeunload', function () { _pageUnloading = true; });

  // TQ-6 FIX: Track last processed requestId to prevent duplicate EXECUTE actions.
  // When Chrome throttles a background tab, the bot's timeout can fire before the
  // content script responds. The bot retries with a NEW requestId, but the original
  // message may still arrive as a ghost. We discard messages with stale IDs.
  var _lastProcessedRequestId = 0;

  async function handleMessage(message) {
    // RC-5 FIX: Bail immediately if page is unloading — we're the dying instance
    if (_pageUnloading) {
      return { success: false, data: null, error: 'Content script unloading (page navigation)' };
    }

    if (!message || !message.type) {
      return { success: false, data: null, error: 'Invalid message: missing type' };
    }

    // TQ-6 FIX: Dedup EXECUTE messages by requestId
    if (message.type === 'EXECUTE' && message._requestId) {
      if (message._requestId <= _lastProcessedRequestId) {
        Logger.warn('Duplicate EXECUTE ignored (requestId=' + message._requestId + ', last=' + _lastProcessedRequestId + ')');
        return { success: false, data: null, error: 'Duplicate request ignored', reason: 'duplicate_request' };
      }
      _lastProcessedRequestId = message._requestId;
    }

    Logger.log('Received message:', message.type, message.action || '');

    try {
      switch (message.type) {

        // ------------------------------------------------------------------
        // SCAN - Run the full DOM scanner and return game state
        // ------------------------------------------------------------------
        case 'SCAN': {
          if (!window.TravianScanner) {
            return { success: false, data: null, error: 'TravianScanner not available' };
          }
          // DOM-4 FIX: Wait for key DOM elements before scanning.
          // Without this, partial page loads produce empty/incomplete scan data
          // that causes bad decisions (missing buildings, zero resources, etc.)
          if (typeof window.TravianScanner.waitForReady === 'function') {
            var ready = await window.TravianScanner.waitForReady(3000);
            if (!ready) {
              Logger.warn('DOM not ready after 3s — scanning anyway (may be partial)');
            }
          }
          var state = window.TravianScanner.getFullState();
          return { success: true, data: state, error: null };
        }

        // ------------------------------------------------------------------
        // GET_STATE - Return current state (lighter than full scan)
        // ------------------------------------------------------------------
        case 'GET_STATE': {
          if (!window.TravianScanner) {
            return { success: false, data: null, error: 'TravianScanner not available' };
          }

          // If a specific state property is requested, return just that
          if (message.params && message.params.property) {
            var prop = message.params.property;
            var scanner = window.TravianScanner;

            var methodMap = {
              page:             'detectPage',
              resources:        'getResources',
              capacity:         'getResourceCapacity',
              production:       'getResourceProduction',
              resourceFields:   'getResourceFields',
              buildings:        'getBuildings',
              queue:            'getConstructionQueue',
              troops:           'getTroopCounts',
              villages:         'getVillageList',
              serverTime:       'getServerTime',
              loggedIn:         'isLoggedIn',
              captcha:          'isCaptchaPresent',
              error:            'isErrorPage',
              hasBuildOrder:    'hasActiveBuildOrder',
              hero:             'getHeroStatus',
              adventures:       'getAdventureList',
              farmLists:        'getFarmLists'
            };

            var methodName = methodMap[prop];
            if (methodName && typeof scanner[methodName] === 'function') {
              var result = scanner[methodName]();
              return { success: true, data: result, error: null };
            }

            return { success: false, data: null, error: 'Unknown state property: ' + prop };
          }

          // Default: return full state
          var fullState = window.TravianScanner.getFullState();
          return { success: true, data: fullState, error: null };
        }

        // ------------------------------------------------------------------
        // EXECUTE - Run an action on the executor
        // ------------------------------------------------------------------
        case 'EXECUTE': {
          var action = message.action;
          var params = message.params || {};

          if (!action) {
            return { success: false, data: null, error: 'EXECUTE: missing action name' };
          }

          // Map action names to executor methods
          var actionResult;

          switch (action) {
            case 'navigateTo':
              actionResult = await TravianExecutor.navigateTo(params.page);
              break;

            case 'switchVillage':
              actionResult = await TravianExecutor.switchVillage(params.villageId);
              break;

            case 'clickResourceField':
              actionResult = await TravianExecutor.clickResourceField(params.fieldId);
              break;

            case 'clickBuildingSlot':
              actionResult = await TravianExecutor.clickBuildingSlot(params.slotId);
              break;

            case 'clickUpgradeButton':
              actionResult = await TravianExecutor.clickUpgradeButton();
              break;

            case 'clickNewBuildingTab':
              actionResult = await TravianExecutor.clickNewBuildingTab(params.buildingName);
              break;

            case 'trainTroops':
              actionResult = await TravianExecutor.trainTroops(params.troopType, params.count);
              break;

            case 'trainTraps':
              actionResult = await TravianExecutor.trainTraps(params.count);
              break;

            case 'clickFarmListTab':
              actionResult = await TravianExecutor.clickFarmListTab();
              break;

            case 'sendFarmList':
              actionResult = await TravianExecutor.sendFarmList(params.farmListId);
              break;

            case 'sendAllFarmLists':
              actionResult = await TravianExecutor.sendAllFarmLists();
              break;

            case 'selectiveFarmSend':
              actionResult = await TravianExecutor.selectiveFarmSend(params);
              break;

            case 'scanFarmListSlots':
              actionResult = { success: true, slots: window.TravianScanner ? window.TravianScanner.scanFarmListSlots() : [] };
              break;

            case 'addToFarmList':
              actionResult = await TravianExecutor.addToFarmList(params);
              break;

            case 'sendAttack':
              actionResult = await TravianExecutor.sendAttack(params.target, params.troops);
              break;

            case 'sendHeroAdventure':
              actionResult = await TravianExecutor.sendHeroAdventure();
              break;

            case 'useHeroItem':
              actionResult = await TravianExecutor.useHeroItem(params.itemIndex, params.amount);
              break;

            case 'useHeroItemBulk':
              actionResult = await TravianExecutor.useHeroItemBulk(params.amounts || {});
              break;

            case 'detectHeroUIVersion':
              actionResult = { success: true, uiVersion: TravianExecutor.detectHeroUIVersion() };
              break;

            case 'scanHeroInventory':
              actionResult = await TravianExecutor.scanHeroInventory();
              break;

            case 'buildNewByGid':
              actionResult = await TravianExecutor.buildNewByGid(params.gid);
              break;

            case 'clickBuildTab':
              actionResult = await TravianExecutor.clickBuildTab(params.tabIndex);
              break;

            case 'clickElement':
              actionResult = await TravianExecutor.clickElement(params.selector);
              break;

            case 'fillInput':
              actionResult = await TravianExecutor.fillInput(params.selector, params.value);
              break;

            default:
              return { success: false, data: null, error: 'EXECUTE: unknown action: ' + action };
          }

          // Actions can return true/false OR structured { success, reason, message }
          if (actionResult && typeof actionResult === 'object' && actionResult.reason) {
            return {
              success: actionResult.success !== undefined ? actionResult.success : false,
              data: actionResult,
              error: actionResult.message || null,
              reason: actionResult.reason
            };
          }
          return {
            success: !!actionResult,
            data: actionResult,
            error: actionResult ? null : 'Action ' + action + ' returned false (element not found or action failed)'
          };
        }

        // ------------------------------------------------------------------
        // Unknown message type
        // ------------------------------------------------------------------
        default:
          return { success: false, data: null, error: 'Unknown message type: ' + message.type };
      }
    } catch (e) {
      Logger.error('handleMessage error for', message.type, ':', e);
      // FIX 13: Capture DOM snapshot on unhandled execution errors
      if (window.DomHelpers && message.type === 'EXECUTE') {
        window.DomHelpers.captureAndLog({
          action: message.action || 'unknown',
          reason: 'unhandled_error: ' + (e.message || String(e))
        });
      }
      return { success: false, data: null, error: e.message || String(e) };
    }
  }

  // ---------------------------------------------------------------------------
  // Expose on the window object
  // ---------------------------------------------------------------------------

  window.TravianExecutor = TravianExecutor;

  // ---------------------------------------------------------------------------
  // Service Worker Bridge: forwards messages from page context to background SW
  // Page sends: window.postMessage({ source: 'travian-bot-sw', swType: 'GET_STATUS', ... }, '*')
  // Content script forwards to chrome.runtime.sendMessage, then replies back
  // ---------------------------------------------------------------------------
  try {
    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== 'travian-bot-sw') return;

      var requestId = event.data.requestId || '';
      var msg = { type: event.data.swType };
      if (event.data.swData) msg.data = event.data.swData;
      if (event.data.swConfig) msg.config = event.data.swConfig;

      chrome.runtime.sendMessage(msg, function (response) {
        window.postMessage({
          source: 'travian-bot-sw-response',
          requestId: requestId,
          data: response
        }, '*');
      });
    });
  } catch (_) {}

  Logger.log('Action Executor initialized. Scanner:', !!window.TravianScanner,
    'DomHelpers:', !!window.DomHelpers);

})();
