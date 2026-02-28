/**
 * domScanner.js - Travian DOM Scanner
 *
 * Extracts game state from Travian pages by scanning the DOM.
 * Supports both Travian Legends and newer versions with fallback selectors.
 * All methods are defensive - they return null/empty on failure rather than throwing.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helper utilities
  // ---------------------------------------------------------------------------

  /**
   * Safely query a single element. Returns null if not found.
   */
  function qs(selector, context) {
    try {
      return (context || document).querySelector(selector);
    } catch (_) {
      return null;
    }
  }

  /**
   * Safely query all matching elements. Returns empty array if none found.
   */
  function qsa(selector, context) {
    try {
      return Array.from((context || document).querySelectorAll(selector));
    } catch (_) {
      return [];
    }
  }

  /**
   * Parse a text string into a number, stripping non-numeric chars (except minus).
   * Returns 0 if parsing fails.
   */
  function parseNum(text) {
    if (text == null) return 0;
    var cleaned = String(text).replace(/[^\d\-]/g, '');
    var n = parseInt(cleaned, 10);
    return isNaN(n) ? 0 : n;
  }

  /**
   * Try multiple selectors in order and return the first match (single element).
   */
  function trySelectors(selectors, context) {
    for (var i = 0; i < selectors.length; i++) {
      var el = qs(selectors[i], context);
      if (el) return el;
    }
    return null;
  }

  /**
   * Try multiple selectors and return the first non-empty result set.
   */
  function trySelectorAll(selectors, context) {
    for (var i = 0; i < selectors.length; i++) {
      var els = qsa(selectors[i], context);
      if (els.length > 0) return els;
    }
    return [];
  }

  /**
   * Extract text content from an element found via selector(s).
   */
  function textOf(selectorOrSelectors, context) {
    var el;
    if (Array.isArray(selectorOrSelectors)) {
      el = trySelectors(selectorOrSelectors, context);
    } else {
      el = qs(selectorOrSelectors, context);
    }
    return el ? el.textContent.trim() : '';
  }

  // ---------------------------------------------------------------------------
  // Resource type mapping (gid -> type)
  // ---------------------------------------------------------------------------
  var GID_TO_RESOURCE = {
    1: 'wood',
    2: 'clay',
    3: 'iron',
    4: 'crop'
  };

  // ---------------------------------------------------------------------------
  // TravianScanner
  // ---------------------------------------------------------------------------

  var TravianScanner = {

    // -------------------------------------------------------------------------
    // Page Detection
    // -------------------------------------------------------------------------

    /**
     * Detect which page the player is currently on.
     * @returns {string} One of: 'login', 'resources', 'village', 'building',
     *                   'rallyPoint', 'barracks', 'stable', 'workshop',
     *                   'marketplace', 'unknown'
     */
    detectPage: function () {
      try {
        // Login page
        if (qs('form#login') || qs('.loginForm') || qs('#loginForm') || qs('.login')) {
          return 'login';
        }

        var url = window.location.href;

        // Hero pages
        if (url.indexOf('/hero/adventures') !== -1 || url.indexOf('hero_adventure') !== -1) {
          return 'heroAdventures';
        }
        if (url.indexOf('/hero') !== -1 || url.indexOf('hero_inventory') !== -1 || url.indexOf('hero.php') !== -1) {
          return 'hero';
        }

        // Building-specific pages (check before generic building)
        if (url.indexOf('build.php') !== -1) {
          // Rally point - slot 39 is the rally point by convention
          if (url.indexOf('id=39') !== -1 || url.indexOf('gid=16') !== -1) {
            // Also check DOM for rally point indicators
            return 'rallyPoint';
          }

          // Check for rally point via DOM as well
          var buildingTitle = textOf(['.titleInHeader', '#build .titleInHeader', '.build_title', '.contentNavi .contentContainer h1']);
          var titleLower = buildingTitle.toLowerCase();

          if (titleLower.indexOf('rally point') !== -1 || titleLower.indexOf('sammelpunkt') !== -1 || titleLower.indexOf('rallypoint') !== -1) {
            return 'rallyPoint';
          }

          // Barracks - gid=19
          if (url.indexOf('gid=19') !== -1 || titleLower.indexOf('barracks') !== -1 || titleLower.indexOf('kaserne') !== -1) {
            return 'barracks';
          }

          // Stable - gid=20
          if (url.indexOf('gid=20') !== -1 || titleLower.indexOf('stable') !== -1 || titleLower.indexOf('stall') !== -1) {
            return 'stable';
          }

          // Workshop - gid=21
          if (url.indexOf('gid=21') !== -1 || titleLower.indexOf('workshop') !== -1 || titleLower.indexOf('werkstatt') !== -1) {
            return 'workshop';
          }

          // Marketplace - gid=17
          if (url.indexOf('gid=17') !== -1 || titleLower.indexOf('marketplace') !== -1 || titleLower.indexOf('marktplatz') !== -1) {
            return 'marketplace';
          }

          // Generic building page
          return 'building';
        }

        // Tasks / quests page
        if (url.indexOf('/tasks') !== -1) {
          return 'tasks';
        }

        // Resource fields overview (dorf1)
        if (url.indexOf('dorf1') !== -1) {
          return 'resources';
        }

        // Village overview (dorf2)
        if (url.indexOf('dorf2') !== -1) {
          return 'village';
        }

        return 'unknown';
      } catch (e) {
        console.warn('[TravianScanner] detectPage error:', e);
        return 'unknown';
      }
    },

    // -------------------------------------------------------------------------
    // Resource Scanning
    // -------------------------------------------------------------------------

    /**
     * Get current resource amounts.
     * @returns {{ wood: number, clay: number, iron: number, crop: number } | null}
     */
    getResources: function () {
      try {
        // Method 1: Classic Travian Legends selectors (#l1 .. #l4)
        var l1 = qs('#l1');
        var l2 = qs('#l2');
        var l3 = qs('#l3');
        var l4 = qs('#l4');

        if (l1 && l2 && l3 && l4) {
          return {
            wood: parseNum(l1.textContent),
            clay: parseNum(l2.textContent),
            iron: parseNum(l3.textContent),
            crop: parseNum(l4.textContent)
          };
        }

        // Method 2: stockBar resource elements
        var stockBarItems = qsa('.stockBar .resource');
        if (stockBarItems.length >= 4) {
          return {
            wood: parseNum(stockBarItems[0].textContent),
            clay: parseNum(stockBarItems[1].textContent),
            iron: parseNum(stockBarItems[2].textContent),
            crop: parseNum(stockBarItems[3].textContent)
          };
        }

        // Method 3: Newer UI with specific resource IDs
        var resWood = trySelectors(['#stockBarResource1', '.resourceWrapper .resource.r1']);
        var resClay = trySelectors(['#stockBarResource2', '.resourceWrapper .resource.r2']);
        var resIron = trySelectors(['#stockBarResource3', '.resourceWrapper .resource.r3']);
        var resCrop = trySelectors(['#stockBarResource4', '.resourceWrapper .resource.r4']);

        if (resWood || resClay || resIron || resCrop) {
          return {
            wood: resWood ? parseNum(resWood.textContent) : 0,
            clay: resClay ? parseNum(resClay.textContent) : 0,
            iron: resIron ? parseNum(resIron.textContent) : 0,
            crop: resCrop ? parseNum(resCrop.textContent) : 0
          };
        }

        // Method 4: data attributes in newer versions
        var resElements = qsa('[id^="stockBarResource"]');
        if (resElements.length >= 4) {
          return {
            wood: parseNum(resElements[0].textContent),
            clay: parseNum(resElements[1].textContent),
            iron: parseNum(resElements[2].textContent),
            crop: parseNum(resElements[3].textContent)
          };
        }

        return null;
      } catch (e) {
        console.warn('[TravianScanner] getResources error:', e);
        return null;
      }
    },

    /**
     * Get warehouse and granary capacity.
     * @returns {{ warehouse: number, granary: number } | null}
     */
    getResourceCapacity: function () {
      try {
        var warehouse = 0;
        var granary = 0;

        // Method 1: stockBar capacity elements (nested .value div in newer versions)
        var warehouseEl = trySelectors([
          '.warehouse .capacity .value',
          '#stockBarWarehouse',
          '.warehouse .capacity',
          '.stockBar .warehouse',
          '.maxWarehouse'
        ]);
        var granaryEl = trySelectors([
          '.granary .capacity .value',
          '#stockBarGranary',
          '.granary .capacity',
          '.stockBar .granary',
          '.maxGranary'
        ]);

        if (warehouseEl) warehouse = parseNum(warehouseEl.textContent);
        if (granaryEl) granary = parseNum(granaryEl.textContent);

        // Method 2: Parse from title/tooltip attributes
        if (warehouse === 0) {
          var wTooltip = qs('[id*="warehouse"][title]') || qs('.warehouse[title]');
          if (wTooltip) warehouse = parseNum(wTooltip.getAttribute('title'));
        }
        if (granary === 0) {
          var gTooltip = qs('[id*="granary"][title]') || qs('.granary[title]');
          if (gTooltip) granary = parseNum(gTooltip.getAttribute('title'));
        }

        if (warehouse === 0 && granary === 0) return null;

        return { warehouse: warehouse, granary: granary };
      } catch (e) {
        console.warn('[TravianScanner] getResourceCapacity error:', e);
        return null;
      }
    },

    /**
     * Get resource production rates (per hour).
     * @returns {{ wood: number, clay: number, iron: number, crop: number } | null}
     */
    getResourceProduction: function () {
      try {
        // Method 1: Production table/tooltip
        var prodElements = trySelectorAll([
          '#production .num',
          '#production td.num',
          '.productionPerHour .value',
          '.production .resource'
        ]);

        if (prodElements.length >= 4) {
          return {
            wood: parseNum(prodElements[0].textContent),
            clay: parseNum(prodElements[1].textContent),
            iron: parseNum(prodElements[2].textContent),
            crop: parseNum(prodElements[3].textContent)
          };
        }

        // Method 2: Tooltips on resource bar
        var prodValues = { wood: 0, clay: 0, iron: 0, crop: 0 };
        var resourceKeys = ['wood', 'clay', 'iron', 'crop'];

        for (var i = 1; i <= 4; i++) {
          var el = qs('#stockBarResource' + i);
          if (el) {
            var tooltip = el.getAttribute('title') || el.getAttribute('data-title') || '';
            // Production is sometimes in tooltip like "Production: 123/h"
            var match = tooltip.match(/(\d[\d\s]*)\s*\/\s*h/);
            if (match) {
              prodValues[resourceKeys[i - 1]] = parseNum(match[1]);
            }
          }
        }

        if (prodValues.wood || prodValues.clay || prodValues.iron || prodValues.crop) {
          return prodValues;
        }

        return null;
      } catch (e) {
        console.warn('[TravianScanner] getResourceProduction error:', e);
        return null;
      }
    },

    // -------------------------------------------------------------------------
    // Resource Fields (dorf1)
    // -------------------------------------------------------------------------

    /**
     * Get all resource fields from the dorf1 map.
     * @returns {Array<{ id: number, type: string, level: number, upgrading: boolean, position: number }>}
     */
    getResourceFields: function () {
      try {
        var fields = [];

        // Method 1: Map area elements with class patterns like gid1, gid2, etc.
        var mapAreas = trySelectorAll([
          '#rx map area',
          '#resourceFieldContainer .buildingSlot',
          '#village_map area[href*="build.php"]',
          'map#annotationsMap area',
          'area[href*="build.php"]'
        ]);

        if (mapAreas.length > 0) {
          mapAreas.forEach(function (area) {
            var href = area.getAttribute('href') || '';
            var className = area.getAttribute('class') || '';
            var title = area.getAttribute('title') || area.getAttribute('alt') || '';

            // Extract field ID from href (e.g., build.php?id=3)
            var idMatch = href.match(/id=(\d+)/);
            var fieldId = idMatch ? parseInt(idMatch[1], 10) : 0;

            // Determine resource type from class (gid1=wood, gid2=clay, gid3=iron, gid4=crop)
            var gidMatch = className.match(/gid(\d)/);
            var gid = gidMatch ? parseInt(gidMatch[1], 10) : 0;
            var type = GID_TO_RESOURCE[gid] || 'unknown';

            // Extract level from class or title
            var levelMatch = className.match(/level(\d+)/) || title.match(/level\s*(\d+)/i) || title.match(/(\d+)$/);
            var level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

            // Check if upgrading (usually indicated by a specific class)
            var upgrading = className.indexOf('underConstruction') !== -1 ||
                            className.indexOf('upgrading') !== -1 ||
                            className.indexOf('good') !== -1; // sometimes 'good' class for active upgrade

            if (fieldId > 0) {
              fields.push({
                id: fieldId,
                type: type,
                level: level,
                upgrading: upgrading,
                position: fieldId
              });
            }
          });
        }

        // Method 2: <a> or <div> elements with class .resourceField and data attributes
        if (fields.length === 0) {
          var fieldEls = trySelectorAll([
            '.resourceField',
            '#village_map .level',
            '#resourceFieldContainer div[class*="buildingSlot"]'
          ]);

          fieldEls.forEach(function (el) {
            var className = el.getAttribute('class') || '';
            var onclick = el.getAttribute('onclick') || '';
            var href = el.getAttribute('href') || '';

            // Prefer data-gid / data-aid attributes (newer Travian)
            var dataGid = parseInt(el.getAttribute('data-gid'), 10) || 0;
            var dataAid = parseInt(el.getAttribute('data-aid'), 10) || 0;

            var gidMatch = className.match(/gid(\d)/);
            var gid = dataGid || (gidMatch ? parseInt(gidMatch[1], 10) : 0);

            var levelMatch = className.match(/level(\d+)/);
            var level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

            var slotMatch = className.match(/buildingSlot(\d+)/);
            var hrefMatch = href.match(/id=(\d+)/) || onclick.match(/id=(\d+)/);
            var fieldId = dataAid || (slotMatch ? parseInt(slotMatch[1], 10) : 0) || (hrefMatch ? parseInt(hrefMatch[1], 10) : 0);

            var upgrading = className.indexOf('underConstruction') !== -1 ||
                            className.indexOf('upgrading') !== -1;

            if (fieldId > 0 || gid > 0) {
              fields.push({
                id: fieldId,
                type: GID_TO_RESOURCE[gid] || 'unknown',
                level: level,
                upgrading: upgrading,
                position: fieldId
              });
            }
          });
        }

        return fields;
      } catch (e) {
        console.warn('[TravianScanner] getResourceFields error:', e);
        return [];
      }
    },

    // -------------------------------------------------------------------------
    // Buildings (dorf2)
    // -------------------------------------------------------------------------

    /**
     * Get all buildings from the dorf2 village view.
     * @returns {Array<{ id: number, slot: number, name: string, level: number, upgrading: boolean }>}
     */
    getBuildings: function () {
      try {
        var buildings = [];

        // Method 1: Building slots with data-aid (newer Travian Legends)
        // Structure: div.buildingSlot[data-aid] > a[href*="build.php?id=X&gid=Y"] > div.labelLayer
        var buildingSlots = trySelectorAll([
          '#villageContent .buildingSlot[data-aid]',
          '.buildingSlot[data-aid]'
        ]);

        if (buildingSlots.length > 0) {
          buildingSlots.forEach(function (slot) {
            var slotId = parseInt(slot.getAttribute('data-aid'), 10) || 0;
            var link = qs('a', slot);
            if (!link) return;

            var href = link.getAttribute('href') || '';
            var linkClass = link.getAttribute('class') || '';

            // Extract gid from href (e.g., build.php?id=26&gid=15)
            var gidFromHref = href.match(/gid=(\d+)/);
            // Also try from class (e.g., gid15)
            var gidFromClass = linkClass.match(/gid(\d+)/);
            // Also try data attribute
            var gidFromData = parseInt(link.getAttribute('data-gid'), 10) || parseInt(slot.getAttribute('data-gid'), 10) || 0;

            var gid = (gidFromHref ? parseInt(gidFromHref[1], 10) : 0) ||
                      (gidFromClass ? parseInt(gidFromClass[1], 10) : 0) ||
                      gidFromData;

            // Include empty slots with gid=0 so popup can show "build new" options
            if (gid === 0) {
              buildings.push({
                id: 0,
                slot: slotId,
                name: '',
                level: 0,
                upgrading: false,
                empty: true
              });
              return;
            }

            // Level from .labelLayer or from class
            var labelEl = qs('.labelLayer', slot);
            var levelFromLabel = labelEl ? parseInt(labelEl.textContent.trim(), 10) || 0 : 0;
            var levelFromClass = linkClass.match(/level(\d+)/);
            var level = levelFromLabel || (levelFromClass ? parseInt(levelFromClass[1], 10) : 0);

            // Building name from title/alt or labelLayer
            var title = link.getAttribute('title') || link.getAttribute('alt') || '';
            var name = title.replace(/\s*level\s*\d+/i, '').replace(/\s*\(.*\)/, '').trim();

            var upgrading = linkClass.indexOf('underConstruction') !== -1 ||
                            linkClass.indexOf('upgrading') !== -1 ||
                            (slot.getAttribute('class') || '').indexOf('underConstruction') !== -1;

            buildings.push({
              id: gid,
              slot: slotId,
              name: name || ('Building GID ' + gid),
              level: level,
              upgrading: upgrading
            });
          });
        }

        // Method 2: Map areas (older Travian versions)
        if (buildings.length === 0) {
          var buildingAreas = trySelectorAll([
            '#village_map area[href*="build.php"]',
            'map#annotationsMap area[href*="build.php"]',
            '#levels area',
            'area[href*="build.php"]'
          ]);

          buildingAreas.forEach(function (area) {
            var href = area.getAttribute('href') || '';
            var className = area.getAttribute('class') || '';
            var title = area.getAttribute('title') || area.getAttribute('alt') || '';

            var idMatch = href.match(/id=(\d+)/);
            var slotId = idMatch ? parseInt(idMatch[1], 10) : 0;

            var gidMatch = className.match(/gid(\d+)/);
            var gid = gidMatch ? parseInt(gidMatch[1], 10) : 0;
            if (!gid) {
              var hrefGid = href.match(/gid=(\d+)/);
              gid = hrefGid ? parseInt(hrefGid[1], 10) : 0;
            }

            var levelMatch = className.match(/level(\d+)/) || title.match(/level\s*(\d+)/i);
            var level = levelMatch ? parseInt(levelMatch[1], 10) : 0;

            var name = title.replace(/\s*level\s*\d+/i, '').replace(/\s*\(.*\)/, '').trim();

            var upgrading = className.indexOf('underConstruction') !== -1 ||
                            className.indexOf('upgrading') !== -1;

            if (slotId > 0 && gid > 0) {
              buildings.push({
                id: gid,
                slot: slotId,
                name: name || ('Building GID ' + gid),
                level: level,
                upgrading: upgrading
              });
            }
          });
        }

        return buildings;
      } catch (e) {
        console.warn('[TravianScanner] getBuildings error:', e);
        return [];
      }
    },

    // -------------------------------------------------------------------------
    // Construction Queue
    // -------------------------------------------------------------------------

    /**
     * Get the current construction/build queue.
     * @returns {{ count: number, maxCount: number, items: Array<{ name: string, finishTime: string }> }}
     */
    getConstructionQueue: function () {
      try {
        var items = [];
        var now = Date.now();

        // Helper: parse timer text "H:MM:SS" or "MM:SS" into remaining seconds
        function parseTimerText(text) {
          if (!text) return 0;
          var parts = text.replace(/[^\d:]/g, '').split(':').map(Number);
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          return parts[0] || 0;
        }

        // Helper: extract seconds remaining from a timer element.
        // Tries the "value" attribute first (Travian sometimes stores seconds there),
        // then falls back to parsing the displayed text.
        function extractSecondsRemaining(timerEl) {
          if (!timerEl) return 0;
          var valAttr = timerEl.getAttribute('value');
          if (valAttr) {
            var parsed = parseInt(valAttr, 10);
            if (parsed > 0) return parsed;
          }
          return parseTimerText(timerEl.textContent.trim());
        }

        // Method 1: Build duration elements
        var queueElements = trySelectorAll([
          '.buildDuration',
          '#building_contract .buildDuration',
          '.buildingList .buildDuration',
          '#contracts .buildDuration',
          '.finishtime'
        ]);

        queueElements.forEach(function (el) {
          // Find the parent row or container to get the building name
          var parent = el.closest('li') || el.closest('tr') || el.closest('.buildingList') || el.closest('.contractItem') || el.parentElement;
          var nameEl = parent ? (qs('.name', parent) || qs('.buildingName', parent) || qs('a', parent)) : null;
          var name = nameEl ? nameEl.textContent.trim().replace(/\s+/g, ' ') : 'Unknown';

          // Extract finish time from timer span
          var timerEl = qs('.timer', el) || qs('span.timer', el) || el;
          var finishTime = timerEl ? timerEl.textContent.trim() : '';

          // Compute absolute finish timestamp (ms since epoch)
          var secsLeft = extractSecondsRemaining(timerEl);
          var finishTimestamp = secsLeft > 0 ? now + secsLeft * 1000 : 0;

          items.push({
            name: name,
            finishTime: finishTime,
            finishTimestamp: finishTimestamp
          });
        });

        // Method 2: Building contract section
        if (items.length === 0) {
          var contractRows = trySelectorAll([
            '#building_contract tr',
            '.contractList li',
            '.buildingList li'
          ]);

          contractRows.forEach(function (row) {
            var nameEl = qs('.name', row) || qs('a', row);
            var timeEl = qs('.timer', row) || qs('.buildDuration', row);

            var secsLeft = extractSecondsRemaining(timeEl);
            var finishTimestamp = secsLeft > 0 ? now + secsLeft * 1000 : 0;

            if (nameEl || timeEl) {
              items.push({
                name: nameEl ? nameEl.textContent.trim() : 'Unknown',
                finishTime: timeEl ? timeEl.textContent.trim() : '',
                finishTimestamp: finishTimestamp
              });
            }
          });
        }

        // Determine max queue count (usually 1 for free, 2 for Plus)
        var maxCount = 1;
        // Check for Travian Plus (allows 2 simultaneous builds)
        if (qs('.plusFeature.active') || qs('.gold_club') || qs('.a2') || qs('.finishNow')) {
          maxCount = 2;
        }

        // Compute earliest finish timestamp across all queue items
        var earliestFinish = 0;
        for (var i = 0; i < items.length; i++) {
          var ts = items[i].finishTimestamp;
          if (ts > 0 && (earliestFinish === 0 || ts < earliestFinish)) {
            earliestFinish = ts;
          }
        }

        return {
          count: items.length,
          maxCount: maxCount,
          items: items,
          earliestFinishTime: earliestFinish
        };
      } catch (e) {
        console.warn('[TravianScanner] getConstructionQueue error:', e);
        return { count: 0, maxCount: 1, items: [] };
      }
    },

    // -------------------------------------------------------------------------
    // Troops
    // -------------------------------------------------------------------------

    /**
     * Get troop counts from the troop overview if visible.
     * @returns {Object|null} Map of troop type/name to count
     */
    getTroopCounts: function () {
      try {
        var troops = {};

        // Method 1: Troop table in barracks/stable/overview
        // Note: #troops IS the table element itself (not a wrapper), so use #troops tbody tr
        var troopRows = trySelectorAll([
          '#troops tbody tr',
          '#troops table tbody tr',
          '.troop_details tr',
          '.troopOverview tr',
          '#troopInfo tr',
          '.army tr'
        ]);

        troopRows.forEach(function (row) {
          var nameEl = qs('.un', row) || qs('.troopName', row) || qs('td:first-child', row);
          var countEl = qs('.num', row) || qs('.troopCount', row) || qs('td:last-child', row);

          if (nameEl && countEl) {
            var name = nameEl.textContent.trim();
            var count = parseNum(countEl.textContent);
            if (name && count > 0) {
              troops[name] = count;
            }
          }
        });

        // Method 2: Unit images with counts
        if (Object.keys(troops).length === 0) {
          var unitElements = trySelectorAll([
            '.unit',
            '.troop_details td',
            '.troops_wrapper .unit'
          ]);

          unitElements.forEach(function (el) {
            var className = el.getAttribute('class') || '';
            var unitMatch = className.match(/unit\s+u(\d+)/);
            var count = parseNum(el.textContent);

            if (unitMatch && count > 0) {
              troops['unit_' + unitMatch[1]] = count;
            }
          });
        }

        return Object.keys(troops).length > 0 ? troops : null;
      } catch (e) {
        console.warn('[TravianScanner] getTroopCounts error:', e);
        return null;
      }
    },

    /**
     * Check if troop training is available for a given type.
     * @param {string} type - Troop type identifier
     * @returns {boolean}
     */
    canTrainTroops: function (type) {
      try {
        // Look for enabled train button
        var trainBtn = qs('.trainButton:not(.disabled)') ||
                       qs('#btn_train:not(.disabled)') ||
                       qs('button.green[type="submit"]');

        if (!trainBtn) return false;

        // If type is specified, check if the specific troop input is available
        if (type) {
          var troopInput = qs('input[name="' + type + '"]') ||
                           qs('.troop input[name*="' + type + '"]');
          if (!troopInput) return false;
          // Check if the input is not disabled
          return !troopInput.disabled;
        }

        return true;
      } catch (e) {
        console.warn('[TravianScanner] canTrainTroops error:', e);
        return false;
      }
    },

    // -------------------------------------------------------------------------
    // Villages
    // -------------------------------------------------------------------------

    /**
     * Get list of all player villages from the sidebar.
     * @returns {Array<{ id: string, name: string, x: number, y: number, isActive: boolean }>}
     */
    getVillageList: function () {
      try {
        var villages = [];

        // Method 1: Modern Travian Legends — .listEntry.village with .coordinatesGrid
        var villageEntries = document.querySelectorAll('#sidebarBoxVillageList .listEntry.village');
        if (villageEntries.length > 0) {
          villageEntries.forEach(function (entry) {
            var nameEl = entry.querySelector('.name');
            var coordEl = entry.querySelector('.coordinatesGrid');
            var linkEl = entry.querySelector('a');
            var isActive = entry.classList.contains('active');
            var name = nameEl ? nameEl.textContent.trim() : '';

            // Extract coordinates — strip Unicode bidi markers before parsing
            var x = 0, y = 0;
            if (coordEl) {
              var coordText = coordEl.textContent.replace(/[^\d|\-]/g, '');
              var coordMatch = coordText.match(/(-?\d+)\|(-?\d+)/);
              if (coordMatch) {
                x = parseInt(coordMatch[1], 10);
                y = parseInt(coordMatch[2], 10);
              }
            }

            // Extract village ID from link href or entry data attributes
            var id = '';
            if (linkEl) {
              var href = linkEl.getAttribute('href') || '';
              var idMatch = href.match(/newdid=(\d+)/) || href.match(/did=(\d+)/);
              if (idMatch) id = idMatch[1];
            }

            if (name) {
              villages.push({
                id: id,
                name: name,
                x: x,
                y: y,
                isActive: isActive
              });
            }
          });
        }

        // Method 2: Legacy sidebar with li > a structure
        if (villages.length === 0) {
          var villageLinks = trySelectorAll([
            '#sidebarBoxVillageList li a',
            '#sidebarBoxVil498 li a',
            '.villageList li a',
            '#villageListLinks li a'
          ]);

          villageLinks.forEach(function (link) {
            var href = link.getAttribute('href') || '';
            var name = link.textContent.trim();
            var li = link.closest('li');
            var isActive = li && (li.classList.contains('active') || li.classList.contains('selected'));

            var idMatch = href.match(/newdid=(\d+)/) || href.match(/did=(\d+)/);
            var id = idMatch ? idMatch[1] : '';

            var x = 0, y = 0;
            var coordMatch = (link.getAttribute('title') || '').match(/\((-?\d+)\s*\|\s*(-?\d+)\)/);
            if (coordMatch) {
              x = parseInt(coordMatch[1], 10);
              y = parseInt(coordMatch[2], 10);
            }

            if (name) {
              villages.push({ id: id, name: name, x: x, y: y, isActive: isActive });
            }
          });
        }

        return villages;
      } catch (e) {
        console.warn('[TravianScanner] getVillageList error:', e);
        return [];
      }
    },

    // -------------------------------------------------------------------------
    // Server Time
    // -------------------------------------------------------------------------

    /**
     * Get the current server time.
     * @returns {string|null} Server time string (e.g., "12:34:56")
     */
    getServerTime: function () {
      try {
        var timeEl = trySelectors([
          '#servertime',
          '.serverTime',
          '#serverTime',
          '#timer .serverTime',
          '.servertime span',
          '#servertime span'
        ]);

        if (timeEl) {
          // Try to find a nested timer span
          var timerSpan = qs('#timer_value', timeEl) || qs('span', timeEl);
          return (timerSpan || timeEl).textContent.trim();
        }

        return null;
      } catch (e) {
        console.warn('[TravianScanner] getServerTime error:', e);
        return null;
      }
    },

    // -------------------------------------------------------------------------
    // Safety Checks
    // -------------------------------------------------------------------------

    /**
     * Check if the player is currently logged in.
     * @returns {boolean}
     */
    isLoggedIn: function () {
      try {
        // If we see a login form, we are NOT logged in
        if (qs('form#login') || qs('.loginForm') || qs('#loginForm')) {
          return false;
        }

        // If we see typical game UI elements, we are logged in
        if (qs('#sidebarBoxVillageList') || qs('#sidebarBoxVil498') || qs('#stockBar') || qs('.stockBar') ||
            qs('#navigation') || qs('#villageListLinks') || qs('.villageList') ||
            qs('#l1') || qs('#servertime')) {
          return true;
        }

        // Check for resource display as a fallback indicator
        if (qs('[id^="stockBarResource"]')) {
          return true;
        }

        return false;
      } catch (e) {
        console.warn('[TravianScanner] isLoggedIn error:', e);
        return false;
      }
    },

    /**
     * Check if a CAPTCHA is present on the page.
     * @returns {boolean}
     */
    isCaptchaPresent: function () {
      try {
        return !!(
          qs('.captcha') ||
          qs('#captcha') ||
          qs('[class*="captcha"]') ||
          qs('[id*="captcha"]') ||
          qs('iframe[src*="captcha"]') ||
          qs('iframe[src*="recaptcha"]') ||
          qs('.g-recaptcha') ||
          qs('[data-sitekey]')
        );
      } catch (e) {
        console.warn('[TravianScanner] isCaptchaPresent error:', e);
        return false;
      }
    },

    /**
     * Check if the current page is an error page.
     * @returns {boolean}
     */
    isErrorPage: function () {
      try {
        // Check for actual error pages — NOT generic .error class which Travian
        // uses on normal pages (form validation, cost indicators, input styling).
        // Only match selectors specific to full-page error states.
        var errorSelectors = [
          '.systemMessage.error',   // Travian system-level error banner
          '.errorPage',             // Dedicated error page wrapper
          '#error',                 // Legacy error container
          '.errorMessage'           // Explicit error message block
          // NOTE: '.error' alone is intentionally EXCLUDED — it matches
          // dozens of normal UI elements (resource cost spans, form fields,
          // validation hints) causing false emergency stops.
        ];

        for (var i = 0; i < errorSelectors.length; i++) {
          var el = qs(errorSelectors[i]);
          if (el && el.textContent.trim().length > 0) {
            // Extra safety: ignore if the element is tiny or deeply nested in
            // a building/resource panel (likely a cost indicator, not a page error)
            var rect = el.getBoundingClientRect();
            if (rect.width < 50 && rect.height < 20) continue;
            return true;
          }
        }

        // Check for maintenance page
        if (document.title.toLowerCase().indexOf('maintenance') !== -1 ||
            document.title.toLowerCase().indexOf('wartung') !== -1) {
          return true;
        }

        // Check for ban or suspension messages
        var bodyText = (document.body ? document.body.textContent : '').toLowerCase();
        if (bodyText.indexOf('banned') !== -1 || bodyText.indexOf('suspended') !== -1) {
          // Only flag if the page looks very short (likely a ban message page)
          if (bodyText.length < 2000) {
            return true;
          }
        }

        return false;
      } catch (e) {
        console.warn('[TravianScanner] isErrorPage error:', e);
        return false;
      }
    },

    /**
     * Check if there is an active build order in the queue.
     * @returns {boolean}
     */
    hasActiveBuildOrder: function () {
      try {
        var queue = this.getConstructionQueue();
        return queue.count > 0;
      } catch (e) {
        console.warn('[TravianScanner] hasActiveBuildOrder error:', e);
        return false;
      }
    },

    // -------------------------------------------------------------------------
    // Hero & Adventures
    // -------------------------------------------------------------------------

    /**
     * Get hero status: whether hero is home, away, dead, and health info.
     * Works from any page (reads top bar hero widget).
     * @returns {{ isHome: boolean, isAway: boolean, isDead: boolean, health: number, hasAdventure: boolean, adventureCount: number } | null}
     */
    getHeroStatus: function () {
      try {
        var result = {
          isHome: false,
          isAway: false,
          isDead: false,
          health: 100,
          hasAdventure: false,
          adventureCount: 0
        };

        // --- Hero location from top bar (.heroStatus) or adventure page (.heroState) ---
        // On adventure page: .heroState has .statusHome_medium (home) or .statusAway_medium (away)
        var heroState = qs('.heroState');
        if (heroState) {
          if (qs('.statusHome_medium, .statusHome_small, [class*="statusHome"]', heroState)) {
            result.isHome = true;
          } else if (qs('.statusAway_medium, .statusAway_small, [class*="statusAway"]', heroState)) {
            result.isAway = true;
          } else if (qs('.statusDead_medium, .statusDead_small, [class*="statusDead"]', heroState)) {
            result.isDead = true;
          } else {
            // Check text content as fallback
            var stateText = heroState.textContent.toLowerCase();
            if (stateText.indexOf('village') !== -1 || stateText.indexOf('หมู่บ้าน') !== -1) {
              result.isHome = true;
            }
          }
        }

        // On any page: top bar .heroStatus div
        if (!heroState) {
          var topStatus = qs('.heroStatus');
          if (topStatus) {
            // heroStatus with class variations
            var cls = topStatus.getAttribute('class') || '';
            if (cls.indexOf('home') !== -1 || qs('[class*="Home"]', topStatus)) {
              result.isHome = true;
            } else if (cls.indexOf('away') !== -1 || qs('[class*="Away"]', topStatus)) {
              result.isAway = true;
            } else if (cls.indexOf('dead') !== -1 || qs('[class*="Dead"]', topStatus)) {
              result.isDead = true;
            } else {
              // If heroStatus exists but no away/dead indicator, assume home
              result.isHome = true;
            }
          }
        }

        // --- Adventure count from the adventure badge button ---
        var advBtn = trySelectors([
          'a[href*="/hero/adventures"].attention',
          'a[href*="/hero/adventures"]',
          'a[href*="hero_adventure"].attention',
          'a.adventure.attention',
          '.adventure.attention'
        ]);

        if (advBtn) {
          var countText = advBtn.textContent.trim();
          var count = parseInt(countText, 10) || 0;
          result.adventureCount = count;
          result.hasAdventure = count > 0 || advBtn.classList.contains('attention');
        }

        // --- On adventure page: count rows in adventure table ---
        if (result.adventureCount === 0) {
          var advRows = qsa('.adventureList tbody tr');
          if (advRows.length > 0) {
            result.adventureCount = advRows.length;
            result.hasAdventure = true;
          }
        }

        // --- Hero health from SVG in top bar ---
        // The health SVG uses a path arc; we can't easily read %, but check for
        // the health bar percentage via title/tooltip or aria attributes
        var healthSvg = qs('#topBarHero svg.health, .heroV2 svg.health');
        if (healthSvg) {
          var titleEl = qs('title', healthSvg);
          if (titleEl) {
            var hMatch = titleEl.textContent.match(/(\d+)/);
            if (hMatch) result.health = parseInt(hMatch[1], 10);
          }
        }

        // Fallback: check for health text in hero page
        var healthText = textOf(['.heroHealthStatus', '.health .value', '#heroHealth']);
        if (healthText) {
          var hParse = parseInt(healthText, 10);
          if (!isNaN(hParse)) result.health = hParse;
        }

        return result;
      } catch (e) {
        console.warn('[TravianScanner] getHeroStatus error:', e);
        return null;
      }
    },

    /**
     * Get adventure list from the hero adventures page.
     * Only works when on /hero/adventures page.
     * @returns {Array<{ distance: string, duration: string, difficulty: string, hasButton: boolean }>}
     */
    getAdventureList: function () {
      try {
        var adventures = [];
        var rows = qsa('.adventureList tbody tr');

        rows.forEach(function (row) {
          var distEl = qs('td.distance', row);
          var durEl = qs('td.duration', row);
          var diffEl = qs('td.difficulty', row);
          var btnEl = qs('td.button button, td.button a', row);

          adventures.push({
            distance: distEl ? distEl.textContent.trim() : '',
            duration: durEl ? durEl.textContent.trim() : '',
            difficulty: diffEl ? (diffEl.getAttribute('class') || '').trim() : '',
            hasButton: !!btnEl
          });
        });

        return adventures;
      } catch (e) {
        console.warn('[TravianScanner] getAdventureList error:', e);
        return [];
      }
    },

    // -------------------------------------------------------------------------
    // Quest Scanning
    // -------------------------------------------------------------------------

    /**
     * Scan quests/tasks from the /tasks page.
     * Returns an array of quest objects with title, silver reward, and progress.
     * Only works when on /tasks page.
     *
     * @returns {Array<{ title: string, silver: number, progress: number, total: number, progressPct: number }> | null}
     */
    scanQuests: function () {
      try {
        if (window.location.pathname.indexOf('/tasks') === -1) return null;

        var tasks = qsa('.task');
        if (!tasks.length) return [];

        return tasks.map(function (t) {
          var titleEl = qs('.title', t);
          var rewardEl = qs('.rewards', t);
          var progressEl = qs('.progress', t);

          var title = titleEl ? titleEl.textContent.trim() : '';

          // Extract silver reward
          var silverEl = rewardEl ? qs('.iconValueBoxWrapper', rewardEl) : null;
          var silverText = silverEl ? silverEl.textContent.trim() : '0';
          var silver = parseInt(silverText.replace(/[^\d]/g, ''), 10) || 0;

          // Extract progress text like "102/150" or "5/6 เป็นเลเวล 5"
          var progressText = progressEl ? progressEl.textContent.trim() : '';
          var progressMatch = progressText.match(/(\d+)\s*\/\s*(\d+)/);
          var progress = progressMatch ? parseInt(progressMatch[1], 10) : 0;
          var total = progressMatch ? parseInt(progressMatch[2], 10) : 1;

          return {
            title: title,
            silver: silver,
            progress: progress,
            total: total,
            progressPct: progress / total
          };
        });
      } catch (e) {
        console.warn('[TravianScanner] scanQuests error:', e);
        return null;
      }
    },

    // -------------------------------------------------------------------------
    // Trapper (Gaul building, gid=36)
    // -------------------------------------------------------------------------

    /**
     * Read trapper info from the trapper building page (gid=36).
     * Returns current trap count, max traps, and training availability.
     * Only works when on the trapper building page.
     *
     * @returns {Object|null} Trapper info or null if not on trapper page
     */
    getTrapperInfo: function () {
      try {
        // Only works on trapper building page (gid=36)
        if (window.location.href.indexOf('gid=36') === -1) return null;

        // Read trap counts from the description area
        var descEl = trySelectors(['#build .description', '#build .buildingDetails']);
        var descText = descEl ? descEl.textContent : '';
        var currentMatch = descText.match(/(\d+)\s*อัน.*?ขณะนี้/);
        var maxMatch = descText.match(/สูงสุด.*?(\d+)\s*อัน/);

        // Check training form
        var trainInput = qs('input[name="t1"]');
        var canTrain = trainInput ? !trainInput.disabled : false;
        var maxTrain = trainInput ? (parseInt(trainInput.max || '0', 10) || 0) : 0;

        return {
          currentTraps: currentMatch ? parseInt(currentMatch[1], 10) : 0,
          maxTraps: maxMatch ? parseInt(maxMatch[1], 10) : 0,
          canTrain: canTrain,
          maxTrain: maxTrain,
          isUpgrading: maxTrain === 0 && canTrain === false
        };
      } catch (e) {
        console.warn('[TravianScanner] getTrapperInfo error:', e);
        return null;
      }
    },

    // -------------------------------------------------------------------------
    // Full State
    // -------------------------------------------------------------------------

    /**
     * Scan farm lists from the rally point farm list page (tt=99).
     * Returns an array of farm list objects with id, name, entryCount.
     * Only returns data when on the rally point farm list tab.
     *
     * @returns {Array<{id: string, name: string, entryCount: number}>}
     */
    getFarmLists: function () {
      try {
        var url = window.location.href;
        // Only scan if on rally point farm list tab
        if (url.indexOf('build.php') === -1 || url.indexOf('tt=99') === -1) {
          return [];
        }

        var lists = [];

        // Farm list containers: .farmListWrapper is the actual wrapper in Travian Legends
        var listEls = trySelectorAll([
          '.farmListWrapper',
          '.raidList',
          '.farmList'
        ]);

        for (var i = 0; i < listEls.length; i++) {
          var el = listEls[i];

          // Extract list ID (wrapper may not have data-listid, fall back to index)
          var listId = el.getAttribute('data-listid') ||
                       el.getAttribute('data-id') ||
                       el.id ||
                       String(i);

          // Extract list name
          var nameEl = trySelectors([
            '.farmListName',
            '.listTitleRow .listTitle',
            '.farmListHeader .name',
            '.listName',
            '.listTitle'
          ], el);
          var name = nameEl ? nameEl.textContent.trim() : ('Farm List ' + (i + 1));

          // Count entries in the list
          var entries = qsa('.slot, tr.slotRow, .farmListEntry', el);
          var entryCount = entries.length;

          // Check if start button exists (list is usable)
          var startBtn = trySelectors([
            'button.startFarmList',
            'button.startButton',
            'button.green.startRaid',
            '.farmListHeader button.green',
            '.buttonsWrapper button.green'
          ], el);

          lists.push({
            id: listId,
            name: name,
            entryCount: entryCount,
            hasStartButton: !!startBtn
          });
        }

        // Also check if the global "Start All" button exists
        var startAllBtn = qs('button.startAllFarmLists');
        if (startAllBtn && lists.length === 0) {
          // Fallback: at least one list exists if the start-all button is present
          lists.push({
            id: '0',
            name: 'All Farm Lists',
            entryCount: 0,
            hasStartButton: true
          });
        }

        return lists;
      } catch (e) {
        console.warn('[TravianScanner] getFarmLists error:', e);
        return [];
      }
    },

    /**
     * Scan farm list slots with raid status and loot data.
     * Only works on rally point farm list tab (tt=99).
     * @returns {Array<{ slotId, name, raidStatus, lastLoot, avgLoot, bountyLevel, distance, population }>}
     */
    scanFarmListSlots: function () {
      try {
        var url = window.location.href;
        if (url.indexOf('tt=99') === -1) return [];

        var slots = qsa('.slot');
        var result = [];

        for (var i = 0; i < slots.length; i++) {
          var slot = slots[i];
          var checkbox = qs('input[type="checkbox"][name="selectOne"]', slot);
          if (!checkbox) continue; // skip header/footer rows

          var slotId = checkbox.getAttribute('data-slot-id') || String(i);
          var nameEl = qs('.villageNameWrapper a, .target a, a.targetLink', slot);
          var raidIcon = qs('i.lastRaidState', slot);
          var bountyIcon = qs('.lastRaidBounty i', slot);
          var bountyVal = qs('.lastRaidBounty .value', slot);
          var avgVal = qs('.averageRaidBounty .value', slot);
          var popEl = qs('td.population .value, td.pop .value', slot);
          var distEl = qs('td.distance .value, td.dist .value', slot);

          // Parse raid status from icon class
          var raidClass = raidIcon ? (raidIcon.className || '') : '';
          var raidStatus = 'unknown';
          if (raidClass.indexOf('attack_lost') !== -1) raidStatus = 'lost';
          else if (raidClass.indexOf('withLosses') !== -1) raidStatus = 'won_with_losses';
          else if (raidClass.indexOf('withoutLosses') !== -1) raidStatus = 'won';

          // Parse bounty level from icon class
          var bountyClass = bountyIcon ? (bountyIcon.className || '') : '';
          var bountyLevel = 'unknown';
          if (bountyClass.indexOf('bounty_full') !== -1) bountyLevel = 'full';
          else if (bountyClass.indexOf('bounty_half') !== -1) bountyLevel = 'half';
          else if (bountyClass.indexOf('bounty_empty') !== -1) bountyLevel = 'empty';

          result.push({
            index: i,
            slotId: slotId,
            name: nameEl ? nameEl.textContent.trim() : '',
            raidStatus: raidStatus,
            bountyLevel: bountyLevel,
            lastLoot: bountyVal ? (parseInt(bountyVal.textContent.replace(/[^\d]/g, ''), 10) || 0) : 0,
            avgLoot: avgVal ? (parseInt(avgVal.textContent.replace(/[^\d]/g, ''), 10) || 0) : 0,
            population: popEl ? (parseInt(popEl.textContent.replace(/[^\d]/g, ''), 10) || 0) : 0,
            distance: distEl ? parseFloat(distEl.textContent) || 0 : 0
          });
        }

        return result;
      } catch (e) {
        console.warn('[TravianScanner] scanFarmListSlots error:', e);
        return [];
      }
    },

    /**
     * Gather complete game state from all available scanners.
     * @returns {Object} Full game state object
     */
    /**
     * DOM-4 FIX: Wait for key DOM indicators before scanning.
     * Prevents partial/empty scan data when page is still loading.
     * Polls for resource bar (#l1) or sidebar (#sidebarBoxVillageList) or login form.
     * @param {number} maxWaitMs - Maximum wait time (default 3000ms)
     * @returns {Promise<boolean>} true if DOM is ready, false if timed out
     */
    waitForReady: function (maxWaitMs) {
      maxWaitMs = maxWaitMs || 3000;
      return new Promise(function (resolve) {
        var start = Date.now();
        function check() {
          // Key indicators that the Travian page is loaded
          var hasResources = !!qs('#l1');
          var hasSidebar = !!qs('#sidebarBoxVillageList');
          var hasLogin = !!qs('form#login') || !!qs('.loginForm');
          var hasContent = !!qs('#content');

          if (hasResources || hasSidebar || hasLogin || hasContent) {
            resolve(true);
            return;
          }
          if (Date.now() - start >= maxWaitMs) {
            console.warn('[TravianScanner] waitForReady timed out after ' + maxWaitMs + 'ms');
            resolve(false);
            return;
          }
          setTimeout(check, 200);
        }
        check();
      });
    },

    /**
     * FIX-P4: Detect Travian game version from CDN/gpack URLs.
     * Returns version string (e.g. "4.6.2.1") or null if not detected.
     * Used to warn when Travian pushes UI updates that may break selectors.
     */
    getGameVersion: function () {
      try {
        var links = qsa('link[href*="gpack/"]');
        for (var i = 0; i < links.length; i++) {
          var match = links[i].href.match(/gpack\/([0-9.]+)\//);
          if (match) return match[1];
        }
        // Fallback: check script tags
        var scripts = qsa('script[src*="gpack/"]');
        for (var j = 0; j < scripts.length; j++) {
          var m2 = scripts[j].src.match(/gpack\/([0-9.]+)\//);
          if (m2) return m2[1];
        }
      } catch (_) {}
      return null;
    },

    getFullState: function () {
      var state = {
        timestamp: Date.now(),
        page: 'unknown',
        loggedIn: false,
        captcha: false,
        error: false,
        serverTime: null,
        resources: null,
        resourceCapacity: null,
        resourceProduction: null,
        resourceFields: [],
        buildings: [],
        constructionQueue: { count: 0, maxCount: 1, items: [] },
        troops: null,
        villages: [],
        hero: null,
        farmLists: [],
        url: window.location.href
      };

      try { state.page = this.detectPage(); } catch (e) { console.warn('[TravianScanner] getFullState - detectPage error:', e); }
      try { state.loggedIn = this.isLoggedIn(); } catch (e) { console.warn('[TravianScanner] getFullState - isLoggedIn error:', e); }
      try { state.captcha = this.isCaptchaPresent(); } catch (e) { console.warn('[TravianScanner] getFullState - isCaptchaPresent error:', e); }
      try { state.error = this.isErrorPage(); } catch (e) { console.warn('[TravianScanner] getFullState - isErrorPage error:', e); }
      try { state.serverTime = this.getServerTime(); } catch (e) { console.warn('[TravianScanner] getFullState - getServerTime error:', e); }
      try { state.resources = this.getResources(); } catch (e) { console.warn('[TravianScanner] getFullState - getResources error:', e); }
      try { state.resourceCapacity = this.getResourceCapacity(); } catch (e) { console.warn('[TravianScanner] getFullState - getResourceCapacity error:', e); }
      try { state.resourceProduction = this.getResourceProduction(); } catch (e) { console.warn('[TravianScanner] getFullState - getResourceProduction error:', e); }
      try { state.resourceFields = this.getResourceFields(); } catch (e) { console.warn('[TravianScanner] getFullState - getResourceFields error:', e); }
      try { state.buildings = this.getBuildings(); } catch (e) { console.warn('[TravianScanner] getFullState - getBuildings error:', e); }
      try { state.constructionQueue = this.getConstructionQueue(); } catch (e) { console.warn('[TravianScanner] getFullState - getConstructionQueue error:', e); }
      try { state.troops = this.getTroopCounts(); } catch (e) { console.warn('[TravianScanner] getFullState - getTroopCounts error:', e); }
      try { state.villages = this.getVillageList(); } catch (e) { console.warn('[TravianScanner] getFullState - getVillageList error:', e); }
      try { state.hero = this.getHeroStatus(); } catch (e) { console.warn('[TravianScanner] getFullState - getHeroStatus error:', e); }
      try { state.farmLists = this.getFarmLists(); } catch (e) { console.warn('[TravianScanner] getFullState - getFarmLists error:', e); }

      // FIX-P4: Detect Travian game version from CDN URLs for selector breakage warning
      try { state.gameVersion = this.getGameVersion(); } catch (e) { /* non-critical */ }

      // Quest scanning (only on tasks page)
      if (state.page === 'tasks' || window.location.pathname.indexOf('/tasks') !== -1) {
        try { state.quests = this.scanQuests(); } catch (e) { console.warn('[TravianScanner] getFullState - scanQuests error:', e); }
      }

      // Trapper info (only on trapper building page gid=36)
      try { state.trapperInfo = this.getTrapperInfo(); } catch (e) { console.warn('[TravianScanner] getFullState - getTrapperInfo error:', e); }

      // Extract own userId from page for MapScanner
      try {
        var bodyText = document.body ? document.body.innerHTML.substring(0, 5000) : '';
        var uidMatch = bodyText.match(/playerId['":\s]+(\d+)/) ||
                       bodyText.match(/Travian\.Game\.player\s*=\s*\{[^}]*?id\s*:\s*(\d+)/) ||
                       bodyText.match(/player_id['":\s]+(\d+)/);
        if (uidMatch) {
          state.myUserId = parseInt(uidMatch[1], 10) || 0;
        }
      } catch (e) {
        console.warn('[TravianScanner] getFullState - myUserId error:', e);
      }

      return state;
    }
  };

  // Expose on the window object
  window.TravianScanner = TravianScanner;

  // Inject a DOM marker so page-context scripts can detect the bot is loaded
  try {
    document.documentElement.setAttribute('data-travian-bot', 'loaded');
    document.documentElement.setAttribute('data-travian-bot-page', TravianScanner.detectPage());
  } catch (_) {}

  // ---------------------------------------------------------------------------
  // DOM Bridge: allows page-context scripts (e.g. MCP testing) to trigger scans
  // Uses window.postMessage which correctly crosses the content script boundary.
  // Page context sends: window.postMessage({ source: 'travian-bot-page', action: 'getFullState' }, '*')
  // Content script replies: window.postMessage({ source: 'travian-bot-cs', data: ... }, '*')
  // ---------------------------------------------------------------------------
  try {
    window.addEventListener('message', function (event) {
      if (event.source !== window) return;
      if (!event.data || event.data.source !== 'travian-bot-page') return;

      var action = event.data.action || 'getFullState';
      var requestId = event.data.requestId || '';
      var result = null;

      try {
        if (typeof TravianScanner[action] === 'function') {
          result = TravianScanner[action]();
        } else {
          result = { error: 'Unknown action: ' + action };
        }
      } catch (err) {
        result = { error: err.message || String(err) };
      }

      window.postMessage({
        source: 'travian-bot-cs',
        requestId: requestId,
        data: result
      }, '*');
    });
  } catch (_) {}

  console.log('[TravianScanner] DOM Scanner initialized. Page:', TravianScanner.detectPage());

})();
