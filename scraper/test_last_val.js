/**
 * LAST VAL — the 10B boundary, and the sort that reads the same scale.
 *
 * Asked for by the 2026-08-18 10:50 review: "add a focused filter/sort fixture
 * at the 10B boundary".
 *
 * THE DEFECT THIS PINS. The Flow Analyzer displayed one-sided `buyValue` under a
 * column named TURNOVER, which is the TWO-sided figure — SUM(buy_val + sell_val),
 * exactly 2x the value that changed hands. While display, filter and sort had
 * drifted onto different fields, typing "min 10" filtered a scale the column did
 * not show, so "at least 10B" silently meant 5B and nothing on screen said so.
 * A filter that quietly means half what it says produces no error and no empty
 * table — just a shorter list nobody questions.
 *
 * The column, the filter and the sort now all read LAST VAL, and this file is
 * what stops them drifting apart again. It imports the SHIPPED module, not a
 * copy: lib/lastVal.js is plain CommonJS precisely so the page and this test can
 * execute the same code.
 *
 * The frontend tree is located rather than assumed — on the VPS it is a SIBLING
 * of the scraper, not its parent (the same correction test_api_origins.js
 * needed).
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function findFrontendRoot() {
  const candidates = [
    process.env.FRONTEND_ROOT,
    path.join(__dirname, '..'),                        // repo layout
    path.join(__dirname, '..', 'flowtracker'),         // sibling layout (VPS)
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib', 'lastVal.js'))) return c;
  }
  console.error('Could not locate the frontend tree. Tried:');
  for (const c of candidates) console.error('  ' + c);
  console.error('Set FRONTEND_ROOT to the directory containing lib/lastVal.js.');
  process.exit(1);
}

const ROOT = findFrontendRoot();
const { parseLastVal, withinLastVal } = require(path.join(ROOT, 'lib', 'lastVal.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

console.log('');
console.log('every suffix formatVal can emit');

t('B is the base unit', () => {
  assert.strictEqual(parseLastVal('10B'), 10);
  assert.strictEqual(parseLastVal('12.4B'), 12.4);
});

t('T scales up, M and K scale down', () => {
  assert.strictEqual(parseLastVal('1.05T'), 1050);
  assert.strictEqual(parseLastVal('500M'), 0.5);
  assert.ok(Math.abs(parseLastVal('929.2K') - 0.0009292) < 1e-12);
});

t('a bare number is raw rupiah, not billions', () => {
  // This was the bug: no suffix fell through and was read as billions, so a
  // 4,500-rupiah row sorted above a 12-billion one.
  assert.strictEqual(parseLastVal('4500'), 4.5e-6);
  assert.ok(parseLastVal('4500') < parseLastVal('12.4B'));
});

t('929.2K does not read as 929.2 billion', () => {
  // A million times too large. It put the SMALLEST rows at the top of a
  // descending sort, which looks like a sort bug and is a units bug.
  assert.ok(parseLastVal('929.2K') < 1, `read as ${parseLastVal('929.2K')}B`);
});

t('unparseable input is 0, never NaN', () => {
  for (const s of ['', '-', 'n/a', null, undefined]) {
    assert.strictEqual(parseLastVal(s), 0, `${JSON.stringify(s)} produced ${parseLastVal(s)}`);
  }
});

console.log('');
console.log('the 10B boundary');

t('exactly 10.0B passes a min of 10 — the bound is inclusive', () => {
  // The row the number names must survive the filter that names it. An
  // exclusive bound drops it, and the drop is invisible: the row is simply
  // not there to notice.
  assert.strictEqual(withinLastVal('10B', 10, NaN), true);
  assert.strictEqual(withinLastVal('10.0B', 10, NaN), true);
});

t('exactly 10.0B passes a max of 10 too', () => {
  assert.strictEqual(withinLastVal('10B', NaN, 10), true);
});

t('just under 10B is excluded, just over is kept', () => {
  assert.strictEqual(withinLastVal('9.99B', 10, NaN), false);
  assert.strictEqual(withinLastVal('10.01B', 10, NaN), true);
});

t('the two-sided figure would have passed where the one-sided one must not', () => {
  // The exact shape of the defect: a stock with 5B of one-sided value prints
  // 10B of turnover. Under a "min 10B" filter the old wiring kept it.
  const oneSided = '5B', twoSided = '10B';
  assert.strictEqual(withinLastVal(oneSided, 10, NaN), false,
    'a 5B stock must not survive a 10B floor');
  assert.strictEqual(withinLastVal(twoSided, 10, NaN), true);
  assert.strictEqual(parseLastVal(twoSided), parseLastVal(oneSided) * 2,
    'turnover is exactly twice LAST VAL — that is why the label mattered');
});

t('an empty filter box matches everything, including tiny rows', () => {
  // NaN means "not filtering", not "nothing matches". Getting this backwards
  // empties the table the moment a user clears a box.
  assert.strictEqual(withinLastVal('929.2K', NaN, NaN), true);
  assert.strictEqual(withinLastVal('0', NaN, NaN), true);
});

t('a min/max pair keeps only the interior, ends included', () => {
  const rows = ['5B', '10B', '50B', '100B', '1.05T'];
  const kept = rows.filter(r => withinLastVal(r, 10, 100));
  assert.deepStrictEqual(kept, ['10B', '50B', '100B']);
});

console.log('');
console.log('the sort reads the same scale as the filter');

t('descending sort puts the largest transaction value first', () => {
  const rows = ['929.2K', '4500', '12.4B', '1.05T', '500M', '10B'];
  const sorted = rows.slice().sort((a, b) => parseLastVal(b) - parseLastVal(a));
  assert.deepStrictEqual(sorted, ['1.05T', '12.4B', '10B', '500M', '929.2K', '4500']);
});

t('a row that survives the filter cannot sort below one that did not', () => {
  // Filter and sort drifting onto different fields is the original defect. If
  // they share a scale this ordering is guaranteed; if they ever diverge again
  // it breaks here rather than on screen.
  const rows = ['929.2K', '4500', '12.4B', '1.05T', '500M', '10B'];
  const kept = rows.filter(r => withinLastVal(r, 10, NaN));
  const dropped = rows.filter(r => !withinLastVal(r, 10, NaN));
  const worstKept = Math.min(...kept.map(parseLastVal));
  const bestDropped = dropped.length ? Math.max(...dropped.map(parseLastVal)) : -Infinity;
  assert.ok(worstKept > bestDropped,
    `filter and sort disagree: kept ${worstKept}B, dropped ${bestDropped}B`);
});

console.log('');
console.log('the page still uses this module, and no longer says TURNOVER');

const PAGE = path.join(ROOT, 'app', 'flow-analyzer', 'page.tsx');
const src = fs.readFileSync(PAGE, 'utf8');

t('the page imports the shared helper instead of carrying its own copy', () => {
  assert.ok(src.includes('from "@/lib/lastVal"'), 'the import is gone');
  assert.ok(!/function parseLastVal/.test(src),
    'the page has grown its own parseLastVal again — this file no longer tests what ships');
});

t('no visible label calls the one-sided figure TURNOVER', () => {
  // Comments may discuss `turnover`; a rendered label may not name it, because
  // the column shows the one-sided value.
  const visible = src
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
  const offenders = [/label: "TURNOVER/, />TURNOVER</, /k="turnover"/];
  for (const re of offenders) {
    assert.ok(!re.test(visible), `a visible TURNOVER label survives: ${re}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
