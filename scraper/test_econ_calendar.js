'use strict';
/**
 * Economic calendar parsing — the figures, and the missing ones.
 *
 * The whole value of this feed is `consensus`, and the one way to destroy it is
 * to turn a blank into a zero. A missing consensus coerced to 0 becomes a
 * forecast of "no change" that nobody made, and every surprise computed against
 * it is fiction that looks like data. Upstream sends blanks as `" "` and
 * `"&nbsp;"`, never as an absent field, so `Number(x) || 0` produces exactly
 * that failure silently.
 *
 * Run: node test_econ_calendar.js
 */

const assert = require('assert');
const { parseFigure, rowUnit, dateRange, feedToRelease, saveDay } = require('./econ_calendar_fetcher');

let pass = 0, fail = 0;

/**
 * Async-aware on purpose. The synchronous version of this helper -- the one used
 * elsewhere in this suite -- swallows a returned promise: the assertion inside
 * settles after `t` has already counted a pass, so a failing async test reports
 * green. Three of the tests below exercise saveDay() and are async, so the
 * runner queues everything and awaits it in order.
 */
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
/** Headings are queued too, or they would all print before the first test runs. */
t.section = title => queue.push([title, null]);

async function run() {
  for (const [name, fn] of queue) {
    if (!fn) { console.log(''); console.log(name); continue; }
    try { await fn(); pass++; console.log('  PASS  ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
  }
}


t.section('figures that were measured');

t('a plain number carries no unit', () => {
  assert.deepStrictEqual(parseFigure('99.8'), { value: 99.8, unit: null });
});

t('percent, including negative', () => {
  assert.deepStrictEqual(parseFigure('2.6%'), { value: 2.6, unit: '%' });
  assert.deepStrictEqual(parseFigure('-1.7%'), { value: -1.7, unit: '%' });
});

t('K, M, B and T are kept as units, not silently multiplied', () => {
  // Storing 11.00K as 11000 would make it incomparable with the previous
  // reading if that one printed in millions. The unit travels with the number.
  assert.deepStrictEqual(parseFigure('11.00K'), { value: 11, unit: 'K' });
  assert.deepStrictEqual(parseFigure('4.06M'), { value: 4.06, unit: 'M' });
  assert.deepStrictEqual(parseFigure('-0.500M'), { value: -0.5, unit: 'M' });
  assert.deepStrictEqual(parseFigure('1.25B'), { value: 1.25, unit: 'B' });
});

t('thousands separators do not truncate the number', () => {
  // parseFloat('1,234') is 1. Stripping the comma is not cosmetic.
  assert.deepStrictEqual(parseFigure('1,234.5'), { value: 1234.5, unit: null });
  assert.deepStrictEqual(parseFigure('1,234.5%'), { value: 1234.5, unit: '%' });
});

t('a yield prints as a percent', () => {
  assert.deepStrictEqual(parseFigure('4.291%'), { value: 4.291, unit: '%' });
});

t.section('figures that were NOT measured — none of these may become 0');

t('the blank forms upstream actually sends', () => {
  for (const blank of [' ', '&nbsp;', '', '   ', '-', '--', null, undefined]) {
    const r = parseFigure(blank);
    assert.strictEqual(r.value, null,
      `${JSON.stringify(blank)} parsed to ${r.value}; a consensus nobody gave must not become a forecast`);
  }
});

t('an unmeasured figure is distinguishable from a measured zero', () => {
  // The distinction the whole design turns on: 0.0% is a real forecast of no
  // change; a blank is the absence of a forecast.
  assert.strictEqual(parseFigure('0.0%').value, 0);
  assert.strictEqual(parseFigure(' ').value, null);
  assert.notStrictEqual(parseFigure('0.0%').value, parseFigure(' ').value);
});

t('junk is null rather than a number invented from a prefix', () => {
  // parseFloat('4.06 est.') would happily return 4.06.
  for (const junk of ['n/a', 'TBD', 'Holiday', '4.06 est.', '<0.1', '≈2']) {
    assert.strictEqual(parseFigure(junk).value, null, `${junk} parsed to a number`);
  }
});

t.section('the unit of a row');

t('actual decides the unit, not a blank consensus', () => {
  const a = parseFigure('4.06M'), c = parseFigure(' '), p = parseFigure('4.13M');
  assert.strictEqual(rowUnit(a, p, c), 'M');
});

t('previous supplies the unit when the release has not printed yet', () => {
  // A scheduled-but-unreleased event: actual blank, previous known.
  assert.strictEqual(rowUnit(parseFigure(' '), parseFigure('2.6%'), parseFigure('2.5%')), '%');
});

t('an all-blank row simply has no unit', () => {
  assert.strictEqual(rowUnit(parseFigure(' '), parseFigure('&nbsp;'), parseFigure(' ')), null);
});

t.section('the date walk');

t('the range is inclusive at both ends', () => {
  assert.deepStrictEqual(dateRange('2026-08-19', '2026-08-21'),
    ['2026-08-19', '2026-08-20', '2026-08-21']);
});

t('weekends are included — releases happen on them', () => {
  // 2026-08-22 is a Saturday. Skipping weekends to save requests would drop
  // Chinese and OPEC releases and leave a hole shaped like "no events".
  const r = dateRange('2026-08-21', '2026-08-24');
  assert.strictEqual(r.length, 4);
  assert.ok(r.includes('2026-08-22') && r.includes('2026-08-23'));
});

t('a single-day range is one date, not zero', () => {
  assert.deepStrictEqual(dateRange('2026-08-21', '2026-08-21'), ['2026-08-21']);
});

t('a month boundary does not stall or skip', () => {
  assert.deepStrictEqual(dateRange('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
});

t('a leap day is walked', () => {
  assert.ok(dateRange('2024-02-27', '2024-03-01').includes('2024-02-29'));
});


t.section('the feed files everything one day late, on a clock that is not GMT');

// These are not invented fixtures. Each is a release whose real date and time
// are public and fixed, so the correction can be checked rather than believed.

t('Dec-2022 CPI: released 2023-01-12 08:30 ET, filed under 2023-01-13 09:30', () => {
  const r = feedToRelease('2023-01-13', '09:30');
  assert.strictEqual(r.releaseDate, '2023-01-12');
  assert.strictEqual(r.releaseTimeEt, '08:30');
  assert.strictEqual(r.releaseUtc.toISOString().slice(0, 16), '2023-01-12T13:30');
});

t('a summer CPI lands on the SAME ET clock from a DIFFERENT printed time', () => {
  // This pair is the strongest single check. US CPI is 08:30 ET all year. The
  // feed prints 09:30 in January and 08:30 in August; both must come back as
  // 08:30 ET. Only a fixed GMT-4 clock behaves this way -- a real GMT field, or
  // a real ET field, would fail one of the two.
  const winter = feedToRelease('2023-01-13', '09:30');
  const summer = feedToRelease('2026-08-13', '08:30');
  assert.strictEqual(winter.releaseTimeEt, '08:30');
  assert.strictEqual(summer.releaseTimeEt, '08:30');
  assert.strictEqual(summer.releaseDate, '2026-08-12');
});

t('MBA Mortgage Applications is a Wednesday release, filed on Thursday', () => {
  // 2023-01-12 was a Thursday; MBA publishes Wednesday 07:00 ET.
  const r = feedToRelease('2023-01-12', '08:00');
  assert.strictEqual(r.releaseDate, '2023-01-11');
  assert.strictEqual(r.releaseTimeEt, '07:00');
  assert.strictEqual(new Date(r.releaseDate + 'T12:00:00Z').getUTCDay(), 3, 'must land on a Wednesday');
});

t('Initial Jobless Claims is a Thursday release, filed on Friday', () => {
  const r = feedToRelease('2023-01-13', '09:30');
  assert.strictEqual(new Date(r.releaseDate + 'T12:00:00Z').getUTCDay(), 4, 'must land on a Thursday');
});

t('the date correction applies even when no time was printed', () => {
  // Speeches and reports often print no clock. The +1 day is a FILING
  // convention and has nothing to do with the clock, so it still applies.
  const r = feedToRelease('2023-01-13', null);
  assert.strictEqual(r.releaseDate, '2023-01-12');
  assert.strictEqual(r.releaseTimeEt, null);
  assert.strictEqual(r.releaseUtc, null);
});

t('a row printed just after midnight belongs to the previous ET evening', () => {
  // Asian sessions. 00:30 GMT-4 is 23:30 ET the day before, so release_date is
  // NOT simply feed_date minus one here -- which is why the ET date is derived
  // rather than subtracted.
  const r = feedToRelease('2023-01-13', '00:30');
  assert.strictEqual(r.releaseDate, '2023-01-11');
  assert.strictEqual(r.releaseTimeEt, '23:30');
});

t('a garbled time degrades to no time, never to midnight', () => {
  // '' parsed as 00:00 would silently move the row to the previous evening.
  for (const bad of ['', 'All Day', 'Tentative', '99:99']) {
    const r = feedToRelease('2023-01-13', bad);
    assert.strictEqual(r.releaseTimeEt, null, `${JSON.stringify(bad)} produced a time`);
    assert.strictEqual(r.releaseDate, '2023-01-12');
  }
});

t.section('seq, which is what tells same-named rows apart');

t('five CPI rows at one timestamp get five distinct keys', async () => {
  // A US CPI day really does look like this. Without seq the upsert would
  // collapse them into one row and four series would vanish.
  const rows = [
    { gmt: '08:30', country: 'United States', eventName: 'Core CPI', actual: '0.2%', consensus: '0.3%', previous: '0.2%' },
    { gmt: '08:30', country: 'United States', eventName: 'Core CPI', actual: '3.1%', consensus: '3.0%', previous: '2.9%' },
    { gmt: '08:30', country: 'United States', eventName: 'CPI', actual: '0.4%', consensus: '0.3%', previous: '0.3%' },
    { gmt: '08:30', country: 'United States', eventName: 'CPI', actual: '2.8%', consensus: '2.7%', previous: '2.7%' },
    { gmt: '08:30', country: 'United States', eventName: 'CPI Index, n.s.a.', actual: '324.10', consensus: ' ', previous: '323.05' },
  ];
  const captured = [];
  const fakePool = { query: (sql, params) => { captured.push(params[0]); return Promise.resolve(); } };
  const res = await saveDay(fakePool, '2026-08-13', rows);

  assert.strictEqual(res.written, 5);
  assert.strictEqual(res.withConsensus, 4, 'the index row has no consensus and must not be counted');

  const keys = captured[0].map(v => `${v[5]}|${v[6]}|${v[1]}|${v[7]}`);
  assert.strictEqual(new Set(keys).size, 5, `keys collided: ${JSON.stringify(keys)}`);

  // seq restarts per name, so Core CPI is 0,1 and CPI is 0,1 -- not 0..3.
  const coreSeqs = captured[0].filter(v => v[6] === 'Core CPI').map(v => v[7]);
  assert.deepStrictEqual(coreSeqs, [0, 1]);

  // And the blank consensus is stored as SQL NULL.
  const indexRow = captured[0].find(v => v[6] === 'CPI Index, n.s.a.');
  assert.strictEqual(indexRow[10], null, 'a blank consensus reached the INSERT as a number');

  // And the rows are keyed to the REAL release date, one day before the feed's.
  assert.strictEqual(captured[0][0][0], '2026-08-12', 'the +1 filing offset was not undone');
});

t('a row missing a name or country is dropped, not written blank', () => {
  const captured = [];
  const fakePool = { query: (sql, params) => { captured.push(params[0]); return Promise.resolve(); } };
  return saveDay(fakePool, '2026-08-13', [
    { gmt: '08:30', country: '', eventName: 'Orphan', actual: '1' },
    { gmt: '08:30', country: 'United States', eventName: '', actual: '1' },
    { gmt: '08:30', country: 'United States', eventName: 'Real', actual: '1' },
  ]).then(res => {
    assert.strictEqual(res.written, 1);
    assert.strictEqual(captured[0][0][6], 'Real');
  });
});

t.section('what saveDay actually stores');

t('the corrected ET time is stored, and the raw one kept beside it', () => {
  const captured = [];
  const fakePool = { query: (sql, params) => { captured.push(params[0]); return Promise.resolve(); } };
  return saveDay(fakePool, '2026-08-13', [
    { gmt: '08:30', country: 'United States', eventName: 'CPI', actual: '2.8%', consensus: '2.7%', previous: '2.7%' },
  ]).then(() => {
    // The stored time is REAL Eastern. August, so the printed 08:30 already is
    // Eastern; the winter case is covered by the fixtures above.
    assert.strictEqual(captured[0][0][1], '08:30');
    assert.strictEqual(captured[0][0][4], '08:30', 'the raw feed time must be kept for audit');
  });
});

run().then(() => {
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
