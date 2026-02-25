/**
 * gameData.js — Travian Game Data Repository
 *
 * All static game constants, formulas, troop stats, building data.
 * Source of truth for the strategy engine's calculations.
 *
 * Compatible with: Service Worker (self), Browser (window), Node.js (module.exports)
 */
(function () {
  'use strict';

  const TravianGameData = {

    // =========================================================================
    // Resource Production per Hour by Field Level (0-20)
    // =========================================================================
    PRODUCTION: [
      2, 5, 9, 15, 22, 33, 50, 70, 100, 145,
      200, 280, 375, 495, 635, 800, 1000, 1300, 1600, 2000, 2450
    ],

    // =========================================================================
    // Storage Capacity by Warehouse/Granary Level (0-20)
    // =========================================================================
    STORAGE: [
      800, 1220, 1660, 2120, 2600, 3100, 3620, 4170, 4740, 5340,
      5960, 6620, 7300, 8020, 8780, 9580, 10420, 11300, 12240, 13220, 14240
    ],

    // Cost/time multiplier per level (each level costs ~1.28x previous)
    COST_MULT: 1.28,
    TIME_MULT: 1.28,

    // =========================================================================
    // Building Base Data (level 1 costs + base construction time in seconds)
    // =========================================================================
    BUILDINGS: {
      woodcutter:    { wood: 40,  clay: 100, iron: 50,  crop: 60,  time: 260,  category: 'resource', gid: 1 },
      clayPit:       { wood: 80,  clay: 40,  iron: 80,  crop: 50,  time: 220,  category: 'resource', gid: 2 },
      ironMine:      { wood: 100, clay: 80,  iron: 30,  crop: 60,  time: 450,  category: 'resource', gid: 3 },
      cropField:     { wood: 70,  clay: 90,  iron: 70,  crop: 20,  time: 150,  category: 'resource', gid: 4 },
      mainBuilding:  { wood: 70,  clay: 40,  iron: 60,  crop: 20,  time: 3000, category: 'infra',    gid: 15 },
      warehouse:     { wood: 130, clay: 160, iron: 90,  crop: 40,  time: 2000, category: 'storage',  gid: 10 },
      granary:       { wood: 80,  clay: 100, iron: 70,  crop: 20,  time: 1600, category: 'storage',  gid: 11 },
      barracks:      { wood: 210, clay: 140, iron: 260, crop: 120, time: 3000, category: 'military', gid: 19 },
      stable:        { wood: 260, clay: 140, iron: 220, crop: 100, time: 4600, category: 'military', gid: 20 },
      workshop:      { wood: 460, clay: 510, iron: 600, crop: 320, time: 6000, category: 'military', gid: 21 },
      academy:       { wood: 220, clay: 160, iron: 90,  crop: 40,  time: 5000, category: 'military', gid: 22 },
      marketplace:   { wood: 80,  clay: 70,  iron: 120, crop: 70,  time: 3200, category: 'trade',    gid: 17 },
      embassy:       { wood: 180, clay: 130, iron: 150, crop: 80,  time: 4800, category: 'infra',    gid: 18 },
      residence:     { wood: 580, clay: 460, iron: 350, crop: 180, time: 3800, category: 'expansion',gid: 25 },
      palace:        { wood: 550, clay: 800, iron: 750, crop: 250, time: 6600, category: 'expansion',gid: 26 },
      cranny:        { wood: 40,  clay: 50,  iron: 30,  crop: 10,  time: 500,  category: 'defense',  gid: 23 },
      rallyPoint:    { wood: 110, clay: 160, iron: 90,  crop: 70,  time: 2400, category: 'military', gid: 16 },
      townHall:      { wood: 1250,clay: 1110,iron: 1260,crop: 600, time: 15000,category: 'infra',    gid: 24 },
      wall:          { wood: 120, clay: 200, iron: 0,   crop: 80,  time: 2000, category: 'defense',  gid: 31 },
      sawmill:       { wood: 520, clay: 380, iron: 290, crop: 90,  time: 6000, category: 'bonus',    gid: 5 },
      brickyard:     { wood: 440, clay: 480, iron: 320, crop: 50,  time: 5600, category: 'bonus',    gid: 6 },
      ironFoundry:   { wood: 200, clay: 450, iron: 510, crop: 120, time: 7200, category: 'bonus',    gid: 7 },
      grainMill:     { wood: 500, clay: 440, iron: 380, crop: 1240,time: 4800, category: 'bonus',    gid: 8 },
      bakery:        { wood: 1200,clay: 1480,iron: 870, crop: 1600,time: 9000, category: 'bonus',    gid: 9 },
      heroMansion:   { wood: 700, clay: 670, iron: 700, crop: 240, time: 5400, category: 'infra',    gid: 37 },
      tradeOffice:   { wood: 1400,clay: 1330,iron: 1200,crop: 400, time: 7000, category: 'trade',    gid: 28 },
      trapper:       { wood: 60,  clay: 70,  iron: 80,  crop: 40,  time: 600,  category: 'defense',  gid: 36, tribe: 'gaul' },
    },

    // Trap capacity per trapper level (index = level, 0-based; level 0 = no building)
    TRAPPER_CAPACITY: [0, 10, 22, 36, 52, 70, 90, 112, 136, 162, 190, 220, 252, 286, 322, 360, 400, 442, 486, 532, 580],

    // =========================================================================
    // Wall Defense Bonus per Level (base defense % added)
    // =========================================================================
    WALL_BONUS: [0, 3, 6, 9, 12, 15, 19, 23, 27, 32, 37, 42, 48, 54, 60, 67, 74, 81, 89, 97, 106],

    // Wall base defense by tribe
    WALL_BASE_DEF: { roman: 10, teuton: 6, gaul: 8 },

    // =========================================================================
    // Troop Data per Tribe
    // cost = {wood, clay, iron, crop}, upkeep = crop/hour
    // =========================================================================
    TROOPS: {
      roman: {
        legionnaire:       { attack: 40,  defInf: 35,  defCav: 50,  speed: 6,  carry: 50,  cost: { wood: 120, clay: 100, iron: 150, crop: 30 },  upkeep: 1, time: 1600, building: 'barracks' },
        praetorian:        { attack: 30,  defInf: 65,  defCav: 35,  speed: 5,  carry: 20,  cost: { wood: 100, clay: 130, iron: 160, crop: 70 },  upkeep: 1, time: 1760, building: 'barracks' },
        imperian:          { attack: 70,  defInf: 40,  defCav: 25,  speed: 7,  carry: 50,  cost: { wood: 150, clay: 160, iron: 210, crop: 80 },  upkeep: 1, time: 1920, building: 'barracks' },
        equitesLegati:     { attack: 0,   defInf: 20,  defCav: 10,  speed: 16, carry: 0,   cost: { wood: 140, clay: 160, iron: 20,  crop: 40 },  upkeep: 2, time: 1360, building: 'stable' },
        equitesImperatoris:{ attack: 120, defInf: 65,  defCav: 50,  speed: 14, carry: 100, cost: { wood: 550, clay: 440, iron: 320, crop: 100 }, upkeep: 3, time: 2640, building: 'stable' },
        equitesCaesaris:   { attack: 180, defInf: 80,  defCav: 105, speed: 10, carry: 70,  cost: { wood: 550, clay: 640, iron: 800, crop: 180 }, upkeep: 4, time: 3520, building: 'stable' },
        batteringRam:      { attack: 60,  defInf: 30,  defCav: 75,  speed: 4,  carry: 0,   cost: { wood: 900, clay: 360, iron: 500, crop: 180 }, upkeep: 3, time: 4600, building: 'workshop' },
        senator:           { attack: 50,  defInf: 40,  defCav: 30,  speed: 4,  carry: 0,   cost: { wood: 30750,clay: 27200,iron: 45000,crop: 37500}, upkeep: 5, time: 90700, building: 'residence' },
      },
      teuton: {
        clubswinger:       { attack: 40,  defInf: 20,  defCav: 5,   speed: 7,  carry: 60,  cost: { wood: 95,  clay: 75,  iron: 40,  crop: 40 },  upkeep: 1, time: 1120, building: 'barracks' },
        spearfighter:      { attack: 10,  defInf: 35,  defCav: 60,  speed: 7,  carry: 40,  cost: { wood: 145, clay: 70,  iron: 85,  crop: 40 },  upkeep: 1, time: 1360, building: 'barracks' },
        axefighter:        { attack: 60,  defInf: 30,  defCav: 30,  speed: 6,  carry: 50,  cost: { wood: 130, clay: 120, iron: 170, crop: 70 },  upkeep: 1, time: 1760, building: 'barracks' },
        scout:             { attack: 0,   defInf: 10,  defCav: 5,   speed: 9,  carry: 0,   cost: { wood: 160, clay: 100, iron: 50,  crop: 10 },  upkeep: 1, time: 1120, building: 'stable' },
        paladin:           { attack: 55,  defInf: 100, defCav: 40,  speed: 10, carry: 110, cost: { wood: 370, clay: 270, iron: 290, crop: 75 },  upkeep: 2, time: 2640, building: 'stable' },
        teutonicKnight:    { attack: 150, defInf: 50,  defCav: 75,  speed: 9,  carry: 80,  cost: { wood: 450, clay: 515, iron: 480, crop: 80 },  upkeep: 3, time: 3520, building: 'stable' },
        ram:               { attack: 65,  defInf: 30,  defCav: 80,  speed: 4,  carry: 0,   cost: { wood: 1000,clay: 300, iron: 350, crop: 200 }, upkeep: 3, time: 4200, building: 'workshop' },
        chief:             { attack: 40,  defInf: 60,  defCav: 40,  speed: 4,  carry: 0,   cost: { wood: 35500,clay: 26600,iron: 25000,crop: 27200}, upkeep: 4, time: 70500, building: 'residence' },
      },
      gaul: {
        phalanx:           { attack: 15,  defInf: 40,  defCav: 50,  speed: 7,  carry: 35,  cost: { wood: 100, clay: 130, iron: 55,  crop: 30 },  upkeep: 1, time: 1360, building: 'barracks' },
        swordsman:         { attack: 65,  defInf: 35,  defCav: 20,  speed: 6,  carry: 45,  cost: { wood: 140, clay: 150, iron: 185, crop: 60 },  upkeep: 1, time: 1760, building: 'barracks' },
        pathfinder:        { attack: 0,   defInf: 20,  defCav: 10,  speed: 17, carry: 0,   cost: { wood: 170, clay: 150, iron: 120, crop: 40 },  upkeep: 2, time: 1360, building: 'stable' },
        theutatesThunder:  { attack: 90,  defInf: 25,  defCav: 40,  speed: 19, carry: 75,  cost: { wood: 350, clay: 450, iron: 230, crop: 60 },  upkeep: 2, time: 2400, building: 'stable' },
        druidrider:        { attack: 45,  defInf: 115, defCav: 55,  speed: 16, carry: 35,  cost: { wood: 360, clay: 330, iron: 280, crop: 120 }, upkeep: 2, time: 2560, building: 'stable' },
        haeduan:           { attack: 140, defInf: 60,  defCav: 165, speed: 13, carry: 65,  cost: { wood: 500, clay: 620, iron: 675, crop: 170 }, upkeep: 3, time: 3200, building: 'stable' },
        ram:               { attack: 50,  defInf: 30,  defCav: 105, speed: 4,  carry: 0,   cost: { wood: 950, clay: 555, iron: 330, crop: 75 },  upkeep: 3, time: 4600, building: 'workshop' },
        chieftain:         { attack: 40,  defInf: 50,  defCav: 50,  speed: 5,  carry: 0,   cost: { wood: 30750,clay: 45400,iron: 31000,crop: 37500}, upkeep: 4, time: 90700, building: 'residence' },
      }
    },

    // =========================================================================
    // Tribe Strategic Profiles
    // =========================================================================
    TRIBE_PROFILES: {
      roman:  { doubleBuild: true,  crannyMult: 1.0, bestFarmer: 'equitesImperatoris', bestDefInf: 'praetorian', bestDefCav: 'equitesCaesaris', bestOff: 'imperian', eco: 'balanced' },
      teuton: { doubleBuild: false, crannyMult: 0.33, bestFarmer: 'clubswinger', bestDefInf: 'spearfighter', bestDefCav: 'paladin', bestOff: 'axefighter', eco: 'aggressive' },
      gaul:   { doubleBuild: false, crannyMult: 2.0,  bestFarmer: 'theutatesThunder', bestDefInf: 'phalanx', bestDefCav: 'druidrider', bestOff: 'swordsman', eco: 'defensive' },
    },

    // =========================================================================
    // Bonus Building Production Multipliers
    // Each level adds +5% to corresponding resource production
    // =========================================================================
    BONUS_BUILDING_PER_LEVEL: 0.05,

    // =========================================================================
    // Settler costs
    // =========================================================================
    SETTLER_COST: { wood: 5800, clay: 5300, iron: 7200, crop: 5500 },
    SETTLERS_NEEDED: 3,

    // =========================================================================
    // Formulas
    // =========================================================================

    /** Resource production per hour at given level */
    getProduction: function (level) {
      level = Math.max(0, Math.min(level || 0, 20));
      return this.PRODUCTION[level];
    },

    /** Storage capacity at given warehouse/granary level */
    getStorageCapacity: function (level) {
      level = Math.max(0, Math.min(level || 0, 20));
      return this.STORAGE[level];
    },

    /** Cost to upgrade a building from (level) to (level+1) */
    getUpgradeCost: function (buildingKey, fromLevel) {
      var base = this.BUILDINGS[buildingKey];
      if (!base) return null;
      var mult = Math.pow(this.COST_MULT, fromLevel); // from level 0→1: mult=1, 1→2: 1.28, etc
      return {
        wood: Math.round(base.wood * mult),
        clay: Math.round(base.clay * mult),
        iron: Math.round(base.iron * mult),
        crop: Math.round(base.crop * mult),
      };
    },

    /** Total resource cost (sum of all 4 resources) */
    totalCost: function (costObj) {
      if (!costObj) return Infinity;
      return (costObj.wood || 0) + (costObj.clay || 0) + (costObj.iron || 0) + (costObj.crop || 0);
    },

    /** Construction time in seconds for a building upgrade */
    getConstructionTime: function (buildingKey, fromLevel, mainBuildingLevel, serverSpeed) {
      var base = this.BUILDINGS[buildingKey];
      if (!base) return Infinity;
      var rawTime = base.time * Math.pow(this.TIME_MULT, fromLevel);
      var mbReduction = 1 - (mainBuildingLevel || 1) * 0.035; // ~3.5% per MB level
      mbReduction = Math.max(mbReduction, 0.1); // floor at 10% of original
      var speed = serverSpeed || 1;
      return Math.round(rawTime * mbReduction / speed);
    },

    /** Additional production gained by upgrading a resource field from level to level+1 */
    getProductionGain: function (fromLevel) {
      var current = this.getProduction(fromLevel);
      var next = this.getProduction(Math.min(fromLevel + 1, 20));
      return next - current;
    },

    /** Wall defense bonus percentage at given level */
    getWallBonus: function (level) {
      level = Math.max(0, Math.min(level || 0, 20));
      return this.WALL_BONUS[level];
    },

    /** Map GID to building key */
    gidToKey: function (gid) {
      for (var key in this.BUILDINGS) {
        if (this.BUILDINGS[key].gid === gid) return key;
      }
      return null;
    },
  };

  // Export
  if (typeof module !== 'undefined' && module.exports) module.exports = TravianGameData;
  else if (typeof self !== 'undefined') self.TravianGameData = TravianGameData;
  else if (typeof window !== 'undefined') window.TravianGameData = TravianGameData;
})();
