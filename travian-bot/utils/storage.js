/**
 * Travian Bot - Chrome Storage Wrapper
 *
 * Promise-based wrapper around chrome.storage.local with helpers for
 * bot configuration, per-village settings, and farm target management.
 * Exposed globally as window.TravianStorage for content script usage.
 */

(function () {
  'use strict';

  // ── Storage Keys ─────────────────────────────────────────────────────

  const KEYS = {
    CONFIG: 'bot_config',
    CONFIG_PREFIX: 'bot_config__',
    STATE_PREFIX: 'bot_state__',
    REGISTRY: 'bot_config_registry',
    VILLAGE_PREFIX: 'village_config_',
    FARM_TARGETS: 'farm_targets',
    FARM_DATA_PREFIX: 'farm_data__',
    FARM_CYCLE_PREFIX: 'farm_cycle__',
  };

  // ── FIX-P2: Write Serialization ────────────────────────────────────
  // Prevents read-merge-write race conditions when multiple callers
  // (popup SAVE_CONFIG + BotEngine state_persistence) write the same key.
  // Each key gets its own promise chain so writes to different keys run in parallel.

  /** @type {Map<string, Promise<void>>} */
  const _writeChains = new Map();

  /**
   * Execute a read-merge-write cycle atomically for a given storage key.
   * Concurrent calls for the same key are serialized; different keys run in parallel.
   * @param {string} key - Storage key
   * @param {function(Object): Object} mergeFn - Receives current value, returns updated value
   * @returns {Promise<Object>} The updated value after write
   */
  function atomicMerge(key, mergeFn) {
    const prev = _writeChains.get(key) || Promise.resolve();
    const callerPromise = prev.then(async () => {
      const current = await get(key, {});
      const updated = mergeFn(current);
      await set(key, updated);
      return updated;
    });
    // FIX: Chain must always resolve so subsequent writes can proceed.
    // But return the raw promise to callers so they can detect failures.
    _writeChains.set(key, callerPromise.catch(err => {
      console.warn('[TravianStorage] atomicMerge failed for ' + key + ':', err);
    }));
    return callerPromise;
  }

  // ── Default Configuration ────────────────────────────────────────────

  /**
   * Returns a deep copy of the default bot configuration.
   * Called every time to avoid accidental mutation of shared state.
   * @returns {Object}
   */
  function getDefaultConfig() {
    return {
      // Master enable/disable switch
      enabled: false,

      // Feature toggles
      autoResourceUpgrade: true,
      autoBuildingUpgrade: true,
      autoTroopTraining: false,
      autoFarming: false,

      // Currently selected village (Travian village ID or null)
      activeVillage: null,

      // Per-village overrides keyed by village ID
      villages: {},

      // Ordered list of building types to prioritise when upgrading
      buildingPriority: ['granary', 'warehouse', 'mainBuilding', 'barracks'],

      // Troop training settings
      troopConfig: {
        type: null,          // Troop type identifier (game-specific)
        minResources: 1000,  // Don't train if total resources below this
        trainBatchSize: 5,   // Number of troops to queue per cycle
      },

      // Farming / raiding settings
      farmConfig: {
        enabled: false,
        interval: 300000,    // 5 minutes between raid cycles
        minTroops: 10,       // Minimum troop count before sending raids
        targets: [],         // Array of target coordinate objects
      },

      // Human-like delay ranges (ms)
      delays: {
        min: 2000,
        max: 8000,
        idleMin: 30000,
        idleMax: 120000,
      },

      // Safety / anti-detection settings
      safetyConfig: {
        maxActionsPerHour: 60,
        captchaAutoStop: true,
        emergencyStopOnError: true,
        maxRetries: 3,
      },
    };
  }

  // ── Low-level helpers ────────────────────────────────────────────────

  /**
   * Get a value from chrome.storage.local.
   * @param {string} key - Storage key
   * @param {*} [defaultValue=null] - Returned if the key does not exist
   * @returns {Promise<*>}
   */
  function get(key, defaultValue = null) {
    return new Promise((resolve) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.get([key], (result) => {
            if (chrome.runtime.lastError) {
              console.warn('[TravianStorage] get() error:', chrome.runtime.lastError.message);
              resolve(defaultValue);
              return;
            }
            resolve(result[key] !== undefined ? result[key] : defaultValue);
          });
        } else {
          // Fallback when chrome.storage is unavailable (tests / plain browser)
          console.debug('[TravianStorage] chrome.storage.local unavailable');
          resolve(defaultValue);
        }
      } catch (err) {
        console.warn('[TravianStorage] get() exception:', err);
        resolve(defaultValue);
      }
    });
  }

  /**
   * Set a value in chrome.storage.local.
   * @param {string} key - Storage key
   * @param {*} value - Value to store (must be JSON-serialisable)
   * @returns {Promise<void>}
   */
  function set(key, value) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ [key]: value }, () => {
            if (chrome.runtime.lastError) {
              console.warn('[TravianStorage] set() error:', chrome.runtime.lastError.message);
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve();
          });
        } else {
          console.debug('[TravianStorage] chrome.storage.local unavailable, value not saved');
          resolve();
        }
      } catch (err) {
        console.warn('[TravianStorage] set() exception:', err);
        reject(err);
      }
    });
  }

  // ── Bot configuration ────────────────────────────────────────────────

  /**
   * Load the full bot configuration, merging stored values on top of
   * defaults so that new config keys are always present.
   * @returns {Promise<Object>}
   */
  async function getConfig() {
    const defaults = getDefaultConfig();
    const stored = await get(KEYS.CONFIG, {});

    // Shallow-merge top-level keys, then deep-merge known nested objects
    // so that new fields added to defaults are never lost.
    const merged = { ...defaults, ...stored };

    // Deep-merge nested objects individually
    merged.troopConfig   = { ...defaults.troopConfig,   ...(stored.troopConfig   || {}) };
    merged.farmConfig    = { ...defaults.farmConfig,    ...(stored.farmConfig    || {}) };
    merged.delays        = { ...defaults.delays,        ...(stored.delays        || {}) };
    merged.safetyConfig  = { ...defaults.safetyConfig,  ...(stored.safetyConfig  || {}) };
    merged.villages      = { ...defaults.villages,      ...(stored.villages      || {}) };

    return merged;
  }

  /**
   * Persist the bot configuration.
   * @param {Object} config - Full or partial config object to save
   * @returns {Promise<void>}
   */
  async function saveConfig(config) {
    // FIX-P2: Use atomicMerge to prevent lost updates from concurrent saves
    return atomicMerge(KEYS.CONFIG, (stored) => {
      const defaults = getDefaultConfig();
      const current = { ...defaults, ...stored };
      current.troopConfig  = { ...defaults.troopConfig,  ...(stored.troopConfig  || {}) };
      current.farmConfig   = { ...defaults.farmConfig,   ...(stored.farmConfig   || {}) };
      current.delays       = { ...defaults.delays,       ...(stored.delays       || {}) };
      current.safetyConfig = { ...defaults.safetyConfig, ...(stored.safetyConfig || {}) };
      current.villages     = { ...defaults.villages,     ...(stored.villages     || {}) };

      const updated = { ...current, ...config };
      if (config.troopConfig)  updated.troopConfig  = { ...current.troopConfig,  ...config.troopConfig };
      if (config.farmConfig)   updated.farmConfig   = { ...current.farmConfig,   ...config.farmConfig };
      if (config.delays)       updated.delays       = { ...current.delays,       ...config.delays };
      if (config.safetyConfig) updated.safetyConfig = { ...current.safetyConfig, ...config.safetyConfig };
      if (config.villages)     updated.villages     = { ...current.villages,     ...config.villages };
      return updated;
    });
  }

  // ── Per-village configuration ────────────────────────────────────────

  /**
   * Get configuration for a specific village.
   * Falls back to an empty object if nothing has been saved yet.
   * @param {string|number} villageId - Travian village identifier
   * @returns {Promise<Object>}
   */
  function getVillageConfig(villageId) {
    return get(KEYS.VILLAGE_PREFIX + villageId, {});
  }

  /**
   * Save configuration for a specific village.
   * @param {string|number} villageId - Travian village identifier
   * @param {Object} config - Village-specific settings
   * @returns {Promise<void>}
   */
  function saveVillageConfig(villageId, config) {
    return set(KEYS.VILLAGE_PREFIX + villageId, config);
  }

  // ── Farm targets ─────────────────────────────────────────────────────

  /**
   * Retrieve the list of saved farm/raid targets.
   * @returns {Promise<Array>}
   */
  function getFarmTargets() {
    return get(KEYS.FARM_TARGETS, []);
  }

  /**
   * Save the farm/raid target list.
   * @param {Array} targets - Array of target objects (coords, notes, etc.)
   * @returns {Promise<void>}
   */
  function saveFarmTargets(targets) {
    return set(KEYS.FARM_TARGETS, targets);
  }

  // ── Server identification ────────────────────────────────────────────

  /**
   * Extract a server key (hostname) from a Travian URL.
   * @param {string} url - Full URL (e.g. "https://ts5.x1.asia.travian.com/dorf1.php")
   * @returns {string|null} Lowercase hostname or null if invalid
   */
  function extractServerKey(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (_) {
      return null;
    }
  }

  // ── Per-server configuration ───────────────────────────────────────

  /**
   * Load config for a specific server, merged with defaults.
   * @param {string} serverKey - Server hostname
   * @returns {Promise<Object>}
   */
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

  /**
   * Save config for a specific server and update the registry.
   * @param {string} serverKey - Server hostname
   * @param {Object} config - Full or partial config
   * @returns {Promise<void>}
   */
  async function saveServerConfig(serverKey, config) {
    const configKey = KEYS.CONFIG_PREFIX + serverKey;

    // FIX-P2: Use atomicMerge for both config and registry to prevent lost updates
    await atomicMerge(configKey, (stored) => {
      const defaults = getDefaultConfig();
      const current = { ...defaults, ...stored };
      current.troopConfig  = { ...defaults.troopConfig,  ...(stored.troopConfig  || {}) };
      current.farmConfig   = { ...defaults.farmConfig,   ...(stored.farmConfig   || {}) };
      current.delays       = { ...defaults.delays,       ...(stored.delays       || {}) };
      current.safetyConfig = { ...defaults.safetyConfig, ...(stored.safetyConfig || {}) };
      current.villages     = { ...defaults.villages,     ...(stored.villages     || {}) };

      const updated = { ...current, ...config };
      if (config.troopConfig)  updated.troopConfig  = { ...current.troopConfig,  ...config.troopConfig };
      if (config.farmConfig)   updated.farmConfig   = { ...current.farmConfig,   ...config.farmConfig };
      if (config.delays)       updated.delays       = { ...current.delays,       ...config.delays };
      if (config.safetyConfig) updated.safetyConfig = { ...current.safetyConfig, ...config.safetyConfig };
      if (config.villages)     updated.villages     = { ...current.villages,     ...config.villages };
      return updated;
    });

    // Update registry (also serialized to prevent concurrent overwrites)
    await atomicMerge(KEYS.REGISTRY, (registry) => {
      if (!registry.servers) registry = { servers: {}, version: 2 };
      registry.servers[serverKey] = registry.servers[serverKey] || {};
      registry.servers[serverKey].lastUsed = Date.now();
      registry.servers[serverKey].label = registry.servers[serverKey].label || serverKey;
      return registry;
    });
  }

  /**
   * Get the server registry (all known servers and their metadata).
   * @returns {Promise<Object>} { servers: { [serverKey]: { label, lastUsed } }, version }
   */
  function getServerRegistry() {
    return get(KEYS.REGISTRY, { servers: {}, version: 2 });
  }

  /**
   * Get runtime state for a specific server.
   * @param {string} serverKey - Server hostname
   * @returns {Promise<Object|null>}
   */
  function getServerState(serverKey) {
    return get(KEYS.STATE_PREFIX + serverKey, null);
  }

  /**
   * Save runtime state for a specific server.
   * @param {string} serverKey - Server hostname
   * @param {Object} state - Runtime state to persist
   * @returns {Promise<void>}
   */
  function saveServerState(serverKey, state) {
    return set(KEYS.STATE_PREFIX + serverKey, state);
  }

  // ── Migration ──────────────────────────────────────────────────────

  /**
   * Migrate legacy single-server config to per-server scheme.
   * Non-destructive: old keys are kept as backup.
   * @param {string} [detectedServerKey] - Server key from an open Travian tab
   * @returns {Promise<void>}
   */
  async function migrateIfNeeded(detectedServerKey) {
    var registry = await get(KEYS.REGISTRY, null);
    if (registry) return; // Already migrated

    var oldConfig = await get(KEYS.CONFIG, null);
    var oldState  = await get('bot_state', null);

    if (!oldConfig && !oldState) {
      // Fresh install
      await set(KEYS.REGISTRY, { servers: {}, version: 2 });
      return;
    }

    var serverKey = detectedServerKey || 'unknown_server';

    if (oldConfig) {
      await set(KEYS.CONFIG_PREFIX + serverKey, oldConfig);
    }
    if (oldState) {
      await set(KEYS.STATE_PREFIX + serverKey, oldState);
    }

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

  // ── Expose globally (works in both content script and service worker) ──
  const _global = typeof window !== 'undefined' ? window : self;
  _global.TravianStorage = {
    // Low-level
    get,
    set,
    // Bot config (legacy single-server)
    getConfig,
    saveConfig,
    // Per-server config
    extractServerKey,
    getServerConfig,
    saveServerConfig,
    getServerRegistry,
    getServerState,
    saveServerState,
    migrateIfNeeded,
    // Village config
    getVillageConfig,
    saveVillageConfig,
    // Farm targets
    getFarmTargets,
    saveFarmTargets,
  };
})();
