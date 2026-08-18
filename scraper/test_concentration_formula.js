'use strict';
// Concentration formula — parity with the reference site, pinned by real data.
//
// The point of this file is that the formula is not free to drift again. The
// ANTM fixture below is the actual per-broker net for 2026-08-14 as stored in
// idx_broker_summary, and 48.69 is the value flowtracker.id published for that
// session. If a future change to the model breaks that equality, this fails.
const assert = require('assert');
const { signedTop3Concentration, signedTop3ConcentrationRounded } =
  require('./modules/concentration_formula');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}

// idx_broker_summary, stock_code='ANTM', date='2026-08-14', SUM(buy_val-sell_val)
// per broker. 60 brokers, all non-zero.
const ANTM_2026_08_14 = [
  57333440000, -12384162000, 12168093000, -11717154000, -10297124000, 8830957000,
  -8376282000, -6174694000, -5723764000, -5015249000, 5011235000, -3318574000,
  -3191696000, -3110783000, -2983685000, -2726839000, -2210529000, 2083846000,
  -1963346000, -1918621000, -1824181000, -1635083000, 1510000000, -1504300000,
  -1031068000, 758230000, -650361000, 614247000, -557400000, -508387000,
  488652000, 461697000, -404823000, 375629000, -316176000, -255212000,
  169120000, 121663000, -119600000, -96261000, 74601000, -69521000,
  69080000, 59600000, -54070000, -45300000, 30200000, 29700000,
  -24892000, 22309000, -9210000, 7735000, 5425000, -4293000,
  3625000, -3070000, -924000, -918000, -900000, 286000,
];

console.log('\nparity with the reference site');

test('ANTM 2026-08-14 reproduces flowtracker.id exactly (48.69)', () => {
  assert.strictEqual(signedTop3ConcentrationRounded(ANTM_2026_08_14), 48.69);
});

test('the old halving is gone — the value is not ~24.3 or ~12.7', () => {
  // 24.34 would mean the denominator is SUM|net| (twice the positive side);
  // 12.70 was the shipped value, 0.4x our own signal after the NG blend.
  const v = signedTop3Concentration(ANTM_2026_08_14);
  assert.ok(Math.abs(v - 24.35) > 1, `denominator regressed to SUM|net|: ${v}`);
  assert.ok(Math.abs(v - 12.70) > 1, `the 0.6 NG blend is back: ${v}`);
});

// idx_broker_summary, stock_code='TLKM', date='2026-08-14'. The session that
// settled "top 3 per side" against "top 6 by magnitude": the reference site
// published -9.33, per-side gives -9.32, and by-magnitude gives +6.50 -- not
// merely a different number but the opposite direction.
const TLKM_2026_08_14 = [
  -47884419000, 38433777000, -11820153000, 9635803000, 9241124000, 8209963000,
  6341115000, 5976828000, -5942193000, -5558368000, -4640765000, -4202168000,
  3970120000, 3791906000, -2027480000, -1435619000, 1126942000, -1110015000,
  -1037560000, -1012913000, -987787000, -594645000, 518351000, -500264000,
  465014000, 324766000, 290178000, 276335000, -256042000, 239456000,
  -169441000, 150451000, -138535000, 131262000, 100860000, 75456000,
  -73750000, 51123000, -31702000, 29252000, 26000000, 20960000,
  18662000, -15097000, -13736000, 13100000, 12803000, -12596000,
  -6575000, -4741000, 3393000, 2610000, -2610000, 259000,
];

test('TLKM 2026-08-14 matches the reference where the rival reading flips the sign', () => {
  assert.strictEqual(signedTop3ConcentrationRounded(TLKM_2026_08_14), -9.32);

  // The rival reading, computed rather than asserted so the divergence is
  // visible: the top 6 by |net| here is 4 buyers / 2 sellers, not 3/3.
  const top6 = [...TLKM_2026_08_14].sort((a, b) => Math.abs(b) - Math.abs(a)).slice(0, 6);
  const posTotal = TLKM_2026_08_14.filter(n => n > 0).reduce((a, b) => a + b, 0);
  const byMagnitude = 100 * top6.reduce((a, b) => a + b, 0) / posTotal;
  assert.ok(byMagnitude > 0, 'the rival reading is positive on this session');
  assert.ok(Math.abs(byMagnitude + 9.33) > 15, 'the readings must be far apart here');
});

console.log('\nthe definition, stated as tests');

test('top 3 PER SIDE, not top 6 by magnitude — the sample could not tell these apart', () => {
  // 4 buyers, 3 sellers: the top 6 by |net| are 4 buyers + 2 sellers, so the two
  // readings genuinely diverge here. Across the universe they disagree on 52% of
  // ticker-sessions, which is why this is pinned rather than left to chance.
  const nets = [100, 90, 80, 70, -60, -10, -5];
  //  top3 buyers 270, top3 sellers -75, positives total 340 -> 57.35
  //  top6 by |net| would be 100+90+80+70-60-10 = 270      -> 79.41
  assert.strictEqual(signedTop3ConcentrationRounded(nets), 57.35);
});

test('a balanced market reads 0 — a real measurement, not a missing one', () => {
  assert.strictEqual(signedTop3Concentration([50, -50]), 0);
});

test('no accumulation at all returns null, which is NOT zero', () => {
  // Zero would claim "we looked and the market was balanced". Null says the
  // question does not apply — the distinction the R2-A null work exists for.
  assert.strictEqual(signedTop3Concentration([]), null);
  assert.strictEqual(signedTop3Concentration([-10, -20]), null);
  assert.strictEqual(signedTop3Concentration([0, 0, 0]), null);
});

test('brokers with exactly zero net occupy no slot', () => {
  const withZeros = [100, 0, 90, 0, 80, 0, 70, -60, -10, -5, 0];
  assert.strictEqual(signedTop3ConcentrationRounded(withZeros), 57.35);
});

test('the result stays inside +/-100', () => {
  const negatives = Array.from({ length: 100 }, () => -1000);
  const spread = [60000, 40000, ...negatives];          // matched: 100k vs 100k
  const v = signedTop3Concentration(spread);
  assert.ok(v <= 100 && v >= -100, `out of bounds: ${v}`);
  assert.strictEqual(signedTop3ConcentrationRounded(spread), 97);
  const mirrored = spread.map(n => -n);
  assert.strictEqual(signedTop3ConcentrationRounded(mirrored), -97);
});

test('sign follows dominance, and is symmetric', () => {
  const buyerHeavy = [100, 50, 20, -10, -10, -10, -140];
  const sellerHeavy = buyerHeavy.map(n => -n);
  assert.strictEqual(
    signedTop3ConcentrationRounded(buyerHeavy),
    -signedTop3ConcentrationRounded(sellerHeavy));
});

test('junk values are ignored rather than poisoning the sum', () => {
  const dirty = [100, 90, 80, 70, -60, -10, -5, NaN, null, undefined, 'x'];
  assert.strictEqual(signedTop3ConcentrationRounded(dirty), 57.35);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
