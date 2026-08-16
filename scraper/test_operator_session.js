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

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

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

test('Secure is set when the request arrived over TLS, and not otherwise', () => {
  const s = os.createSession({ actor: 'operator' });
  assert.ok(!/Secure/.test(os.cookieHeaders(s, { headers: {} })[0]), 'plain HTTP: no Secure');
  const tls = os.cookieHeaders(s, { headers: { 'x-forwarded-proto': 'https' } })[0];
  assert.ok(/Secure/.test(tls), 'behind a TLS proxy: Secure must be set');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
