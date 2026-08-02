/**
 * Backfill script: full broker-summary history (idx_broker_summary) for a
 * SPECIFIC list of tickers — built for the 100 tickers added to the tracked
 * universe on 2026-07-22 (see modules/tickers.js), which otherwise would have
 * zero broker history vs the original 145's ~13.5 months.
 *
 * Pulls investor=all (no market filter) per ticker per date — the same basic
 * call pullStockFromIndexAlpha() uses in server.js — across every trading
 * date already present in idx_broker_summary (so the new tickers end up with
 * exactly the same date coverage as the existing ones).
 *
 * Resumable: skips any ticker+date that already has rows in idx_broker_summary.
 *
 * Usage: node backfill_broker_summary_tickers.js --tickers A,B,C [--dry-run]
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

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { tickers: null, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tickers') out.tickers = args[++i].split(',').map(s => s.trim());
    else if (args[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function fetchBrokerSummary(ticker, date) {
  const url = `${INDEX_ALPHA_BASE}/stocks/broker-summary?ticker=${ticker}&from=${date}&to=${date}&investor=all`;
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

async function saveBrokerData(pool, date, ticker, rows) {
  if (!rows.length) return 0;
  const values = rows.map(r => [date, r.brokerCode, ticker, r.buyVal, r.buyLot, r.buyAvg, r.sellVal, r.sellLot, r.sellAvg, r.netVal]);
  const [result] = await pool.query(
    `INSERT INTO idx_broker_summary (date, broker_code, stock_code, buy_val, buy_lot, buy_avg, sell_val, sell_lot, sell_avg, net_val)
     VALUES ?
     ON DUPLICATE KEY UPDATE buy_val=VALUES(buy_val), buy_lot=VALUES(buy_lot), buy_avg=VALUES(buy_avg),
       sell_val=VALUES(sell_val), sell_lot=VALUES(sell_lot), sell_avg=VALUES(sell_avg), net_val=VALUES(net_val)`,
    [values]
  );
  return result.affectedRows;
}

async function main() {
  const opts = parseArgs();
  if (!opts.tickers) { console.error('--tickers required'); process.exit(1); }
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [dateRows] = await pool.query('SELECT DISTINCT date FROM idx_broker_summary ORDER BY date ASC');
  const dates = dateRows.map(r => r.date.toISOString().slice(0, 10));

  console.log(`Backfill plan: ${dates.length} dates (${dates[0]} .. ${dates[dates.length - 1]}) x ${opts.tickers.length} tickers = up to ${dates.length * opts.tickers.length} API calls`);
  if (opts.dryRun) { console.log('(dry run — not fetching)'); await pool.end(); return; }

  let calls = 0, saved = 0, skipped = 0, errors = 0;
  const startTime = Date.now();

  for (const ticker of opts.tickers) {
    for (const date of dates) {
      const [existing] = await pool.query(
        'SELECT COUNT(*) as cnt FROM idx_broker_summary WHERE date=? AND stock_code=?', [date, ticker]
      );
      if (existing[0].cnt > 0) { skipped++; continue; }

      try {
        const rows = await fetchBrokerSummary(ticker, date);
        calls++;
        saved += await saveBrokerData(pool, date, ticker, rows);
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
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${ticker}] done — calls=${calls} saved=${saved} skipped=${skipped} errors=${errors} elapsed=${elapsed}s`);
  }

  console.log(`\nBackfill complete: ${calls} API calls, ${saved} rows saved, ${skipped} ticker-dates skipped (already had data), ${errors} errors`);
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
