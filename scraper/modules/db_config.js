'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/**
 * Single source of truth for MySQL connection config.
 *
 * WHY THIS MODULE EXISTS (2026-08-12, external review)
 * ------------------------------------------------------
 * A production incident: `erp_user`'s MySQL password was rotated on the VPS
 * and `scraper/.env` was never updated. `server.js` kept running anyway —
 * its pooled connections were opened BEFORE the rotation and stayed alive
 * (a 30-second cron kept them busy, so `wait_timeout` never reaped them) —
 * so `/api/health` (which never touches MySQL) reported healthy the whole
 * time. Every FRESH connection — any CLI script, any future restart — was
 * silently broken. This module exists so "is the DB actually reachable
 * right now, with a real connection, not an old one" is one function call
 * (`checkConnection()`), not something re-derived per script, and so every
 * script resolves the SAME host/user/password/database the SAME way instead
 * of the ~57 places in this codebase that each redefine
 * `{ host: process.env.DB_HOST || 'localhost', ... }` independently.
 *
 * NOTE: unlike every other file under `modules/` (which receive `pool` as a
 * parameter and never construct one themselves), this module IS the source
 * of the pool/connection, not a consumer of it — that's deliberate, not an
 * inconsistency with the rest of `modules/`.
 *
 * MIGRATION SCOPE (deliberately partial, see DB_ROTATION.md)
 * ------------------------------------------------------------
 * Every one of the ~57 files that builds its own `DB` object resolves
 * `user: process.env.DB_USER || 'erp_user'` — i.e. the env var already wins
 * over the fallback everywhere. That means a credential ROTATION was never
 * actually blocked by code duplication: editing `.env` once already
 * propagates to all of them. Only `server.js` is migrated to this module in
 * the initial pass (the production-critical path, and the one that gets the
 * explicit preflight + `/api/health/db`), plus the two scripts that
 * bypassed env entirely (`dbcheck.js`, `check-db.sh` — hardcoded
 * `user: 'erp_user'`, which would have kept silently authenticating as a
 * stale/wrong account once the dedicated `flowtracker_app` user exists).
 * Backfilling the rest is a mechanical, low-priority follow-up — NEW
 * top-level scripts should `require('./modules/db_config')` rather than
 * hand-roll the DB object.
 */

const DEFAULT_POOL_OPTIONS = {
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

// Classes of mysql2 error codes worth distinguishing in a preflight/health
// result — "wrong credential" vs "can't reach the server" vs "something
// else" have different fixes and shouldn't be lumped into one generic
// failure message.
const AUTH_ERROR_CODES = new Set(['ER_ACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR']);
const UNREACHABLE_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'PROTOCOL_CONNECTION_LOST']);

function classifyError(err) {
  const code = err && err.code;
  if (AUTH_ERROR_CODES.has(code)) return 'DB_AUTH_FAILED';
  if (UNREACHABLE_ERROR_CODES.has(code)) return 'DB_UNREACHABLE';
  return 'DB_UNKNOWN_ERROR';
}

/**
 * Connecting to 'localhost' can trigger Node's dual-stack (IPv6+IPv4)
 * happy-eyeballs resolution, and when BOTH attempts fail (e.g. nothing is
 * listening at all) Node throws an `AggregateError` whose own `.message` is
 * an empty string by design — the real per-attempt errors live in
 * `.errors[]`. Without this, a genuine connection-refused would log as
 * "FAIL — DB_UNREACHABLE: " with nothing after the colon.
 */
function describeError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length) {
    return err.errors.map(e => e.message).filter(Boolean).join('; ') || err.code || String(err);
  }
  return err.message || err.code || String(err);
}

/**
 * Which commit/version produced this PASS/FAIL — reuses the repo's own
 * existing `.deployed-commit` stamp (predeploy_check.sh's freshness marker)
 * rather than inventing a second version concept. Falls back to
 * package.json's version, then 'unknown'. Read fresh every call (cheap,
 * small file) so it reflects the currently-deployed commit even if this
 * process has been running a while.
 */
function resolveVersion() {
  try {
    const stamped = fs.readFileSync(path.join(__dirname, '..', '.deployed-commit'), 'utf8').trim();
    if (stamped) return stamped;
  } catch {}
  try {
    return require('../package.json').version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Full config INCLUDING the password — internal use only, never returned
 * to a caller that might log or display it. */
function resolveDbConfig() {
  const usedDefaults = [];
  if (!process.env.DB_HOST) usedDefaults.push('host');
  if (!process.env.DB_USER) usedDefaults.push('user');
  if (!process.env.DB_NAME) usedDefaults.push('database');

  return {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'erp_user',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'erp_manufacturing',
    usedDefaults,
  };
}

/** Config + pool-tuning defaults, overridable per caller. Still has the
 * password — for building a pool/connection, not for logging. */
function getPoolConfig(overrides = {}) {
  const { usedDefaults, ...cfg } = resolveDbConfig();
  return { ...DEFAULT_POOL_OPTIONS, ...cfg, ...overrides };
}

function createPool(overrides = {}) {
  return mysql.createPool(getPoolConfig(overrides));
}

function configSource() {
  // dotenv populates process.env from `.env` at require-time in every
  // caller (`require('dotenv').config()` runs before this module is used);
  // by the time resolveDbConfig() runs we can only tell whether the values
  // came from SOME env source, not specifically a .env file vs. the shell.
  // Good enough for a log line's "where did this come from" context.
  return process.env.DB_PASSWORD !== undefined ? 'environment (.env or shell)' : 'defaults only — DB_PASSWORD not set';
}

/** Never includes the password. Safe to log, return in an API response, or
 * print to a deploy console. */
function safeConfigInfo() {
  const { host, user, database, usedDefaults } = resolveDbConfig();
  return { host, user, database, configSource: configSource(), usedDefaults, version: resolveVersion() };
}

/**
 * Opens a genuinely FRESH connection (never the pool — a pool can report
 * "healthy" purely because an old connection opened before a rotation is
 * still warm, which is exactly the incident this module exists to prevent),
 * runs SELECT 1, closes it. Bounded connectTimeout so a network black hole
 * fails fast instead of hanging a deploy script.
 *
 * @returns {Promise<{ok:boolean, host, user, database, configSource, usedDefaults, version,
 *   durationMs:number, errorCode:null|'DB_AUTH_FAILED'|'DB_UNREACHABLE'|'DB_UNKNOWN_ERROR', errorMessage:null|string}>}
 */
async function checkConnection({ connectTimeout = 5000 } = {}) {
  const info = safeConfigInfo();
  const cfg = resolveDbConfig();
  const start = Date.now();
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: cfg.host, user: cfg.user, password: cfg.password, database: cfg.database, connectTimeout,
    });
    await conn.query('SELECT 1');
    return { ok: true, ...info, durationMs: Date.now() - start, errorCode: null, errorMessage: null };
  } catch (err) {
    return {
      ok: false, ...info, durationMs: Date.now() - start,
      errorCode: classifyError(err), errorMessage: describeError(err),
    };
  } finally {
    if (conn) { try { await conn.end(); } catch {} }
  }
}

module.exports = { getPoolConfig, createPool, safeConfigInfo, checkConnection };
