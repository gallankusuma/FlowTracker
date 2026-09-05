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

/**
 * The async form, and it must be AWAITED at the call site.
 *
 * `test()` above cannot be used for a promise-returning assertion: it calls fn(),
 * gets a pending promise back, and counts a pass before the assertion has run —
 * so a failing async test would report ✓ and a rejection would surface as an
 * unhandled rejection rather than a failure. A test harness that cannot fail is
 * worth less than no harness, since it produces confidence rather than evidence.
 */
async function atest(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
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
      // ── the exchange calendar, for brokerFreshness/expectedBrokerSession ──
      // spec.sessions is the canonical session list, newest last.
      if (/FROM idx_ihsg_history ORDER BY date DESC LIMIT 2/i.test(sql)) {
        const s = spec.sessions || [];
        return [s.slice(-2).reverse().map(d => ({ date: d }))];
      }
      if (/SELECT 1 AS ok FROM idx_ihsg_history WHERE date = \?/i.test(sql)) {
        return [(spec.sessions || []).includes(params[0]) ? [{ ok: 1 }] : []];
      }
      if (/MIN\(date\) lo, MAX\(date\) hi FROM idx_ihsg_history/i.test(sql)) {
        const s = spec.sessions || [];
        return [[{ lo: s[0] ?? null, hi: s[s.length - 1] ?? null }]];
      }
      if (/COUNT\(\*\) n FROM idx_ihsg_history WHERE date > \? AND date <= \?/i.test(sql)) {
        const s = spec.sessions || [];
        return [[{ n: s.filter(d => d > params[0] && d <= params[1]).length }]];
      }
      // ── us_stock_prices cross-section coverage ──────────────────────────
      // spec.usCoverage maps date -> number of tickers that landed on it. Absent,
      // these fall through and the module keeps its pre-coverage behaviour, which
      // is what every test written before 2026-09-05 expects.
      if (spec.usCoverage && /COUNT\(\*\) n FROM us_stock_prices\s+GROUP BY date/i.test(sql)) {
        const desc = Object.keys(spec.usCoverage).sort().reverse();
        return [desc.slice(0, params[0]).map(d => ({ n: spec.usCoverage[d] }))];
      }
      if (spec.usCoverage && /SELECT date d FROM us_stock_prices GROUP BY date HAVING/i.test(sql)) {
        const hit = Object.keys(spec.usCoverage).sort().reverse()
          .filter(d => spec.usCoverage[d] >= params[0]);
        return [hit.length ? [{ d: hit[0] }] : []];
      }
      if (spec.usCoverage && /FROM us_stock_prices WHERE date > \? AND date <= \?/i.test(sql)) {
        const n = Object.keys(spec.usCoverage)
          .filter(d => d > params[0] && d <= params[1] && spec.usCoverage[d] >= params[2]).length;
        return [[{ n }]];
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
//
// 13:50 UTC = 20:50 WIB, the hour the watchdog actually judges the system —
// after the 12:30 broker publication and the 13:00 deadline. It used to be
// 12:00, which made the "healthy baseline" fixture describe an impossible
// state: every feed dated 2026-07-31 at a moment before 2026-07-31's data could
// exist. The PREMATURE check caught it, which is the check doing its job on the
// fixture rather than the fixture proving the check wrong.
const CLOCK = new Date('2026-07-31T13:50:00Z');
const ALL_FRESH = {
  tables: { idx_stock_prices: '2026-07-31', idx_broker_summary: '2026-07-31',
            idx_concentration: '2026-07-31', idx_broker_flow_detail: '2026-07-31',
            idx_ihsg_history: '2026-07-31', ft_signals: '2026-07-31' },
  lag: { '2026-07-31': 0 },
  // Canonical exchange sessions, newest last. 2026-07-31 is a Friday.
  sessions: ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'],
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

  // ── review P1: freshness must be time-aware, not merely session-aware ──────
  // A tolerance of 0 is right for a post-close consumer and wrong for one that
  // can be opened at 10:00 WIB, when today's EOD pull is nine hours away.
  console.log('\nP1 — expectedBrokerSession is the last session whose pipeline window CLOSED');
  {
    // Calendar: Friday 07 Aug is newest, Thursday 06 Aug before it.
    const calPool = {
      async query(sql) {
        if (/ORDER BY date DESC LIMIT 2/i.test(sql)) return [[{ date: '2026-08-07' }, { date: '2026-08-06' }]];
        return [[]];
      },
    };
    const at = s => new Date(s);
    // Cutoff for 07 Aug is 12:30 UTC + 30min grace = 13:00 UTC.
    await atest('intraday, before the cutoff -> the PREVIOUS session is expected', async () =>
      assert.strictEqual(await sh.expectedBrokerSession(calPool, at('2026-08-07T03:00:00Z')), '2026-08-06'));
    await atest('one minute before the deadline is still the previous session', async () =>
      assert.strictEqual(await sh.expectedBrokerSession(calPool, at('2026-08-07T12:59:00Z')), '2026-08-06'));
    await atest('after the cutoff -> today is expected', async () =>
      assert.strictEqual(await sh.expectedBrokerSession(calPool, at('2026-08-07T13:00:00Z')), '2026-08-07'));
    await atest('at the watchdog hour it is unambiguously today', async () =>
      assert.strictEqual(await sh.expectedBrokerSession(calPool, at('2026-08-07T13:50:00Z')), '2026-08-07'));
    // Measured against the session's own date, so a weekend does not reset it.
    await atest('over the weekend Friday stays expected, not Thursday', async () =>
      assert.strictEqual(await sh.expectedBrokerSession(calPool, at('2026-08-09T04:00:00Z')), '2026-08-07'));
    await atest('no calendar -> null rather than a guess', async () =>
      assert.strictEqual(await sh.expectedBrokerSession({ async query() { return [[]]; } }), null));
  }

  // ── HEALTH FINAL: a bar can be INVALID rather than merely late ────────────
  // Both states below made weekdaysSince() return 0, so the old lag checks
  // called them "fresh" — the healthiest possible reading for data that is true
  // of no day at all.
  console.log('\nHEALTH FINAL — future and non-session broker dates must REFUSE');
  {
    const base = () => JSON.parse(JSON.stringify(ALL_FRESH));
    const at = s => new Date(s);

    await atest('a broker bar dated AFTER today is FUTURE, not fresh', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-08-14';   // a week ahead
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.FUTURE, JSON.stringify(r));
      assert.strictEqual(r.valid, false);
    });

    await atest('a WEEKEND broker bar is NON_SESSION even though the calendar can never contain it', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-08-01';   // Saturday
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-08-03T13:50:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.NON_SESSION, JSON.stringify(r));
      assert.strictEqual(r.valid, false);
    });

    await atest('a WEEKDAY the index did not trade is NON_SESSION (holiday)', async () => {
      const spec = base();
      spec.sessions = ['2026-07-27', '2026-07-28', '2026-07-30', '2026-07-31']; // 07-29 absent
      spec.tables.idx_broker_summary = '2026-07-29';
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.NON_SESSION, JSON.stringify(r));
    });

    // The regression the first version of this rule caused. Broker lands 12:30
    // UTC, the deadline is 13:00, so for half an hour the feed legitimately
    // holds a session `expected` has not reached. Refusing there would reject
    // the freshest data in the system, every single evening.
    await atest('landing BEFORE the deadline is CURRENT, not FUTURE', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-31';
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T12:40:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.CURRENT, JSON.stringify(r));
      assert.strictEqual(r.valid, true);
    });

    // The exemption written for the legitimate 19:30-20:00 WIB window must not
    // become a door for a bar dated to a session that is still trading. This is
    // an END-OF-DAY feed; 10:00 WIB data for today cannot be real.
    await atest('a today-dated bar BEFORE the publication window is PREMATURE', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-31';
      // 03:00 UTC = 10:00 WIB, session still trading.
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T03:00:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.PREMATURE, JSON.stringify(r));
      assert.strictEqual(r.valid, false);
    });

    await atest('the same bar AFTER publication opens is CURRENT', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-31';
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T12:31:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.CURRENT, JSON.stringify(r));
      assert.strictEqual(r.valid, true);
    });

    await atest('PREMATURE also refuses through readiness', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-31';
      const r = await sh.readiness(makePool(spec), {
        subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: at('2026-07-31T03:00:00Z') });
      assert.strictEqual(r.enabled, false, JSON.stringify(r.blocking));
      assert.ok(r.blocking.some(b => b.includes('PREMATURE')), JSON.stringify(r.blocking));
    });

    await atest('an ordinary current feed is CURRENT', async () => {
      const r = await sh.brokerFreshness(makePool(base()), { asOf: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.CURRENT, JSON.stringify(r));
    });

    await atest('a genuinely late feed is still STALE', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-28';
      const r = await sh.brokerFreshness(makePool(spec), { asOf: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.state, sh.BROKER_FRESHNESS.STALE, JSON.stringify(r));
      assert.strictEqual(r.sessionsBehind, 3);
    });

    // The point of the whole exercise: readiness must inherit it, so the
    // scanner, Flow Analyzer and the burn-in all refuse without asking twice.
    await atest('readiness REFUSES on an invalid broker bar, not just a late one', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-08-14';
      const r = await sh.readiness(makePool(spec), {
        subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.enabled, false, JSON.stringify(r.blocking));
      assert.ok(r.blocking.some(b => b.includes('FUTURE')), JSON.stringify(r.blocking));
    });

    await atest('one fault is not counted twice — STALE is reported by the lag check alone', async () => {
      const spec = base();
      spec.tables.idx_broker_summary = '2026-07-28';
      spec.lag = { '2026-07-31': 0, '2026-07-28': 3 };
      const r = await sh.readiness(makePool(spec), {
        subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: at('2026-07-31T13:50:00Z') });
      const brokerReasons = r.blocking.filter(b => b.startsWith('broker:'));
      assert.strictEqual(brokerReasons.length, 1, JSON.stringify(r.blocking));
    });
  }

  // ── P1 2026-08-11: ONE DEFINITION OF FRESHNESS ────────────────────────────
  // Seen live 2026-08-10 18:55 WIB. The calendar (idx_ihsg_history) reaches
  // session D at 16:15 WIB, because refreshIHSG keeps a bar once the WIB day has
  // passed the close and it runs on page open. The broker pull is the 19:30 WIB
  // job. In between, the freshest-feed reference was D while the broker table
  // sat at D-1 — a lag of 1 against a tolerance of 0 — so the broker check went
  // BLOCKING and the scanner and Flow Analyzer both refused, while
  // brokerFreshness() called the very same feed CURRENT because
  // expectedBrokerSession() knew D's data was not due yet.
  //
  // Every trading day, for about three and a quarter hours, healing itself at
  // 19:30. The fixture below IS that window.
  console.log('\nP1 — the calendar running ahead of the broker pull is not staleness');
  {
    const at = s => new Date(s);
    // Calendar has reached Friday 31 Jul; broker/concentration/flow still hold
    // Thursday 30 Jul, which is the session actually being promised right now.
    const windowSpec = () => ({
      tables: { idx_stock_prices: '2026-07-30', idx_broker_summary: '2026-07-30',
                idx_concentration: '2026-07-30', idx_broker_flow_detail: '2026-07-30',
                idx_ihsg_history: '2026-07-31', ft_signals: '2026-07-30' },
      lag: { '2026-07-31': 0, '2026-07-30': 1 },
      sessions: ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31'],
    });
    // 10:30 UTC = 17:30 WIB: after the 16:15 close, before the 19:30 pull.
    const INSIDE = at('2026-07-31T10:30:00Z');

    await atest('inside the window the broker feed is NOT reported stale', async () => {
      const rows = await sh.dataFreshness(makePool(windowSpec()), INSIDE);
      for (const key of ['broker', 'concentration', 'flow_detail']) {
        const r = rows.find(x => x.key === key);
        assert.strictEqual(r.ok, true, `${key}: ${r.detail}`);
      }
    });

    await atest('so the scanner and Flow Analyzer stay ENABLED all afternoon', async () => {
      const r = await sh.readiness(makePool(windowSpec()), {
        subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: INSIDE });
      assert.strictEqual(r.enabled, true, JSON.stringify(r.blocking));
      assert.strictEqual(r.ready, true, JSON.stringify(r.blocking.concat(r.degraded)));
    });

    await atest('and the burn-in does not fail for a pull that is not due yet', async () => {
      const r = await sh.readiness(makePool(windowSpec()), {
        subsystems: [sh.SUBSYSTEM.VIRTUAL_BROKER], today: INSIDE });
      assert.strictEqual(r.ready, true, JSON.stringify(r.blocking.concat(r.degraded)));
    });

    // The other half of the contract: the tolerance must not have been widened.
    // Once the deadline passes, an absent pull is a real fault again.
    await atest('AFTER the deadline the same fixture DOES block — this is not a widened tolerance', async () => {
      const r = await sh.readiness(makePool(windowSpec()), {
        subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: at('2026-07-31T13:50:00Z') });
      assert.strictEqual(r.enabled, false, JSON.stringify(r.blocking));
      assert.ok(r.blocking.some(b => b.startsWith('broker:')), JSON.stringify(r.blocking));
    });

    await atest('the two definitions now agree, feed by feed, at every hour', async () => {
      for (const iso of ['2026-07-31T03:00:00Z', '2026-07-31T10:30:00Z',
                         '2026-07-31T12:40:00Z', '2026-07-31T13:50:00Z']) {
        const pool = makePool(windowSpec());
        const rows = await sh.dataFreshness(pool, at(iso));
        for (const [key, table, col] of [['broker', 'idx_broker_summary', 'date'],
                                         ['concentration', 'idx_concentration', 'data_date'],
                                         ['flow_detail', 'idx_broker_flow_detail', 'date']]) {
          const bf = await sh.brokerFreshness(pool, { asOf: at(iso), table, col });
          const row = rows.find(x => x.key === key);
          assert.strictEqual(row.ok, bf.valid,
            `${key} at ${iso}: freshness table says ok=${row.ok}, the primitive says valid=${bf.valid}`);
        }
      }
    });

    // ── the hole the FIRST cut of this fix opened, found in the nightly job's
    // own failure record (2026-08-10 19:37 WIB, "concentration:1 trading
    // session(s) behind"). Between the 12:30 UTC broker pull and the 13:05 UTC
    // calendar refresh, broker holds session D while concentration is still
    // derived only through D-1 and `expected` is still D-1. Judged against the
    // clock alone BOTH are legitimately current — while covering different
    // sessions. The scan dates itself by MAX(broker) and would read
    // concentration from the older one.
    console.log('\nP1b — the broker family must agree with EACH OTHER, not just with the clock');
    {
      // 12:37 UTC: broker landed, concentration not yet derived, calendar not
      // yet advanced. Sessions deliberately stop at 07-30 — the calendar has not
      // reached 07-31, exactly as at 19:37 WIB.
      const midPipeline = () => ({
        tables: { idx_stock_prices: '2026-07-31', idx_broker_summary: '2026-07-31',
                  idx_concentration: '2026-07-30', idx_broker_flow_detail: '2026-07-30',
                  idx_ihsg_history: '2026-07-30', ft_signals: '2026-07-30' },
        lag: { '2026-07-31': 0, '2026-07-30': 0 },
        sessions: ['2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'],
      });
      const MID = at('2026-07-31T12:37:00Z');

      await atest('concentration lagging the broker pull is STALE, not "within its window"', async () => {
        const rows = await sh.dataFreshness(makePool(midPipeline()), MID);
        const conc = rows.find(r => r.key === 'concentration');
        assert.strictEqual(conc.ok, false,
          `concentration reported fresh at ${conc.latest} while broker is at 2026-07-31: ${conc.detail}`);
      });

      await atest('so the scan REFUSES rather than dating itself by MAX(broker)', async () => {
        const r = await sh.readiness(makePool(midPipeline()), {
          subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: MID });
        assert.strictEqual(r.enabled, false, JSON.stringify(r.blocking));
        assert.ok(r.blocking.some(b => b.startsWith('concentration:')), JSON.stringify(r.blocking));
      });

      await atest('the broker feed that is AHEAD is not itself blamed', async () => {
        const rows = await sh.dataFreshness(makePool(midPipeline()), MID);
        const broker = rows.find(r => r.key === 'broker');
        assert.strictEqual(broker.ok, true, `broker wrongly faulted: ${broker.detail}`);
      });

      // The family reference must come from the family ALONE. If prices or the
      // calendar could raise it, the original bug would be back by another name.
      await atest('prices running ahead still cannot make the family refuse', async () => {
        const spec = windowSpec();
        // A page view minted today's price row at 17:30 WIB — the exact trigger
        // of the original bug. The broker family is untouched at 2026-07-30.
        spec.tables.idx_stock_prices = '2026-07-31';
        const rows = await sh.dataFreshness(makePool(spec), at('2026-07-31T10:30:00Z'));
        for (const key of ['broker', 'concentration', 'flow_detail']) {
          const r = rows.find(x => x.key === key);
          assert.strictEqual(r.ok, true, `${key} refused because PRICES moved: ${r.detail}`);
        }
        const r = await sh.readiness(makePool(spec), {
          subsystems: [sh.SUBSYSTEM.SIGNAL_ENGINE], today: at('2026-07-31T10:30:00Z') });
        assert.strictEqual(r.enabled, true, JSON.stringify(r.blocking));
      });
    }

    test('the broker family declares which yardstick it is measured by', () => {
      for (const key of ['broker', 'concentration', 'flow_detail']) {
        assert.strictEqual(sh.CHECKS.find(c => c.key === key).reference,
          sh.REFERENCE.BROKER_PIPELINE, `${key} is still judged against the freshest feed`);
      }
    });
  }

  console.log('\nassertCompleteSessions validates SQL identifiers (review P2)');
  {
    const pool = makePool(ALL_FRESH);
    const bad = [
      { table: 'x; DROP TABLE users--', col: 'date' },
      { table: 'idx_stock_prices', col: 'date) OR 1=1--' },
      { table: 'idx_stock_prices', col: 'date', calendar: 'a b' },
      { table: 'idx_stock_prices', col: 'date', requiredFields: ['ok', 'bad-name'] },
    ];
    for (const [i, opts] of bad.entries()) {
      await atest(`rejects hostile identifier #${i + 1}`, async () => {
        await assert.rejects(
          () => sh.assertCompleteSessions(pool, { count: 5, ...opts }),
          /not a valid SQL identifier/);
      });
    }
    await atest('accepts ordinary identifiers', async () => {
      // Reaches the query layer rather than throwing on validation.
      await sh.assertCompleteSessions(pool, {
        table: 'idx_stock_prices', col: 'date', count: 5, requiredFields: ['close_price'] });
    });
  }

  // ── review P2: incident cardinality ───────────────────────────────────────
  console.log('\nP2 — one upstream fault must not read as three problems');
  {
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.tables.idx_broker_summary = '2026-07-20';
    spec.lag = { '2026-07-31': 0, '2026-07-20': 8 };
    spec.jobs = [{ job_name: 'watchdog', status: 'FAILED', finished_at: null, error: 'burn-in failed' }];
    spec.failCounts = { watchdog: 3 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('the watchdog failing BECAUSE inputs are stale is not a separate reason', () =>
      assert.ok(!s.reasons.some(r => r.startsWith('JOB_FAILING:watchdog')), JSON.stringify(s.reasons)));
    test('it is reported as a symptom instead', () =>
      assert.ok(s.symptoms.some(r => r.startsWith('JOB_FAILING:watchdog')), JSON.stringify(s.symptoms)));
    test('root cause names the stale inputs', () => {
      assert.strictEqual(s.rootCause.code, 'INPUT_DATA_STALE');
      assert.ok(s.rootCause.inputs.includes('broker'), JSON.stringify(s.rootCause));
    });
    test('the consequences are listed as symptoms, not causes', () =>
      assert.ok(s.symptoms.some(r => r.startsWith('SCANNER_BLOCKED')), JSON.stringify(s.symptoms)));
    test('it still DISABLES — dedupe is about counting, never about severity', () =>
      assert.strictEqual(s.enabled, false));
  }
  {
    // The demotion must be conditional. A monitor that breaks on its own, with
    // every input fresh, is a real and independent failure.
    const spec = JSON.parse(JSON.stringify(ALL_FRESH));
    spec.jobs = [{ job_name: 'watchdog', status: 'FAILED', finished_at: null, error: 'crashed' }];
    spec.failCounts = { watchdog: 4 };
    const s = await sh.signalState(makePool(spec), { today: CLOCK });
    test('a watchdog failing with NO stale input stays a reason', () =>
      assert.ok(s.reasons.some(r => r.startsWith('JOB_FAILING:watchdog')), JSON.stringify(s.reasons)));
    test('and it disables', () => assert.strictEqual(s.enabled, false));
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

  // ── US layer scoping, added 2026-09-05 ──────────────────────────────────
  //
  // The US checks are DEGRADED, and DEGRADED binds. The ONLY thing stopping a
  // stale S&P table from halting IDX order execution is that they are scoped to
  // a subsystem nothing depends on. That is a one-line property in the CHECKS
  // table and it would be silently lost by anyone adding SIGNAL_ENGINE to an
  // `affects` array "so it shows up on the dashboard".
  {
    console.log('');
    console.log('US layer scoping — a US fault must never gate IDX execution');
    const at = d => new Date(d + 'T12:00:00Z');
    const usChecks = sh.CHECKS.filter(c => (c.affects || []).includes(sh.SUBSYSTEM.US_LAYER));

    test('the US checks exist at all', () => assert.ok(usChecks.length >= 3,
      `expected the US feeds to be monitored, found ${usChecks.length}`));

    test('no US check touches an IDX subsystem', () => {
      for (const c of usChecks) {
        for (const a of c.affects) {
          assert.strictEqual(a, sh.SUBSYSTEM.US_LAYER,
            `${c.key} affects ${a}; a US fault would then bind the IDX chain`);
        }
      }
    });

    test('nothing depends on the US layer', () => {
      for (const [sub, deps] of Object.entries(sh.SUBSYSTEM_DEPENDS_ON)) {
        assert.ok(!deps.includes(sh.SUBSYSTEM.US_LAYER),
          `${sub} depends on us-layer, which would let a US fault cascade`);
      }
    });

    test('US checks are DEGRADED — not advisory, not blocking', () => {
      for (const c of usChecks) {
        // Advisory is how sp500_history sat six weeks wrong; BLOCKING would let
        // it stop IDX trading. The middle severity is the point.
        assert.strictEqual(c.severity, sh.SEVERITY.DEGRADED, `${c.key} is ${c.severity}`);
        assert.ok(sh.binds(c.severity), `${c.key} must bind within its own scope`);
      }
    });

    test('US checks use the US pipeline yardstick, not the IDX one', () => {
      for (const c of usChecks) {
        assert.strictEqual(c.reference, sh.REFERENCE.US_PIPELINE,
          `${c.key} would be measured against IDX feeds on a different calendar`);
      }
    });

    test('the US tolerance would have caught the real six-week freeze', () => {
      // sp500_history froze on 2026-07-24 and was found by hand on 2026-09-05.
      const stale = sh.weekdaysSince('2026-07-24', at('2026-09-05'));
      assert.ok(stale > sh.US_MAX_REFERENCE_WEEKDAYS,
        `${stale} weekdays did not exceed the tolerance ${sh.US_MAX_REFERENCE_WEEKDAYS}`);
    });

    test('but one weekday of lag does not, because the US cron precedes the open', () => {
      assert.ok(sh.weekdaysSince('2026-09-03', at('2026-09-04')) <= sh.US_MAX_REFERENCE_WEEKDAYS);
    });
  }

  // ── a hollow session must not read as a session ──────────────────────────
  // The real 2026-09-05 shape: MAX(date) 2026-09-04 on ONE ticker, 406 at 09-03.
  {
    const HOLLOW = {
      '2026-08-31': 404, '2026-09-01': 404, '2026-09-02': 404,
      '2026-09-03': 403, '2026-09-04': 1,
    };
    const usSpec = cov => ({
      tables: {
        us_stock_prices: '2026-09-04', us_signal_history: '2026-09-03',
        sp500_history: '2026-09-03',
        idx_stock_prices: '2026-09-04', idx_ihsg_history: '2026-09-04',
        idx_broker_summary: '2026-09-04', idx_concentration: '2026-09-04',
        idx_broker_flow_detail: '2026-09-04', ft_signals: '2026-09-04',
      },
      usCoverage: cov, sessions: ['2026-09-03', '2026-09-04'], lag: {}, jobs: [],
    });
    const at = new Date('2026-09-05T14:00:00Z');

    await atest('a one-ticker date is not the US frontier', async () => {
      const rows = await sh.dataFreshness(makePool(usSpec(HOLLOW)), at);
      const px = rows.find(r => r.key === 'us_prices');
      assert.strictEqual(px.latest, '2026-09-03',
        `frontier should be the covered session, got ${px.latest}`);
    });

    await atest('and the row names the thin session even while reporting fresh', async () => {
      const rows = await sh.dataFreshness(makePool(usSpec(HOLLOW)), at);
      const px = rows.find(r => r.key === 'us_prices');
      assert.ok(/thin/.test(px.detail), `detail should name it, got: ${px.detail}`);
    });

    await atest('a fully covered newest session is reported unchanged', async () => {
      const rows = await sh.dataFreshness(makePool(usSpec({ ...HOLLOW, '2026-09-04': 404 })), at);
      const px = rows.find(r => r.key === 'us_prices');
      assert.strictEqual(px.latest, '2026-09-04');
      assert.ok(!/thin/.test(px.detail), `should not warn when whole: ${px.detail}`);
    });

    await atest('the hollow date does not inflate another US feed lag either', async () => {
      // us_signal_history sits at 09-03. Against a phantom 09-04 frontier it
      // would read a session behind; against the covered one it is current.
      const rows = await sh.dataFreshness(makePool(usSpec(HOLLOW)), at);
      const sig = rows.find(r => r.key === 'us_signals');
      assert.strictEqual(sig.lagTradingDays, 0, `got lag ${sig.lagTradingDays}`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
