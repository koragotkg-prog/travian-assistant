/**
 * Travian Bot — Logger (replaces chrome.storage-backed logger)
 *
 * API-compatible with the Chrome extension's TravianLogger.
 * Flushes to a log file instead of chrome.storage.local.
 * Supports an emitter callback for real-time forwarding to frontend.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Constants ───────────────────────────────────────────────────────

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const MAX_LOG_ENTRIES = 500;
const AUTO_FLUSH_INTERVAL = 30000; // 30 seconds
const LOG_FILE = path.join(
  os.homedir(), 'Library', 'Application Support', 'TravianBot', 'bot_logs.json'
);

// Ensure data directory exists
const logDir = path.dirname(LOG_FILE);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// ── Internal state ──────────────────────────────────────────────────

let logs = [];
let flushIntervalId = null;
let emitter = null; // Callback for real-time log forwarding

// ── Helpers ─────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function consoleMethod(level) {
  // ALL log output goes to stderr — stdout is reserved for JSON-RPC IPC
  return console.error;
}

// ── Core logging ────────────────────────────────────────────────────

function log(level, message, data = null) {
  const upperLevel = (level || 'INFO').toUpperCase();
  const validLevel = upperLevel in LOG_LEVELS ? upperLevel : 'INFO';

  const entry = {
    timestamp: timestamp(),
    level: validLevel,
    message: message,
    data: data,
  };

  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) {
    logs = logs.slice(logs.length - MAX_LOG_ENTRIES);
  }

  // Mirror to console
  const prefix = `[TravianBot][${validLevel}]`;
  const fn = consoleMethod(validLevel);
  if (data !== null && data !== undefined) {
    fn(`${prefix} ${message}`, data);
  } else {
    fn(`${prefix} ${message}`);
  }

  // Forward to emitter for real-time display in frontend
  if (emitter) {
    try {
      emitter('log', entry);
    } catch (_) {
      // Don't let emitter errors break logging
    }
  }
}

// ── Convenience shortcuts ───────────────────────────────────────────

function debug(message, data) { log('DEBUG', message, data); }
function info(message, data)  { log('INFO', message, data); }
function warn(message, data)  { log('WARN', message, data); }
function error(message, data) { log('ERROR', message, data); }

// ── Retrieval & management ──────────────────────────────────────────

function getLogs(level = null, count = null) {
  let filtered = logs;
  if (level) {
    const minSeverity = LOG_LEVELS[level.toUpperCase()];
    if (minSeverity !== undefined) {
      filtered = filtered.filter((entry) => LOG_LEVELS[entry.level] >= minSeverity);
    }
  }
  if (count && count > 0) {
    filtered = filtered.slice(-count);
  }
  return filtered;
}

function clear() {
  logs = [];
  console.error('[TravianBot] Logs cleared');
}

/**
 * Persist logs to a JSON file.
 */
function flush() {
  try {
    const tmpPath = LOG_FILE + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(logs, null, 2), 'utf8');
    fs.renameSync(tmpPath, LOG_FILE);
  } catch (err) {
    console.warn('[TravianLogger] Flush error:', err.message);
  }
}

/**
 * Load logs from file (restores after restart).
 */
function loadFromFile() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const raw = fs.readFileSync(LOG_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      if (Array.isArray(loaded)) {
        logs = loaded.slice(-MAX_LOG_ENTRIES);
      }
    }
  } catch (err) {
    console.warn('[TravianLogger] Failed to load log file:', err.message);
  }
}

// ── Emitter for real-time forwarding ────────────────────────────────

/**
 * Set a callback that receives every log entry in real time.
 * @param {Function} fn - Called as fn('log', entry)
 */
function setEmitter(fn) {
  emitter = fn;
}

// ── Auto-flush setup ────────────────────────────────────────────────

function startAutoFlush() {
  if (flushIntervalId) clearInterval(flushIntervalId);
  flushIntervalId = setInterval(flush, AUTO_FLUSH_INTERVAL);
}

// Restore logs from previous session and start auto-flush
loadFromFile();
startAutoFlush();

// ── Export ───────────────────────────────────────────────────────────

module.exports = {
  log,
  debug,
  info,
  warn,
  error,
  getLogs,
  clear,
  flush,
  setEmitter,
  LOG_LEVELS: Object.freeze({ ...LOG_LEVELS }),
};
