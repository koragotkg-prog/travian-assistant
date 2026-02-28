/**
 * ContentScriptBridge — Encapsulates all content script communication logic.
 * Extracted from BotEngine to allow reuse by any service worker module.
 *
 * Handles:
 *   - Sending messages with retry on transient connection errors (MP-1)
 *   - Adaptive timeout for Chrome's background tab throttling (TQ-6)
 *   - Request deduplication via unique requestId stamps (TQ-6)
 *   - Ghost callback prevention via settled flags (FIX 1)
 *   - Waiting for content script readiness after navigation
 *   - Page verification after navigation (FIX 9)
 *
 * Runs in service worker context (no DOM, no window).
 * Exported via self.TravianContentScriptBridge
 */
(function() {
  'use strict';
  const root = typeof window !== 'undefined' ? window : self;

  class ContentScriptBridge {
    /**
     * @param {Function} [logger] - Logging function with signature (level, message, meta).
     *   Falls back to console.log if not provided.
     */
    constructor(logger) {
      this.activeTabId = null;

      // Logger: accepts (level, message, meta) like BotEngine._slog
      this._log = logger || function(level, message) {
        console.log('[ContentScriptBridge][' + level + '] ' + message);
      };

      // Adaptive timeout state (TQ-6)
      // Chrome throttles background tabs with minimum 1s setTimeout.
      // Content scripts can take 20-30s under heavy throttle.
      this._messageTimeout = 30000;
      this._messageTimeoutBase = 30000;   // Reset target after success
      this._messageTimeoutMax = 60000;    // Cap for throttled tabs
      this._messageTimeoutStep = 10000;   // Increase per consecutive timeout

      // Request deduplication counter (TQ-6)
      // Each EXECUTE message gets a unique requestId so the content script
      // can detect and discard duplicate requests from timeout->retry sequences.
      this._requestIdCounter = 0;
    }

    /**
     * Set the active tab ID for all subsequent messages.
     * @param {number} tabId - Chrome tab ID
     */
    setTabId(tabId) {
      this.activeTabId = tabId;
    }

    // -----------------------------------------------------------------------
    // Public: send message with retry (extracted from BotEngine.sendToContentScript)
    // -----------------------------------------------------------------------

    /**
     * Send a message to the content script with retry on transient connection errors.
     * EXECUTE messages are stamped with a unique requestId for deduplication.
     *
     * MP-1 FIX: Retry wrapper for transient "Receiving end does not exist" errors.
     * Content script may not be injected yet after page navigation.
     *
     * @param {object} message - The message to send
     * @returns {Promise<object>} The response from the content script
     */
    async send(message) {
      if (!this.activeTabId) {
        throw new Error('No active tab ID set');
      }

      // TQ-6 FIX: Stamp EXECUTE messages with a unique requestId for dedup.
      // Content script tracks last seen requestId and ignores duplicates.
      if (message && message.type === 'EXECUTE') {
        this._requestIdCounter++;
        message._requestId = this._requestIdCounter;
      }

      // MP-1 FIX: Retry wrapper for transient "Receiving end does not exist" errors.
      var maxRetries = 2;
      var lastErr = null;
      for (var attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await this._sendOnce(message);
        } catch (err) {
          lastErr = err;
          var isConnectionError = err.message && (
            err.message.indexOf('Receiving end does not exist') !== -1 ||
            err.message.indexOf('Could not establish connection') !== -1
          );
          if (!isConnectionError || attempt >= maxRetries) throw err;
          // Wait before retry -- content script may be loading
          var retryDelay = 1000 * (attempt + 1); // 1s, 2s
          this._log('WARN', 'Content script not ready, retry ' + (attempt + 1) + '/' + maxRetries + ' in ' + retryDelay + 'ms');
          await new Promise(r => setTimeout(r, retryDelay));
        }
      }
      throw lastErr;
    }

    // -----------------------------------------------------------------------
    // Internal: single message send with adaptive timeout (extracted from BotEngine._sendMessageOnce)
    // -----------------------------------------------------------------------

    /**
     * Send a single message to the content script (no retry).
     * Handles adaptive timeout and ghost callback prevention.
     *
     * @param {object} message - The message to send
     * @returns {Promise<object>} The response from the content script
     */
    async _sendOnce(message) {
      var bridge = this;
      return new Promise(function(resolve, reject) {
        // FIX 1: "settled" flag prevents ghost actions from the timeout/callback race.
        // When the timeout fires first, we reject -- but chrome.tabs.sendMessage callback
        // can still arrive later. Without this flag, both resolve AND reject would fire,
        // or the late callback would trigger side-effects on an already-abandoned promise.
        var settled = false;

        var currentTimeout = bridge._messageTimeout;
        var timeoutId = setTimeout(function() {
          if (settled) return;
          settled = true;
          // Adaptive timeout: increase for next attempt (Chrome may be throttling)
          if (bridge._messageTimeout < bridge._messageTimeoutMax) {
            bridge._messageTimeout = Math.min(bridge._messageTimeout + bridge._messageTimeoutStep, bridge._messageTimeoutMax);
            console.log('[ContentScriptBridge] Timeout -> adaptive increase to ' + bridge._messageTimeout + 'ms');
          }
          reject(new Error('Content script message timed out after ' + currentTimeout + 'ms'));
        }, currentTimeout);

        try {
          chrome.tabs.sendMessage(bridge.activeTabId, message, function(response) {
            if (settled) {
              // Ghost callback -- timeout already fired. Log and discard.
              console.warn('[ContentScriptBridge] Ghost callback after timeout for:', message.type || message.action);
              return;
            }
            settled = true;
            clearTimeout(timeoutId);

            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }

            // Adaptive timeout: reset to base after successful response
            if (bridge._messageTimeout > bridge._messageTimeoutBase) {
              bridge._messageTimeout = bridge._messageTimeoutBase;
            }

            resolve(response);
          });
        } catch (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          reject(err);
        }
      });
    }

    // -----------------------------------------------------------------------
    // Public: wait for content script readiness (extracted from BotEngine._waitForContentScript)
    // -----------------------------------------------------------------------

    /**
     * Wait until the content script in the active tab is ready and responding.
     * Used after page-reload navigations (clicking links that cause full page load)
     * to avoid sending messages before the new content script has registered.
     *
     * Uses a direct chrome.tabs.sendMessage ping (bypasses send()'s own retry
     * layer which would eat the timeout budget with inner retries).
     *
     * @param {number} [maxWaitMs=10000] - Maximum time to wait
     * @returns {Promise<boolean>} true if content script responded, false if timed out
     */
    async waitForReady(maxWaitMs) {
      maxWaitMs = maxWaitMs || 10000;
      var start = Date.now();
      var attempts = 0;
      var tabId = this.activeTabId;

      if (!tabId) {
        console.warn('[ContentScriptBridge] waitForReady: no activeTabId');
        return false;
      }

      // First, check if the tab still exists and is loading/complete
      try {
        var tabInfo = await new Promise(function(resolve) {
          chrome.tabs.get(tabId, function(tab) {
            if (chrome.runtime.lastError) resolve(null);
            else resolve(tab);
          });
        });
        if (!tabInfo) {
          console.warn('[ContentScriptBridge] waitForReady: tab ' + tabId + ' no longer exists');
          return false;
        }
        if (tabInfo.status === 'loading') {
          // Tab is still loading -- give extra time for document_idle content script injection
          console.log('[ContentScriptBridge] Tab is still loading, waiting for document_idle...');
        }
      } catch (e) {
        // Non-critical -- proceed with polling
      }

      while (Date.now() - start < maxWaitMs) {
        attempts++;
        try {
          // Direct lightweight ping -- bypass send()'s retry wrapper
          // to avoid wasting timeout budget on inner 1s+2s retries.
          var ping = await new Promise(function(resolve) {
            var pingTimeoutId = setTimeout(function() {
              resolve(null);
            }, 1500); // 1.5s per ping attempt max

            try {
              chrome.tabs.sendMessage(tabId, {
                type: 'GET_STATE', params: { property: 'page' }
              }, function(response) {
                clearTimeout(pingTimeoutId);
                if (chrome.runtime.lastError) {
                  // "Receiving end does not exist" = content script not injected yet
                  resolve(null);
                } else {
                  resolve(response);
                }
              });
            } catch (e) {
              clearTimeout(pingTimeoutId);
              resolve(null);
            }
          });

          if (ping && ping.success) {
            if (attempts > 1) {
              console.log('[ContentScriptBridge] Content script ready after ' + attempts + ' attempts (' + (Date.now() - start) + 'ms)');
            }
            return true;
          }
        } catch (e) {
          // Unexpected error -- continue polling
        }

        // Short wait between attempts -- more frequent polling = faster detection
        var elapsed = Date.now() - start;
        if (elapsed >= maxWaitMs) break;
        var waitMs = Math.min(800, maxWaitMs - elapsed);
        await new Promise(function(r) { setTimeout(r, waitMs); });
      }

      console.warn('[ContentScriptBridge] Content script not ready after ' + maxWaitMs + 'ms (' + attempts + ' attempts)');
      return false;
    }

    // -----------------------------------------------------------------------
    // Public: ping content script (lightweight liveness check)
    // -----------------------------------------------------------------------

    /**
     * Quick liveness check -- sends a GET_STATE ping and returns true/false.
     * @param {number} [timeoutMs=1500] - Timeout for the ping
     * @returns {Promise<boolean>} true if content script responded
     */
    async ping(timeoutMs) {
      timeoutMs = timeoutMs || 1500;
      var tabId = this.activeTabId;
      if (!tabId) return false;

      try {
        var result = await new Promise(function(resolve) {
          var tid = setTimeout(function() { resolve(null); }, timeoutMs);
          try {
            chrome.tabs.sendMessage(tabId, {
              type: 'GET_STATE', params: { property: 'page' }
            }, function(response) {
              clearTimeout(tid);
              if (chrome.runtime.lastError) resolve(null);
              else resolve(response);
            });
          } catch (e) {
            clearTimeout(tid);
            resolve(null);
          }
        });
        return !!(result && result.success);
      } catch (e) {
        return false;
      }
    }

    // -----------------------------------------------------------------------
    // Public: verify page after navigation (extracted from BotEngine._verifyNavigation)
    // -----------------------------------------------------------------------

    /**
     * Verify the browser is on the expected page type after navigation.
     * Sends a lightweight SCAN and compares the page type.
     *
     * FIX 9: Page state assertion to detect navigation failures.
     *
     * @param {string} expectedPage - Expected value from domScanner.detectPage()
     * @returns {Promise<boolean>} true if on correct page
     */
    async verifyPage(expectedPage) {
      try {
        var resp = await this.send({ type: 'SCAN' });
        if (!resp || !resp.success || !resp.data) return false;
        var actual = resp.data.page || 'unknown';
        if (actual === expectedPage) return true;
        this._log('WARN', 'Page assertion failed: expected ' + expectedPage + ', got ' + actual, {
          expectedPage: expectedPage, actualPage: actual
        });
        return false;
      } catch (e) {
        this._log('WARN', 'Page assertion error: ' + e.message);
        return false;
      }
    }
  }

  root.TravianContentScriptBridge = ContentScriptBridge;
})();
