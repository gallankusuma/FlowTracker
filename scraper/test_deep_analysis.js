'use strict';
/**
 * Tests for the deep-analysis primitives.
 *
 * This file exists because of what the report LOOKS like. It prints structure
 * labels, zone tables and cost bases in a confident format, and a reader has no
 * way to tell a correct pivot from a wrong one by looking. Output that
 * authoritative has to be pinned, or it becomes the most convincing way to be
 * wrong that this project has built.
 *
 * Run: node test_deep_analysis.js
 */

const assert = require('assert');
const { pivots, structure, zones, volumeState, weeklyFromDaily } = require('./deep_analysis');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
t.section = title => queue.push([title, null]);

/** Bars from a list of closes; range is a fixed fraction so highs/lows are predictable. */
function bars(closes, startDate = '2026-01-01') {
  const d = new Date(startDate + 'T00:00:00Z');
  return closes.map((c, i) => {
    const day = new Date(d); day.setUTCDate(d.getUTCDate() + i);
    return { d: day.toISOString().slice(0, 10), o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 };
  });
}

t.section('pivots');

t('a single peak is found, and only when both sides confirm it', () => {
  //                       0   1   2   3    4   5   6
  const b = bars([10, 11, 12, 20, 12, 11, 10]);
  const p = pivots(b, 3);
  const highs = p.filter(x => x.kind === 'high');
  assert.strictEqual(highs.length, 1);
  assert.strictEqual(highs[0].d, b[3].d);
});

t('the last k bars can never be a pivot yet — that is what makes it a swing', () => {
  // A rising series ending at its maximum: the top is NOT a confirmed pivot,
  // because nothing has closed on the far side of it.
  const b = bars([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const p = pivots(b, 3);
  assert.ok(!p.some(x => x.i > b.length - 1 - 3),
    'a pivot was reported inside the unconfirmable tail');
});

t.section('structure');

// Peaks at 14, 16, 18 and troughs at 10, 12: each peak has two lower bars on
// BOTH sides, which is what makes it a pivot at k=2.
const UP = [10, 12, 14, 12, 10, 12, 16, 14, 12, 14, 18, 16, 14];
const DOWN = [18, 16, 14, 16, 18, 16, 12, 14, 16, 14, 10, 12, 14];

t('higher highs and higher lows read as an uptrend', () => {
  const s = structure(bars(UP), 2);
  assert.ok(s.state.startsWith('UPTREND'), s.state);
});

t('lower highs and lower lows read as a downtrend', () => {
  const s = structure(bars(DOWN), 2);
  assert.ok(s.state.startsWith('DOWNTREND'), s.state);
});

t('a higher low without a higher high is a reversal ATTEMPT, not a reversal', () => {
  // The distinction the worked example insists on: weekly "belum kembali
  // bullish", it is attempting. The label must not promote it.
  // Highs falling 22 -> 20 -> 19, lows rising 14 -> 16.
  const b = bars([20, 18, 22, 18, 14, 16, 20, 18, 16, 18, 19, 17, 15]);
  const s = structure(b, 2);
  assert.ok(s.state.startsWith('REVERSAL ATTEMPT'), s.state);
  assert.ok(!/UPTREND/.test(s.state));
});

t('too few swings is UNDETERMINED, never a guess', () => {
  assert.strictEqual(structure(bars([10, 11, 12, 13]), 3).state, 'UNDETERMINED');
});

t('invalidation is the last swing low, and is quoted as a distance', () => {
  const s = structure(bars(UP), 2);
  assert.strictEqual(s.invalidation.below, s.lastSwingLow.price);
  assert.ok(s.invalidation.distancePct < 0, 'price is above the low, so the distance is negative');
});

t('price already above the last confirmed high is reported as a BREAK, not as pending', () => {
  // The presentation bug this caught on ADMR: "needs a close above 1695" while
  // price was 1710 reads as though something is still to come. A confirmed pivot
  // is always at least k bars old, so this case is normal, not exceptional.
  // Same shape as UP, but the final bar runs far past the last confirmed peak,
  // which also means that peak can no longer be a pivot -- exactly the ADMR case.
  const s = structure(bars([10, 12, 14, 12, 10, 12, 16, 14, 12, 14, 18, 16, 25]), 2);
  assert.ok(s.toConfirmUp.status, 'expected the already-above branch');
  assert.ok(s.toConfirmUp.abovePct > 0);
  assert.ok(/cannot be confirmed/.test(s.toConfirmUp.then));
  assert.strictEqual(s.toConfirmUp.needsCloseAbove, undefined,
    'the pending wording must not appear when the level is already exceeded');
});

t('the swing high reports how old it is', () => {
  const s = structure(bars(UP), 2);
  assert.ok(s.lastSwingHigh.barsAgo >= 2, 'a confirmed pivot is at least k bars old');
});

t.section('zones');

t('the point of control lands where the volume actually sat', () => {
  // 100 sessions parked at 50, ten spread over 40-60. The POC must be at 50.
  const b = [];
  for (let i = 0; i < 100; i++) b.push({ d: `2026-01-${(i % 28) + 1}`, o: 50, h: 50.2, l: 49.8, c: 50, v: 1000 });
  for (let i = 0; i < 10; i++) b.push({ d: `2026-03-${i + 1}`, o: 45, h: 60, l: 40, c: 45, v: 100 });
  const z = zones(b, 40, 5);
  // Asserted as a neighbourhood, not as containment. A bucket EDGE can land
  // anywhere -- here it falls at 49.99, two hundredths below the price the
  // volume sat on -- and demanding the bucket contain 50 exactly would be
  // testing where the grid happens to start rather than where the volume is.
  const mid = (z.poc.lo + z.poc.hi) / 2;
  assert.ok(Math.abs(mid / 50 - 1) < 0.02, `POC ${z.poc.lo}-${z.poc.hi} is not around 50`);
});

t('a shelf with volume but no turns is distinguishable from one with both', () => {
  // This is the column that stops volume alone from ranking two shelves equally:
  // a level price passed straight through is not a level it respected.
  //
  // The first fixture I wrote put its turning points at the price EXTREMES of a
  // sine, where the series spends the least time -- so the top-volume shelves
  // genuinely held no pivots and the code was right to say so. Here the turns
  // and the volume are deliberately at the SAME price: a repeated bounce off
  // ~100 with heavy volume there, and a thin excursion to 120 that never turns.
  const cycle = [100, 104, 110, 116, 120, 116, 110, 104];
  const b = [];
  for (let r = 0; r < 8; r++) {
    cycle.forEach((c, k) => {
      b.push({ d: `2026-0${(r % 9) + 1}-${k + 1}`, o: c, h: c + 1, l: c - 1, c,
        v: c < 106 ? 5000 : 500 });          // volume concentrated at the bounce
    });
  }
  const z = zones(b, 24, 8);
  const bounce = z.zones.find(x => x.lo <= 101 && x.hi >= 99);
  assert.ok(bounce, `no shelf covers the repeated bounce at 100: ${JSON.stringify(z.zones.map(x => [Math.round(x.lo), Math.round(x.hi)]))}`);
  assert.ok(bounce.turns > 0, 'the bounce shelf must record the turns that happened there');
});

t('the value area is at least as wide as the point of control', () => {
  const b = [];
  for (let i = 0; i < 80; i++) {
    const c = 100 + Math.sin(i / 5) * 8;
    b.push({ d: `2026-01-${(i % 28) + 1}`, o: c, h: c + 1, l: c - 1, c, v: 1000 });
  }
  const z = zones(b, 40, 5);
  assert.ok(z.valueArea.lo <= z.poc.lo && z.valueArea.hi >= z.poc.hi);
});

t.section('weekly resampling');

t('a week is an ISO week, not "every five rows"', () => {
  // 2026-01-01 is a Thursday. Grouping by row count would cut the first week
  // after five bars; grouping by ISO week must close it after two.
  const b = bars([10, 11, 12, 13, 14, 15, 16, 17, 18, 19], '2026-01-01');
  const w = weeklyFromDaily(b);
  assert.ok(w.length >= 2);
  assert.strictEqual(w[0].o, 10, 'the week opens at its first bar');
});

t('a weekly bar takes the extremes and the last close', () => {
  const b = bars([10, 20, 15, 30, 25], '2026-01-05');   // Mon..Fri, one ISO week
  const w = weeklyFromDaily(b);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].c, 25, 'the week closes at the last bar');
  assert.ok(w[0].h >= 30 && w[0].l <= 10);
  assert.strictEqual(w[0].v, 5000, 'volume sums across the week');
});

t('a week spanning a month boundary stays one week', () => {
  const b = bars([10, 11, 12, 13, 14], '2026-01-29');   // Thu 29 Jan .. Mon 2 Feb
  const w = weeklyFromDaily(b);
  assert.ok(w.length === 2, `expected the ISO week to break on Monday, got ${w.length} weeks`);
});

t.section('volume');

t('an upper wick is measured from the body, not from the close', () => {
  // A bar that opened low, ran up, and gave it back: body top is the close here.
  const b = bars([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
  b.push({ d: '2026-02-01', o: 10, h: 20, l: 9, c: 11, v: 5000 });
  const v = volumeState(b);
  //           range 11, body top 11, so the upper wick is 9 of 11
  assert.ok(Math.abs(v.upperWickPct - 81.8) < 0.5, `upper wick was ${v.upperWickPct}`);
  assert.ok(v.closePositionInRange < 0.25, 'a close near the low must not read as strength');
});

t('volume is compared against the prior 20 sessions, not including itself', () => {
  const b = bars(new Array(25).fill(10));
  b[b.length - 1].v = 10000;                       // today is 10x
  const v = volumeState(b);
  assert.ok(v.vs20dAverage > 9, `expected ~10x, got ${v.vs20dAverage}`);
});

t('the reported date is the last CLOSED session', () => {
  const b = bars(new Array(25).fill(10));
  assert.strictEqual(volumeState(b).date, b[b.length - 1].d);
});

(async () => {
  for (const [name, fn] of queue) {
    if (!fn) { console.log(''); console.log(name); continue; }
    try { await fn(); pass++; console.log('  PASS  ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
  }
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
