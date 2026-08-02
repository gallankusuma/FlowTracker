/**
 * Backtest: "Broker Alpha" — does a SPECIFIC broker code's net-buying activity
 * predict forward returns better than others? This is the quantitative version
 * of classic bandarmology ("ikutin bandar mana yang beneran smart money").
 *
 * Methodology (deliberately stricter than earlier single-window tests, because
 * we're testing 92 brokers at once — multiple-testing risk is severe: even pure
 * noise would produce ~4-5 "significant at p<0.05" brokers by chance):
 *   1. For each (stock, date), rank brokers by net_val; a broker is a "buy signal"
 *      for that stock-date if net_val > 0 AND it's among the top-3 net buyers.
 *   2. Measure forward return (+5d, +10d) for every buy-signal event.
 *   3. Split the 13.5-month history into two halves. A broker only counts as
 *      having real, non-fluke alpha if its average forward return is POSITIVE
 *      AND above the all-broker baseline in BOTH halves independently — this is
 *      an out-of-sample-style replication check, not a single p-value.
 *   4. Require n>=30 buy-signal events per half per broker (reliability floor).
 *
 * Usage: node backtest_broker_alpha.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const { mean } = require('./modules/statistics');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

function fmtPct(x) { return (x >= 0 ? '+' : '') + x.toFixed(3) + '%'; }

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('Loading idx_broker_summary (this may take a moment)...');
  const [rows] = await pool.query(
    `SELECT date, broker_code, stock_code, net_val FROM idx_broker_summary ORDER BY date ASC`
  );
  console.log(`Loaded ${rows.length} broker-summary rows\n`);

  const allDates = [...new Set(rows.map(r => r.date.toISOString().split('T')[0]))].sort();
  const midDate = allDates[Math.floor(allDates.length / 2)];
  console.log(`Date range: ${allDates[0]} to ${allDates[allDates.length - 1]}, split point: ${midDate}\n`);

  // Group by (date, stock) to find top-3 net buyers per group
  const groups = new Map(); // "date_stock" -> [{broker, net_val}]
  for (const r of rows) {
    const dateStr = r.date.toISOString().split('T')[0];
    const key = `${dateStr}|${r.stock_code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ broker: r.broker_code, net_val: Number(r.net_val), date: dateStr, stock: r.stock_code });
  }

  const buySignals = []; // { broker, stock, date, half }
  for (const [, arr] of groups) {
    arr.sort((a, b) => b.net_val - a.net_val);
    const top3 = arr.slice(0, 3).filter(x => x.net_val > 0);
    for (const t of top3) {
      buySignals.push({ broker: t.broker, stock: t.stock, date: t.date, half: t.date < midDate ? 1 : 2 });
    }
  }
  console.log(`Total buy-signal events (top-3 net buyer, net_val>0): ${buySignals.length}\n`);

  // Load price history for all referenced tickers
  const tickers = [...new Set(buySignals.map(s => s.stock))];
  const priceMap = new Map();
  for (const t of tickers) {
    const [prows] = await pool.query(`SELECT date, close_price c FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`, [t]);
    priceMap.set(t, prows.map(r => ({ date: r.date.toISOString().split('T')[0], close: Number(r.c) })));
  }

  function forwardReturn(stock, dateStr, horizon) {
    const candles = priceMap.get(stock);
    if (!candles) return null;
    const idx = candles.findIndex(c => c.date >= dateStr);
    if (idx === -1 || idx + horizon >= candles.length) return null;
    return (candles[idx + horizon].close / candles[idx].close - 1) * 100;
  }

  // Compute forward returns for every buy signal (+5d)
  console.log('Computing forward returns for all buy-signal events...');
  for (const s of buySignals) {
    s.ret5 = forwardReturn(s.stock, s.date, 5);
  }
  const withRet = buySignals.filter(s => s.ret5 !== null);
  console.log(`${withRet.length} events with valid forward-return data\n`);

  // Overall baseline (all buy-signal events pooled, regardless of broker) per half
  const baseline = { 1: withRet.filter(s => s.half === 1).map(s => s.ret5), 2: withRet.filter(s => s.half === 2).map(s => s.ret5) };
  console.log(`Baseline half1: n=${baseline[1].length}, avg+5d=${fmtPct(mean(baseline[1]))}`);
  console.log(`Baseline half2: n=${baseline[2].length}, avg+5d=${fmtPct(mean(baseline[2]))}\n`);

  // Per-broker, per-half stats
  const byBroker = new Map();
  for (const s of withRet) {
    if (!byBroker.has(s.broker)) byBroker.set(s.broker, { 1: [], 2: [] });
    byBroker.get(s.broker)[s.half].push(s.ret5);
  }

  const MIN_N = 30;
  const results = [];
  for (const [broker, halves] of byBroker) {
    if (halves[1].length < MIN_N || halves[2].length < MIN_N) continue;
    const avg1 = mean(halves[1]), avg2 = mean(halves[2]);
    const beatsBaseline1 = avg1 > mean(baseline[1]);
    const beatsBaseline2 = avg2 > mean(baseline[2]);
    results.push({
      broker, n1: halves[1].length, n2: halves[2].length, avg1, avg2,
      consistent: avg1 > 0 && avg2 > 0 && beatsBaseline1 && beatsBaseline2,
      consistentlyBad: avg1 < 0 && avg2 < 0 && !beatsBaseline1 && !beatsBaseline2,
    });
  }

  results.sort((a, b) => (a.avg1 + a.avg2) - (b.avg1 + b.avg2));

  console.log('='.repeat(90));
  console.log(`BROKERS TESTED: ${results.length} (n>=${MIN_N} events in BOTH halves)`);
  console.log('='.repeat(90));
  console.log('broker | n_half1 | avg+5d_half1 | n_half2 | avg+5d_half2 | consistent_positive | consistent_negative');
  for (const r of results) {
    console.log(`${r.broker.padEnd(6)} | ${String(r.n1).padStart(7)} | ${fmtPct(r.avg1).padStart(12)} | ${String(r.n2).padStart(7)} | ${fmtPct(r.avg2).padStart(12)} | ${r.consistent ? 'YES' : ''.padEnd(3)} | ${r.consistentlyBad ? 'YES' : ''}`);
  }

  const goodBrokers = results.filter(r => r.consistent);
  const badBrokers = results.filter(r => r.consistentlyBad);
  console.log('\n' + '='.repeat(90));
  console.log(`Brokers with REPLICATED positive alpha (both halves, beat baseline both halves): ${goodBrokers.length}`);
  console.log(goodBrokers.map(r => r.broker).join(', ') || '(none)');
  console.log(`\nBrokers with REPLICATED negative signal (both halves, below baseline both halves): ${badBrokers.length}`);
  console.log(badBrokers.map(r => r.broker).join(', ') || '(none)');
  console.log('='.repeat(90));

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
