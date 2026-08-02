/**
 * Backfill script: foreign/domestic x RG/NG broker flow breakdown from Index Alpha.
 *
 * Pulls the 4 finest-grained combos (foreign x RG, foreign x NG, domestic x RG,
 * domestic x NG) per ticker per trading day and stores them in
 * idx_broker_flow_detail. These 4 combos are additive and reconstruct every other
 * view (investor=all, market=ALL, etc.) with zero further API calls.
 *
 * Resumable: skips any ticker+date that already has rows in idx_broker_flow_detail,
 * so re-running after an interruption only fetches what's missing.
 *
 * Usage: node backfill_flow_detail.js [--days 45] [--tickers BBCA,BBRI] [--dry-run]
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

const FLOW_DETAIL_COMBOS = [
  { investor: 'f', investorType: 'foreign', market: 'RG' },
  { investor: 'f', investorType: 'foreign', market: 'NG' },
  { investor: 'd', investorType: 'domestic', market: 'RG' },
  { investor: 'd', investorType: 'domestic', market: 'NG' },
];

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { days: 45, tickers: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days') out.days = parseInt(args[++i], 10);
    else if (args[i] === '--tickers') out.tickers = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function fetchCombo(ticker, date, investor, market) {
  const url = `${INDEX_ALPHA_BASE}/stocks/broker-summary?ticker=${ticker}&from=${date}&to=${date}&investor=${investor}&market=${market}`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${INDEX_ALPHA_KEY}`, 'Accept': 'application/json' },
  });
  if (!resp.ok) {
    if (resp.status === 429) throw new Error('RATE_LIMITED');
    return [];
  }
  const json = await resp.json();
  if (!json.success || !Array.isArray(json.data)) return [];
  return json.data.map(b => ({
    brokerCode: b.code,
    buyVal: Math.round(b.buy_value || 0), buyLot: Math.round(b.buy_volume || 0), buyAvg: b.buy_avg || 0,
    sellVal: Math.round(b.sell_value || 0), sellLot: Math.round(b.sell_volume || 0), sellAvg: b.sell_avg || 0,
    netVal: Math.round((b.buy_value || 0) - (b.sell_value || 0)),
  }));
}

async function saveFlowDetail(pool, date, ticker, investorType, market, rows) {
  if (!rows.length) return 0;
  const values = rows.map(r => [
    date, ticker, r.brokerCode, investorType, market,
    r.buyVal, r.buyLot, r.buyAvg, r.sellVal, r.sellLot, r.sellAvg, r.netVal,
  ]);
  const [result] = await pool.query(
    `INSERT INTO idx_broker_flow_detail
       (date, stock_code, broker_code, investor_type, market_segment,
        buy_val, buy_lot, buy_avg, sell_val, sell_lot, sell_avg, net_val)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       buy_val=VALUES(buy_val), buy_lot=VALUES(buy_lot), buy_avg=VALUES(buy_avg),
       sell_val=VALUES(sell_val), sell_lot=VALUES(sell_lot), sell_avg=VALUES(sell_avg),
       net_val=VALUES(net_val)`,
    [values]
  );
  return result.affectedRows;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [dateRows] = await pool.query(
    'SELECT DISTINCT date FROM idx_broker_summary ORDER BY date DESC LIMIT ?',
    [opts.days]
  );
  const dates = dateRows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10))).sort();

  const [tickerRows] = await pool.query('SELECT DISTINCT stock_code FROM idx_broker_summary ORDER BY stock_code');
  const tickers = opts.tickers || tickerRows.map(r => r.stock_code);

  console.log(`Backfill plan: ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]}) x ${tickers.length} tickers x 4 combos = ${dates.length * tickers.length * 4} API calls`);
  if (opts.dryRun) { console.log('(dry run — not fetching)'); await pool.end(); return; }

  let calls = 0, saved = 0, skippedTickerDates = 0, errors = 0;
  const startTime = Date.now();

  for (const date of dates) {
    for (const ticker of tickers) {
      const [existing] = await pool.query(
        'SELECT COUNT(*) as cnt FROM idx_broker_flow_detail WHERE date=? AND stock_code=?', [date, ticker]
      );
      if (existing[0].cnt > 0) { skippedTickerDates++; continue; }

      for (const combo of FLOW_DETAIL_COMBOS) {
        try {
          const rows = await fetchCombo(ticker, date, combo.investor, combo.market);
          calls++;
          saved += await saveFlowDetail(pool, date, ticker, combo.investorType, combo.market, rows);
        } catch (e) {
          if (e.message === 'RATE_LIMITED') {
            console.log('  Rate limited — backing off 30s...');
            await delay(30000);
          } else {
            errors++;
          }
        }
        await delay(150);
      }
    }
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${date}] done — calls=${calls} saved=${saved} skipped=${skippedTickerDates} errors=${errors} elapsed=${elapsed}s`);
  }

  console.log(`\nBackfill complete: ${calls} API calls, ${saved} rows saved, ${skippedTickerDates} ticker-dates skipped (already had data), ${errors} errors`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
