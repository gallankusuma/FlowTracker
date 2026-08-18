'use strict';
/**
 * Required-input check for the research harness.
 *
 * WHY THIS EXISTS. `db41f20` moved these scripts off cwd-relative dotenv
 * discovery onto an explicit `../.env`, which was the right resolution rule and
 * still left the actual defect in place: **the return of `dotenv.config()` was
 * ignored**. When the file is absent — as it is on any checkout that has not
 * been given credentials — nothing complained, `db_config` fell back to its
 * defaults, and the connection was attempted as the old shared `erp_user` with
 * no password. The operator then sees
 *
 *     Access denied for user 'erp_user'@'localhost' (using password: NO)
 *
 * which describes a credential that was never meant to be used, for a question
 * nobody asked. The real fact — "the env file you named is not there" — was
 * never stated. Fixing the path without checking the read swapped one silent
 * fallback for a quieter one.
 *
 * So: verify the named input exists and was parsed BEFORE any pool is built,
 * and say which file and why it matters.
 */
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Load the scraper's .env or fail loudly. Returns the resolved path.
 * @param {{optional?: boolean}} [opts] optional:true reports and returns null
 *        instead of throwing — for callers that have an offline mode.
 */
function loadEnv(opts) {
  const optional = !!(opts && opts.optional);
  if (!fs.existsSync(ENV_PATH)) {
    const msg =
      'required environment file not found: ' + ENV_PATH + '\n' +
      '  The research harness reads database credentials from the scraper .env.\n' +
      '  Without it modules/db_config falls back to host=localhost user=erp_user\n' +
      '  with no password, and the failure appears as "Access denied" rather than\n' +
      '  as the missing file it actually is.';
    if (optional) { console.error('ENV MISSING\n' + msg); return null; }
    throw new Error(msg);
  }
  const res = require('dotenv').config({ path: ENV_PATH });
  if (res.error) {
    const msg = 'could not read ' + ENV_PATH + ': ' + describeError(res.error);
    if (optional) { console.error('ENV UNREADABLE\n' + msg); return null; }
    throw new Error(msg);
  }
  return ENV_PATH;
}

/**
 * Render an error without losing the part that says what happened.
 *
 * mysql2 connection failures arrive as an AggregateError whose own `.message`
 * is EMPTY, so `console.error('ERR', e.message)` prints a bare "ERR" — reported
 * by the reviewer, and worse than no handler at all because it looks handled.
 * Walk `errors[]` and `cause`, and fall back to the code or the class name so
 * something identifying always survives.
 */
function describeError(e) {
  if (!e) return 'unknown error (no error object)';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (Array.isArray(e.errors) && e.errors.length) {
    parts.push('[' + e.errors.map(describeError).join(' | ') + ']');
  }
  if (e.cause) parts.push('caused by: ' + describeError(e.cause));
  if (!parts.length) {
    if (e.code) parts.push('code ' + e.code);
    else parts.push(e.constructor ? e.constructor.name : String(e));
  }
  if (e.code && parts.length && !String(parts[0]).includes(e.code)) parts.push('(' + e.code + ')');
  return parts.join(' ');
}

/** Standard fatal handler: full detail, exit 1. */
function fail(e) {
  console.error('ERR ' + describeError(e));
  if (e && e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
}

module.exports = { loadEnv, describeError, fail, ENV_PATH };
