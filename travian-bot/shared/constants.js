/**
 * Travian Bot - Shared Constants
 *
 * Building names, state labels, and lookup tables used across
 * popup and (potentially) other UI surfaces.
 */

// GID → Building/Resource name mapping (Travian Legends)
const GID_NAMES = {
  1: 'Woodcutter', 2: 'Clay Pit', 3: 'Iron Mine', 4: 'Crop Field',
  5: 'Sawmill', 6: 'Brickyard', 7: 'Iron Foundry', 8: 'Grain Mill',
  9: 'Bakery', 10: 'Warehouse', 11: 'Granary', 13: 'Armoury',
  14: 'Tournament Square', 15: 'Main Building', 16: 'Rally Point',
  17: 'Marketplace', 18: 'Embassy', 19: 'Barracks', 20: 'Stable',
  21: 'Workshop', 22: 'Academy', 23: 'Cranny', 24: 'Town Hall',
  25: 'Residence', 26: 'Palace', 27: 'Treasury', 28: 'Trade Office',
  29: 'Great Barracks', 30: 'Great Stable',
  31: 'City Wall', 32: 'Earth Wall', 33: 'Palisade',
  34: 'Stonemason', 35: 'Brewery', 36: 'Trapper',
  37: "Hero's Mansion", 38: 'Great Warehouse', 39: 'Great Granary',
  40: 'Wonder', 41: 'Horse Drinking Trough', 42: 'Stone Wall',
  43: 'Command Center', 44: 'Waterworks', 45: 'Hospital'
};

// Bot high-level state labels (derived from running/paused/stopped flags)
const STATE_LABELS = {
  running: 'Running',
  stopped: 'Stopped',
  paused:  'Paused',
};

// BotEngine FSM granular state labels
const FSM_LABELS = {
  SCANNING:  'Scanning',
  DECIDING:  'Deciding',
  EXECUTING: 'Executing',
  COOLDOWN:  'Cooldown',
  IDLE:      'Idle',
};

// Tab → Panel ID mapping for the new 4-tab layout
const TAB_PANEL_MAP = {
  overview:  'panelOverview',
  activity:  'panelActivity',
  config:    'panelConfig',
  more:      'panelMore',
};

// Building GIDs available for construction in empty slots
const BUILDABLE_GIDS = [
  10, 11, 13, 14, 15, 17, 19, 20, 21, 22, 23, 24, 25,
  27, 28, 29, 30, 36, 37, 38, 39, 41
];

// Task type → display name mapping
const TASK_TYPE_NAMES = {
  upgrade_resource:     'Upgrade Resource',
  upgrade_building:     'Upgrade Building',
  build_new:            'Build New',
  train_troops:         'Train Troops',
  send_farm:            'Send Farm Raid',
  send_hero_adventure:  'Hero Adventure',
  train_traps:          'Train Traps',
};

// Resource type string → GID mapping (for domScanner field types)
const RESOURCE_TYPE_GID = {
  wood: 1, clay: 2, iron: 3, crop: 4,
};
