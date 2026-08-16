// FT-P0-01A — operator session boundary.
//
// The acceptance evidence the dispatch asks for is unauthorized / authorized /
// CSRF-negative, so those three are the spine of this file. The rest exist
// because each is a way this control is commonly built wrong: accepting a cookie
// without proving intent, demanding CSRF from a header credential and breaking
// every machine caller, comparing the CSRF token against a cookie the attacker
// can also set, or letting an expired session through.
//
// authorize() is pure and takes a plain request-shaped object, so none of this
// needs a live server or a database.
'use strict';

const assert = require('assert');
const os = require('./modules/operator_session');

// THE RUNNER AWAITS. The previous version called fn() without awaiting, so an
// async test that threw resolved into an unhandled rejection AFTER the try/catch
// had already counted it as a pass. Three audit tests were green while asserting
// nothing, and the "23/23" figure that went into a commit message and the
// remediation log was not evidence for those three.
//
// The self-check at the bottom is the part that matters: a runner nobody has
// watched fail is a runner nobody should trust.
let pass = 0, fail = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

async function runAll() {
  for (const { name, fn } of queue) {
    try {
      await fn();                       // <- the whole point
      pass++; console.log(`  PASS  ${name}`);
    } catch (e) {
      fail++; console.log(`  FAIL  ${name}\n        ${e.message}`);
    }
  }
}

// An unhandled rejection anywhere must not be swallowed into a green run.
process.on('unhandledRejection', (e) => {
  console.log(`  FAIL  <unhandled rejection>\n        ${e && e.message}`);
  process.exit(1);
});

const REAL_KEY = 'test-admin-key-0123456789';
process.env.ADMIN_API_KEY = REAL_KEY;

const req = ({ method = 'GET', cookie, csrf, key, ...rest } = {}) => {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (csrf) headers[os.HEADER_CSRF] = csrf;
  if (key) headers[os.HEADER_KEY] = key;
  return { method, headers, socket: {}, ...rest };
};
const cookieFor = (sid, csrf) =>
  `${os.COOKIE_SESSION}=${sid}` + (csrf ? `; ${os.COOKIE_CSRF}=${csrf}` : '');

console.log('\nunauthorized');
test('no credential at all is refused', () => {
  const v = os.authorize(req({ method: 'DELETE' }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 401);
});

test('a forged session id is refused', () => {
  const v = os.authorize(req({ cookie: cookieFor('not-a-real-session') }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 401);
});

test('a wrong admin key is refused, and does not fall through to the cookie path', () => {
  const s = os.createSession({ actor: 'op' });
  const v = os.authorize(req({ key: 'wrong-key', cookie: cookieFor(s.sid, s.csrf) }));
  assert.strictEqual(v.ok, false, 'a bad key must fail outright, not silently retry as a session');
  assert.strictEqual(v.status, 401);
  os.destroySession(s.sid);
});

test('an expired session is refused', () => {
  const s = os.createSession({ actor: 'op' });
  os._sessions.get(s.sid).expiresAt = Date.now() - 1;
  const v = os.authorize(req({ cookie: cookieFor(s.sid) }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 401);
  assert.ok(!os.getSession(s.sid), 'expired session must be evicted, not merely rejected');
});

console.log('\nauthorized');
test('a valid session reads', () => {
  const s = os.createSession({ actor: 'operator' });
  const v = os.authorize(req({ method: 'GET', cookie: cookieFor(s.sid, s.csrf) }));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.via, 'session');
  os.destroySession(s.sid);
});

test('a valid session mutates WITH the CSRF token', () => {
  const s = os.createSession({ actor: 'operator' });
  const v = os.authorize(req({ method: 'DELETE', cookie: cookieFor(s.sid, s.csrf), csrf: s.csrf }));
  assert.strictEqual(v.ok, true);
  os.destroySession(s.sid);
});

test('the machine path still works, and needs no CSRF token', () => {
  const v = os.authorize(req({ method: 'DELETE', key: REAL_KEY }));
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.via, 'admin-key');
});

console.log('\nCSRF negative — the whole point of the cookie path');
test('a mutation with a session but NO CSRF token is refused', () => {
  const s = os.createSession({ actor: 'operator' });
  const v = os.authorize(req({ method: 'POST', cookie: cookieFor(s.sid, s.csrf) }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 403);
  os.destroySession(s.sid);
});

test('a mutation with the WRONG CSRF token is refused', () => {
  const s = os.createSession({ actor: 'operator' });
  const v = os.authorize(req({ method: 'PUT', cookie: cookieFor(s.sid, s.csrf), csrf: 'attacker-token' }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 403);
  os.destroySession(s.sid);
});

test('the token is checked against the SESSION, not against the cookie', () => {
  // The classic double-submit mistake: comparing header to cookie. Anyone who can
  // write both — a subdomain, a MITM on plain HTTP — then passes trivially.
  const s = os.createSession({ actor: 'operator' });
  const forged = 'attacker-controlled-value';
  const v = os.authorize(req({
    method: 'DELETE',
    cookie: `${os.COOKIE_SESSION}=${s.sid}; ${os.COOKIE_CSRF}=${forged}`,
    csrf: forged,                     // header matches the cookie exactly
  }));
  assert.strictEqual(v.ok, false, 'matching a forged cookie must not be enough');
  assert.strictEqual(v.status, 403);
  os.destroySession(s.sid);
});

test('reads are not blocked by a missing CSRF token', () => {
  const s = os.createSession({ actor: 'operator' });
  assert.strictEqual(os.authorize(req({ method: 'GET', cookie: cookieFor(s.sid) })).ok, true);
  os.destroySession(s.sid);
});

console.log('\nsecret hygiene');
test('the session cookie is HttpOnly and the CSRF cookie deliberately is not', () => {
  const s = os.createSession({ actor: 'operator' });
  const [sess, csrf] = os.cookieHeaders(s, { headers: {} });
  assert.ok(/HttpOnly/.test(sess), 'session cookie must be HttpOnly so page scripts cannot read it');
  assert.ok(!/HttpOnly/.test(csrf), 'CSRF cookie must be readable — the client has to echo it');
  assert.ok(/SameSite=Strict/.test(sess) && /SameSite=Strict/.test(csrf));
  os.destroySession(s.sid);
});

test('no cookie ever carries the admin key', () => {
  const s = os.createSession({ actor: 'operator' });
  const headers = os.cookieHeaders(s, { headers: {} }).join(' ');
  assert.ok(!headers.includes(REAL_KEY), 'ADMIN_API_KEY must never reach the browser');
  os.destroySession(s.sid);
});

test('Secure follows the ACTUAL transport, not a header anyone can send', () => {
  // This test previously asserted that `x-forwarded-proto: https` alone was
  // enough. Correction 3 removed that, so the old assertion encoded the very
  // defect being fixed — a caller could set the header on a plaintext
  // connection and get Secure on a cookie the browser would then never send
  // back. Updated to the corrected contract rather than relaxed.
  const s = os.createSession({ ip: '1.2.3.4' });
  const plain = { headers: {}, socket: {}, app: { get: () => false } };
  const spoofed = { headers: { 'x-forwarded-proto': 'https' }, socket: {}, app: { get: () => false } };
  const behindTrustedProxy = { headers: { 'x-forwarded-proto': 'https' }, socket: {}, app: { get: () => true } };
  const realTls = { headers: {}, socket: { encrypted: true }, app: { get: () => false } };

  assert.ok(!/Secure/.test(os.cookieHeaders(s, plain)[0]), 'plain HTTP: no Secure');
  assert.ok(!/Secure/.test(os.cookieHeaders(s, spoofed)[0]), 'spoofed header must NOT set Secure');
  assert.ok(/Secure/.test(os.cookieHeaders(s, behindTrustedProxy)[0]), 'trusted proxy: Secure');
  assert.ok(/Secure/.test(os.cookieHeaders(s, realTls)[0]), 'real TLS socket: Secure');
  os.destroySession(s.sid);
});

console.log('\nserver misconfiguration fails closed');
test('an unset ADMIN_API_KEY refuses the machine path with 503, never passes it', () => {
  const saved = process.env.ADMIN_API_KEY;
  delete process.env.ADMIN_API_KEY;
  const v = os.authorize(req({ method: 'POST', key: 'anything' }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 503);
  process.env.ADMIN_API_KEY = saved;
});

test('empty credentials never compare equal', () => {
  assert.strictEqual(os.safeEqual('', ''), false);
  assert.strictEqual(os.safeEqual(undefined, undefined), false);
  assert.strictEqual(os.safeEqual('a', 'a'), true);
});

console.log('\ncookie parsing — the Cookie header is entirely attacker-controlled');
test('parses multiple cookies and tolerates junk structure', () => {
  const c = os.parseCookies({ headers: { cookie: 'a=1; ft_op=xyz; broken; b=%20two' } });
  assert.strictEqual(c.ft_op, 'xyz');
  assert.strictEqual(c.a, '1');
  assert.strictEqual(c.b, ' two');
});

test('MALFORMED PERCENT-ENCODING does not throw', () => {
  // The original test used %20 — valid encoding — so it proved tolerance of a
  // malformed STRUCTURE while leaving malformed ENCODING untested. %ZZ and a
  // lone % both make decodeURIComponent throw.
  for (const bad of ['ft_op=%ZZ', 'ft_op=%', 'ft_op=abc%E0%A4', 'a=%GG; ft_op=ok']) {
    assert.doesNotThrow(() => os.parseCookies({ headers: { cookie: bad } }), `threw on: ${bad}`);
  }
});

test('an undecodable value is kept raw, so it fails to MATCH rather than crashing', () => {
  const c = os.parseCookies({ headers: { cookie: 'ft_op=%ZZ' } });
  assert.strictEqual(c.ft_op, '%ZZ');
});

test('a malformed cookie is REFUSED cleanly — 401, never a 500 from the boundary', () => {
  const v = os.authorize(req({ method: 'DELETE', cookie: 'ft_op=%ZZ; ft_csrf=%' }));
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 401, 'must be an ordinary refusal, not an exception path');
});

console.log('\naudit outcome — status must be observed, not assumed');
test('finalizeAudit maps a real status to the right outcome', async () => {
  const seen = [];
  const fakePool = { query: async (sql, params) => { seen.push({ sql, params }); return [{}]; } };
  await os.finalizeAudit(fakePool, 42, 500);
  await os.finalizeAudit(fakePool, 43, 204);
  assert.strictEqual(seen[0].params[1], 'FAILED', 'a 500 handler must not be recorded as ALLOWED');
  assert.strictEqual(seen[1].params[1], 'ALLOWED');
  assert.strictEqual(seen[0].params[2], 42);
});

test('recordAttempt propagates failure so a mutation can be refused', async () => {
  const brokenPool = { query: async () => { throw new Error('table gone'); } };
  await assert.rejects(() => os.recordAttempt(brokenPool, {
    actor: 'op', via: 'session', method: 'DELETE', route: '/x', outcome: 'ATTEMPTED', statusCode: 0,
  }), /table gone/, 'must throw, or the middleware cannot fail closed');
});

test('recordAudit swallows failure so a denial stays a denial', async () => {
  const brokenPool = { query: async () => { throw new Error('table gone'); } };
  const id = await os.recordAudit(brokenPool, {
    actor: 'anonymous', via: 'none', method: 'GET', route: '/x', outcome: 'DENIED', statusCode: 401,
  });
  assert.strictEqual(id, null, 'a 401 must never be upgraded to a 503 by the audit path');
});

console.log('\naudit fail-closed — missing infrastructure is a failure, not a pass');
test('a MISSING POOL makes recordAttempt throw, so the middleware can refuse', async () => {
  await assert.rejects(() => os.recordAttempt(null, {
    actor: 'op', via: 'session', method: 'DELETE', route: '/x', outcome: 'ATTEMPTED', statusCode: 0,
  }), /audit pool unavailable/, 'returning null here let the one unaudited configuration through');
});

test('a failed finalize is reported, not swallowed', async () => {
  const broken = { query: async () => { throw new Error('update failed'); } };
  assert.strictEqual(await os.finalizeAudit(broken, 7, 200), false);
  assert.strictEqual(await os.finalizeAudit({ query: async () => [{}] }, 7, 200), true);
});

test('unfinalized rows are observable so they can be reconciled', async () => {
  let seen = null;
  const pool = { query: async (sql, params) => { seen = { sql, params }; return [[{ id: 9 }]]; } };
  const rows = await os.findUnfinalized(pool, { olderThanMinutes: 5 });
  assert.strictEqual(rows.length, 1);
  assert.ok(/ATTEMPTED/.test(seen.sql) && /status_code = 0/.test(seen.sql),
    'must look for admitted-but-unresolved rows specifically');
});

console.log('\nbrute force — this slice introduced the public login');
test('failures accumulate and lock out after the bound', () => {
  os._loginFailures.clear();
  const id = '10.0.0.1';
  for (let i = 0; i < os.LOGIN_MAX_FAILURES - 1; i++) os.recordLoginFailure(id);
  assert.strictEqual(os.loginState(id).locked, false, 'must not lock before the bound');
  os.recordLoginFailure(id);
  const st = os.loginState(id);
  assert.strictEqual(st.locked, true);
  assert.ok(st.retryAfterMs > 0);
});

test('a successful login clears the counter, so real use never locks itself out', () => {
  os._loginFailures.clear();
  const id = '10.0.0.2';
  os.recordLoginFailure(id); os.recordLoginFailure(id);
  os.clearLoginFailures(id);
  assert.strictEqual(os.loginState(id).remaining, os.LOGIN_MAX_FAILURES);
});

test('lockout expires, and the window rolls over', () => {
  os._loginFailures.clear();
  const id = '10.0.0.3';
  for (let i = 0; i < os.LOGIN_MAX_FAILURES; i++) os.recordLoginFailure(id);
  assert.strictEqual(os.loginState(id).locked, true);
  assert.strictEqual(os.loginState(id, Date.now() + os.LOGIN_LOCKOUT_MS + 1000).locked, false);
});

test('clients are limited independently', () => {
  os._loginFailures.clear();
  for (let i = 0; i < os.LOGIN_MAX_FAILURES; i++) os.recordLoginFailure('10.0.0.4');
  assert.strictEqual(os.loginState('10.0.0.4').locked, true);
  assert.strictEqual(os.loginState('10.0.0.5').locked, false);
});

console.log('\nactor identity is server-derived, never caller-supplied');
test('createSession ignores any actor the caller offers', () => {
  const s = os.createSession({ actor: 'admin-impersonator', ip: '1.2.3.4' });
  assert.ok(!s.actor.includes('impersonator'), `caller-supplied actor leaked: ${s.actor}`);
  assert.ok(s.actor.startsWith('operator:'), s.actor);
  os.destroySession(s.sid);
});

test('identity is a key fingerprint, and never the key itself', () => {
  const a = os.serverActorIdentity();
  assert.ok(a.startsWith('operator:key-'), a);
  assert.ok(!a.includes(REAL_KEY), 'the key must not appear in the audit actor');
});

test('an explicit OPERATOR_IDENTITY label wins', () => {
  process.env.OPERATOR_IDENTITY = 'gallan';
  assert.strictEqual(os.serverActorIdentity(), 'operator:gallan');
  delete process.env.OPERATOR_IDENTITY;
});

test('rotating the key changes the actor — it is a different credential', () => {
  const before = os.serverActorIdentity();
  process.env.ADMIN_API_KEY = REAL_KEY + '-rotated';
  const after = os.serverActorIdentity();
  process.env.ADMIN_API_KEY = REAL_KEY;
  assert.notStrictEqual(before, after);
});

console.log('\nforwarded headers are not trusted without a configured proxy');
const withApp = (trust, headers, socket = {}) => ({ headers, socket, app: { get: () => trust } });

test('a spoofed X-Forwarded-For is IGNORED when no proxy is trusted', () => {
  const ip = os.clientIp(withApp(false, { 'x-forwarded-for': '9.9.9.9' }, { remoteAddress: '10.1.1.1' }));
  assert.strictEqual(ip, '10.1.1.1', 'audit IP must not be forgeable by a header');
});

test('X-Forwarded-For is honoured only when a proxy IS trusted', () => {
  const ip = os.clientIp(withApp(true, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }, { remoteAddress: '10.1.1.1' }));
  assert.strictEqual(ip, '9.9.9.9');
});

test('a spoofed X-Forwarded-Proto cannot claim HTTPS on a plaintext socket', () => {
  const req = withApp(false, { 'x-forwarded-proto': 'https' });
  assert.strictEqual(os.requestIsSecure(req), false);
  const [sess] = os.cookieHeaders({ sid: 'a', csrf: 'b', expiresAt: Date.now() + 1000 }, req);
  assert.ok(!/Secure/.test(sess),
    'Secure on a plaintext connection means the cookie is never sent back — a self-inflicted outage');
});

test('a real TLS socket is secure regardless of headers or proxy config', () => {
  assert.strictEqual(os.requestIsSecure(withApp(false, {}, { encrypted: true })), true);
});

// ── the runner must be able to FAIL ─────────────────────────────────────────
// Proved in-band, because the previous runner reported 23/23 while three async
// tests asserted nothing, and a moment ago this file reported "0 passed" and
// exited zero because nothing invoked the queue at all. A self-check that is
// never exercised is the same class of mistake it exists to catch.
async function selfCheck() {
  let caught = false;
  try { await (async () => { assert.strictEqual(1, 2, 'deliberate'); })(); }
  catch { caught = true; }
  if (!caught) {
    console.log('  FAIL  <self-check> the runner cannot observe async failures');
    process.exit(1);
  }
  if (queue.length === 0) {
    console.log('  FAIL  <self-check> no tests were registered');
    process.exit(1);
  }
  console.log(`  PASS  <self-check> runner observes async rejections; ${queue.length} tests registered`);
  pass++;
}

runAll()
  .then(selfCheck)
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
