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
        `INSERT INTO virtual_accounts (account_code, strategy_id, exit_policy, execution_policy_hash,
                                       config_json, starting_cash, cash_balance, total_nav)
         VALUES (?,?,?,?,?,?,?,?)`,
        [`TEST_${a.exitPolicy}`, STRATEGY, a.exitPolicy, vb.executionPolicyHash({}, a.exitPolicy),
         JSON.stringify(vb.DEFAULT_CONFIG), 100_000_000, 100_000_000, 100_000_000]);
    }
    await pool.query(
      `INSERT INTO ft_strategy_plan (strategy_id, as_of_date, run_mode, generated_at, strategy_hash,
                                     data_snapshot_hash, code_commit, exposure, reason, regime_label,
                                     eligible, vetoed, target_json, status)
       VALUES (?,?,'LIVE',NOW(),?,?,?,1.00,'TEST PLAN','INVESTED',?,0,?,'PLANNED')`,
      [STRATEGY, signalDate, 'testvirtual00001', 'testsnapshot0001', 'testcommit',
       TICKERS.length, JSON.stringify(TICKERS)]);

    console.log('\nvirtual portfolio — scheduling');

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
      assert.ok(problems.some(p => /impossible stop/.test(p)),
        `expected a stop failure, got: ${JSON.stringify(problems)}`);
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
        `INSERT INTO virtual_accounts (account_code, strategy_id, exit_policy, execution_policy_hash,
                                       config_json, starting_cash, cash_balance, total_nav)
         VALUES ('TEST_STALE_CONTRACT',?,'POSITION','0000staleconTract','{}',100000000,100000000,100000000)`,
        [STRATEGY]);
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
