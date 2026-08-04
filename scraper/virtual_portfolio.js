/**
 * Virtual portfolio — a simulated Rp100 juta account driven by the system's own
 * recommendations, with a real cash ledger.
 *
 * TWO ACCOUNTS, NEVER POOLED (2026-08-04 design):
 *
 *   POSITION_100M       stop, target, or 40 bars   — the horizon this engine was built for
 *   INTRADAY_EOD_100M   stop, target, or the close of the entry day
 *
 * Same recommendation source, different execution policy, separate
 * execution_policy_hash, separate cash, separate journal, separate performance.
 * The question they exist to answer is whether this system's edge, if it has
 * one, appears intraday or needs weeks.
 *
 * THE ANSWER IS ALREADY EXPECTED FOR ONE OF THEM. EXP-019 measured the
 * same-day rule at -0.951% per trade on this system's own BUY days (n=2,204,
 * t=-18.5), against a -0.673% unconditional base rate. INTRADAY_EOD_100M should
 * lose. It is run to confirm that forward, and it must not be tuned until it
 * stops losing.
 *
 * THE LEDGER IS THE TRUTH, NOT THE JOURNAL. Cash, positions and fills are the
 * source; virtual_trade_events is an append-only view of what happened to them.
 * If the journal could be edited and also drive accounting, sooner or later the
 * journal says CLOSED while the position is OPEN, the cash never received the
 * proceeds, and the NAV is wrong. Every order resolution runs in one
 * transaction: order, position, cash, event, NAV — all of it or none.
 *
 * EOD SIMULATION, NOT LIVE EXECUTION. Daily OHLC says a level was touched, never
 * in what order, so both-touched resolves to STOP. Nothing here pretends an
 * order existed before the close.
 *
 * Usage:
 *   node virtual_portfolio.js resolve    # settle yesterday's scheduled orders
 *   node virtual_portfolio.js schedule   # freeze tomorrow's orders from today's plan
 *   node virtual_portfolio.js mark       # cash + market value -> NAV
 *   node virtual_portfolio.js reconcile  # invariants; exits non-zero if any broke
 *   node virtual_portfolio.js status
 *   node virtual_portfolio.js            # resolve, schedule, mark, reconcile
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const vb = require('./modules/virtual_broker');
const sb = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const SOURCE_STRATEGY = 'HI52W_REGIME_BROKERVETO_V1';

const ACCOUNTS = [
  { code: 'POSITION_100M', exitPolicy: vb.EXIT_POLICIES.POSITION },
  { code: 'INTRADAY_EOD_100M', exitPolicy: vb.EXIT_POLICIES.INTRADAY_EOD },
];

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : (d ? String(d).slice(0, 10) : null);

const rp = n => 'Rp ' + Math.round(Number(n)).toLocaleString('en-US');

async function hasColumn(pool, table, column) {
  const [r] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`,
    [table, column]);
  return r.length > 0;
}

async function setup(pool, quiet = false) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_code VARCHAR(32) NOT NULL,
      strategy_id VARCHAR(64) NOT NULL,
      exit_policy VARCHAR(16) NOT NULL,
      execution_policy_hash VARCHAR(32) NOT NULL,
      config_json TEXT NULL,
      starting_cash DECIMAL(20,2) NOT NULL,
      cash_balance DECIMAL(20,2) NOT NULL,
      total_nav DECIMAL(20,2) NOT NULL,
      status ENUM('ACTIVE','CLOSED') NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_account (account_code, execution_policy_hash)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      source_plan_id INT NULL,
      ticker VARCHAR(10) NOT NULL,
      side ENUM('BUY') NOT NULL DEFAULT 'BUY',
      signal_date DATE NOT NULL,
      scheduled_entry_date DATE NULL,
      intended_notional DECIMAL(20,2) NULL,
      quantity INT NULL,
      status ENUM('SCHEDULED','FILLED','NO_FILL','REJECTED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
      reject_reason VARCHAR(48) NULL,
      strategy_hash VARCHAR(32) NULL,
      execution_policy_hash VARCHAR(32) NOT NULL,
      data_snapshot_hash VARCHAR(32) NULL,
      code_commit VARCHAR(40) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      -- One order per name per signal date per account. This is what makes a
      -- duplicate recommendation, or a re-run of the same cron, a no-op.
      UNIQUE KEY uq_order (account_id, ticker, signal_date),
      KEY idx_status (account_id, status)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_positions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      order_id INT NOT NULL,
      ticker VARCHAR(10) NOT NULL,
      quantity INT NOT NULL,
      entry_date DATE NOT NULL,
      entry_price DECIMAL(15,2) NOT NULL,
      stop_price DECIMAL(15,2) NULL,
      target_price DECIMAL(15,2) NULL,
      cost_basis DECIMAL(20,2) NOT NULL,
      entry_fee DECIMAL(20,2) NOT NULL,
      status ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
      exit_date DATE NULL,
      exit_price DECIMAL(15,2) NULL,
      exit_reason VARCHAR(16) NULL,
      exit_fee DECIMAL(20,2) NULL,
      proceeds DECIMAL(20,2) NULL,
      gross_pnl DECIMAL(20,2) NULL,
      net_pnl DECIMAL(20,2) NULL,
      return_pct DECIMAL(10,4) NULL,
      holding_bars INT NULL,
      ambiguous_exit TINYINT(1) NOT NULL DEFAULT 0,
      UNIQUE KEY uq_position (order_id),
      KEY idx_open (account_id, status)
    )`);

  // Append-only. Never updated, never deleted: the lifecycle has to stay
  // auditable even when the current status says something simple.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_trade_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      order_id INT NULL,
      position_id INT NULL,
      ticker VARCHAR(10) NULL,
      event VARCHAR(24) NOT NULL,
      event_date DATE NOT NULL,
      detail_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_account (account_id, event_date)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_nav (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_id INT NOT NULL,
      mark_date DATE NOT NULL,
      cash_value DECIMAL(20,2) NOT NULL,
      market_value DECIMAL(20,2) NOT NULL,
      total_nav DECIMAL(20,2) NOT NULL,
      realized_pnl DECIMAL(20,2) NOT NULL,
      unrealized_pnl DECIMAL(20,2) NOT NULL,
      gross_exposure DECIMAL(10,6) NOT NULL,
      open_positions INT NOT NULL,
      unmarkable VARCHAR(255) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mark (account_id, mark_date)
    )`);

  for (const a of ACCOUNTS) {
    const hash = vb.executionPolicyHash({}, a.exitPolicy);
    await pool.query(
      `INSERT IGNORE INTO virtual_accounts
         (account_code, strategy_id, exit_policy, execution_policy_hash, config_json,
          starting_cash, cash_balance, total_nav)
       VALUES (?,?,?,?,?,?,?,?)`,
      [a.code, SOURCE_STRATEGY, a.exitPolicy, hash, JSON.stringify(vb.DEFAULT_CONFIG),
       vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash]);
  }

  await retireSupersededAccounts(pool, SOURCE_STRATEGY, quiet);
}

/**
 * Retire accounts running under an execution contract that no longer exists.
 *
 * Changing a fee, the slippage or the risk layer changes execution_policy_hash,
 * which is the point — the new record is a different experiment. But the unique
 * key is (account_code, execution_policy_hash), so the new row lands BESIDE the
 * old one and both are ACTIVE. Caught live on 2026-08-04: every account ran
 * twice and the integrity check reported four accounts where there are two.
 *
 * The old row is CLOSED, never deleted: its orders, positions and NAV history
 * are the record of what that contract did, and a superseded contract must stop
 * accruing new trades without its past being erased. It is announced loudly
 * when it had any history, because that is a track record ending.
 */
async function retireSupersededAccounts(pool, strategyId, quiet = false) {
  const current = new Set(ACCOUNTS.map(a => vb.executionPolicyHash({}, a.exitPolicy)));
  const [rows] = await pool.query(
    `SELECT a.id, a.account_code, a.execution_policy_hash,
            (SELECT COUNT(*) FROM virtual_positions p WHERE p.account_id = a.id) positions
       FROM virtual_accounts a WHERE a.strategy_id=? AND a.status='ACTIVE'`, [strategyId]);

  const stale = rows.filter(r => !current.has(r.execution_policy_hash));
  for (const r of stale) {
    await pool.query(`UPDATE virtual_accounts SET status='CLOSED' WHERE id=?`, [r.id]);
    if (quiet) continue;
    console.log(`SETUP  retired ${r.account_code} (policy ${r.execution_policy_hash}) — the execution contract changed`);
    if (Number(r.positions) > 0) {
      console.log(`       it holds ${r.positions} position(s) of history, kept and CLOSED, not deleted.`);
      console.log('       Its track record ends here and must not be pooled with the new one.');
    }
  }
  return stale;
}

/**
  * The active accounts for one strategy. `strategyId` is a parameter and not a
  * constant so the integration test can drive the real functions against its own
  * throwaway accounts instead of the live ledger.
  */
async function loadAccounts(pool, strategyId = SOURCE_STRATEGY) {
  const [rows] = await pool.query(
    `SELECT * FROM virtual_accounts WHERE strategy_id=? AND status='ACTIVE' ORDER BY account_code`, [strategyId]);
  return rows;
}

/** Daily bars, keyed ticker -> date -> {open,high,low,close}, plus the trading-date axis. */
async function loadBars(pool, sinceDays = 120) {
  const [dateRows] = await pool.query(
    'SELECT DISTINCT date FROM idx_stock_prices WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY date', [sinceDays]);
  const dates = dateRows.map(r => toDateStr(r.date));
  const [rows] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c
       FROM idx_stock_prices WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`, [sinceDays]);
  const bars = new Map();
  for (const r of rows) {
    const t = r.stock_code;
    if (!bars.has(t)) bars.set(t, new Map());
    bars.get(t).set(toDateStr(r.date), { open: +r.o, high: +r.h, low: +r.l, close: +r.c });
  }
  return { bars, dates, dateIdx: new Map(dates.map((d, i) => [d, i])) };
}

async function logEvent(conn, accountId, event, eventDate, { orderId = null, positionId = null, ticker = null, detail = null } = {}) {
  await conn.query(
    `INSERT INTO virtual_trade_events (account_id, order_id, position_id, ticker, event, event_date, detail_json)
     VALUES (?,?,?,?,?,?,?)`,
    [accountId, orderId, positionId, ticker, event, eventDate, detail ? JSON.stringify(detail) : null]);
}

/**
 * SCHEDULE — freeze tomorrow's orders from the latest frozen plan.
 *
 * No entry price here, deliberately: the plan is decided on today's close and
 * the fill happens at tomorrow's open, which does not exist yet. Only the
 * INTENDED notional is recorded; the quantity is computed at resolve time, once
 * the entry and therefore the stop distance are known.
 */
async function cmdSchedule(pool, quiet, { strategyId = SOURCE_STRATEGY } = {}) {
  const accounts = await loadAccounts(pool, strategyId);
  const [[plan]] = await pool.query(
    `SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND run_mode='LIVE' AND status IN ('PLANNED','PARTIALLY_FILLED','EXECUTED')
      ORDER BY as_of_date DESC LIMIT 1`, [strategyId]);
  if (!plan) { if (!quiet) console.log('SCHEDULE  no plan to work from.'); return { scheduled: 0 }; }

  const target = JSON.parse(plan.target_json || '[]');
  const signalDate = toDateStr(plan.as_of_date);
  let scheduled = 0, skipped = 0;

  for (const acct of accounts) {
    for (const ticker of target) {
      const [r] = await pool.query(
        `INSERT IGNORE INTO virtual_orders
           (account_id, source_plan_id, ticker, side, signal_date, status,
            strategy_hash, execution_policy_hash, data_snapshot_hash, code_commit)
         VALUES (?,?,?,'BUY',?, 'SCHEDULED', ?,?,?,?)`,
        [acct.id, plan.id, ticker, signalDate,
         plan.strategy_hash, acct.execution_policy_hash, plan.data_snapshot_hash, plan.code_commit]);
      if (r.affectedRows === 1) {
        scheduled++;
        await logEvent(pool, acct.id, 'ORDER_SCHEDULED', signalDate, { ticker, detail: { planId: plan.id } });
      } else skipped++;
    }
  }
  if (!quiet) {
    console.log(`SCHEDULE  ${signalDate}  ${plan.reason}`);
    console.log(`  ${scheduled} order(s) scheduled, ${skipped} already existed (a duplicate recommendation is a no-op)`);
    if (!target.length) console.log('  the book is empty, so there is nothing to schedule — that is a decision, not a failure');
  }
  return { scheduled, skipped };
}

/**
 * RESOLVE — fill scheduled orders at the next open, then run every open
 * position through the bars that have landed since.
 *
 * One transaction per order: the order, the position, the cash and the event
 * move together or not at all.
 */
async function cmdResolve(pool, quiet, { strategyId = SOURCE_STRATEGY } = {}) {
  const accounts = await loadAccounts(pool, strategyId);
  const { bars, dates, dateIdx } = await loadBars(pool);
  const summary = [];

  for (const acct of accounts) {
    const cfg = { ...vb.DEFAULT_CONFIG, ...(acct.config_json ? JSON.parse(acct.config_json) : {}) };
    let filled = 0, noFill = 0, rejected = 0, closed = 0;

    // ── fills ────────────────────────────────────────────────────────────
    const [orders] = await pool.query(
      `SELECT * FROM virtual_orders WHERE account_id=? AND status='SCHEDULED' ORDER BY signal_date, ticker`, [acct.id]);

    for (const o of orders) {
      const sIdx = dateIdx.get(toDateStr(o.signal_date));
      if (sIdx === undefined || sIdx + 1 >= dates.length) continue;   // execution bar has not landed
      const entryDate = dates[sIdx + 1];
      const bar = bars.get(o.ticker)?.get(entryDate);

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[acc]] = await conn.query('SELECT cash_balance, total_nav FROM virtual_accounts WHERE id=? FOR UPDATE', [acct.id]);
        const [[expo]] = await conn.query(
          `SELECT COALESCE(SUM(cost_basis),0) gross, COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);

        if (!bar || !(bar.open > 0)) {
          await conn.query(`UPDATE virtual_orders SET status='NO_FILL', reject_reason='NO_OPEN_PRICE' WHERE id=?`, [o.id]);
          await logEvent(conn, acct.id, 'NO_FILL', entryDate, { orderId: o.id, ticker: o.ticker });
          noFill++;
        } else {
          const entry = bar.open;
          // Stop and target from the ACTIVE TRADE POLICY, not an invented
          // number: risk-based sizing is only as meaningful as its stop.
          // ATR is computed from bars up to and including the SIGNAL date and
          // no further — the entry is the next morning, and an ATR that saw
          // that bar would be sizing the position with tomorrow's information.
          const hist = [];
          for (let k = Math.max(0, sIdx - 20); k <= sIdx; k++) {
            const b = bars.get(o.ticker)?.get(dates[k]);
            if (b) hist.push(b);
          }
          const atr = vb.atrFrom(hist);
          // One basis for everything: the price actually paid. Levels off the
          // quoted open while the ledger records the fill would leave
          // entry_price - stop_price disagreeing with the policy's 2.5 x ATR.
          const fillPrice = entry * (1 + cfg.slippage);
          const lv = vb.tradeLevels(fillPrice, atr, cfg);
          const stop = lv.stopPrice, targetPx = lv.targetPrice;
          const size = vb.sizeOrder({
            nav: Number(acc.total_nav), cash: Number(acc.cash_balance),
            entryPrice: entry, fillPrice, stopPrice: stop,
            grossExposure: Number(expo.gross), openPositions: Number(expo.n), config: cfg,
          });

          if (size.quantity <= 0) {
            await conn.query(`UPDATE virtual_orders SET status='REJECTED', reject_reason=? WHERE id=?`, [size.rejectReason, o.id]);
            await logEvent(conn, acct.id, 'REJECTED', entryDate, { orderId: o.id, ticker: o.ticker, detail: size });
            rejected++;
          } else {
            const cost = vb.buyCost(size.quantity, entry, cfg);
            await conn.query(
              `UPDATE virtual_orders SET status='FILLED', quantity=?, intended_notional=?, scheduled_entry_date=? WHERE id=?`,
              [size.quantity, cost.total, entryDate, o.id]);
            const [pos] = await conn.query(
              `INSERT INTO virtual_positions
                 (account_id, order_id, ticker, quantity, entry_date, entry_price, stop_price, target_price,
                  cost_basis, entry_fee, status)
               VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN')`,
              [acct.id, o.id, o.ticker, size.quantity, entryDate, cost.fillPrice, stop, targetPx, cost.total, cost.fee]);
            await conn.query('UPDATE virtual_accounts SET cash_balance = cash_balance - ? WHERE id=?', [cost.total, acct.id]);
            await logEvent(conn, acct.id, 'ORDER_FILLED', entryDate,
              { orderId: o.id, positionId: pos.insertId, ticker: o.ticker,
                detail: { qty: size.quantity, price: cost.fillPrice, cappedBy: size.cappedBy,
                          stop, target: targetPx, atr, atrFallback: lv.usedFallback } });
            await logEvent(conn, acct.id, 'STOP_SET', entryDate, { positionId: pos.insertId, ticker: o.ticker, detail: { stop } });
            await logEvent(conn, acct.id, 'TARGET_SET', entryDate, { positionId: pos.insertId, ticker: o.ticker, detail: { target: targetPx } });
            filled++;
          }
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback();
        console.error(`RESOLVE  order ${o.id} rolled back: ${e.message}`);
      } finally { conn.release(); }
    }

    // ── exits ────────────────────────────────────────────────────────────
    const [open] = await pool.query(
      `SELECT * FROM virtual_positions WHERE account_id=? AND status='OPEN' ORDER BY entry_date`, [acct.id]);

    for (const p of open) {
      const eIdx = dateIdx.get(toDateStr(p.entry_date));
      if (eIdx === undefined) continue;
      // Walk forward from the entry bar. INTRADAY_EOD resolves on the entry bar
      // itself; POSITION may run for many.
      for (let i = eIdx; i < dates.length; i++) {
        const d = dates[i];
        const bar = bars.get(p.ticker)?.get(d);
        const r = vb.resolveBar({
          bar, stopPrice: Number(p.stop_price), targetPrice: Number(p.target_price),
          exitPolicy: acct.exit_policy, barsHeld: i - eIdx + 1, config: cfg,
        });
        if (r.open) continue;

        const proceeds = vb.sellProceeds(p.quantity, r.exitPrice, cfg);
        const grossPnl = proceeds.gross - (Number(p.cost_basis) - Number(p.entry_fee));
        const netPnl = proceeds.net - Number(p.cost_basis);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [upd] = await conn.query(
            `UPDATE virtual_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, exit_fee=?,
                    proceeds=?, gross_pnl=?, net_pnl=?, return_pct=?, holding_bars=?, ambiguous_exit=?
              WHERE id=? AND status='OPEN'`,
            [d, proceeds.fillPrice, r.exitReason, proceeds.fee, proceeds.net, grossPnl, netPnl,
             (netPnl / Number(p.cost_basis)) * 100, i - eIdx + 1, r.ambiguous ? 1 : 0, p.id]);
          if (upd.affectedRows === 1) {
            await conn.query('UPDATE virtual_accounts SET cash_balance = cash_balance + ? WHERE id=?', [proceeds.net, acct.id]);
            await logEvent(conn, acct.id, r.exitReason, d,
              { positionId: p.id, ticker: p.ticker, detail: { price: proceeds.fillPrice, netPnl, ambiguous: !!r.ambiguous } });
            closed++;
          }
          await conn.commit();
        } catch (e) {
          await conn.rollback();
          console.error(`RESOLVE  exit ${p.id} rolled back: ${e.message}`);
        } finally { conn.release(); }
        break;
      }
    }
    summary.push({ account: acct.account_code, filled, noFill, rejected, closed });
  }

  if (!quiet) for (const s of summary) {
    console.log(`RESOLVE  ${s.account.padEnd(20)} filled ${s.filled}, no-fill ${s.noFill}, rejected ${s.rejected}, closed ${s.closed}`);
  }
  return summary;
}

/** MARK — cash plus market value, reconciled and stored. */
async function cmdMark(pool, quiet, { strategyId = SOURCE_STRATEGY } = {}) {
  const accounts = await loadAccounts(pool, strategyId);
  const { bars, dates } = await loadBars(pool, 30);
  const today = dates[dates.length - 1];
  const out = [];

  for (const acct of accounts) {
    const [open] = await pool.query(
      `SELECT ticker, quantity, cost_basis FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
    const [[realized]] = await pool.query(
      `SELECT COALESCE(SUM(net_pnl),0) r FROM virtual_positions WHERE account_id=? AND status='CLOSED'`, [acct.id]);
    const [[acc]] = await pool.query('SELECT cash_balance, starting_cash FROM virtual_accounts WHERE id=?', [acct.id]);

    const m = vb.markToMarket({
      cash: Number(acc.cash_balance), positions: open,
      priceOf: t => bars.get(t)?.get(today)?.close || 0,
    });
    const openCost = open.reduce((a, p) => a + Number(p.cost_basis), 0);
    const unrealized = m.marketValue - openCost;

    await pool.query(
      `INSERT INTO virtual_nav (account_id, mark_date, cash_value, market_value, total_nav,
                                realized_pnl, unrealized_pnl, gross_exposure, open_positions, unmarkable)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE cash_value=VALUES(cash_value), market_value=VALUES(market_value),
         total_nav=VALUES(total_nav), realized_pnl=VALUES(realized_pnl), unrealized_pnl=VALUES(unrealized_pnl),
         gross_exposure=VALUES(gross_exposure), open_positions=VALUES(open_positions), unmarkable=VALUES(unmarkable)`,
      [acct.id, today, m.cash, m.marketValue, m.totalNav, Number(realized.r), unrealized,
       m.totalNav > 0 ? m.marketValue / m.totalNav : 0, open.length, m.unmarkable.join(',') || null]);
    await pool.query('UPDATE virtual_accounts SET total_nav=? WHERE id=?', [m.totalNav, acct.id]);

    out.push({ account: acct.account_code, ...m, realized: Number(realized.r), unrealized, startingCash: Number(acc.starting_cash) });
  }

  if (!quiet) for (const o of out) {
    const ret = (o.totalNav / o.startingCash - 1) * 100;
    console.log(`MARK  ${o.account.padEnd(20)} NAV ${rp(o.totalNav)}  (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)`);
    console.log(`      cash ${rp(o.cash)} + market ${rp(o.marketValue)}   realized ${rp(o.realized)}   unrealized ${rp(o.unrealized)}`);
    if (o.cash < -1e-6) console.log('      ** NEGATIVE CASH — the account borrowed, which must not happen');
    if (o.unmarkable.length) console.log(`      carried at cost, no price: ${o.unmarkable.join(', ')}`);
  }
  return out;
}

async function cmdStatus(pool) {
  const accounts = await loadAccounts(pool);
  for (const acct of accounts) {
    const [[nav]] = await pool.query(
      'SELECT * FROM virtual_nav WHERE account_id=? ORDER BY mark_date DESC LIMIT 1', [acct.id]);
    const [[c]] = await pool.query(
      `SELECT COUNT(*) n, COALESCE(SUM(net_pnl),0) pnl, SUM(net_pnl>0) wins,
              COALESCE(SUM(CASE WHEN net_pnl>0 THEN net_pnl ELSE 0 END),0) gp,
              COALESCE(SUM(CASE WHEN net_pnl<0 THEN -net_pnl ELSE 0 END),0) gl,
              SUM(exit_reason='STOP') stops, SUM(exit_reason='TARGET') targets,
              SUM(exit_reason='EOD_CLOSE') eods, SUM(exit_reason='TIME_EXIT') times,
              SUM(ambiguous_exit) ambiguous
         FROM virtual_positions WHERE account_id=? AND status='CLOSED'`, [acct.id]);
    const [[o]] = await pool.query(
      `SELECT COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);

    console.log(`\n${'─'.repeat(74)}`);
    console.log(`${acct.account_code}   exit ${acct.exit_policy}   policy ${acct.execution_policy_hash}`);
    console.log('─'.repeat(74));
    console.log(`Starting        ${rp(acct.starting_cash)}`);
    if (nav) {
      const ret = (Number(nav.total_nav) / Number(acct.starting_cash) - 1) * 100;
      console.log(`NAV             ${rp(nav.total_nav)}   ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%   marked ${toDateStr(nav.mark_date)}`);
      console.log(`  cash ${rp(nav.cash_value)} + market ${rp(nav.market_value)}   exposure ${(Number(nav.gross_exposure) * 100).toFixed(1)}%`);
    } else {
      console.log('NAV             not marked yet — run `mark`');
    }
    console.log(`Closed trades   ${c.n || 0}   open ${o.n || 0}`);
    if (c.n > 0) {
      const pf = Number(c.gl) > 0 ? Number(c.gp) / Number(c.gl) : (Number(c.gp) > 0 ? Infinity : null);
      console.log(`  net P&L ${rp(c.pnl)}   win rate ${((c.wins / c.n) * 100).toFixed(1)}%   profit factor ${pf === null ? 'n/a' : pf === Infinity ? '∞' : pf.toFixed(2)}`);
      console.log(`  exits: STOP ${c.stops || 0}, TARGET ${c.targets || 0}, EOD_CLOSE ${c.eods || 0}, TIME_EXIT ${c.times || 0}`);
      if (Number(c.ambiguous) > 0) {
        console.log(`  ${c.ambiguous} exit(s) had stop AND target on one bar and were resolved to STOP — daily data cannot order them`);
      }
    }
    if (acct.exit_policy === vb.EXIT_POLICIES.INTRADAY_EOD) {
      console.log('  EXPECTED TO LOSE. EXP-019 measured this rule at -0.951%/trade on this');
      console.log('  system\'s own BUY days (n=2,204, t=-18.5). It runs to confirm that forward.');
    }
  }
  console.log('\nThese are simulated accounts. No orders are placed anywhere.');
}

/**
 * RECONCILE — the checks the design asks for at the end of the cycle.
 *
 * Not a printout. Every item here is an invariant that, if it ever breaks,
 * means a number somewhere is a lie: cash that went negative, a NAV that does
 * not equal what the account holds, a fill with no position behind it. Exits
 * non-zero so the cron leaves a trace instead of a silent wrong balance —
 * this system's recurring failure has been work that fails while reporting
 * success, and an integrity check that cannot fail would be another one.
 */
async function cmdReconcile(pool, { strategyId = SOURCE_STRATEGY } = {}) {
  const accounts = await loadAccounts(pool, strategyId);
  const problems = [];
  const check = (ok, msg) => { if (!ok) problems.push(msg); };

  for (const acct of accounts) {
    const A = acct.account_code;
    const [[led]] = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN status='OPEN'   THEN cost_basis END),0) openCost,
              COALESCE(SUM(CASE WHEN status='CLOSED' THEN net_pnl    END),0) realized,
              SUM(status='OPEN') nOpen
         FROM virtual_positions WHERE account_id=?`, [acct.id]);
    const cash = Number(acct.cash_balance);
    const expected = Number(acct.starting_cash) - Number(led.openCost) + Number(led.realized);

    check(cash >= -1e-6, `${A}: cash is NEGATIVE (${rp(cash)}) — the account borrowed`);
    check(Math.abs(cash - expected) < 1,
      `${A}: cash ${rp(cash)} does not equal starting - open cost + realized (${rp(expected)})`);
    check(Number(led.nOpen) <= vb.DEFAULT_CONFIG.maxPositions,
      `${A}: ${led.nOpen} open positions, the limit is ${vb.DEFAULT_CONFIG.maxPositions}`);

    const [[nav]] = await pool.query(
      'SELECT * FROM virtual_nav WHERE account_id=? ORDER BY mark_date DESC LIMIT 1', [acct.id]);
    if (nav) {
      check(Math.abs(Number(nav.total_nav) - (Number(nav.cash_value) + Number(nav.market_value))) < 1,
        `${A}: the last NAV mark does not equal cash + market value`);
      check(Number(nav.gross_exposure) <= vb.DEFAULT_CONFIG.maxGrossExposure + 1e-6,
        `${A}: gross exposure ${(Number(nav.gross_exposure) * 100).toFixed(1)}% is over the ceiling`);
    }

    const [[x]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM virtual_orders o WHERE o.account_id=? AND o.status='FILLED'
            AND NOT EXISTS (SELECT 1 FROM virtual_positions p WHERE p.order_id=o.id)) orphanFills,
         (SELECT COUNT(*) FROM virtual_positions p JOIN virtual_orders o ON o.id=p.order_id
            WHERE p.account_id=? AND p.account_id <> o.account_id) crossed,
         (SELECT COUNT(*) FROM virtual_positions p WHERE p.account_id=? AND p.status='CLOSED'
            AND (p.exit_reason IS NULL OR p.exit_date IS NULL OR p.proceeds IS NULL)) halfClosed,
         (SELECT COUNT(*) FROM virtual_positions p WHERE p.account_id=? AND p.status='OPEN'
            AND (p.stop_price IS NULL OR p.target_price IS NULL OR p.stop_price >= p.entry_price)) badLevels`,
      [acct.id, acct.id, acct.id, acct.id]);
    check(!Number(x.orphanFills), `${A}: ${x.orphanFills} FILLED order(s) with no position behind them`);
    check(!Number(x.crossed), `${A}: ${x.crossed} position(s) attached to another account's order`);
    check(!Number(x.halfClosed), `${A}: ${x.halfClosed} position(s) marked CLOSED with the exit half-written`);
    check(!Number(x.badLevels), `${A}: ${x.badLevels} open position(s) with a missing or impossible stop`);
  }

  if (!accounts.length) problems.push('no active accounts — setup did not run, or they were all closed');

  if (problems.length) {
    console.log(`RECONCILE  ${problems.length} PROBLEM(S):`);
    for (const p of problems) console.log(`  ** ${p}`);
  } else {
    console.log(`RECONCILE  ${accounts.length} account(s) OK — cash, NAV, exposure and the order/position graph all reconcile`);
  }
  return problems;
}

async function main() {
  const cmd = process.argv[2] || null;
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  try {
    await setup(pool);
    if (cmd === 'status') { await cmdStatus(pool); return; }
    if (cmd === 'resolve') { await cmdResolve(pool, false); return; }
    if (cmd === 'schedule') { await cmdSchedule(pool, false); return; }
    if (cmd === 'mark') { await cmdMark(pool, false); return; }
    if (cmd === 'reconcile') {
      const problems = await cmdReconcile(pool);
      if (problems.length) process.exitCode = 1;
      return;
    }
    // Default: today's orders are settled BEFORE tomorrow's are created.
    await cmdResolve(pool, false);
    await cmdSchedule(pool, false);
    await cmdMark(pool, false);
    const problems = await cmdReconcile(pool);
    if (problems.length) process.exitCode = 1;
  } finally { await pool.end(); }
}

module.exports = {
  setup, cmdSchedule, cmdResolve, cmdMark, cmdStatus, cmdReconcile,
  retireSupersededAccounts, loadAccounts, loadBars, ACCOUNTS, SOURCE_STRATEGY,
};

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
