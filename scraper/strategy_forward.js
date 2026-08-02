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
 * the same module verify_strategy_book.js replays history through. That is
 * deliberate: `awo_paper_trades` broke silently precisely because the live path
 * and the tested path were separate implementations.
 *
 * NOT A TRADING SYSTEM. It writes intentions to a table. It places no orders and
 * touches no broker. Execution stays manual by design — IDX retail brokers have
 * no public order API, and the strategy has not earned automation.
 *
 * Idempotent: running twice for the same date changes nothing.
 *
 * Usage:
 *   node strategy_forward.js                 # decide for the latest data date
 *   node strategy_forward.js --date 2026-07-30
 *   node strategy_forward.js --replay 60     # seed history: last 60 trading days
 *   node strategy_forward.js --status        # show the current book and P&L
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const sb = require('./modules/strategy_book');

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

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { date: null, replay: 0, status: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--date') o.date = a[++i];
    else if (a[i] === '--replay') o.replay = Number(a[++i]);
    else if (a[i] === '--status') o.status = true;
  }
  return o;
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
 */
async function decideFor(pool, ctx, i, quiet) {
  const { tradingDates, series, ihsgClose, ihsgSma } = ctx;
  const asOf = tradingDates[i];
  const execI = i + 1;
  if (execI >= tradingDates.length) return { skipped: 'no execution bar yet' };

  const [dup] = await pool.query('SELECT id FROM ft_strategy_log WHERE strategy_id=? AND as_of_date=?', [STRATEGY_ID, asOf]);
  if (dup.length) return { skipped: 'already recorded' };

  const [openRows] = await pool.query(
    'SELECT ticker, entry_price, entry_date FROM ft_strategy_positions WHERE strategy_id=? AND status=?',
    [STRATEGY_ID, 'OPEN']);
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
      `UPDATE ft_strategy_positions SET status='CLOSED', exit_date=?, exit_price=?, exit_reason=?, gross_pct=?, net_pct=?
        WHERE strategy_id=? AND ticker=? AND entry_date=? AND status='OPEN'`,
      [tradingDates[execI], px, d.exposure === 0 ? 'REGIME_FLAT' : 'REBALANCE',
       gross.toFixed(4), net.toFixed(4), STRATEGY_ID, row.ticker, toDateStr(row.entry_date)]);
    closed++;
  }

  const heldNow = new Set(openRows.filter(r => tset.has(r.ticker)).map(r => r.ticker));
  for (const t of d.target) {
    if (heldNow.has(t)) continue;
    const s = series.get(t);
    const px = s ? s.open[execI] : null;
    if (!(px > 0)) continue;
    await pool.query(
      `INSERT IGNORE INTO ft_strategy_positions (strategy_id, ticker, entry_date, entry_price, weight)
       VALUES (?,?,?,?,?)`,
      [STRATEGY_ID, t, tradingDates[execI], px, (1 / d.target.length).toFixed(5)]);
    opened++;
  }

  await pool.query(
    `INSERT IGNORE INTO ft_strategy_log (strategy_id, as_of_date, exposure, reason, eligible, vetoed, n_target, opened, closed, target_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [STRATEGY_ID, asOf, d.exposure, d.reason, d.eligible, d.vetoedCount, d.target.length, opened, closed, JSON.stringify(d.target)]);

  if (!quiet) {
    console.log(`${asOf}  ${d.reason}`);
    console.log(`  eligible ${d.eligible}, vetoed ${d.vetoedCount} | opened ${opened}, closed ${closed}`);
    console.log(`  book: ${d.target.length ? d.target.join(', ') : '(flat)'}`);
  }
  return { asOf, opened, closed, exposure: d.exposure, target: d.target };
}

async function showStatus(pool, ctx) {
  const { tradingDates, series } = ctx;
  const lastI = tradingDates.length - 1;
  const [open] = await pool.query(
    'SELECT ticker, entry_date, entry_price, weight FROM ft_strategy_positions WHERE strategy_id=? AND status=? ORDER BY entry_date',
    [STRATEGY_ID, 'OPEN']);
  const [closed] = await pool.query(
    'SELECT COUNT(*) n, AVG(net_pct) avg_net, SUM(net_pct>0) wins, MIN(exit_date) first_exit FROM ft_strategy_positions WHERE strategy_id=? AND status=?',
    [STRATEGY_ID, 'CLOSED']);
  const [log] = await pool.query(
    'SELECT COUNT(*) days, SUM(exposure=0) flat_days, MIN(as_of_date) since FROM ft_strategy_log WHERE strategy_id=?', [STRATEGY_ID]);

  console.log(`\n=== ${STRATEGY_ID} ===`);
  const L = log[0];
  console.log(`Decision days recorded: ${L.days}   flat (stood aside): ${L.flat_days}   since ${L.since ? toDateStr(L.since) : 'n/a'}`);

  console.log(`\nOPEN positions: ${open.length}`);
  let mtm = 0;
  for (const p of open) {
    const s = series.get(p.ticker);
    const px = s ? s.close[lastI] : null;
    const entry = Number(p.entry_price);
    const g = px > 0 ? ((px - entry) / entry) * 100 : null;
    if (g !== null) mtm += g * Number(p.weight);
    console.log(`  ${p.ticker.padEnd(6)} entry ${toDateStr(p.entry_date)} @ ${entry}   now ${px ?? 'n/a'}   ${g === null ? 'n/a' : (g >= 0 ? '+' : '') + g.toFixed(2) + '%'}`);
  }
  if (open.length) console.log(`  weighted mark-to-market: ${mtm >= 0 ? '+' : ''}${mtm.toFixed(2)}% (gross, unrealised)`);

  const C = closed[0];
  console.log(`\nCLOSED trades: ${C.n || 0}`);
  if (C.n > 0) {
    console.log(`  avg net ${Number(C.avg_net).toFixed(2)}%   win rate ${((C.wins / C.n) * 100).toFixed(1)}%`);
  }
  console.log(`\nPromotion bar (mirrors the AWO gates): >=30 closed trades, >=20 calendar days,`);
  console.log(`positive average net, profit factor >=1.10. Currently ${C.n || 0}/30 trades.`);
  console.log('This records intentions only. No orders are placed anywhere.');
}

async function main() {
  const o = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  await setup(pool);
  const ctx = await loadSeries(pool);

  if (o.status) { await showStatus(pool, ctx); await pool.end(); return; }

  const lastI = ctx.tradingDates.length - 2;   // need an execution bar
  if (o.replay > 0) {
    // Seed a track record from recent history using ONLY as-of data, so the
    // forward test starts with something to look at. These rows are marked by
    // their as_of_date and are honest walk-forward decisions, not a backtest.
    const startI = Math.max(sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma, lastI - o.replay);
    console.log(`Replaying decisions from ${ctx.tradingDates[startI]} to ${ctx.tradingDates[lastI]} (every ${REBAL_BARS} bars)\n`);
    for (let i = startI; i <= lastI; i += REBAL_BARS) await decideFor(pool, ctx, i, false);
    await showStatus(pool, ctx);
    await pool.end();
    return;
  }

  const i = o.date ? ctx.dateIdx.get(o.date) : lastI;
  if (i === undefined) { console.error(`Date ${o.date} is not a trading date on the IHSG axis`); process.exit(1); }
  const r = await decideFor(pool, ctx, i, false);
  if (r.skipped) console.log(`${ctx.tradingDates[i]}: ${r.skipped}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
