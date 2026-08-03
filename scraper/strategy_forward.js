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
 *   node strategy_forward.js                    # decide for the latest data date (LIVE)
 *   node strategy_forward.js --date 2026-07-30
 *   node strategy_forward.js --replay 60        # seed history, recorded as REPLAY
 *   node strategy_forward.js --status           # full report, LIVE only
 *   node strategy_forward.js --status --include-replay   # both, reported separately
 */
'use strict';
require('dotenv').config();

const crypto = require('crypto');
const { execSync } = require('child_process');
const mysql = require('mysql2/promise');
const sb = require('./modules/strategy_book');
const fg = require('./modules/forward_gate');

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

/**
 * Identity of the exact strategy configuration a row was produced by. If any
 * of this changes, rows written before and after are not the same track record
 * and must not be pooled — the same lesson candidateKeyFromWeights encodes for
 * the AWO paper trader.
 */
const STRATEGY_HASH = crypto.createHash('sha256')
  .update(JSON.stringify({ id: STRATEGY_ID, rebal: REBAL_BARS, params: PARAMS, buy: BUY_COST, sell: SELL_COST }))
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
  const o = { date: null, replay: 0, status: false, includeReplay: false };
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

  await migrateProvenance(pool);
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
  for (const [t, s] of series) if (s.placed < 400 || s.nConc < 200) series.delete(t);
  return { tradingDates, dateIdx, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series };
}

/**
 * Decide and record for one date. Entry/exit price is the NEXT bar's open,
 * matching the backtest's T+1 execution convention exactly.
 *
 * @param {'LIVE'|'REPLAY'} runMode - stamped on every row this writes. REPLAY
 *   rows are excluded from every forward statistic; see migrateProvenance.
 */
async function decideFor(pool, ctx, i, quiet, runMode) {
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
function periodReturns(ctx, logRows) {
  const { dateIdx, tradingDates, series, ihsgClose } = ctx;
  const port = [], bench = [], regimes = [];
  let turnoverTotal = 0;

  for (let k = 0; k < logRows.length - 1; k++) {
    const a = logRows[k], b = logRows[k + 1];
    const ia = dateIdx.get(toDateStr(a.as_of_date)), ib = dateIdx.get(toDateStr(b.as_of_date));
    if (ia === undefined || ib === undefined) continue;
    const execA = ia + 1, execB = ib + 1;
    if (execB >= tradingDates.length) continue;

    let book = [];
    try { book = JSON.parse(a.target_json || '[]'); } catch { book = []; }
    const exposure = Number(a.exposure);

    // Held names are priced open-to-open across the holding period, matching
    // how entries and exits are actually recorded. Cash earns nothing.
    const rets = [];
    for (const t of book) {
      const s = series.get(t);
      if (!s) continue;
      const p0 = s.open[execA], p1 = s.open[execB];
      if (!(p0 > 0) || !(p1 > 0)) continue;
      rets.push(p1 / p0 - 1);
    }
    const gross = rets.length ? rets.reduce((x, y) => x + y, 0) / rets.length : 0;

    const nextBook = (() => { try { return JSON.parse(b.target_json || '[]'); } catch { return []; } })();
    const churn = book.length ? nextBook.filter(t => !book.includes(t)).length / Math.max(book.length, 1) : 0;
    turnoverTotal += churn;
    const cost = churn * (BUY_COST + SELL_COST);

    port.push(gross * exposure - cost);
    bench.push(ihsgClose[execB] / ihsgClose[execA] - 1);
    regimes.push(String(a.reason || '').split(' ')[0]);
  }
  return { port, bench, regimes, avgTurnover: port.length ? turnoverTotal / port.length : 0 };
}

async function reportFor(pool, ctx, runMode) {
  const [logRows] = await pool.query(
    'SELECT as_of_date, exposure, reason, target_json, opened, closed FROM ft_strategy_log WHERE strategy_id=? AND run_mode=? ORDER BY as_of_date',
    [STRATEGY_ID, runMode]);
  const [closedRows] = await pool.query(
    'SELECT net_pct, exit_date FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND status=?',
    [STRATEGY_ID, runMode, 'CLOSED']);
  const [openRows] = await pool.query(
    'SELECT ticker, entry_date, entry_price, weight FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=? AND status=? ORDER BY entry_date',
    [STRATEGY_ID, runMode, 'OPEN']);
  const [[fillsRow]] = await pool.query(
    'SELECT COUNT(*) n FROM ft_strategy_positions WHERE strategy_id=? AND run_mode=?', [STRATEGY_ID, runMode]);

  const { port, bench, regimes, avgTurnover } = periodReturns(ctx, logRows);
  const eq = fg.compound(port), beq = fg.compound(bench);
  const portRet = eq.length ? eq[eq.length - 1] - 1 : null;
  const benchRet = beq.length ? beq[beq.length - 1] - 1 : null;
  const excess = (portRet !== null && benchRet !== null) ? portRet - benchRet : null;

  const dates = logRows.map(r => toDateStr(r.as_of_date));
  const months = dates.length >= 2
    ? (new Date(dates[dates.length - 1]) - new Date(dates[0])) / (1000 * 86400 * 30.44) : 0;

  const m = {
    rebalanceDecisions: logRows.length,
    calendarMonths: Math.round(months * 10) / 10,
    distinctRegimes: fg.distinctRegimes(regimes),
    fills: fillsRow.n,
    profitFactor: fg.profitFactor(closedRows.map(r => r.net_pct)),
    excessReturn: excess,
  };

  return {
    runMode, logRows, openRows, closedRows, m,
    liveStart: dates[0] || null, liveEnd: dates[dates.length - 1] || null,
    portRet, benchRet, excess,
    infoRatio: fg.informationRatio(port, bench, REBAL_BARS),
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
  console.log(`Benchmark (IHSG)        ${pct(r.benchRet)}`);
  console.log(`Excess return           ${pct(r.excess)}`);
  console.log(`Information ratio       ${num(r.infoRatio)}   (annualised; null when <2 periods or no dispersion)`);
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

  const i = o.date ? ctx.dateIdx.get(o.date) : lastI;
  if (i === undefined) { console.error(`Date ${o.date} is not a trading date on the IHSG axis`); process.exit(1); }

  // REBALANCE CADENCE IS OWNED BY THIS SCRIPT, NOT BY THE CRON SCHEDULE.
  // The frozen configuration rebalances every REBAL_BARS trading days. If the
  // cadence were left to however often cron happens to fire, a weekly cron would
  // silently run a weekly-rebalance strategy — a different strategy from the one
  // EXP-017 tested, with different turnover and different costs. Self-throttling
  // here means the schedule can be as frequent as you like (daily is best: a
  // failed run is simply retried tomorrow) without changing what is being tested.
  // An explicit --date overrides, for backfilling a specific decision.
  if (!o.date) {
    const [last] = await pool.query(
      'SELECT MAX(as_of_date) AS d FROM ft_strategy_log WHERE strategy_id=? AND run_mode=?', [STRATEGY_ID, 'LIVE']);
    if (last[0].d) {
      const lastIdx = ctx.dateIdx.get(toDateStr(last[0].d));
      if (lastIdx !== undefined) {
        const elapsed = i - lastIdx;
        if (elapsed < REBAL_BARS) {
          console.log(`${ctx.tradingDates[i]}: no decision due — ${elapsed}/${REBAL_BARS} trading days since ${toDateStr(last[0].d)}.`);
          console.log(`Next decision in ${REBAL_BARS - elapsed} trading day(s). Nothing written.`);
          await pool.end();
          return;
        }
      }
    }
  }

  const r = await decideFor(pool, ctx, i, false, 'LIVE');
  if (r.skipped) console.log(`${ctx.tradingDates[i]}: ${r.skipped}`);
  await pool.end();
}

module.exports = { periodReturns, STRATEGY_HASH };

if (require.main === module) {
  main().catch(e => { console.error('FATAL', e); process.exit(1); });
}
