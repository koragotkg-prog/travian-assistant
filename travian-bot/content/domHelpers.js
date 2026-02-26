/**
 * domHelpers.js - DOM Resilience & Self-Healing Layer (Phase 4)
 *
 * FIX 10: Robust DOM Interaction (waitForElement, safeClick, safeQuery, withTimeout)
 * FIX 11: Self-Healing Selector Strategy (registry, text fallback, attribute fallback)
 * FIX 12: Action Retry & Recovery (retryAction with exponential backoff)
 * FIX 13: DOM Snapshot Debugging (captureSnapshot on failure)
 *
 * Loaded BEFORE actionExecutor.js. Exposes window.DomHelpers.
 *
 * Dependencies (optional):
 *   - window.TravianLogger (falls back to console)
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Internal logger (mirrors actionExecutor pattern)
  // ---------------------------------------------------------------------------

  var Logger = {
    _fmt: function (args) {
      return Array.from(args).map(function (a) {
        return typeof a === 'string' ? a : JSON.stringify(a);
      }).join(' ');
    },
    log: function () {
      if (window.TravianLogger && typeof window.TravianLogger.info === 'function') {
        window.TravianLogger.info('[DomHelpers] ' + Logger._fmt(arguments));
      } else {
        console.log.apply(console, ['[DomHelpers]'].concat(Array.from(arguments)));
      }
    },
    warn: function () {
      if (window.TravianLogger && typeof window.TravianLogger.warn === 'function') {
        window.TravianLogger.warn('[DomHelpers] ' + Logger._fmt(arguments));
      } else {
        console.warn.apply(console, ['[DomHelpers]'].concat(Array.from(arguments)));
      }
    },
    error: function () {
      if (window.TravianLogger && typeof window.TravianLogger.error === 'function') {
        window.TravianLogger.error('[DomHelpers] ' + Logger._fmt(arguments));
      } else {
        console.error.apply(console, ['[DomHelpers]'].concat(Array.from(arguments)));
      }
    }
  };

  // ---------------------------------------------------------------------------
  // FIX 10: Robust DOM Interaction Layer
  // ---------------------------------------------------------------------------

  /**
   * Wait for an element matching a CSS selector using MutationObserver.
   * Falls back to polling if MutationObserver is unavailable.
   *
   * @param {string|string[]} selector - CSS selector(s) to wait for
   * @param {Object} [opts] - Options
   * @param {number}  [opts.timeout=5000]  - Max ms to wait
   * @param {boolean} [opts.visible=false] - Require element to be visible (offsetParent !== null)
   * @param {Element} [opts.root=document] - Root element to observe
   * @returns {Promise<Element|null>}
   */
  function waitForElement(selector, opts) {
    opts = opts || {};
    var timeout = opts.timeout || 5000;
    var requireVisible = opts.visible || false;
    var root = opts.root || document;

    var selectors = Array.isArray(selector) ? selector : [selector];

    // Try immediate match first
    var found = _queryFirst(selectors, root);
    if (found && (!requireVisible || _isVisible(found))) {
      return Promise.resolve(found);
    }

    return new Promise(function (resolve) {
      var settled = false;
      var observer = null;
      var timer = null;
      var pollTimer = null;

      function cleanup() {
        if (settled) return;
        settled = true;
        if (observer) { try { observer.disconnect(); } catch (_) {} }
        if (timer) clearTimeout(timer);
        if (pollTimer) clearInterval(pollTimer);
      }

      function check() {
        if (settled) return null;
        var el = _queryFirst(selectors, root);
        if (el && (!requireVisible || _isVisible(el))) {
          cleanup();
          resolve(el);
          return el;
        }
        return null;
      }

      // Timeout handler
      timer = setTimeout(function () {
        cleanup();
        Logger.warn('waitForElement timeout (' + timeout + 'ms):', selectors[0]);
        resolve(null);
      }, timeout);

      // MutationObserver approach
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(function () {
          check();
        });
        observer.observe(root === document ? document.documentElement : root, {
          childList: true,
          subtree: true,
          attributes: requireVisible,
          attributeFilter: requireVisible ? ['style', 'class', 'hidden'] : undefined
        });
      }

      // Safety polling fallback (every 300ms) — MutationObserver can miss
      // some insertions (e.g., innerHTML replacements, framework renders)
      pollTimer = setInterval(function () {
        check();
      }, 300);

      // One more immediate check after observer is set up
      check();
    });
  }

  /**
   * Check if an element is visible (has layout).
   * @param {Element} el
   * @returns {boolean}
   */
  function _isVisible(el) {
    if (!el) return false;
    // offsetParent is null for hidden elements (display:none, or detached)
    // Exception: <body> and position:fixed elements have null offsetParent but are visible
    if (el.offsetParent === null && el !== document.body &&
        getComputedStyle(el).position !== 'fixed') {
      return false;
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /**
   * Check if element is still attached to the DOM.
   * @param {Element} el
   * @returns {boolean}
   */
  function _isAttached(el) {
    return el && document.contains(el);
  }

  /**
   * Check if an element is interactable (visible, attached, not disabled).
   * @param {Element} el
   * @returns {{ok: boolean, reason: string}}
   */
  function checkInteractable(el) {
    if (!el) return { ok: false, reason: 'null_element' };
    if (!_isAttached(el)) return { ok: false, reason: 'detached' };
    if (!_isVisible(el)) return { ok: false, reason: 'not_visible' };
    if (el.disabled) return { ok: false, reason: 'disabled' };
    if (el.getAttribute('aria-disabled') === 'true') return { ok: false, reason: 'aria_disabled' };
    return { ok: true, reason: '' };
  }

  /**
   * Safe click: wait for element, verify interactable, scroll into view, simulate click.
   * Returns the element that was clicked or null on failure.
   *
   * @param {string|string[]} selector - CSS selector(s)
   * @param {Object} [opts] - Options
   * @param {number}  [opts.timeout=5000]  - Max ms to wait for element
   * @param {boolean} [opts.visible=true]  - Require visibility before clicking
   * @param {boolean} [opts.scroll=true]   - Scroll element into view
   * @param {string}  [opts.label='']      - Human-readable label for logging
   * @returns {Promise<{clicked: boolean, element: Element|null, failReason: string}>}
   */
  async function safeClick(selector, opts) {
    opts = opts || {};
    var label = opts.label || (Array.isArray(selector) ? selector[0] : selector);
    var scrollIntoView = opts.scroll !== false;

    // Wait for element
    var el = await waitForElement(selector, {
      timeout: opts.timeout || 5000,
      visible: opts.visible !== false
    });

    if (!el) {
      return { clicked: false, element: null, failReason: 'not_found' };
    }

    // Verify interactable
    var check = checkInteractable(el);
    if (!check.ok) {
      Logger.warn('safeClick: element not interactable:', label, check.reason);
      return { clicked: false, element: el, failReason: check.reason };
    }

    // Scroll into view
    if (scrollIntoView && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await _delay(randomInt(80, 200));
    }

    // Re-check after scroll (element might have been removed during scroll animation)
    if (!_isAttached(el)) {
      Logger.warn('safeClick: element detached after scroll:', label);
      return { clicked: false, element: null, failReason: 'detached_after_scroll' };
    }

    // Simulate human click (inline version — actionExecutor will override with its own)
    await _simulateClick(el);

    return { clicked: true, element: el, failReason: '' };
  }

  /**
   * Safe query: querySelector with error swallowing and logging.
   * @param {string} selector
   * @param {Element} [context=document]
   * @returns {Element|null}
   */
  function safeQuery(selector, context) {
    try {
      return (context || document).querySelector(selector);
    } catch (e) {
      Logger.warn('safeQuery: invalid selector:', selector, e.message);
      return null;
    }
  }

  /**
   * Safe queryAll: querySelectorAll with error swallowing.
   * @param {string} selector
   * @param {Element} [context=document]
   * @returns {Element[]}
   */
  function safeQueryAll(selector, context) {
    try {
      return Array.from((context || document).querySelectorAll(selector));
    } catch (e) {
      Logger.warn('safeQueryAll: invalid selector:', selector, e.message);
      return [];
    }
  }

  /**
   * Wrap an async action with a timeout. Rejects with 'ACTION_TIMEOUT' if exceeded.
   *
   * @param {Function} asyncFn - Async function to execute
   * @param {number} timeoutMs - Max execution time
   * @param {string} [label='action'] - Label for error messages
   * @returns {Promise<*>}
   */
  function withTimeout(asyncFn, timeoutMs, label) {
    label = label || 'action';
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          Logger.error('withTimeout: ' + label + ' exceeded ' + timeoutMs + 'ms');
          reject(new Error('ACTION_TIMEOUT: ' + label + ' exceeded ' + timeoutMs + 'ms'));
        }
      }, timeoutMs);

      asyncFn().then(function (result) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(result);
        }
      }).catch(function (err) {
        if (!done) {
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // FIX 11: Self-Healing Selector Strategy
  // ---------------------------------------------------------------------------

  /**
   * Selector Registry: maps logical element names to ordered arrays of CSS selectors.
   * First selector is the "primary" (fastest/most specific).
   * Subsequent selectors are fallbacks tried in order.
   *
   * The registry can be extended at runtime via registerSelector().
   */
  var SelectorRegistry = {
    // Navigation
    'nav.resources':      ['a[href="/dorf1.php"]', 'a[href*="dorf1"]', '.navigation a:first-child'],
    'nav.village':        ['a[href="/dorf2.php"]', 'a[href*="dorf2"]', '.navigation a:nth-child(2)'],
    'nav.map':            ['a[href="/karte.php"]', 'a[href*="karte"]'],
    'nav.stats':          ['a[href="/statistics"]', 'a[href*="statistic"]'],
    'nav.reports':        ['a[href="/report"]', 'a[href*="report"]'],
    'nav.messages':       ['a[href="/messages"]', 'a[href*="message"]'],
    'nav.hero':           ['#heroImageButton', 'a[href="/hero"]'],

    // Upgrade / Build
    'btn.upgrade':        ['.upgradeButtonsContainer .section1 .textButtonV1.green', '.section1 button.green', '.section1 .green'],
    'btn.upgrade.gold':   ['.upgradeButtonsContainer .section1 .textButtonV1.gold', '.section1 button.gold'],
    'indicator.blocked':  ['.upgradeBlocked', '.upgradeButtonsContainer .upgradeBlocked'],

    // Build new
    'build.tabs':         ['.contentNavi a.tabItem', '.contentNavi .tabItem'],

    // Hero
    'hero.inventory.tab': ['a[href="/hero/inventory"]', '.heroTab a[href*="inventory"]'],
    'hero.items':         ['.heroItems .heroItem[data-tier="consumable"]', '.heroItems .heroItem'],
    'hero.dialog.confirm': ['button.textButtonV2.green', '.heroConsumablesPopup button.green', '.heroConsumablesPopup .green'],
    'hero.dialog.cancel':  ['button.textButtonV2.grey', '.heroConsumablesPopup button.grey'],

    // Farm lists
    'farm.tab':           ['a[href*="tt=99"]', '.tabItem[href*="tt=99"]'],
    'farm.startAll':      ['button.startButton', 'button.green.startRaid', '.buttonsWrapper button.green'],

    // Village sidebar
    'sidebar.villages':   ['#sidebarBoxVillageList', '.sidebarBoxVillageList'],

    // Build queue
    'queue.timer':        ['.buildDuration .timer', '.buildDuration > .timer']
  };

  /**
   * Register or update selector chain for a logical name.
   * @param {string} name - Logical element name (e.g., 'btn.upgrade')
   * @param {string[]} selectors - Ordered array of CSS selectors
   */
  function registerSelector(name, selectors) {
    SelectorRegistry[name] = selectors;
  }

  /**
   * Resolve a logical name or raw selector to a DOM element using the registry.
   * If `nameOrSelector` is in the registry, tries all registered selectors.
   * Otherwise treats it as a raw CSS selector.
   *
   * @param {string} nameOrSelector - Registry name or CSS selector
   * @param {Object} [opts] - Options
   * @param {Element} [opts.context=document] - Root element
   * @param {string}  [opts.text]    - Text content filter (substring match)
   * @param {string}  [opts.attr]    - Attribute name to check exists
   * @param {string}  [opts.attrVal] - Attribute value to match (requires opts.attr)
   * @returns {Element|null}
   */
  function resolveSelector(nameOrSelector, opts) {
    opts = opts || {};
    var context = opts.context || document;
    var selectors;

    // Check registry first
    if (SelectorRegistry[nameOrSelector]) {
      selectors = SelectorRegistry[nameOrSelector];
    } else if (Array.isArray(nameOrSelector)) {
      selectors = nameOrSelector;
    } else {
      selectors = [nameOrSelector];
    }

    // Try each selector
    for (var i = 0; i < selectors.length; i++) {
      var el = safeQuery(selectors[i], context);
      if (el) {
        // Apply text filter if specified
        if (opts.text && (el.textContent || '').indexOf(opts.text) === -1) {
          continue;
        }
        // Apply attribute filter if specified
        if (opts.attr) {
          if (!el.hasAttribute(opts.attr)) continue;
          if (opts.attrVal !== undefined && el.getAttribute(opts.attr) !== opts.attrVal) continue;
        }
        // Log if fallback selector was used
        if (i > 0) {
          Logger.warn('resolveSelector: primary failed, used fallback[' + i + '] for "' +
            nameOrSelector + '": ' + selectors[i]);
        }
        return el;
      }
    }

    // Text-based fallback: if we have a text filter, try broad querySelectorAll
    if (opts.text) {
      var candidates = safeQueryAll('*', context);
      for (var j = 0; j < candidates.length && j < 2000; j++) {
        var c = candidates[j];
        if (c.children.length === 0 && (c.textContent || '').indexOf(opts.text) !== -1) {
          Logger.warn('resolveSelector: used text fallback for "' + nameOrSelector + '", text="' + opts.text + '"');
          return c;
        }
      }
    }

    return null;
  }

  /**
   * Resolve ALL elements matching a logical name or raw selector.
   * @param {string} nameOrSelector
   * @param {Object} [opts]
   * @returns {Element[]}
   */
  function resolveSelectorAll(nameOrSelector, opts) {
    opts = opts || {};
    var context = opts.context || document;
    var selectors;

    if (SelectorRegistry[nameOrSelector]) {
      selectors = SelectorRegistry[nameOrSelector];
    } else if (Array.isArray(nameOrSelector)) {
      selectors = nameOrSelector;
    } else {
      selectors = [nameOrSelector];
    }

    // Return results from first selector that yields any matches
    for (var i = 0; i < selectors.length; i++) {
      var els = safeQueryAll(selectors[i], context);
      if (els.length > 0) {
        if (i > 0) {
          Logger.warn('resolveSelectorAll: primary failed, used fallback[' + i + '] for "' +
            nameOrSelector + '": ' + selectors[i]);
        }
        return els;
      }
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // FIX 12: Action Retry & Recovery
  // ---------------------------------------------------------------------------

  /**
   * Retry an async action with exponential backoff.
   *
   * @param {Function} actionFn - Async function to retry. Should return a result
   *                              or throw on failure. Can also return {success: false, ...}.
   * @param {Object} [opts] - Options
   * @param {number}  [opts.maxRetries=3]      - Max retry attempts (0 = no retry)
   * @param {number}  [opts.baseDelay=500]     - Initial delay ms
   * @param {number}  [opts.maxDelay=5000]     - Max delay ms cap
   * @param {number}  [opts.backoffFactor=2]   - Multiplier per retry
   * @param {number}  [opts.jitter=0.3]        - Random jitter factor (0-1)
   * @param {string}  [opts.label='action']    - Label for logging
   * @param {Function} [opts.shouldRetry]      - Predicate: (error, attempt) => boolean
   * @param {Function} [opts.onRetry]          - Callback before each retry: (attempt, delay, error) => void
   * @param {Function} [opts.beforeRetry]      - Async function to run before retrying (e.g., re-navigate)
   * @returns {Promise<*>}
   */
  async function retryAction(actionFn, opts) {
    opts = opts || {};
    var maxRetries = opts.maxRetries !== undefined ? opts.maxRetries : 3;
    var baseDelay = opts.baseDelay || 500;
    var maxDelay = opts.maxDelay || 5000;
    var factor = opts.backoffFactor || 2;
    var jitterFactor = opts.jitter !== undefined ? opts.jitter : 0.3;
    var label = opts.label || 'action';

    var lastError = null;

    for (var attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        var result = await actionFn(attempt);

        // Handle structured failure responses
        if (result && typeof result === 'object' && result.success === false) {
          // Treat as retryable failure
          var pseudoError = new Error(result.message || result.reason || 'action returned success:false');
          pseudoError.result = result;
          pseudoError.reason = result.reason;
          throw pseudoError;
        }

        return result;
      } catch (err) {
        lastError = err;

        // Check if we should retry
        if (attempt >= maxRetries) break;
        if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) break;

        // Calculate delay with exponential backoff + jitter
        var delayMs = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
        var jitterMs = delayMs * jitterFactor * (Math.random() * 2 - 1); // ±jitter
        delayMs = Math.max(100, Math.round(delayMs + jitterMs));

        Logger.warn('retryAction [' + label + '] attempt ' + (attempt + 1) + '/' + maxRetries +
          ' failed: ' + (err.message || err) + '. Retrying in ' + delayMs + 'ms');

        if (opts.onRetry) opts.onRetry(attempt + 1, delayMs, err);

        await _delay(delayMs);

        // Run pre-retry hook (e.g., re-check page, re-navigate)
        if (opts.beforeRetry) {
          try {
            await opts.beforeRetry(attempt + 1);
          } catch (hookErr) {
            Logger.warn('retryAction [' + label + '] beforeRetry hook failed:', hookErr.message);
          }
        }
      }
    }

    // All retries exhausted
    Logger.error('retryAction [' + label + '] all ' + (maxRetries + 1) + ' attempts failed');
    throw lastError;
  }

  // ---------------------------------------------------------------------------
  // FIX 13: DOM Snapshot Debugging
  // ---------------------------------------------------------------------------

  /**
   * Capture a DOM snapshot for debugging a failed action.
   * Returns a compact object with page context and element state.
   *
   * @param {Object} [opts] - Options
   * @param {string}  [opts.selector]  - Selector that was being targeted
   * @param {string}  [opts.action]    - Action name that failed
   * @param {string}  [opts.reason]    - Failure reason
   * @param {Element} [opts.element]   - Element reference (if found but not interactable)
   * @param {number}  [opts.maxHtml=500] - Max characters of outerHTML to capture
   * @returns {Object} snapshot
   */
  function captureSnapshot(opts) {
    opts = opts || {};
    var maxHtml = opts.maxHtml || 500;

    var snapshot = {
      timestamp: Date.now(),
      url: window.location.href,
      pageType: _detectPageType(),
      action: opts.action || '',
      selector: opts.selector || '',
      reason: opts.reason || '',
      title: document.title || '',
      readyState: document.readyState
    };

    // Capture target element state
    if (opts.element) {
      snapshot.element = {
        tag: opts.element.tagName,
        id: opts.element.id || '',
        classes: opts.element.className || '',
        visible: _isVisible(opts.element),
        attached: _isAttached(opts.element),
        disabled: !!opts.element.disabled,
        rect: _safeRect(opts.element),
        html: (opts.element.outerHTML || '').substring(0, maxHtml)
      };
    }

    // Capture surrounding context: what IS on the page
    snapshot.context = {
      bodyChildCount: document.body ? document.body.children.length : 0,
      hasContent: !!safeQuery('#content, .content, #contentContainer, main'),
      hasNavigation: !!safeQuery('.navigation, #navigation, nav'),
      hasBuildView: !!safeQuery('.upgradeButtonsContainer, .buildingWrapper'),
      hasDialog: !!safeQuery('.dialogWrapper, .modalContent, .heroConsumablesPopup, .popup'),
      hasError: !!safeQuery('.error, .errorMessage, #errorPage'),
      loadingVisible: !!safeQuery('.loading:not([style*="display: none"]), .ajaxLoader:not([style*="none"])')
    };

    return snapshot;
  }

  /**
   * Log a snapshot (calls Logger.error with structured data).
   * @param {Object} snapshot - From captureSnapshot()
   */
  function logSnapshot(snapshot) {
    Logger.error('DOM Snapshot [' + snapshot.action + '] ' + snapshot.reason, snapshot);
  }

  /**
   * Capture and log a snapshot in one call (convenience wrapper).
   * @param {Object} opts - Same as captureSnapshot options
   * @returns {Object} The snapshot
   */
  function captureAndLog(opts) {
    var snap = captureSnapshot(opts);
    logSnapshot(snap);
    return snap;
  }

  /**
   * Detect current page type from URL patterns.
   * @returns {string}
   */
  function _detectPageType() {
    var path = window.location.pathname;
    var search = window.location.search || '';
    if (path.indexOf('dorf1') !== -1) return 'resources';
    if (path.indexOf('dorf2') !== -1) return 'village';
    if (path.indexOf('build') !== -1) return 'building';
    if (path.indexOf('karte') !== -1) return 'map';
    if (path.indexOf('hero') !== -1) return 'hero';
    if (path.indexOf('report') !== -1) return 'reports';
    if (path.indexOf('message') !== -1) return 'messages';
    if (path.indexOf('statistic') !== -1) return 'stats';
    if (search.indexOf('tt=99') !== -1) return 'farmlist';
    return 'unknown';
  }

  /**
   * Safely get bounding rect.
   * @param {Element} el
   * @returns {Object|null}
   */
  function _safeRect(el) {
    try {
      var r = el.getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left),
               width: Math.round(r.width), height: Math.round(r.height) };
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function _delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Try multiple selectors, return first match.
   */
  function _queryFirst(selectors, context) {
    for (var i = 0; i < selectors.length; i++) {
      try {
        var el = (context || document).querySelector(selectors[i]);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Minimal click simulation (used by safeClick when actionExecutor's
   * simulateHumanClick is not yet available).
   */
  async function _simulateClick(element) {
    if (!element) return;
    var rect = element.getBoundingClientRect();
    var cx = rect.left + randomInt(2, Math.max(3, Math.floor(rect.width * 0.8)));
    var cy = rect.top + randomInt(2, Math.max(3, Math.floor(rect.height * 0.8)));
    var props = { bubbles: true, cancelable: true, view: window,
                  clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
    element.dispatchEvent(new MouseEvent('mousedown', props));
    await _delay(randomInt(30, 90));
    element.dispatchEvent(new MouseEvent('mouseup', props));
    await _delay(randomInt(10, 40));
    element.dispatchEvent(new MouseEvent('click', props));
  }

  // ---------------------------------------------------------------------------
  // Expose on window
  // ---------------------------------------------------------------------------

  window.DomHelpers = {
    // FIX 10: DOM interaction
    waitForElement: waitForElement,
    safeClick: safeClick,
    safeQuery: safeQuery,
    safeQueryAll: safeQueryAll,
    checkInteractable: checkInteractable,
    withTimeout: withTimeout,
    isVisible: _isVisible,
    isAttached: _isAttached,

    // FIX 11: Selector strategy
    SelectorRegistry: SelectorRegistry,
    registerSelector: registerSelector,
    resolveSelector: resolveSelector,
    resolveSelectorAll: resolveSelectorAll,

    // FIX 12: Retry & recovery
    retryAction: retryAction,

    // FIX 13: Snapshot debugging
    captureSnapshot: captureSnapshot,
    logSnapshot: logSnapshot,
    captureAndLog: captureAndLog
  };

  Logger.log('DomHelpers initialized (Phase 4: FIX 10-13)');

})();
