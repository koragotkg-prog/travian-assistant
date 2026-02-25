/**
 * Travian Bot - Delay & Timing Utilities
 *
 * Provides human-like random delays and DOM element waiting.
 * All functions return Promises so they can be awaited.
 * Exposed globally as window.TravianDelay for content script usage.
 */

(function () {
  'use strict';

  /**
   * Generate a random integer between min and max (inclusive).
   * @param {number} min - Lower bound
   * @param {number} max - Upper bound
   * @returns {number}
   */
  function randomBetween(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Add random jitter (variance) to a base value.
   * Returns a value in the range [base - variance, base + variance],
   * clamped so it never goes below 0.
   * @param {number} base - The center value
   * @param {number} variance - Maximum deviation in either direction
   * @returns {number}
   */
  function jitter(base, variance) {
    const offset = randomBetween(-variance, variance);
    return Math.max(0, base + offset);
  }

  /**
   * Sleep for a random duration between min and max milliseconds.
   * Mimics human-like pauses between actions.
   * @param {number} [min=2000] - Minimum delay in ms
   * @param {number} [max=8000] - Maximum delay in ms
   * @returns {Promise<number>} Resolves with the actual delay used
   */
  function humanDelay(min = 2000, max = 8000) {
    const delay = randomBetween(min, max);
    return new Promise((resolve) => {
      setTimeout(() => resolve(delay), delay);
    });
  }

  /**
   * Short pause (500-2000ms). Useful between rapid sequential actions
   * like clicking through menus.
   * @returns {Promise<number>} Resolves with the actual delay used
   */
  function shortDelay() {
    return humanDelay(500, 2000);
  }

  /**
   * Long pause (5000-20000ms). Useful for idle periods or between
   * major bot cycles to appear more human.
   * @returns {Promise<number>} Resolves with the actual delay used
   */
  function longDelay() {
    return humanDelay(5000, 20000);
  }

  /**
   * Wait for a DOM element matching the given CSS selector to appear.
   * Uses MutationObserver for efficiency instead of polling.
   * @param {string} selector - CSS selector to watch for
   * @param {number} [timeout=10000] - Maximum time to wait in ms
   * @returns {Promise<Element>} Resolves with the found element
   * @throws {Error} If the element does not appear within the timeout
   */
  function waitForElement(selector, timeout = 10000) {
    return new Promise((resolve, reject) => {
      // Check if element already exists in the DOM
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      let observer = null;
      let timeoutId = null;

      // Clean up observer and timer
      const cleanup = () => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      };

      // Set up the timeout to reject if element never appears
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForElement: "${selector}" not found within ${timeout}ms`));
      }, timeout);

      // Observe the DOM for additions that match the selector
      observer = new MutationObserver((mutations) => {
        const el = document.querySelector(selector);
        if (el) {
          cleanup();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  }

  // ── Expose globally (works in both content script and service worker) ──
  const _global = typeof window !== 'undefined' ? window : self;
  _global.TravianDelay = {
    humanDelay,
    shortDelay,
    longDelay,
    jitter,
    randomBetween,
    waitForElement,
  };
})();
