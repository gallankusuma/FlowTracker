/**
 * Float Cost Map — model invariants.
 *
 * Pure arithmetic: no database, no network, no clock. Every case here is one of
 * the ten properties the review asked for, and each is written so that a wrong
 * answer fails rather than a crash.
 *
 * Usage:  node test_model.js
 */
'use strict';

const assert = require('assert');
const M = require('./model');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

/** A synthetic series. Deterministic — no Math.random anywhere in this file. */
function bars({ n = 250, price = 1000, vol = 0, drift = 0, spread = 0.02 } = {}) {
  const out = [];
  let c = price;
  for (let i = 0; i < n; i++) {
    c = c * (1 + drift);
    out.push({ h: c * (1 + spread), l: c * (1 - spread), c, v: vol });
  }
  return out;
}

const FLOAT = 1_000_000_000;

console.log('\nfloat map model — conservation');

t('1. the distribution always totals the free float', () => {
  // Shares are moved between buckets, never created or destroyed. If this drifts,
  // every percentage on the page is quietly renormalised against a wrong base.
  for (const vol of [0, 1e6, 5e7, 5e8]) {
    const m = M.costMap(bars({ vol }), FLOAT);
    assert.ok(!m.error, m.error);
    const rel = Math.abs(m.totalShares - FLOAT) / FLOAT;
    assert.ok(rel < 1e-9, `volume ${vol}: total drifted ${(rel * 100).toFixed(6)}%`);
  }
});

t('2. zero volume preserves the inventory exactly where it started', () => {
  const m = M.costMap(bars({ vol: 0 }), FLOAT);
  assert.ok(!m.error, m.error);
  assert.strictEqual(m.seedRemaining, 1, 'nothing traded, yet the seed decayed');
  const occupied = m.dist.filter(x => x > 0).length;
  assert.strictEqual(occupied, 1, `inventory spread across ${occupied} buckets with no volume`);
});

console.log('\nfloat map model — convergence away from the day-one assumption');

t('3. a full-float session replaces essentially all of the old inventory', () => {
  // turnover 1/k = 1.334 of float -> t clamps to 1 -> seed must vanish.
  const b = bars({ vol: 0 });
  b[b.length - 1].v = FLOAT * 2;
  const m = M.costMap(b, FLOAT);
  assert.ok(!m.error, m.error);
  assert.ok(m.seedRemaining < 1e-12, `seed survived a full rotation: ${m.seedRemaining}`);
});

t('4. repeated heavy turnover drives the seed toward zero', () => {
  const hi = M.costMap(bars({ vol: FLOAT * 0.05 }), FLOAT);   // ~5% of float daily
  const lo = M.costMap(bars({ vol: FLOAT * 0.0001 }), FLOAT); // almost untraded
  // 5% of float a day at k=0.75 is (1-0.0375)^250 ≈ 7e-5 of the seed left.
  // Below 0.1% the day-one assumption is no longer visible in the answer;
  // demanding 1e-6 was an arbitrary expectation of mine, not a property.
  assert.ok(hi.seedRemaining < 1e-3, `busy name still ${(hi.seedRemaining * 100).toFixed(4)}% seed`);
  assert.ok(lo.seedRemaining > 0.9, `quiet name should still be mostly seed, got ${lo.seedRemaining}`);
  // And the confidence must SAY so — this is the whole point of reporting it.
  const cHi = M.confidenceFor({ seedRemaining: hi.seedRemaining, bars: 250, floatStatus: 'VALID', floatAgeDays: 1, brokerLagSessions: 0 });
  const cLo = M.confidenceFor({ seedRemaining: lo.seedRemaining, bars: 250, floatStatus: 'VALID', floatAgeDays: 1, brokerLagSessions: 0 });
  assert.strictEqual(cHi.convergence, 100);
  assert.strictEqual(cLo.convergence, 0, 'an unconverged map scored as if it had converged');
  assert.ok(cHi.overall > cLo.overall);
});

console.log('\nfloat map model — refusals');

t('5. a corporate-action jump fails closed', () => {
  const b = bars({ vol: 1e6 });
  b[100].c *= 1.6; b[100].h *= 1.6; b[100].l *= 1.6;     // a 1:1 bonus, roughly
  const m = M.costMap(b, FLOAT);
  assert.strictEqual(m.error, 'CORPORATE_ACTION', `got ${JSON.stringify(m.error)}`);
});

t('   ...and a move just under the threshold does NOT', () => {
  // The negative control: a detector that rejects everything would pass above.
  const b = bars({ vol: 1e6 });
  b[100].c *= 1.30; b[100].h *= 1.30; b[100].l *= 1.30;
  b[101].c = b[100].c;                                    // no snap-back
  const m = M.costMap(b, FLOAT);
  assert.ok(!m.error, `a 30% move was rejected as a corporate action: ${m.error}`);
});

t('6. an invalid float produces no map at all', () => {
  for (const f of [0, -1, null, undefined, NaN, Infinity]) {
    const m = M.costMap(bars({ vol: 1e6 }), f);
    assert.strictEqual(m.error, 'NO_FLOAT', `float ${f} produced a map`);
  }
});

t('   ...short history and malformed bars are refused too', () => {
  assert.strictEqual(M.costMap(bars({ n: 30, vol: 1e6 }), FLOAT).error, 'SHORT_HISTORY');
  const bad = bars({ vol: 1e6 });
  bad[10].h = NaN;
  assert.strictEqual(M.costMap(bad, FLOAT).error, 'BAD_BAR');
  const inverted = bars({ vol: 1e6 });
  inverted[10].h = inverted[10].l - 1;
  assert.strictEqual(M.costMap(inverted, FLOAT).error, 'BAD_BAR');
});

t('9. no NaN or Infinity ever reaches the output', () => {
  for (const cfg of [{ vol: 0 }, { vol: 1e9 }, { vol: 1e-6 }, { drift: 0.001, vol: 1e7 }, { spread: 0 }]) {
    const m = M.costMap(bars(cfg), FLOAT);
    if (m.error) continue;
    for (const [k, v] of Object.entries(m)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} = ${v} for ${JSON.stringify(cfg)}`);
    }
    for (const [i, v] of m.dist.entries()) assert.ok(Number.isFinite(v), `dist[${i}] = ${v}`);
  }
});

console.log('\nfloat map model — determinism and the residual');

t('8. the same input gives byte-identical output', () => {
  const b = bars({ vol: 3e7, drift: 0.0004 });
  const a1 = M.costMap(b, FLOAT), a2 = M.costMap(b, FLOAT);
  assert.strictEqual(JSON.stringify(a1), JSON.stringify(a2));
  // And a different float genuinely changes it — otherwise the test above is vacuous.
  const a3 = M.costMap(b, FLOAT * 2);
  assert.notStrictEqual(JSON.stringify(a1), JSON.stringify(a3));
});

t('7. the residual is orthogonal to the columns it was regressed on', () => {
  // If it is not, "momentum removed" is a claim the code does not honour, and
  // the one number EXP-023 found predictive would be contaminated.
  const n = 60;
  const roc20 = Array.from({ length: n }, (_, i) => (i % 7) / 10 - 0.3);
  const roc60 = Array.from({ length: n }, (_, i) => (i % 11) / 8 - 0.6);
  const y = roc20.map((a, i) => 3 * a - 2 * roc60[i] + ((i % 5) - 2) * 0.01);
  const res = M.residualise(y, [roc20, roc60]);
  assert.ok(res, 'residualise returned null on a well-conditioned system');

  const dot = (a, b) => {
    const ma = a.reduce((x, y2) => x + y2, 0) / a.length, mb = b.reduce((x, y2) => x + y2, 0) / b.length;
    return a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / a.length;
  };
  assert.ok(Math.abs(dot(res, roc20)) < 1e-9, `residual still correlates with ROC20: ${dot(res, roc20)}`);
  assert.ok(Math.abs(dot(res, roc60)) < 1e-9, `residual still correlates with ROC60: ${dot(res, roc60)}`);
  assert.ok(Math.abs(res.reduce((a, b) => a + b, 0)) < 1e-9, 'residual has a non-zero mean');
});

t('   ...a singular system returns null rather than nonsense', () => {
  const n = 20;
  const a = Array.from({ length: n }, (_, i) => i);
  assert.strictEqual(M.residualise(a, [a, a]), null, 'collinear inputs produced a residual');
});

console.log('\nfloat map model — the shape the page consumes');



console.log('\nfloat map model — a bucket is a band, not a point');

t('the price splits the band it falls inside, proportionally', () => {
  // The reviewer's worked example: a band Rp1,000-1,100 holding 20% with the
  // price at Rp1,030 is 6% in profit — not 20%, and not 0%.
  const nb = 10, lo = 500, step = 100;
  const dist = new Array(nb).fill(0);
  dist[5] = 20; dist[0] = 80;
  const price = 1030;
  let profit = 0;
  for (let i = 0; i < nb; i++) {
    const bl = lo + step * i, bh = bl + step;
    if (bh <= price) profit += dist[i];
    else if (bl >= price) continue;
    else profit += dist[i] * ((price - bl) / step);
  }
  assert.strictEqual(+profit.toFixed(4), 86, 'got ' + profit);
});

t('costMap uses that split, so a small price move cannot jump a whole band', () => {
  // The series must span a real range, or 40 bands cover a couple of rupiah
  // and a one-rupiah move genuinely crosses most of them — which is what my
  // first version of this test measured, and it was the test that was wrong.
  const mk = last => {
    const b = bars({ n: 250, price: 800, vol: 1e6, drift: 0.001, spread: 0.01 });
    b[b.length - 1] = { h: last * 1.001, l: last * 0.999, c: last, v: 1e6 };
    return M.costMap(b, FLOAT);
  };
  const base = bars({ n: 250, price: 800, vol: 1e6, drift: 0.001, spread: 0.01 });
  const mid = base[base.length - 1].c;
  const a = mk(mid), c = mk(mid * 1.001);
  assert.ok(!a.error && !c.error, a.error || c.error);
  const jump = Math.abs(c.profitSupply - a.profitSupply);
  assert.ok(jump < 0.25, 'a 0.1% price move shifted profitSupply by ' + (jump*100).toFixed(1) + ' points');
});

t('every band carries its own low, high and midpoint', () => {
  const m = M.costMap(bars({ vol: 2e7, drift: 0.0005 }), FLOAT);
  const { bands } = M.chartBuckets(m);
  assert.ok(bands.length > 0);
  for (const b of bands) {
    assert.ok(b.high > b.low, 'band ' + b.low + '-' + b.high + ' is not a range');
    assert.strictEqual(b.midpoint, Math.round((b.low + b.high) / 2), 'midpoint is not the middle of its own band');
  }
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i].midpoint < bands[i-1].midpoint, 'not descending');
});

t('displayed + hidden = 100%, measured rather than inferred', () => {
  for (const cfg of [{ vol: 2e7, drift: 0.0005 }, { vol: 1e6 }, { vol: 4e8, spread: 0.05 }]) {
    const m = M.costMap(bars(cfg), FLOAT);
    if (m.error) continue;
    const { bands, hidden } = M.chartBuckets(m);
    const shown = bands.reduce((a, x) => a + x.share, 0);
    const tol = 0.05 * bands.length + 0.05;
    assert.ok(Math.abs(shown + hidden - 100) <= tol,
      'shown ' + shown.toFixed(2) + ' + hidden ' + hidden + ' = ' + (shown+hidden).toFixed(2));
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
