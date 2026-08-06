/**
 * The ledger half of the virtual broker's mandatory tests, against real MySQL.
 *
 * test_virtual_broker.js proves the arithmetic. Nothing there can catch the
 * defects that actually happen: an order filled twice by a re-run, cash that
 * never received the proceeds, two accounts quietly sharing one pot. Those live
 * in the glue, so this drives the real functions —
 *
 *   cmdSchedule -> SCHEDULED orders, and a second run that adds nothing
 *   cmdResolve  -> fills at the T+1 open, then STOP / TARGET / EOD_CLOSE
 *   cmdResolve  -> AGAIN, which must change nothing at all
 *   cmdMark     -> a NAV that reconciles to cash + market value
 *
 * ISOLATION. A throwaway strategy_id owns its own accounts, and the price bars
 * are synthetic tickers written into idx_stock_prices so the exits are decided
 * by construction rather than by whatever the market did today. Everything is
 * removed in a finally block and the cleanup is asserted.
 *
 * EVERY ASSERTION IS AWAITED. A test whose assertions run inside an un-awaited
 * promise reports PASS before it has checked anything, which is the failure mode
 * this whole suite exists to prevent.
 *
 * SKIPPING IS NOT SUCCESS. Without a database this exits 0 only when run WITHOUT
 * --require-db, which `npm run test:integration` passes.
 */
'use strict';
require('dotenv').config();

const assert = require('assert');
const mysql = require('mysql2/promise');
const vp = require('./virtual_portfolio');
const vb = require('./modules/virtual_broker');

const STRATEGY = 'TEST_VIRTUAL_DO_NOT_TRADE';
const OPTS = { strategyId: STRATEGY };
const TICKERS = ['ZZTSTOP', 'ZZTTGT', 'ZZTFLAT'];
const PLAN_HASH = 'testvirtual00001';
const REQUIRE_DB = process.argv.includes('--require-db') || process.env.FT_REQUIRE_DB === '1';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

async function cleanup(pool) {
  const [accts] = await pool.query('SELECT id FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
  const ids = accts.map(a => a.id);
  if (ids.length) {
    for (const tbl of ['virtual_nav', 'virtual_trade_events', 'virtual_positions', 'virtual_orders']) {
      await pool.query(`DELETE FROM ${tbl} WHERE account_id IN (?)`, [ids]);
    }
    await pool.query('DELETE FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
  }
  await pool.query('DELETE FROM ft_strategy_plan WHERE strategy_id=?', [STRATEGY]);
  await pool.query('DELETE FROM idx_stock_prices WHERE stock_code IN (?)', [TICKERS]);
}

/**
 * Twenty calm bars ending at the signal date, then one entry bar per ticker
 * engineered to force a known exit. The calm range is 20, so ATR14 is 20, the
 * stop sits 2.5 x 20 = 50 below the fill and the target 100 above it.
 */
async function seedPrices(pool, dates, signalDate, entryDate) {
  const sIdx = dates.indexOf(signalDate);
  const hist = dates.slice(sIdx - 19, sIdx + 1);
  const rows = [];
  for (const tk of TICKERS) for (const d of hist) rows.push([tk, d, 1000, 1010, 990, 1000]);

  //                          open  high  low   close
  rows.push(['ZZTSTOP', entryDate, 1000, 1005, 900, 950]);   // the low pierces the stop
  rows.push(['ZZTTGT', entryDate, 1000, 1200, 995, 1150]);   // the high clears the target, the low is nowhere near the stop
  rows.push(['ZZTFLAT', entryDate, 1000, 1005, 995, 1002]);  // neither: EOD_CLOSE, or still open

  await pool.query(
    `INSERT INTO idx_stock_prices (stock_code, date, open_price, high_price, low_price, close_price)
     VALUES ? ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
       low_price=VALUES(low_price), close_price=VALUES(close_price)`, [rows]);
}

const q = async (pool, sql, params = []) => (await pool.query(sql, params))[0];

async function positionMap(pool) {
  const rows = await q(pool,
    `SELECT p.*, a.exit_policy FROM virtual_positions p JOIN virtual_accounts a ON a.id = p.account_id
      WHERE a.strategy_id = ?`, [STRATEGY]);
  return new Map(rows.map(p => [`${p.exit_policy}/${p.ticker}`, p]));
}

/**
 * Keyed on account_code, not exit_policy: a retired contract shares its exit
 * policy with the live one, so an exit_policy key silently collapses two rows
 * into one and the last writer wins. That is how the retirement test corrupted
 * the cash test the first time it was written.
 */
async function cashByAccount(pool) {
  const rows = await q(pool, 'SELECT account_code, cash_balance FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
  return new Map(rows.map(a => [a.account_code, Number(a.cash_balance)]));
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
      console.log('\nvirtual portfolio — FAILED: --require-db was passed but no database is reachable');
      console.log(`  ${e.message}`);
      process.exit(1);
    }
    console.log('\nvirtual portfolio — skipped (no database; pass --require-db to make this a failure)');
    process.exit(0);
  }

  try {
    await vp.setup(pool);
    await cleanup(pool);

    const { dates } = await vp.loadBars(pool);
    assert.ok(dates.length > 25, `need a price history to work against, found ${dates.length} trading days`);
    const signalDate = dates[dates.length - 2];
    const entryDate = dates[dates.length - 1];
    await seedPrices(pool, dates, signalDate, entryDate);

    // Two accounts, identical but for the exit policy — the comparison the whole
    // design exists to make.
    for (const a of vp.ACCOUNTS) {
      await pool.query(
        `INSERT INTO virtual_accounts (account_code, strategy_id, strategy_hash, exit_policy, execution_policy_hash,
                                       config_json, starting_cash, cash_balance, total_nav)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [`TEST_${a.exitPolicy}`, STRATEGY, PLAN_HASH, a.exitPolicy, vb.executionPolicyHash({}, a.exitPolicy),
         JSON.stringify(vb.DEFAULT_CONFIG), 100_000_000, 100_000_000, 100_000_000]);
    }
    await pool.query(
      `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                     data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                     eligible, vetoed, target_json, status)
       VALUES (?,?,'LIVE',NOW(),?,?,?,1.00,'TEST PLAN','INVESTED',?,0,?,'PLANNED')`,
      [STRATEGY, signalDate, PLAN_HASH, 'testsnapshot0001', 'testcommit',
       TICKERS.length, JSON.stringify(TICKERS)]);

    console.log('\nvirtual portfolio — the stage checkpoint');

    await t('SCHEDULE REFUSES UNTIL RESOLVE HAS COMPLETED FOR THIS SESSION', async () => {
      // Production runs resolve, schedule, mark and reconcile as FOUR separate
      // cron processes. A non-zero exit from resolve does not cancel the others,
      // so "the chain halts" was true only in the single-process mode nobody
      // runs. The checkpoint survives between processes.
      const session = await vp.currentSession(pool);
      await pool.query(
        'DELETE FROM virtual_cycle_stage WHERE session_date=? AND stage=?', [session, 'resolve'])
        .catch(() => {});
      const blocked = await vp.cmdSchedule(pool, true, OPTS);
      assert.ok(blocked.blocked, `schedule ran without a completed resolve: ${JSON.stringify(blocked)}`);
      assert.strictEqual(blocked.scheduled, 0);

      const markBlocked = await vp.cmdMark(pool, true, OPTS);
      assert.deepStrictEqual(markBlocked, [], 'mark ran without a completed resolve');
    });

    console.log('\nvirtual portfolio — scheduling');

    // Production order: resolve settles the previous session before anything is
    // scheduled. Running it here both mirrors that and satisfies the checkpoint.
    await vp.cmdResolve(pool, true, OPTS);

    const first = await vp.cmdSchedule(pool, true, OPTS);
    await t('every name in the plan becomes a scheduled order, on both accounts', () => {
      assert.strictEqual(first.scheduled, TICKERS.length * 2);
    });

    const second = await vp.cmdSchedule(pool, true, OPTS);
    await t('a duplicate recommendation does NOT create a second order', () => {
      assert.strictEqual(second.scheduled, 0, 'the re-run created orders');
      assert.strictEqual(second.skipped, TICKERS.length * 2);
    });

    await t('a scheduled order has no quantity: sizing needs an entry price that does not exist yet', async () => {
      const [o] = await q(pool,
        `SELECT o.* FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id
          WHERE a.strategy_id=? AND o.ticker='ZZTSTOP' LIMIT 1`, [STRATEGY]);
      assert.strictEqual(o.status, 'SCHEDULED');
      assert.strictEqual(o.quantity, null);
      assert.strictEqual(o.scheduled_entry_date, null);
      assert.strictEqual(o.strategy_hash, 'testvirtual00001', 'provenance travels with the order');
    });

    console.log('\nvirtual portfolio — resolution, and the two policies diverging');

    const res = await vp.cmdResolve(pool, true, OPTS);

    await t('every order fills at the next open', () => {
      assert.strictEqual(res.length, 2, 'both accounts resolved');
      for (const r of res) assert.strictEqual(r.filled, TICKERS.length, `${r.account} filled ${r.filled}`);
    });

    await t('entry is the T+1 open plus slippage, on the T+1 bar — not the signal-day close', async () => {
      // The signal-day close is 1000 and so is the entry-day open, so a naive
      // check could not tell them apart. The slippage shows which price was
      // used and entry_date shows which bar.
      const expected = 1000 * (1 + vb.DEFAULT_CONFIG.slippage);
      const rows = await q(pool,
        `SELECT p.entry_price, p.entry_date FROM virtual_positions p JOIN virtual_accounts a ON a.id=p.account_id
          WHERE a.strategy_id=? AND p.ticker='ZZTFLAT'`, [STRATEGY]);
      assert.strictEqual(rows.length, 2);
      for (const p of rows) {
        assert.ok(Math.abs(Number(p.entry_price) - expected) < 0.01, `entry ${p.entry_price}, expected ${expected}`);
        assert.strictEqual(String(p.entry_date).slice(0, 10) === entryDate ||
          new Date(p.entry_date).toISOString().slice(0, 10) === entryDate, true, `entry_date ${p.entry_date}`);
      }
    });

    const pos = await positionMap(pool);

    await t('the recorded stop is exactly the policy distance below the recorded entry', () => {
      // The reconciliation that fails silently if levels and fills are ever
      // computed on different price bases. ATR here is 20 by construction, so
      // 2.5 x ATR = 50 and the 2R target is 100.
      for (const [k, p] of pos) {
        const dist = Number(p.entry_price) - Number(p.stop_price);
        assert.ok(Math.abs(dist - 50) < 0.01, `${k} stop distance ${dist.toFixed(4)}, expected 50`);
        assert.ok(Math.abs((Number(p.target_price) - Number(p.entry_price)) - 100) < 0.01,
          `${k} target distance ${(Number(p.target_price) - Number(p.entry_price)).toFixed(4)}`);
      }
    });

    await t('quantity is a whole board lot and stays inside the risk budget', () => {
      for (const [k, p] of pos) {
        assert.strictEqual(p.quantity % vb.LOT, 0, `${k} qty ${p.quantity}`);
        const risked = p.quantity * (Number(p.entry_price) - Number(p.stop_price));
        assert.ok(risked <= 500_000 + 1, `${k} risks ${risked}, the budget is 500,000`);
      }
    });

    await t('a pierced stop closes at the stop, on both accounts', () => {
      for (const k of ['POSITION/ZZTSTOP', 'INTRADAY_EOD/ZZTSTOP']) {
        assert.strictEqual(pos.get(k).exit_reason, 'STOP', k);
        assert.ok(Number(pos.get(k).net_pnl) < 0, `${k} should have lost money`);
      }
    });

    await t('a cleared target closes at the target, on both accounts', () => {
      for (const k of ['POSITION/ZZTTGT', 'INTRADAY_EOD/ZZTTGT']) {
        assert.strictEqual(pos.get(k).exit_reason, 'TARGET', k);
        assert.ok(Number(pos.get(k).net_pnl) > 0, `${k} should have made money`);
      }
    });

    await t('THE POLICIES DIVERGE: a quiet day closes intraday and stays open for position', () => {
      assert.strictEqual(pos.get('INTRADAY_EOD/ZZTFLAT').exit_reason, 'EOD_CLOSE');
      assert.strictEqual(pos.get('INTRADAY_EOD/ZZTFLAT').status, 'CLOSED');
      assert.strictEqual(pos.get('POSITION/ZZTFLAT').status, 'OPEN', 'the position account must not exit on a quiet bar');
      assert.strictEqual(pos.get('POSITION/ZZTFLAT').exit_reason, null);
    });

    await t('an EOD_CLOSE is not a frictionless fill at the printed close', () => {
      assert.ok(Number(pos.get('INTRADAY_EOD/ZZTFLAT').exit_price) < 1002,
        `exit ${pos.get('INTRADAY_EOD/ZZTFLAT').exit_price} should be under the 1002 close`);
    });

    await t('the flat trade LOSES money despite closing above the price it opened at', () => {
      // Bought at the 1000 open, sold at the 1002 close, and the round trip
      // still cost more than the 0.2% it made. The cost model doing its job.
      assert.ok(Number(pos.get('INTRADAY_EOD/ZZTFLAT').net_pnl) < 0);
    });

    console.log('\nvirtual portfolio — the cash ledger');

    await t('cash reconciles exactly: start - open cost + realized P&L', async () => {
      const rows = await q(pool,
        `SELECT a.exit_policy, a.cash_balance,
                COALESCE(SUM(CASE WHEN p.status='OPEN' THEN p.cost_basis END),0) openCost,
                COALESCE(SUM(CASE WHEN p.status='CLOSED' THEN p.net_pnl END),0) realized
           FROM virtual_accounts a LEFT JOIN virtual_positions p ON p.account_id = a.id
          WHERE a.strategy_id=? GROUP BY a.id, a.exit_policy, a.cash_balance`, [STRATEGY]);
      assert.strictEqual(rows.length, 2);
      for (const r of rows) {
        const expected = 100_000_000 - Number(r.openCost) + Number(r.realized);
        assert.ok(Math.abs(Number(r.cash_balance) - expected) < 1,
          `${r.exit_policy}: cash ${r.cash_balance} vs expected ${expected.toFixed(2)}`);
        assert.ok(Number(r.cash_balance) >= 0, `${r.exit_policy} borrowed money`);
      }
    });

    await t('the intraday account closed everything, so its cash is the whole account again', async () => {
      const cash = await cashByAccount(pool);
      assert.ok(cash.get('TEST_INTRADAY_EOD') > 90_000_000, `cash ${cash.get('TEST_INTRADAY_EOD')}`);
      assert.ok(cash.get('TEST_POSITION') < cash.get('TEST_INTRADAY_EOD'),
        'the position account still holds ZZTFLAT, so it must have less cash');
    });

    console.log('\nvirtual portfolio — running it twice, which is what a cron actually does');

    const cashBefore = await cashByAccount(pool);
    const again = await vp.cmdResolve(pool, true, OPTS);
    const cashAfter = await cashByAccount(pool);

    await t('a re-run fills nothing and closes nothing', () => {
      for (const r of again) {
        assert.strictEqual(r.filled, 0, `${r.account} filled ${r.filled} on the second run`);
        assert.strictEqual(r.closed, 0, `${r.account} closed ${r.closed} on the second run`);
      }
    });

    await t('a re-run does not move cash by one rupiah', () => {
      for (const [k, v] of cashBefore) {
        assert.ok(Math.abs(cashAfter.get(k) - v) < 1e-6, `${k}: ${v} -> ${cashAfter.get(k)}`);
      }
    });

    await t('a re-run does not duplicate positions', async () => {
      const [c] = await q(pool,
        `SELECT COUNT(*) n FROM virtual_positions p JOIN virtual_accounts a ON a.id=p.account_id
          WHERE a.strategy_id=?`, [STRATEGY]);
      assert.strictEqual(Number(c.n), TICKERS.length * 2);
    });

    console.log('\nvirtual portfolio — NAV');

    const marks = await vp.cmdMark(pool, true, OPTS);

    await t('NAV is exactly cash plus market value', () => {
      assert.strictEqual(marks.length, 2);
      for (const m of marks) {
        assert.ok(Math.abs(m.totalNav - (m.cash + m.marketValue)) < 1e-6, `${m.account} NAV ${m.totalNav}`);
      }
    });

    await t('NAV equals starting capital plus realized plus unrealized', () => {
      for (const m of marks) {
        const expected = 100_000_000 + m.realized + m.unrealized;
        assert.ok(Math.abs(m.totalNav - expected) < 1, `${m.account}: NAV ${m.totalNav} vs ${expected.toFixed(2)}`);
      }
    });

    await t('marking twice does not create a second row for the same day', async () => {
      await vp.cmdMark(pool, true, OPTS);
      const [c] = await q(pool,
        `SELECT COUNT(*) n FROM virtual_nav v JOIN virtual_accounts a ON a.id=v.account_id
          WHERE a.strategy_id=?`, [STRATEGY]);
      assert.strictEqual(Number(c.n), 2, 'one mark per account per day');
    });

    console.log('\nvirtual portfolio — the two accounts are separate experiments');

    await t('the two accounts have different execution policy hashes', async () => {
      const rows = await q(pool, 'SELECT DISTINCT execution_policy_hash FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
      assert.strictEqual(rows.length, 2, 'two exit rules must never share a track record');
    });

    await t('no position belongs to two accounts, and no order crosses accounts', async () => {
      const [c] = await q(pool,
        `SELECT COUNT(*) n FROM virtual_positions p JOIN virtual_orders o ON o.id = p.order_id
          WHERE p.account_id <> o.account_id`);
      assert.strictEqual(Number(c.n), 0, 'a position is attached to an order from a different account');
    });

    await t('the lifecycle is auditable: every fill left a STOP_SET and a TARGET_SET behind', async () => {
      const [c] = await q(pool,
        `SELECT SUM(event='ORDER_FILLED') fills, SUM(event='STOP_SET') stops, SUM(event='TARGET_SET') targets
           FROM virtual_trade_events e JOIN virtual_accounts a ON a.id=e.account_id WHERE a.strategy_id=?`, [STRATEGY]);
      assert.strictEqual(Number(c.fills), TICKERS.length * 2);
      assert.strictEqual(Number(c.stops), TICKERS.length * 2);
      assert.strictEqual(Number(c.targets), TICKERS.length * 2);
    });

    console.log('\nvirtual portfolio — the integrity check, and whether it can fail');

    await t('a healthy ledger reconciles clean', async () => {
      const problems = await vp.cmdReconcile(pool, OPTS);
      assert.deepStrictEqual(problems, [], problems.join('; '));
    });

    await t('CORRUPT THE CASH: the check catches a balance that no longer matches the positions', async () => {
      // A check that has never been seen to fail is not a check. Move the cash
      // behind the ledger's back, exactly as a half-committed transaction would.
      const before = await cashByAccount(pool);
      await pool.query(
        `UPDATE virtual_accounts SET cash_balance = cash_balance - 12345 WHERE strategy_id=? AND account_code='TEST_POSITION'`,
        [STRATEGY]);
      const problems = await vp.cmdReconcile(pool, OPTS);
      await pool.query(
        `UPDATE virtual_accounts SET cash_balance = ? WHERE strategy_id=? AND account_code='TEST_POSITION'`,
        [before.get('TEST_POSITION'), STRATEGY]);
      assert.ok(problems.some(p => /does not equal starting/.test(p)),
        `expected a cash reconciliation failure, got: ${JSON.stringify(problems)}`);
      const after = await vp.cmdReconcile(pool, OPTS);
      assert.deepStrictEqual(after, [], 'the ledger must be clean again after the corruption is undone');
    });

    await t('CORRUPT A STOP: an open position with an impossible stop is caught', async () => {
      await pool.query(
        `UPDATE virtual_positions p JOIN virtual_accounts a ON a.id=p.account_id
            SET p.stop_price = p.entry_price + 1
          WHERE a.strategy_id=? AND p.status='OPEN'`, [STRATEGY]);
      const problems = await vp.cmdReconcile(pool, OPTS);
      // Restore it. Leaving a corrupted stop behind meant every later
      // reconcile in this file carried a phantom second problem.
      await pool.query(
        `UPDATE virtual_positions p JOIN virtual_accounts a ON a.id=p.account_id
            SET p.stop_price = p.entry_price - 50
          WHERE a.strategy_id=? AND p.status='OPEN'`, [STRATEGY]);
      assert.ok(problems.some(p => /impossible stop/.test(p)),
        `expected a stop failure, got: ${JSON.stringify(problems)}`);
      const after = await vp.cmdReconcile(pool, OPTS);
      assert.deepStrictEqual(after, [], 'the ledger must be clean again once the stop is restored');
    });

    console.log('\nvirtual portfolio — the 2026-08-05 review');

    await t('A PHANTOM WEEKEND BAR CANNOT BECOME THE ENTRY DAY', () => {
      // The failure this guards: a Friday signal filling on a "Saturday" row.
      // The axis is idx_ihsg_history, so a price row outside the session
      // calendar is invisible no matter what the price table says.
      const bad = dates.filter(d => {
        const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
        return dow === 0 || dow === 6;
      });
      assert.deepStrictEqual(bad, [], `the session axis contains weekend dates: ${bad.join(', ')}`);
    });

    await t('a price row dated off the session calendar is dropped, not used', async () => {
      // Written directly, exactly as a bad ingest would. The Saturday after the
      // last session is not a session, so the bar must never be reachable.
      const sat = (() => {
        const d = new Date(`${dates[dates.length - 1]}T00:00:00Z`);
        do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== 6);
        return d.toISOString().slice(0, 10);
      })();
      await pool.query(
        `INSERT INTO idx_stock_prices (stock_code, date, open_price, high_price, low_price, close_price)
         VALUES ('ZZTFLAT',?,1,1,1,1) ON DUPLICATE KEY UPDATE open_price=1`, [sat]);
      try {
        const loaded = await vp.loadBars(pool);
        assert.ok(!loaded.dates.includes(sat), 'a weekend date reached the session axis');
        assert.ok(!loaded.bars.get('ZZTFLAT')?.has(sat), 'a weekend bar reached the price map');
        assert.ok(loaded.offCalendar >= 1, 'the drop must be COUNTED, not silent');
      } finally {
        await pool.query(`DELETE FROM idx_stock_prices WHERE stock_code='ZZTFLAT' AND date=?`, [sat]);
      }
    });

    await t('A RETAINED TICKER IS NOT BOUGHT TWICE', async () => {
      // ZZTFLAT is still OPEN on the position account. A new plan naming it
      // again must not schedule a second order.
      const nextSignal = dates[dates.length - 1];
      await pool.query(
        `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                       data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                       eligible, vetoed, target_json, status)
         VALUES (?,?,'LIVE',NOW(),?,?,?,1.00,'RETAIN TEST','INVESTED',1,0,?,'PLANNED')
         ON DUPLICATE KEY UPDATE target_json=VALUES(target_json)`,
        [STRATEGY, nextSignal, PLAN_HASH, 'testsnapshot0001', 'testcommit', JSON.stringify(['ZZTFLAT'])]);

      const r = await vp.cmdSchedule(pool, true, OPTS);
      assert.ok(r.held >= 1, `expected the retained holding to be skipped, got ${JSON.stringify(r)}`);
      const [c] = await q(pool,
        `SELECT COUNT(*) n FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id
          WHERE a.strategy_id=? AND a.exit_policy='POSITION' AND o.ticker='ZZTFLAT'`, [STRATEGY]);
      assert.strictEqual(Number(c.n), 1, 'a second order was created for a name already held');
    });

    await t('orders carry their TARGET RANK, so cash does not go to the alphabet', async () => {
      const rows = await q(pool,
        `SELECT o.ticker, o.target_rank FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id
          WHERE a.strategy_id=? AND a.exit_policy='POSITION' AND o.signal_date=?
          ORDER BY o.target_rank`, [STRATEGY, signalDate]);
      assert.strictEqual(rows.length, TICKERS.length);
      assert.deepStrictEqual(rows.map(r => r.ticker), TICKERS,
        'rank order must reproduce the plan order, not alphabetical order');
      assert.deepStrictEqual(rows.map(r => Number(r.target_rank)), [0, 1, 2]);
    });

    await t('A PLAN FROM A DIFFERENT STRATEGY HASH IS NOT SCHEDULED INTO THIS ACCOUNT', async () => {
      // The scenario the review named: hash A made Rp10 juta, config changes to
      // hash B, B's orders land in A's account and B starts from Rp110 juta.
      const d = dates[dates.length - 1];
      await pool.query('DELETE FROM ft_strategy_plan WHERE strategy_id=? AND as_of_date=?', [STRATEGY, d]);
      await pool.query(
        `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                       data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                       eligible, vetoed, target_json, status)
         VALUES (?,?,'LIVE',NOW(),'DIFFERENTHASH01',?,?,1.00,'HASH B','INVESTED',1,0,?,'PLANNED')`,
        [STRATEGY, d, 'testsnapshot0001', 'testcommit', JSON.stringify(['ZZTSTOP'])]);

      const before = await q(pool,
        `SELECT COUNT(*) n FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id WHERE a.strategy_id=?`, [STRATEGY]);
      const r = await vp.cmdSchedule(pool, true, OPTS);
      const after = await q(pool,
        `SELECT COUNT(*) n FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id WHERE a.strategy_id=?`, [STRATEGY]);

      assert.strictEqual(r.scheduled, 0, 'orders from another strategy hash were scheduled');
      assert.strictEqual(r.mismatched, 2, 'both accounts should have refused it');
      assert.strictEqual(Number(after[0].n), Number(before[0].n), 'the order table changed');
    });

    await t('a plan with NO strategy hash is refused outright', async () => {
      const d = dates[dates.length - 1];
      await pool.query('DELETE FROM ft_strategy_plan WHERE strategy_id=? AND as_of_date=?', [STRATEGY, d]);
      await pool.query(
        `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                       data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                       eligible, vetoed, target_json, status)
         VALUES (?,?,'LIVE',NOW(),NULL,?,?,1.00,'NO HASH','INVESTED',1,0,?,'PLANNED')`,
        [STRATEGY, d, 'testsnapshot0001', 'testcommit', JSON.stringify(['ZZTSTOP'])]);
      const r = await vp.cmdSchedule(pool, true, OPTS);
      assert.strictEqual(r.reason, 'PLAN_WITHOUT_HASH');
      assert.strictEqual(r.scheduled, 0);
      await pool.query('DELETE FROM ft_strategy_plan WHERE strategy_id=? AND as_of_date=?', [STRATEGY, d]);
    });

    await t('A RETIRING ACCOUNT KEEPS RESOLVING ITS OPEN POSITIONS', async () => {
      // The failure: CLOSED hid the account from loadAccounts() while a
      // position was still open, so it was never stopped out, never timed out,
      // never marked, and never returned its cash.
      await pool.query(
        `UPDATE virtual_accounts SET status='RETIRING' WHERE strategy_id=? AND exit_policy='POSITION'`, [STRATEGY]);
      const loaded = await vp.loadAccounts(pool, STRATEGY);
      assert.ok(loaded.some(a => a.status === 'RETIRING'),
        'a retiring account must still be loaded for exits and marks');

      // ...but it must take no new orders.
      const d = dates[dates.length - 1];
      await pool.query(
        `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                       data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                       eligible, vetoed, target_json, status)
         VALUES (?,?,'LIVE',NOW(),?,?,?,1.00,'RETIRING TEST','INVESTED',1,0,?,'PLANNED')`,
        [STRATEGY, d, PLAN_HASH, 'testsnapshot0001', 'testcommit', JSON.stringify(['ZZTSTOP'])]);
      const before = await q(pool,
        `SELECT COUNT(*) n FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id
          WHERE a.strategy_id=? AND a.exit_policy='POSITION'`, [STRATEGY]);
      await vp.cmdSchedule(pool, true, OPTS);
      const after = await q(pool,
        `SELECT COUNT(*) n FROM virtual_orders o JOIN virtual_accounts a ON a.id=o.account_id
          WHERE a.strategy_id=? AND a.exit_policy='POSITION'`, [STRATEGY]);
      assert.strictEqual(Number(after[0].n), Number(before[0].n), 'a retiring account accepted a new order');

      // And marking must still cover it.
      const marks = await vp.cmdMark(pool, true, OPTS);
      assert.ok(marks.some(m => m.status === 'RETIRING'), 'a retiring account was not marked');

      await pool.query('DELETE FROM ft_strategy_plan WHERE strategy_id=? AND as_of_date=?', [STRATEGY, d]);
      await pool.query(`UPDATE virtual_accounts SET status='ACTIVE' WHERE strategy_id=? AND exit_policy='POSITION'`, [STRATEGY]);
    });

    await t('an account is NOT closed while it still holds something', async () => {
      // retireSupersededAccounts must route a busy account to RETIRING.
      await pool.query(
        `UPDATE virtual_accounts SET execution_policy_hash='0000gonepolicy1'
          WHERE strategy_id=? AND exit_policy='POSITION'`, [STRATEGY]);
      try {
        await vp.retireSupersededAccounts(pool, STRATEGY, true);
        const [a] = await q(pool,
          `SELECT status FROM virtual_accounts WHERE strategy_id=? AND execution_policy_hash='0000gonepolicy1'`, [STRATEGY]);
        assert.strictEqual(a.status, 'RETIRING',
          'an account with an open position must not go straight to CLOSED');
      } finally {
        await pool.query(
          `UPDATE virtual_accounts SET execution_policy_hash=?, status='ACTIVE'
            WHERE strategy_id=? AND exit_policy='POSITION'`,
          [vb.executionPolicyHash({}, 'POSITION'), STRATEGY]);
      }
    });

    await t('the NAV mark and the account total move together', async () => {
      // They were two autocommit statements; a crash between them left the
      // account sizing its next fill against a stale NAV, and nothing compared
      // the two numbers.
      await vp.cmdMark(pool, true, OPTS);
      const rows = await q(pool,
        `SELECT a.account_code, a.total_nav, v.total_nav navRow
           FROM virtual_accounts a
           JOIN virtual_nav v ON v.account_id = a.id
          WHERE a.strategy_id=? AND v.mark_date = (SELECT MAX(mark_date) FROM virtual_nav WHERE account_id=a.id)`,
        [STRATEGY]);
      assert.ok(rows.length >= 2);
      for (const r of rows) {
        assert.ok(Math.abs(Number(r.total_nav) - Number(r.navRow)) < 1,
          `${r.account_code}: account ${r.total_nav} vs nav row ${r.navRow}`);
      }
    });

    await t('a stale account NAV is caught by reconcile, not just left there', async () => {
      const before = await q(pool,
        `SELECT id, total_nav FROM virtual_accounts WHERE strategy_id=? AND exit_policy='POSITION'`, [STRATEGY]);
      await pool.query('UPDATE virtual_accounts SET total_nav = total_nav + 777777 WHERE id=?', [before[0].id]);
      const problems = await vp.cmdReconcile(pool, OPTS);
      await pool.query('UPDATE virtual_accounts SET total_nav=? WHERE id=?', [before[0].total_nav, before[0].id]);
      assert.ok(problems.some(p => /latest virtual_nav/.test(p)),
        `expected a NAV disagreement, got ${JSON.stringify(problems)}`);
    });

    console.log('\nvirtual portfolio — the 2026-08-05 second round');

    await t('RESOLVE REFUSES TO RUN ON A STALE SESSION CALENDAR', async () => {
      // The live cron ran resolve at 20:00 and refresh_ihsg at 20:10, so on any
      // evening the index had not refreshed, today's session was off the axis
      // and every order silently went unfilled — to be booked a day late.
      const state = await vp.sessionCalendarState(pool);
      assert.strictEqual(state.stale, false, 'sanity: the calendar is current right now');

      // Push the price series one session ahead of the calendar, exactly as the
      // 19:30 pull followed by no IHSG refresh would.
      const ahead = (() => {
        const d = new Date(`${state.prices}T00:00:00Z`);
        do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
        return d.toISOString().slice(0, 10);
      })();
      await pool.query(
        `INSERT INTO idx_stock_prices (stock_code, date, open_price, high_price, low_price, close_price)
         VALUES ('ZZTFLAT',?,1000,1010,990,1000) ON DUPLICATE KEY UPDATE open_price=1000`, [ahead]);
      try {
        const now = await vp.sessionCalendarState(pool);
        assert.strictEqual(now.stale, true, 'the calendar must now read as behind');
        const r = await vp.cmdResolve(pool, true, OPTS);
        assert.strictEqual(r.blocked, 'SESSION_CALENDAR_STALE');
        assert.deepStrictEqual(r.summary, [], 'nothing may be resolved while the calendar is behind');
      } finally {
        await pool.query(`DELETE FROM idx_stock_prices WHERE stock_code='ZZTFLAT' AND date=?`, [ahead]);
      }
    });

    await t('AN UNREADABLE SESSION BLOCKS THE WALK — the engine does not read past it', async () => {
      // The dangerous case: day 2's high/low missing, day 3 reaches the target.
      // Skipping day 2 books a TARGET that may never have happened, because the
      // position could have been stopped out on the bar nobody can read.
      const held = await q(pool,
        `SELECT p.id, p.ticker, p.account_id FROM virtual_positions p JOIN virtual_accounts a ON a.id=p.account_id
          WHERE a.strategy_id=? AND p.status='OPEN' LIMIT 1`, [STRATEGY]);
      assert.ok(held.length, 'need an open position to block');
      const pos = held[0];

      // Blank the high and low on the latest session, then put a target-clearing
      // bar nowhere the engine may legally look yet.
      const last = dates[dates.length - 1];
      const [orig] = await q(pool,
        'SELECT high_price h, low_price l FROM idx_stock_prices WHERE stock_code=? AND date=?', [pos.ticker, last]);
      await pool.query(
        'UPDATE idx_stock_prices SET high_price=0, low_price=0 WHERE stock_code=? AND date=?', [pos.ticker, last]);
      try {
        await vp.cmdResolve(pool, true, OPTS);
        const [after] = await q(pool, 'SELECT status, exit_reason FROM virtual_positions WHERE id=?', [pos.id]);
        assert.strictEqual(after.status, 'OPEN', 'the position must wait, not resolve on a later bar');

        const [ev] = await q(pool,
          `SELECT COUNT(*) n FROM virtual_trade_events WHERE position_id=? AND event='DATA_BLOCKED'`, [pos.id]);
        assert.ok(Number(ev.n) >= 1, 'the block must be journalled, not merely implied by inaction');

        const [acct] = await q(pool,
          'SELECT performance_eligible, data_blocked_json FROM virtual_accounts WHERE id=?', [pos.account_id]);
        assert.strictEqual(Number(acct.performance_eligible), 0,
          'an account with a frozen exit walk cannot report a comparable number');
        assert.ok(acct.data_blocked_json && acct.data_blocked_json.includes(pos.ticker));
      } finally {
        await pool.query(
          'UPDATE idx_stock_prices SET high_price=?, low_price=? WHERE stock_code=? AND date=?',
          [orig.h, orig.l, pos.ticker, last]);
        await vp.cmdResolve(pool, true, OPTS);
      }
    });

    await t('a blocked resolve marks the stage BLOCKED, so later stages can see it', async () => {
      const state = await vp.sessionCalendarState(pool);
      const ahead = (() => {
        const d = new Date(`${state.prices}T00:00:00Z`);
        do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
        return d.toISOString().slice(0, 10);
      })();
      await pool.query(
        `INSERT INTO idx_stock_prices (stock_code, date, open_price, high_price, low_price, close_price)
         VALUES ('ZZTFLAT',?,1000,1010,990,1000) ON DUPLICATE KEY UPDATE open_price=1000`, [ahead]);
      try {
        const r = await vp.cmdResolve(pool, true, OPTS);
        assert.ok(r.blocked, 'expected a blocked resolve');
        const gate = await vp.stageOk(pool, await vp.currentSession(pool), 'resolve');
        assert.strictEqual(gate.ok, false, 'the stage must record the refusal, not just return it');
        assert.ok(/BLOCKED/.test(gate.reason), gate.reason);
      } finally {
        await pool.query(`DELETE FROM idx_stock_prices WHERE stock_code='ZZTFLAT' AND date=?`, [ahead]);
        await vp.cmdResolve(pool, true, OPTS);   // restore the OK stage
      }
    });

    await t('the calendar guard fails closed when PRICES are behind, not only the calendar', async () => {
      // The direction the first version missed: the 19:30 pull fails, the 20:05
      // IHSG refresh succeeds, and the calendar is a session ahead of any price.
      const state = await vp.sessionCalendarState(pool);
      assert.strictEqual(state.blocked, null, 'sanity: healthy right now');
      const ahead = (() => {
        const d = new Date(`${state.calendar}T00:00:00Z`);
        do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
        return d.toISOString().slice(0, 10);
      })();
      await pool.query(
        `INSERT INTO idx_ihsg_history (date, close_price) VALUES (?, 6000)
         ON DUPLICATE KEY UPDATE close_price=6000`, [ahead]);
      try {
        const s = await vp.sessionCalendarState(pool);
        assert.strictEqual(s.blocked, 'PRICE_DATA_STALE',
          `expected PRICE_DATA_STALE, got ${s.blocked} (calendar ${s.calendar}, prices ${s.prices})`);
      } finally {
        await pool.query('DELETE FROM idx_ihsg_history WHERE date=?', [ahead]);
      }
    });

    await t('once the data returns, the account becomes eligible again', async () => {
      const rows = await q(pool,
        'SELECT performance_eligible FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
      for (const r of rows) assert.strictEqual(Number(r.performance_eligible), 1);
    });

    await t('SETUP WORKS ON A COMPLETELY FRESH SCHEMA', async () => {
      // The failure this catches: an ALTER placed above its own CREATE TABLE.
      // Invisible on a database that already has the table, fatal on every new
      // environment — a fresh install, a disaster recovery, a temp CI schema.
      // Production never saw it because production already had the table.
      const db = `zz_fresh_${Date.now().toString(36)}`;
      await pool.query(`CREATE DATABASE \`${db}\``);
      const fresh = mysql.createPool({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
        password: process.env.DB_PASSWORD, database: db, waitForConnections: true, connectionLimit: 2,
      });
      try {
        // setup() reads idx_ihsg_history / ft_strategy_plan for the start date
        // and the strategy hash, so give the empty schema the shape it expects.
        await fresh.query('CREATE TABLE idx_ihsg_history (date DATE PRIMARY KEY, close_price DECIMAL(12,2))');
        await fresh.query(`INSERT INTO idx_ihsg_history VALUES ('2026-08-04', 6320)`);
        await fresh.query('CREATE TABLE idx_stock_prices (stock_code VARCHAR(10), date DATE, PRIMARY KEY(stock_code,date))');
        await fresh.query(`CREATE TABLE ft_strategy_plan (
          id INT AUTO_INCREMENT PRIMARY KEY, strategy_id VARCHAR(64), as_of_date DATE,
          run_mode VARCHAR(16), strategy_hash VARCHAR(32), status VARCHAR(16), target_json TEXT,
          data_snapshot_hash VARCHAR(32), code_commit VARCHAR(40), reason VARCHAR(128))`);

        await vp.setup(fresh, true);   // must not throw

        for (const tbl of ['virtual_accounts', 'virtual_orders', 'virtual_positions',
                           'virtual_trade_events', 'virtual_nav', 'virtual_charter']) {
          const [[r]] = await fresh.query(
            `SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?`, [db, tbl]);
          assert.strictEqual(Number(r.n), 1, `${tbl} was not created`);
        }
        // And the widened column really is wide on a fresh build.
        const [[col]] = await fresh.query(
          `SELECT CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=? AND TABLE_NAME='virtual_positions' AND COLUMN_NAME='exit_reason'`, [db]);
        assert.ok(Number(col.len) >= 24, `exit_reason is only ${col.len} on a fresh schema`);
      } finally {
        await fresh.end();
        await pool.query(`DROP DATABASE \`${db}\``);
      }
    });

    await t('widening a column refuses to run before its table exists', async () => {
      await assert.rejects(
        () => vp.migrateColumn(pool, 'zz_no_such_table', 'x', { minLength: 24, definition: 'VARCHAR(24) NULL', why: 'test' }),
        /does not exist/,
        'the ALTER-before-CREATE mistake must produce a sentence, not a cryptic SQL error');
    });

    await t('MIGRATIONS PROVE THEMSELVES — a widened enum is read back, not assumed', async () => {
      // The old code did ALTER ... .catch(() => {}), so a migration that failed
      // on permissions reported success and the runtime broke hours later.
      await pool.query('DROP TABLE IF EXISTS zz_enum_probe');
      await pool.query(`CREATE TABLE zz_enum_probe (id INT PRIMARY KEY, status ENUM('A','B') NOT NULL DEFAULT 'A')`);
      await pool.query(`INSERT INTO zz_enum_probe (id,status) VALUES (1,'A')`);
      try {
        const r = await vp.migrateEnum(pool, 'zz_enum_probe', 'status', ['A', 'B', 'C'], `NOT NULL DEFAULT 'A'`);
        assert.strictEqual(r.migrated, true);
        // The proof the review asked for: the new value can actually be written.
        await pool.query(`UPDATE zz_enum_probe SET status='C' WHERE id=1`);
        const [row] = await q(pool, 'SELECT status FROM zz_enum_probe WHERE id=1');
        assert.strictEqual(row.status, 'C');
        // And re-running is a no-op rather than a repeated ALTER.
        const again = await vp.migrateEnum(pool, 'zz_enum_probe', 'status', ['A', 'B', 'C'], `NOT NULL DEFAULT 'A'`);
        assert.strictEqual(again.alreadyCurrent, true);
      } finally {
        await pool.query('DROP TABLE IF EXISTS zz_enum_probe');
      }
    });

    await t('a migration that CANNOT succeed throws instead of reporting success', async () => {
      await assert.rejects(
        () => vp.migrateEnum(pool, 'zz_table_that_does_not_exist', 'status', ['A'], 'NULL'),
        /does not exist/,
        'a missing table must not be swallowed');
    });

    await t('PENDING ORDERS ARE CANCELLED when the contract changes, not inherited', async () => {
      // An order scheduled under v1 and filled by v2's resolver is recorded as
      // v1 while being executed by a different algorithm.
      const acct = (await q(pool,
        `SELECT id FROM virtual_accounts WHERE strategy_id=? AND exit_policy='INTRADAY_EOD'`, [STRATEGY]))[0];
      await pool.query(
        `INSERT INTO virtual_orders (account_id, ticker, side, signal_date, status, execution_policy_hash)
         VALUES (?, 'ZZTSTOP', 'BUY', ?, 'DATA_PENDING', 'x')
         ON DUPLICATE KEY UPDATE status='DATA_PENDING'`, [acct.id, dates[dates.length - 3]]);
      await pool.query(
        `UPDATE virtual_accounts SET execution_policy_hash='0000gonepolicy2' WHERE id=?`, [acct.id]);
      try {
        await vp.retireSupersededAccounts(pool, STRATEGY, true);
        const [o] = await q(pool,
          `SELECT status, reject_reason FROM virtual_orders WHERE account_id=? AND ticker='ZZTSTOP' AND signal_date=?`,
          [acct.id, dates[dates.length - 3]]);
        assert.strictEqual(o.status, 'CANCELLED', 'a DATA_PENDING order survived a contract change');
        assert.ok(/POLICY_CHANGE|STRATEGY_CHANGE/.test(o.reject_reason), o.reject_reason);
      } finally {
        await pool.query(`DELETE FROM virtual_orders WHERE account_id=? AND ticker='ZZTSTOP' AND signal_date=?`,
          [acct.id, dates[dates.length - 3]]);
        await pool.query(
          `UPDATE virtual_accounts SET execution_policy_hash=?, status='ACTIVE' WHERE id=?`,
          [vb.executionPolicyHash({}, 'INTRADAY_EOD'), acct.id]);
      }
    });

    await t('A FORCED EXIT CANNOT PRECEDE THE DECISION TO RETIRE', async () => {
      // This test used to assert the opposite, and locked in the bug: it
      // demanded the account be empty after ONE cmdResolve, which could only
      // happen by selling at the latest session's open. Retirement is detected
      // by the nightly chain around 20:10 WIB; that open was ~09:00, eleven
      // hours earlier. The record said the account sold before anyone decided
      // to retire it.
      const acct = (await q(pool,
        `SELECT id FROM virtual_accounts WHERE strategy_id=? AND exit_policy='POSITION'`, [STRATEGY]))[0];
      const before = await q(pool,
        `SELECT COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
      assert.ok(Number(before[0].n) >= 1, 'need an open position to unwind');

      await pool.query(`UPDATE virtual_accounts SET execution_policy_hash='0000gonepolicy3' WHERE id=?`, [acct.id]);
      try {
        await vp.retireSupersededAccounts(pool, STRATEGY, true);
        const [st] = await q(pool,
          'SELECT status, retirement_session, retirement_reason FROM virtual_accounts WHERE id=?', [acct.id]);
        assert.strictEqual(st.status, 'RETIRING');
        assert.ok(st.retirement_session, 'the session the decision was made on must be recorded');
        assert.ok(/POLICY_CHANGE|STRATEGY_CHANGE/.test(st.retirement_reason), st.retirement_reason);

        // The decision was recorded on the LATEST session, so there is no session
        // after it yet. The position must WAIT.
        await vp.cmdResolve(pool, true, OPTS);
        const [stillOpen] = await q(pool,
          `SELECT COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
        assert.strictEqual(Number(stillOpen.n), Number(before[0].n),
          'the position was sold at an open that happened before the retirement decision');

        // Backdate the decision by one session; now a later session exists and
        // the unwind may legitimately happen there.
        const priorSession = dates[dates.length - 2];
        await pool.query('UPDATE virtual_accounts SET retirement_session=? WHERE id=?', [priorSession, acct.id]);
        await vp.cmdResolve(pool, true, OPTS);

        const [after] = await q(pool,
          `SELECT COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
        assert.strictEqual(Number(after.n), 0, 'the retiring account still holds positions');

        const [closedRow] = await q(pool,
          `SELECT exit_reason, exit_date FROM virtual_positions WHERE account_id=? AND status='CLOSED'
            ORDER BY id DESC LIMIT 1`, [acct.id]);
        assert.ok(/_CHANGE_EXIT$/.test(closedRow.exit_reason),
          `expected an explicit policy/strategy exit, got ${closedRow.exit_reason}`);
        const exitDate = String(closedRow.exit_date).slice(0, 10).includes('-')
          ? String(closedRow.exit_date).slice(0, 10)
          : new Date(closedRow.exit_date).toISOString().slice(0, 10);
        assert.ok(exitDate > priorSession,
          `the exit (${exitDate}) must be strictly after the decision (${priorSession})`);
      } finally {
        await pool.query(
          `UPDATE virtual_accounts SET execution_policy_hash=?, status='ACTIVE',
                  retirement_session=NULL, retirement_reason=NULL WHERE id=?`,
          [vb.executionPolicyHash({}, 'POSITION'), acct.id]);
      }
    });

    console.log('\nvirtual portfolio — a changed execution contract');

    // LAST on purpose. This inserts an extra account row, and an extra row is
    // exactly the kind of thing that quietly perturbs whatever runs after it —
    // it did, the first time this was written: the cash helper was keyed on
    // exit_policy, the stale row shared that policy, and the restore in the
    // corrupt-cash test wrote the wrong balance back.
    await t('an account under a superseded execution contract is retired, not run alongside', async () => {
      // Caught live on 2026-08-04: adding the risk layer changed the policy
      // hash, so the new account row landed BESIDE the old one, both stayed
      // ACTIVE, and every stage ran twice against four accounts.
      await pool.query(
        `INSERT INTO virtual_accounts (account_code, strategy_id, strategy_hash, exit_policy, execution_policy_hash,
                                       config_json, starting_cash, cash_balance, total_nav)
         VALUES ('TEST_STALE_CONTRACT',?,?,'POSITION','0000staleconTract','{}',100000000,100000000,100000000)`,
        [STRATEGY, PLAN_HASH]);
      const before = await vp.loadAccounts(pool, STRATEGY);
      assert.strictEqual(before.length, 3, 'the stale row must be ACTIVE to begin with, or this proves nothing');

      const retired = await vp.retireSupersededAccounts(pool, STRATEGY, true);
      assert.strictEqual(retired.length, 1, 'exactly the stale row, and nothing else');
      assert.strictEqual(retired[0].execution_policy_hash, '0000staleconTract');

      const after = await vp.loadAccounts(pool, STRATEGY);
      assert.strictEqual(after.length, 2, 'the two current contracts must survive');
      const [[stale]] = await pool.query(
        `SELECT status FROM virtual_accounts WHERE execution_policy_hash='0000staleconTract'`);
      assert.strictEqual(stale.status, 'CLOSED', 'retired, not deleted — its history is the record of what it did');
    });

  } catch (e) {
    fail++;
    console.log(`\n  FAIL  the run itself threw\n          ${e.stack}`);
  } finally {
    if (pool) {
      try {
        await cleanup(pool);
        const [left] = await pool.query('SELECT COUNT(*) n FROM virtual_accounts WHERE strategy_id=?', [STRATEGY]);
        const [px] = await pool.query('SELECT COUNT(*) n FROM idx_stock_prices WHERE stock_code IN (?)', [TICKERS]);
        if (Number(left[0].n) || Number(px[0].n)) {
          fail++;
          console.log(`  FAIL  cleanup left ${left[0].n} account(s) and ${px[0].n} synthetic price row(s) behind`);
        }
      } catch (e) {
        fail++;
        console.log(`  FAIL  cleanup threw: ${e.message}`);
      }
      await pool.end();
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
