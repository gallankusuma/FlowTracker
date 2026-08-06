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
const charter = require('./modules/virtual_charter');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const SOURCE_STRATEGY = 'HI52W_REGIME_BROKERVETO_V1';

/**
 * THE OFFICIAL V2 ACCOUNTS.
 *
 * Renamed from POSITION_100M / INTRADAY_EOD_100M on 2026-08-05, deliberately.
 * Those were development accounts: they existed while the session calendar, the
 * missing-bar blocking, the retirement unwind and the migration guards were
 * still being written. They traded nothing, but "it happened to hold no
 * positions" is a weak reason to call a record official. The rename makes the
 * separation structural rather than a matter of trust — the old rows retire,
 * these start from Rp100 juta, and no query can accidentally pool them.
 *
 * Their identity and their pass/fail criteria are frozen in `virtual_charter`
 * BEFORE any result exists. See modules/virtual_charter.js.
 */
const ACCOUNTS = [
  { code: 'POSITION_100M_V2', exitPolicy: vb.EXIT_POLICIES.POSITION },
  { code: 'INTRADAY_EOD_100M_V2', exitPolicy: vb.EXIT_POLICIES.INTRADAY_EOD },
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

/**
 * Widen an ENUM, and PROVE it worked.
 *
 * These migrations used to be `await pool.query(ALTER ...).catch(() => {})`.
 * The swallow was there because re-running an already-applied ALTER is
 * harmless — but it also swallowed a permission error, an incompatible column,
 * and a row whose value the new enum could not hold. setup() then reported
 * success against a schema that was not ready, and the failure surfaced hours
 * later as a runtime write error in the middle of a transaction.
 *
 * That is the same pattern as every silent failure in this system's history, so
 * it does not get a fourth outing. The ALTER is allowed to throw, and afterwards
 * information_schema is READ BACK to confirm every required value is really
 * present. A migration that says it worked has to be able to prove it.
 */
/**
 * Widen a column, but only after proving the table and the column exist.
 *
 * Migration ordering has now gone wrong four times in this file: an ALTER placed
 * above its own CREATE TABLE, which is invisible on a database that already has
 * the table and fatal on every fresh one. Rather than move the statement and
 * hope, this refuses to run against a table that is not there and says which
 * one — so the next person who writes the two lines in the wrong order gets a
 * sentence instead of a cryptic SQL error, on the first run rather than the
 * first fresh install.
 */
async function migrateColumn(pool, table, column, { minLength, definition, why }) {
  const [[col]] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]);
  if (!col) {
    throw new Error(
      `cannot widen ${table}.${column}: the column does not exist. If this is a fresh ` +
      `database, the ALTER is running before its CREATE TABLE — move it after.`);
  }
  if (Number(col.len) >= minLength) return { alreadyWide: true };

  await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
  const [[after]] = await pool.query(
    `SELECT CHARACTER_MAXIMUM_LENGTH len FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]);
  if (Number(after?.len) < minLength) {
    throw new Error(`${table}.${column} is still ${after?.len} after the ALTER (${why})`);
  }
  return { migrated: true };
}

async function migrateEnum(pool, table, column, values, suffix) {
  const present = async () => {
    const [[r]] = await pool.query(
      `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column]);
    if (!r) throw new Error(`${table}.${column} does not exist`);
    return values.filter(v => !r.t.includes(`'${v}'`));
  };

  if (!(await present()).length) return { alreadyCurrent: true };

  const def = `ENUM(${values.map(v => `'${v}'`).join(',')}) ${suffix}`;
  await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${def}`);

  const missing = await present();
  if (missing.length) {
    throw new Error(
      `${table}.${column} migration reported success but ${missing.join(', ')} ` +
      `${missing.length === 1 ? 'is' : 'are'} still not in the enum`);
  }
  return { migrated: true };
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
      -- The ALGORITHM's identity. The policy hash covers configuration only, so
      -- a behaviour change kept the same hash and one account carried trades
      -- executed under two different engines.
      execution_engine_version INT NOT NULL DEFAULT 1,
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
      -- The session retirement was DECIDED on. A forced exit may only happen
      -- strictly after it: retirement is detected around 20:10 WIB, and that
      -- day's open was eleven hours earlier.
      retirement_session DATE NULL,
      retirement_reason VARCHAR(32) NULL,
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
  if (!await hasColumn(pool, 'virtual_accounts', 'execution_engine_version')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN execution_engine_version INT NOT NULL DEFAULT 1 AFTER execution_policy_hash');
  }
  if (!await hasColumn(pool, 'virtual_accounts', 'retirement_session')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN retirement_session DATE NULL AFTER retired_at');
  }
  if (!await hasColumn(pool, 'virtual_accounts', 'retirement_reason')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN retirement_reason VARCHAR(32) NULL AFTER retirement_session');
  }
  if (!await hasColumn(pool, 'virtual_accounts', 'performance_eligible')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN performance_eligible TINYINT(1) NOT NULL DEFAULT 1 AFTER status');
  }
  if (!await hasColumn(pool, 'virtual_accounts', 'data_blocked_json')) {
    await pool.query('ALTER TABLE virtual_accounts ADD COLUMN data_blocked_json TEXT NULL AFTER performance_eligible');
  }
  await migrateEnum(pool, 'virtual_accounts', 'status',
    ['ACTIVE', 'RETIRING', 'CLOSED'], `NOT NULL DEFAULT 'ACTIVE'`);
  const [[uq]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_accounts'
        AND INDEX_NAME='uq_account' AND COLUMN_NAME='strategy_hash'`);
  if (!Number(uq.n)) {
    // Ask whether it exists rather than dropping and swallowing the answer. The
    // swallow would have hidden a permission failure here just as well.
    const [[has]] = await pool.query(
      `SELECT COUNT(*) n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_accounts' AND INDEX_NAME='uq_account'`);
    if (Number(has.n)) await pool.query('ALTER TABLE virtual_accounts DROP INDEX uq_account');
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
  await migrateEnum(pool, 'virtual_orders', 'status',
    ['SCHEDULED', 'FILLED', 'NO_FILL', 'REJECTED', 'CANCELLED', 'DATA_MISSING', 'DATA_PENDING'],
    `NOT NULL DEFAULT 'SCHEDULED'`);

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
      exit_reason VARCHAR(24) NULL,
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

  // AFTER the CREATE, not before it. This ALTER sat above the CREATE and would
  // have thrown on any fresh database — a new environment, a disaster recovery,
  // a temporary integration schema. It never showed up in production because
  // the table was already there.
  //
  // That is migration ordering going wrong for the FOURTH time in this codebase,
  // so `migrateColumn` below exists to make the shape unavailable: it verifies
  // the table before touching the column, and it is a no-op when the column is
  // already wide enough rather than re-issuing the ALTER every startup.
  await migrateColumn(pool, 'virtual_positions', 'exit_reason', {
    minLength: 24, definition: 'VARCHAR(24) NULL',
    why: 'POLICY_CHANGE_EXIT and STRATEGY_CHANGE_EXIT do not fit in VARCHAR(16), and a silently truncated exit reason is a falsified record',
  });

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
         (account_code, strategy_id, strategy_hash, exit_policy, execution_policy_hash,
          execution_engine_version, config_json, starting_cash, cash_balance, total_nav)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [a.code, SOURCE_STRATEGY, stratHash, a.exitPolicy, hash,
       vb.EXECUTION_ENGINE_VERSION, JSON.stringify(vb.DEFAULT_CONFIG),
       vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash, vb.DEFAULT_CONFIG.startingCash]);
  }

  // Freeze the charter for each identity — the official start date and the
  // evaluation gate, written once, before any trade exists. A gate agreed after
  // seeing the results is not a gate.
  await charter.ensureTable(pool);
  // THE FIRST SESSION THE ACCOUNT COULD ACTUALLY TRADE.
  // The first version asked for MIN(date) > CURDATE(), but a historical table
  // does not hold future sessions, so the fallback fired every time and the
  // "official start" was today or earlier — a date on which the account
  // provably could not have traded, because it did not exist yet.
  //
  // Recorded as PENDING_FIRST_SESSION instead, and resolved to the first real
  // session after the freeze once one lands. Honest while it is unknown rather
  // than confidently wrong.
  // LEFT NULL AT FREEZE TIME, on purpose. Which session an account first trades
  // on is not knowable before it trades: the previous attempt asked for the
  // first date after the latest one, a historical table has none, and the
  // fallback recorded today -- a date the account could not have traded on.
  // charter.resolveOfficialStart() fills it in once, from the first NAV mark the
  // account actually produced after its charter was frozen.
  const officialStart = null;

  for (const a of ACCOUNTS) {
    const r = await charter.freezeCharter(pool, {
      accountCode: a.code, strategyId: SOURCE_STRATEGY, strategyHash: stratHash,
      executionPolicyHash: vb.executionPolicyHash({}, a.exitPolicy),
      executionEngineVersion: vb.EXECUTION_ENGINE_VERSION,
      configVersion: vb.DEFAULT_CONFIG.version,
      startingCapital: vb.DEFAULT_CONFIG.startingCash,
      officialStartDate: officialStart, exitPolicy: a.exitPolicy,
    });
    if (quiet) continue;
    if (r.frozen) {
      console.log(`CHARTER  ${a.code} frozen — engine v${vb.EXECUTION_ENGINE_VERSION}, commit ${r.charter.code_commit}`);
      console.log('         official start: pending its first NAV mark');
      console.log(`         gate: ${JSON.parse(r.charter.gate_json).kind}, ` +
        `${JSON.parse(r.charter.gate_json).minTradingDays} days / ${JSON.parse(r.charter.gate_json).minClosedTrades} trades minimum`);
    } else if (r.gateDrift) {
      // The code's gate no longer matches the frozen one. The frozen one wins;
      // this is the whole point of freezing it. Say so loudly rather than
      // silently honouring whichever copy the reader happens to look at.
      console.log(`CHARTER  ** ${a.code}: the gate in code differs from the FROZEN gate.`);
      console.log('         The frozen one stands. Changing the criteria requires a new');
      console.log('         identity and an account that starts again from Rp100 juta.');
    }
  }

  await retireSupersededAccounts(pool, SOURCE_STRATEGY, quiet);

  // One-way, once: NULL -> the first session this account actually marked.
  const started = await charter.resolveOfficialStart(pool);
  if (!quiet) for (const r of started) {
    console.log(`CHARTER  ${r.accountCode} official start resolved to ${r.officialStartDate} (its first NAV mark)`);
  }
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

  // Three ways an account can be superseded, and the third was missing until
  // 2026-08-05: an account whose CODE is no longer in the roster. Renaming
  // POSITION_100M to POSITION_100M_V2 left the old row with identical hashes, so
  // nothing retired it and both ran in parallel — the duplicate-account problem
  // again, wearing a different hat.
  // The roster rule applies ONLY to the strategy the roster describes. ACCOUNTS
  // lists the live accounts for SOURCE_STRATEGY; it says nothing about any other
  // strategy_id, so applying it globally retired every account belonging to one —
  // which is exactly what it did to the integration suite's throwaway accounts.
  // Same shape as the currentStrategyHash bug a day earlier: a global assumption
  // used inside a function that takes the scope as a parameter.
  const rosterApplies = strategyId === SOURCE_STRATEGY;
  const currentCodes = new Set(ACCOUNTS.map(a => a.code));
  const superseded = rows.filter(r =>
    (rosterApplies && !currentCodes.has(r.account_code)) ||
    !currentPolicies.has(r.execution_policy_hash) ||
    (stratHash !== 'UNSET' && r.strategy_hash !== stratHash));

  const changed = [];
  for (const r of superseded) {
    const retired = rosterApplies && !currentCodes.has(r.account_code);
    const policyChanged = !currentPolicies.has(r.execution_policy_hash);
    const reason = (retired || policyChanged) ? 'POLICY_CHANGE' : 'STRATEGY_CHANGE';

    // PENDING ORDERS ARE CANCELLED, NOT INHERITED.
    // An order scheduled under v1 and filled by v2's resolver would be recorded
    // against a v1 account while being executed by a different algorithm —
    // different gap handling, different opening-NAV sizing, different
    // missing-bar handling. config_json freezes the NUMBERS, not the code.
    // DATA_PENDING is included: counting only SCHEDULED let an account with a
    // pending order and no open positions go CLOSED, and that order was then
    // never looked at again.
    const [cancelled] = await pool.query(
      `UPDATE virtual_orders SET status='CANCELLED', reject_reason=?
        WHERE account_id=? AND status IN ('SCHEDULED','DATA_PENDING')`, [reason, r.id]);
    if (cancelled.affectedRows && !quiet) {
      console.log(`SETUP  ${r.account_code}: ${cancelled.affectedRows} pending order(s) CANCELLED (${reason})`);
      console.log('       They were decided under a contract that no longer exists.');
    }
    r.scheduled = 0;

    const busy = Number(r.openPositions) > 0;
    const next = busy ? 'RETIRING' : 'CLOSED';
    if (r.status !== next) {
      // The session retirement was DECIDED on, recorded once. The forced exit
      // must land strictly after it — see the unwind in cmdResolve.
      // THE DECISION'S OWN DATE, in WIB — not the calendar's latest session.
      // A deploy on Thursday 11:05 WIB while the index only reaches Wednesday
      // would have recorded Wednesday, and Thursday's 09:00 open then counted
      // as "after" the decision. It was two hours before it. The wall clock in
      // Jakarta is what the decision actually happened on.
      const decisionDate = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await pool.query(
        `UPDATE virtual_accounts
            SET status=?, retired_at=COALESCE(retired_at, NOW()),
                retirement_session=COALESCE(retirement_session, ?),
                retirement_reason=COALESCE(retirement_reason, ?)
          WHERE id=?`,
        [next, decisionDate, reason, r.id]);
      changed.push({ ...r, newStatus: next });
    }
    if (quiet) continue;
    const why = retired ? 'this account code is no longer in the roster'
      : policyChanged ? 'the execution contract changed' : 'the strategy hash changed';
    console.log(`SETUP  ${r.account_code} -> ${next} (policy ${r.execution_policy_hash}, strategy ${r.strategy_hash}) — ${why}`);
    if (busy) {
      console.log(`       ${r.openPositions} position(s) still open.`);
      console.log(`       RETIRING: they will be force-closed at the next available open with ${reason}_EXIT,`);
      console.log('       not run to their natural stop or target under a resolver they were not opened under.');
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
async function cmdSchedule(pool, quiet, { strategyId = SOURCE_STRATEGY, force = false } = {}) {
  // THE CHECKPOINT. Cron runs this as a separate process half an hour after
  // resolve, so a non-zero exit there does not stop this one. Creating tomorrow's
  // orders against a book that was never settled is worse than doing nothing.
  const session = await currentSession(pool);
  const gate = await stageOk(pool, session, 'resolve', strategyId);
  if (!gate.ok && !force) {
    if (!quiet) {
      console.log(`SCHEDULE  refusing — resolve did not complete for ${session || 'this session'} (${gate.reason}).`);
      console.log('  Freezing new orders over an unsettled book would record decisions the');
      console.log('  engine never actually acted on. Fix resolve and re-run the chain.');
    }
    await recordStage(pool, session, 'schedule', 'BLOCKED', gate.reason, strategyId);
    return { blocked: gate.reason, scheduled: 0, skipped: 0, held: 0, mismatched: 0 };
  }

  // ACTIVE only. A RETIRING account keeps resolving and marking, but taking a
  // new order is exactly the thing it must not do.
  const all = await loadAccounts(pool, strategyId);
  const accounts = all.filter(a => a.status === 'ACTIVE');
  const retiring = all.length - accounts.length;

  const [[plan]] = await pool.query(
    `SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND run_mode='LIVE' AND status IN ('PLANNED','PARTIALLY_FILLED','EXECUTED')
      ORDER BY as_of_date DESC LIMIT 1`, [strategyId]);
  if (!plan) {
    // NO PLAN IS NOT A QUIET SUCCESS. The strategy deciding to hold nothing is
    // an empty target book, which is fine; no plan AT ALL means the stage that
    // writes plans did not run, and scheduling nothing over that is indistinct
    // from a healthy standing-aside night unless it is said out loud.
    if (!quiet) {
      console.log('SCHEDULE  BLOCKED — there is no LIVE plan for this strategy.');
      console.log('  strategy_forward.js plan runs at 20:20; check whether it completed.');
    }
    await recordStage(pool, session, 'schedule', 'BLOCKED', 'NO_LIVE_PLAN', strategyId);
    return { blocked: 'NO_LIVE_PLAN', scheduled: 0, skipped: 0, held: 0, mismatched: 0 };
  }

  // A PLAN WITH NO HASH CANNOT BE SCHEDULED, and a plan from a DIFFERENT hash
  // cannot be scheduled into this account. Without both checks a configuration
  // change quietly poured orders from strategy B into the account that holds
  // strategy A's profit, and B's track record started from A's NAV.
  if (!plan.strategy_hash) {
    if (!quiet) {
      console.log('SCHEDULE  FAILED — the latest plan carries no strategy_hash.');
      console.log('  A plan with no identity cannot be attributed to any track record.');
    }
    await recordStage(pool, session, 'schedule', 'FAILED', 'PLAN_WITHOUT_HASH', strategyId);
    return { failed: true, failures: ['PLAN_WITHOUT_HASH'], scheduled: 0, skipped: 0, held: 0, mismatched: 0,
             reason: 'PLAN_WITHOUT_HASH' };
  }

  const target = JSON.parse(plan.target_json || '[]');
  const signalDate = toDateStr(plan.as_of_date);
  let scheduled = 0, skipped = 0, held = 0, mismatched = 0;
  // Same lesson as resolve: a rolled-back order that only reaches stderr leaves
  // the stage OK, so eight of ten orders frozen reads as a complete target book.
  const rollbacks = [];

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
        rollbacks.push(`${acct.account_code}/${ticker}: ${e.message}`);
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
  // AN ACTIVE ACCOUNT THAT DOES NOT MATCH THE PLAN IS NOT NORMAL. Skipping it and
  // recording OK meant the night looked complete while an account sat out for a
  // reason nobody was told about. (An EMPTY target book is different, and stays
  // OK: standing aside is a decision the strategy is entitled to make.)
  if (mismatched > 0 && !rollbacks.length) {
    await recordStage(pool, session, 'schedule', 'FAILED',
      `${mismatched} account(s) on a different strategy hash`, strategyId);
    if (!quiet) {
      console.log(`SCHEDULE  FAILED — ${mismatched} active account(s) do not match the plan's strategy hash.`);
      console.log('  Either the plan or the account is from an identity that should have retired.');
    }
    return { failed: true, failures: [`ACCOUNT_HASH_DRIFT: ${mismatched}`],
             scheduled, skipped, held, mismatched };
  }

  if (rollbacks.length) {
    await recordStage(pool, session, 'schedule', 'FAILED',
      `${rollbacks.length} transaction(s) rolled back`, strategyId);
    if (!quiet) {
      console.log(`SCHEDULE  stage FAILED — ${rollbacks.length} order(s) rolled back.`);
      for (const r of rollbacks.slice(0, 5)) console.log(`  ${r}`);
      console.log('  The account received only part of its target book.');
    }
    return { failed: true, failures: rollbacks, scheduled, skipped, held, mismatched };
  }
  await recordStage(pool, session, 'schedule', 'OK', null, strategyId);
  return { scheduled, skipped, held, mismatched };
}

/**
 * RESOLVE — fill scheduled orders at the next open, then run every open
 * position through the bars that have landed since.
 *
 * One transaction per order: the order, the position, the cash and the event
 * move together or not at all.
 */
/**
 * Is the session calendar caught up with the prices?
 *
 * THE FAILURE THIS PREVENTS (2026-08-05 review, confirmed on the live box).
 * loadBars now takes its date axis from idx_ihsg_history. The cron ran
 * `resolve` at 20:00 WIB and `refresh_ihsg` at 20:10 — ten minutes AFTER the
 * calendar it depends on. So on any evening the index had not yet refreshed,
 * today's session was not on the axis and every order silently went unfilled,
 * to be picked up a day late with the right entry_date but a NAV history that
 * never showed the position on the day it was actually held.
 *
 * Reordering the cron fixes today. This makes the dependency explicit so it
 * cannot rot again: an ordering that exists only as a cron schedule is one
 * edit away from being wrong, and the failure is silent.
 */
async function sessionCalendarState(pool) {
  const [[ihsg]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const [[px]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const calendar = toDateStr(ihsg?.d);
  const prices = toDateStr(px?.d);

  // FAIL CLOSED IN BOTH DIRECTIONS. The first version only caught the calendar
  // trailing the prices. The opposite happens just as easily — the 19:30 price
  // pull fails, the 20:05 IHSG refresh succeeds, and at 20:10 the calendar is a
  // session ahead of any price. Resolve would have run happily and the mark
  // would then stamp a NAV dated 2026-08-05 built entirely from 2026-08-04
  // prices: a valuation for a session nothing has been priced in.
  if (!calendar || !prices) {
    return { calendar, prices, blocked: 'MARKET_DATA_UNAVAILABLE', stale: true };
  }
  if (calendar < prices) return { calendar, prices, blocked: 'SESSION_CALENDAR_STALE', stale: true };
  if (prices < calendar) return { calendar, prices, blocked: 'PRICE_DATA_STALE', stale: true };

  // MAX(date) alone is not coverage. A single ticker landing would make the
  // whole session look present, so the latest session must also carry a
  // plausible share of the universe.
  const [[cov]] = await pool.query(
    'SELECT COUNT(DISTINCT stock_code) n FROM idx_stock_prices WHERE date=?', [prices]);
  const [[typical]] = await pool.query(
    `SELECT ROUND(AVG(n)) n FROM (
       SELECT COUNT(DISTINCT stock_code) n FROM idx_stock_prices
        WHERE date < ? GROUP BY date ORDER BY date DESC LIMIT 10) x`, [prices]);
  const have = Number(cov?.n) || 0;
  const usual = Number(typical?.n) || 0;
  if (usual > 0 && have < usual * 0.5) {
    return { calendar, prices, blocked: 'PRICE_COVERAGE_THIN', stale: true, coverage: have, typical: usual };
  }

  return { calendar, prices, blocked: null, stale: false, coverage: have, typical: usual };
}

/**
 * THE NIGHTLY CHAIN'S CHECKPOINT.
 *
 * `main()` halts the chain when the whole cycle runs as one process. Production
 * does not: cron fires four INDEPENDENT processes at 20:10, 20:30, 20:35 and
 * 20:40, and a non-zero exit from the first does not cancel the other three. So
 * the "nothing was scheduled or marked" guarantee held only in the mode nobody
 * runs. Found by the 2026-08-05 review, and it is the difference between a
 * refusal that protects the record and one that merely logs.
 *
 * The stage table makes the dependency explicit and survives between processes:
 * schedule and mark refuse unless resolve is recorded OK for the SAME session
 * and the SAME engine version.
 *
 * `reconcile` is deliberately NOT gated. It reads and checks; refusing to
 * verify integrity because an upstream stage failed removes the reporting
 * exactly when something has gone wrong.
 */
async function ensureStageTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_cycle_stage (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_date DATE NOT NULL,
      -- SCOPED TO AN IDENTITY, not just an engine version. Keyed on
      -- (session, engine, stage) alone, a resolve run by the integration
      -- suite's throwaway strategy satisfied the gate for the LIVE one — a test
      -- opening the door for production.
      strategy_id VARCHAR(64) NOT NULL DEFAULT '',
      identity_hash VARCHAR(32) NOT NULL DEFAULT '',
      engine_version INT NOT NULL,
      stage VARCHAR(16) NOT NULL,
      status ENUM('OK','BLOCKED','FAILED') NOT NULL,
      reason VARCHAR(64) NULL,
      -- FAILURE IS STICKY. The row is upserted, so a retry that succeeded
      -- rewrote status to OK and the evidence that the stage had ever failed was
      -- gone. A pipeline may legitimately be re-run and continue; a burn-in
      -- session may not be quietly promoted to clean because the second attempt
      -- worked. status is the CURRENT state; ever_failed is the RECORD.
      ever_failed TINYINT(1) NOT NULL DEFAULT 0,
      attempt_count INT NOT NULL DEFAULT 1,
      first_failure_reason VARCHAR(64) NULL,
      first_failed_at TIMESTAMP NULL,
      completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_stage (session_date, identity_hash, stage)
    )`);

  for (const [col, def] of [
    ['ever_failed', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER reason'],
    ['attempt_count', 'INT NOT NULL DEFAULT 1 AFTER ever_failed'],
    ['first_failure_reason', 'VARCHAR(64) NULL AFTER attempt_count'],
    ['first_failed_at', 'TIMESTAMP NULL AFTER first_failure_reason'],
  ]) {
    if (!await hasColumn(pool, 'virtual_cycle_stage', col)) {
      await pool.query(`ALTER TABLE virtual_cycle_stage ADD COLUMN ${col} ${def}`);
    }
  }

  for (const [col, def] of [
    ['strategy_id', `VARCHAR(64) NOT NULL DEFAULT '' AFTER session_date`],
    ['identity_hash', `VARCHAR(32) NOT NULL DEFAULT '' AFTER strategy_id`],
  ]) {
    if (!await hasColumn(pool, 'virtual_cycle_stage', col)) {
      await pool.query(`ALTER TABLE virtual_cycle_stage ADD COLUMN ${col} ${def}`);
    }
  }
  const [[uq]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_cycle_stage'
        AND INDEX_NAME='uq_stage' AND COLUMN_NAME='identity_hash'`);
  if (!Number(uq.n)) {
    const [[has]] = await pool.query(
      `SELECT COUNT(*) n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_cycle_stage' AND INDEX_NAME='uq_stage'`);
    if (Number(has.n)) await pool.query('ALTER TABLE virtual_cycle_stage DROP INDEX uq_stage');
    await pool.query('ALTER TABLE virtual_cycle_stage ADD UNIQUE KEY uq_stage (session_date, identity_hash, stage)');
  }
}

/**
 * Who a cycle belongs to: the strategy, the engine version, and the exact set of
 * accounts that will act on it. Two strategies running the same session are two
 * separate chains and must not unlock each other's stages.
 */
async function cycleIdentity(pool, strategyId) {
  // STATUS IS LIFECYCLE, NOT IDENTITY, and mixing them broke the checkpoint.
  //
  // The first version hashed the accounts that were ACTIVE or RETIRING, so the
  // identity moved DURING a cycle: resolve at 20:10 saw active+retiring,
  // finished unwinding, and by 20:30 setup() had flipped that account to CLOSED
  // — schedule then computed a different identity, found no resolve checkpoint
  // under it, and refused. Fail-closed, but it costs a night's scheduling every
  // time a retirement completes. Restricting to ACTIVE only moved the problem to
  // the other end: flipping ACTIVE -> RETIRING changed it just as readily.
  //
  // So the identity is derived from what the EXPERIMENT is, not from where each
  // account happens to be in its lifecycle: the strategy, the engine version,
  // the strategy hash, and the roster of account codes with their exit policies.
  // Those change when the experiment changes and hold still while it runs.
  // NOT the strategy hash. It is read from the latest plan, so it moves when a
  // new plan lands — which made the identity shift for a reason that has nothing
  // to do with which cycle is running, and blocked schedule before it could even
  // report the hash mismatch it exists to catch. Per-account strategy_hash
  // isolation is enforced in cmdSchedule, where it belongs.
  let roster;
  if (strategyId === SOURCE_STRATEGY) {
    roster = ACCOUNTS.map(a => [a.code, a.exitPolicy, vb.executionPolicyHash({}, a.exitPolicy)]);
  } else {
    // Any other strategy (the integration suite, a future second strategy) has
    // no code-level roster, so use every account code it has ever opened —
    // status-independent for the same reason.
    const [rows] = await pool.query(
      `SELECT DISTINCT account_code, exit_policy FROM virtual_accounts
        WHERE strategy_id=? ORDER BY account_code`, [strategyId]);
    roster = rows.map(r => [r.account_code, r.exit_policy, vb.executionPolicyHash({}, r.exit_policy)]);
  }
  return require('crypto').createHash('sha256')
    .update(JSON.stringify({ strategyId, engine: vb.EXECUTION_ENGINE_VERSION, roster }))
    .digest('hex').slice(0, 16);
}

/**
 * WHOSE RECORD this is — a different question from which cycle is running.
 *
 * `cycleIdentity` must hold still for one night so the four cron processes can
 * find each other's checkpoints; that is why the strategy hash is deliberately
 * not in it. But the burn-in and the dashboard were using the same value, and
 * for them that omission is a lie: strategy A could accrue eight clean sessions,
 * the strategy hash change to B with the engine, policy and account codes
 * untouched, and B's second night would report a ten-session streak.
 *
 * So there are two identities, and they answer two questions:
 *   cycleIdentity       stable within a night   -> which chain is running
 *   experimentIdentity  moves with the record   -> whose streak this is
 *
 * This one is read from the accounts themselves, so a change to any of the four
 * things that make a record incomparable — strategy hash, policy hash, engine
 * version, or the roster — starts the count again.
 */
async function experimentIdentity(pool, strategyId) {
  const [rows] = await pool.query(
    `SELECT account_code, strategy_hash, execution_policy_hash, execution_engine_version
       FROM virtual_accounts WHERE strategy_id=? AND status IN ('ACTIVE','RETIRING')
      ORDER BY account_code`, [strategyId]);
  return require('crypto').createHash('sha256')
    .update(JSON.stringify({
      strategyId,
      accounts: rows.map(r => ({
        accountCode: r.account_code,
        strategyHash: r.strategy_hash,
        policyHash: r.execution_policy_hash,
        engineVersion: r.execution_engine_version,
      })),
    }))
    .digest('hex').slice(0, 16);
}

async function recordStage(pool, sessionDate, stage, status, reason = null, strategyId = SOURCE_STRATEGY) {
  if (!sessionDate) return;
  await ensureStageTable(pool);
  const identity = await cycleIdentity(pool, strategyId);
  const failedNow = status !== 'OK' ? 1 : 0;
  await pool.query(
    `INSERT INTO virtual_cycle_stage
       (session_date, strategy_id, identity_hash, engine_version, stage, status, reason,
        ever_failed, attempt_count, first_failure_reason, first_failed_at)
     VALUES (?,?,?,?,?,?,?,?,1,?,?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       reason = VALUES(reason),
       -- Never cleared. GREATEST keeps a 1 once it has been set, whatever a
       -- later attempt reports.
       ever_failed = GREATEST(ever_failed, VALUES(ever_failed)),
       attempt_count = attempt_count + 1,
       first_failure_reason = COALESCE(first_failure_reason, VALUES(first_failure_reason)),
       first_failed_at = COALESCE(first_failed_at, VALUES(first_failed_at)),
       completed_at = CURRENT_TIMESTAMP`,
    [sessionDate, strategyId, identity, vb.EXECUTION_ENGINE_VERSION, stage, status, reason,
     failedNow, failedNow ? (reason || status) : null, failedNow ? new Date() : null]);
}

async function stageOk(pool, sessionDate, stage, strategyId = SOURCE_STRATEGY) {
  if (!sessionDate) return { ok: false, reason: 'NO_SESSION' };
  await ensureStageTable(pool);
  const identity = await cycleIdentity(pool, strategyId);
  const [[r]] = await pool.query(
    `SELECT status, reason, ever_failed, attempt_count, first_failure_reason
       FROM virtual_cycle_stage WHERE session_date=? AND identity_hash=? AND stage=?`,
    [sessionDate, identity, stage]);
  if (!r) return { ok: false, reason: `${stage.toUpperCase()}_NOT_RUN`, everFailed: false };
  if (r.status !== 'OK') {
    return { ok: false, reason: `${stage.toUpperCase()}_${r.status}:${r.reason || ''}`, everFailed: true };
  }
  // `ok` is the CURRENT state, so a fixed pipeline may continue. `everFailed`
  // travels with it so the burn-in can refuse to call the session clean.
  return { ok: true, everFailed: Number(r.ever_failed) === 1,
           attempts: Number(r.attempt_count),
           firstFailure: r.first_failure_reason || null };
}

/** The session the current cycle belongs to — the calendar's latest closed bar. */
async function currentSession(pool) {
  const [[r]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  return toDateStr(r?.d);
}

async function cmdResolve(pool, quiet, { strategyId = SOURCE_STRATEGY } = {}) {
  const cal = await sessionCalendarState(pool);
  if (cal.blocked) {
    // Refuse rather than under-fill. A run that quietly fills nothing looks
    // exactly like a day with no signals, which is the shape of every silent
    // failure this project has had.
    if (!quiet) {
      const why = {
        MARKET_DATA_UNAVAILABLE: 'one of the two feeds is empty, so there is nothing to reconcile against',
        SESSION_CALENDAR_STALE: `prices reach ${cal.prices} but the session calendar only reaches ${cal.calendar} — filling now would skip that session and book it a day late`,
        PRICE_DATA_STALE: `the calendar reaches ${cal.calendar} but prices only reach ${cal.prices} — the 19:30 pull has not landed, and marking would date a NAV to a session nothing is priced in`,
        PRICE_COVERAGE_THIN: `${cal.prices} carries only ${cal.coverage} tickers against a recent norm of ${cal.typical} — the session is present but not complete`,
      }[cal.blocked];
      console.log(`RESOLVE  ${cal.blocked} — refusing to run.`);
      console.log(`  ${why}`);
      console.log('  Cron order is 19:30 prices, 20:05 IHSG, 20:10 resolve. Fix the upstream stage and re-run.');
    }
    await recordStage(pool, cal.calendar || cal.prices, 'resolve', 'BLOCKED', cal.blocked, strategyId);
    return { blocked: cal.blocked, calendar: cal.calendar, prices: cal.prices, summary: [] };
  }

  const accounts = await loadAccounts(pool, strategyId);
  const { bars, dates, dateIdx } = await loadBars(pool);
  const summary = [];
  // A rolled-back transaction used to print to stderr and leave the stage OK,
  // so the next stage ran as if the session had settled cleanly. A refusal that
  // only reaches a log is the failure mode this whole checkpoint exists to end.
  const rollbacks = [];

  for (const acct of accounts) {
    const cfg = { ...vb.DEFAULT_CONFIG, ...(acct.config_json ? JSON.parse(acct.config_json) : {}) };
    let filled = 0, noFill = 0, rejected = 0, closed = 0, dataMissing = 0, dataPending = 0;
    const blocked = [];

    // ── a retiring account does not trade, it unwinds ────────────────────
    // Its positions were opened under an execution contract that no longer
    // exists. Running them on to their natural stop or target under the CURRENT
    // resolver would record a v2 execution as a v1 result — the numbers in
    // config_json are frozen, the algorithm is not. So they are closed at the
    // first available price with an explicit reason, which is auditable in a way
    // "it eventually hit its target, under different rules" is not.
    if (acct.status === 'RETIRING') {
      const [openRows] = await pool.query(
        `SELECT * FROM virtual_positions WHERE account_id=? AND status='OPEN' ORDER BY entry_date`, [acct.id]);
      const exitReason = `${acct.retirement_reason === 'STRATEGY_CHANGE' ? 'STRATEGY' : 'POLICY'}_CHANGE_EXIT`;

      // THE EXIT CANNOT PRECEDE THE DECISION.
      // This used to sell at the LATEST session's open. Retirement is detected
      // by the nightly chain at about 20:10 WIB; that day's open was around
      // 09:00, eleven hours earlier. The account was therefore recorded as
      // having sold before anyone decided to retire it — not a conservative
      // assumption but an impossible timestamp.
      //
      // The first session strictly after the decision is the earliest moment an
      // order could genuinely have been placed. Until it exists, the positions
      // stay open and the account stays RETIRING, which is the honest state.
      const decidedOn = toDateStr(acct.retirement_session);
      let waiting = 0;

      for (const p of openRows) {
        // PER TICKER, not one global exit session. A single shared exitDate meant
        // that if one name was suspended on that session the code hit `continue`
        // and, on every later run, tried the SAME session again — the position
        // could never advance to the next one and would sit open forever.
        const exitDate = decidedOn
          ? dates.find(d => d > decidedOn && bars.get(p.ticker)?.get(d)?.open > 0)
          : null;
        if (!exitDate) { waiting++; continue; }
        const px = bars.get(p.ticker).get(exitDate).open;

        const proceeds = vb.sellProceeds(p.quantity, px, cfg);
        const grossPnl = proceeds.gross - (Number(p.cost_basis) - Number(p.entry_fee));
        const netPnl = proceeds.net - Number(p.cost_basis);
        const eIdx = dateIdx.get(toDateStr(p.entry_date));
        const xIdx = dateIdx.get(exitDate);
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [upd] = await conn.query(
            `UPDATE virtual_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, exit_fee=?,
                    proceeds=?, gross_pnl=?, net_pnl=?, return_pct=?, holding_bars=?
              WHERE id=? AND status='OPEN'`,
            [exitDate, proceeds.fillPrice, exitReason, proceeds.fee, proceeds.net, grossPnl, netPnl,
             (netPnl / Number(p.cost_basis)) * 100,
             (eIdx === undefined || xIdx === undefined) ? null : xIdx - eIdx + 1, p.id]);
          if (upd.affectedRows === 1) {
            await conn.query('UPDATE virtual_accounts SET cash_balance = cash_balance + ? WHERE id=?', [proceeds.net, acct.id]);
            await logEvent(conn, acct.id, exitReason, exitDate,
              { positionId: p.id, ticker: p.ticker,
                detail: { price: proceeds.fillPrice, netPnl, decidedOn, exitDate } });
          }
          await conn.commit();
          if (upd.affectedRows === 1) closed++;
        } catch (e) {
          await conn.rollback();
          rollbacks.push(`forced exit ${p.id}: ${e.message}`);
          console.error(`RESOLVE  forced exit ${p.id} rolled back: ${e.message}`);
        } finally { conn.release(); }
      }

      if (waiting && !quiet) {
        console.log(`RESOLVE  ${acct.account_code} [RETIRING] ${waiting} position(s) waiting for a tradable`);
        console.log(`         session after ${decidedOn || 'retirement'}. Selling at an open that preceded`);
        console.log('         the decision is not an exit, and neither is a session with no price.');
      }
      summary.push({ account: acct.account_code, status: acct.status, filled: 0, noFill: 0,
                     rejected: 0, closed, dataMissing: 0, dataPending: 0, blocked: 0,
                     unwinding: true, awaiting: waiting });
      continue;
    }

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
        let openingExposure = 0, tickerExposure = 0, stalePriced = 0, unpricedHoldings = 0;
        for (const p of openPos) {
          let px = bars.get(p.ticker)?.get(entryDate)?.open;
          // No opening print: walk back to the last close this system has for
          // the name, BEFORE the entry date. Cost basis was the old fallback and
          // it is badly wrong for a holding that has moved — a name that has
          // doubled would be counted at half its value, so exposure reads low
          // and the caps let the book run further than they should.
          if (!(px > 0)) {
            const series = bars.get(p.ticker);
            for (let k = sIdx; k >= 0 && !(px > 0); k--) {
              const c = series?.get(dates[k])?.close;
              if (c > 0) px = c;
            }
            if (px > 0) stalePriced++; else unpricedHoldings++;
          }
          openingExposure += px > 0 ? Number(p.quantity) * px : Number(p.cost_basis);
          if (p.ticker === o.ticker) {
            tickerExposure += px > 0 ? Number(p.quantity) * px : Number(p.cost_basis);
          }
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
        } else if (unpricedHoldings > 0) {
          // A holding this system has NEVER seen a price for makes the opening
          // NAV a guess, and every cap — risk budget, gross exposure, per-name —
          // is a fraction of that NAV. Sizing a new position against a number
          // built partly on cost basis is how a book quietly ends up larger than
          // its own limits. Wait instead; the order is retried tomorrow.
          await conn.query(`UPDATE virtual_orders SET status='DATA_PENDING', reject_reason='OPENING_NAV_UNRELIABLE' WHERE id=?`, [o.id]);
          await logEvent(conn, acct.id, 'DATA_PENDING', entryDate,
            { orderId: o.id, ticker: o.ticker, detail: { unpricedHoldings, reason: 'OPENING_NAV_UNRELIABLE' } });
          outcome = 'dataPending';
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
        rollbacks.push(`order ${o.id}: ${e.message}`);
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

        // A SESSION WE CANNOT READ BLOCKS THE WALK. It does not get skipped.
        //
        // `continue` here was unsafe in a way that quietly rewrites history: if
        // day 2's high and low are missing and day 3 reaches the target, the
        // engine books a TARGET on day 3 — when the position may well have been
        // stopped out on day 2. It cannot know, so it must not choose the
        // profitable reading by default. For INTRADAY_EOD it is starker still:
        // an incomplete entry bar turns a same-day trade into a multi-day one,
        // which is a different strategy.
        //
        // So the position waits. It stays OPEN, the account is flagged, and the
        // walk resumes only once that session's data arrives.
        if (r.unpriced || r.dataIncomplete) {
          blocked.push({ position: p, date: d, reason: r.dataIncomplete ? 'DATA_INCOMPLETE_EXIT_BAR' : 'PRICE_HISTORY_BLOCKED' });
          // Once per (position, session, reason). Every nightly retry hits the
          // same unreadable bar, so an unconditional insert filled the journal
          // with identical rows and buried the events that mean something.
          const reasonCode = r.dataIncomplete ? 'DATA_INCOMPLETE_EXIT_BAR' : 'PRICE_HISTORY_BLOCKED';
          const [[seen]] = await pool.query(
            `SELECT COUNT(*) n FROM virtual_trade_events
              WHERE position_id=? AND event='DATA_BLOCKED' AND event_date=?
                AND detail_json LIKE ?`, [p.id, d, `%${reasonCode}%`]);
          if (!Number(seen.n)) {
            await logEvent(pool, acct.id, 'DATA_BLOCKED', d, {
              positionId: p.id, ticker: p.ticker,
              detail: { reason: reasonCode, barsHeld: i - eIdx + 1 },
            });
          }
          break;
        }
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
          rollbacks.push(`exit ${p.id}: ${e.message}`);
          console.error(`RESOLVE  exit ${p.id} rolled back: ${e.message}`);
        } finally { conn.release(); }
        break;
      }
    }
    // An account whose exit walk is blocked cannot produce a trustworthy NAV or
    // a comparable performance number: some of its positions are frozen mid-walk
    // on a session nobody can read. Say so on the account rather than letting the
    // number look ordinary.
    await pool.query(
      'UPDATE virtual_accounts SET performance_eligible=? , data_blocked_json=? WHERE id=?',
      [blocked.length ? 0 : 1,
       blocked.length ? JSON.stringify(blocked.map(b => ({ ticker: b.position.ticker, date: b.date, reason: b.reason }))) : null,
       acct.id]);

    summary.push({ account: acct.account_code, status: acct.status, filled, noFill, rejected, closed,
                   dataMissing, dataPending, blocked: blocked.length });
  }

  // Any rollback, on any account, fails the whole stage. Partial settlement is
  // not settlement: scheduling or marking over it would record decisions taken
  // against a book that is missing whatever rolled back.
  const anyBlocked = summary.some(x => x.blocked > 0);
  if (rollbacks.length || anyBlocked) {
    const why = rollbacks.length
      ? `${rollbacks.length} transaction(s) rolled back`
      : 'positions blocked on unreadable sessions';
    await recordStage(pool, cal.calendar, 'resolve', 'FAILED', why.slice(0, 64), strategyId);
    if (!quiet) {
      console.log(`RESOLVE  stage FAILED — ${why}.`);
      for (const r of rollbacks.slice(0, 5)) console.log(`  ${r}`);
      console.log('  Schedule and mark will refuse until this session settles cleanly.');
    }
  } else {
    await recordStage(pool, cal.calendar, 'resolve', 'OK', null, strategyId);
  }

  const resolveFailed = rollbacks.length > 0 || anyBlocked;

  if (!quiet) for (const s of summary) {
    console.log(`RESOLVE  ${s.account.padEnd(20)} filled ${s.filled}, no-fill ${s.noFill}, rejected ${s.rejected}, closed ${s.closed}` +
      (s.status === 'RETIRING' ? '   [RETIRING - exits only]' : ''));
    if (s.dataMissing || s.dataPending) {
      console.log(`         ${s.dataPending} awaiting data, ${s.dataMissing} with data confirmed missing — NOT counted as no-fills`);
    }
    if (s.blocked) {
      console.log(`         ** ${s.blocked} position(s) BLOCKED on an unreadable session — the walk stopped there`);
      console.log('            performance_eligible=0 until that data arrives. The engine will');
      console.log('            not read past a bar it cannot see and guess which level was hit first.');
    }
  }
  // A SHAPE THE CALLER CAN ACT ON. This returned a bare array, so the CLI's
  // `if (r?.blocked)` could never see a FAILED stage: the checkpoint blocked
  // everything downstream while the resolve process itself exited 0 and the
  // cron recorded a success.
  summary.blocked = null;
  summary.failed = resolveFailed;
  summary.failures = rollbacks;
  return summary;
}

/** MARK — cash plus market value, reconciled and stored. */
async function cmdMark(pool, quiet, { strategyId = SOURCE_STRATEGY, force = false } = {}) {
  // Same checkpoint. A NAV marked over a book resolve refused to settle is a
  // number that looks ordinary and is not.
  const session = await currentSession(pool);
  const gate = await stageOk(pool, session, 'resolve', strategyId);
  if (!gate.ok && !force) {
    if (!quiet) {
      console.log(`MARK  refusing — resolve did not complete for ${session || 'this session'} (${gate.reason}).`);
      console.log('  A NAV stamped on an unsettled book is worse than a missing one: it looks');
      console.log('  exactly like a real valuation.');
    }
    await recordStage(pool, session, 'mark', 'BLOCKED', gate.reason, strategyId);
    return [];
  }

  const accounts = await loadAccounts(pool, strategyId);
  const { bars, dates } = await loadBars(pool, 30);
  const today = dates[dates.length - 1];
  const out = [];
  const markFailures = [];

  for (const acct of accounts) {
    // ONE SNAPSHOT, INSIDE THE TRANSACTION, WITH THE ACCOUNT LOCKED.
    // The write was already atomic, but cash, positions and realized P&L were
    // READ beforehand on autocommit. A resolve running concurrently could close
    // a position between those reads, and the mark would then combine old cash
    // with a new position list — a NAV that never existed at any instant.
    const conn = await pool.getConnection();
    let m, realizedPnl, openCount, startingCash, unrealized;
    try {
      await conn.beginTransaction();
      const [[acc]] = await conn.query(
        'SELECT cash_balance, starting_cash FROM virtual_accounts WHERE id=? FOR UPDATE', [acct.id]);
      const [open] = await conn.query(
        `SELECT ticker, quantity, cost_basis FROM virtual_positions WHERE account_id=? AND status='OPEN'`, [acct.id]);
      const [[realized]] = await conn.query(
        `SELECT COALESCE(SUM(net_pnl),0) r FROM virtual_positions WHERE account_id=? AND status='CLOSED'`, [acct.id]);

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

      m = vb.markToMarket({
        cash: Number(acc.cash_balance), positions: open,
        priceOf: t => bars.get(t)?.get(today)?.close || 0,
        lastCloseOf,
      });
      realizedPnl = Number(realized.r);
      openCount = open.length;
      startingCash = Number(acc.starting_cash);
      unrealized = m.marketValue - open.reduce((a, p) => a + Number(p.cost_basis), 0);

      await conn.query(
        `INSERT INTO virtual_nav (account_id, mark_date, cash_value, market_value, total_nav,
                                  realized_pnl, unrealized_pnl, gross_exposure, open_positions, unmarkable)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE cash_value=VALUES(cash_value), market_value=VALUES(market_value),
           total_nav=VALUES(total_nav), realized_pnl=VALUES(realized_pnl), unrealized_pnl=VALUES(unrealized_pnl),
           gross_exposure=VALUES(gross_exposure), open_positions=VALUES(open_positions), unmarkable=VALUES(unmarkable)`,
        [acct.id, today, m.cash, m.marketValue, m.totalNav, realizedPnl, unrealized,
         m.totalNav > 0 ? m.marketValue / m.totalNav : 0, openCount,
         [...m.unmarkable, ...m.stale.map(t => `${t}(stale)`)].join(',') || null]);
      await conn.query('UPDATE virtual_accounts SET total_nav=? WHERE id=?', [m.totalNav, acct.id]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      markFailures.push(`${acct.account_code}: ${e.message}`);
      console.error(`MARK  ${acct.account_code} rolled back: ${e.message}`);
      continue;
    } finally { conn.release(); }

    out.push({ account: acct.account_code, status: acct.status, ...m,
               realized: realizedPnl, unrealized, startingCash });
  }

  // EVERY account must be marked, not most of them. One account failing while
  // the stage says OK is the checkpoint giving false evidence about the very
  // thing it exists to attest.
  if (markFailures.length || out.length !== accounts.length) {
    const why = markFailures.length
      ? `${markFailures.length} account(s) rolled back`
      : `${out.length} of ${accounts.length} accounts marked`;
    await recordStage(pool, session, 'mark', 'FAILED', why.slice(0, 64), strategyId);
    if (!quiet) {
      console.log(`MARK  stage FAILED — ${why}.`);
      for (const m of markFailures.slice(0, 5)) console.log(`  ${m}`);
    }
    out.failed = true;
    out.failures = markFailures;
    return out;
  }
  await recordStage(pool, session, 'mark', 'OK', null, strategyId);

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
    // THE ACCOUNT'S OWN FROZEN CONFIG, not whatever the code currently defaults
    // to. A v1 account checked against v2's caps is being judged by rules it was
    // never run under, which produces both false alarms and false clean bills.
    const acfg = { ...vb.DEFAULT_CONFIG, ...(acct.config_json ? JSON.parse(acct.config_json) : {}) };
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
    check(Number(led.nOpen) <= acfg.maxPositions,
      `${A}: ${led.nOpen} open positions, the limit is ${acfg.maxPositions}`);

    const [[nav]] = await pool.query(
      'SELECT * FROM virtual_nav WHERE account_id=? ORDER BY mark_date DESC LIMIT 1', [acct.id]);
    if (nav) {
      check(Math.abs(Number(nav.total_nav) - (Number(nav.cash_value) + Number(nav.market_value))) < 1,
        `${A}: the last NAV mark does not equal cash + market value`);
      check(Number(nav.gross_exposure) <= acfg.maxGrossExposure + 1e-6,
        `${A}: gross exposure ${(Number(nav.gross_exposure) * 100).toFixed(1)}% is over the ceiling`);
      // The two NAV numbers must agree. They live in different rows and used to
      // be written by two separate autocommit statements, so a crash between
      // them left the account sizing its next fill against a stale figure — and
      // nothing compared them.
      check(Math.abs(Number(acct.total_nav) - Number(nav.total_nav)) < 1,
        `${A}: account.total_nav ${rp(acct.total_nav)} != latest virtual_nav ${rp(nav.total_nav)} — a mark was written but the account was not`);
      // The mark must also agree with the ledger it claims to summarise.
      check(Math.abs(Number(nav.cash_value) - Number(acct.cash_balance)) < 1,
        `${A}: the last NAV mark says cash ${rp(nav.cash_value)}, the account holds ${rp(acct.cash_balance)}`);
      check(Number(nav.open_positions) === Number(led.nOpen),
        `${A}: the last NAV mark counts ${nav.open_positions} open position(s), the ledger has ${led.nOpen}`);
    }

    // One OPEN position per name, unless pyramiding is an explicit policy.
    // Without this the retained-ticker bug stacked a name past its cap silently.
    const [dupes] = await pool.query(
      `SELECT ticker, COUNT(*) n FROM virtual_positions WHERE account_id=? AND status='OPEN'
        GROUP BY ticker HAVING n > 1`, [acct.id]);
    if (!acfg.allowPyramiding) {
      check(!dupes.length,
        `${A}: ${dupes.map(d => `${d.ticker} x${d.n}`).join(', ')} held as multiple independent OPEN positions, but pyramiding is off`);
    }

    // The per-name cap is aggregate. Checked at LAST MARK prices, so a winner
    // drifting past the ceiling is visible even though nothing was bought.
    if (nav && Number(nav.total_nav) > 0) {
      const [byTicker] = await pool.query(
        `SELECT ticker, SUM(quantity) q FROM virtual_positions WHERE account_id=? AND status='OPEN' GROUP BY ticker`, [acct.id]);
      for (const t of byTicker) {
        // ON THE SESSION CALENDAR. `ORDER BY date DESC LIMIT 1` over the raw
        // price table would happily pick up a phantom weekend row that
        // loadBars() has already refused — the reconciliation contradicting the
        // engine it is supposed to be checking.
        const [[px]] = await pool.query(
          `SELECT p.close_price c FROM idx_stock_prices p
             JOIN idx_ihsg_history i ON i.date = p.date
            WHERE p.stock_code=? ORDER BY p.date DESC LIMIT 1`, [t.ticker]);
        if (!px?.c) continue;
        const frac = (Number(t.q) * Number(px.c)) / Number(nav.total_nav);
        // 1.5x the cap: drift from a winner is expected and is not a bug; this
        // is looking for a name that was BOUGHT past the limit.
        check(frac <= acfg.maxPositionNotional * 1.5,
          `${A}: ${t.ticker} is ${(frac * 100).toFixed(1)}% of NAV, cap is ${(acfg.maxPositionNotional * 100).toFixed(1)}%`);
      }
    }

    // A CLOSED account must not still hold anything. This is the failure the
    // RETIRING state exists to prevent: administratively shut while positions
    // stayed open, unmonitored and never returning their cash.
    if (acct.status === 'CLOSED') {
      check(!Number(led.nOpen), `${A}: status is CLOSED but ${led.nOpen} position(s) are still OPEN`);
    }

    // A blocked exit walk means some positions are frozen on a session nobody
    // can read, so the account's numbers are not comparable to anything.
    if (Number(acct.performance_eligible) === 0) {
      problems.push(`${A}: performance_eligible=0 — ${acct.data_blocked_json || 'exit walk blocked'}`);
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
    // A REFUSAL MUST LOOK LIKE A FAILURE TO THE CRON.
    // cmdResolve returning { blocked } while the process exits 0 is precisely the
    // shape this project keeps getting bitten by: the schedule sees success, the
    // log holds the real story, and nobody reads the log.
    if (cmd === 'resolve') {
      const r = await cmdResolve(pool, false);
      if (r?.blocked || r?.failed) process.exitCode = 1;
      return;
    }
    // Each of these is its own cron process, so each must report its own
    // refusal. An exit code is the only thing a schedule entry can see.
    if (cmd === 'schedule') {
      const r = await cmdSchedule(pool, false);
      if (r?.blocked || r?.failed) process.exitCode = 1;
      return;
    }
    if (cmd === 'mark') {
      const r = await cmdMark(pool, false);
      if (!Array.isArray(r) || r.failed) process.exitCode = 1;
      else if (!r.length) {
        // An empty result means either no accounts or a refusal; the refusal
        // path already recorded BLOCKED, so ask the checkpoint which it was.
        const g = await stageOk(pool, await currentSession(pool), 'mark');
        if (!g.ok) process.exitCode = 1;
      }
      return;
    }
    if (cmd === 'reconcile') {
      const problems = await cmdReconcile(pool);
      if (problems.length) process.exitCode = 1;
      return;
    }
    // Default: today's orders are settled BEFORE tomorrow's are created.
    const resolved = await cmdResolve(pool, false);
    if (resolved?.blocked || resolved?.failed) {
      // And the chain STOPS. Scheduling tomorrow's orders and marking a NAV on
      // data the resolve step just refused to touch would produce exactly the
      // wrong record: new orders against a book that was never settled.
      console.log(`\nHALTED after resolve (${resolved.blocked || 'stage FAILED'}). Nothing was scheduled or marked.`);
      process.exitCode = 1;
      return;
    }
    const sched = await cmdSchedule(pool, false);
    const marked = await cmdMark(pool, false);
    if (sched?.blocked || sched?.failed || marked?.failed) process.exitCode = 1;
    const problems = await cmdReconcile(pool);
    if (problems.length) process.exitCode = 1;
  } finally { await pool.end(); }
}

module.exports = {
  setup, cmdSchedule, cmdResolve, cmdMark, cmdStatus, cmdReconcile,
  retireSupersededAccounts, loadAccounts, loadBars, sessionCalendarState, migrateEnum, migrateColumn,
  recordStage, stageOk, currentSession, cycleIdentity, experimentIdentity, ensureStageTable,
  ACCOUNTS, SOURCE_STRATEGY,
};

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
