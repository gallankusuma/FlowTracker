// Geometry and taxonomy tests for EXP-028.
//
// Everything in the 101-pattern taxonomy is thresholds over the primitives in
// candle_geometry.js, so an error here is an error in every pattern at once.
// Hand-built bars with arithmetic that can be checked by eye — no database.
'use strict';

const assert = require('assert');
const g = require('./research/candlestick/candle_geometry');
const tax = require('./research/candlestick/pattern_taxonomy_v1');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\ngeometry primitives');
test('a plain bullish bar decomposes exactly', () => {
  // O=100 H=110 L=95 C=105 -> range 15, body 5, upper 5, lower 5
  const r = g.candleGeometry({ open: 100, high: 110, low: 95, close: 105 });
  assert.ok(r.resolved);
  assert.strictEqual(r.range, 15);
  assert.strictEqual(r.body, 5);
  assert.strictEqual(r.upperWick, 5);
  assert.strictEqual(r.lowerWick, 5);
  assert.ok(near(r.bodyRatio, 5 / 15));
  assert.ok(near(r.closeLocation, (105 - 95) / 15));
  assert.strictEqual(r.direction, 1);
});

test('wicks are measured from the BODY, not from open', () => {
  // bearish: O=110 C=100, so body top is the OPEN
  const r = g.candleGeometry({ open: 110, high: 115, low: 95, close: 100 });
  assert.strictEqual(r.upperWick, 5);   // 115 - 110
  assert.strictEqual(r.lowerWick, 5);   // 100 - 95
  assert.strictEqual(r.direction, -1);
});

test('ratios sum to one, which is the invariant everything else rests on', () => {
  const r = g.candleGeometry({ open: 100, high: 110, low: 95, close: 105 });
  assert.ok(near(r.bodyRatio + r.upperWickRatio + r.lowerWickRatio, 1));
});

console.log('\nunresolved is a stated reason, never a quiet false');
test('zero range is refused rather than dividing by zero', () => {
  const r = g.candleGeometry({ open: 100, high: 100, low: 100, close: 100 });
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.reason, g.UNRESOLVED.ZERO_RANGE);
  assert.strictEqual(r.bodyRatio, null);
});

test('a self-contradicting bar is corrupt, not merely odd', () => {
  assert.strictEqual(g.candleGeometry({ open: 100, high: 90, low: 95, close: 92 }).reason,
    g.UNRESOLVED.INCONSISTENT);
  // close above the high
  assert.strictEqual(g.candleGeometry({ open: 100, high: 110, low: 95, close: 120 }).reason,
    g.UNRESOLVED.INCONSISTENT);
});

test('missing and non-positive prices are distinguished', () => {
  assert.strictEqual(g.candleGeometry({ open: 100, high: 110, low: 95 }).reason, g.UNRESOLVED.MISSING_OHLC);
  assert.strictEqual(g.candleGeometry({ open: 0, high: 0, low: 0, close: 0 }).reason, g.UNRESOLVED.NON_POSITIVE);
});

test('THE ASJT BAD PRINT IS REFUSED: 463 -> 8 is not a session', () => {
  const r = g.candleGeometry({ open: 8, high: 8, low: 8, close: 8 }, { prevClose: 463 });
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.reason, g.UNRESOLVED.IMPLAUSIBLE_MOVE);
});

test('a large but plausible move is NOT refused', () => {
  // +30% is inside IDX auto-rejection; refusing it would delete real limit-up days
  const r = g.candleGeometry({ open: 100, high: 132, low: 100, close: 130 }, { prevClose: 100 });
  assert.ok(r.resolved);
});

console.log('\ntick resolution is reported, not silently enforced');
test('a 2-tick range is resolved but flagged unreliable', () => {
  // close 100 -> tick size 1; range 110-95 would be 15 ticks, so use a tight bar
  const r = g.candleGeometry({ open: 100, high: 101, low: 99, close: 100.5 });
  assert.ok(r.resolved, 'still resolved — the caller decides, not this helper');
  assert.strictEqual(r.ticksInRange, 2);
  assert.strictEqual(r.geometryReliable, false);
});

test('tick size follows the IDX price bands', () => {
  assert.strictEqual(g.tickSize(150), 1);
  assert.strictEqual(g.tickSize(300), 2);
  assert.strictEqual(g.tickSize(1000), 5);
  assert.strictEqual(g.tickSize(3000), 10);
  assert.strictEqual(g.tickSize(9000), 25);
});

console.log('\nATR refuses a partial window rather than averaging a short one');
test('ATR is null until the full period is available', () => {
  const bars = Array.from({ length: 20 }, (_, k) => ({ open: 100, high: 105, low: 95, close: 100 + k }));
  assert.strictEqual(g.atrAt(bars, 5, 14), null);
  assert.ok(g.atrAt(bars, 14, 14) > 0);
});

console.log('\ngeometrySeries keeps index alignment');
test('a refused bar keeps its slot so bar i-1 is never the wrong bar', () => {
  const bars = [
    { open: 100, high: 110, low: 95, close: 105 },
    { open: 100, high: 100, low: 100, close: 100 },  // zero range -> unresolved
    { open: 105, high: 115, low: 100, close: 110 },
  ];
  const geo = g.geometrySeries(bars);
  assert.strictEqual(geo.length, 3);
  assert.strictEqual(geo[1].resolved, false);
  assert.ok(geo[2].resolved);
});

console.log('\ntaxonomy — shape rules');
const mk = (o, h, l, c) => ({ open: o, high: h, low: l, close: c });
function detect(id, bars, i) {
  const p = tax.PATTERNS.find(x => x.id === id);
  const geo = g.geometrySeries(bars);
  const trend = tax.priorTrend(bars, i, p.candleCount);
  return p.match({ geo, bars, i, trend });
}
/** 7 flat bars then a decline, so a pattern at the end sits in a DOWN trend. */
function downtrendPrefix(from = 200) {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const c = from - k * 6;                       // ~-3% per bar, clearly DOWN
    out.push(mk(c + 1, c + 2, c - 2, c));
  }
  return out;
}
function uptrendPrefix(from = 100) {
  const out = [];
  for (let k = 0; k < 8; k++) {
    const c = from + k * 6;
    out.push(mk(c - 1, c + 2, c - 2, c));
  }
  return out;
}

test('HAMMER needs the downtrend — the identical shape in an uptrend is not one', () => {
  const shape = mk(150, 152, 130, 151);   // tiny body on top, long lower shadow
  const down = [...downtrendPrefix(), shape];
  assert.strictEqual(detect('HAMMER_V1', down, down.length - 1), true);
  const up = [...uptrendPrefix(), shape];
  assert.strictEqual(detect('HAMMER_V1', up, up.length - 1), false);
});

test('HANGING MAN is that same shape, and needs the uptrend', () => {
  const shape = mk(150, 152, 130, 151);
  const up = [...uptrendPrefix(), shape];
  assert.strictEqual(detect('HANGING_MAN_V1', up, up.length - 1), true);
  const down = [...downtrendPrefix(), shape];
  assert.strictEqual(detect('HANGING_MAN_V1', down, down.length - 1), false);
});

test('DOJI is body <= 5% of range and carries no trend requirement', () => {
  const bars = [...uptrendPrefix(), mk(100, 110, 90, 100.5)];
  assert.strictEqual(detect('DOJI_V1', bars, bars.length - 1), true);
  const fat = [...uptrendPrefix(), mk(100, 110, 90, 108)];
  assert.strictEqual(detect('DOJI_V1', fat, fat.length - 1), false);
});

test('MARUBOZU requires almost the whole range to be body, and a direction', () => {
  const bulls = [...uptrendPrefix(), mk(100, 110.2, 99.8, 110)];
  assert.strictEqual(detect('MARUBOZU_BULL_V1', bulls, bulls.length - 1), true);
  assert.strictEqual(detect('MARUBOZU_BEAR_V1', bulls, bulls.length - 1), false);
});

console.log('\ntaxonomy — two-candle rules');
test('BULLISH ENGULFING needs the body to wrap the prior body, not just the range', () => {
  const pre = downtrendPrefix();
  const prev = mk(150, 152, 144, 145);                  // black body 145..150
  const wraps = [...pre, prev, mk(144, 156, 143, 152)]; // white body 144..152 wraps it
  assert.strictEqual(detect('BULLISH_ENGULFING_V1', wraps, wraps.length - 1), true);
  const inside = [...pre, prev, mk(146, 156, 143, 149)]; // white body 146..149 does NOT
  assert.strictEqual(detect('BULLISH_ENGULFING_V1', inside, inside.length - 1), false);
});

test('PIERCING LINE must open below the prior LOW and close past the midpoint', () => {
  const pre = downtrendPrefix();
  const prev = mk(160, 162, 140, 142);                  // black, midpoint 151
  const ok = [...pre, prev, mk(139, 156, 138, 155)];    // opens < 140, closes 155 > 151, < 160
  assert.strictEqual(detect('PIERCING_LINE_V1', ok, ok.length - 1), true);
  const shallow = [...pre, prev, mk(139, 150, 138, 148)]; // closes 148 < midpoint
  assert.strictEqual(detect('PIERCING_LINE_V1', shallow, shallow.length - 1), false);
  const noGap = [...pre, prev, mk(141, 156, 140, 155)];   // opens above the prior low
  assert.strictEqual(detect('PIERCING_LINE_V1', noGap, noGap.length - 1), false);
});

console.log('\ntrend is measured strictly before the pattern');
test('the signal bar cannot qualify itself', () => {
  // Flat prefix, then one huge up bar as the pattern candle. Trend must read
  // FLAT: if the signal bar leaked in, it would read UP.
  const flat = Array.from({ length: 8 }, () => mk(100, 101, 99, 100));
  const bars = [...flat, mk(100, 140, 100, 138)];
  assert.strictEqual(tax.priorTrend(bars, bars.length - 1, 1), tax.TREND.FLAT);
});

test('for a 2-candle pattern the window ends before the FIRST candle', () => {
  const flat = Array.from({ length: 8 }, () => mk(100, 101, 99, 100));
  const bars = [...flat, mk(100, 140, 100, 138), mk(138, 145, 137, 144)];
  assert.strictEqual(tax.priorTrend(bars, bars.length - 1, 2), tax.TREND.FLAT);
});

test('trend is null when there is not enough history to state one', () => {
  const bars = [mk(100, 101, 99, 100), mk(100, 101, 99, 100)];
  assert.strictEqual(tax.priorTrend(bars, 1, 1), null);
});

console.log('\ntaxonomy provenance');
test('the hash is stable across calls', () => {
  assert.strictEqual(tax.taxonomyHash(), tax.taxonomyHash());
});

test('every pattern is well formed and ids are unique', () => {
  const ids = new Set();
  for (const p of tax.PATTERNS) {
    assert.ok(p.id && p.name && p.family && p.direction, `${p.id} missing a field`);
    assert.ok(p.candleCount >= 1 && p.candleCount <= 3, `${p.id} candleCount`);
    assert.strictEqual(typeof p.match, 'function', `${p.id} match`);
    assert.ok(p.source, `${p.id} has no source reference`);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
  }
  assert.ok(tax.PATTERNS.length >= 10, 'fixture set should span at least 10 patterns');
});

test('mirrored pairs really are mirrored, not copy-paste with one edit missed', () => {
  const pairs = [['HAMMER_V1', 'HANGING_MAN_V1'], ['INVERTED_HAMMER_V1', 'SHOOTING_STAR_V1'],
                 ['BULLISH_ENGULFING_V1', 'BEARISH_ENGULFING_V1'], ['PIERCING_LINE_V1', 'DARK_CLOUD_COVER_V1']];
  for (const [a, b] of pairs) {
    const pa = tax.PATTERNS.find(p => p.id === a), pb = tax.PATTERNS.find(p => p.id === b);
    assert.strictEqual(pa.candleCount, pb.candleCount, `${a}/${b} candleCount differs`);
    assert.notStrictEqual(pa.direction, pb.direction, `${a}/${b} share a direction`);
    assert.notStrictEqual(pa.priorContextRequired, pb.priorContextRequired, `${a}/${b} share a prior context`);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
