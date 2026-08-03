/**
 * Tests for modules/conviction.js shadow mode (review P1, 2026-08-03).
 *
 * The point of the change is that a signal with no measured edge must size
 * NOTHING while remaining fully visible. Both halves of that need asserting:
 * a test that only checks `sizeMultiplier === 0` would pass a module that had
 * simply stopped returning anything.
 */
'use strict';

const assert = require('assert');
const c = require('./modules/conviction');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

const CASES = [
  ['harmonic, smart money confirmed', { source: 'harmonic', patternType: 'Gartley', smartMoneyConfirmed: true }],
  ['harmonic ABCD', { source: 'harmonic', patternType: 'ABCD' }],
  ['harmonic exotic', { source: 'harmonic', patternType: 'Crab' }],
  ['AWO bullish, market up', { source: 'awo', patternType: 'AWO_SIGNAL', signal: 'BUY', marketDirection: 'UP' }],
  ['AWO bullish, market flat', { source: 'awo', patternType: 'AWO_SIGNAL', signal: 'BUY', marketDirection: 'FLAT' }],
  ['AWO bearish, market up', { source: 'awo', patternType: 'AWO_SIGNAL', signal: 'SELL', marketDirection: 'UP' }],
  ['AWO bearish, market down', { source: 'awo', patternType: 'AWO_SIGNAL', signal: 'SELL', marketDirection: 'DOWN' }],
  ['unclassifiable', { source: 'awo', patternType: 'AWO_SIGNAL' }],
];

console.log('\nconviction — every path sizes nothing by default');

for (const [label, args] of CASES) {
  t(`${label}: sizeMultiplier is 0`, () => {
    assert.strictEqual(c.computeConvictionTier(args).sizeMultiplier, 0);
  });
}

t('every path is labelled SHADOW_ONLY', () => {
  for (const [label, args] of CASES) {
    assert.strictEqual(c.computeConvictionTier(args).mode, 'SHADOW_ONLY', label);
  }
});

console.log('\nconviction — visibility is preserved, only allocation is removed');

t('the tier is still returned, so badges still render', () => {
  for (const [label, args] of CASES) {
    const r = c.computeConvictionTier(args);
    assert.ok(typeof r.tier === 'string' && r.tier.length > 0, label);
  }
});

t('the underlying reason survives, with the shadow note appended not substituted', () => {
  const r = c.computeConvictionTier({ source: 'harmonic', patternType: 'ABCD' });
  assert.ok(/ABCD pattern/.test(r.reason), r.reason);
  assert.ok(/SHADOW_ONLY/.test(r.reason), r.reason);
});

t('the multiplier it WOULD have used is reported, so the change is auditable', () => {
  assert.strictEqual(c.computeConvictionTier({ source: 'harmonic', patternType: 'ABCD' }).sizedMultiplierIfEnabled, 0.25);
  assert.strictEqual(
    c.computeConvictionTier({ source: 'awo', patternType: 'AWO_SIGNAL', signal: 'BUY', marketDirection: 'UP' }).sizedMultiplierIfEnabled, 0.8);
});

console.log('\nconviction — the classifier underneath is unchanged');

t('classifyConvictionTier still returns the historical multipliers', () => {
  // Shadow mode must be a wrapper, not a rewrite: if the override is ever used,
  // it has to restore the documented behaviour rather than some new default.
  assert.strictEqual(c.classifyConvictionTier({ source: 'harmonic', patternType: 'ABCD' }).sizeMultiplier, 0.25);
  assert.strictEqual(c.classifyConvictionTier({ source: 'awo', patternType: 'AWO_SIGNAL', signal: 'SELL', marketDirection: 'DOWN' }).sizeMultiplier, 0.8);
  assert.strictEqual(c.classifyConvictionTier({ source: 'awo', patternType: 'AWO_SIGNAL' }).sizeMultiplier, 0.5);
});

t('classifyConvictionTier carries no shadow marker — it is the raw classification', () => {
  assert.strictEqual(c.classifyConvictionTier({ source: 'harmonic', patternType: 'ABCD' }).mode, undefined);
});

t('non-IDX markets get honest text rather than borrowed IDX statistics', () => {
  const r = c.classifyConvictionTier({ source: 'harmonic', patternType: 'ABCD', market: 'US' });
  assert.ok(/not backtested on this market/.test(r.reason), r.reason);
});

t('sizing is off unless deliberately enabled', () => {
  assert.strictEqual(c.SIZING_ENABLED, process.env.CONVICTION_SIZING === 'enabled');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
