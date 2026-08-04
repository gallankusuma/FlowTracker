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
const EFFECTIVE_CONFIG = { ...sb.DEFAULTS, ...PARAMS, rebalanceBars: REBAL_BARS, buyCost: BUY_COST, sellCost: SELL_COST, modelVersion: MODEL_VERSION };
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
      exit_date DATE NULL,
      exit_price DECIMAL(15,2) NULL,
      exit_reason VARCHAR(32) NULL,
      gross_pct DECIMAL(10,4) NULL,
      net_pct DECIMAL(10,4) NULL,
      status ENUM('OPEN','CLOSED') NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_open (strategy_id, ticker, entry_date),
      KEY idx_status (strategy_id, status)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      as_of_date DATE NOT NULL,
      exposure DECIMAL(4,2) NOT NULL,
      reason VARCHAR(128) NOT NULL,
      eligible INT NOT NULL,
      vetoed INT NOT NULL,
      n_target INT NOT NULL,
      opened INT NOT NULL DEFAULT 0,
      closed INT NOT NULL DEFAULT 0,
      target_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_day (strategy_id, as_of_date)
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
      eligible INT NOT NULL,
      vetoed INT NOT NULL,
      target_json TEXT NULL,
      reference_json TEXT NULL,
      status ENUM('PLANNED','PARTIALLY_FILLED','EXECUTED','EXPIRED') NOT NULL DEFAULT 'PLANNED',
      nofill_json TEXT NULL,
      executed_at DATETIME NULL,
      execution_date DATE NULL,
      UNIQUE KEY uq_plan (strategy_id, as_of_date),
      KEY idx_plan_status (strategy_id, run_mode, status)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_strategy_nav (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_id VARCHAR(64) NOT NULL,
      mark_date DATE NOT NULL,
      run_mode ENUM('LIVE','REPLAY','BACKFILL') NOT NULL DEFAULT 'LIVE',
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
      UNIQUE KEY uq_mark (strategy_id, mark_date, run_mode)
    )`);

  await migratePlanTable(pool);
  await migrateNavTable(pool);
  await migrateProvenance(pool);
}

/**
 * Bring an already-created ft_strategy_plan up to date: PARTIALLY_FILLED became
 * a real state and per-ticker no-fills are recorded (review P1.2).
 */
async function migrateNavTable(pool) {
  const cols = ['cash_value', 'market_value', 'total_nav', 'realized_pnl', 'unrealized_pnl', 'gross_exposure', 'benchmark_nav'];
  const missing = [];
  for (const c of cols) if (!(await hasColumn(pool, 'ft_strategy_nav', c))) missing.push(c);
  if (!missing.length) return;
  await pool.query(`ALTER TABLE ft_strategy_nav ${missing.map(c => `ADD COLUMN ${c} DECIMAL(16,6) NULL`).join(', ')}`);
  console.log(`MIGRATION: ft_strategy_nav gained ${missing.join(', ')} — it now stores a NAV, not just an unrealised percentage`);
}

async function migratePlanTable(pool) {
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
  const [batched] = await pool.query(
    `UPDATE ft_strategy_log SET run_mode='REPLAY'
      WHERE run_mode='LIVE' AND created_at IN (
        SELECT c FROM (
          SELECT created_at c FROM ft_strategy_log
           GROUP BY strategy_id, created_at HAVING COUNT(*) > 1
        ) batch)`);

  // A position belongs to the decision whose execution bar it was filled on.
  // If that decision is REPLAY, so is the position.
  const [orphans] = await pool.query(
    `UPDATE ft_strategy_positions p SET p.run_mode='REPLAY'
      WHERE p.run_mode='LIVE' AND EXISTS (
        SELECT 1 FROM ft_strategy_log l
         WHERE l.strategy_id = p.strategy_id AND l.run_mode='REPLAY'
           AND (l.as_of_date = p.decision_date
                OR (p.decision_date IS NULL AND p.entry_date BETWEEN l.as_of_date AND l.as_of_date + INTERVAL 5 DAY)))`);

  if (batched.affectedRows || orphans.affectedRows) {
    console.log(`PROVENANCE REPAIR: ${batched.affectedRows} log row(s) and ${orphans.affectedRows} position(s) were batch-written by a replay loop and are now marked REPLAY.`);
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
      dn0: new Array(n).fill(null), placed: 0, nConc: 0,
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
    s.dn0[i] = v; s.nConc++;
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
  let bars = 0, conc = 0;
  for (const s of ctx.series.values()) {
    for (let i = 0; i < s.close.length; i++) {
      if (s.close[i] !== null) bars++;
      if (s.dn0[i] !== null) conc++;
    }
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify({ lastDate: ctx.tradingDates[ctx.tradingDates.length - 1], n: ctx.tradingDates.length, tickers: ctx.series.size, bars, conc }))
    .digest('hex').slice(0, 16);
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
async function cmdPlan(pool, ctx, quiet) {
  const { tradingDates, series, ihsgClose, ihsgSma } = ctx;
  const i = tradingDates.length - 1;              // the latest COMPLETE bar
  const asOf = tradingDates[i];
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const [dup] = await pool.query(
    'SELECT id, status FROM ft_strategy_plan WHERE strategy_id=? AND as_of_date=?', [STRATEGY_ID, asOf]);
  if (dup.length) return { skipped: `plan for ${asOf} already exists (${dup[0].status}) — never recomputed` };

  const [last] = await pool.query(
    'SELECT MAX(as_of_date) d FROM ft_strategy_plan WHERE strategy_id=? AND run_mode=?', [STRATEGY_ID, 'LIVE']);
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
    'SELECT ticker FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=?',
    [STRATEGY_ID, 'OPEN', 'LIVE']);

  const d = sb.targetBook({
    series, i, ihsgClose, ihsgSma, currentHoldings: openRows.map(r => r.ticker), opts: PARAMS,
  });

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
        exposure, reason, eligible, vetoed, target_json, reference_json, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'PLANNED')`,
    [STRATEGY_ID, asOf, 'LIVE', nowSql, snapshotHash(ctx), STRATEGY_HASH, CODE_COMMIT,
     d.exposure, d.reason, d.eligible, d.vetoedCount, JSON.stringify(d.target), JSON.stringify(reference)]);

  if (!quiet) {
    console.log(`PLAN  ${asOf}  ${d.reason}`);
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
async function cmdFill(pool, ctx, quiet) {
  const { tradingDates, dateIdx, series } = ctx;
  const nowSql = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const [plans] = await pool.query(
    `SELECT * FROM ft_strategy_plan WHERE strategy_id=? AND run_mode=? AND status IN ('PLANNED','PARTIALLY_FILLED') ORDER BY as_of_date`,
    [STRATEGY_ID, 'LIVE']);

  // Run-level totals for the console line only. The PER-PLAN counters live
  // inside the loop: they used to be declared out here and written into every
  // plan's ft_strategy_log row, so with two pending plans the second row got
  // the first plan's activity added to its own (review P1.3).
  let executed = 0, partial = 0, waiting = 0;
  let totOpened = 0, totClosed = 0, totMissed = 0;
  let shortfallSum = 0, shortfallN = 0;

  for (const p of plans) {
    const asOf = toDateStr(p.as_of_date);
    const i = dateIdx.get(asOf);
    if (i === undefined) continue;
    const execI = i + 1;
    if (execI >= tradingDates.length) { waiting++; continue; }   // genuinely not knowable yet

    const target = JSON.parse(p.target_json || '[]');
    const reference = JSON.parse(p.reference_json || '{}');
    const tset = new Set(target);
    const exposure = Number(p.exposure);

    // One transaction per plan, so a crash cannot leave a plan half-executed
    // with its status already advanced (review P1.3). The work was already
    // idempotent enough to be re-runnable, but the sell-done/buy-not-done
    // window could still corrupt a NAV mark taken in between.
    const conn = await pool.getConnection();
    let opened = 0, closed = 0;
    const noFill = { buy: [], sell: [] };
    try {
      await conn.beginTransaction();

      const [openRows] = await conn.query(
        'SELECT ticker, entry_price, entry_date, weight FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=?',
        [STRATEGY_ID, 'OPEN', 'LIVE']);

      const stranded = [];      // wanted out, could not get out
      for (const row of openRows) {
        if (tset.has(row.ticker)) continue;
        const px = exec.sellFill(series.get(row.ticker), execI);
        if (px === null) { noFill.sell.push(row.ticker); stranded.push(row); continue; }
        const entry = Number(row.entry_price);
        const gross = ((px - entry) / entry) * 100;
        await conn.query(
          `UPDATE ft_strategy_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?,
                  gross_pct=?, net_pct=?, execution_observed_at=?
            WHERE strategy_id=? AND ticker=? AND entry_date=? AND status='OPEN' AND run_mode=?`,
          [tradingDates[execI], px, exposure === 0 ? 'REGIME_FLAT' : 'REBALANCE',
           gross.toFixed(4), (gross - (BUY_COST + SELL_COST) * 100).toFixed(4), nowSql,
           STRATEGY_ID, row.ticker, toDateStr(row.entry_date), 'LIVE']);
        closed++;
      }

      const retained = openRows.filter(r => tset.has(r.ticker));
      const heldNow = new Set(retained.map(r => r.ticker));

      // CAPACITY BEFORE SIZE (review P0.2). New positions used to be sized at
      // 1/target.length regardless of what was already committed, so a failed
      // sell left capital tied up AND the replacement was bought at full
      // weight: 8 targets plus 2 stranded names is 10 positions at 1/8 each,
      // 125% of the book. Nothing anywhere corrected it.
      //
      // The reviewer attributed this to `heldNow`, which is wrong -- a stranded
      // name is by definition absent from `target`, so the buy loop could never
      // have touched it and fixing `heldNow` would change nothing. The defect
      // is the DENOMINATOR: it has to be the capacity that is actually free.
      const committed = [...retained, ...stranded]
        .reduce((s, r) => s + Number(r.weight || 0), 0);
      const toBuy = target.filter(t => !heldNow.has(t));
      const capacity = Math.max(0, 1 - committed);
      const perName = toBuy.length ? capacity / toBuy.length : 0;

      for (const t of toBuy) {
        if (!(perName > 0)) { noFill.buy.push(t); continue; }   // no capacity left
        const px = exec.buyFill(series.get(t), execI);
        if (px === null) { noFill.buy.push(t); continue; }
        // Implementation shortfall: what the decision saw vs what it paid.
        if (reference[t] > 0) { shortfallSum += (px - reference[t]) / reference[t]; shortfallN++; }
        await conn.query(
          `INSERT IGNORE INTO ft_strategy_positions
             (strategy_id, ticker, entry_date, entry_price, weight,
              run_mode, decision_date, decision_created_at, data_available_at, execution_observed_at,
              strategy_hash, code_commit)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [STRATEGY_ID, t, tradingDates[execI], px, perName.toFixed(5),
           'LIVE', asOf, p.generated_at, p.generated_at, nowSql, STRATEGY_HASH, CODE_COMMIT]);
        opened++;
      }

      await conn.query(
        `INSERT IGNORE INTO ft_strategy_log
           (strategy_id, as_of_date, exposure, reason, eligible, vetoed, n_target, opened, closed, target_json,
            run_mode, decision_created_at, data_available_at, strategy_hash, code_commit)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [STRATEGY_ID, asOf, exposure, p.reason, p.eligible, p.vetoed, target.length, opened, closed,
         p.target_json, 'LIVE', p.generated_at, p.generated_at, STRATEGY_HASH, CODE_COMMIT]);

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
async function cmdMark(pool, ctx, quiet) {
  const { tradingDates, series, ihsgClose, dateIdx } = ctx;
  const i = tradingDates.length - 1;

  const [openRows] = await pool.query(
    'SELECT ticker, entry_price, weight FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=?',
    [STRATEGY_ID, 'OPEN', 'LIVE']);
  const [[realizedRow]] = await pool.query(
    `SELECT COALESCE(SUM(weight * net_pct / 100), 0) r FROM ft_strategy_positions
      WHERE strategy_id=? AND status='CLOSED' AND run_mode='LIVE'`, [STRATEGY_ID]);
  const [[firstRow]] = await pool.query(
    `SELECT MIN(as_of_date) d FROM ft_strategy_log WHERE strategy_id=? AND run_mode='LIVE'`, [STRATEGY_ID]);

  let grossExposure = 0, marketValue = 0;
  const unmarkable = [];
  for (const p of openRows) {
    const w = Number(p.weight);
    grossExposure += w;
    const px = exec.markPrice(series.get(p.ticker), i);
    if (px === null) { unmarkable.push(p.ticker); marketValue += w; continue; }  // carried at cost, and named
    marketValue += w * (px / Number(p.entry_price));
  }
  const realized = Number(realizedRow.r) || 0;
  const unrealized = marketValue - grossExposure;
  const cash = 1 - grossExposure + realized;
  const nav = cash + marketValue;

  // Benchmark on the same base, so the two curves are directly comparable.
  let benchNav = null;
  if (firstRow.d) {
    const j = dateIdx.get(toDateStr(firstRow.d));
    if (j !== undefined && ihsgClose[j] > 0) benchNav = ihsgClose[i] / ihsgClose[j];
  }

  await pool.query(
    `INSERT INTO ft_strategy_nav
       (strategy_id, mark_date, run_mode, open_positions, unrealised_pct, unmarkable,
        cash_value, market_value, total_nav, realized_pnl, unrealized_pnl, gross_exposure, benchmark_nav)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE open_positions=VALUES(open_positions), unrealised_pct=VALUES(unrealised_pct),
       unmarkable=VALUES(unmarkable), cash_value=VALUES(cash_value), market_value=VALUES(market_value),
       total_nav=VALUES(total_nav), realized_pnl=VALUES(realized_pnl), unrealized_pnl=VALUES(unrealized_pnl),
       gross_exposure=VALUES(gross_exposure), benchmark_nav=VALUES(benchmark_nav)`,
    [STRATEGY_ID, tradingDates[i], 'LIVE', openRows.length, (unrealized * 100).toFixed(4),
     unmarkable.join(',') || null, cash.toFixed(6), marketValue.toFixed(6), nav.toFixed(6),
     realized.toFixed(6), unrealized.toFixed(6), grossExposure.toFixed(6), benchNav === null ? null : benchNav.toFixed(6)]);

  if (!quiet) {
    console.log(`MARK  ${tradingDates[i]}   NAV ${nav.toFixed(4)}   (cash ${cash.toFixed(4)} + market ${marketValue.toFixed(4)})`);
    console.log(`      ${openRows.length} open, exposure ${(grossExposure * 100).toFixed(1)}%   realized ${(realized * 100).toFixed(2)}%   unrealized ${(unrealized * 100).toFixed(2)}%`);
    if (benchNav !== null) console.log(`      IHSG on the same base: ${benchNav.toFixed(4)}`);
    if (unmarkable.length) console.log(`      carried at cost, no price found: ${unmarkable.join(', ')}`);
  }
  return { nav, cash, marketValue, realized, unrealized, grossExposure, benchNav, openPositions: openRows.length, unmarkable };
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
    'SELECT ticker, entry_price, entry_date FROM ft_strategy_positions WHERE strategy_id=? AND status=? AND run_mode=?',
    [STRATEGY_ID, 'OPEN', runMode]);
  const holdings = openRows.map(r => r.ticker);

  const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: holdings, opts: PARAMS });
  const tset = new Set(d.target);

  let closed = 0, opened = 0;
  for (const row of openRows) {
    if (tset.has(row.ticker)) continue;
    const s = series.get(row.ticker);
    const px = s ? s.open[execI] : null;
    if (!(px > 0)) continue;
    const entry = Number(row.entry_price);
    const gross = ((px - entry) / entry) * 100;
    const net = gross - (BUY_COST + SELL_COST) * 100;
    await pool.query(
      `UPDATE ft_strategy_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, gross_pct=?, net_pct=?,
              execution_observed_at=?
        WHERE strategy_id=? AND ticker=? AND entry_date=? AND status='OPEN' AND run_mode=?`,
      [tradingDates[execI], px, d.exposure === 0 ? 'REGIME_FLAT' : 'REBALANCE',
       gross.toFixed(4), net.toFixed(4), nowSql, STRATEGY_ID, row.ticker, toDateStr(row.entry_date), runMode]);
    closed++;
  }

  const heldNow = new Set(openRows.filter(r => tset.has(r.ticker)).map(r => r.ticker));
  for (const t of d.target) {
    if (heldNow.has(t)) continue;
    const s = series.get(t);
    const px = s ? s.open[execI] : null;
    if (!(px > 0)) continue;
    await pool.query(
      `INSERT IGNORE INTO ft_strategy_positions
         (strategy_id, ticker, entry_date, entry_price, weight,
          run_mode, decision_date, decision_created_at, data_available_at, strategy_hash, code_commit)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [STRATEGY_ID, t, tradingDates[execI], px, (1 / d.target.length).toFixed(5),
       runMode, asOf, nowSql, nowSql, STRATEGY_HASH, CODE_COMMIT]);
    opened++;
  }

  await pool.query(
    `INSERT IGNORE INTO ft_strategy_log
       (strategy_id, as_of_date, exposure, reason, eligible, vetoed, n_target, opened, closed, target_json,
        run_mode, decision_created_at, data_available_at, strategy_hash, code_commit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [STRATEGY_ID, asOf, d.exposure, d.reason, d.eligible, d.vetoedCount, d.target.length, opened, closed,
     JSON.stringify(d.target), runMode, nowSql, nowSql, STRATEGY_HASH, CODE_COMMIT]);

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
  const port = [], bench = [], universe = [], regimes = [];
  let turnoverTotal = 0;

  for (let k = 0; k < logRows.length - 1; k++) {
    const a = logRows[k], b = logRows[k + 1];
    const ia = dateIdx.get(toDateStr(a.as_of_date)), ib = dateIdx.get(toDateStr(b.as_of_date));
    if (ia === undefined || ib === undefined) continue;
    const execA = ia + 1, execB = ib + 1;
    if (execB >= tradingDates.length) continue;
    const dA = tradingDates[execA], dB = tradingDates[execB];

    // Held across the window means: entered on or before it opened, and not yet
    // exited when it opened. Nothing here consults the plan.
    let gross = 0, held = 0;
    for (const h of positionRows) {
      const entry = toDateStr(h.entry_date);
      const exit = h.exit_date ? toDateStr(h.exit_date) : null;
      if (entry > dA) continue;
      if (exit && exit <= dA) continue;
      const s = series.get(h.ticker);
      const p0 = barPrice(s, execA);
      // A name that stops printing is marked at its last real close, not dropped.
      const p1 = (exit && exit < dB) ? barPrice(s, dateIdx.get(exit) ?? execB) : barPrice(s, execB);
      if (!(p0 > 0) || !(p1 > 0)) continue;
      const w = Number(h.weight || 0);
      gross += w * (p1 / p0 - 1);
      held += w;
    }

    // Costs from the events that actually happened at this period's boundary,
    // not from a diff of two planned books. The old churn term also went to
    // zero at exactly the transitions this strategy makes most — re-entering
    // from REGIME_FLAT was free, because the previous book was empty.
    let cost = 0, turnover = 0;
    for (const h of positionRows) {
      const w = Number(h.weight || 0);
      if (toDateStr(h.entry_date) === dB) { cost += w * BUY_COST; turnover += w; }
      if (h.exit_date && toDateStr(h.exit_date) === dB) { cost += w * SELL_COST; turnover += w; }
    }
    turnoverTotal += turnover;

    // PRIMARY BENCHMARK: the point-in-time eligible universe, equal-weighted
    // (review P0.5). IHSG alone is the wrong bar to clear -- this strategy has
    // already screened for liquidity, price-history depth and broker coverage,
    // so beating IHSG can come entirely from the SCREEN while the SELECTION adds
    // nothing. Measuring against the set the names were chosen FROM is what
    // isolates the choice. Reported alongside IHSG, not instead of it.
    const elig = sb.crossSection(series, ia, PARAMS);
    const eligRets = [];
    for (const r of elig) {
      const s2 = series.get(r.ticker);
      const q0 = barPrice(s2, execA), q1 = barPrice(s2, execB);
      if (!(q0 > 0) || !(q1 > 0)) continue;
      eligRets.push(q1 / q0 - 1);
    }
    universe.push(eligRets.length ? eligRets.reduce((x, y) => x + y, 0) / eligRets.length : 0);

    // No `* exposure` factor: standing flat already produces 0 because no rows
    // are open. Multiplying would have zeroed a retained no-fill position during
    // a REGIME_FLAT period, hiding exactly the exposure we failed to shed.
    port.push(gross - cost);
    bench.push(ihsgClose[execB] / ihsgClose[execA] - 1);
    regimes.push(String(a.regime_label || a.reason || '').split(' ')[0]);
  }
  return { port, bench, universe, regimes, avgTurnover: port.length ? turnoverTotal / port.length : 0 };
}

async function reportFor(pool, ctx, runMode) {
  // EVERY QUERY IS SCOPED TO THE CURRENT strategy_hash (review P0.4). The code
  // comments have always insisted records from different configurations must
  // not be pooled; nothing enforced it, because reportFor filtered on
  // strategy_id and run_mode only. Rows written under an older configuration
  // are not silently dropped — `otherHashes` below reports them, so an empty
  // record reads as "the configuration changed" rather than "nothing happened".
  const HASH = [STRATEGY_ID, runMode, STRATEGY_HASH];
  const [logRows] = await pool.query(
    'SELECT as_of_date, exposure, reason, target_json, opened, closed FROM ft_strategy_log WHERE strategy_id=? AND run_mode=? AND strategy_hash=? ORDER BY as_of_date', HASH);
  const [closedRows] = await pool.query(
    "SELECT net_pct, exit_date FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? AND status='CLOSED'", HASH);
  const [openRows] = await pool.query(
    "SELECT ticker, entry_date, entry_price, weight FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? AND status='OPEN' ORDER BY entry_date", HASH);
  const [[fillsRow]] = await pool.query(
    'SELECT COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=?', HASH);
  // The full ledger, every status: this is what was ACTUALLY held (review P0.1).
  const [ledger] = await pool.query(
    'SELECT ticker, entry_date, exit_date, weight, net_pct, status FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND strategy_hash=? ORDER BY entry_date', HASH);
  const [otherHashes] = await pool.query(
    `SELECT COALESCE(strategy_hash, '(none)') h, COUNT(*) n, MIN(entry_date) d0, MAX(entry_date) d1
       FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND (strategy_hash IS NULL OR strategy_hash <> ?)
      GROUP BY h ORDER BY n DESC`, HASH);

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
    profitFactor: fg.profitFactor(closedRows.map(r => r.net_pct)),
    excessReturn: excessUniverse,          // PRIMARY: vs the set names were chosen from
    excessVsIndex: excess,                 // secondary, reported not gated
  };

  return {
    runMode, logRows, openRows, closedRows, m, otherHashes,
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

module.exports = { periodReturns, snapshotHash, cmdPlan, cmdFill, cmdMark, STRATEGY_HASH };

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
