/**
 * ConfigSchema — Declarative configuration validation and migration.
 *
 * Validates bot config against a schema, coerces types where possible,
 * strips unknown keys, and applies default values for missing fields.
 * Called on config load and save to prevent corruption.
 *
 * Usage:
 *   var result = TravianConfigSchema.validate(config);
 *   if (result.warnings.length > 0) console.warn(result.warnings);
 *   var cleanConfig = result.config; // validated + coerced
 */
(function(root) {
  'use strict';

  // ── Schema definition ──────────────────────────────────────────────────
  // Each field: { type, default, [min], [max], [enum], [items], [nested] }
  // type: 'boolean', 'number', 'string', 'array', 'object', 'any'

  var SCHEMA = {
    enabled:              { type: 'boolean', default: false },
    autoResourceUpgrade:  { type: 'boolean', default: true },
    autoUpgradeResources: { type: 'boolean', default: true },   // legacy alias
    autoBuildingUpgrade:  { type: 'boolean', default: true },
    autoBuildUpgrade:     { type: 'boolean', default: true },    // legacy alias
    autoTroopTraining:    { type: 'boolean', default: false },
    autoFarming:          { type: 'boolean', default: false },
    autoHeroAdventure:    { type: 'boolean', default: false },
    autoQuestClaim:       { type: 'boolean', default: true },
    autoBuildTraps:       { type: 'boolean', default: false },

    activeVillage:     { type: 'any',    default: null },
    villages:          { type: 'object', default: {} },
    buildingPriority:  { type: 'array',  default: ['granary', 'warehouse', 'mainBuilding', 'barracks'] },
    upgradeTargets:    { type: 'object', default: {} },

    tribe:             { type: 'string', default: null, enum: [null, 'roman', 'teuton', 'gaul'] },
    serverStartDate:   { type: 'string', default: null },
    serverSpeed:       { type: 'number', default: 1, min: 1, max: 10 },

    // Village coordinates (for MilitaryPlanner)
    villageX:          { type: 'number', default: null },
    villageY:          { type: 'number', default: null },

    troopConfig: {
      type: 'object', default: {},
      nested: {
        type:           { type: 'string', default: null },
        minResources:   { type: 'number', default: 1000, min: 0 },
        trainBatchSize: { type: 'number', default: 5, min: 1, max: 200 },
        slots:          { type: 'array',  default: [] },
      }
    },

    farmConfig: {
      type: 'object', default: {},
      nested: {
        enabled:        { type: 'boolean', default: false },
        interval:       { type: 'number',  default: 300000, min: 60000, max: 3600000 },
        minTroops:      { type: 'number',  default: 10, min: 1 },
        targets:        { type: 'array',   default: [] },
        reRaidEnabled:  { type: 'boolean', default: false },
        reRaidTroopSpeed:    { type: 'number', default: 19 },
        reRaidCarryPerUnit:  { type: 'number', default: 150 },
        reRaidTroopCount:    { type: 'number', default: 5 },
      }
    },

    delays: {
      type: 'object', default: {},
      nested: {
        min:     { type: 'number', default: 2000, min: 500, max: 30000 },
        max:     { type: 'number', default: 8000, min: 1000, max: 60000 },
        idleMin: { type: 'number', default: 30000, min: 5000, max: 300000 },
        idleMax: { type: 'number', default: 120000, min: 10000, max: 600000 },
      }
    },

    safetyConfig: {
      type: 'object', default: {},
      nested: {
        maxActionsPerHour:   { type: 'number',  default: 60, min: 10, max: 300 },
        captchaAutoStop:     { type: 'boolean', default: true },
        emergencyStopOnError: { type: 'boolean', default: true },
        maxRetries:          { type: 'number',  default: 3, min: 1, max: 10 },
      }
    },

    // NPC marketplace (Phase 3)
    npcConfig: {
      type: 'object', default: {},
      nested: {
        enabled:      { type: 'boolean', default: false },
        ratioWood:    { type: 'number', default: 25, min: 0, max: 100 },
        ratioClay:    { type: 'number', default: 25, min: 0, max: 100 },
        ratioIron:    { type: 'number', default: 25, min: 0, max: 100 },
        ratioCrop:    { type: 'number', default: 25, min: 0, max: 100 },
        triggerPercent: { type: 'number', default: 90, min: 50, max: 100 },
      }
    },

    // Dodge config (Phase 3)
    dodgeConfig: {
      type: 'object', default: {},
      nested: {
        enabled:           { type: 'boolean', default: false },
        dodgeDestination:  { type: 'object',  default: null }, // {x, y}
        minTimeToReact:    { type: 'number',  default: 120, min: 30, max: 3600 }, // seconds
      }
    },
  };

  // ── Validator ──────────────────────────────────────────────────────────

  var TravianConfigSchema = {};

  /**
   * Validate and coerce a config object against the schema.
   *
   * @param {Object} config - Raw config from storage
   * @returns {{ config: Object, warnings: string[] }}
   */
  TravianConfigSchema.validate = function(config) {
    if (!config || typeof config !== 'object') {
      return { config: {}, warnings: ['Config was not an object — reset to empty'] };
    }

    var warnings = [];
    var result = _validateLevel(config, SCHEMA, '', warnings);
    return { config: result, warnings: warnings };
  };

  /**
   * Get schema definition for a given key path (e.g., 'delays.min').
   * @param {string} path
   * @returns {Object|null}
   */
  TravianConfigSchema.getFieldSchema = function(path) {
    var parts = path.split('.');
    var level = SCHEMA;
    for (var i = 0; i < parts.length; i++) {
      if (!level[parts[i]]) return null;
      if (i < parts.length - 1 && level[parts[i]].nested) {
        level = level[parts[i]].nested;
      } else {
        return level[parts[i]];
      }
    }
    return null;
  };

  /**
   * Get all field paths in the schema (for debugging / UI generation).
   * @returns {string[]}
   */
  TravianConfigSchema.getAllPaths = function() {
    var paths = [];
    _collectPaths(SCHEMA, '', paths);
    return paths;
  };

  // ── Internal helpers ───────────────────────────────────────────────────

  function _validateLevel(obj, schema, prefix, warnings) {
    var result = {};

    for (var key in schema) {
      var spec = schema[key];
      var path = prefix ? prefix + '.' + key : key;
      var value = obj[key];

      // Nested object with sub-schema
      if (spec.nested) {
        var subObj = (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
        result[key] = _validateLevel(subObj, spec.nested, path, warnings);
        continue;
      }

      // Missing → apply default
      if (value === undefined) {
        result[key] = spec.default;
        continue;
      }

      // Null is acceptable for nullable fields
      if (value === null && spec.default === null) {
        result[key] = null;
        continue;
      }

      // Type validation + coercion
      result[key] = _coerce(value, spec, path, warnings);
    }

    // Preserve unknown keys (forward compatibility — don't strip user's custom data)
    for (var uKey in obj) {
      if (!(uKey in schema)) {
        result[uKey] = obj[uKey];
      }
    }

    return result;
  }

  function _coerce(value, spec, path, warnings) {
    if (spec.type === 'any') return value;

    if (spec.type === 'boolean') {
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 1) return true;
      if (value === 'false' || value === 0) return false;
      warnings.push(path + ': expected boolean, got ' + typeof value + ' — using default');
      return spec.default;
    }

    if (spec.type === 'number') {
      var num = Number(value);
      if (isNaN(num)) {
        warnings.push(path + ': expected number, got "' + value + '" — using default');
        return spec.default;
      }
      if (spec.min !== undefined && num < spec.min) {
        warnings.push(path + ': ' + num + ' below min ' + spec.min + ' — clamped');
        num = spec.min;
      }
      if (spec.max !== undefined && num > spec.max) {
        warnings.push(path + ': ' + num + ' above max ' + spec.max + ' — clamped');
        num = spec.max;
      }
      return num;
    }

    if (spec.type === 'string') {
      if (value === null && spec.default === null) return null;
      if (typeof value !== 'string') {
        warnings.push(path + ': expected string, got ' + typeof value + ' — using default');
        return spec.default;
      }
      if (spec.enum && spec.enum.indexOf(value) === -1) {
        warnings.push(path + ': "' + value + '" not in allowed values — using default');
        return spec.default;
      }
      return value;
    }

    if (spec.type === 'array') {
      if (Array.isArray(value)) return value;
      warnings.push(path + ': expected array, got ' + typeof value + ' — using default');
      return spec.default;
    }

    if (spec.type === 'object') {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      warnings.push(path + ': expected object, got ' + typeof value + ' — using default');
      return spec.default;
    }

    return value;
  }

  function _collectPaths(schema, prefix, paths) {
    for (var key in schema) {
      var path = prefix ? prefix + '.' + key : key;
      paths.push(path);
      if (schema[key].nested) {
        _collectPaths(schema[key].nested, path, paths);
      }
    }
  }

  root.TravianConfigSchema = TravianConfigSchema;
})(typeof window !== 'undefined' ? window : self);
