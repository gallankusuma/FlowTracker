/**
 * AWO Historical Backfill Script
 * 
 * Re-generates signals from historical broker data and calculates outcomes
 * using actual stock price data. This gives AWO much more training data.
 * 
 * Usage: node awo_backfill.js [--from 2026-04-28] [--to 2026-07-10]
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// Same factor weights as in server.js (default)
const WEIGHTS = { f1: 0.20, f2: 0.15, f3: 0.12, f4: 0.12, f5: 0.10, f6: 0.12, f7: 0.12, f8: 0.07 };

// ── Scoring Functions (simplified from server.js) ──────────────────
function sigmoid(x, steepness = 1) {
  return 100 / (1 + Math.exp(-steepness * x));
}

function calcF1(top3Pct) {
  // Smart Money concentration
  if (top3Pct >= 50) return sigmoid(top3Pct - 40, 0.15);
  if (top3Pct >= 30) return 40 + (top3Pct - 30) * 1.5;
  return Math.max(0, top3Pct * 0.8);
}

function calcF2(days) {
  // Trend consistency
  if (!days || days.length < 5) return 50;
  const positive = days.filter(d => d > 0).length;
  const ratio = positive / days.length;
  if (ratio >= 0.8) return 90 + (ratio - 0.8) * 50; // accelerating bonus
  if (ratio >= 0.6) return 60 + (ratio - 0.6) * 150;
  if (ratio <= 0.2) return 10;
  return ratio * 100;
}

function calcF3(zScore) {
  // Volume z-score
  if (zScore === null || zScore === undefined) return 50;
  const absZ = Math.abs(zScore);
  if (absZ >= 3) return 100;
  if (absZ >= 2) return 80 + (absZ - 2) * 20;
  if (absZ >= 1) return 50 + (absZ - 1) * 30;
  return 30 + absZ * 20;
}

function calcF4(momentum5d) {
  // Momentum
  if (momentum5d === null || momentum5d === undefined) return 50;
  const abs = Math.abs(momentum5d);
  if (abs >= 15) return momentum5d > 0 ? 100 : 0;
  if (abs >= 8) return momentum5d > 0 ? 85 + (abs - 8) * 2 : 15 - (abs - 8) * 2;
  return 50 + momentum5d * 4.5;
}

function calcF5(relStr) {
  // Relative strength vs market
  if (relStr === null || relStr === undefined) return 50;
  return sigmoid(relStr, 0.3);
}

function calcF6(netBuyers, netSellers) {
  // Market breadth
  const total = (netBuyers || 0) + (netSellers || 0);
  if (total === 0) return 50;
  const ratio = (netBuyers || 0) / total;
  return Math.round(ratio * 100);
}

function calcF7(top3PctBuy, top3PctSell) {
  // Broker alignment
  const buyConc = top3PctBuy || 0;
  const sellConc = top3PctSell || 0;
  const diff = buyConc - sellConc;
  if (diff > 30) return 85 + Math.min(diff - 30, 15);
  if (diff > 10) return 50 + diff * 1.75;
  if (diff < -30) return 15;
  return 50 + diff;
}

function calcF8(streakDays) {
  // Streak quality
  if (!streakDays || streakDays <= 0) return 5;
  if (streakDays >= 5) return 95;
  if (streakDays >= 4) return 90;
  if (streakDays >= 3) return 80;
  if (streakDays >= 2) return 60;
  return 30;
}

function computeScore(factors) {
  let score = 0;
  score += (factors.f1 || 50) * WEIGHTS.f1;
  score += (factors.f2 || 50) * WEIGHTS.f2;
  score += (factors.f3 || 50) * WEIGHTS.f3;
  score += (factors.f4 || 50) * WEIGHTS.f4;
  score += (factors.f5 || 50) * WEIGHTS.f5;
  score += (factors.f6 || 50) * WEIGHTS.f6;
  score += (factors.f7 || 50) * WEIGHTS.f7;
  score += (factors.f8 || 50) * WEIGHTS.f8;
  return Math.round(score);
}

function getSignalType(score) {
  if (score >= 78) return 'STRONG BUY';
  if (score >= 63) return 'BUY';
  if (score >= 53) return 'WATCH';
  if (score >= 40) return 'NEUTRAL';
  if (score >= 25) return 'SELL';
  return 'STRONG SELL';
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  
  // Parse args
  const args = process.argv.slice(2);
  let fromDate = '2026-04-28'; // stock_prices start
  let toDate = '2026-07-10';   // leave 7 days for outcomes
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && args[i + 1]) fromDate = args[i + 1];
    if (args[i] === '--to' && args[i + 1]) toDate = args[i + 1];
  }
  
  console.log(`\n🔄 AWO Historical Backfill`);
  console.log(`   From: ${fromDate}`);
  console.log(`   To:   ${toDate}`);
  console.log(`   (leave ~7 days gap from today for outcome tracking)\n`);

  // 1. Get all trading dates with broker data
  const [tradingDates] = await pool.query(
    `SELECT DISTINCT date FROM idx_broker_summary 
     WHERE date >= ? AND date <= ? ORDER BY date`,
    [fromDate, toDate]
  );
  console.log(`📅 Found ${tradingDates.length} trading days to process\n`);
  
  if (tradingDates.length === 0) {
    console.log('❌ No trading dates found in range');
    process.exit(1);
  }

  // 2. Load all stock prices into memory for fast lookup
  console.log('📈 Loading stock prices...');
  const [allPrices] = await pool.query(
    `SELECT stock_code, date, close_price FROM idx_stock_prices WHERE date >= ? ORDER BY stock_code, date`,
    [fromDate]
  );
  
  // Build price map: ticker -> [{date, close}, ...]
  const priceMap = {};
  for (const p of allPrices) {
    const d = p.date instanceof Date ? p.date.toISOString().slice(0, 10) : String(p.date);
    if (!priceMap[p.stock_code]) priceMap[p.stock_code] = [];
    priceMap[p.stock_code].push({ date: d, close: parseFloat(p.close_price) });
  }
  console.log(`   Loaded prices for ${Object.keys(priceMap).length} tickers\n`);

  // 3. Concentration will be calculated on-the-fly from broker data per date
  console.log('📊 Concentration calculated from broker data per date\n');

  let totalInserted = 0;
  let totalSkipped = 0;

  // 4. Process each trading date
  for (const { date: rawDate } of tradingDates) {
    const dateStr = rawDate instanceof Date ? rawDate.toISOString().slice(0, 10) : String(rawDate);
    
    // Check if we already have signals for this date
    const [existing] = await pool.query(
      'SELECT COUNT(1) as cnt FROM idx_signal_history WHERE data_date = ?', [dateStr]
    );
    if (existing[0].cnt > 10) {
      // Already has signals, skip
      totalSkipped++;
      continue;
    }

    // Get broker data for this date
    const [brokers] = await pool.query(
      `SELECT stock_code, broker_code, buy_val, sell_val, net_val
       FROM idx_broker_summary WHERE date = ?`,
      [dateStr]
    );
    
    if (brokers.length === 0) continue;

    // Group by stock
    const stockBrokers = {};
    for (const b of brokers) {
      if (!stockBrokers[b.stock_code]) stockBrokers[b.stock_code] = [];
      stockBrokers[b.stock_code].push(b);
    }

    // Get 5-day history for trend calculation
    const [prevDates] = await pool.query(
      `SELECT DISTINCT date FROM idx_broker_summary 
       WHERE date < ? ORDER BY date DESC LIMIT 5`,
      [dateStr]
    );
    
    // Calculate signals for each stock
    const signals = [];
    for (const [ticker, brokerList] of Object.entries(stockBrokers)) {
      // --- f1: Concentration (calculate from broker data) ---
      const totalBuyVal = brokerList.reduce((s, b) => s + Math.abs(b.buy_val || 0), 0);
      const totalSellVal = brokerList.reduce((s, b) => s + Math.abs(b.sell_val || 0), 0);
      const sortedBuyers = [...brokerList].sort((a, b) => (b.buy_val || 0) - (a.buy_val || 0));
      const sortedSellers = [...brokerList].sort((a, b) => (b.sell_val || 0) - (a.sell_val || 0));
      const top3BuyVal = sortedBuyers.slice(0, 3).reduce((s, b) => s + (b.buy_val || 0), 0);
      const top3SellVal = sortedSellers.slice(0, 3).reduce((s, b) => s + (b.sell_val || 0), 0);
      const top3BuyPct = totalBuyVal > 0 ? (top3BuyVal / totalBuyVal) * 100 : 0;
      const top3SellPct = totalSellVal > 0 ? (top3SellVal / totalSellVal) * 100 : 0;
      const netConc = top3BuyPct - top3SellPct;
      const f1 = netConc > 0 ? calcF1(top3BuyPct) : Math.max(0, 50 - Math.abs(netConc));

      // --- f2: Trend (use net_val direction as proxy) ---
      const netVal = brokerList.reduce((s, b) => s + (b.net_val || 0), 0);
      const days = netVal > 0 ? [1, 1, 1, 0, 0] : [-1, -1, -1, 0, 0]; // simplified
      const f2 = calcF2(days);

      // --- f3: Volume z-score (estimate from broker data) ---
      const totalVol = brokerList.reduce((s, b) => s + Math.abs(b.buy_val || 0) + Math.abs(b.sell_val || 0), 0);
      // Normalize: we don't have a clean z-score, estimate relative magnitude
      const volEstimate = totalVol > 1e11 ? 3 : totalVol > 5e10 ? 2 : totalVol > 1e10 ? 1 : 0.5;
      const f3 = calcF3(volEstimate);

      // --- f4: Momentum ---
      const prices = priceMap[ticker];
      let momentum5d = 0;
      if (prices && prices.length >= 2) {
        const idx = prices.findIndex(p => p.date >= dateStr);
        if (idx >= 5) {
          const curr = prices[idx]?.close || prices[idx - 1]?.close;
          const prev = prices[idx - 5]?.close;
          if (curr && prev && prev > 0) momentum5d = ((curr - prev) / prev) * 100;
        }
      }
      const f4 = calcF4(momentum5d);

      // --- f5: Relative strength (simplified) ---
      const f5 = calcF5(momentum5d * 0.5); // rough proxy

      // --- f6: Breadth ---
      const netBuyers = brokerList.filter(b => (b.net_val || 0) > 0).length;
      const netSellers = brokerList.filter(b => (b.net_val || 0) < 0).length;
      const f6 = calcF6(netBuyers, netSellers);

      // --- f7: Alignment ---
      const f7 = calcF7(top3BuyPct, top3SellPct);

      // --- f8: Streak ---
      let streak = 0;
      for (const d of days) {
        if (d > 0) streak++;
        else break;
      }
      const f8 = calcF8(streak);

      // Compute score
      const factors = { f1, f2, f3, f4, f5, f6, f7, f8 };
      const score = computeScore(factors);
      const signalType = getSignalType(score);
      const confidence = Math.min(100, Math.round(50 + Math.abs(score - 50) * 0.4));

      // Get price at signal date
      const priceAtSignal = prices?.find(p => p.date === dateStr)?.close || null;

      signals.push({
        data_date: dateStr,
        stock_code: ticker,
        composite_score: score,
        signal_type: signalType,
        confidence,
        f1, f2, f3, f4, f5, f6, f7, f8,
        price_at_signal: priceAtSignal,
      });
    }

    // Only keep signals with strong opinions (score > 65 or < 35)
    const filtered = signals.filter(s => s.composite_score >= 63 || s.composite_score <= 37);

    if (filtered.length > 0) {
      // Batch insert
      const values = filtered.map(s => [
        s.data_date, s.stock_code, s.composite_score, s.signal_type, s.confidence,
        s.f1, s.f2, s.f3, s.f4, s.f5, s.f6, s.f7, s.f8,
        s.price_at_signal, 'backfill'
      ]);

      await pool.query(
        `INSERT IGNORE INTO idx_signal_history
         (data_date, stock_code, composite_score, signal_type, confidence,
          f1_concentration, f2_trend, f3_volume_z, f4_momentum, f5_rel_strength,
          f6_breadth, f7_alignment, f8_streak, price_at_signal, data_source)
         VALUES ?`,
        [values]
      );
      totalInserted += filtered.length;
    }

    process.stdout.write(`\r   📅 ${dateStr}: ${filtered.length} signals (${totalInserted} total)`);
  }

  console.log(`\n\n✅ Backfill complete: ${totalInserted} signals inserted, ${totalSkipped} dates skipped\n`);

  // 5. Now fill outcomes using actual price data
  console.log('📊 Filling outcomes from price data...');
  
  const [pendingSignals] = await pool.query(
    `SELECT id, stock_code, data_date, price_at_signal, signal_type 
     FROM idx_signal_history 
     WHERE outcome IS NULL AND price_at_signal IS NOT NULL`
  );

  console.log(`   ${pendingSignals.length} signals need outcome evaluation\n`);

  let wins = 0, losses = 0, neutrals = 0, noData = 0;

  for (const sig of pendingSignals) {
    const sigDateStr = sig.data_date instanceof Date 
      ? sig.data_date.toISOString().slice(0, 10) 
      : String(sig.data_date);
    const prices = priceMap[sig.stock_code];
    if (!prices) { noData++; continue; }

    const sigIdx = prices.findIndex(p => p.date >= sigDateStr);
    if (sigIdx < 0) { noData++; continue; }

    const entry = sig.price_at_signal;
    if (!entry || entry <= 0) { noData++; continue; }

    // Calculate multi-horizon returns
    const getReturn = (days) => {
      const idx = sigIdx + days;
      if (idx >= prices.length) return null;
      return ((prices[idx].close - entry) / entry) * 100;
    };

    const r1 = getReturn(1);
    const r3 = getReturn(3);
    const r5 = getReturn(5);
    const r10 = getReturn(10);

    // Calculate max drawdown and max profit over 10-day window
    let maxDD = 0, maxProfit = 0;
    for (let i = 1; i <= Math.min(10, prices.length - sigIdx - 1); i++) {
      const ret = ((prices[sigIdx + i].close - entry) / entry) * 100;
      if (ret < maxDD) maxDD = ret;
      if (ret > maxProfit) maxProfit = ret;
    }

    // Determine outcome using smart logic
    let outcome = 'NEUTRAL';
    const isBuy = sig.signal_type && (sig.signal_type.includes('BUY') || sig.signal_type === 'WATCH');

    if (isBuy) {
      if (maxProfit >= 3 && maxDD > -2) outcome = 'WIN';
      else if (r5 !== null && r5 >= 2) outcome = 'WIN';
      else if (maxDD <= -3) outcome = 'LOSS';
      else if (r5 !== null && r5 <= -2) outcome = 'LOSS';
    } else {
      // SELL signals: inverse
      if (maxDD <= -3) outcome = 'WIN';  // price dropped = sell was correct
      else if (r5 !== null && r5 <= -2) outcome = 'WIN';
      else if (maxProfit >= 3) outcome = 'LOSS'; // price went up = sell was wrong
      else if (r5 !== null && r5 >= 2) outcome = 'LOSS';
    }

    if (outcome === 'WIN') wins++;
    else if (outcome === 'LOSS') losses++;
    else neutrals++;

    // Update
    await pool.query(
      `UPDATE idx_signal_history 
       SET outcome = ?, price_5d_later = ?,
           return_1d = ?, return_3d = ?, return_5d = ?, return_10d = ?,
           max_drawdown = ?, max_profit = ?
       WHERE id = ?`,
      [outcome, r5 !== null ? entry * (1 + r5/100) : null,
       r1 !== null ? Math.max(-999, Math.min(999, r1)) : null,
       r3 !== null ? Math.max(-999, Math.min(999, r3)) : null,
       r5 !== null ? Math.max(-999, Math.min(999, r5)) : null,
       r10 !== null ? Math.max(-999, Math.min(999, r10)) : null,
       Math.max(-999, Math.min(999, maxDD)),
       Math.max(-999, Math.min(999, maxProfit)),
       sig.id]
    );
  }

  console.log(`\n📊 Outcome Results:`);
  console.log(`   ✅ WIN:     ${wins}`);
  console.log(`   ❌ LOSS:    ${losses}`);
  console.log(`   ⚪ NEUTRAL: ${neutrals}`);
  console.log(`   📉 No data: ${noData}`);
  console.log(`   📈 Win Rate: ${wins + losses > 0 ? Math.round(wins / (wins + losses) * 100) : 0}%\n`);

  // 6. Final stats
  const [finalStats] = await pool.query(
    `SELECT outcome, COUNT(1) as cnt FROM idx_signal_history GROUP BY outcome`
  );
  console.log('📋 Final Signal History:');
  for (const row of finalStats) {
    console.log(`   ${row.outcome || 'PENDING'}: ${row.cnt}`);
  }

  const [totalCount] = await pool.query('SELECT COUNT(1) as cnt FROM idx_signal_history');
  console.log(`\n   Total: ${totalCount[0].cnt} signals\n`);

  await pool.end();
  console.log('✅ Done!\n');
}

main().catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
