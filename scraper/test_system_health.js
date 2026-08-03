// Tests for modules/system_health.js — the kill switch.
//
// The point of a kill switch is what it does when things are BROKEN, so a test
// that only confirms "healthy system reports healthy" proves nothing. These
// drive it through the two failure modes that actually happened on this box:
// a job failing repeatedly and unnoticed (signal_engine.py hk, 45 consecutive
// SyntaxErrors), and a table going quietly stale (idx_ihsg_history, July 2026).
'use strict';

const assert = require('assert');
const sh = require('./modules/system_health');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

// Minimal fake pool: returns canned rows per query shape.
function makePool(spec) {
  return {
    async query(sql, params) {
      if (/CREATE TABLE/i.test(sql)) return [{}];
      if (/COUNT\(\*\) AS n FROM idx_ihsg_history WHERE date >/i.test(sql)) {
        return [[{ n: spec.lag[params[0]] ?? 0 }]];
      }
      const m = sql.match(/MAX\((\w+)\) AS d, COUNT\(\*\) AS n FROM (\w+)/i);
      if (m) {
        const t = m[2];
        const v = spec.tables[t];
        return [[{ d: v === null ? null : v, n: v === null ? 0 : 100 }]];
      }
      if (/FROM ft_system_health h/i.test(sql)) return [spec.jobs || []];
      if (/consecutive|status = 'FAILED'/i.test(sql) || /COUNT\(\*\) AS n FROM ft_system_health/i.test(sql)) {
        const job = params && params[0];
        return [[{ n: (spec.failCounts && spec.failCounts[job]) || 0 }]];
      }
      return [[]];
    },
  };
}

const ALL_FRESH = {
  tables: { idx_stock_prices: '2026-07-31', idx_broker_summary: '2026-07-31',
            idx_concentration: '2026-07-31', idx_ihsg_history: '2026-07-31' },
  lag: { '2026-07-31': 0 },
};

(async () => {
  console.log('\nsignalState — healthy baseline');
  {
    const s = await sh.signalState(makePool(ALL_FRESH));
    test('all data fresh, no failing jobs -> ENABLED', () => assert.strictEqual(s.enabled, true));
    test('no blocking reasons when healthy', () => assert.strictEqual(s.reasons.length, 0));
  }

  console.log('\nthe July 2026 failure mode: a critical table goes quietly stale');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_ihsg_history = '2026-07-24';
    spec.lag = { '2026-07-31': 0, '2026-07-24': 5 };
    const s = await sh.signalState(makePool(spec));
    test('stale IHSG DISABLES signals', () => assert.strictEqual(s.enabled, false));
    test('reason is machine-readable and names the table', () =>
      assert.ok(s.reasons.some(r => r.startsWith('STALE_CRITICAL:ihsg')), JSON.stringify(s.reasons)));
  }

  console.log('\nnon-critical staleness warns but does not disable');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_broker_summary = '2026-07-20';
    spec.lag = { '2026-07-31': 0, '2026-07-20': 8 };
    const s = await sh.signalState(makePool(spec));
    test('stale broker feed does NOT disable (veto degrades, prices do not)', () =>
      assert.strictEqual(s.enabled, true));
    test('but it is surfaced as a warning', () =>
      assert.ok(s.warnings.some(w => w.includes('broker')), JSON.stringify(s.warnings)));
  }

  console.log('\nthe HK failure mode: a job failing repeatedly and unnoticed');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.jobs = [{ job_name: 'signal_engine_hk', status: 'FAILED', finished_at: null, error: 'SyntaxError' }];
    spec.failCounts = { signal_engine_hk: 45 };
    const s = await sh.signalState(makePool(spec));
    test('45 consecutive failures DISABLES signals', () => assert.strictEqual(s.enabled, false));
    test('reason names the job and the count', () =>
      assert.ok(s.reasons.some(r => r.startsWith('JOB_FAILING:signal_engine_hk')), JSON.stringify(s.reasons)));
  }
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.jobs = [{ job_name: 'nightly_cron', status: 'FAILED', finished_at: null, error: 'timeout' }];
    spec.failCounts = { nightly_cron: 2 };
    const s = await sh.signalState(makePool(spec));
    test('two failures is tolerated — transient errors must not flap the switch', () =>
      assert.strictEqual(s.enabled, true));
  }

  console.log('\nmodel version mismatch');
  {
    const s = await sh.signalState(makePool(ALL_FRESH),
      { expectedModelVersion: '4.1.0-research', actualModelVersion: '4.0.0-research' });
    test('a version mismatch DISABLES signals', () => assert.strictEqual(s.enabled, false));
    test('reason is MODEL_VERSION_MISMATCH', () =>
      assert.ok(s.reasons.some(r => r.startsWith('MODEL_VERSION_MISMATCH')), JSON.stringify(s.reasons)));
  }

  console.log('\nempty table is treated as broken, not as fresh');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_ihsg_history = null;
    const s = await sh.signalState(makePool(spec));
    test('an empty critical table DISABLES signals', () => assert.strictEqual(s.enabled, false));
  }

  console.log('\nrecording must never break the job it records');
  {
    const brokenPool = { async query() { throw new Error('db down'); } };
    let threw = false;
    try { await sh.recordJobRun(brokenPool, { job: 'x', status: 'OK' }); } catch { threw = true; }
    test('recordJobRun swallows its own DB errors', () => assert.strictEqual(threw, false));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
