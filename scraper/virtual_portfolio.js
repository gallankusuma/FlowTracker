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
      -- The STRATEGY's identity, not just the execution contract's. Without it
      -- a configuration change produced orders under a new strategy hash that
      -- landed in the same account, inheriting its cash: hash B would start
      -- from Rp110 juta because hash A had made Rp10 juta, and B's track record
      -- would carry A's profit. Found by the 2026-08-05 review.
      strategy_hash VARCHAR(32) NOT NULL DEFAULT 'UNSET',
      exit_policy VARCHAR(16) NOT NULL,
      execution_policy_hash VARCHAR(32) NOT NULL,
      config_json TEXT NULL,
      starting_cash DECIMAL(20,2) NOT NULL,
      cash_balance DECIMAL(20,2) NOT NULL,
      total_nav DECIMAL(20,2) NOT NULL,
      -- RETIRING is not decoration. Flipping straight to CLOSED hid the account
      -- from loadAccounts() while it still held OPEN positions, which then had
      -- no stop checked, no time exit, no mark, and never returned their cash.
      -- RETIRING takes no new orders but keeps resolving and marking until the
      -- book is genuinely empty.
      status ENUM('ACTIVE','RETIRING','CLOSED') NOT NULL DEFAULT 'ACTIVE',
      retired_at TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_account (account_code, strategy_id, strategy_hash, execution_policy_hash)
    )`);

  // Existing installations predate strategy_hash and the RETIRING state.
  // Columns before keys, and the key rebuild after both — the ordering this
  // codebase has now got wrong three times.
  if (!await hasColumn(pool, 'virtual_accounts', 'strategy_hash')) {
    await pool.query(`ALTER TABLE virtual_accounts ADD COLUMN strategy_hash VARCHAR(32) NOT NULL DEFAULT 'UNSET' AFTER strategy_id`);
  }
  if (!await hasColumn(pool, 'virtual_accounts', 'retired_at')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN retired_at TIMESTAMP NULL AFTER total_nav');
  }
  await pool.query(
    `ALTER TABLE virtual_accounts MODIFY COLUMN status ENUM('ACTIVE','RETIRING','CLOSED') NOT NULL DEFAULT 'ACTIVE'`
  ).catch(() => {});
  const [[uq]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_accounts'
        AND INDEX_NAME='uq_account' AND COLUMN_NAME='strategy_hash'`);
  if (!Number(uq.n)) {
    await pool.query('ALTER TABLE virtual_accounts DROP INDEX uq_account').catch(() => {});
    await pool.query(
      'ALTER TABLE virtual_accounts ADD UNIQUE KEY uq_account (account_code, strategy_id, strategy_hash, execution_policy_hash)');
  }

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
      -- Rank in the plan's target book. Execution used to be ORDER BY ticker,
      -- so when cash ran out the alphabet decided the portfolio: AALI got
      -- funded and WIKA did not, for no reason connected to the strategy.
      target_rank INT NULL,
      status ENUM('SCHEDULED','FILLED','NO_FILL','REJECTED','CANCELLED','DATA_MISSING','DATA_PENDING') NOT NULL DEFAULT 'SCHEDULED',
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

  if (!await hasColumn(pool, 'virtual_orders', 'target_rank')) {
    await pool.query('ALTER TABLE virtual_orders ADD COLUMN target_rank INT NULL AFTER quantity');
  }
  await pool.query(
    `ALTER TABLE virtual_orders MODIFY COLUMN status
       ENUM('SCHEDULED','FILLED','NO_FILL','REJECTED','CANCELLED','DATA_MISSING','DATA_PENDING')
       NOT NULL DEFAULT 'SCHEDULED'`).catch(() => {});

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

  const stratHash = await currentStrategyHash(pool, SOURCE_STRATEGY);
  for (const a of ACCOUNTS) {
    const hash = vb.executionPolicyHash({}, a.exitPolicy);
    await pool.query(
      `INSERT IGNORE INTO virtual_accounts
         (account_code, strategy_id, strategy_hash, exit_policy, execution_policy_hash, config_json,
          starting_cash, cash_balance, total_nav)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [a.code, SOURCE_STRATEGY, stratHash, a.exitPolicy, hash, JSON.stringify(vb.DEFAULT_CONFIG),
       vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash]);
  }

  await retireSupersededAccounts(pool, SOURCE_STRATEGY, quiet);
}

/**
 * The strategy identity accounts are keyed on.
 *
 * `strategy_forward.STRATEGY_HASH` is the hash of the strategy configuration as
 * currently coded, which is exactly the thing that must not change underneath a
 * track record. Falling back to the latest LIVE plan's hash keeps this working
 * on a box where the module cannot be loaded; falling back to 'UNSET' would be
 * worse than failing, so it is only used when there is genuinely nothing to key
 * on and no orders can be scheduled anyway.
 */
async function currentStrategyHash(pool, strategyId = SOURCE_STRATEGY) {
  // PER STRATEGY, not one global answer. The first version returned
  // strategy_forward's own hash whatever it was asked about, so every account
  // belonging to any other strategy_id looked superseded — the integration
  // suite's throwaway accounts were all marked stale on sight.
  //
  // The latest LIVE plan is the better authority anyway: an account exists to
  // trade plans, and until a plan is written under a new hash there is nothing
  // to trade under it. When that plan does appear, the hash moves, setup()
  // opens a fresh Rp100 juta account and the old one retires.
  const [[plan]] = await pool.query(
    `SELECT strategy_hash FROM ft_strategy_plan WHERE strategy_id=? AND run_mode='LIVE' AND strategy_hash IS NOT NULL
      ORDER BY as_of_date DESC LIMIT 1`, [strategyId]).catch(() => [[null]]);
  if (plan?.strategy_hash) return plan.strategy_hash;

  // No plan yet. Only the live strategy can fall back to the coded hash;
  // anything else has nothing to key on and must not retire accounts on a guess.
  if (strategyId !== SOURCE_STRATEGY) return 'UNSET';
  try {
    const sf = require('./strategy_forward');
    if (sf.STRATEGY_HASH) return sf.STRATEGY_HASH;
  } catch { /* fall through */ }
  return 'UNSET';
}

/**
 * Retire accounts whose contract no longer exists — either the EXECUTION policy
 * (fees, slippage, exit rule, risk layer) or the STRATEGY itself.
 *
 * Both matter, and the strategy half was missing until the 2026-08-05 review.
 * The unique key puts a new account row BESIDE the old one, so without this both
 * stay ACTIVE: on 2026-08-04 every stage ran twice against four accounts.
 *
 * RETIRING, NOT CLOSED, WHILE THE BOOK IS STILL OPEN.
 * The previous version flipped straight to CLOSED, and loadAccounts() filtered
 * on ACTIVE — so a retired account's OPEN positions had no stop checked, no time
 * exit, no mark, never returned their cash and never appeared in reconciliation.
 * They simply stopped existing, mid-trade. A RETIRING account takes no new
 * orders but keeps resolving and marking, and becomes CLOSED only once nothing
 * is scheduled and nothing is open.
 *
 * Nothing is ever deleted: the history is the record of what that contract did.
 */
async function retireSupersededAccounts(pool, strategyId, quiet = false) {
  const currentPolicies = new Set(ACCOUNTS.map(a => vb.executionPolicyHash({}, a.exitPolicy)));
  const stratHash = await currentStrategyHash(pool, strategyId);

  const [rows] = await pool.query(
    `SELECT a.id, a.account_code, a.status, a.strategy_hash, a.execution_policy_hash,
            (SELECT COUNT(*) FROM virtual_positions p WHERE p.account_id=a.id AND p.status='OPEN') openPositions,
            (SELECT COUNT(*) FROM virtual_orders o WHERE o.account_id=a.id AND o.status='SCHEDULED') scheduled,
            (SELECT COUNT(*) FROM virtual_positions p WHERE p.account_id=a.id) positions
       FROM virtual_accounts a WHERE a.strategy_id=? AND a.status IN ('ACTIVE','RETIRING')`, [strategyId]);

  const superseded = rows.filter(r =>
    !currentPolicies.has(r.execution_policy_hash) ||
    (stratHash !== 'UNSET' && r.strategy_hash !== stratHash));

  const changed = [];
  for (const r of superseded) {
    const busy = Number(r.openPositions) > 0 || Number(r.scheduled) > 0;
    const next = busy ? 'RETIRING' : 'CLOSED';
    if (r.status !== next) {
      await pool.query('UPDATE virtual_accounts SET status=?, retired_at=COALESCE(retired_at, NOW()) WHERE id=?', [next, r.id]);
      changed.push({ ...r, newStatus: next });
    }
    if (quiet) continue;
    const why = !currentPolicies.has(r.execution_policy_hash) ? 'the execution contract changed' : 'the strategy hash changed';
    console.log(`SETUP  ${r.account_code} -> ${next} (policy ${r.execution_policy_hash}, strategy ${r.strategy_hash}) — ${why}`);
    if (busy) {
      console.log(`       ${r.openPositions} position(s) still open, ${r.scheduled} order(s) scheduled.`);
      console.log('       RETIRING: no new orders, but exits and marks keep running until the book is empty.');
    } else if (Number(r.positions) > 0) {
      console.log(`       ${r.positions} position(s) of history kept and CLOSED, not deleted.`);
      console.log('       Its track record ends here and must not be pooled with the new one.');
    }
  }

  // An account that finished emptying since the last run graduates to CLOSED.
  for (const r of rows) {
    if (r.status === 'RETIRING' && !Number(r.openPositions) && !Number(r.scheduled) &&
        !changed.some(c => c.id === r.id)) {
      await pool.query(`UPDATE virtual_accounts SET status='CLOSED' WHERE id=?`, [r.id]);
      if (!quiet) console.log(`SETUP  ${r.account_code} RETIRING -> CLOSED — its book is empty`);
      changed.push({ ...r, newStatus: 'CLOSED' });
    }
  }
  return superseded;
}

/**
 * Accounts that still need work done on them.
 *
 * RETIRING is included on purpose: it must keep resolving exits and marking NAV.
 * `cmdSchedule` filters to ACTIVE separately, because taking a NEW order is the
 * one thing a retiring account must not do.
 */
async function loadAccounts(pool, strategyId = SOURCE_STRATEGY) {
  const [rows] = await pool.query(
    `SELECT * FROM virtual_accounts WHERE strategy_id=? AND status IN ('ACTIVE','RETIRING') ORDER BY account_code`,
    [strategyId]);
  return rows;
}

/**
 * Daily bars keyed ticker -> date -> OHLC, on the AUTHORITATIVE SESSION CALENDAR.
 *
 * The axis is `idx_ihsg_history`, not `SELECT DISTINCT date FROM
 * idx_stock_prices`. That distinction is not academic: on 2026-08-04 the price
 * table was found holding 75 dates that were never trading sessions — weekends,
 * public holidays written as open=high=low=close with zero volume, and bars
 * copied forward from the previous day. Those rows have been purged, but the
 * CODE that trusted them had not been fixed, and the next bad ingest would have
 * put them straight back.
 *
 * What a phantom date does to this engine, specifically:
 *   - a Friday signal fills on "Saturday" instead of Monday;
 *   - the ATR window averages bars that never traded;
 *   - holding_bars counts non-sessions, so TIME_EXIT fires early;
 *   - the INTRADAY_EOD account books a round trip on a day the exchange was shut.
 *
 * ^JKSE is the exchange's own index, so it defines what a session is. Price bars
 * dated outside that calendar are dropped and counted, never silently ignored.
 */
async function loadBars(pool, sinceDays = 120) {
  const [dateRows] = await pool.query(
    'SELECT date FROM idx_ihsg_history WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY date', [sinceDays]);
  const dates = dateRows.map(r => toDateStr(r.date));
  const sessions = new Set(dates);

  const [rows] = await pool.query(
    `SELECT stock_code, date, open_price o, high_price h, low_price l, close_price c
       FROM idx_stock_prices WHERE date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`, [sinceDays]);
  const bars = new Map();
  let offCalendar = 0;
  for (const r of rows) {
    const d = toDateStr(r.date);
    if (!sessions.has(d)) { offCalendar++; continue; }
    const t = r.stock_code;
    if (!bars.has(t)) bars.set(t, new Map());
    bars.get(t).set(d, { open: +r.o, high: +r.h, low: +r.l, close: +r.c });
  }
  return { bars, dates, dateIdx: new Map(dates.map((d, i) => [d, i])), offCalendar };
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
  // ACTIVE only. A RETIRING account keeps resolving and marking, but taking a
  // new order is exactly the thing it must not do.
  const all = await loadAccounts(pool, strategyId);
  const accounts = all.filter(a => a.status === 'ACTIVE');
  const retiring = all.length - accounts.length;

  const [[plan]] = await pool.query(
    `SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND run_mode='LIVE' AND status IN ('PLANNED','PARTIALLY_FILLED','EXECUTED')
      ORDER BY as_of_date DESC LIMIT 1`, [strategyId]);
  if (!plan) { if (!quiet) console.log('SCHEDULE  no plan to work from.'); return { scheduled: 0, skipped: 0, held: 0, mismatched: 0 }; }

  // A PLAN WITH NO HASH CANNOT BE SCHEDULED, and a plan from a DIFFERENT hash
  // cannot be scheduled into this account. Without both checks a configuration
  // change quietly poured orders from strategy B into the account that holds
  // strategy A's profit, and B's track record started from A's NAV.
  if (!plan.strategy_hash) {
    if (!quiet) console.log('SCHEDULE  the latest plan carries no strategy_hash — refusing to schedule it.');
    return { scheduled: 0, skipped: 0, held: 0, mismatched: 0, reason: 'PLAN_WITHOUT_HASH' };
  }

  const target = JSON.parse(plan.target_json || '[]');
  const signalDate = toDateStr(plan.as_of_date);
  let scheduled = 0, skipped = 0, held = 0, mismatched = 0;

  for (const acct of accounts) {
    if (acct.strategy_hash !== 'UNSET' && acct.strategy_hash !== plan.strategy_hash) {
      mismatched++;
      if (!quiet) {
        console.log(`  ${acct.account_code}: plan hash ${plan.strategy_hash} != account hash ${acct.strategy_hash} — skipped.`);
        console.log('    A new strategy hash gets a NEW account with fresh capital, never this one.');
      }
      continue;
    }

    // Names already held are not bought again. The target book legitimately
    // RETAINS a holding across rebalances, so without this the same ticker was
    // re-ordered on every plan and one name could stack past its 12.5% cap.
    const [openRows] = await pool.query(
      `SELECT ticker FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
    const heldNames = new Set(openRows.map(r => r.ticker));

    for (let rank = 0; rank < target.length; rank++) {
      const ticker = target[rank];
      if (heldNames.has(ticker)) { held++; continue; }

      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [r] = await conn.query(
          `INSERT IGNORE INTO virtual_orders
             (account_id, source_plan_id, ticker, side, signal_date, status, target_rank,
              strategy_hash, execution_policy_hash, data_snapshot_hash, code_commit)
           VALUES (?,?,?,'BUY',?, 'SCHEDULED', ?, ?,?,?,?)`,
          [acct.id, plan.id, ticker, signalDate, rank,
           plan.strategy_hash, acct.execution_policy_hash, plan.data_snapshot_hash, plan.code_commit]);
        if (r.affectedRows === 1) {
          // The event carries the order it created. Without insertId the journal
          // timeline could not be walked back from a fill to its scheduling.
          await logEvent(conn, acct.id, 'ORDER_SCHEDULED', signalDate,
            { orderId: r.insertId, ticker, detail: { planId: plan.id, targetRank: rank } });
          await conn.commit();
          scheduled++;
        } else {
          await conn.commit();
          skipped++;
        }
      } catch (e) {
        await conn.rollback();
        console.error(`SCHEDULE  ${ticker} rolled back: ${e.message}`);
      } finally { conn.release(); }
    }
  }

  if (!quiet) {
    console.log(`SCHEDULE  ${signalDate}  ${plan.reason}`);
    console.log(`  ${scheduled} scheduled, ${skipped} already existed, ${held} already held, ${mismatched} account(s) on a different strategy hash`);
    if (retiring) console.log(`  ${retiring} retiring account(s) took no new orders, by design`);
    if (!target.length) console.log('  the book is empty, so there is nothing to schedule — that is a decision, not a failure');
  }
  return { scheduled, skipped, held, mismatched };
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
    let filled = 0, noFill = 0, rejected = 0, closed = 0, dataMissing = 0, dataPending = 0;

    // ── fills ────────────────────────────────────────────────────────────
    // BY TARGET RANK, not alphabetically. When cash or exposure runs out the
    // last orders go unfunded, so `ORDER BY ticker` let the alphabet pick the
    // portfolio: AALI funded, WIKA not, for no reason the strategy would
    // recognise. Rank ties fall back to ticker only for determinism.
    const [orders] = await pool.query(
      `SELECT * FROM virtual_orders WHERE account_id=? AND status IN ('SCHEDULED','DATA_PENDING')
        ORDER BY signal_date, COALESCE(target_rank, 9999), ticker`, [acct.id]);

    for (const o of orders) {
      const sIdx = dateIdx.get(toDateStr(o.signal_date));
      if (sIdx === undefined || sIdx + 1 >= dates.length) continue;   // execution bar has not landed
      const entryDate = dates[sIdx + 1];
      const bar = bars.get(o.ticker)?.get(entryDate);

      let outcome = null;   // set inside the transaction, counted only after commit
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[acc]] = await conn.query('SELECT cash_balance, total_nav FROM virtual_accounts WHERE id=? FOR UPDATE', [acct.id]);

        // OPENING NAV AND OPENING EXPOSURE, not last night's mark and cost basis.
        // Sizing against yesterday's NAV over-risks after a gap down and
        // under-counts exposure after a run-up: cost basis is what was paid, not
        // what is held. Both are recomputed here at THIS MORNING's open prices,
        // inside the account lock.
        const [openPos] = await conn.query(
          `SELECT ticker, quantity, cost_basis FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
        let openingExposure = 0, tickerExposure = 0, unpricedHoldings = 0;
        for (const p of openPos) {
          const px = bars.get(p.ticker)?.get(entryDate)?.open;
          // A holding with no opening print is carried at cost for exposure
          // purposes and counted, so the caps stay conservative rather than
          // silently treating it as worth nothing.
          const value = px > 0 ? Number(p.quantity) * px : Number(p.cost_basis);
          if (!(px > 0)) unpricedHoldings++;
          openingExposure += value;
          if (p.ticker === o.ticker) tickerExposure += value;
        }
        const openingNav = Number(acc.cash_balance) + openingExposure;

        if (!bar) {
          // NO ROW IS NOT A NO-FILL. It could be a suspension, a scraper
          // failure, an un-ingested ticker, or data still arriving. Recording it
          // as NO_FILL made a data outage indistinguishable from an execution
          // outcome — the exact confusion that let this system report
          // `success: true, stocks: 0` for 47 days.
          //
          // DATA_PENDING is retryable and stays in the resolve queue; it only
          // hardens into DATA_MISSING once the session is old enough that the
          // row is not coming.
          const sessionsSince = dates.length - 1 - (sIdx + 1);
          const status = sessionsSince >= 2 ? 'DATA_MISSING' : 'DATA_PENDING';
          await conn.query('UPDATE virtual_orders SET status=?, reject_reason=? WHERE id=?',
            [status, 'NO_PRICE_ROW', o.id]);
          await logEvent(conn, acct.id, status, entryDate,
            { orderId: o.id, ticker: o.ticker, detail: { sessionsSince } });
          outcome = status === 'DATA_MISSING' ? 'dataMissing' : 'dataPending';
        } else if (!(bar.open > 0)) {
          // The row exists and says there was no opening price. That IS an
          // execution outcome: the name was halted or never opened.
          await conn.query(`UPDATE virtual_orders SET status='NO_FILL', reject_reason='NO_OPEN_PRICE' WHERE id=?`, [o.id]);
          await logEvent(conn, acct.id, 'NO_FILL', entryDate, { orderId: o.id, ticker: o.ticker });
          outcome = 'noFill';
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
            nav: openingNav, cash: Number(acc.cash_balance),
            entryPrice: entry, fillPrice, stopPrice: stop,
            grossExposure: openingExposure, openPositions: openPos.length,
            tickerExposure, config: cfg,
          });

          if (size.quantity <= 0) {
            await conn.query(`UPDATE virtual_orders SET status='REJECTED', reject_reason=? WHERE id=?`, [size.rejectReason, o.id]);
            await logEvent(conn, acct.id, 'REJECTED', entryDate, {
              orderId: o.id, ticker: o.ticker,
              detail: { ...size, openingNav, openingExposure, tickerExposure, unpricedHoldings },
            });
            outcome = 'rejected';
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
                          stop, target: targetPx, atr, atrFallback: lv.usedFallback,
                          openingNav, openingExposure } });
            await logEvent(conn, acct.id, 'STOP_SET', entryDate, { orderId: o.id, positionId: pos.insertId, ticker: o.ticker, detail: { stop } });
            await logEvent(conn, acct.id, 'TARGET_SET', entryDate, { orderId: o.id, positionId: pos.insertId, ticker: o.ticker, detail: { target: targetPx } });
            outcome = 'filled';
          }
        }
        await conn.commit();
        // COUNTED ONLY AFTER THE COMMIT. Incrementing inside the transaction
        // meant a rollback still produced "filled 3" in the summary — the
        // console reporting success for work the database had thrown away.
        if (outcome === 'filled') filled++;
        else if (outcome === 'noFill') noFill++;
        else if (outcome === 'rejected') rejected++;
        else if (outcome === 'dataMissing') dataMissing++;
        else if (outcome === 'dataPending') dataPending++;
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
    summary.push({ account: acct.account_code, status: acct.status, filled, noFill, rejected, closed, dataMissing, dataPending });
  }

  if (!quiet) for (const s of summary) {
    console.log(`RESOLVE  ${s.account.padEnd(20)} filled ${s.filled}, no-fill ${s.noFill}, rejected ${s.rejected}, closed ${s.closed}` +
      (s.status === 'RETIRING' ? '   [RETIRING - exits only]' : ''));
    if (s.dataMissing || s.dataPending) {
      console.log(`         ${s.dataPending} awaiting data, ${s.dataMissing} with data confirmed missing — NOT counted as no-fills`);
    }
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

    // The last close this system actually has for a name, whatever its date.
    // Used when today's close is missing, BEFORE falling back to cost: a name
    // that has doubled should not snap back to its entry value because one
    // print did not arrive.
    const lastCloseOf = t => {
      const series = bars.get(t);
      if (!series) return null;
      for (let i = dates.length - 1; i >= 0; i--) {
        const c = series.get(dates[i])?.close;
        if (c > 0) return c;
      }
      return null;
    };

    const m = vb.markToMarket({
      cash: Number(acc.cash_balance), positions: open,
      priceOf: t => bars.get(t)?.get(today)?.close || 0,
      lastCloseOf,
    });
    const openCost = open.reduce((a, p) => a + Number(p.cost_basis), 0);
    const unrealized = m.marketValue - openCost;

    // ONE TRANSACTION. These used to be two autocommit statements, so a crash
    // between them left virtual_nav correct and virtual_accounts.total_nav
    // stale — and the next fill sized against the stale one. Reconciliation did
    // not compare them either, so the disagreement was invisible.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO virtual_nav (account_id, mark_date, cash_value, market_value, total_nav,
                                  realized_pnl, unrealized_pnl, gross_exposure, open_positions, unmarkable)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE cash_value=VALUES(cash_value), market_value=VALUES(market_value),
           total_nav=VALUES(total_nav), realized_pnl=VALUES(realized_pnl), unrealized_pnl=VALUES(unrealized_pnl),
           gross_exposure=VALUES(gross_exposure), open_positions=VALUES(open_positions), unmarkable=VALUES(unmarkable)`,
        [acct.id, today, m.cash, m.marketValue, m.totalNav, Number(realized.r), unrealized,
         m.totalNav > 0 ? m.marketValue / m.totalNav : 0, open.length,
         [...m.unmarkable, ...m.stale.map(t => `${t}(stale)`)].join(',') || null]);
      await conn.query('UPDATE virtual_accounts SET total_nav=? WHERE id=?', [m.totalNav, acct.id]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      console.error(`MARK  ${acct.account_code} rolled back: ${e.message}`);
      conn.release();
      continue;
    }
    conn.release();

    out.push({ account: acct.account_code, status: acct.status, ...m,
               realized: Number(realized.r), unrealized, startingCash: Number(acc.starting_cash) });
  }

  if (!quiet) for (const o of out) {
    const ret = (o.totalNav / o.startingCash - 1) * 100;
    console.log(`MARK  ${o.account.padEnd(20)} NAV ${rp(o.totalNav)}  (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%)` +
      (o.status === 'RETIRING' ? '   [RETIRING]' : ''));
    console.log(`      cash ${rp(o.cash)} + market ${rp(o.marketValue)}   realized ${rp(o.realized)}   unrealized ${rp(o.unrealized)}`);
    if (o.cash < -1e-6) console.log('      ** NEGATIVE CASH — the account borrowed, which must not happen');
    if (o.stale.length) console.log(`      marked at last known close, not today's: ${o.stale.join(', ')}`);
    if (o.degraded) {
      console.log(`      ** NAV_DEGRADED — carried at COST, no price ever seen: ${o.unmarkable.join(', ')}`);
      console.log('         This NAV is not a market value. Treat it as an estimate until the price returns.');
    }
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
  // CLOSED accounts are included here on purpose, unlike everywhere else: the
  // invariant that a closed account holds nothing can only be checked by
  // looking at closed accounts.
  const [accounts] = await pool.query(
    'SELECT * FROM virtual_accounts WHERE strategy_id=? ORDER BY status, account_code', [strategyId]);
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
      // The two NAV numbers must agree. They live in different rows and used to
      // be written by two separate autocommit statements, so a crash between
      // them left the account sizing its next fill against a stale figure — and
      // nothing compared them.
      check(Math.abs(Number(acct.total_nav) - Number(nav.total_nav)) < 1,
        `${A}: account.total_nav ${rp(acct.total_nav)} != latest virtual_nav ${rp(nav.total_nav)} — a mark was written but the account was not`);
    }

    // One OPEN position per name, unless pyramiding is an explicit policy.
    // Without this the retained-ticker bug stacked a name past its cap silently.
    const [dupes] = await pool.query(
      `SELECT ticker, COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'
        GROUP BY ticker HAVING n > 1`, [acct.id]);
    if (!vb.DEFAULT_CONFIG.allowPyramiding) {
      check(!dupes.length,
        `${A}: ${dupes.map(d => `${d.ticker} x${d.n}`).join(', ')} held as multiple independent OPEN positions, but pyramiding is off`);
    }

    // The per-name cap is aggregate. Checked at LAST MARK prices, so a winner
    // drifting past the ceiling is visible even though nothing was bought.
    if (nav && Number(nav.total_nav) > 0) {
      const [byTicker] = await pool.query(
        `SELECT ticker, SUM(quantity) q FROM virtual_positions WHERE account_id=? AND status='OPEN' GROUP BY ticker`, [acct.id]);
      for (const t of byTicker) {
        const [[px]] = await pool.query(
          'SELECT close_price c FROM idx_stock_prices WHERE stock_code=? ORDER BY date DESC LIMIT 1', [t.ticker]);
        if (!px?.c) continue;
        const frac = (Number(t.q) * Number(px.c)) / Number(nav.total_nav);
        // 1.5x the cap: drift from a winner is expected and is not a bug; this
        // is looking for a name that was BOUGHT past the limit.
        check(frac <= vb.DEFAULT_CONFIG.maxPositionNotional * 1.5,
          `${A}: ${t.ticker} is ${(frac * 100).toFixed(1)}% of NAV, cap is ${(vb.DEFAULT_CONFIG.maxPositionNotional * 100).toFixed(1)}%`);
      }
    }

    // A CLOSED account must not still hold anything. This is the failure the
    // RETIRING state exists to prevent: administratively shut while positions
    // stayed open, unmonitored and never returning their cash.
    if (acct.status === 'CLOSED') {
      check(!Number(led.nOpen), `${A}: status is CLOSED but ${led.nOpen} position(s) are still OPEN`);
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

  if (!accounts.length) problems.push('no accounts at all — setup did not run');

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
