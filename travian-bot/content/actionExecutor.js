/**
 * actionExecutor.js - Travian Action Executor
 *
 * Performs game actions (navigation, building, training, farming) with
 * human-like timing and behaviour. Communicates with the background script
 * via chrome.runtime.onMessage.
 *
 * Dependencies (expected on window):
 *   - window.TravianScanner  (domScanner.js)
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
   * Human-like delay: random duration between min and max ms.
   */
  function humanDelay(minMs, maxMs) {
    var ms = randomInt(minMs || 80, maxMs || 300);
    return delay(ms);
  }

  /**
   * Wait for a selector to appear in the DOM (polls every 200ms).
   * @param {string} selector - CSS selector
   * @param {number} timeout - max ms to wait (default 5000)
   * @returns {Promise<Element|null>}
   */
  function awaitSelector(selector, timeout) {
    timeout = timeout || 5000;
    return new Promise(function (resolve) {
      var el = document.querySelector(selector);
      if (el) return resolve(el);
      var elapsed = 0;
      var interval = setInterval(function () {
        el = document.querySelector(selector);
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

    // Get bounding rect and compute click position with small random offset
    var rect = element.getBoundingClientRect();
    var offsetX = randomInt(2, Math.max(3, Math.floor(rect.width * 0.8)));
    var offsetY = randomInt(2, Math.max(3, Math.floor(rect.height * 0.8)));
    var clientX = rect.left + offsetX;
    var clientY = rect.top + offsetY;

    var commonProps = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: clientX,
      clientY: clientY,
      screenX: clientX,
      screenY: clientY,
      button: 0
    };

    // mousedown
    element.dispatchEvent(new MouseEvent('mousedown', commonProps));
    await delay(randomInt(30, 90));

    // mouseup
    element.dispatchEvent(new MouseEvent('mouseup', commonProps));
    await delay(randomInt(10, 40));

    // click
    element.dispatchEvent(new MouseEvent('click', commonProps));

    Logger.log('Clicked element:', element.tagName, element.className || element.id || '');
  }

  /**
   * Find an element by selector (or array of selectors) and click it.
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
      return false;
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
          Logger.warn('navigateTo: could not find nav link for', page);
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
          Logger.warn('clickUpgradeButton: insufficient resources (upgradeBlocked found)');
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

    /**
     * Use a hero inventory item (resource bucket, etc.) by index.
     * Must already be on /hero/inventory page.
     *
     * @param {number} itemIndex - Index of the item to use (0-based among all .heroItem elements)
     * @param {number} [amount] - Optional specific amount to transfer. If omitted, uses Travian default (fill warehouse).
     * @returns {Promise<object>}
     */
    useHeroItem: async function (itemIndex, amount) {
      try {
        Logger.log('useHeroItem: claiming item at index', itemIndex, 'amount:', amount || 'default');
        await humanDelay(300, 600);

        // In Travian Legends, hero items don't have "use" buttons.
        // You click the .heroItem element directly → a dialog opens → click green confirm button.
        // IMPORTANT: Must use same selectors as scanHeroInventory so indices match!
        var heroItems = qsa('.heroItems .heroItem, .heroInventory .heroItem, #itemsToSale .heroItem, .inventoryContent .item');

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
        var dialogPopup = await awaitSelector('.heroConsumablesPopup, .dialogContent, .dialog.plain', 3000);
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
          var cancelBtn2 = qs('.heroConsumablesPopup button.grey, .dialog button.grey, button.textButtonV2.grey');
          if (cancelBtn2) cancelBtn2.click();
          return { success: false, reason: 'no_amount', message: 'No transfer amount specified, cancelled to avoid waste' };
        }
        var useAmount = Math.ceil(amount);
        var inputSelectors = [
          '.heroConsumablesPopup input[type="text"]',
          '.dialog input[type="text"]',
          '.dialogContainer input[type="number"]',
          '.dialogContainer input',
          '.heroConsumablesPopup input'
        ];
        var filled = await fillInput(inputSelectors, useAmount);
        if (filled) {
          Logger.log('useHeroItem: set transfer amount to', useAmount);
        } else {
          // CRITICAL: If we can't set the amount, the dialog default may transfer everything!
          // Cancel instead of proceeding with unknown amount.
          Logger.warn('useHeroItem: could not set amount in input — cancelling to avoid waste');
          var cancelBtn3 = qs('.heroConsumablesPopup button.grey, .dialog button.grey, button.textButtonV2.grey');
          if (cancelBtn3) cancelBtn3.click();
          return { success: false, reason: 'button_not_found', message: 'Could not set transfer amount' };
        }
        await humanDelay(200, 400);

        // Click the green confirm/transfer button in the dialog
        var confirmBtn = trySelectors([
          '.heroConsumablesPopup button.green',
          '.dialog button.green',
          '.dialogContainer button.green',
          '.dialogButtonOk',
          '#ok',
          'button.green[type="submit"]',
          'button.green[type="button"]'
        ]);
        if (confirmBtn) {
          await simulateHumanClick(confirmBtn);
          Logger.log('useHeroItem: confirmed transfer');
          await humanDelay(500, 1000);
          return { success: true };
        } else {
          // Dialog opened but no green button — close it
          var cancelBtn = qs('.heroConsumablesPopup button.grey, .dialog button.grey');
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
     * Scan hero inventory and return items info.
     * Must be on hero page (/hero).
     *
     * @returns {Promise<object>}
     */
    scanHeroInventory: async function () {
      try {
        Logger.log('scanHeroInventory');
        await humanDelay(200, 400);

        var items = [];
        // Hero inventory items - look for item containers
        var itemEls = qsa('.heroItems .heroItem, .heroInventory .heroItem, #itemsToSale .heroItem, .inventoryContent .item');

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
            var itemChild = qs('[class*="item item"]', el);
            var itemChildCls = itemChild ? (itemChild.className || '') : '';
            var isResourceByItemId = /item14[5678]|item17[6789]/.test(itemChildCls);

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
            var countEl = qs('.count', el);
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

        Logger.log('scanHeroInventory: found', items.length, 'items, resources:', items.filter(function(x){return x.isResource;}).length);
        return { success: true, items: items };
      } catch (e) {
        Logger.error('scanHeroInventory error:', e);
        return { success: false, items: [] };
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

        // Check current tab only — do NOT switch tabs here!
        // Tab clicks cause page reload which destroys content script mid-function.
        // Tab switching is handled by botEngine as separate steps.
        var result = tryBuildInCurrentTab(gid);

        if (!result) {
          Logger.warn('buildNewByGid: building GID', gid, 'not found in current tab');
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
            Logger.warn('buildNewByGid: insufficient resources for GID', gid);
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
  async function handleMessage(message) {
    if (!message || !message.type) {
      return { success: false, data: null, error: 'Invalid message: missing type' };
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

            case 'sendAttack':
              actionResult = await TravianExecutor.sendAttack(params.target, params.troops);
              break;

            case 'sendHeroAdventure':
              actionResult = await TravianExecutor.sendHeroAdventure();
              break;

            case 'useHeroItem':
              actionResult = await TravianExecutor.useHeroItem(params.itemIndex, params.amount);
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

  Logger.log('Action Executor initialized. Scanner available:', !!window.TravianScanner);

})();
