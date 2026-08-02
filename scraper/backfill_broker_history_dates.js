/**
 * Backfill script: extend idx_broker_summary BACKWARDS in time.
 *
 * WHY THIS EXISTS (2026-08-02)
 * ----------------------------
 * The broker/bandarmology factors (F1, F2, F6, F7, F8) are the one edge genuinely
 * specific to this market — they are not in the global anomaly literature and not
 * arbitraged by foreign quants. They were also the least testable thing in the
 * project: idx_concentration only started 2026-01-19, so every AWO backtest above
 * EXP-010 was effectively a price-only model.
 *
 * Two separate gaps were found, and this script closes only the second:
 *   1. idx_broker_summary already held raw data back to 2025-06-02 that had never
 *      been turned into concentration — recovered for FREE by re-running
 *      /api/calc-concentration over those dates. No API calls.
 *   2. Index Alpha serves broker data back to roughly the start of 2024, which is
 *      earlier than any raw data we hold. That is what this script pulls.
 *
 * COST MODEL — why it is one call per ticker per DAY
 * --------------------------------------------------
 * The API's from/to parameters return a SUM over the range, not a per-day series
 * (verified 2026-08-02: BBCA broker ZP has buy_freq 2,527 for one day and 17,126
 * for the same week, and no row carries a date field). There is therefore no
 * range shortcut — a day of history costs one call per ticker.
 *
 * Scope is deliberately the liquid universe, not all 245 tickers: the tradeable
 * screen only ever passes ~100-120 names, and 245 x 328 days would exceed the
 * 100k monthly quota while buying history for names no strategy can trade.
 *
 * Resumable: skips any ticker+date already present. Safe to re-run.
 * Rate limits: exponential backoff on 429, and it stops rather than hammering.
 *
 * Usage:
 *   node backfill_broker_history_dates.js --from 2024-01-02 --to 2025-06-01 \
 *        [--min-adv 5e9] [--max-tickers 120] [--delay 250] [--budget 90000] [--dry-run]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const INDEX_ALPHA_KEY = process.env.INDEX_ALPHA_KEY;
const INDEX_ALPHA_BASE = 'https://api.indexalpha.id';
const MAX_CONSECUTIVE_FAILURES = 25;

const delay = ms => new Promise(r => setTimeout(r, ms));

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { from: null, to: null, minAdv: 5e9, maxTickers: 120, delayMs: 250, budget: 90000, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--from') out.from = a[++i];
    else if (a[i] === '--to') out.to = a[++i];
    else if (a[i] === '--min-adv') out.minAdv = Number(a[++i]);
    else if (a[i] === '--max-tickers') out.maxTickers = Number(a[++i]);
    else if (a[i] === '--delay') out.delayMs = Number(a[++i]);
    else if (a[i] === '--budget') out.budget = Number(a[++i]);
    else if (a[i] === '--dry-run') out.dryRun = true;
  }
  if (!out.from || !out.to) { console.error('--from and --to are required (YYYY-MM-DD)'); process.exit(1); }
  return out;
}

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

async function fetchBrokerSummary(ticker, date) {
  const url = `${INDEX_ALPHA_BASE}/stocks/broker-summary?ticker=${ticker}&from=${date}&to=${date}&investor=all`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${INDEX_ALPHA_KEY}`, Accept: 'application/json' },
  });
  if (resp.status === 429) throw new Error('RATE_LIMITED');
  if (!resp.ok) return null;                       // null = call failed
  const json = await resp.json();
  if (!json.success || !Array.isArray(json.data)) return [];  // [] = no data that day
  return json.data.map(b => ({
    brokerCode: b.code,
    buyVal: Math.round(b.buy_value || 0), buyLot: Math.round(b.buy_volume || 0), buyAvg: b.buy_avg || 0,
    sellVal: Math.round(b.sell_value || 0), sellLot: Math.round(b.sell_volume || 0), sellAvg: b.sell_avg || 0,
    netVal: Math.round((b.buy_value || 0) - (b.sell_value || 0)),
  }));
}

async function saveBrokerData(pool, date, ticker, rows) {
  if (!rows.length) return 0;
  const values = rows.map(r => [date, r.brokerCode, ticker, r.buyVal, r.buyLot, r.buyAvg, r.sellVal, r.sellLot, r.sellAvg, r.netVal]);
  const [res] = await pool.query(
    `INSERT INTO idx_broker_summary (date, broker_code, stock_code, buy_val, buy_lot, buy_avg, sell_val, sell_lot, sell_avg, net_val)
     VALUES ?
     ON DUPLICATE KEY UPDATE buy_val=VALUES(buy_val), buy_lot=VALUES(buy_lot), buy_avg=VALUES(buy_avg),
       sell_val=VALUES(sell_val), sell_lot=VALUES(sell_lot), sell_avg=VALUES(sell_avg), net_val=VALUES(net_val)`,
    [values]
  );
  return res.affectedRows;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  // Trading-date axis from IHSG — the same canonical calendar every backtest uses.
  const [dateRows] = await pool.query(
    'SELECT date FROM idx_ihsg_history WHERE date >= ? AND date <= ? ORDER BY date ASC',
    [opts.from, opts.to]
  );
  const dates = dateRows.map(r => toDateStr(r.date));

  // Liquid universe: rank by average daily traded value over the period being
  // backfilled, so the selection reflects what was liquid THEN, not only now.
  const [tickerRows] = await pool.query(
    `SELECT stock_code, AVG(value) AS adv
       FROM idx_stock_prices
      WHERE date >= ? AND date <= ?
      GROUP BY stock_code
     HAVING AVG(value) >= ?
      ORDER BY adv DESC
      LIMIT ?`,
    [opts.from, opts.to, opts.minAdv, opts.maxTickers]
  );
  const tickers = tickerRows.map(r => r.stock_code);

  // Skip work already done.
  const [existing] = await pool.query(
    `SELECT date, stock_code, COUNT(*) n FROM idx_broker_summary
      WHERE date >= ? AND date <= ? GROUP BY date, stock_code`,
    [opts.from, opts.to]
  );
  const done = new Set(existing.filter(r => r.n > 3).map(r => `${toDateStr(r.date)}|${r.stock_code}`));

  const todo = [];
  for (const d of dates) for (const t of tickers) if (!done.has(`${d}|${t}`)) todo.push({ d, t });

  console.log(`Range        : ${opts.from} .. ${opts.to}`);
  console.log(`Trading days : ${dates.length}`);
  console.log(`Tickers      : ${tickers.length} (ADV >= Rp ${(opts.minAdv / 1e9).toFixed(1)}bn over the period, top ${opts.maxTickers})`);
  console.log(`Already done : ${done.size} ticker-days`);
  console.log(`TO FETCH     : ${todo.length} calls  (budget ${opts.budget})`);
  const hrs = (todo.length * opts.delayMs) / 3600000;
  console.log(`Est. runtime : ${hrs.toFixed(1)}h at ${opts.delayMs}ms/call`);
  if (todo.length > opts.budget) console.log(`NOTE: will stop after ${opts.budget} calls — re-run to continue (resumable).`);
  if (opts.dryRun) { console.log('\n(dry run)'); await pool.end(); return; }

  let calls = 0, saved = 0, emptyDays = 0, failures = 0, consecutiveFail = 0;
  const started = Date.now();

  for (const { d, t } of todo) {
    if (calls >= opts.budget) { console.log(`\nBudget ${opts.budget} reached — stopping cleanly.`); break; }

    let rows = null, attempt = 0;
    while (attempt < 5) {
      try {
        rows = await fetchBrokerSummary(t, d);
        break;
      } catch (e) {
        if (e.message === 'RATE_LIMITED') {
          const wait = 30000 * Math.pow(2, attempt);   // 30s, 60s, 120s, 240s
          console.log(`  429 rate limited — backing off ${wait / 1000}s (attempt ${attempt + 1})`);
          await delay(wait);
          attempt++;
        } else {
          rows = null; break;
        }
      }
    }
    calls++;

    if (rows === null) {
      failures++; consecutiveFail++;
      if (consecutiveFail >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`\nABORT: ${MAX_CONSECUTIVE_FAILURES} consecutive failures — something is wrong upstream, not retrying blindly.`);
        break;
      }
    } else {
      consecutiveFail = 0;
      if (rows.length === 0) emptyDays++;
      else saved += await saveBrokerData(pool, d, t, rows);
    }

    if (calls % 500 === 0) {
      const el = (Date.now() - started) / 1000;
      const rate = calls / el;
      const remain = Math.min(todo.length, opts.budget) - calls;
      console.log(`[${calls}/${Math.min(todo.length, opts.budget)}] ${d} ${t} — saved=${saved} empty=${emptyDays} fail=${failures} — ${rate.toFixed(1)} calls/s, ETA ${(remain / rate / 3600).toFixed(1)}h`);
    }
    await delay(opts.delayMs);
  }

  console.log(`\nDone: ${calls} calls, ${saved} rows saved, ${emptyDays} empty (non-trading/no-data), ${failures} failures`);
  const [after] = await pool.query(
    'SELECT COUNT(DISTINCT date) dates, MIN(date) earliest, MAX(date) latest FROM idx_broker_summary'
  );
  console.log(`idx_broker_summary now: ${after[0].dates} dates, ${toDateStr(after[0].earliest)} .. ${toDateStr(after[0].latest)}`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
