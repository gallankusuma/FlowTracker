// Authorization policy test — every mutation route in server.js must have one.
//
// Codex review P0-01 asks for two things this file provides: "automated
// authorization tests that enumerate every Express route", and "CI fails when a
// new mutation route is registered without an auth policy".
//
// WHY A RATCHET AND NOT A FLAT ASSERTION. 19 mutation routes are still unguarded
// and cannot be closed today: they are called by the frontend with plain fetch(),
// so adding requireAdminKey without moving the client first returns 401 to our
// own pages. A test that simply demanded "all guarded" would fail from the moment
// it was written, and a permanently red test is one nobody reads.
//
// So the debt is ENUMERATED here instead. Each pending route is listed by name.
// The list may only SHRINK — removing a route from it is the act of fixing it,
// and a NEW unguarded route that is not on the list fails immediately. That gives
// the CI guarantee the review asked for while the client work is still open, and
// it makes the remaining surface visible in code rather than in a review document
// that goes stale.
//
// PUBLIC_MUTATIONS is separate and deliberately tiny: a mutation VERB that is
// intentionally unauthenticated, with the reason recorded. The review asked that
// such cases be "explicitly documented" rather than silently tolerated.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
const lines = src.split(/\r?\n/);

/**
 * Mutation verbs that are intentionally open, with the reason. Adding an entry
 * here is a deliberate security decision and should be argued in review.
 */
const PUBLIC_MUTATIONS = {
  'POST /api/ft-pull':
    'Retired stub. Returns HTTP 410 and performs no work; a 401 would hide the ' +
    'explanation a stale caller needs. Accepted by the reviewer 2026-08-16 as ' +
    'outside the auth defect count.',

  'POST /api/operator/login':
    'This is how an operator session is OBTAINED, so requiring one would be ' +
    'circular. It verifies ADMIN_API_KEY in constant time, returns 401 on ' +
    'mismatch and 503 when the key is unconfigured, and both outcomes are ' +
    'audited. Not rate-limited yet — that is P0-01 remediation item 4, outside ' +
    'the FT-P0-01A slice, and is recorded rather than assumed handled.',

  'POST /api/operator/logout':
    'Destroys only the session named by the caller own httpOnly cookie, so it ' +
    'grants nothing and reveals nothing. Logout must work even from a stale or ' +
    'already-invalid session, which is exactly when a user needs it; forcing it ' +
    'to authenticate first would leave dead sessions unrevocable.',
};

/**
 * Unguarded mutations still pending a client change (P0-01 PARTIAL).
 * THIS LIST MUST ONLY GET SHORTER. Do not add to it — guard the route instead.
 */
const PENDING_UNGUARDED = new Set([
  'POST /api/broker-summary/upload',
  'POST /api/broker-summary/upload-csv',
  'POST /api/stockbit-import',
  'POST /api/sectors/configure',
  'POST /api/scanner/run',
  'PATCH /api/scanner/picks/:id',
  'DELETE /api/recommendations/:id',
  'PATCH /api/recommendations/:id',
  'POST /api/scan-weights',
  'POST /api/recommendations',
  'POST /api/recommendations/bulk',
  'POST /api/recommendations/update-statuses',
  'POST /api/backtest/run',
  'DELETE /api/backtest/:runId',
  'POST /api/daily-picks/track',
  'POST /api/daily-picks/run',
]);

/** Every app.post/put/patch/delete registration, with its first middleware. */
function mutationRoutes() {
  const out = [];
  const re = /app\.(post|put|patch|delete)\(\s*'([^']+)'\s*(?:,\s*([A-Za-z_$][\w$]*))?/;
  lines.forEach((l, i) => {
    const m = l.match(re);
    if (!m) return;
    const guard = m[3] && m[3] !== 'async' ? m[3] : null;
    out.push({ key: `${m[1].toUpperCase()} ${m[2]}`, line: i + 1, guard });
  });
  return out;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const routes = mutationRoutes();
const GUARDS = new Set(['requireAdminKey', 'requireOperator']);
const guarded = routes.filter(r => GUARDS.has(r.guard));
const open = routes.filter(r => !GUARDS.has(r.guard));

console.log(`\nroute authorization policy — ${routes.length} mutation routes found`);
console.log(`  guarded (key or session)   : ${guarded.length}`);
console.log(`  intentionally public       : ${open.filter(r => PUBLIC_MUTATIONS[r.key]).length}`);
console.log(`  pending (P0-01)            : ${open.filter(r => PENDING_UNGUARDED.has(r.key)).length}`);

console.log('\nthe guarantee the review asked for');
test('every mutation route has an explicit authorization policy', () => {
  const undeclared = open
    .filter(r => !PUBLIC_MUTATIONS[r.key] && !PENDING_UNGUARDED.has(r.key))
    .map(r => `${r.key}  (server.js:${r.line})`);
  assert.deepStrictEqual(undeclared, [],
    'These mutation routes are unauthenticated and not declared anywhere.\n' +
    'Either add requireAdminKey, or — if the route is deliberately public —\n' +
    'add it to PUBLIC_MUTATIONS with the reason:\n  ' + undeclared.join('\n  '));
});

test('the pending list only shrinks — nothing on it may already be guarded', () => {
  // A route that has been fixed must be REMOVED from the list, otherwise the
  // ratchet silently loosens and the count stops meaning anything.
  const stale = [...PENDING_UNGUARDED].filter(k => {
    const r = routes.find(x => x.key === k);
    return r && GUARDS.has(r.guard);
  });
  assert.deepStrictEqual(stale, [],
    'These are now guarded and must be deleted from PENDING_UNGUARDED: ' + stale.join(', '));
});

test('every pending entry still corresponds to a real route', () => {
  const ghosts = [...PENDING_UNGUARDED].filter(k => !routes.some(x => x.key === k));
  assert.deepStrictEqual(ghosts, [],
    'PENDING_UNGUARDED names routes that no longer exist: ' + ghosts.join(', '));
});

test('intentionally-public mutations are documented and still exist', () => {
  for (const [k, reason] of Object.entries(PUBLIC_MUTATIONS)) {
    assert.ok(routes.some(x => x.key === k), `PUBLIC_MUTATIONS names a missing route: ${k}`);
    assert.ok(reason && reason.length > 40, `PUBLIC_MUTATIONS[${k}] needs a real reason, not a label`);
  }
});

console.log('\nthe routes already closed stay closed');
test('the two Sectors.app routes remain guarded', () => {
  for (const k of ['POST /api/sectors/pull', 'POST /api/sectors/pull-broker']) {
    const r = routes.find(x => x.key === k);
    assert.ok(r, `route disappeared: ${k}`);
    assert.ok(GUARDS.has(r.guard), `${k} lost its guard (regression)`);
  }
});

test('requireAdminKey is defined before any route uses it', () => {
  const def = lines.findIndex(l => /function requireAdminKey\s*\(/.test(l));
  assert.ok(def >= 0, 'requireAdminKey is not defined in server.js');
  const firstUse = routes.filter(r => r.guard === 'requireAdminKey')
    .reduce((m, r) => Math.min(m, r.line), Infinity);
  assert.ok(def + 1 < firstUse, 'requireAdminKey must be defined before its first use');
});

test('the guard actually rejects, rather than merely existing', () => {
  const i = lines.findIndex(l => /function requireAdminKey\s*\(/.test(l));
  const body = lines.slice(i, i + 25).join('\n');
  assert.ok(/401|403/.test(body), 'requireAdminKey never returns 401/403');
  assert.ok(/timingSafeEqual/.test(body), 'requireAdminKey should compare in constant time');
  assert.ok(/503/.test(body), 'requireAdminKey should refuse when ADMIN_API_KEY is unset, not pass through');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0 && PENDING_UNGUARDED.size > 0) {
  console.log(`\nNOTE: ${PENDING_UNGUARDED.size} routes remain unguarded by design of this ratchet.`);
  console.log('P0-01 is PARTIAL, not FIXED. This test prevents the number from growing;');
  console.log('it does not claim the finding is closed.');
}
process.exit(fail ? 1 : 0);
