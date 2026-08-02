/**
 * Backtest: ex-dividend price effect ("dividend capture" style anomaly), using
 * user-provided Stockbit calendar data (idx_calendar_dividend, 463 events,
 * 2025-07 to 2026-07) joined against idx_stock_prices.
 *
 * Classic documented pattern (global + IDX-specific literature):
 *   - Pre-cum-date run-up: buying pressure into the cum-date (last day still
 *     entitled to the dividend) as investors position to capture it.
 *   - Ex-date drop: price should theoretically fall ~by the dividend amount
 *     (dividend yield %) the day trading goes ex-dividend.
 *   - Post-ex-date drift/recovery: does price recover faster/slower than the
 *     theoretical drop over the following days?
 *
 * Same rigor as prior backtests: win-rate + two-proportion z-test vs a
 * same-ticker random-day baseline, no lookahead beyond what a real trader
 * would know (dividend calendar is announced well ahead of cum-date in practice).
 *
 * Usage: node backtest_dividend_effect.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { twoProportionZTest, mean } = require('./modules/statistics');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function fmtPct(x) { return (x >= 0 ? '+' : '') + x.toFixed(3) + '%'; }

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [divRows] = await pool.query(
    `SELECT symbol, dividend_per_share, last_price, cum_date, ex_date
     FROM idx_calendar_dividend WHERE ex_date IS NOT NULL AND cum_date IS NOT NULL ORDER BY symbol, ex_date`
  );
  console.log(`Loaded ${divRows.length} dividend events`);

  // Preload price history per ticker referenced
  const tickers = [...new Set(divRows.map(r => r.symbol))];
  const priceMap = new Map(); // symbol -> [{date, close}]
  for (const t of tickers) {
    const [rows] = await pool.query(
      `SELECT date, close_price c FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`, [t]
    );
    if (rows.length > 0) {
      priceMap.set(t, rows.map(r => ({ date: r.date.toISOString().split('T')[0], close: Number(r.c) })));
    }
  }
  console.log(`Price history available for ${priceMap.size}/${tickers.length} tickers referenced in dividend calendar\n`);

  function findIdx(candles, dateStr) {
    // exact match, else nearest trading day AFTER dateStr (handles weekends/holidays)
    let idx = candles.findIndex(c => c.date >= dateStr);
    return idx === -1 ? -1 : idx;
  }

  const preRunup = [];   // return from (cumIdx-5) to cumIdx
  const exDrop = [];     // return from (exIdx-1) to exIdx  [close-to-close across the ex transition]
  const postRecover = { 3: [], 5: [], 10: [] }; // forward return from exIdx
  const yieldVsDrop = []; // { theoreticalDropPct, actualDropPct }
  let matched = 0, skipped = 0;

  for (const ev of divRows) {
    const candles = priceMap.get(ev.symbol);
    if (!candles) { skipped++; continue; }
    const cumDateStr = ev.cum_date.toISOString().split('T')[0];
    const exDateStr = ev.ex_date.toISOString().split('T')[0];
    const cumIdx = findIdx(candles, cumDateStr);
    const exIdx = findIdx(candles, exDateStr);
    if (cumIdx === -1 || exIdx === -1 || exIdx <= cumIdx || cumIdx < 5) { skipped++; continue; }

    matched++;
    // Pre-cum run-up: 5 trading days before cum-date -> cum-date close
    const runupRet = (candles[cumIdx].close / candles[cumIdx - 5].close - 1) * 100;
    preRunup.push(runupRet);

    // Ex-date drop: last cum-eligible close -> ex-date close
    const dropRet = (candles[exIdx].close / candles[cumIdx].close - 1) * 100;
    exDrop.push(dropRet);

    // Theoretical drop = dividend / last cum-date close
    const divAmt = Number(ev.dividend_per_share);
    if (divAmt > 0 && candles[cumIdx].close > 0) {
      const theoreticalDropPct = -(divAmt / candles[cumIdx].close) * 100;
      yieldVsDrop.push({ theoreticalDropPct, actualDropPct: dropRet });
    }

    // Post-ex-date recovery at +3/+5/+10 trading days
    for (const h of [3, 5, 10]) {
      const fut = candles[exIdx + h];
      if (fut) postRecover[h].push((fut.close / candles[exIdx].close - 1) * 100);
    }
  }

  console.log(`Matched ${matched} events to price history, skipped ${skipped} (missing/insufficient data)\n`);

  // ─── Baseline: random-day returns for the same tickers, same-length windows ──
  const baseline5d = [], baselineFwd = { 3: [], 5: [], 10: [] };
  for (const t of tickers) {
    const candles = priceMap.get(t);
    if (!candles || candles.length < 20) continue;
    for (let i = 5; i < candles.length - 10; i++) {
      baseline5d.push((candles[i].close / candles[i - 5].close - 1) * 100);
      for (const h of [3, 5, 10]) baselineFwd[h].push((candles[i + h].close / candles[i].close - 1) * 100);
    }
  }

  console.log('='.repeat(78));
  console.log('1. PRE-CUM-DATE RUN-UP (5 trading days before cum-date -> cum-date close)');
  console.log('='.repeat(78));
  {
    const winsD = preRunup.filter(r => r > 0).length, winsB = baseline5d.filter(r => r > 0).length;
    console.log(`Dividend events: n=${preRunup.length}, avgReturn=${fmtPct(mean(preRunup))}, winRate=${(winsD/preRunup.length*100).toFixed(1)}%`);
    console.log(`Baseline (random 5d, same tickers): n=${baseline5d.length}, avgReturn=${fmtPct(mean(baseline5d))}, winRate=${(winsB/baseline5d.length*100).toFixed(1)}%`);
    const { z, pValue } = twoProportionZTest(winsD, preRunup.length, winsB, baseline5d.length);
    console.log(`z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('2. EX-DATE DROP (cum-date close -> ex-date close)');
  console.log('='.repeat(78));
  console.log(`n=${exDrop.length}, avgReturn=${fmtPct(mean(exDrop))}, medianish check via mean only`);
  if (yieldVsDrop.length > 0) {
    const avgTheoretical = mean(yieldVsDrop.map(y => y.theoreticalDropPct));
    const avgActual = mean(yieldVsDrop.map(y => y.actualDropPct));
    console.log(`Avg theoretical drop (dividend/price): ${fmtPct(avgTheoretical)}`);
    console.log(`Avg actual close-to-close move on ex-date: ${fmtPct(avgActual)}`);
    console.log(`Difference (actual - theoretical): ${fmtPct(avgActual - avgTheoretical)} ${avgActual > avgTheoretical ? '(price drops LESS than theory -> underreaction)' : '(price drops MORE than theory -> overreaction)'}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('3. POST-EX-DATE RECOVERY / DRIFT');
  console.log('='.repeat(78));
  for (const h of [3, 5, 10]) {
    const d = postRecover[h], b = baselineFwd[h];
    const winsD = d.filter(r => r > 0).length, winsB = b.filter(r => r > 0).length;
    console.log(`+${h}d after ex-date: n=${d.length}, avgReturn=${fmtPct(mean(d))}, winRate=${(winsD/d.length*100).toFixed(1)}% | baseline: avgReturn=${fmtPct(mean(b))}, winRate=${(winsB/b.length*100).toFixed(1)}%`);
    const { z, pValue } = twoProportionZTest(winsD, d.length, winsB, b.length);
    console.log(`  z=${z.toFixed(2)} p=${pValue.toFixed(5)} -> ${pValue < 0.05 ? 'SIGNIFICANT (p<0.05)' : 'not significant'}`);
  }

  console.log('\n' + '='.repeat(78));
  console.log('Bonferroni note: 4 hypotheses tested (run-up, drop-vs-theory, +3d, +5d, +10d ~5) -> corrected alpha ~= 0.01');
  console.log('='.repeat(78));

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
