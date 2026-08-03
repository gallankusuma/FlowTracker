/**
 * Tests for modules/execution.js — the sell-side NO_FILL and mark-to-market
 * behaviour the 2026-08-03 review raised as P0.1.
 */
'use strict';

const assert = require('assert');
const ex = require('./modules/execution');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

const S = { open: [10, 0, 12, null, 0], close: [10, null, 12, null, 0] };

console.log('\nexecution — sellFill');

t('returns the open when the bar is tradeable', () => {
  assert.strictEqual(ex.sellFill(S, 0), 10);
});

t('returns null on a zero open — a NO_FILL, not a free exit at zero', () => {
  assert.strictEqual(ex.sellFill(S, 1), null);
});

t('returns null on a null open', () => {
  assert.strictEqual(ex.sellFill(S, 3), null);
});

t('never throws on a ticker with no series at all', () => {
  assert.strictEqual(ex.sellFill(undefined, 0), null);
  assert.strictEqual(ex.sellFill({}, 0), null);
});

console.log('\nexecution — markPrice');

t('uses the bar close when it is real', () => {
  assert.strictEqual(ex.markPrice(S, 2), 12);
});

t('walks back to the last real close rather than returning zero', () => {
  // Bar 3 has no close. The position is still worth bar 2's price, not nothing.
  assert.strictEqual(ex.markPrice(S, 3), 12);
});

t('treats a zero close as absent, not as a price of zero', () => {
  assert.strictEqual(ex.markPrice(S, 4), 12);
});

t('returns null when nothing has ever printed', () => {
  assert.strictEqual(ex.markPrice({ close: [null, 0, null] }, 2), null);
});

t('never looks forward', () => {
  // Bar 1 has no close and nothing before it does either.
  assert.strictEqual(ex.markPrice({ close: [null, null, 99] }, 1), null);
});

t('refuses to mark off a price older than maxLookback', () => {
  const stale = { close: [50, null, null, null, null] };
  assert.strictEqual(ex.markPrice(stale, 4, 2), null);
  assert.strictEqual(ex.markPrice(stale, 4, 10), 50);
});

t('handles i beyond the end of the array without reading undefined', () => {
  assert.strictEqual(ex.markPrice(S, 99), 12);
});

console.log('\nexecution — markToMarket');

const series = new Map([
  ['AAA', { open: [10, 20], close: [10, 20] }],
  ['BBB', { open: [10, 0], close: [10, null] }],   // halted on bar 1
  ['CCC', { open: [0, 0], close: [null, null] }],  // never printed
]);

t('prices a halted holding off its last close instead of zero', () => {
  const r = ex.markToMarket(new Map([['BBB', 5]]), series, 1);
  assert.strictEqual(r.value, 50, `got ${r.value}`);
  assert.deepStrictEqual(r.unmarkable, []);
});

t('prefers the execution open when one exists', () => {
  const r = ex.markToMarket(new Map([['AAA', 3]]), series, 1);
  assert.strictEqual(r.value, 60);
});

t('reports a genuinely unmarkable holding instead of silently valuing it at 0', () => {
  const r = ex.markToMarket(new Map([['CCC', 7]]), series, 1);
  assert.strictEqual(r.value, 0);
  assert.deepStrictEqual(r.unmarkable, ['CCC']);
});

t('sums a mixed book and still names what it could not mark', () => {
  const r = ex.markToMarket(new Map([['AAA', 1], ['BBB', 1], ['CCC', 1]]), series, 1);
  assert.strictEqual(r.value, 30);           // 20 from AAA's open + 10 from BBB's last close
  assert.deepStrictEqual(r.unmarkable, ['CCC']);
});

t('an empty book is worth nothing and marks nothing as unmarkable', () => {
  const r = ex.markToMarket(new Map(), series, 1);
  assert.strictEqual(r.value, 0);
  assert.deepStrictEqual(r.unmarkable, []);
});

console.log('\nexecution — the regression this module exists to prevent');

t('a halted holding is worth MORE than zero, which the old inline code assumed', () => {
  // Old shape: `if (px > 0) pv += units * px` — BBB contributes 0 at bar 1.
  const held = new Map([['BBB', 5]]);
  let oldWay = 0;
  for (const [tk, u] of held) { const px = series.get(tk).open[1]; if (px > 0) oldWay += u * px; }
  assert.strictEqual(oldWay, 0);
  assert.strictEqual(ex.markToMarket(held, series, 1).value, 50);
});

t('an unsellable position must not be disposable — sellFill says no', () => {
  assert.strictEqual(ex.sellFill(series.get('BBB'), 1), null);
  assert.ok(ex.markPrice(series.get('BBB'), 1) > 0, 'yet it still has a value');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
