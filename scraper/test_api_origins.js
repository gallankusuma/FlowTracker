'use strict';
/**
 * FT-P0-02 — hardcoded API origins may only get FEWER.
 *
 * The contract is that browser-side calls go to `/scraper-api/*` on the app's own
 * origin (see API_ROUTING.md). Absolute origins break it in a way that is easy to
 * miss, because the page still renders: the call succeeds anonymously, the
 * `SameSite=Strict` session cookie is simply never sent, and the operator looks
 * signed out for reasons nothing on screen explains.
 *
 * Four such pages exist today. They sit outside this vertical slice and the
 * dispatch says to remove conflicting origins "only where required for this
 * slice", so they are ENUMERATED rather than rewritten — the same ratchet shape
 * used for the authorization debt in test_route_authorization.js.
 *
 * The list may only shrink. A NEW hardcoded origin fails immediately, so the
 * contract cannot quietly erode while the document says otherwise.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Absolute origins that are CORRECT, not debt. Kept separate from the deviations
 * below on purpose: lumping them together would invite someone to "fix" them, and
 * in one case the fix breaks the feature outright.
 */
const LEGITIMATE_ABSOLUTE = {
  'lib/apiConfig.ts':
    'This IS the authority. Its absolute origin is the SSR branch — server-side rendering ' +
    'calls the scraper on loopback, which is correct and never reaches a browser.',
  'components/TampermonkeyPanel.tsx':
    'The origin lives inside SCRIPT_CONTENT, a Tampermonkey userscript that runs in the ' +
    "user's browser on rti.co.id and stockbit.com. A relative /scraper-api path there would " +
    'resolve against THOSE origins, so an absolute URL is the only thing that can work.',
};

/** Files allowed to carry an absolute API origin, with why. Delete entries; never add. */
const KNOWN_DEVIATIONS = {
  'app/daily-picks/page.tsx':
    'Outside the operator slice. Cannot carry a session; works only because port 3100 is directly reachable.',
  'app/journey/page.tsx':
    'Outside the operator slice, and points at localhost — broken for anyone but a developer on the box.',
  'app/screener/page.tsx':
    'Outside the operator slice. Reads NEXT_PUBLIC_API_URL first, absolute origin as fallback.',
  'app/stockbit-connector/page.tsx':
    'Outside the operator slice. Posts imports straight to the API port.',
};

const SEARCH_DIRS = ['app', 'lib', 'components'];
const ABSOLUTE_ORIGIN = /https?:\/\/(?:\d{1,3}(?:\.\d{1,3}){3}|localhost|127\.0\.0\.1)(?::\d+)?/;

function walk(dir, out = []) {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(rel, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

const offenders = [];
const files = SEARCH_DIRS.flatMap(d => walk(d));
for (const rel of files) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const hits = src.split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => ABSOLUTE_ORIGIN.test(line) && !line.startsWith('*') && !line.startsWith('//'));
  if (hits.length) offenders.push({ rel, hits });
}

console.log(`\nAPI origin contract — ${files.length} frontend source files scanned`);
console.log(`  files with an absolute API origin: ${offenders.length}`);

test('no NEW file hardcodes an absolute API origin', () => {
  const undeclared = offenders
    .filter(o => !(o.rel in KNOWN_DEVIATIONS) && !(o.rel in LEGITIMATE_ABSOLUTE))
    .map(o => `${o.rel}:${o.hits[0].n}  ${o.hits[0].line.slice(0, 80)}`);
  assert.deepStrictEqual(undeclared, [],
    'These call the API by host and port, so the SameSite=Strict session cookie\n' +
    'will never be sent and the page acts as an anonymous caller. Use API_BASE\n' +
    'from lib/apiConfig.ts, or declare the exception in KNOWN_DEVIATIONS with a reason:\n  ' +
    undeclared.join('\n  '));
});

test('the deviation list only shrinks — every entry must still be a real offender', () => {
  const stale = Object.keys(KNOWN_DEVIATIONS).filter(rel => !offenders.some(o => o.rel === rel));
  assert.deepStrictEqual(stale, [],
    'These were fixed and must be DELETED from KNOWN_DEVIATIONS, or the ratchet loosens: ' + stale.join(', '));
});

test('every declared exception carries a reason, not a label', () => {
  for (const [rel, why] of Object.entries({ ...KNOWN_DEVIATIONS, ...LEGITIMATE_ABSOLUTE })) {
    assert.ok(why && why.length > 40, `${rel} needs a real reason, not a label`);
  }
});

test('the legitimate list stays legitimate — each entry must still be one of the two allowed shapes', () => {
  // Guards against the list becoming a dumping ground: an entry here is either the
  // apiConfig authority itself, or an origin inside a third-party userscript.
  for (const rel of Object.keys(LEGITIMATE_ABSOLUTE)) {
    assert.ok(offenders.some(o => o.rel === rel), `${rel} no longer has an absolute origin — delete the entry`);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const isAuthority = rel === 'lib/apiConfig.ts';
    const isUserscript = /==UserScript==/.test(src);
    assert.ok(isAuthority || isUserscript,
      `${rel} is neither the apiConfig authority nor a userscript — it belongs in KNOWN_DEVIATIONS`);
  }
});

test('lib/apiConfig.ts remains the single authority for the browser base', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'apiConfig.ts'), 'utf8');
  assert.ok(/\/scraper-api/.test(src), 'apiConfig no longer names the same-origin path');
  assert.ok(/typeof window !== ["']undefined["']/.test(src),
    'apiConfig must still branch on browser vs server — SSR uses loopback, the browser must not');
});

test('the operator client goes through API_BASE, never an absolute origin', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'operatorSession.ts'), 'utf8');
  assert.ok(/from ['"]@\/lib\/apiConfig['"]/.test(src), 'operatorSession must import API_BASE');
  assert.ok(!ABSOLUTE_ORIGIN.test(src.replace(/^\s*\*.*$/gm, '')),
    'operatorSession.ts hardcodes an origin — the session cookie would not be sent');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail === 0 && Object.keys(KNOWN_DEVIATIONS).length > 0) {
  console.log(`\nNOTE: ${Object.keys(KNOWN_DEVIATIONS).length} pages still bypass the same-site contract.`);
  console.log('They are outside this slice and enumerated by name; the count may only fall.');
}
process.exit(fail ? 1 : 0);
