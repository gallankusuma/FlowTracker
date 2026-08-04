/**
 * Forward (paper) test recorder for the EXP-017 strategy.
 *
 * Records what the strategy WOULD hold, decided from data available on the
 * decision date only, and marks open positions to market. This is the honest
 * successor to backtesting for this candidate: EXP-017 established the effect
 * survives every control available, but the concentration data ceiling
 * (2024-01-02, no earlier source exists) means no further backtest can raise
 * confidence. Only forward time can.
 *
 * SAME CODE PATH AS THE BACKTEST. The book comes from modules/strategy_book.js,
 * the same module verify_strategy_book.js pins with a golden fixture. That is
 * deliberate: `awo_paper_trades` broke silently precisely because the live path
 * and the tested path were separate implementations.
 *
 * REPLAY IS NOT FORWARD PERFORMANCE (review P0.5, 2026-08-03). `--replay` seeds
 * the ledger from history. It used to write into the same tables as live
 * decisions with nothing to tell them apart, so replayed trades counted toward
 * the promotion gate's trade count, win rate and average return. On the day the
 * review landed the ledger held 42 CLOSED positions with entry dates spanning
 * 2025-10-24 to 2026-02-24 — every one of them written at the same instant,
 * 2026-08-02 16:44:33, by a single replay run. The gate read "42/30 trades" and
 * would have called that a forward track record. Every row now carries
 * `run_mode`, and every statistic below is LIVE-only unless explicitly asked
 * otherwise.
 *
 * NOT A TRADING SYSTEM. It writes intentions to a table. It places no orders and
 * touches no broker. Execution stays manual by design — IDX retail brokers have
 * no public order API, and the strategy has not earned automation.
 *
 * Idempotent: running twice for the same date changes nothing.
 *
 * Usage:
 *   node strategy_forward.js            # the daily cycle: fill, then plan, then mark
 *   node strategy_forward.js plan       # freeze a decision, reading NO execution price
 *   node strategy_forward.js fill       # execute any plan whose bar has since landed
 *   node strategy_forward.js mark       # record today's NAV
 *   node strategy_forward.js status [--include-replay]
 *   node strategy_forward.js --replay 60   # seed history, recorded as REPLAY
 */
'use strict';
require('dotenv').config();

const crypto = require('crypto');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');
const sb = require('./modules/strategy_book');
const fg = require('./modules/forward_gate');
const exec = require('./modules/execution');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const STRATEGY_ID = 'HI52W_REGIME_BROKERVETO_V1';
const REBAL_BARS = 10;                       // biweekly — the frozen configuration
const PARAMS = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100;

const MODEL_VERSION = process.env.AWO_MODEL_VERSION || '1.0.0-forward';

/**
 * The EXECUTION ledger version, separate from the strategy configuration.
 *
 * v1 recorded a weight fixed at entry. v2 records units, cost basis and
 * proceeds, and derives cash and NAV from them. Those are not two versions of
 * one track record — they are two different accounting systems, and pooling
 * them would mix a return that ignores realized P&L with one that does not.
 *
 * Bumping this changes STRATEGY_HASH, which starts a clean record and leaves
 * the old rows readable under their own hash. Raise it for ANY change to fills,
 * costs, sizing, cash, NAV or no-fill handling — not only configuration
 * (review P0.4). The alternative, backfilling units onto weight-era rows, would
 * mean guessing at a historical NAV that was never recorded.
 */
const EXECUTION_LEDGER_VERSION = 2;

/**
 * Identity of the exact strategy configuration a row was produced by. If any of
 * it changes, rows written before and after are not the same track record and
 * must not be pooled.
 *
 * FIXED 2026-08-04 (review P0.4). This used to hash STRATEGY_ID, REBAL_BARS,
 * the four explicit PARAMS and the two costs — and nothing from
 * strategy_book.DEFAULTS. So minAdv, hiBars, minHiWindowBars, requirePosfrac,
 * posfracWindow, regimeSma, minEligible and advWindow could all change without
 * the hash moving, and records from materially different strategies would pool
 * into one track record. That was not hypothetical: minHiWindowBars and
 * requirePosfrac were BOTH ADDED on 2026-08-03, and the hash did not notice.
 *
 * It now hashes the full effective configuration — the merge that is actually
 * passed to targetBook, so a default that changes upstream in strategy_book.js
 * changes the hash here without anyone remembering to update a list.
 */
const EFFECTIVE_CONFIG = { ...sb.DEFAULTS, ...PARAMS, rebalanceBars: REBAL_BARS, buyCost: BUY_COST, sellCost: SELL_COST, modelVersion: MODEL_VERSION, executionLedgerVersion: EXECUTION_LEDGER_VERSION };
const STRATEGY_HASH = crypto.createHash('sha256')
  .update(JSON.stringify({ id: STRATEGY_ID, cfg: Object.keys(EFFECTIVE_CONFIG).sort().map(k => [k, EFFECTIVE_CONFIG[k]]) }))
  .digest('hex').slice(0, 16);

function codeCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { return process.env.CODE_COMMIT || null; }
}
const CODE_COMMIT = codeCommit();

/**
 * One id per invocation, stamped on everything this process writes. Provenance
 * you can look up beats provenance you have to guess at from a clock.
 */
const RUN_ID = crypto.randomUUID();

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

const pct = v => v === null || v === undefined || !Number.isFinite(v) ? 'n/a' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
const num = (v, d = 2) => v === null || v === undefined ? 'n/a' : (v === Infinity ? '∞' : Number(v).toFixed(d));

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { cmd: null, date: null, replay: 0, status: false, includeReplay: false };
  if (a.length && ['plan', 'fill', 'mark', 'status'].includes(a[0])) {
    o.cmd = a.shift();
    if (o.cmd === 'status') o.status = true;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--date') o.date = a[++i];
    else if (a[i] === '--replay') o.replay = Number(a[++i]);
    else if (a[i] === '--status') o.status = true;
    else if (a[i] === '--include-replay') o.includeReplay = true;
  }
  return o;
}

async function hasColumn(pool, table, column) {
  const [r] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]);
  return r.length > 0;
}

async function setup(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_positions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      ticker VARCHAR(10) NOT NULL,
      entry_date DATE NOT NULL,
      entry_price DECIMAL(15,2) NOT NULL,
      weight DECIMAL(8,5) NOT NULL,
      units DECIMAL(24,10) NULL,
      cost_basis DECIMAL(20,8) NULL,
      proceeds DECIMAL(20,8) NULL,
      exit_date DATE NULL,
      exit_price DECIMAL(15,2) NULL,
      exit_reason VARCHAR(32) NULL,
      gross_pct DECIMAL(10,4) NULL,
      net_pct DECIMAL(10,4) NULL,
      status ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      -- Declared HERE, not only added by a migration (review P0.1). The unique
      -- key below names these columns, so a CREATE TABLE that leaves them to an
      -- ALTER later is rejected outright on an empty database. The migrations
      -- exist for schemas that predate them; a fresh schema must stand alone.
      run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      strategy_hash VARCHAR(32) NULL,
      -- Explicit provenance, so nothing has to be INFERRED from timestamps
      -- (review P0.1). Every row records the command that wrote it and the id
      -- of that invocation.
      source_command VARCHAR(16) NULL,
      run_id VARCHAR(36) NULL,
      decision_date DATE NULL,
      decision_created_at DATETIME NULL,
      data_available_at DATETIME NULL,
      execution_observed_at DATETIME NULL,
      code_commit VARCHAR(40) NULL,
      UNIQUE KEY uq_open (strategy_id, run_mode, strategy_hash, ticker, entry_date),
      KEY idx_status (strategy_id, status)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      as_of_date DATE NOT NULL,
      exposure DECIMAL(4,2) NOT NULL,
      reason VARCHAR(128) NOT NULL,
      regime_label VARCHAR(16) NULL,
      eligible INT NOT NULL,
      vetoed INT NOT NULL,
      n_target INT NOT NULL,
      opened INT NOT NULL DEFAULT 0,
      closed INT NOT NULL DEFAULT 0,
      target_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      -- Same reason as ft_strategy_positions above (review P0.1).
      run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      strategy_hash VARCHAR(32) NULL,
      source_command VARCHAR(16) NULL,
      run_id VARCHAR(36) NULL,
      decision_created_at DATETIME NULL,
      data_available_at DATETIME NULL,
      code_commit VARCHAR(40) NULL,
      UNIQUE KEY uq_day (strategy_id, run_mode, strategy_hash, as_of_date)
    )`);

  // The frozen plan (review P0.3). Written after the close of bar T with no
  // reference whatsoever to bar T+1, which does not exist in idx_stock_prices
  // yet. `fill` later records what it actually cost to execute it.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_plan (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      as_of_date DATE NOT NULL,
      run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      generated_at DATETIME NOT NULL,
      data_snapshot_hash VARCHAR(32) NULL,
      strategy_hash VARCHAR(32) NULL,
      code_commit VARCHAR(40) NULL,
      exposure DECIMAL(4,2) NOT NULL,
      reason VARCHAR(128) NOT NULL,
      regime_label VARCHAR(16) NULL,
      eligible INT NOT NULL,
      vetoed INT NOT NULL,
      target_json TEXT NULL,
      reference_json TEXT NULL,
      -- The execution contract this plan was decided under (review P0.2
      -- residual). strategy_hash covers the STRATEGY; it does not move when a
      -- code-only deploy changes fills, costs or sizing, so a plan could still
      -- be executed by an implementation it was not decided against — now
      -- inside one hash, which is harder to spot afterwards. Compared at fill.
      buy_cost DECIMAL(10,6) NULL,
      sell_cost DECIMAL(10,6) NULL,
      execution_ledger_version INT NULL,
      status ENUM('PLANNED','PARTIALLY_FILLED','EXECUTED','EXPIRED') NOT NULL DEFAULT 'PLANNED',
      nofill_json TEXT NULL,
      executed_at DATETIME NULL,
      execution_date DATE NULL,
      UNIQUE KEY uq_plan (strategy_id, run_mode, strategy_hash, as_of_date),
      KEY idx_plan_status (strategy_id, run_mode, status)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_nav (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      mark_date DATE NOT NULL,
      run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      strategy_hash VARCHAR(32) NULL,
      open_positions INT NOT NULL,
      unrealised_pct DECIMAL(10,4) NULL,
      unmarkable VARCHAR(255) NULL,
      cash_value DECIMAL(16,6) NULL,
      market_value DECIMAL(16,6) NULL,
      total_nav DECIMAL(16,6) NULL,
      realized_pnl DECIMAL(16,6) NULL,
      unrealized_pnl DECIMAL(16,6) NULL,
      gross_exposure DECIMAL(16,6) NULL,
      benchmark_nav DECIMAL(16,6) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_mark (strategy_id, run_mode, strategy_hash, mark_date)
    )`);

  // ORDER MATTERS (review P0.2). migrateUniqueKeys builds indexes over
  // run_mode and strategy_hash, which migrateProvenance is what ADDS on an old
  // schema. Running the index migration first made an upgrade from the oldest
  // schema fail on a column that did not exist yet. Columns first, indexes last.
  // migrateProvenanceColumns FIRST: migrateProvenance ends by calling
  // reclassifyBatchWrites, which now filters on source_command, so that column
  // has to exist before it runs. Same class of mistake as the previous review's
  // P0.2 — a migration querying a column a later migration adds. Columns first,
  // then anything that reads them, then indexes.
  await migrateProvenanceColumns(pool);
  await migrateProvenance(pool);
  await migrateLedgerUnits(pool);
  await migrateNavTable(pool);
  await migratePlanTable(pool);
  await migrateRegimeLabel(pool);
  await migrateUniqueKeys(pool);
}

/**
 * Bring an already-created ft_strategy_plan up to date: PARTIALLY_FILLED became
 * a real state and per-ticker no-fills are recorded (review P1.2).
 */
/**
 * Put run_mode into the uniqueness constraints.
 *
 * Neither key included it, and both writers use INSERT IGNORE, so a LIVE row
 * could collide with a REPLAY row for the same ticker and date and be silently
 * discarded — while `opened++` still counted it and the plan was still marked
 * EXECUTED. reclassifyBatchWrites would then flip the surviving row to REPLAY,
 * erasing a genuine live fill from the track record on the next startup.
 */
async function migrateUniqueKeys(pool) {
  const check = async (table, key, want) => {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME c FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`, [table, key]);
    if (!rows.length) return;                       // freshly created: already correct
    if (rows.some(r => r.c === 'strategy_hash')) return; // already migrated
    await pool.query(`ALTER TABLE ${table} DROP INDEX ${key}, ADD UNIQUE KEY ${key} (${want})`);
    console.log(`MIGRATION: ${table}.${key} now includes run_mode + strategy_hash — different modes and configurations can no longer collide`);
  };
  await check('ft_strategy_positions', 'uq_open', 'strategy_id, run_mode, strategy_hash, ticker, entry_date');
  await check('ft_strategy_log', 'uq_day', 'strategy_id, run_mode, strategy_hash, as_of_date');
  await check('ft_strategy_plan', 'uq_plan', 'strategy_id, run_mode, strategy_hash, as_of_date');
  await check('ft_strategy_nav', 'uq_mark', 'strategy_id, run_mode, strategy_hash, mark_date');
}

async function migrateProvenanceColumns(pool) {
  for (const t of ['ft_strategy_positions', 'ft_strategy_log']) {
    const add = [];
    if (!(await hasColumn(pool, t, 'source_command'))) add.push('ADD COLUMN source_command VARCHAR(16) NULL');
    if (!(await hasColumn(pool, t, 'run_id'))) add.push('ADD COLUMN run_id VARCHAR(36) NULL');
    if (add.length) {
      await pool.query(`ALTER TABLE ${t} ${add.join(', ')}`);
      console.log(`MIGRATION: ${t} gained source_command / run_id — provenance is recorded, not inferred (review P0.1)`);
    }
  }
}

async function migrateRegimeLabel(pool) {
  for (const t of ['ft_strategy_plan', 'ft_strategy_log']) {
    if (!(await hasColumn(pool, t, 'regime_label'))) {
      await pool.query(`ALTER TABLE ${t} ADD COLUMN regime_label VARCHAR(16) NULL`);
      console.log(`MIGRATION: ${t}.regime_label added — the gate no longer infers regime from a reason string (review P1.1)`);
    }
  }
}

/**
 * Give the ledger units and cash flows.
 *
 * Everything before this recorded a WEIGHT fixed at entry, which cannot express
 * a portfolio: weights do not drift with price, so a book that doubles still
 * reports the weights it opened with. Two consequences the review found (P0.5,
 * P0.6): buying capacity was computed as 1 - committedWeight and so ignored a
 * realized loss entirely -- after losing 20% the system could still deploy a
 * full notional 1.0, which is 125% leverage -- and compounding per-period
 * weighted returns gives a different answer from the actual NAV path (their
 * worked example: 1.875 versus 2.00).
 *
 * With units and cash both fall out: NAV is cash plus units times price, and
 * capacity is simply the cash on hand.
 */
async function migrateLedgerUnits(pool) {
  const add = [];
  if (!(await hasColumn(pool, 'ft_strategy_positions', 'units'))) add.push('ADD COLUMN units DECIMAL(24,10) NULL');
  if (!(await hasColumn(pool, 'ft_strategy_positions', 'cost_basis'))) add.push('ADD COLUMN cost_basis DECIMAL(20,8) NULL');
  if (!(await hasColumn(pool, 'ft_strategy_positions', 'proceeds'))) add.push('ADD COLUMN proceeds DECIMAL(20,8) NULL');
  if (!add.length) return;
  await pool.query(`ALTER TABLE ft_strategy_positions ${add.join(', ')}`);
  console.log('MIGRATION: ft_strategy_positions gained units / cost_basis / proceeds — the ledger is self-financing now, not weight-based');
}

async function migrateNavTable(pool) {
  if (!(await hasColumn(pool, 'ft_strategy_nav', 'strategy_hash'))) {
    await pool.query('ALTER TABLE ft_strategy_nav ADD COLUMN strategy_hash VARCHAR(32) NULL');
    console.log('MIGRATION: ft_strategy_nav.strategy_hash added — one configuration could read and overwrite the NAV of another');
  }
  const cols = ['cash_value', 'market_value', 'total_nav', 'realized_pnl', 'unrealized_pnl', 'gross_exposure', 'benchmark_nav'];
  const missing = [];
  for (const c of cols) if (!(await hasColumn(pool, 'ft_strategy_nav', c))) missing.push(c);
  if (!missing.length) return;
  await pool.query(`ALTER TABLE ft_strategy_nav ${missing.map(c => `ADD COLUMN ${c} DECIMAL(16,6) NULL`).join(', ')}`);
  console.log(`MIGRATION: ft_strategy_nav gained ${missing.join(', ')} — it now stores a NAV, not just an unrealised percentage`);
}

async function migratePlanTable(pool) {
  const contract = [];
  if (!(await hasColumn(pool, 'ft_strategy_plan', 'buy_cost'))) contract.push('ADD COLUMN buy_cost DECIMAL(10,6) NULL');
  if (!(await hasColumn(pool, 'ft_strategy_plan', 'sell_cost'))) contract.push('ADD COLUMN sell_cost DECIMAL(10,6) NULL');
  if (!(await hasColumn(pool, 'ft_strategy_plan', 'execution_ledger_version'))) contract.push('ADD COLUMN execution_ledger_version INT NULL');
  if (contract.length) {
    await pool.query(`ALTER TABLE ft_strategy_plan ${contract.join(', ')}`);
    console.log('MIGRATION: ft_strategy_plan gained its execution contract (buy_cost / sell_cost / execution_ledger_version)');
  }
  if (!(await hasColumn(pool, 'ft_strategy_plan', 'nofill_json'))) {
    await pool.query('ALTER TABLE ft_strategy_plan ADD COLUMN nofill_json TEXT NULL');
    console.log('MIGRATION: ft_strategy_plan.nofill_json added');
  }
  const [[col]] = await pool.query(
    `SELECT COLUMN_TYPE t FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ft_strategy_plan' AND COLUMN_NAME = 'status'`);
  if (col && !/PARTIALLY_FILLED/.test(col.t)) {
    await pool.query(
      "ALTER TABLE ft_strategy_plan MODIFY COLUMN status ENUM('PLANNED','PARTIALLY_FILLED','EXECUTED','EXPIRED') NOT NULL DEFAULT 'PLANNED'");
    console.log('MIGRATION: ft_strategy_plan.status gained PARTIALLY_FILLED');
  }
}

/**
 * Add run_mode and provenance columns, and — the part that actually matters —
 * reclassify the rows that already exist.
 *
 * A naive `ADD COLUMN run_mode ... DEFAULT 'LIVE'` would stamp every replayed
 * row as LIVE and make the problem permanent and invisible, which is worse than
 * not having the column. The rows are classified by a rule that follows from
 * what LIVE means: a live decision is recorded at most a few days after the bar
 * it acts on. A row whose entry_date is months before the timestamp it was
 * written at cannot have been produced by a live run.
 */
async function migrateProvenance(pool) {
  if (await hasColumn(pool, 'ft_strategy_positions', 'run_mode')) {
    await reclassifyBatchWrites(pool);
    return;
  }

  console.log('MIGRATION: adding run_mode + provenance columns');
  await pool.query(`
    ALTER TABLE ft_strategy_positions
      ADD COLUMN run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      ADD COLUMN decision_date DATE NULL,
      ADD COLUMN decision_created_at DATETIME NULL,
      ADD COLUMN data_available_at DATETIME NULL,
      ADD COLUMN execution_observed_at DATETIME NULL,
      ADD COLUMN strategy_hash VARCHAR(32) NULL,
      ADD COLUMN code_commit VARCHAR(40) NULL,
      ADD KEY idx_runmode (strategy_id, run_mode, status)`);
  await pool.query(`
    ALTER TABLE ft_strategy_log
      ADD COLUMN run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
      ADD COLUMN decision_created_at DATETIME NULL,
      ADD COLUMN data_available_at DATETIME NULL,
      ADD COLUMN strategy_hash VARCHAR(32) NULL,
      ADD COLUMN code_commit VARCHAR(40) NULL,
      ADD KEY idx_runmode (strategy_id, run_mode)`);

  // A live entry is filled at the open of the trading day after the decision,
  // so entry_date is within a few days of when the row was written. Anything
  // older than that window was replayed out of history.
  const [p] = await pool.query(
    `UPDATE ft_strategy_positions SET run_mode='REPLAY' WHERE entry_date < DATE(created_at) - INTERVAL 5 DAY`);
  const [l] = await pool.query(
    `UPDATE ft_strategy_log SET run_mode='REPLAY' WHERE as_of_date < DATE(created_at) - INTERVAL 5 DAY`);
  console.log(`MIGRATION: reclassified ${p.affectedRows} position(s) and ${l.affectedRows} log row(s) as REPLAY.`);
  console.log('MIGRATION: they were written by --replay and must never count as forward performance.');
  await reclassifyBatchWrites(pool);
}

/**
 * Catch what the date-distance rule above misses.
 *
 * That rule marks a row REPLAY when its decision date is long before the moment
 * it was written. It got 42 of 42 positions right and 18 of 19 log rows right —
 * and left the replay's LAST iteration (as_of 2026-07-30, written 2026-08-02)
 * classified LIVE, because three days is inside any sane "a live run records
 * the recent past" window. One replayed decision masquerading as the entire
 * live track record is precisely the failure this whole column exists to
 * prevent, so the date heuristic alone is not enough.
 *
 * The reliable signal is batching. A live invocation writes exactly ONE log row
 * — it decides for a single date and exits. So two or more log rows sharing a
 * created_at down to the second can only have come from one loop over history.
 * Positions cannot be classified this way (a single live decision legitimately
 * opens eight positions in the same second); they are instead tied to the
 * decision that produced them, by execution date.
 *
 * Cheap, and safe to run on every startup: on a correct ledger it updates zero
 * rows.
 */
async function reclassifyBatchWrites(pool) {
  // ONLY rows that predate source_command, and only within one strategy_hash.
  //
  // This used to treat "two log rows share a created_at second" as proof of a
  // replay batch, on the reasoning that a live invocation writes exactly one log
  // row. That stopped being true when cmdFill was changed to drain every pending
  // plan in one run (review P0.1): a cron outage leaves two plans, one fill
  // executes both, both log rows land in the same second, and the next startup
  // would relabel genuine LIVE decisions as REPLAY and delete them from the
  // promotion gate. I introduced that interaction while fixing something else.
  //
  // The position half was worse: it matched on strategy_id and decision date
  // only, so a REPLAY log under hash A could flip a LIVE position under hash B.
  //
  // Rows written from now on carry source_command, so they are never touched
  // here. Once the historical rows are labelled this whole function is a no-op,
  // which is the intended end state — a timestamp is not evidence.
  const [batched] = await pool.query(
    `UPDATE ft_strategy_log SET run_mode='REPLAY', source_command='REPLAY_INFERRED'
      WHERE run_mode='LIVE' AND source_command IS NULL AND (strategy_id, strategy_hash, created_at) IN (
        SELECT * FROM (
          SELECT strategy_id, strategy_hash, created_at FROM ft_strategy_log
           WHERE source_command IS NULL
           GROUP BY strategy_id, strategy_hash, created_at HAVING COUNT(*) > 1
        ) batch)`);

  const [orphans] = await pool.query(
    `UPDATE ft_strategy_positions p SET p.run_mode='REPLAY', p.source_command='REPLAY_INFERRED'
      WHERE p.run_mode='LIVE' AND p.source_command IS NULL AND EXISTS (
        SELECT 1 FROM ft_strategy_log l
         WHERE l.strategy_id = p.strategy_id AND l.run_mode='REPLAY'
           AND (l.strategy_hash <=> p.strategy_hash)
           AND (l.as_of_date = p.decision_date
                OR (p.decision_date IS NULL AND p.entry_date BETWEEN l.as_of_date AND l.as_of_date + INTERVAL 5 DAY)))`);

  if (batched.affectedRows || orphans.affectedRows) {
    console.log(`PROVENANCE REPAIR: ${batched.affectedRows} log row(s) and ${orphans.affectedRows} position(s) predating source_command were inferred to be REPLAY.`);
    console.log('  Inference is used only for rows written before provenance was recorded, and only within one strategy_hash.');
  }

  // SEAL THE REMAINDER. The inference above is a ONE-TIME classification of rows
  // that predate provenance; everything it did not flip keeps whatever run_mode
  // it already had, and is now stamped so it can never be re-examined.
  //
  // Without this the previous commit's claim — "becomes a permanent no-op once
  // the historical rows are labelled" — was simply not implemented. Nothing
  // labelled them. Every pre-provenance row stayed source_command IS NULL and
  // stayed eligible for the timestamp rule on EVERY startup, forever. A cron
  // outage that legitimately produced two same-second LIVE log rows before this
  // deploy would be relabelled REPLAY on the next restart, and its fills with
  // it, and the promotion gate would lose them.
  //
  // Sealing runs AFTER the inference so the one-time classification still gets
  // its chance on a database restored from before provenance existed.
  let sealed = 0;
  for (const t of ['ft_strategy_log', 'ft_strategy_positions']) {
    const [r] = await pool.query(
      `UPDATE ${t} SET source_command = CONCAT('LEGACY_', run_mode) WHERE source_command IS NULL`);
    sealed += r.affectedRows;
  }
  if (sealed) {
    console.log(`PROVENANCE SEALED: ${sealed} pre-provenance row(s) stamped LEGACY_<run_mode>.`);
    console.log('  The timestamp heuristic can never re-examine them; it is a no-op from here.');
  }
}

async function loadSeries(pool) {
  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`);
  const series = new Map();
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    if (!series.has(r.stock_code)) series.set(r.stock_code, {
      open: new Array(n).fill(null), high: new Array(n).fill(null),
      close: new Array(n).fill(null), value: new Array(n).fill(null),
      dn0: new Array(n).fill(null), dn0Raw: new Array(n).fill(null), placed: 0, nConc: 0,
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c; s.high[i] = Number(r.high_price) || c;
    s.close[i] = c; s.value[i] = Number(r.value) || c * Number(r.volume || 0);
    s.placed++;
  }
  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0 FROM idx_concentration');
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s) continue;
    const v = sb.clipDn(r.dn0, sb.DEFAULTS.dnBound);
    if (v === null) continue;
    s.dn0[i] = v;
    // The RAW value, kept only for the snapshot digest. Hashing the clipped
    // value meant a restatement from 120 to 950 produced a bit-identical hash,
    // because both clip to 100 — the digest could not see a change to the data
    // it exists to fingerprint. 84 rows in idx_concentration breach the bound.
    s.dn0Raw[i] = Number(r.dn0); s.nConc++;
  }
  // NO UNIVERSE FILTER HERE. Eligibility is decided per decision bar inside
  // strategy_book.crossSection(), from data through bar i only. This loader
  // used to run `if (s.placed < 400 || s.nConc < 200) series.delete(t)` --
  // lifetime counts over the WHOLE sample, so a ticker entered the 2024
  // universe only if the code already knew it would eventually reach 400 bars
  // and 200 broker observations by the end of the data (review P0.2). Deleting
  // here also made strategy_book.js's "ALL INPUTS ARE AS-OF" header vacuous:
  // the Map arrived pre-filtered with future knowledge before the module ran.
  return { tradingDates, dateIdx, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series };
}

/**
 * Fingerprint of the data the decision was made from. Stored on the plan so a
 * later reader can tell whether the plan was produced from the data that
 * existed at plan time, rather than taking the timestamp's word for it.
 */
function snapshotHash(ctx) {
  // A CONTENT digest, not a shape digest (review P1.5). This used to hash only
  // the last date, the number of dates, the ticker count and two row counts. If
  // a close or a dn0 were CORRECTED in place — a restatement, a re-fetch, a
  // split adjustment — while the row counts stayed the same, the hash did not
  // move, so it could not establish that a plan came from the data it claims.
  //
  // Worse, two of the four series the decision actually reads contributed
  // nothing at all: `high` is the numerator of the entire 52-week rank and
  // `value` drives the liquidity screen. And the IHSG close series was absent in
  // any form, so a restatement that flipped `exposure` between 1 and 0 — the
  // difference between fully invested and standing aside — left the hash
  // unchanged.
  //
  // Every value the decision reads now feeds an order-independent digest:
  // per-ticker digests are XOR-folded so the result does not depend on Map
  // iteration order, then combined with the IHSG series.
  const h = crypto.createHash('sha256');
  let fold = Buffer.alloc(32);
  for (const [ticker, s] of ctx.series) {
    const t = crypto.createHash('sha256');
    t.update(ticker);
    for (let i = 0; i < s.close.length; i++) {
      const raw = s.dn0Raw ? s.dn0Raw[i] : s.dn0[i];
      if (s.close[i] === null && s.high[i] === null && s.value[i] === null && raw === null) continue;
      t.update(`${i}|${s.close[i]}|${s.high[i]}|${s.value[i]}|${s.dn0Raw ? s.dn0Raw[i] : s.dn0[i]};`);
    }
    const d = t.digest();
    for (let b = 0; b < 32; b++) fold[b] ^= d[b];
  }
  h.update(fold);
  h.update('|IHSG|');
  for (let i = 0; i < ctx.ihsgClose.length; i++) h.update(`${ctx.ihsgClose[i]};`);
  h.update(`|n=${ctx.tradingDates.length}|last=${ctx.tradingDates[ctx.tradingDates.length - 1]}|tickers=${ctx.series.size}`);
  return h.digest('hex').slice(0, 16);
}

/**
 * PLAN — decide, and write the intention down WITHOUT any price from the
 * execution bar (review P0.3).
 *
 * The point is that the plan is frozen before the execution price is observable
 * anywhere in this system. `decideFor` below cannot demonstrate that: it reads
 * `open[i + 1]` in the same pass that makes the decision, so its output is only
 * ever produced once the execution bar has already landed. That is a delayed
 * replay, however honest the ranking inputs are.
 *
 * HONEST LIMIT OF THIS SETUP. We hold end-of-day data only. The T+1 open does
 * not enter idx_stock_prices until that evening's pull, so `fill` necessarily
 * runs the following night, and no real intraday slippage, queue position or
 * broker rejection can be measured. What IS established is the thing the review
 * asked for: the decision existed, in the database, before the price that
 * executes it was knowable. Everything beyond that needs a live feed and a
 * broker, and this system has neither.
 */
/**
 * Fill regime_label on rows written before the column existed.
 *
 * Safe, and worth saying why: the label is a deterministic function of
 * (ihsgClose, ihsgSma, decision bar) — all as-of data that existed when the row
 * was written. Deriving it later introduces no look-ahead and changes no
 * decision. Without it the first LIVE decision could never count toward regime
 * coverage, purely because of when a column was added.
 */
async function backfillRegimeLabels(pool, ctx) {
  const { dateIdx, ihsgClose, ihsgSma } = ctx;
  for (const t of ['ft_strategy_plan', 'ft_strategy_log']) {
    const [rows] = await pool.query(
      `SELECT id, as_of_date FROM ${t} WHERE strategy_id=? AND regime_label IS NULL`, [STRATEGY_ID]);
    let n = 0;
    for (const r of rows) {
      const i = dateIdx.get(toDateStr(r.as_of_date));
      if (i === undefined) continue;
      const label = sb.marketRegime(ihsgClose, ihsgSma, i);
      if (!label) continue;
      await pool.query(`UPDATE ${t} SET regime_label=? WHERE id=?`, [label, r.id]);
      n++;
    }
    if (n) console.log(`BACKFILL: ${t}.regime_label set on ${n} row(s) from as-of index data`);
  }
}

async function cmdPlan(pool, ctx, quiet, ids) {
  const strategyId = (ids && ids.strategyId) || STRATEGY_ID;
  const strategyHash = (ids && ids.strategyHash) || STRATEGY_HASH;
  const { tradingDates, series, ihsgClose, ihsgSma } = ctx;
  const i = tradingDates.length - 1;              // the latest COMPLETE bar
  const asOf = tradingDates[i];
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const [dup] = await pool.query(
    'SELECT id, status FROM ft_strategy_plan WHERE strategy_id=? AND run_mode=? AND strategy_hash=? AND as_of_date=?',
    [strategyId, 'LIVE', strategyHash, asOf]);
  if (dup.length) return { skipped: `plan for ${asOf} already exists (${dup[0].status}) — never recomputed` };

  const [last] = await pool.query(
    // Hash-scoped: an unrelated configuration must not block this one from
    // planning today, nor delay the start of its record by a whole cadence
    // (review P0.5).
    'SELECT MAX(as_of_date) d FROM ft_strategy_plan WHERE strategy_id=? AND run_mode=? AND strategy_hash=?',
    [strategyId, 'LIVE', strategyHash]);
  if (last[0].d) {
    const lastIdx = ctx.dateIdx.get(toDateStr(last[0].d));
    if (lastIdx !== undefined && i - lastIdx < REBAL_BARS) {
      return { skipped: `no decision due — ${i - lastIdx}/${REBAL_BARS} trading days since ${toDateStr(last[0].d)}` };
    }
  }

  // Holdings come from FILLED positions only. A plan that has not executed yet
  // is not a holding, and treating it as one would let an unfilled intention
  // silently become part of the next decision's starting book.
  const [openRows] = await pool.query(
    'SELECT ticker FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=? AND strategy_hash=?',
    [strategyId, 'OPEN', 'LIVE', strategyHash]);

  const d = sb.targetBook({
    series, i, ihsgClose, ihsgSma, currentHoldings: openRows.map(r => r.ticker), opts: PARAMS,
  });
  // The market condition this decision was made under, recorded at decision
  // time. A label, never an input (review P1.1).
  const regimeLabel = sb.marketRegime(ihsgClose, ihsgSma, i);

  // Decision-time reference price, for implementation shortfall at fill. This is
  // the last price the decision could possibly have seen — bar i's close.
  const reference = {};
  for (const t of d.target) {
    const s = series.get(t);
    if (s && s.close[i] > 0) reference[t] = s.close[i];
  }

  await pool.query(
    `INSERT INTO ft_strategy_plan
       (strategy_id, as_of_date, run_mode, generated_at, data_snapshot_hash, strategy_hash, code_commit,
        exposure, reason, regime_label, eligible, vetoed, target_json, reference_json,
        buy_cost, sell_cost, execution_ledger_version, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'PLANNED')`,
    [strategyId, asOf, 'LIVE', nowSql, snapshotHash(ctx), strategyHash, CODE_COMMIT,
     d.exposure, d.reason, regimeLabel, d.eligible, d.vetoedCount, JSON.stringify(d.target), JSON.stringify(reference),
     BUY_COST, SELL_COST, EXECUTION_LEDGER_VERSION]);

  if (!quiet) {
    console.log(`PLAN  ${asOf}  ${d.reason}   [market ${regimeLabel || 'UNKNOWN'}]`);
    console.log(`  eligible ${d.eligible}, vetoed ${d.vetoedCount}`);
    console.log(`  book: ${d.target.length ? d.target.join(', ') : '(flat)'}`);
    console.log('  status PLANNED — no execution price read. Run `fill` once the next bar lands.');
  }
  return { asOf, target: d.target, exposure: d.exposure };
}

/**
 * FILL — execute PLANNED books whose execution bar has since arrived.
 *
 * Reads prices for the first trading bar strictly after the plan's as_of_date,
 * which is robust to holidays in a way a stored calendar date would not be. The
 * plan itself is never recomputed here; only its execution is recorded.
 */
async function cmdFill(pool, ctx, quiet, ids) {
  const strategyId = (ids && ids.strategyId) || STRATEGY_ID;
  const strategyHash = (ids && ids.strategyHash) || STRATEGY_HASH;
  const { tradingDates, dateIdx, series } = ctx;
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const [plans] = await pool.query(
    // Every PLANNED plan, whatever hash produced it — but each is executed
    // against ITS OWN hash book and written under ITS OWN hash (review P0.1).
    // Selecting without a hash filter while WRITING the running code hash was
    // the worst of both: a plan decided by configuration A, filled after a
    // change to B, landed in B track record. Each strategy_hash is an
    // independent record with an independent book; `plan` only ever creates
    // plans for the current one, so nothing is orphaned.
    //
    // ONLY 'PLANNED'. Re-selecting PARTIALLY_FILLED created a permanent work
    // queue: a plan containing a name that is suspended for good would be
    // re-processed every night forever, because its execution bar is fixed at
    // as_of + 1 and that bar is closed history. The retry does not live in the
    // plan — cmdPlan passes only FILLED positions as holdings and targetBook
    // refills the empty slot from the ranked cross-section, so an unfilled name
    // is re-targeted at the next decision if it still ranks. PARTIALLY_FILLED
    // is a terminal record of what happened, not an instruction to try again.
    `SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND run_mode=? AND status='PLANNED' ORDER BY as_of_date`,
    [strategyId, 'LIVE']);

  // EXPIRE ANY PLAN FROM ANOTHER CONFIGURATION (review P0.2). Recording a stale
  // plan's fills under its own hash was half the fix: the EXECUTION still used
  // the running code's costs, sizing and ledger version. So hash A's record
  // would contain trades executed by implementation B, and A would no longer
  // describe what actually happened. Keeping old implementations around to
  // replay them faithfully is the alternative, and it is not worth it here.
  // A plan is stale if its STRATEGY differs, or if the EXECUTION CONTRACT it was
  // decided under differs from the one this process would apply. The hash alone
  // misses the second case: a deploy that changes buyFill, sizing or the ledger
  // version without touching EFFECTIVE_CONFIG leaves the hash identical, so the
  // old plan would be filled by new machinery and recorded as if nothing had
  // changed (review P0.2 residual).
  const contractDiffers = p =>
    (p.buy_cost !== null && Number(p.buy_cost) !== BUY_COST) ||
    (p.sell_cost !== null && Number(p.sell_cost) !== SELL_COST) ||
    (p.execution_ledger_version !== null && Number(p.execution_ledger_version) !== EXECUTION_LEDGER_VERSION);
  const stale = plans.filter(p => (p.strategy_hash && p.strategy_hash !== strategyHash) || contractDiffers(p));
  for (const p of stale) {
    await pool.query(
      `UPDATE ft_strategy_plan SET status='EXPIRED', nofill_json=? WHERE id=?`,
      [JSON.stringify({
        expired: p.strategy_hash && p.strategy_hash !== strategyHash ? 'EXPIRED_CONFIG_CHANGE' : 'EXPIRED_EXECUTION_CONTRACT',
        planHash: p.strategy_hash, runningHash: strategyHash,
        planContract: { buy: p.buy_cost, sell: p.sell_cost, ledger: p.execution_ledger_version },
        runningContract: { buy: BUY_COST, sell: SELL_COST, ledger: EXECUTION_LEDGER_VERSION },
      }), p.id]);
  }
  if (stale.length && !quiet) {
    console.log(`FILL  ${stale.length} plan(s) EXPIRED — decided by a different configuration, and this code cannot execute them faithfully`);
  }

  // Run-level totals for the console line only. The PER-PLAN counters live
  // inside the loop: they used to be declared out here and written into every
  // plan's ft_strategy_log row, so with two pending plans the second row got
  // the first plan's activity added to its own (review P1.3).
  let executed = 0, partial = 0, waiting = 0, expiredNoHash = 0;
  let totOpened = 0, totClosed = 0, totMissed = 0;
  let shortfallSum = 0, shortfallN = 0;

  for (const p of plans) {
    if ((p.strategy_hash && p.strategy_hash !== strategyHash) || contractDiffers(p)) continue;   // expired above
    const asOf = toDateStr(p.as_of_date);
    const i = dateIdx.get(asOf);
    if (i === undefined) continue;
    const execI = i + 1;
    if (execI >= tradingDates.length) { waiting++; continue; }   // genuinely not knowable yet

    const target = JSON.parse(p.target_json || '[]');
    const reference = JSON.parse(p.reference_json || '{}');
    const tset = new Set(target);
    const exposure = Number(p.exposure);
    // NO FALLBACK to the running hash (review P0.6). A plan with no recorded
    // hash carries no evidence that the current configuration produced it;
    // adopting it would import an unknown strategy's decision into this track
    // record. Expire it instead and say why.
    if (!p.strategy_hash) {
      await pool.query(
        `UPDATE ft_strategy_plan SET status='EXPIRED', nofill_json=? WHERE id=?`,
        [JSON.stringify({ expired: 'MISSING_strategyHash' }), p.id]);
      expiredNoHash++;
      continue;
    }
    const planHash = p.strategy_hash;                    // the hash that DECIDED this

    // One transaction per plan, so a crash cannot leave a plan half-executed
    // with its status already advanced (review P1.3). The work was already
    // idempotent enough to be re-runnable, but the sell-done/buy-not-done
    // window could still corrupt a NAV mark taken in between.
    const conn = await pool.getConnection();
    let opened = 0, closed = 0;
    const noFill = { buy: [], sell: [] };
    try {
      await conn.beginTransaction();

      // Hash-scoped like every report query. Without it, a configuration change
      // left retained positions invisible to the report while they still
      // consumed capacity here — the book and the record would disagree.
      // The whole ledger for this hash, every status: cash and NAV are derived
      // from it, so a closed position matters as much as an open one.
      const [ledgerRows] = await conn.query(
        'SELECT ticker, entry_date, exit_date, cost_basis, proceeds, units FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=?',
        [strategyId, 'LIVE', planHash]);
      const [openRows] = await conn.query(
        'SELECT ticker, entry_price, entry_date, weight, units FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=? AND strategy_hash=?',
        [strategyId, 'OPEN', 'LIVE', planHash]);

      const stranded = [];      // wanted out, could not get out
      for (const row of openRows) {
        if (tset.has(row.ticker)) continue;
        const px = exec.sellFill(series.get(row.ticker), execI);
        if (px === null) { noFill.sell.push(row.ticker); stranded.push(row); continue; }
        const entry = Number(row.entry_price);
        const gross = ((px - entry) / entry) * 100;
        const soldUnits = Number(row.units || 0);
        const soldProceeds = soldUnits * px * (1 - SELL_COST);
        const [upd] = await conn.query(
          `UPDATE ft_strategy_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?,
                  gross_pct=?, net_pct=?, proceeds=?, execution_observed_at=?,
                  source_command=COALESCE(source_command,'LIVE_FILL'), run_id=COALESCE(run_id,?)
            WHERE strategy_id=? AND ticker=? AND entry_date=? AND status='OPEN' AND run_mode=? AND strategy_hash=?`,
          [tradingDates[execI], px, exposure === 0 ? 'REGIME_FLAT' : 'REBALANCE',
           gross.toFixed(4), (gross - (BUY_COST + SELL_COST) * 100).toFixed(4), soldProceeds.toFixed(8), nowSql, RUN_ID,
           strategyId, row.ticker, toDateStr(row.entry_date), 'LIVE', planHash]);
        // P0.4: a narrowed UPDATE, like INSERT IGNORE, can match nothing.
        // Counting regardless let the log claim a position was closed when the
        // statement touched no row at all.
        if (upd.affectedRows === 1) {
          closed++;
          const led = ledgerRows.find(l => l.ticker === row.ticker && toDateStr(l.entry_date) === toDateStr(row.entry_date));
          if (led) { led.exit_date = tradingDates[execI]; led.proceeds = soldProceeds; }
        }
      }

      const retained = openRows.filter(r => tset.has(r.ticker));
      const heldNow = new Set(retained.map(r => r.ticker));

      // SELF-FINANCING (review P0.5). Size against the CURRENT NAV and spend
      // only cash that exists. The previous rule was 1 - committedWeight, which
      // is blind to realized P&L: after losing 20% it still authorised a full
      // notional 1.0 against a NAV of 0.80, i.e. 125% leverage funded by
      // nothing. Now a loss shrinks the book and the next allocation with it.
      const nav = navAt(ledgerRows, series, execI, tradingDates[execI]);
      let cash = cashAt(ledgerRows, tradingDates[execI]);
      const toBuy = target.filter(t => !heldNow.has(t));
      const perName = toBuy.length ? nav / target.length : 0;

      for (const t of toBuy) {
        const px = exec.buyFill(series.get(t), execI);
        if (px === null) { noFill.buy.push(t); continue; }
        const spend = Math.min(perName, cash);
        if (!(spend > 0)) { noFill.buy.push(t); continue; }     // no cash left
        const units = (spend * (1 - BUY_COST)) / px;
        // Implementation shortfall: what the decision saw vs what it paid.
        if (reference[t] > 0) { shortfallSum += (px - reference[t]) / reference[t]; shortfallN++; }
        const [ins] = await conn.query(
          `INSERT IGNORE INTO ft_strategy_positions
             (strategy_id, ticker, entry_date, entry_price, weight, units, cost_basis,
              run_mode, decision_date, decision_created_at, data_available_at, execution_observed_at,
              strategy_hash, code_commit, source_command, run_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'LIVE_FILL',?)`,
          [strategyId, t, tradingDates[execI], px, (nav > 0 ? spend / nav : 0).toFixed(5),
           units.toFixed(10), spend.toFixed(8),
           'LIVE', asOf, p.generated_at, p.generated_at, nowSql, planHash, CODE_COMMIT, RUN_ID]);
        if (ins.affectedRows === 1) {
          opened++;
          cash -= spend;
          ledgerRows.push({ ticker: t, entry_date: tradingDates[execI], exit_date: null, cost_basis: spend, proceeds: null, units });
        } else noFill.buy.push(t);
      }

      await conn.query(
        `INSERT IGNORE INTO ft_strategy_log
           (strategy_id, as_of_date, exposure, reason, regime_label, eligible, vetoed, n_target, opened, closed, target_json,
            run_mode, decision_created_at, data_available_at, strategy_hash, code_commit, source_command, run_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'LIVE_FILL',?)`,
        [strategyId, asOf, exposure, p.reason, p.regime_label, p.eligible, p.vetoed, target.length, opened, closed,
         p.target_json, 'LIVE', p.generated_at, p.generated_at, planHash, CODE_COMMIT, RUN_ID]);

      // PARTIALLY_FILLED is a real state (review P1.2). Marking a plan EXECUTED
      // when part of it did not fill throws away the only record that intent and
      // outcome diverged -- which is the single thing this whole lifecycle exists
      // to capture.
      const anyNoFill = noFill.buy.length + noFill.sell.length > 0;
      await conn.query(
        `UPDATE ft_strategy_plan SET status=?, executed_at=?, execution_date=?, nofill_json=? WHERE id=?`,
        [anyNoFill ? 'PARTIALLY_FILLED' : 'EXECUTED', nowSql, tradingDates[execI],
         anyNoFill ? JSON.stringify(noFill) : null, p.id]);

      await conn.commit();
      if (anyNoFill) partial++; else executed++;
      totOpened += opened; totClosed += closed;
      totMissed += noFill.buy.length + noFill.sell.length;
    } catch (e) {
      await conn.rollback();
      console.error(`FILL  plan ${asOf} rolled back: ${e.message}`);
    } finally {
      conn.release();
    }
  }

  if (!quiet) {
    console.log(`FILL  ${executed} fully executed, ${partial} partially filled   opened ${totOpened}, closed ${totClosed}, no-fill ${totMissed}`);
    if (waiting) console.log(`      ${waiting} plan(s) still awaiting an execution bar — correct, not an error`);
    if (expiredNoHash) console.log(`      ${expiredNoHash} plan(s) EXPIRED with no strategy_hash — provenance unknown, not adopted`);
    if (shortfallN) console.log(`      implementation shortfall ${(shortfallSum / shortfallN * 100).toFixed(3)}% mean (decision close -> execution open)`);
    if (!executed && !partial && !waiting) console.log('      nothing to do.');
  }
  return { executed, partial, opened: totOpened, closed: totClosed, missed: totMissed, waiting };
}

/**
 * MARK — record a real net asset value, so the LIVE equity curve is OBSERVED
 * rather than reconstructed from the plan at report time (review P0.3).
 *
 * This used to store only `unrealised_pct`, a weighted sum of open-position
 * returns. That is not a NAV: it excluded realized P&L entirely, carried no
 * cash, and no report ever read it — `reportFor` rebuilt everything from the
 * target book instead.
 *
 * The accounting base is a notional book of 1.0, because the ledger records
 * WEIGHTS, not share counts — this recorder deliberately holds no capital. Every
 * field below is a fraction of that book and they reconcile:
 *
 *   gross_exposure  = Σ weight of open positions
 *   market_value    = Σ weight × (mark / entry)        current value of that slice
 *   unrealized_pnl  = market_value − gross_exposure
 *   realized_pnl    = Σ over closed positions of weight × net_pct
 *   cash_value      = 1 − gross_exposure + realized_pnl
 *   total_nav       = cash_value + market_value = 1 + realized_pnl + unrealized_pnl
 *
 * What it is NOT: compounded. Weights are fractions of the ORIGINAL book, so
 * gains are not reinvested. Stated here rather than papered over — a true
 * compounding NAV needs a capital base and share counts, which is a different
 * recorder from this one.
 */
async function cmdMark(pool, ctx, quiet, ids) {
  const strategyId = (ids && ids.strategyId) || STRATEGY_ID;
  const strategyHash = (ids && ids.strategyHash) || STRATEGY_HASH;
  const { tradingDates, series, ihsgClose, dateIdx } = ctx;
  const i = tradingDates.length - 1;
  const today = tradingDates[i];

  const [ledger] = await pool.query(
    `SELECT ticker, entry_date, exit_date, units, cost_basis, proceeds, status
       FROM ft_strategy_positions WHERE strategy_id=? AND run_mode='LIVE' AND strategy_hash=?`,
    [strategyId, strategyHash]);
  const [[firstRow]] = await pool.query(
    `SELECT MIN(as_of_date) d FROM ft_strategy_log WHERE strategy_id=? AND run_mode='LIVE' AND strategy_hash=?`,
    [strategyId, strategyHash]);

  const open = ledger.filter(r => r.status === 'OPEN');
  const closed = ledger.filter(r => r.status === 'CLOSED');

  const cash = cashAt(ledger, today);
  let marketValue = 0, openCost = 0;
  const unmarkable = [];
  for (const r of open) {
    openCost += Number(r.cost_basis || 0);
    const px = exec.markPrice(series.get(r.ticker), i);
    if (px === null) { unmarkable.push(r.ticker); marketValue += Number(r.cost_basis || 0); continue; }
    marketValue += Number(r.units || 0) * px;
  }
  const realized = closed.reduce((a, r) => a + (Number(r.proceeds || 0) - Number(r.cost_basis || 0)), 0);
  const unrealized = marketValue - openCost;
  const nav = cash + marketValue;
  const grossExposure = nav > 0 ? marketValue / nav : 0;

  let benchNav = null;
  if (firstRow.d) {
    const j = dateIdx.get(toDateStr(firstRow.d));
    if (j !== undefined && ihsgClose[j] > 0) benchNav = ihsgClose[i] / ihsgClose[j];
  }

  await pool.query(
    `INSERT INTO ft_strategy_nav
       (strategy_id, mark_date, run_mode, strategy_hash, open_positions, unrealised_pct, unmarkable,
        cash_value, market_value, total_nav, realized_pnl, unrealized_pnl, gross_exposure, benchmark_nav)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE open_positions=VALUES(open_positions), unrealised_pct=VALUES(unrealised_pct),
       unmarkable=VALUES(unmarkable), cash_value=VALUES(cash_value), market_value=VALUES(market_value),
       total_nav=VALUES(total_nav), realized_pnl=VALUES(realized_pnl), unrealized_pnl=VALUES(unrealized_pnl),
       gross_exposure=VALUES(gross_exposure), benchmark_nav=VALUES(benchmark_nav)`,
    [strategyId, today, 'LIVE', strategyHash, open.length, (unrealized * 100).toFixed(4),
     unmarkable.join(',') || null, cash.toFixed(6), marketValue.toFixed(6), nav.toFixed(6),
     realized.toFixed(6), unrealized.toFixed(6), grossExposure.toFixed(6),
     benchNav === null ? null : benchNav.toFixed(6)]);

  if (!quiet) {
    console.log(`MARK  ${today}   NAV ${nav.toFixed(4)}   (cash ${cash.toFixed(4)} + market ${marketValue.toFixed(4)})`);
    console.log(`      ${open.length} open, exposure ${(grossExposure * 100).toFixed(1)}%   realized ${(realized * 100).toFixed(2)}%   unrealized ${(unrealized * 100).toFixed(2)}%`);
    if (benchNav !== null) console.log(`      IHSG on the same base: ${benchNav.toFixed(4)}`);
    if (unmarkable.length) console.log(`      carried at cost, no price found: ${unmarkable.join(', ')}`);
    if (cash < -1e-9) console.log(`      ** NEGATIVE CASH ${cash.toFixed(6)} — the book borrowed, which must not happen`);
  }
  return { nav, cash, marketValue, realized, unrealized, grossExposure, benchNav, openPositions: open.length, unmarkable };
}

/**
 * Decide AND execute in one pass. This is the REPLAY path and only the replay
 * path: collapsing the two stages is exactly what makes replay replay. The LIVE
 * lifecycle goes through cmdPlan then cmdFill so the decision is provably frozen
 * before its execution price is observable (review P0.3).
 *
 * @param {'REPLAY'} runMode
 */
async function decideFor(pool, ctx, i, quiet, runMode) {
  if (runMode !== 'REPLAY') {
    throw new Error('decideFor is the replay path only — LIVE must use cmdPlan/cmdFill so the plan is frozen before execution (review P0.3)');
  }
  const { tradingDates, series, ihsgClose, ihsgSma } = ctx;
  const asOf = tradingDates[i];
  const execI = i + 1;
  if (execI >= tradingDates.length) return { skipped: 'no execution bar yet' };
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const [dup] = await pool.query('SELECT id FROM ft_strategy_log WHERE strategy_id=? AND as_of_date=?', [STRATEGY_ID, asOf]);
  if (dup.length) return { skipped: 'already recorded' };

  const [openRows] = await pool.query(
    'SELECT ticker, entry_price, entry_date, weight, units FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=?',
    [STRATEGY_ID, 'OPEN', runMode]);
  const [ledgerRows] = await pool.query(
    'SELECT ticker, entry_date, exit_date, units, cost_basis, proceeds FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=?',
    [STRATEGY_ID, runMode, STRATEGY_HASH]);
  const holdings = openRows.map(r => r.ticker);

  const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: holdings, opts: PARAMS });
  const tset = new Set(d.target);

  let closed = 0, opened = 0;
  const stranded = [];
  for (const row of openRows) {
    if (tset.has(row.ticker)) continue;
    const px = exec.sellFill(series.get(row.ticker), execI);
    // A seller who cannot sell still owns the shares. Recorded here as well as
    // in cmdFill: this is the REPLAY writer, and it was left behind when the
    // live path got the fix, so the replay ledger could hold more weight than
    // the book has. periodReturns then reported that faithfully as leverage.
    if (px === null) { stranded.push(row); continue; }
    const soldProceeds = Number(row.units || 0) * px * (1 - SELL_COST);
    const entry = Number(row.entry_price);
    const gross = ((px - entry) / entry) * 100;
    const net = gross - (BUY_COST + SELL_COST) * 100;
    await pool.query(
      `UPDATE ft_strategy_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, gross_pct=?, net_pct=?,
              proceeds=?, execution_observed_at=?
        WHERE strategy_id=? AND ticker=? AND entry_date=? AND status='OPEN' AND run_mode=?`,
      [tradingDates[execI], px, d.exposure === 0 ? 'REGIME_FLAT' : 'REBALANCE',
       gross.toFixed(4), net.toFixed(4), soldProceeds.toFixed(8), nowSql,
       STRATEGY_ID, row.ticker, toDateStr(row.entry_date), runMode]);
    closed++;
    const led = ledgerRows.find(l => l.ticker === row.ticker && toDateStr(l.entry_date) === toDateStr(row.entry_date));
    if (led) { led.exit_date = tradingDates[execI]; led.proceeds = soldProceeds; }
  }

  const retained = openRows.filter(r => tset.has(r.ticker));
  const heldNow = new Set(retained.map(r => r.ticker));
  // Same self-financing rule as cmdFill: size against NAV, spend only cash.
  const nav = navAt(ledgerRows, series, execI, tradingDates[execI]);
  let cash = cashAt(ledgerRows, tradingDates[execI]);
  const toBuy = d.target.filter(t => !heldNow.has(t));
  const perName = toBuy.length ? nav / d.target.length : 0;
  for (const t of toBuy) {
    const px = exec.buyFill(series.get(t), execI);
    if (px === null) continue;
    const spend = Math.min(perName, cash);
    if (!(spend > 0)) continue;
    const units = (spend * (1 - BUY_COST)) / px;
    const [ins] = await pool.query(
      `INSERT IGNORE INTO ft_strategy_positions
         (strategy_id, ticker, entry_date, entry_price, weight, units, cost_basis,
          run_mode, decision_date, decision_created_at, data_available_at, strategy_hash, code_commit, source_command, run_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'REPLAY',?)`,
      [STRATEGY_ID, t, tradingDates[execI], px, (nav > 0 ? spend / nav : 0).toFixed(5),
       units.toFixed(10), spend.toFixed(8),
       runMode, asOf, nowSql, nowSql, STRATEGY_HASH, CODE_COMMIT, RUN_ID]);
    if (ins.affectedRows === 1) {
      opened++;
      cash -= spend;
      ledgerRows.push({ ticker: t, entry_date: tradingDates[execI], exit_date: null, cost_basis: spend, proceeds: null, units });
    }
  }

  await pool.query(
    `INSERT IGNORE INTO ft_strategy_log
       (strategy_id, as_of_date, exposure, reason, regime_label, eligible, vetoed, n_target, opened, closed, target_json,
        run_mode, decision_created_at, data_available_at, strategy_hash, code_commit, source_command, run_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'REPLAY',?)`,
    [STRATEGY_ID, asOf, d.exposure, d.reason, sb.marketRegime(ihsgClose, ihsgSma, i), d.eligible, d.vetoedCount,
     d.target.length, opened, closed, JSON.stringify(d.target), runMode, nowSql, nowSql, STRATEGY_HASH, CODE_COMMIT, RUN_ID]);

  if (!quiet) {
    console.log(`${asOf}  [${runMode}]  ${d.reason}`);
    console.log(`  eligible ${d.eligible}, vetoed ${d.vetoedCount} | opened ${opened}, closed ${closed}`);
    console.log(`  book: ${d.target.length ? d.target.join(', ') : '(flat)'}`);
  }
  return { asOf, opened, closed, exposure: d.exposure, target: d.target };
}

/**
 * Reconstruct the portfolio's period-by-period return from the recorded ledger
 * — the book that was actually written on each decision date, held to the next
 * decision date, priced at the execution bar, charged the real turnover cost.
 *
 * Read from the log rather than recomputed from the strategy: the point of a
 * forward test is to measure what was recorded at the time, not what the
 * current code would decide today.
 */
/**
 * Notional starting capital. The recorder holds no money; 1.0 makes every
 * figure a fraction of the book and keeps NAV directly comparable to the
 * benchmark legs, which are also indexed to 1.
 */
const INITIAL_CAPITAL = 1.0;

/**
 * Cash on hand at `dateStr`, from the ledger alone: what was never spent, plus
 * what came back from sales. This is the number that limits buying — the old
 * `1 - committedWeight` could not see a realized loss and would happily deploy
 * a full book after one (review P0.5).
 */
function cashAt(rows, dateStr) {
  let cash = INITIAL_CAPITAL;
  for (const r of rows) {
    if (toDateStr(r.entry_date) <= dateStr) cash -= Number(r.cost_basis || 0);
    if (r.exit_date && toDateStr(r.exit_date) <= dateStr) cash += Number(r.proceeds || 0);
  }
  return cash;
}

/**
 * Net asset value at bar `i`: cash plus the marked value of what is held.
 *
 * THE authoritative series. Period return is navAt(b) / navAt(a) - 1, and the
 * gate, the information ratio and the drawdown all read it. Previously the
 * report compounded per-period weighted returns while cmdMark computed an
 * additive figure, so two accounting methods could disagree about whether the
 * same record passed (review P0.6).
 */
function navAt(rows, series, i, dateStr, priceFn = barPrice) {
  let nav = cashAt(rows, dateStr);
  for (const r of rows) {
    if (toDateStr(r.entry_date) > dateStr) continue;
    if (r.exit_date && toDateStr(r.exit_date) <= dateStr) continue;
    const px = priceFn(series.get(r.ticker), i);
    if (px === null) continue;
    nav += Number(r.units || 0) * px;
  }
  return nav;
}

/** Price of `s` at bar j: the execution open where one exists, else the last real close. */
function barPrice(s, j) {
  if (!s) return null;
  return (s.open && s.open[j] > 0) ? s.open[j] : exec.markPrice(s, j);
}

/**
 * Period-by-period return of the portfolio that was ACTUALLY HELD.
 *
 * FIXED 2026-08-04 (review P0.1). This used to read `target_json` — the frozen
 * PLAN — and take an unweighted mean over the names in it. Three things were
 * wrong with that, all in the flattering direction:
 *
 *  - An unweighted mean renormalises the book to 100% invested however many
 *    names actually filled. With 8 targets and 2 buy NO_FILLs, the cash sitting
 *    idle was silently re-invested into the 6 that did fill.
 *  - A position that failed to SELL stays open but is by construction absent
 *    from the next target, so its return vanished from the report entirely.
 *  - A holding that stopped printing failed the `p1 > 0` test and was dropped
 *    from the average — so a name going untradeable, the worst case for a
 *    holder, contributed 0.00% instead of a loss.
 *
 * It now reads ft_strategy_positions, the ledger `fill` actually writes, and
 * weights each holding by the weight recorded at entry. Because `cmdFill` sizes
 * from free capacity, those weights sum to at most 1 — so an unfilled slice
 * correctly earns nothing rather than being redistributed.
 *
 * @param {Array} positionRows - every LIVE position row, any status
 */
function periodReturns(ctx, logRows, positionRows = []) {
  const { dateIdx, tradingDates, series, ihsgClose } = ctx;
  const port = [], bench = [], universe = [], regimes = [], navs = [];
  let turnoverTotal = 0;

  // THE DEPLOYMENT LEG (review P1.1). The first period ran from the NAV AFTER
  // the opening trades to the next execution, so the cost of putting the book on
  // sat in the denominator and never appeared in the reported return: a book
  // opened at 0.998 with no price movement read as 0.00% instead of -0.20%.
  // Charged here as its own period, with the benchmark flat over it, so the
  // strategy pays for entering and the comparison stays fair.
  if (logRows.length) {
    const i0 = dateIdx.get(toDateStr(logRows[0].as_of_date));
    if (i0 !== undefined && i0 + 1 < tradingDates.length) {
      const exec0 = i0 + 1;
      const nav0 = navAt(positionRows, series, exec0, tradingDates[exec0]);
      port.push(nav0 / INITIAL_CAPITAL - 1);
      bench.push(0);
      universe.push(0);
      regimes.push(logRows[0].regime_label || null);
      navs.push(nav0);
    }
  }

  for (let k = 0; k < logRows.length - 1; k++) {
    const a = logRows[k], b = logRows[k + 1];
    const ia = dateIdx.get(toDateStr(a.as_of_date)), ib = dateIdx.get(toDateStr(b.as_of_date));
    if (ia === undefined || ib === undefined) continue;
    const execA = ia + 1, execB = ib + 1;
    if (execB >= tradingDates.length) continue;
    const dA = tradingDates[execA], dB = tradingDates[execB];

    // ONE authoritative series (review P0.6). Costs need no separate term: a
    // buy leaves cash as cost_basis and returns fewer units, a sell returns
    // proceeds already net of fees, so the fee is inside the NAV path by
    // construction. The old code added an explicit cost term on top of a
    // weighted price move, which double-counted in some periods and missed
    // entirely in others.
    const nav0 = navAt(positionRows, series, execA, dA);
    const nav1 = navAt(positionRows, series, execB, dB);
    navs.push(nav1);
    port.push(nav0 > 0 ? nav1 / nav0 - 1 : 0);

    let turnover = 0;
    for (const h of positionRows) {
      if (toDateStr(h.entry_date) === dB) turnover += Number(h.cost_basis || 0) / Math.max(nav0, 1e-9);
      if (h.exit_date && toDateStr(h.exit_date) === dB) turnover += Number(h.proceeds || 0) / Math.max(nav0, 1e-9);
    }
    turnoverTotal += turnover;

    // PRIMARY BENCHMARK: the point-in-time eligible universe, equal-weighted
    // (review P0.5, 2026-08-03). IHSG alone is the wrong bar to clear -- this
    // strategy has already screened for liquidity, price-history depth and
    // broker coverage, so beating IHSG can come entirely from the SCREEN while
    // the SELECTION adds nothing. Measuring against the set the names were
    // chosen FROM is what isolates the choice.
    const elig = sb.crossSection(series, ia, PARAMS);
    const eligRets = [];
    for (const r of elig) {
      const s2 = series.get(r.ticker);
      const q0 = barPrice(s2, execA), q1 = barPrice(s2, execB);
      if (!(q0 > 0) || !(q1 > 0)) continue;
      eligRets.push(q1 / q0 - 1);
    }
    universe.push(eligRets.length ? eligRets.reduce((x, y) => x + y, 0) / eligRets.length : 0);

    bench.push(ihsgClose[execB] / ihsgClose[execA] - 1);
    // The recorded label only. Falling back to the reason string is what made
    // INSUFFICIENT_UNIVERSE -- a data outage -- count as a market regime.
    regimes.push(a.regime_label || null);
  }
  return { port, bench, universe, regimes, navs, avgTurnover: port.length ? turnoverTotal / port.length : 0 };
}

async function reportFor(pool, ctx, runMode, ids) {
  const strategyId = (ids && ids.strategyId) || STRATEGY_ID;
  const strategyHash = (ids && ids.strategyHash) || STRATEGY_HASH;
  // EVERY QUERY IS SCOPED TO THE CURRENT strategy_hash (review P0.4). The code
  // comments have always insisted records from different configurations must
  // not be pooled; nothing enforced it, because reportFor filtered on
  // strategy_id and run_mode only. Rows written under an older configuration
  // are not silently dropped — `otherHashes` below reports them, so an empty
  // record reads as "the configuration changed" rather than "nothing happened".
  const HASH = [strategyId, runMode, strategyHash];
  const [logRows] = await pool.query(
    'SELECT as_of_date, exposure, reason, regime_label, target_json, opened, closed FROM ft_strategy_log WHERE strategy_id=? AND run_mode=? AND strategy_hash=? ORDER BY as_of_date', HASH);
  const [closedRows] = await pool.query(
    "SELECT net_pct, cost_basis, proceeds, exit_date FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? AND status='CLOSED'", HASH);
  const [openRows] = await pool.query(
    "SELECT ticker, entry_date, entry_price, weight FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? AND status='OPEN' ORDER BY entry_date", HASH);
  const [[fillsRow]] = await pool.query(
    'SELECT COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=?', HASH);
  // The full ledger, every status: this is what was ACTUALLY held (review P0.1).
  const [ledger] = await pool.query(
    'SELECT ticker, entry_date, exit_date, weight, units, cost_basis, proceeds, net_pct, status FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? ORDER BY entry_date', HASH);
  // The OBSERVED NAV, read back (review P0.3 residual). Writing a NAV that
  // nothing consumes is the same defect as printing a profit factor nobody
  // computes — the thing this whole review series is about. It is read here and
  // cross-checked against the reconstruction below; a divergence means the
  // ledger and the marks disagree and is reported rather than hidden.
  const [[navRow]] = await pool.query(
    `SELECT mark_date, total_nav, cash_value, market_value, realized_pnl, unrealized_pnl, gross_exposure, benchmark_nav
       FROM ft_strategy_nav WHERE strategy_id=? AND run_mode=? AND strategy_hash=? ORDER BY mark_date DESC LIMIT 1`,
    HASH);
  const [otherHashes] = await pool.query(
    `SELECT COALESCE(strategy_hash, '(none)') h, COUNT(*) n, MIN(entry_date) d0, MAX(entry_date) d1
       FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND (strategy_hash IS NULL OR strategy_hash <> ?)
      GROUP BY h ORDER BY n DESC`, HASH);

  // A v2 record must not contain weight-era rows. If the ledger version were
  // ever raised without the hash changing, units would read as 0 and every
  // position would look free — cash intact, market value nil (review P0.3).
  const unconverted = ledger.filter(r => r.units === null || r.cost_basis === null);

  const { port, bench, universe, regimes, avgTurnover } = periodReturns(ctx, logRows, ledger);
  const eq = fg.compound(port), beq = fg.compound(bench), ueq = fg.compound(universe);
  const portRet = eq.length ? eq[eq.length - 1] - 1 : null;
  const benchRet = beq.length ? beq[beq.length - 1] - 1 : null;
  const univRet = ueq.length ? ueq[ueq.length - 1] - 1 : null;
  const excess = (portRet !== null && benchRet !== null) ? portRet - benchRet : null;
  const excessUniverse = (portRet !== null && univRet !== null) ? portRet - univRet : null;

  const dates = logRows.map(r => toDateStr(r.as_of_date));
  const months = dates.length >= 2
    ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (1000 * 86400 * 30.44) : 0;

  const m = {
    rebalanceDecisions: logRows.length,
    calendarMonths: Math.round(months * 10) / 10,
    distinctRegimes: fg.distinctRegimes(regimes),
    fills: fillsRow.n,
    // From ACTUAL cash (review P1): (proceeds - cost_basis) / cost_basis. The
    // stored net_pct is grossPct minus the two fee percentages, which is only an
    // approximation — the buy fee reduces UNITS, so it does not subtract
    // linearly from the return. Falls back to net_pct only for rows with no
    // cost basis, which are pre-v2 and already flagged above.
    ledgerValid: unconverted.length === 0,
    profitFactor: fg.profitFactor(closedRows.map(r => (
      Number(r.cost_basis) > 0
        ? ((Number(r.proceeds || 0) - Number(r.cost_basis)) / Number(r.cost_basis)) * 100
        : r.net_pct))),
    excessReturn: excessUniverse,          // PRIMARY: vs the set names were chosen from
    excessVsIndex: excess,                 // secondary, reported not gated
  };

  // Both are fractions of the same notional book of 1.0, so they are directly
  // comparable. They are NOT expected to match exactly — the report compounds
  // period returns while the mark is additive over entry weights — but a large
  // gap means something is wrong with one of them.
  // Compared at the SAME bar (review P1.2). The observed mark is whatever date
  // `mark` last ran on, while the reconstruction ends at the last execution bar
  // that had a following period. If the market moved between the two, the gap
  // reported a disagreement that was only a difference of dates. The
  // reconstruction is now extended to the mark's own date before comparing, and
  // both dates are printed.
  const observedNav = navRow && navRow.total_nav !== null ? Number(navRow.total_nav) : null;
  const navDate = navRow ? toDateStr(navRow.mark_date) : null;
  // Same date AND the same price function. cmdMark values holdings with
  // exec.markPrice (close-preferring); navAt goes through barPrice, which
  // prefers the OPEN. On a day the market gaps and fades, those differ by the
  // whole intraday move, so the two NAVs disagreed for a reason that had nothing
  // to do with the ledger (review P1.2 residual).
  const reconstructedNav = navDate && ctx.dateIdx.has(navDate)
    ? navAt(ledger, ctx.series, ctx.dateIdx.get(navDate), navDate, exec.markPrice)
    : (portRet === null ? null : 1 + portRet);
  const navGap = (observedNav !== null && reconstructedNav !== null) ? observedNav - reconstructedNav : null;

  return {
    runMode, logRows, openRows, closedRows, m, otherHashes, unconverted,
    navRow, observedNav, reconstructedNav, navGap,
    liveStart: dates[0] || null, liveEnd: dates[dates.length - 1] || null,
    portRet, benchRet, univRet, excess, excessUniverse,
    infoRatio: fg.informationRatio(port, universe, REBAL_BARS),
    infoRatioIndex: fg.informationRatio(port, bench, REBAL_BARS),
    maxDD: eq.length ? fg.maxDrawdown(eq) : null,
    avgTurnover, periods: port.length,
  };
}

function printReport(r, ctx) {
  const { tradingDates, series } = ctx;
  const lastI = tradingDates.length - 1;
  const line = '─'.repeat(78);

  console.log(`\n${line}`);
  console.log(`${STRATEGY_ID}   run_mode=${r.runMode}   strategy_hash=${STRATEGY_HASH}   commit=${CODE_COMMIT || 'unknown'}`);
  console.log(line);

  if (r.unconverted && r.unconverted.length) {
    console.log(`** ${r.unconverted.length} position(s) under this hash have no units/cost_basis.`);
    console.log('   They predate the self-financing ledger and would read as costing nothing.');
    console.log('   Every figure below is unreliable until they are removed or re-recorded.\n');
  }

  if (r.otherHashes && r.otherHashes.length) {
    console.log('Records under a DIFFERENT configuration exist and are excluded (review P0.4):');
    for (const o of r.otherHashes) {
      console.log(`  strategy_hash ${o.h}   ${o.n} position(s)   ${o.d0 ? toDateStr(o.d0) : '?'} .. ${o.d1 ? toDateStr(o.d1) : '?'}`);
    }
    console.log('  They are a different strategy and must not be pooled with this one.');
    console.log('');
  }

  if (!r.logRows.length) {
    console.log(`No ${r.runMode} decisions recorded yet — every statistic below would be undefined, so none are shown.`);
    if (r.runMode === 'LIVE') {
      console.log('This is the correct and expected state: the forward test has not yet made a live decision.');
    }
    return;
  }

  console.log(`Period                  ${r.liveStart} .. ${r.liveEnd}   (${r.m.calendarMonths} months)`);
  console.log(`Rebalance decisions     ${r.m.rebalanceDecisions}   (independent observations — NOT position count)`);
  console.log(`Fills                   ${r.m.fills}   positions opened across those decisions`);
  console.log(`Closed positions        ${r.closedRows.length}   open now ${r.openRows.length}`);
  console.log(`Distinct regimes        ${r.m.distinctRegimes}`);
  console.log('');
  console.log(`Portfolio return        ${pct(r.portRet)}   over ${r.periods} holding period(s), net of costs`);
  console.log(`Eligible universe       ${pct(r.univRet)}   PRIMARY benchmark — the set these names were chosen from`);
  console.log(`Excess vs universe      ${pct(r.excessUniverse)}   <- this is what the gate reads`);
  console.log(`Benchmark (IHSG)        ${pct(r.benchRet)}   secondary`);
  console.log(`Excess vs IHSG          ${pct(r.excess)}`);
  console.log(`Information ratio       ${num(r.infoRatio)}   vs universe (annualised; null when <2 periods or no dispersion)`);
  console.log(`Maximum drawdown        ${r.maxDD === null ? 'n/a' : (r.maxDD * 100).toFixed(2) + '%'}`);
  console.log(`Average turnover        ${(r.avgTurnover * 100).toFixed(1)}% of the book per rebalance`);
  console.log(`Profit factor           ${num(r.m.profitFactor)}   (gross profit / gross loss, net %)`);
  if (r.navRow) {
    console.log('');
    const on = toDateStr(r.navRow.mark_date);
    console.log(`Observed NAV            ${num(r.observedNav, 4)}   marked ${on} — cash ${num(r.navRow.cash_value, 4)} + market ${num(r.navRow.market_value, 4)}`);
    console.log(`Reconstructed NAV       ${num(r.reconstructedNav, 4)}   rebuilt from the ledger on the SAME date, ${on}`);
    if (r.navGap !== null && Math.abs(r.navGap) > 0.02) {
      console.log(`  ** the two disagree by ${(r.navGap * 100).toFixed(2)} pp — the ledger and the marks are telling different stories`);
    }
  } else {
    console.log('Observed NAV            none recorded yet — run `mark`');
  }

  if (r.openRows.length) {
    console.log('\nOPEN positions');
    let mtm = 0;
    for (const p of r.openRows) {
      const s = series.get(p.ticker);
      const px = s ? s.close[lastI] : null;
      const entry = Number(p.entry_price);
      const g = px > 0 ? ((px - entry) / entry) * 100 : null;
      if (g !== null) mtm += g * Number(p.weight);
      console.log(`  ${p.ticker.padEnd(6)} entry ${toDateStr(p.entry_date)} @ ${entry}   now ${px ?? 'n/a'}   ${g === null ? 'n/a' : (g >= 0 ? '+' : '') + g.toFixed(2) + '%'}`);
    }
    console.log(`  weighted mark-to-market: ${mtm >= 0 ? '+' : ''}${mtm.toFixed(2)}% (gross, unrealised)`);
  }
}

function printGate(liveReport, replayDecisions) {
  const g = fg.evaluateForwardGate({ ...liveReport.m, replayDecisions });
  console.log(`\n${'─'.repeat(78)}`);
  console.log(`PROMOTION GATE   →   ${g.status}`);
  console.log('─'.repeat(78));
  for (const c of g.criteria) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    const actual = c.name.includes('return') ? pct(c.actual) : num(c.actual, c.actual === Infinity ? 0 : 2);
    console.log(`  ${mark}  ${c.name.padEnd(42)} ${String(actual).padStart(8)}  (need ${c.name.includes('return') ? '>' : '>='} ${c.required})`);
  }
  if (replayDecisions > 0) {
    console.log(`\n  ${replayDecisions} REPLAY decision(s) exist and are excluded from every number above.`);
    console.log('  Replayed history is not forward performance and never clears this gate.');
  }
  console.log(`\n  ${g.note}`);
  console.log('  This records intentions only. No orders are placed anywhere.');
}

async function main() {
  const o = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  await setup(pool);
  const ctx = await loadSeries(pool);
  await backfillRegimeLabels(pool, ctx);

  if (o.status) {
    const live = await reportFor(pool, ctx, 'LIVE');
    printReport(live, ctx);
    const [[rc]] = await pool.query(
      'SELECT COUNT(*) n FROM ft_strategy_log WHERE strategy_id=? AND run_mode=?', [STRATEGY_ID, 'REPLAY']);
    if (o.includeReplay) {
      const replay = await reportFor(pool, ctx, 'REPLAY');
      printReport(replay, ctx);
      console.log('\n  ^ REPLAY. Decisions made with as-of data, but all recorded in one pass after the');
      console.log('    fact. It never faced a data outage, a missed fill, or a real execution. Diagnostic only.');
    }
    printGate(live, rc.n);
    await pool.end();
    return;
  }

  const lastI = ctx.tradingDates.length - 2;   // need an execution bar
  if (o.replay > 0) {
    const startI = Math.max(sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma, lastI - o.replay);
    console.log(`Replaying decisions from ${ctx.tradingDates[startI]} to ${ctx.tradingDates[lastI]} (every ${REBAL_BARS} bars)`);
    console.log('These are recorded as run_mode=REPLAY and are excluded from forward performance.\n');
    for (let i = startI; i <= lastI; i += REBAL_BARS) await decideFor(pool, ctx, i, false, 'REPLAY');
    const replay = await reportFor(pool, ctx, 'REPLAY');
    printReport(replay, ctx);
    await pool.end();
    return;
  }

  // LIFECYCLE (review P0.3). `plan` freezes the decision; `fill` executes any
  // plan whose execution bar has since landed; `mark` records the NAV.
  //
  // ORDER MATTERS in the daily run: fill BEFORE plan. Filling settles the
  // previous plan into real positions, so the new plan sees the true holdings.
  // Planning first would decide against a stale book.
  //
  // REBALANCE CADENCE IS OWNED BY THIS SCRIPT, NOT BY THE CRON SCHEDULE. The
  // frozen configuration rebalances every REBAL_BARS trading days. If the cadence
  // were left to however often cron fires, a weekly cron would silently run a
  // weekly-rebalance strategy -- a different strategy from the one EXP-017
  // tested, with different turnover and different costs. cmdPlan self-throttles,
  // so the schedule can be as frequent as you like without changing what is
  // being tested.
  if (o.cmd === 'fill') {
    await cmdFill(pool, ctx, false);
  } else if (o.cmd === 'plan') {
    const r = await cmdPlan(pool, ctx, false);
    if (r.skipped) console.log(r.skipped);
  } else if (o.cmd === 'mark') {
    await cmdMark(pool, ctx, false);
  } else {
    // Default: the whole daily cycle, in the only order that is correct.
    await cmdFill(pool, ctx, false);
    const r = await cmdPlan(pool, ctx, false);
    if (r.skipped) console.log(r.skipped);
    await cmdMark(pool, ctx, false);
  }
  await pool.end();
}

module.exports = { setup, loadSeries, reportFor, reclassifyBatchWrites, periodReturns, snapshotHash, cashAt, navAt, INITIAL_CAPITAL, cmdPlan, cmdFill, cmdMark, backfillRegimeLabels, STRATEGY_HASH, EFFECTIVE_CONFIG };

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
