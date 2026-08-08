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
      // The calendar's own last row. tradingDayLag needs it to know how far the
      // IHSG calendar can see — the gap that let the ihsg check measure itself
      // against itself and always report 0.
      if (/MAX\(date\) AS d FROM idx_ihsg_history/i.test(sql)) {
        return [[{ d: spec.tables.idx_ihsg_history ?? null }]];
      }
      // Reference scan: MAX(col) AS d, without the COUNT.
      const ref = sql.match(/MAX\((\w+)\) AS d FROM (\w+)/i);
      if (ref) return [[{ d: spec.tables[ref[2]] ?? null }]];
      if (/FROM ft_system_health h/i.test(sql)) return [spec.jobs || []];
      if (/consecutive|status = 'FAILED'/i.test(sql) || /COUNT\(\*\) AS n FROM ft_system_health/i.test(sql)) {
        const job = params && params[0];
        return [[{ n: (spec.failCounts && spec.failCounts[job]) || 0 }]];
      }
      return [[]];
    },
  };
}

// Pinned so these assertions do not start failing as real time passes.
const CLOCK = new Date('2026-07-31T12:00:00Z');
const ALL_FRESH = {
  tables: { idx_stock_prices: '2026-07-31', idx_broker_summary: '2026-07-31',
            idx_concentration: '2026-07-31', idx_broker_flow_detail: '2026-07-31',
            idx_ihsg_history: '2026-07-31', ft_signals: '2026-07-31' },
  lag: { '2026-07-31': 0 },
};

(async () => {
  console.log('\nsignalState — healthy baseline');
  {
    const s = await sh.signalState(makePool(ALL_FRESH), { today: CLOCK });
    test('all data fresh, no failing jobs -> ENABLED', () => assert.strictEqual(s.enabled, true));
    test('no blocking reasons when healthy', () => assert.strictEqual(s.reasons.length, 0));
  }

  console.log('\nthe July 2026 failure mode: a BLOCKING table goes quietly stale');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_ihsg_history = '2026-07-24';
    spec.lag = { '2026-07-31': 0, '2026-07-24': 5 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('stale IHSG DISABLES signals', () => assert.strictEqual(s.enabled, false));
    test('reason is machine-readable and names the table', () =>
      assert.ok(s.reasons.some(r => r.startsWith('STALE_BLOCKING:ihsg')), JSON.stringify(s.reasons)));
  }

  // THIS TEST USED TO ASSERT THE OPPOSITE, and it passed for as long as it was
  // wrong. It read: "stale broker feed does NOT disable (veto degrades, prices
  // do not)". That is the same reasoning the CHECKS table carried, and on
  // 2026-07-31 the broker feed died and this exact behaviour let the scanner
  // serve eight days of frozen scores with the kill switch green. The premise
  // was false: /api/signal-scanner takes its DATE from idx_broker_summary, so a
  // dead broker feed is a stopped clock, not a weakened veto. Kept, inverted,
  // and annotated rather than deleted — a test that encoded a wrong belief is
  // worth leaving visible.
  console.log('\nstale broker feed now BLOCKS (this assertion is inverted from its original)');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_broker_summary = '2026-07-20';
    spec.lag = { '2026-07-31': 0, '2026-07-20': 8 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('stale broker feed DISABLES signals (it is the scanner clock)', () =>
      assert.strictEqual(s.enabled, false));
    test('reason names broker at BLOCKING', () =>
      assert.ok(s.reasons.some(r => r.startsWith('STALE_BLOCKING:broker')), JSON.stringify(s.reasons)));
  }

  console.log('\nDEGRADED labels output without stopping it, and is never merely advisory');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_broker_flow_detail = '2026-07-20';
    spec.lag = { '2026-07-31': 0, '2026-07-20': 8 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('a DEGRADED input does not disable output', () => assert.strictEqual(s.enabled, true));
    test('but it sets the degraded flag, so callers cannot render it as clean', () =>
      assert.strictEqual(s.degraded, true));
    test('and it names itself', () =>
      assert.ok(s.degradedReasons.some(r => r.startsWith('flow_detail')), JSON.stringify(s.degradedReasons)));
  }

  console.log('\nseverity binding: nothing that affects correctness may be advisory');
  {
    test('every declared check carries a severity', () =>
      assert.ok(sh.CHECKS.every(c => sh.SEVERITY[c.severity]), 'a check has no valid severity'));
    test('every declared check says who it affects', () =>
      assert.ok(sh.CHECKS.every(c => Array.isArray(c.affects) && c.affects.length),
        'a check declares no affected subsystem'));
    test('DEGRADED and BLOCKING bind; INFO and ADVISORY do not', () => {
      assert.strictEqual(sh.binds(sh.SEVERITY.BLOCKING), true);
      assert.strictEqual(sh.binds(sh.SEVERITY.DEGRADED), true);
      assert.strictEqual(sh.binds(sh.SEVERITY.ADVISORY), false);
      assert.strictEqual(sh.binds(sh.SEVERITY.INFO), false);
    });
    test('the broker pipeline is BLOCKING, which is the whole point of the sweep', () => {
      for (const key of ['broker', 'concentration']) {
        const c = sh.CHECKS.find(x => x.key === key);
        assert.strictEqual(c.severity, sh.SEVERITY.BLOCKING, `${key} is not BLOCKING`);
      }
    });
  }

  console.log('\nBROKER_DATA_MAX_LAG_SESSIONS is one constant, used everywhere');
  {
    test('the constant is 0 — derived from arrival times, not copied', () =>
      assert.strictEqual(sh.BROKER_DATA_MAX_LAG_SESSIONS, 0));
    test('every broker-pipeline check uses it rather than its own literal', () => {
      for (const key of ['broker', 'concentration', 'flow_detail']) {
        const c = sh.CHECKS.find(x => x.key === key);
        assert.strictEqual(c.maxLag, sh.BROKER_DATA_MAX_LAG_SESSIONS,
          `${key} has its own tolerance (${c.maxLag}) instead of the canonical one`);
      }
    });
    // The split this replaced: gate 1, warning 2, scanner 1.
    test('no broker-pipeline check silently tolerates a session of lag', () =>
      assert.ok(sh.CHECKS.filter(c => /broker|concentration|flow_detail/.test(c.key))
        .every(c => c.maxLag === 0)));
  }

  console.log('\nreadiness is scoped, so one subsystem cannot fail another');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.ft_signals = '2026-07-20';
    spec.lag = { '2026-07-31': 0, '2026-07-20': 8 };
    const pool = makePool(spec);
    const vb = await sh.readiness(pool, { subsystems: [sh.SUBSYSTEM.VIRTUAL_BROKER], today: CLOCK });
    const pt = await sh.readiness(pool, { subsystems: [sh.SUBSYSTEM.PAPER_TRADER], today: CLOCK });
    test('a dead ft_signals does NOT fail the virtual-broker chain', () =>
      assert.strictEqual(vb.ready, true, JSON.stringify(vb.degraded.concat(vb.blocking))));
    test('but it DOES fail the paper-trader it actually feeds', () =>
      assert.strictEqual(pt.ready, false));
    test('virtual-broker pulls in signal-engine transitively', () =>
      assert.ok(vb.subsystems.includes(sh.SUBSYSTEM.SIGNAL_ENGINE), JSON.stringify(vb.subsystems)));
  }

  console.log('\nreadiness: a stale broker feed fails the burn-in scope');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_broker_summary = '2026-07-30';
    spec.lag = { '2026-07-31': 0, '2026-07-30': 1 };
    const r = await sh.readiness(makePool(spec), { subsystems: [sh.SUBSYSTEM.VIRTUAL_BROKER], today: CLOCK });
    test('ONE session of broker lag is already a failure', () =>
      assert.strictEqual(r.ready, false, JSON.stringify(r)));
    test('and it is BLOCKING, not merely degraded', () =>
      assert.ok(r.blocking.some(b => b.startsWith('broker')), JSON.stringify(r.blocking)));
    test('signalDate reports the session we can honestly speak for', () =>
      assert.strictEqual(r.signalDate, '2026-07-30'));
    test('and names the feed that limits it', () =>
      assert.strictEqual(r.limitedBy, 'broker'));
  }

  console.log('\nthe HK failure mode: a job failing repeatedly and unnoticed');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.jobs = [{ job_name: 'signal_engine_hk', status: 'FAILED', finished_at: null, error: 'SyntaxError' }];
    spec.failCounts = { signal_engine_hk: 45 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('45 consecutive failures DISABLES signals', () => assert.strictEqual(s.enabled, false));
    test('reason names the job and the count', () =>
      assert.ok(s.reasons.some(r => r.startsWith('JOB_FAILING:signal_engine_hk')), JSON.stringify(s.reasons)));
  }
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.jobs = [{ job_name: 'nightly_cron', status: 'FAILED', finished_at: null, error: 'timeout' }];
    spec.failCounts = { nightly_cron: 2 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
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
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('an empty critical table DISABLES signals', () => assert.strictEqual(s.enabled, false));
  }

  console.log('\nrecording must never break the job it records');
  {
    const brokenPool = { async query() { throw new Error('db down'); } };
    let threw = false;
    try { await sh.recordJobRun(brokenPool, { job: 'x', status: 'OK' }); } catch { threw = true; }
    test('recordJobRun swallows its own DB errors', () => assert.strictEqual(threw, false));
  }

  console.log('the self-referential freshness bug (found 2026-08-03)');
  {
    const at = d => new Date(d + 'T12:00:00Z');
    // The old tradingDayLag compared idx_ihsg_history's MAX(date) against its
    // own MAX(date), so the ihsg check returned 0 however stale it got -- the
    // one check written because that table had silently gone stale for a week.
    test('weekdaysSince skips weekends', () =>
      assert.strictEqual(sh.weekdaysSince('2026-07-31', at('2026-08-03')), 1));
    test('weekdaysSince is 0 for today', () =>
      assert.strictEqual(sh.weekdaysSince('2026-08-03', at('2026-08-03')), 0));
    test('weekdaysSince is 0 for a future date rather than negative', () =>
      assert.strictEqual(sh.weekdaysSince('2026-08-10', at('2026-08-03')), 0));
    test('weekdaysSince grows across a long outage', () =>
      assert.strictEqual(sh.weekdaysSince('2026-07-20', at('2026-08-03')), 10));
    test('a two-week-old reference breaches the tolerance', () =>
      assert.ok(sh.weekdaysSince('2026-07-20', at('2026-08-03')) > sh.MAX_REFERENCE_WEEKDAYS));
    test('a one-weekday-old reference does not', () =>
      assert.ok(sh.weekdaysSince('2026-07-31', at('2026-08-03')) <= sh.MAX_REFERENCE_WEEKDAYS));
    test('the tolerance survives a holiday but not the two-month silence before', () => {
      assert.ok(sh.MAX_REFERENCE_WEEKDAYS >= 3);
      assert.ok(sh.MAX_REFERENCE_WEEKDAYS <= 10);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
