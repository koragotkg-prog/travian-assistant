/**
 * Travian Bot - Shared Formatters
 *
 * Pure utility functions for formatting numbers, durations, labels.
 * No side effects, no DOM access, no chrome APIs.
 */

/**
 * Format a number compactly: 12345 → "12.3k", 1234567 → "1.2M".
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Format milliseconds into a human-readable uptime: "2h 15m", "42m 3s", "8s".
 * @param {number} ms
 * @returns {string}
 */
function formatUptime(ms) {
  var totalSeconds = Math.floor(ms / 1000);
  var hours   = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds % 3600) / 60);
  var seconds = totalSeconds % 60;

  if (hours > 0)   return hours + 'h ' + minutes + 'm';
  if (minutes > 0)  return minutes + 'm ' + seconds + 's';
  return seconds + 's';
}

/**
 * Format milliseconds into countdown: "1:23:45" or "4:30" or "0:08".
 * @param {number} ms
 * @returns {string}
 */
function formatCountdown(ms) {
  if (ms <= 0) return '0:00';
  var totalSec = Math.ceil(ms / 1000);
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  if (h > 0) {
    return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * Format a server hostname for display.
 * "ts5.x1.asia.travian.com" → "ts5 (Asia)"
 * @param {string} key - Server hostname
 * @returns {string}
 */
function formatServerLabel(key) {
  if (!key) return 'Unknown';
  var serverName = key.split('.')[0] || key;
  var region = '';
  if (key.indexOf('.asia.') !== -1) region = 'Asia';
  else if (key.indexOf('.europe.') !== -1 || key.indexOf('.de') !== -1) region = 'EU';
  else if (key.indexOf('.us') !== -1) region = 'US';
  else if (key.indexOf('.co.uk') !== -1) region = 'UK';
  else if (key.indexOf('.com.br') !== -1) region = 'BR';
  else if (key.indexOf('.co.id') !== -1) region = 'ID';
  return region ? serverName + ' (' + region + ')' : serverName;
}

/**
 * Escape HTML special characters to prevent XSS in innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Derive high-level bot state from engine status flags.
 * @param {{ running: boolean, paused: boolean, emergencyStopped: boolean }} s
 * @returns {'running'|'paused'|'stopped'}
 */
function deriveBotState(s) {
  if (!s) return 'stopped';
  if (s.emergencyStopped) return 'stopped';
  if (s.running && s.paused) return 'paused';
  if (s.running) return 'running';
  return 'stopped';
}
