/**
 * Travian Bot - Logging Utility
 *
 * Provides leveled logging with in-memory storage, console output,
 * and periodic persistence to chrome.storage.local.
 * Exposed globally as window.TravianLogger for content script usage.
 */

(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────────

  /** Available log levels ordered by severity. */
  const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  };

  /** Maximum number of log entries kept in memory before oldest are dropped. */
  const MAX_LOG_ENTRIES = 500;

  /** Interval (ms) between automatic flushes to chrome.storage.local. */
  const AUTO_FLUSH_INTERVAL = 30000; // 30 seconds

  /** Key used in chrome.storage.local to persist logs. */
  const STORAGE_KEY = 'bot_logs';

  // ── Internal state ───────────────────────────────────────────────────

  /** @type {Array<{timestamp: string, level: string, message: string, data: *}>} */
  let logs = [];

  /** Handle for the auto-flush interval so it can be cleared if needed. */
  let flushIntervalId = null;

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Return an ISO-8601 timestamp string for the current moment.
   * @returns {string}
   */
  function timestamp() {
    return new Date().toISOString();
  }

  /**
   * Map a level string to its corresponding console method.
   * @param {string} level
   * @returns {Function}
   */
  function consoleMethod(level) {
    switch (level) {
      case 'ERROR': return console.error;
      case 'WARN':  return console.warn;
      case 'DEBUG': return console.debug;
      case 'INFO':
      default:      return console.log;
    }
  }

  // ── Core logging ─────────────────────────────────────────────────────

  /**
   * Record a log entry.
   * @param {string} level - One of DEBUG, INFO, WARN, ERROR
   * @param {string} message - Human-readable description
   * @param {*} [data=null] - Optional structured data to attach
   */
  function log(level, message, data = null) {
    // Normalise and validate the level
    const upperLevel = (level || 'INFO').toUpperCase();
    if (!(upperLevel in LOG_LEVELS)) {
      console.warn(`[TravianLogger] Unknown log level "${level}", defaulting to INFO`);
    }
    const validLevel = upperLevel in LOG_LEVELS ? upperLevel : 'INFO';

    // Build the entry
    const entry = {
      timestamp: timestamp(),
      level: validLevel,
      message: message,
      data: data,
    };

    // Push to in-memory store, evicting oldest if necessary
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
    }

    // Mirror to the browser console with a prefix
    const prefix = `[TravianBot][${validLevel}]`;
    const fn = consoleMethod(validLevel);
    if (data !== null && data !== undefined) {
      fn(`${prefix} ${message}`, data);
    } else {
      fn(`${prefix} ${message}`);
    }
  }

  // ── Convenience shortcuts ────────────────────────────────────────────

  /** @param {string} message @param {*} [data] */
  function debug(message, data) { log('DEBUG', message, data); }

  /** @param {string} message @param {*} [data] */
  function info(message, data)  { log('INFO', message, data); }

  /** @param {string} message @param {*} [data] */
  function warn(message, data)  { log('WARN', message, data); }

  /** @param {string} message @param {*} [data] */
  function error(message, data) { log('ERROR', message, data); }

  // ── Retrieval & management ───────────────────────────────────────────

  /**
   * Retrieve stored log entries, optionally filtered by minimum level
   * and limited to the most recent N entries.
   * @param {string|null} [level=null] - Minimum severity to include (null = all)
   * @param {number|null} [count=null] - Max entries to return (null = all matching)
   * @returns {Array}
   */
  function getLogs(level = null, count = null) {
    let filtered = logs;

    // Filter by minimum level if provided
    if (level) {
      const minSeverity = LOG_LEVELS[level.toUpperCase()];
      if (minSeverity !== undefined) {
        filtered = filtered.filter((entry) => LOG_LEVELS[entry.level] >= minSeverity);
      }
    }

    // Return only the most recent `count` entries
    if (count && count > 0) {
      filtered = filtered.slice(-count);
    }

    return filtered;
  }

  /**
   * Clear all in-memory log entries.
   */
  function clear() {
    logs = [];
    console.log('[TravianBot] Logs cleared');
  }

  /**
   * Persist the current in-memory logs to chrome.storage.local.
   * Safe to call even if chrome.storage is unavailable (e.g. in tests).
   * @returns {Promise<void>}
   */
  function flush() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [STORAGE_KEY]: logs }, () => {
            if (chrome.runtime.lastError) {
              console.warn('[TravianLogger] Flush failed:', chrome.runtime.lastError.message);
            }
            resolve();
          });
        } else {
          // Fallback: no chrome.storage available (unit tests, plain browser, etc.)
          console.debug('[TravianLogger] chrome.storage.local unavailable, skipping flush');
          resolve();
        }
      } catch (err) {
        console.warn('[TravianLogger] Flush error:', err);
        resolve();
      }
    });
  }

  // ── Auto-flush setup ────────────────────────────────────────────────

  /**
   * Start the periodic auto-flush timer.
   * Called once on load; safe to call again (it clears any existing timer).
   */
  function startAutoFlush() {
    if (flushIntervalId) {
      clearInterval(flushIntervalId);
    }
    flushIntervalId = setInterval(() => {
      flush();
    }, AUTO_FLUSH_INTERVAL);
  }

  // Kick off auto-flush immediately
  startAutoFlush();

  // ── Expose globally (works in both content script and service worker) ──
  const _global = typeof window !== 'undefined' ? window : self;
  _global.TravianLogger = {
    // Core
    log,
    // Shortcuts
    debug,
    info,
    warn,
    error,
    // Retrieval & management
    getLogs,
    clear,
    flush,
    // Constants (read-only copies for external use)
    LOG_LEVELS: Object.freeze({ ...LOG_LEVELS }),
  };
})();
