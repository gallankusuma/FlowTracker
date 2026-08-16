/**
 * Operator session — the server-side authorization boundary for the Admin slice.
 *
 * FT-P0-01A. The queue is explicit about what this may NOT be: no public Next.js
 * proxy injecting the static key, no `NEXT_PUBLIC_ADMIN_KEY`, no anonymous server
 * proxy. The browser must never hold `ADMIN_API_KEY` in a place page JavaScript
 * can read.
 *
 * WHY THIS IS WRITTEN RATHER THAN REUSED. The dispatch says to reuse a sound
 * existing session facility if one exists. There is none: the scraper's whole
 * dependency set is cors, dotenv, express, mysql2, puppeteer — no
 * express-session, cookie-parser, jsonwebtoken or csurf. Adding a dependency to
 * a production service for one Admin panel is a larger change than the ~120
 * lines below, so cookies are parsed by hand and the session store is a Map.
 *
 * TWO ADMISSION PATHS, AND THEY DIFFER ON PURPOSE
 * ----------------------------------------------
 *   BROWSER  — `ft_op` session cookie, httpOnly. Page scripts cannot read it,
 *              so an XSS on any FlowTracker page cannot exfiltrate the
 *              credential. Because the cookie is AMBIENT (the browser attaches
 *              it automatically), this path MUST prove intent on every
 *              mutation, hence CSRF below.
 *   MACHINE  — `x-admin-key` header, unchanged. A header is not ambient: no
 *              browser attaches it on a cross-site form post, so a CSRF token
 *              would protect nothing here. Requiring one would only break the
 *              cron and CLI callers that already use this path correctly.
 *
 * Conflating the two — demanding CSRF from a header credential, or accepting a
 * cookie without it — is the usual way this control is got wrong.
 *
 * CSRF: DOUBLE SUBMIT. `ft_csrf` is deliberately NOT httpOnly, because the
 * client has to read it to echo it back in `X-CSRF-Token`. That is safe: the
 * token is worthless without the httpOnly session cookie, and an attacker's
 * page cannot read our cookie to copy it. `SameSite=Strict` already stops most
 * of this class; the token is the belt to that pair of braces, and the review
 * asked for it explicitly.
 *
 * SESSIONS LIVE IN MEMORY. A restart logs the operator out. That is acceptable
 * for a single-operator panel and avoids inventing a schema; it is recorded here
 * so nobody later mistakes it for durability. Audit records, which DO need to
 * survive, go to the database instead.
 */
'use strict';

const crypto = require('crypto');

const COOKIE_SESSION = 'ft_op';
const COOKIE_CSRF = 'ft_csrf';
const HEADER_CSRF = 'x-csrf-token';
const HEADER_KEY = 'x-admin-key';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // one working day
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** sid -> { actor, csrf, createdAt, expiresAt, ip } */
const sessions = new Map();

// ── Brute-force protection for the public login (correction 1) ───────────────
// This slice INTRODUCED a public endpoint that accepts a static key, so making
// it expensive to guess belongs to this slice rather than to a later hardening
// pass. Bounded, in-memory, keyed by client identity.
//
// Counting FAILURES only, and clearing on success, means a working operator is
// never locked out by their own activity — the limiter exists to slow guessing,
// not to punish use.
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginFailures = new Map();   // id -> { count, first, lockedUntil }

function loginState(id, at = Date.now()) {
  const e = loginFailures.get(id);
  if (!e) return { locked: false, remaining: LOGIN_MAX_FAILURES, retryAfterMs: 0 };
  if (e.lockedUntil && e.lockedUntil > at) {
    return { locked: true, remaining: 0, retryAfterMs: e.lockedUntil - at };
  }
  if (at - e.first > LOGIN_WINDOW_MS) {           // window rolled over
    loginFailures.delete(id);
    return { locked: false, remaining: LOGIN_MAX_FAILURES, retryAfterMs: 0 };
  }
  return { locked: false, remaining: Math.max(0, LOGIN_MAX_FAILURES - e.count), retryAfterMs: 0 };
}

function recordLoginFailure(id, at = Date.now()) {
  const e = loginFailures.get(id);
  if (!e || at - e.first > LOGIN_WINDOW_MS) {
    loginFailures.set(id, { count: 1, first: at, lockedUntil: 0 });
    return loginState(id, at);
  }
  e.count += 1;
  if (e.count >= LOGIN_MAX_FAILURES) e.lockedUntil = at + LOGIN_LOCKOUT_MS;
  loginFailures.set(id, e);
  return loginState(id, at);
}

function clearLoginFailures(id) { loginFailures.delete(id); }

function now() { return Date.now(); }
function token(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }

/** Constant-time string compare that cannot throw on length mismatch. */
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length || A.length === 0) return false;
  return crypto.timingSafeEqual(A, B);
}

/**
 * Minimal cookie parser — avoids pulling in cookie-parser for two cookies.
 *
 * decodeURIComponent THROWS on malformed percent-encoding (`%ZZ`, a lone `%`),
 * and the Cookie header is entirely attacker-controlled. An uncaught throw here
 * would turn a hostile request into a 500 from inside the authorization
 * middleware — a crash on the security boundary, reachable anonymously. The
 * first version of this function had exactly that hole, and the test that was
 * supposed to cover it used `%20`, which is VALID encoding, so it proved
 * tolerance of malformed structure while leaving malformed encoding untested.
 *
 * A value that cannot be decoded is kept raw rather than dropped: it will simply
 * fail to match a session id or CSRF token, so the request is refused by the
 * normal 401/403 path instead of by an exception.
 */
function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

function sweep() {
  const t = now();
  for (const [sid, s] of sessions) if (s.expiresAt <= t) sessions.delete(sid);
}

/**
 * ACTOR IDENTITY IS SERVER-DERIVED (correction 2).
 *
 * `operator` is a ROLE, not an identity — every session carried the same string,
 * so the audit trail could say what was done but never by which credential. The
 * actor is now derived from server-controlled configuration only: a label from
 * `OPERATOR_IDENTITY` when set, otherwise a stable fingerprint of the configured
 * key. Never from request input, which the caller controls and could therefore
 * forge into someone else's name.
 *
 * The fingerprint is a truncated SHA-256 of the key, so it identifies WHICH
 * credential was used without being reversible to the key itself. When the key
 * is rotated the actor changes, which is the correct behaviour: it is a
 * different credential.
 */
function serverActorIdentity() {
  const label = (process.env.OPERATOR_IDENTITY || '').trim();
  if (label) return `operator:${label.slice(0, 40)}`;
  const key = process.env.ADMIN_API_KEY || '';
  if (!key) return 'operator:unconfigured';
  const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 10);
  return `operator:key-${fp}`;
}

function createSession({ ip } = {}) {
  sweep();
  const sid = token();
  const csrf = token(24);
  const actor = serverActorIdentity();          // never taken from the caller
  const s = { actor, csrf, createdAt: now(), expiresAt: now() + SESSION_TTL_MS, ip: ip || null };
  sessions.set(sid, s);
  return { sid, csrf, expiresAt: s.expiresAt, actor };
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt <= now()) { sessions.delete(sid); return null; }
  return s;
}

function destroySession(sid) { return sessions.delete(sid); }

/**
 * CLIENT IDENTITY AND TRANSPORT, WITHOUT TRUSTING THE CALLER (correction 3).
 *
 * `x-forwarded-for` and `x-forwarded-proto` are set by anyone who can reach the
 * port. Reading them unconditionally let an attacker write whatever IP they
 * liked into the audit trail and claim HTTPS on a plaintext connection — which
 * would have set `Secure` on a cookie that then never gets sent back.
 *
 * They are honoured ONLY when Express is configured to trust a proxy
 * (`app.set('trust proxy', …)`, surfaced as `req.app.get('trust proxy')`), which
 * is a deployment statement the operator makes deliberately. Otherwise the
 * direct socket wins — it cannot be forged by a header.
 */
function proxyIsTrusted(req) {
  try { return Boolean(req && req.app && req.app.get && req.app.get('trust proxy')); }
  catch { return false; }
}

function clientIp(req) {
  if (!req) return null;
  if (proxyIsTrusted(req)) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket && req.socket.remoteAddress) || null;
}

function requestIsSecure(req) {
  if (!req) return false;
  if (req.socket && req.socket.encrypted) return true;      // real TLS, unforgeable
  if (proxyIsTrusted(req)) {
    if (req.secure) return true;
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return false;
}

/** Cookie attributes. Secure is set only when the request actually arrived over TLS. */
function cookieHeaders({ sid, csrf, expiresAt }, req) {
  const secure = requestIsSecure(req);
  const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
  const base = `Path=/; SameSite=Strict; Max-Age=${maxAge}` + (secure ? '; Secure' : '');
  return [
    `${COOKIE_SESSION}=${sid}; HttpOnly; ${base}`,
    `${COOKIE_CSRF}=${csrf}; ${base}`,     // readable by the client ON PURPOSE
  ];
}

function clearCookieHeaders() {
  return [
    `${COOKIE_SESSION}=; Path=/; SameSite=Strict; Max-Age=0; HttpOnly`,
    `${COOKIE_CSRF}=; Path=/; SameSite=Strict; Max-Age=0`,
  ];
}

/**
 * Decide admission for a request without touching res — kept pure so the tests
 * can drive it directly with plain objects rather than a live server.
 *
 * @returns {{ok:true, actor:string, via:'session'|'admin-key'} |
 *           {ok:false, status:number, reason:string}}
 */
function authorize(req) {
  const method = String(req.method || 'GET').toUpperCase();

  // MACHINE PATH — header credential, not ambient, so no CSRF token required.
  const provided = req.headers && req.headers[HEADER_KEY];
  if (provided) {
    if (!process.env.ADMIN_API_KEY) {
      return { ok: false, status: 503, reason: 'ADMIN_API_KEY not configured on server' };
    }
    if (!safeEqual(provided, process.env.ADMIN_API_KEY)) {
      return { ok: false, status: 401, reason: 'invalid admin key' };
    }
    return { ok: true, actor: 'machine:admin-key', via: 'admin-key' };
  }

  // BROWSER PATH — ambient cookie, so intent must be proven on every mutation.
  const cookies = parseCookies(req);
  const s = getSession(cookies[COOKIE_SESSION]);
  if (!s) return { ok: false, status: 401, reason: 'no valid operator session' };

  if (MUTATING.has(method)) {
    const sent = req.headers && req.headers[HEADER_CSRF];
    if (!sent) return { ok: false, status: 403, reason: 'missing CSRF token' };
    // Compared against the SESSION's token, not against the cookie: a cookie the
    // attacker can set is not evidence of anything, and checking cookie-vs-header
    // alone would pass for anyone able to write both.
    if (!safeEqual(sent, s.csrf)) return { ok: false, status: 403, reason: 'CSRF token mismatch' };
  }
  return { ok: true, actor: s.actor, via: 'session' };
}

/**
 * THE AUDIT POLICY, stated because the dispatch asked for it to be defined
 * rather than assumed.
 *
 * The first version was fire-and-forget AND stamped every admitted request as
 * HTTP 200 `ALLOWED` before the handler had run. Both are wrong: the status was
 * a guess, not an outcome, so a handler that 500'd or refused was recorded as a
 * success; and a failed audit write left no trace of a state change.
 *
 * Now:
 *
 *   MUTATIONS FAIL CLOSED. The attempt is written BEFORE the handler runs, and
 *   if that write fails the request is refused with 503. A state change that
 *   cannot be attributed must not happen — that is the whole purpose of an audit
 *   trail, and "the database was busy" is not a reason to lose accountability.
 *
 *   READS ARE BEST EFFORT, LOUDLY. A GET leaves nothing to attribute, so
 *   refusing it protects nobody while making the panel unusable on a transient
 *   database hiccup. The write is still attempted and a failure is logged at
 *   error level.
 *
 *   DENIALS ARE NEVER UPGRADED. A refused request is recorded best-effort too: a
 *   401 must never become a 503 because the audit table was unavailable, or an
 *   attacker could probe the audit path to change the answer they get.
 *
 * The real response status replaces the placeholder on `res.finish`.
 */
async function recordAttempt(pool, entry) {
  // A MISSING POOL IS A FAILURE, NOT A PASS. The first version returned null
  // here, which the middleware read as "nothing to do" and let the mutation
  // through — so the one configuration where auditing is completely absent was
  // also the one configuration that skipped the fail-closed check entirely.
  if (!pool) throw new Error('audit pool unavailable');
  const [r] = await pool.query(
    `INSERT INTO ft_operator_audit
       (actor, via, method, route, target, outcome, status_code, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?, NOW())`,
    [entry.actor, entry.via, entry.method, entry.route,
     entry.target || null, entry.outcome, entry.statusCode, entry.ip || null]
  );
  return r && r.insertId ? r.insertId : null;
}

/** Best-effort variant for reads and denials — never throws at the caller. */
async function recordAudit(pool, entry) {
  if (!pool) return null;
  try { return await recordAttempt(pool, entry); }
  catch (e) {
    console.error('[audit] FAILED to record operator action:', e.message, JSON.stringify(entry));
    return null;
  }
}

/**
 * Stamp the real outcome once the response is actually finished.
 *
 * A row that never gets finalized stays `ATTEMPTED` with status 0. That is
 * deliberate and is the reconcilable state the review asked for: it means "this
 * mutation was admitted and we never learned how it ended", which is a different
 * and more alarming fact than "it failed". `findUnfinalized()` below makes those
 * rows observable so they can be reconciled rather than sitting unnoticed.
 */
async function finalizeAudit(pool, id, statusCode) {
  if (!pool || !id) return false;
  const outcome = statusCode >= 200 && statusCode < 400 ? 'ALLOWED' : 'FAILED';
  try {
    await pool.query(
      'UPDATE ft_operator_audit SET status_code = ?, outcome = ? WHERE id = ?',
      [statusCode, outcome, id]
    );
    return true;
  } catch (e) {
    // Loud, and reported to the caller — a silent false here is how an
    // unfinalized row would become invisible.
    console.error('[audit] UNFINALIZED audit row', id, '— reconcile required:', e.message);
    return false;
  }
}

/**
 * Admitted mutations whose outcome was never recorded. Exposed so the gap is
 * observable and retryable instead of being a hole nobody can see.
 */
async function findUnfinalized(pool, { olderThanMinutes = 5, limit = 100 } = {}) {
  if (!pool) return [];
  const [rows] = await pool.query(
    `SELECT id, actor, via, method, route, target, created_at
       FROM ft_operator_audit
      WHERE outcome = 'ATTEMPTED' AND status_code = 0
        AND created_at < (NOW() - INTERVAL ? MINUTE)
      ORDER BY id DESC LIMIT ?`,
    [olderThanMinutes, limit]
  );
  return rows;
}

async function ensureAuditTable(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_operator_audit (
      id          BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor       VARCHAR(64)  NOT NULL,
      via         VARCHAR(16)  NOT NULL,
      method      VARCHAR(8)   NOT NULL,
      route       VARCHAR(160) NOT NULL,
      target      VARCHAR(120) NULL,
      outcome     VARCHAR(16)  NOT NULL,
      status_code SMALLINT     NOT NULL,
      ip          VARCHAR(64)  NULL,
      created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      KEY idx_audit_created (created_at),
      KEY idx_audit_actor (actor)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

/**
 * Express middleware factory. Every decision — allowed or refused — is audited,
 * because a refusal is exactly the event worth having a record of.
 */
function requireOperator(pool) {
  return async function (req, res, next) {
    let verdict;
    // authorize() reads attacker-controlled headers. If it ever throws, the
    // boundary must refuse rather than hand a 500 to an anonymous caller.
    try { verdict = authorize(req); }
    catch (e) {
      console.error('[operator] authorize threw:', e.message);
      verdict = { ok: false, status: 401, reason: 'malformed credentials' };
    }

    const ip = clientIp(req);
    const method = String(req.method || '').toUpperCase();
    const entry = {
      actor: verdict.ok ? verdict.actor : 'anonymous',
      via: verdict.ok ? verdict.via : 'none',
      method,
      route: req.baseUrl ? req.baseUrl + req.path : (req.originalUrl || req.path || '').split('?')[0],
      target: req.params ? Object.values(req.params).join('/') || null : null,
      outcome: verdict.ok ? 'ATTEMPTED' : 'DENIED',
      statusCode: verdict.ok ? 0 : verdict.status,   // 0 = not yet known
      ip,
    };

    if (!verdict.ok) {
      // Best effort: a refusal must stay a refusal even if the audit table is down.
      recordAudit(pool, entry).catch(() => {});
      return res.status(verdict.status).json({ error: verdict.reason });
    }

    let auditId = null;
    if (MUTATING.has(method)) {
      try {
        auditId = await recordAttempt(pool, entry);
      } catch (e) {
        console.error('[audit] refusing mutation — attempt could not be recorded:', e.message);
        return res.status(503).json({ error: 'audit unavailable; mutation refused' });
      }
    } else {
      auditId = await recordAudit(pool, entry);
    }

    // The real status, not a guess made before the handler ran.
    res.on('finish', () => { finalizeAudit(pool, auditId, res.statusCode).catch(() => {}); });

    req.operator = { actor: verdict.actor, via: verdict.via, auditId };
    next();
  };
}

module.exports = {
  COOKIE_SESSION, COOKIE_CSRF, HEADER_CSRF, HEADER_KEY, SESSION_TTL_MS,
  createSession, getSession, destroySession, authorize, requireOperator,
  cookieHeaders, clearCookieHeaders, parseCookies, safeEqual,
  ensureAuditTable, recordAudit, recordAttempt, finalizeAudit, findUnfinalized,
  serverActorIdentity, clientIp, requestIsSecure, proxyIsTrusted,
  loginState, recordLoginFailure, clearLoginFailures,
  LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS,
  _sessions: sessions, _loginFailures: loginFailures,
};
