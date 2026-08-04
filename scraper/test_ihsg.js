/**
 * Tests for modules/ihsg.js — the partial-bar guard and the skip rule.
 *
 * The guard exists because Yahoo returns the CURRENT session as a candle while
 * it is still trading, and the old code wrote it straight into the series the
 * 200-day regime filter reads. It was overwritten that evening, which made the
 * error temporary and invisible rather than harmless.
 */
'use strict';

const assert = require('assert');
const { dropUnclosedSession, wibNow, toDateStr, IDX_CLOSE_WIB_MINUTES } = require('./modules/ihsg');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

// WIB is UTC+7, so 03:00 UTC is 10:00 WIB — mid-session — and 10:00 UTC is
// 17:00 WIB, after the close.
const MIDSESSION = new Date('2026-08-04T03:00:00Z');
const AFTER_CLOSE = new Date('2026-08-04T10:00:00Z');
const BEFORE_OPEN = new Date('2026-08-04T01:00:00Z');   // 08:00 WIB

const bars = [
  { date: '2026-07-31', close: 6236 },
  { date: '2026-08-03', close: 6250 },
  { date: '2026-08-04', close: 6300 },   // today
];

console.log('\nihsg — WIB clock');

t('a UTC instant maps to the right WIB date and minute', () => {
  const w = wibNow(MIDSESSION);
  assert.strictEqual(w.date, '2026-08-04');
  assert.strictEqual(w.minutes, 10 * 60);
});

t('late UTC on one day is already the next day in WIB', () => {
  // 18:00 UTC on the 3rd is 01:00 WIB on the 4th.
  assert.strictEqual(wibNow(new Date('2026-08-03T18:00:00Z')).date, '2026-08-04');
});

console.log('\nihsg — the partial-bar guard');

t("today's candle is DROPPED while the session is still running", () => {
  const kept = dropUnclosedSession(bars, MIDSESSION);
  assert.deepStrictEqual(kept.map(b => b.date), ['2026-07-31', '2026-08-03'],
    'a provisional close must never enter the series the regime filter reads');
});

t("today's candle is KEPT once the session has closed", () => {
  const kept = dropUnclosedSession(bars, AFTER_CLOSE);
  assert.deepStrictEqual(kept.map(b => b.date), ['2026-07-31', '2026-08-03', '2026-08-04']);
});

t("today's candle is dropped before the open too", () => {
  const kept = dropUnclosedSession(bars, BEFORE_OPEN);
  assert.deepStrictEqual(kept.map(b => b.date), ['2026-07-31', '2026-08-03']);
});

t('a future-dated candle is never trusted', () => {
  const kept = dropUnclosedSession(
    [...bars, { date: '2026-08-05', close: 9999 }], AFTER_CLOSE);
  assert.ok(!kept.some(b => b.date === '2026-08-05'));
});

t('past sessions are always kept, whatever time it is', () => {
  for (const now of [MIDSESSION, AFTER_CLOSE, BEFORE_OPEN]) {
    const kept = dropUnclosedSession(bars, now);
    assert.ok(kept.some(b => b.date === '2026-07-31'), 'a closed session must survive');
    assert.ok(kept.some(b => b.date === '2026-08-03'));
  }
});

t('an empty input yields an empty output rather than throwing', () => {
  assert.deepStrictEqual(dropUnclosedSession([], MIDSESSION), []);
});

t('the cutoff leaves room after the 16:00 close for the closing auction', () => {
  assert.ok(IDX_CLOSE_WIB_MINUTES >= 16 * 60, 'must not be before the close');
  assert.ok(IDX_CLOSE_WIB_MINUTES <= 17 * 60, 'but must still allow a same-evening refresh');
});

console.log('\nihsg — the regression this prevents');

t('the old behaviour would have stored an unfinished session as a close', () => {
  // No guard: every candle Yahoo returns goes in, including the live one.
  const oldWay = bars;
  assert.ok(oldWay.some(b => b.date === '2026-08-04'));
  assert.ok(!dropUnclosedSession(bars, MIDSESSION).some(b => b.date === '2026-08-04'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
