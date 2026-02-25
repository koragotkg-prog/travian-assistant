/**
 * Load IIFE modules into Node.js global scope.
 * Mimics how service-worker.js uses importScripts().
 *
 * Uses require() instead of vm.runInThisContext() so that internal
 * require() fallbacks in strategy modules resolve correctly.
 *
 * Core/strategy modules attach to `self`, so we alias global.self = global.
 * Content scripts (domScanner, actionExecutor) are NOT loaded here —
 * they run inside Puppeteer's page context via page.addScriptTag().
 */

// Make IIFE modules find `self` as global
global.self = global;

// Provide TravianLogger and TravianStorage on global
// so modules that reference them at load time find them.
if (!global.TravianLogger) {
  global.TravianLogger = require('../utils/logger');
}
if (!global.TravianStorage) {
  global.TravianStorage = require('../utils/storage');
}

// Load in dependency order (same as service-worker.js importScripts).
// Strategy modules use `module.exports` in Node.js (not self.*),
// so we explicitly assign to global after require().
require('../utils/delay');       // IIFE, attaches to global.TravianDelay directly

global.TravianTaskQueue       = require('./taskQueue');
global.TravianScheduler       = require('./scheduler');
global.TravianGameData        = require('../strategy/gameData');
global.TravianBuildOptimizer  = require('../strategy/buildOptimizer');
global.TravianMilitaryPlanner = require('../strategy/militaryPlanner');
global.TravianStrategyEngine  = require('../strategy/strategyEngine');
global.TravianDecisionEngine  = require('./decisionEngine');

module.exports = {
  TravianTaskQueue: global.TravianTaskQueue,
  TravianScheduler: global.TravianScheduler,
  TravianDecisionEngine: global.TravianDecisionEngine,
  TravianGameData: global.TravianGameData,
  TravianBuildOptimizer: global.TravianBuildOptimizer,
  TravianMilitaryPlanner: global.TravianMilitaryPlanner,
  TravianStrategyEngine: global.TravianStrategyEngine,
  TravianDelay: global.TravianDelay,
};
