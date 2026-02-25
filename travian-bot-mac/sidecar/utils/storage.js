/**
 * Travian Bot — File-based Storage (replaces chrome.storage.local)
 *
 * API-compatible with the Chrome extension's TravianStorage.
 * Stores data as JSON files in ~/Library/Application Support/TravianBot/
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Data directory ──────────────────────────────────────────────────

const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'TravianBot');

// Ensure data directory exists on load
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Storage Keys ────────────────────────────────────────────────────

const KEYS = {
  CONFIG: 'bot_config',
  CONFIG_PREFIX: 'bot_config__',
  STATE_PREFIX: 'bot_state__',
  REGISTRY: 'bot_config_registry',
  VILLAGE_PREFIX: 'village_config_',
  FARM_TARGETS: 'farm_targets',
};

// ── Default Configuration ───────────────────────────────────────────

function getDefaultConfig() {
  return {
    enabled: false,
    autoResourceUpgrade: true,
    autoBuildingUpgrade: true,
    autoTroopTraining: false,
    autoFarming: false,
    activeVillage: null,
    villages: {},
    buildingPriority: ['granary', 'warehouse', 'mainBuilding', 'barracks'],
    troopConfig: {
      type: null,
      minResources: 1000,
      trainBatchSize: 5,
    },
    farmConfig: {
      enabled: false,
      interval: 300000,
      minTroops: 10,
      targets: [],
    },
    delays: {
      min: 2000,
      max: 8000,
      idleMin: 30000,
      idleMax: 120000,
    },
    safetyConfig: {
      maxActionsPerHour: 60,
      captchaAutoStop: true,
      emergencyStopOnError: true,
      maxRetries: 3,
    },
  };
}

// ── Low-level helpers ───────────────────────────────────────────────

/**
 * Sanitize a storage key for use as a filename.
 */
function _filePath(key) {
  const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(DATA_DIR, safe + '.json');
}

/**
 * Get a value from file storage.
 * @param {string} key
 * @param {*} [defaultValue=null]
 * @returns {Promise<*>}
 */
async function get(key, defaultValue = null) {
  try {
    const fp = _filePath(key);
    if (!fs.existsSync(fp)) return defaultValue;
    const raw = fs.readFileSync(fp, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[TravianStorage] get() error:', err.message);
    return defaultValue;
  }
}

/**
 * Set a value in file storage.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
async function set(key, value) {
  try {
    const fp = _filePath(key);
    // Write to temp file then rename for atomicity
    const tmpPath = fp + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmpPath, fp);
  } catch (err) {
    console.warn('[TravianStorage] set() error:', err.message);
    throw err;
  }
}

// ── Bot configuration ───────────────────────────────────────────────

async function getConfig() {
  const defaults = getDefaultConfig();
  const stored = await get(KEYS.CONFIG, {});
  const merged = { ...defaults, ...stored };
  merged.troopConfig  = { ...defaults.troopConfig,  ...(stored.troopConfig  || {}) };
  merged.farmConfig   = { ...defaults.farmConfig,   ...(stored.farmConfig   || {}) };
  merged.delays       = { ...defaults.delays,       ...(stored.delays       || {}) };
  merged.safetyConfig = { ...defaults.safetyConfig, ...(stored.safetyConfig || {}) };
  merged.villages     = { ...defaults.villages,     ...(stored.villages     || {}) };
  return merged;
}

async function saveConfig(config) {
  const current = await getConfig();
  const updated = { ...current, ...config };
  if (config.troopConfig)  updated.troopConfig  = { ...current.troopConfig,  ...config.troopConfig };
  if (config.farmConfig)   updated.farmConfig   = { ...current.farmConfig,   ...config.farmConfig };
  if (config.delays)       updated.delays       = { ...current.delays,       ...config.delays };
  if (config.safetyConfig) updated.safetyConfig = { ...current.safetyConfig, ...config.safetyConfig };
  if (config.villages)     updated.villages     = { ...current.villages,     ...config.villages };
  return set(KEYS.CONFIG, updated);
}

// ── Per-village configuration ───────────────────────────────────────

function getVillageConfig(villageId) {
  return get(KEYS.VILLAGE_PREFIX + villageId, {});
}

function saveVillageConfig(villageId, config) {
  return set(KEYS.VILLAGE_PREFIX + villageId, config);
}

// ── Farm targets ────────────────────────────────────────────────────

function getFarmTargets() {
  return get(KEYS.FARM_TARGETS, []);
}

function saveFarmTargets(targets) {
  return set(KEYS.FARM_TARGETS, targets);
}

// ── Server identification ───────────────────────────────────────────

function extractServerKey(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

// ── Per-server configuration ────────────────────────────────────────

async function getServerConfig(serverKey) {
  const defaults = getDefaultConfig();
  const stored = await get(KEYS.CONFIG_PREFIX + serverKey, {});
  const merged = { ...defaults, ...stored };
  merged.troopConfig  = { ...defaults.troopConfig,  ...(stored.troopConfig  || {}) };
  merged.farmConfig   = { ...defaults.farmConfig,   ...(stored.farmConfig   || {}) };
  merged.delays       = { ...defaults.delays,       ...(stored.delays       || {}) };
  merged.safetyConfig = { ...defaults.safetyConfig, ...(stored.safetyConfig || {}) };
  merged.villages     = { ...defaults.villages,     ...(stored.villages     || {}) };
  return merged;
}

async function saveServerConfig(serverKey, config) {
  const current = await getServerConfig(serverKey);
  const updated = { ...current, ...config };
  if (config.troopConfig)  updated.troopConfig  = { ...current.troopConfig,  ...config.troopConfig };
  if (config.farmConfig)   updated.farmConfig   = { ...current.farmConfig,   ...config.farmConfig };
  if (config.delays)       updated.delays       = { ...current.delays,       ...config.delays };
  if (config.safetyConfig) updated.safetyConfig = { ...current.safetyConfig, ...config.safetyConfig };
  if (config.villages)     updated.villages     = { ...current.villages,     ...config.villages };

  await set(KEYS.CONFIG_PREFIX + serverKey, updated);

  // Update registry
  var registry = await get(KEYS.REGISTRY, { servers: {}, version: 2 });
  if (!registry.servers) registry.servers = {};
  registry.servers[serverKey] = registry.servers[serverKey] || {};
  registry.servers[serverKey].lastUsed = Date.now();
  registry.servers[serverKey].label = registry.servers[serverKey].label || serverKey;
  await set(KEYS.REGISTRY, registry);
}

function getServerRegistry() {
  return get(KEYS.REGISTRY, { servers: {}, version: 2 });
}

function getServerState(serverKey) {
  return get(KEYS.STATE_PREFIX + serverKey, null);
}

function saveServerState(serverKey, state) {
  return set(KEYS.STATE_PREFIX + serverKey, state);
}

// ── Migration ───────────────────────────────────────────────────────

async function migrateIfNeeded(detectedServerKey) {
  var registry = await get(KEYS.REGISTRY, null);
  if (registry) return;

  var oldConfig = await get(KEYS.CONFIG, null);
  var oldState  = await get('bot_state', null);

  if (!oldConfig && !oldState) {
    await set(KEYS.REGISTRY, { servers: {}, version: 2 });
    return;
  }

  var serverKey = detectedServerKey || 'unknown_server';
  if (oldConfig) await set(KEYS.CONFIG_PREFIX + serverKey, oldConfig);
  if (oldState)  await set(KEYS.STATE_PREFIX + serverKey, oldState);

  await set(KEYS.REGISTRY, {
    servers: {
      [serverKey]: {
        label: serverKey,
        lastUsed: Date.now(),
        migratedFrom: 'bot_config'
      }
    },
    version: 2
  });

  console.log('[TravianStorage] Config migrated to server: ' + serverKey);
}

// ── Export (Node.js module) ─────────────────────────────────────────

module.exports = {
  get,
  set,
  getConfig,
  saveConfig,
  extractServerKey,
  getServerConfig,
  saveServerConfig,
  getServerRegistry,
  getServerState,
  saveServerState,
  migrateIfNeeded,
  getVillageConfig,
  saveVillageConfig,
  getFarmTargets,
  saveFarmTargets,
  getDefaultConfig,
  DATA_DIR,
};
