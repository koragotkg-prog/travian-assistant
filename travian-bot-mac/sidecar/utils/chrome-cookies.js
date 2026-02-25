'use strict';
/**
 * Chrome cookie importer for macOS.
 *
 * Chrome stores cookies in an SQLite3 DB at:
 *   ~/Library/Application Support/Google/Chrome/Default/Cookies
 *
 * Cookie values are AES-128-CBC encrypted using a key derived from
 * the macOS Keychain entry "Chrome Safe Storage":
 *   key = PBKDF2(keychain_password, 'saltysalt', 1003 iterations, 16 bytes, sha1)
 *   iv  = Buffer.alloc(16, 0x20)   (16 space characters)
 *   encrypted_value starts with 3-byte 'v10' prefix (skip before decrypting)
 *
 * Uses only Node.js built-ins + macOS system binaries (no npm deps needed).
 * Uses execFileSync (not execSync) to avoid shell injection.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────

const CHROME_COOKIES_PATHS = [
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Default/Cookies'),
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome/Profile 1/Cookies'),
  path.join(os.homedir(), 'Library/Application Support/Chromium/Default/Cookies'),
];

const PBKDF2_SALT       = 'saltysalt';
const PBKDF2_ITERATIONS = 1003;
const PBKDF2_KEY_LEN    = 16;
const PBKDF2_DIGEST     = 'sha1';

const AES_IV = Buffer.alloc(16, 0x20); // 16 space characters

// Chrome timestamps: microseconds since 1601-01-01; Unix epoch offset = 11644473600 s
const CHROME_EPOCH_OFFSET_SEC = 11644473600n;

// ── Keychain + key derivation ─────────────────────────────────────────

function getKeychainPassword() {
  // execFileSync — no shell, args passed directly, safe from injection
  const out = execFileSync(
    'security',
    ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return out.trim();
}

function deriveAesKey(password) {
  return crypto.pbkdf2Sync(
    password, PBKDF2_SALT, PBKDF2_ITERATIONS, PBKDF2_KEY_LEN, PBKDF2_DIGEST
  );
}

// ── Decryption ────────────────────────────────────────────────────────

function decryptCookieValue(encryptedBuf, key) {
  if (!encryptedBuf || encryptedBuf.length === 0) return '';

  const prefix = encryptedBuf.slice(0, 3).toString('latin1');
  if (prefix === 'v10') {
    // AES-128-CBC: skip 3-byte 'v10' prefix
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, AES_IV);
      return Buffer.concat([decipher.update(encryptedBuf.slice(3)), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  // Unencrypted legacy value
  return encryptedBuf.toString('utf8');
}

// ── SQLite query ──────────────────────────────────────────────────────

function findCookiesDb() {
  for (const p of CHROME_COOKIES_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    'Chrome Cookies DB not found. Open Chrome at least once so the profile is created.'
  );
}

function queryCookies(cookiesPath, hostLike) {
  const tmpPath = path.join(os.tmpdir(), `chrome_cookies_${process.pid}_${Date.now()}.db`);

  try {
    // Copy to avoid SQLite WAL lock while Chrome is open
    fs.copyFileSync(cookiesPath, tmpPath);
    for (const ext of ['-wal', '-shm']) {
      try { fs.copyFileSync(cookiesPath + ext, tmpPath + ext); } catch {}
    }

    // Use hex() on the BLOB column so binary data survives pipe output safely
    // hostLike is internal (not user-supplied), but we double-single-quote just in case
    const safePattern = hostLike.replace(/'/g, "''");
    const sql =
      `SELECT host_key,name,hex(encrypted_value),value,path,expires_utc,is_secure,is_httponly ` +
      `FROM cookies WHERE host_key LIKE '${safePattern}' ORDER BY host_key,name;`;

    // execFileSync with array args — sqlite3 receives path and SQL directly, no shell
    const output = execFileSync('sqlite3', [tmpPath, sql], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const parts = line.split('|');
        return {
          hostKey:    parts[0] || '',
          name:       parts[1] || '',
          encHex:     parts[2] || '',
          rawValue:   parts[3] || '',
          cookiePath: parts[4] || '/',
          expiresUtc: parts[5] || '0',
          isSecure:   parts[6] || '0',
          isHttpOnly: parts[7] || '0',
        };
      });
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpPath + ext); } catch {}
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Import Travian-related cookies from Chrome.
 *
 * @param {object} [opts]
 * @param {string} [opts.hostLike='%travian%']  SQL LIKE pattern for host_key filtering
 * @returns {Promise<Array>}  Puppeteer-compatible cookie objects
 */
async function importChromeCookies({ hostLike = '%travian%' } = {}) {
  // 1. Derive AES key from macOS Keychain
  let key;
  try {
    key = deriveAesKey(getKeychainPassword());
  } catch (e) {
    throw new Error(
      `Keychain read failed: ${e.message}. ` +
      'Ensure Chrome has been opened at least once and you allow access when prompted.'
    );
  }

  // 2. Query cookies DB
  const cookiesPath = findCookiesDb();
  const rows = queryCookies(cookiesPath, hostLike);

  // 3. Decrypt + convert to Puppeteer format
  const cookies = [];
  for (const { hostKey, name, encHex, rawValue, cookiePath, expiresUtc, isSecure, isHttpOnly } of rows) {
    if (!name) continue;

    let value = rawValue || '';
    if (encHex) {
      const decrypted = decryptCookieValue(Buffer.from(encHex, 'hex'), key);
      if (decrypted) value = decrypted;
    }

    let expires;
    if (expiresUtc && expiresUtc !== '0') {
      try {
        const unixSecs = Number(BigInt(expiresUtc) / 1000000n - CHROME_EPOCH_OFFSET_SEC);
        if (unixSecs > 0) expires = unixSecs;
      } catch {}
    }

    cookies.push({
      name,
      value,
      domain: hostKey.startsWith('.') ? hostKey.slice(1) : hostKey,
      path: cookiePath || '/',
      secure: isSecure === '1',
      httpOnly: isHttpOnly === '1',
      ...(expires !== undefined ? { expires } : {}),
    });
  }

  return cookies;
}

module.exports = { importChromeCookies };
