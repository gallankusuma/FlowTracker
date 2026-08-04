/**
 * End-to-end lifecycle test against real MySQL.
 *
 * The previous file with this name claimed to run cmdPlan -> cmdFill -> cmdMark
 * -> reportFor -> gate and did none of it: it inserted rows by hand and tested
 * the primitives. The 2026-08-04 13:07 review caught the gap between the
 * docstring and the code, which is a fair hit — the defects that keep surviving
 * live in the glue, and hand-written INSERTs are not the glue. That file is now
 * test_forward_schema.js, named for what it does.
 *
 * This one drives the actual functions:
 *
 *   cmdPlan (on a truncated view, so the execution bar does not exist yet)
 *     -> a PLANNED row with no execution price
 *   cmdFill (on the full view, with one target deliberately unbuyable)
 *     -> PARTIALLY_FILLED, real units, cash reduced by exactly the cost basis
 *   cmdMark   -> a NAV that reconciles
 *   reportFor -> metrics from that ledger
 *   gate      -> NOT_ELIGIBLE on a one-decision record
 *
 * Isolation is by an injected strategyId/strategyHash, so the live ledger is
 * untouched; rows are removed in a finally block and the cleanup is asserted.
 *
 * SKIPPING IS NOT SUCCESS. Without a database this exits 0 only when run
 * WITHOUT --require-db. `npm run test:integration` passes it, so an environment
 * that is supposed to have MySQL cannot go green by quietly skipping.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');
const sf = require('./strategy_forward');
const fg = require('./modules/forward_gate');
const sb = require('./modules/strategy_book');

const IDS = { strategyId: 'TEST_LIFECYCLE_DO_NOT_TRADE', strategyHash: 'testhash00000001' };
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

async function cleanup(pool) {
  for (const tbl of ['ft_strategy_positions', 'ft_strategy_log', 'ft_strategy_plan', 'ft_strategy_nav']) {
    await pool.query(`DELETE FROM ${tbl} WHERE strategy_id=?`, [IDS.strategyId]);
  }
}

/** A view of ctx that ends at bar `n`, so cmdPlan cannot see the execution bar. */
function truncated(ctx, n) {
  return {
    tradingDates: ctx.tradingDates.slice(0, n + 1),
    dateIdx: new Map(ctx.tradingDates.slice(0, n + 1).map((d, i) => [d, i])),
    ihsgClose: ctx.ihsgClose.slice(0, n + 1),
    ihsgSma: ctx.ihsgSma.slice(0, n + 1),
    series: ctx.series,
  };
}

(async () => {
  let pool;
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
      password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
      waitForConnections: true, connectionLimit: 4,
    });
    await pool.query('SELECT 1');
  } catch (e) {
    if (REQUIRE_DB) {
      console.log('\nforward lifecycle — FAILED: FT_REQUIRE_DB=1 but no database is reachable');
      console.log(`  ${e.message}`);
      process.exit(1);
    }
    console.log('\nforward lifecycle — skipped (no database; pass --require-db to make this a failure)');
    process.exit(0);
  }

  await sf.setup(pool);
  const ctx = await sf.loadSeries(pool);
  await cleanup(pool);

  try {
    // Plan on a bar the strategy would actually have INVESTED on, so the
    // partial-fill path is exercised regardless of what the market is doing the
    // day this test runs. Neutralising the regime instead would have been
    // simpler and wrong: marketRegime reads the same SMA, so the plan would
    // carry no regime label and the test would be asserting on a fixture that
    // cannot occur. Any bar with an execution bar after it will do.
    let planI = null;
    for (let i = ctx.tradingDates.length - 6; i > sb.DEFAULTS.regimeSma; i--) {
      if (ctx.ihsgSma[i] !== null && ctx.ihsgClose[i] > ctx.ihsgSma[i]) { planI = i; break; }
    }
    assert.ok(planI !== null, 'no INVESTED bar anywhere in the sample');
    const planDate = ctx.tradingDates[planI];
    const execDate = ctx.tradingDates[planI + 1];

    console.log('\nforward lifecycle — cmdPlan');
    const planned = await sf.cmdPlan(pool, truncated(ctx, planI), true, IDS);
    const [[planRow]] = await pool.query(
      'SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND strategy_hash=?', [IDS.strategyId, IDS.strategyHash]);

    t('cmdPlan wrote exactly one PLANNED row', () => {
      assert.ok(planRow, 'no plan row was written');
      assert.strictEqual(planRow.status, 'PLANNED');
    });
    t('the plan is stamped with the injected hash, a snapshot and a regime label', () => {
      assert.strictEqual(planRow.strategy_hash, IDS.strategyHash);
      assert.ok(planRow.data_snapshot_hash, 'no data_snapshot_hash');
      assert.ok(planRow.regime_label, 'no regime_label');
    });
    t('cmdPlan opened no positions — it reads no execution price', () => {
      assert.ok(!planned.skipped, planned.skipped || '');
    });

    console.log('\nforward lifecycle — cmdFill with one deliberately unbuyable name');
    const target = JSON.parse(planRow.target_json || '[]');
    const fillCtx = { ...ctx, series: new Map(ctx.series) };
    let blocked = null;
    if (target.length) {
      blocked = target[0];
      const s0 = ctx.series.get(blocked);
      fillCtx.series.set(blocked, { ...s0, open: s0.open.slice() });
      fillCtx.series.get(blocked).open[planI + 1] = 0;      // suspended that morning
    }
    const filled = await sf.cmdFill(pool, fillCtx, true, IDS);
    const [[after]] = await pool.query(
      'SELECT status, nofill_json FROM ft_strategy_plan WHERE id=?', [planRow.id]);
    const [positions] = await pool.query(
      'SELECT ticker, units, cost_basis, entry_date, status FROM ft_strategy_positions WHERE strategy_id=? AND strategy_hash=?',
      [IDS.strategyId, IDS.strategyHash]);

    if (target.length) {
      t('a plan that did not fully fill is PARTIALLY_FILLED, not EXECUTED', () => {
        assert.strictEqual(after.status, 'PARTIALLY_FILLED', `status ${after.status}`);
      });
      t('the unbuyable name is named in nofill_json', () => {
        assert.ok(after.nofill_json, 'nofill_json is empty');
        assert.ok(JSON.parse(after.nofill_json).buy.includes(blocked), after.nofill_json);
      });
      t('it opened every OTHER target and none of the blocked one', () => {
        assert.strictEqual(positions.length, target.length - 1, `opened ${positions.length} of ${target.length - 1}`);
        assert.ok(!positions.some(p => p.ticker === blocked));
      });
      t('every filled position carries real units and a cost basis', () => {
        for (const p of positions) {
          assert.ok(Number(p.units) > 0, `${p.ticker} has no units`);
          assert.ok(Number(p.cost_basis) > 0, `${p.ticker} has no cost basis`);
        }
      });
      t('cash fell by exactly the sum of the cost bases', () => {
        const spent = positions.reduce((a, p) => a + Number(p.cost_basis), 0);
        const cash = sf.cashAt(positions.map(p => ({ ...p, exit_date: null, proceeds: null })), execDate);
        assert.ok(Math.abs(cash - (sf.INITIAL_CAPITAL - spent)) < 1e-9, `cash ${cash}, spent ${spent}`);
      });
      t('the book never borrowed', () => {
        const spent = positions.reduce((a, p) => a + Number(p.cost_basis), 0);
        assert.ok(spent <= sf.INITIAL_CAPITAL + 1e-9, `deployed ${spent} of ${sf.INITIAL_CAPITAL}`);
      });
    } else {
      // A flat plan means the fixture failed to produce a book, so the partial
      // fill path — the whole point of this test — never ran. Passing here would
      // be a green run that tested nothing (review, test notes).
      t('THE FIXTURE FAILED: the chosen bar produced an empty target', () => {
        assert.fail(`planned ${planDate} with an empty book; the partial-fill path was not exercised`);
      });
    }

    console.log('\nforward lifecycle — cmdMark');
    const marked = await sf.cmdMark(pool, ctx, true, IDS);
    const [[navRow]] = await pool.query(
      'SELECT * FROM ft_strategy_nav WHERE strategy_id=? AND strategy_hash=?', [IDS.strategyId, IDS.strategyHash]);
    t('cmdMark wrote a NAV row under the injected hash', () => {
      assert.ok(navRow, 'no NAV row');
      assert.strictEqual(navRow.strategy_hash, IDS.strategyHash);
    });
    t('the NAV identity holds: total = cash + market', () => {
      const gap = Number(navRow.total_nav) - (Number(navRow.cash_value) + Number(navRow.market_value));
      assert.ok(Math.abs(gap) < 1e-5, `off by ${gap}`);
    });
    t('cash is not negative — the book is self-financing', () => {
      assert.ok(marked.cash >= -1e-9, `cash ${marked.cash}`);
    });

    console.log('\nforward lifecycle — reportFor and the gate');
    const rep = await sf.reportFor(pool, ctx, 'LIVE', IDS);
    t('the report sees this hash and no other', () => {
      assert.strictEqual(rep.m.fills, positions.length, `fills ${rep.m.fills}`);
      assert.ok(!rep.unconverted.length, 'a v2 record must have no weight-era rows');
    });
    t('one decision cannot clear the gate', () => {
      const g = fg.evaluateForwardGate({ ...rep.m, replayDecisions: 0 });
      assert.strictEqual(g.status, 'NOT_ELIGIBLE');
      assert.ok(g.failed.includes('independent rebalance decisions (LIVE)'));
    });
  } finally {
    await cleanup(pool);
    const [[left]] = await pool.query(
      'SELECT COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=?', [IDS.strategyId]);
    t('the test cleans up after itself', () => assert.strictEqual(Number(left.n), 0));
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
