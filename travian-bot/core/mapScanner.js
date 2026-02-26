/**
 * MapScanner — Fetch and parse map.sql for automated farm target discovery
 *
 * Fetches the public /map.sql endpoint from a Travian server, parses the SQL
 * INSERT statements into tile objects, and filters/ranks candidates as farm
 * targets based on distance, population, alliance, and oasis status.
 *
 * Runs in service worker context (no DOM, no window required).
 * Exported via self.TravianMapScanner / window.TravianMapScanner.
 *
 * Dependencies: TravianLogger (optional, falls back to console)
 */
(function () {
  'use strict';

  // ── Logger fallback ──────────────────────────────────────────────────

  var Logger = (typeof TravianLogger !== 'undefined') ? TravianLogger : {
    log: function () { console.log.apply(console, arguments); }
  };

  // ── Distance ─────────────────────────────────────────────────────────

  /**
   * Euclidean distance between two coordinate pairs.
   * @param {number} x1
   * @param {number} y1
   * @param {number} x2
   * @param {number} y2
   * @returns {number}
   */
  function distance(x1, y1, x2, y2) {
    var dx = x2 - x1;
    var dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ── SQL Parser ───────────────────────────────────────────────────────

  /**
   * Parse a single SQL VALUES tuple string into a tile object.
   * Handles quoted strings with escaped quotes (e.g., 'player\'s village').
   *
   * Expected column order:
   *   tileId, x, y, tribe, playerId, 'villageName', userId, 'playerName',
   *   allianceId, 'allianceName', population, NULL, isCapital, NULL, NULL, NULL
   *
   * @param {string} valuesStr - The content inside a single (...) tuple
   * @returns {Object|null} Parsed tile object, or null on failure
   */
  function parseValuesTuple(valuesStr) {
    var fields = [];
    var current = '';
    var inQuote = false;
    var i = 0;
    var len = valuesStr.length;

    while (i < len) {
      var ch = valuesStr[i];

      if (inQuote) {
        if (ch === '\\' && i + 1 < len) {
          // Escaped character inside quotes — include the escaped char
          current += valuesStr[i + 1];
          i += 2;
          continue;
        }
        if (ch === "'" && i + 1 < len && valuesStr[i + 1] === "'") {
          // SQL-style escaped quote ('') — include single quote
          current += "'";
          i += 2;
          continue;
        }
        if (ch === "'") {
          // End of quoted string
          inQuote = false;
          i++;
          continue;
        }
        current += ch;
        i++;
      } else {
        if (ch === "'") {
          inQuote = true;
          i++;
          continue;
        }
        if (ch === ',') {
          fields.push(current.trim());
          current = '';
          i++;
          continue;
        }
        current += ch;
        i++;
      }
    }
    // Push the last field
    fields.push(current.trim());

    // We expect at least 11 fields (up to population)
    if (fields.length < 11) {
      return null;
    }

    var tileId = parseInt(fields[0], 10);
    var x = parseInt(fields[1], 10);
    var y = parseInt(fields[2], 10);
    var tribe = parseInt(fields[3], 10);
    var playerId = parseInt(fields[4], 10);
    var villageName = fields[5];
    var userId = parseInt(fields[6], 10);
    var playerName = fields[7];
    var allianceId = parseInt(fields[8], 10);
    var allianceName = fields[9];
    var population = parseInt(fields[10], 10);
    var isCapital = fields.length > 12 ? parseInt(fields[12], 10) : 0;

    // Validate critical numeric fields
    if (isNaN(x) || isNaN(y) || isNaN(tribe) || isNaN(population)) {
      return null;
    }

    return {
      tileId: tileId,
      x: x,
      y: y,
      tribe: tribe,
      playerId: isNaN(playerId) ? 0 : playerId,
      villageName: villageName,
      userId: isNaN(userId) ? 0 : userId,
      playerName: playerName,
      allianceId: isNaN(allianceId) ? 0 : allianceId,
      allianceName: allianceName,
      population: isNaN(population) ? 0 : population,
      isCapital: isCapital === 1
    };
  }

  /**
   * Parse raw SQL text from map.sql into an array of tile objects.
   *
   * The file contains INSERT INTO `x_world` VALUES (...),(...),(...);
   * statements. Each tuple represents one map tile.
   *
   * @param {string} sqlText - Raw SQL text from /map.sql
   * @returns {Array<Object>} Array of parsed tile objects
   */
  function parseSql(sqlText) {
    if (!sqlText || typeof sqlText !== 'string') {
      Logger.log('WARN', '[MapScanner] parseSql received empty or invalid input');
      return [];
    }

    var tiles = [];
    var errorCount = 0;

    // Match all VALUES clause content: everything between VALUES and ;
    // The SQL can have multiple INSERT statements, each with multiple tuples.
    var valuesRegex = /VALUES\s*(\([\s\S]*?\));/gi;
    var match;

    while ((match = valuesRegex.exec(sqlText)) !== null) {
      var valuesBlock = match[1];

      // Split tuples by "),(" pattern — but must handle quoted strings
      // containing parentheses. We use a state machine approach.
      var tuples = splitTuples(valuesBlock);

      for (var i = 0; i < tuples.length; i++) {
        var tile = parseValuesTuple(tuples[i]);
        if (tile) {
          tiles.push(tile);
        } else {
          errorCount++;
        }
      }
    }

    Logger.log('INFO', '[MapScanner] Parsed ' + tiles.length + ' tiles from SQL' +
      (errorCount > 0 ? ' (' + errorCount + ' parse errors)' : ''));

    return tiles;
  }

  /**
   * Split a VALUES block like "(1,2,...),(3,4,...)" into individual tuple strings.
   * Handles quoted strings that may contain commas and parentheses.
   *
   * @param {string} block - The full VALUES content including outer parens
   * @returns {Array<string>} Array of inner tuple content strings
   */
  function splitTuples(block) {
    var tuples = [];
    var depth = 0;
    var inQuote = false;
    var start = -1;
    var i = 0;
    var len = block.length;

    while (i < len) {
      var ch = block[i];

      if (inQuote) {
        if (ch === '\\' && i + 1 < len) {
          i += 2; // Skip escaped char
          continue;
        }
        if (ch === "'" && i + 1 < len && block[i + 1] === "'") {
          i += 2; // Skip SQL escaped quote
          continue;
        }
        if (ch === "'") {
          inQuote = false;
        }
        i++;
        continue;
      }

      if (ch === "'") {
        inQuote = true;
        i++;
        continue;
      }

      if (ch === '(') {
        if (depth === 0) {
          start = i + 1; // Content starts after opening paren
        }
        depth++;
        i++;
        continue;
      }

      if (ch === ')') {
        depth--;
        if (depth === 0 && start !== -1) {
          tuples.push(block.substring(start, i));
          start = -1;
        }
        i++;
        continue;
      }

      i++;
    }

    return tuples;
  }

  // ── Fetch and Parse ──────────────────────────────────────────────────

  /**
   * Fetch /map.sql from a Travian server and parse it.
   *
   * @param {string} serverUrl - Base server URL, e.g. "https://ts5.x1.asia.travian.com"
   * @returns {Promise<Array<Object>>} Parsed tile objects
   */
  function fetchAndParse(serverUrl) {
    // Normalize: remove trailing slash
    var baseUrl = serverUrl.replace(/\/+$/, '');
    var mapUrl = baseUrl + '/map.sql';

    Logger.log('INFO', '[MapScanner] Fetching map data from ' + mapUrl);

    return fetch(mapUrl)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status + ' fetching map.sql');
        }
        return response.text();
      })
      .then(function (sqlText) {
        Logger.log('INFO', '[MapScanner] Downloaded ' + Math.round(sqlText.length / 1024) + ' KB of SQL data');
        return parseSql(sqlText);
      })
      .catch(function (err) {
        Logger.log('ERROR', '[MapScanner] Failed to fetch/parse map.sql: ' + err.message);
        throw err;
      });
  }

  // ── Target Scanner ───────────────────────────────────────────────────

  /**
   * Scan a Travian server's map for potential farm targets.
   *
   * Fetches map.sql, parses it, then filters and ranks targets by distance.
   *
   * @param {string} serverUrl - Base server URL
   * @param {Object} options - Scan options
   * @param {number} options.myX - Player's X coordinate (required)
   * @param {number} options.myY - Player's Y coordinate (required)
   * @param {number} [options.myUserId] - Player's userId to exclude own villages
   * @param {number} [options.scanRadius=10] - Max distance to scan
   * @param {number} [options.maxPop=50] - Max population for targets
   * @param {boolean} [options.includeOases=true] - Include unoccupied oases
   * @param {boolean} [options.skipAlliance=true] - Skip villages with alliances
   * @param {Array<{x:number,y:number}>} [options.existingCoords] - Coords already in farm list
   * @returns {Promise<Array<Object>>} Sorted farm targets (closest first)
   */
  function scanForTargets(serverUrl, options) {
    if (options == null || options.myX == null || options.myY == null) {
      return Promise.reject(new Error('[MapScanner] myX and myY coordinates are required'));
    }

    var myX = options.myX;
    var myY = options.myY;
    var myUserId = options.myUserId || 0;
    var scanRadius = options.scanRadius != null ? options.scanRadius : 10;
    var maxPop = options.maxPop != null ? options.maxPop : 50;
    var includeOases = options.includeOases != null ? options.includeOases : true;
    var skipAlliance = options.skipAlliance != null ? options.skipAlliance : true;

    // Build O(1) lookup set for existing coordinates
    var existingSet = {};
    if (options.existingCoords && options.existingCoords.length > 0) {
      for (var i = 0; i < options.existingCoords.length; i++) {
        var coord = options.existingCoords[i];
        existingSet[coord.x + '|' + coord.y] = true;
      }
    }

    Logger.log('INFO', '[MapScanner] Starting scan — center=(' + myX + ',' + myY +
      '), radius=' + scanRadius + ', maxPop=' + maxPop);

    return fetchAndParse(serverUrl).then(function (tiles) {
      var targets = [];

      for (var i = 0; i < tiles.length; i++) {
        var tile = tiles[i];

        // Skip own villages
        if (myUserId && tile.userId === myUserId) {
          continue;
        }

        // Skip Natar (tribe 5) — they always defend
        if (tile.tribe === 5) {
          continue;
        }

        // Calculate distance — early exit if out of range
        var dist = distance(myX, myY, tile.x, tile.y);
        if (dist > scanRadius) {
          continue;
        }

        // Skip tiles already in farm list (O(1) lookup)
        if (existingSet[tile.x + '|' + tile.y]) {
          continue;
        }

        // Determine tile type
        var isOasis = tile.tribe === 4 && tile.population === 0;
        var isVillage = tile.population > 0;

        // Oasis handling
        if (isOasis) {
          if (!includeOases) {
            continue;
          }
          // Unoccupied oasis — include as target
          targets.push({
            x: tile.x,
            y: tile.y,
            villageName: tile.villageName || 'Oasis',
            playerName: '',
            population: 0,
            distance: Math.round(dist * 100) / 100,
            tribe: tile.tribe,
            allianceId: tile.allianceId,
            allianceName: tile.allianceName,
            type: 'oasis'
          });
          continue;
        }

        // Must be a village (population > 0) to be a farm target
        if (!isVillage) {
          continue;
        }

        // Population filter
        if (tile.population > maxPop) {
          continue;
        }

        // Alliance filter — villages with alliances are likely active/defended
        if (skipAlliance && tile.allianceId > 0) {
          continue;
        }

        targets.push({
          x: tile.x,
          y: tile.y,
          villageName: tile.villageName,
          playerName: tile.playerName,
          population: tile.population,
          distance: Math.round(dist * 100) / 100,
          tribe: tile.tribe,
          allianceId: tile.allianceId,
          allianceName: tile.allianceName,
          type: 'village'
        });
      }

      // Sort by distance (closest first)
      targets.sort(function (a, b) {
        return a.distance - b.distance;
      });

      Logger.log('INFO', '[MapScanner] Found ' + targets.length + ' farm targets within radius ' + scanRadius);

      return targets;
    });
  }

  // ── Export ────────────────────────────────────────────────────────────

  var MapScanner = {
    parseSql: parseSql,
    fetchAndParse: fetchAndParse,
    scanForTargets: scanForTargets,
    distance: distance
  };

  if (typeof self !== 'undefined') self.TravianMapScanner = MapScanner;
  if (typeof window !== 'undefined') window.TravianMapScanner = MapScanner;
})();
