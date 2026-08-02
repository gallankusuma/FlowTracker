/**
 * Backtest: historical win rate of the Harmonic Pattern "Ultra Engine"
 * (harmonicEngine.js), replicating exactly what harmonic-scan-worker.js does
 * in production (180-day trailing OHLC window, trailing-5-day broker net,
 * latest available concentration snapshot) but re-run at many historical
 * "as-of" dates instead of just today.
 *
 * Goal: diagnose whether the user's suspicion is right — that the DEFAULT_WEIGHTS
 * (harmonic 20 / wyckoff 15 / smc 20 / volume_profile 15 / broker_flow 30) are
 * miscalibrated — by checking whether each component (and the composite score)
 * actually correlates with realized win rate (target hit before stop-loss),
 * same IC/lift discipline used to validate AWO's 14 factors.
 *
 * Sampling: every 5 trading days (~weekly) per ticker, to keep runtime sane
 * while still capturing many independent pattern instances over time.
 *
 * Usage: node backtest_harmonic_winrate.js
 */

'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const {
  detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
  detectFairValueGaps, detectLiquiditySweeps, buildVolumeProfile,
  calcUltraConviction, DEFAULT_WEIGHTS,
} = require('./harmonicEngine');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const WINDOW = 180;      // trailing bars for pattern/structure detection (matches production)
const STEP = 5;          // sample every 5 trading days
const MAX_HOLD = 30;     // max trading days to wait for target/stop hit
const FRESH_BARS = 5;    // only count patterns whose D-point formed within the last N bars of the window

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [tickerRows] = await pool.query(
    `SELECT stock_code, COUNT(*) n FROM idx_stock_prices GROUP BY stock_code HAVING n >= 250 ORDER BY stock_code`
  );
  const tickers = tickerRows.map(r => r.stock_code);
  console.log(`Tickers: ${tickers.length}`);

  // ─── Preload broker categories ──────────────────────────────────────────
  const [catRows] = await pool.query(`SELECT code, category FROM ft_broker_config`);
  const cats = { foreign: new Set(), bigMoney: new Set() };
  for (const r of catRows) {
    if (r.category === 'FOREIGN') cats.foreign.add(r.code);
    else if (r.category === 'BIG_MONEY') cats.bigMoney.add(r.code);
  }

  // ─── Preload daily foreign/bigMoney net per (stock, date) ───────────────
  console.log('Loading broker summary (daily net by category)...');
  const [brokerRows] = await pool.query(
    `SELECT date, stock_code, broker_code, buy_val - sell_val net_val FROM idx_broker_summary`
  );
  const dailyNetMap = new Map(); // stock -> [{date, foreignNet, bigMoneyNet}] sorted
  {
    const tmp = new Map(); // "stock|date" -> {foreignNet, bigMoneyNet}
    for (const r of brokerRows) {
      const dateStr = r.date.toISOString().split('T')[0];
      const key = `${r.stock_code}|${dateStr}`;
      if (!tmp.has(key)) tmp.set(key, { date: dateStr, foreignNet: 0, bigMoneyNet: 0 });
      const e = tmp.get(key);
      if (cats.foreign.has(r.broker_code)) e.foreignNet += Number(r.net_val);
      else if (cats.bigMoney.has(r.broker_code)) e.bigMoneyNet += Number(r.net_val);
    }
    for (const [key, e] of tmp) {
      const stock = key.split('|')[0];
      if (!dailyNetMap.has(stock)) dailyNetMap.set(stock, []);
      dailyNetMap.get(stock).push(e);
    }
    for (const [, arr] of dailyNetMap) arr.sort((a, b) => a.date < b.date ? -1 : 1);
  }
  console.log(`Broker net data loaded for ${dailyNetMap.size} tickers`);

  // ─── Preload concentration snapshots per (stock, date) ──────────────────
  console.log('Loading concentration history...');
  const [concRows] = await pool.query(`SELECT data_date, stock_code, dn0, dn1, dn2 FROM idx_concentration`);
  const concMap = new Map(); // stock -> [{date, dn0, dn1, dn2}] sorted
  for (const r of concRows) {
    const dateStr = r.data_date.toISOString().split('T')[0];
    if (!concMap.has(r.stock_code)) concMap.set(r.stock_code, []);
    concMap.get(r.stock_code).push({ date: dateStr, dn0: r.dn0, dn1: r.dn1, dn2: r.dn2 });
  }
  for (const [, arr] of concMap) arr.sort((a, b) => a.date < b.date ? -1 : 1);
  console.log(`Concentration data loaded for ${concMap.size} tickers\n`);

  function trailingNet(stock, asOfDate, days = 5) {
    const arr = dailyNetMap.get(stock);
    if (!arr) return { foreignNet: 0, bigMoneyNet: 0 };
    let idx = arr.findIndex(e => e.date > asOfDate);
    if (idx === -1) idx = arr.length; // all entries <= asOfDate
    const slice = arr.slice(Math.max(0, idx - days), idx);
    return {
      foreignNet: slice.reduce((s, e) => s + e.foreignNet, 0),
      bigMoneyNet: slice.reduce((s, e) => s + e.bigMoneyNet, 0),
    };
  }
  function latestConc(stock, asOfDate) {
    const arr = concMap.get(stock);
    if (!arr) return { dn0: 0, dn1: 0, dn2: 0 };
    let latest = null;
    for (const e of arr) { if (e.date <= asOfDate) latest = e; else break; }
    return latest || { dn0: 0, dn1: 0, dn2: 0 };
  }

  // ─── Main loop: for each ticker, each as-of date, detect + simulate ─────
  const events = [];
  let scanned = 0;

  for (const ticker of tickers) {
    const [prows] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE stock_code = ? ORDER BY date ASC`, [ticker]
    );
    const candles = prows.map(r => ({
      date: r.date.toISOString().split('T')[0],
      open: Number(r.o), high: Number(r.h), low: Number(r.l), close: Number(r.c), volume: Number(r.v),
    }));
    if (candles.length < WINDOW + MAX_HOLD + 10) continue;

    for (let asOfIdx = WINDOW; asOfIdx < candles.length - MAX_HOLD; asOfIdx += STEP) {
      const windowOhlc = candles.slice(asOfIdx - WINDOW + 1, asOfIdx + 1);
      const asOfDate = candles[asOfIdx].date;

      let patterns;
      try { patterns = detectHarmonicPatterns(windowOhlc, ticker); } catch { continue; }
      if (!patterns.length) continue;

      // Only fresh completions (D point near the end of the window)
      const fresh = patterns.filter(p => (windowOhlc.length - 1 - p.pattern_data.D.index) <= FRESH_BARS);
      if (!fresh.length) continue;

      let wy, obs, fvgs, sw, vp;
      try {
        wy = detectWyckoffPhase(windowOhlc) || {};
        obs = detectOrderBlocks(windowOhlc) || [];
        fvgs = detectFairValueGaps(windowOhlc) || [];
        sw = detectLiquiditySweeps(windowOhlc) || {};
        vp = buildVolumeProfile(windowOhlc) || {};
      } catch { continue; }

      const last = windowOhlc[windowOhlc.length - 1];
      const vols = windowOhlc.map(c => c.volume || 0);
      const avg30 = vols.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, vols.length);
      const avg5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
      const vol_spike = avg30 > 0 && (avg5 / avg30) > 1.5;
      const closes = windowOhlc.map(c => c.close);
      const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
      const above_vwap = last.close > ma20;

      const { foreignNet, bigMoneyNet } = trailingNet(ticker, asOfDate);
      const conc = latestConc(ticker, asOfDate);
      const brokerData = { foreignNet, bigMoneyNet, dn0: conc.dn0 || 0, dn1: conc.dn1 || 0, dn2: conc.dn2 || 0 };

      for (const p of fresh) {
        const structureData = { trend: above_vwap ? p.direction : 'NEUTRAL', lastClose: last.close, vol_spike, above_vwap };
        const wyckoffData = { phase: wy.phase || 'UNKNOWN' };
        const smcData = { order_blocks: obs, fair_value_gaps: fvgs, liquidity_sweeps: sw };

        let ms;
        try { ms = calcUltraConviction(p, structureData, wyckoffData, smcData, vp, brokerData, DEFAULT_WEIGHTS); }
        catch { continue; }

        // Simulate forward outcome using REAL future price path
        let outcome = 'NO_HIT';
        for (let h = 1; h <= MAX_HOLD; h++) {
          const bar = candles[asOfIdx + h];
          if (!bar) break;
          if (p.direction === 'BULLISH') {
            if (bar.low <= p.stop_loss) { outcome = 'LOSS'; break; }
            if (bar.high >= p.target_1) { outcome = 'WIN'; break; }
          } else {
            if (bar.high >= p.stop_loss) { outcome = 'LOSS'; break; }
            if (bar.low <= p.target_1) { outcome = 'WIN'; break; }
          }
        }

        const smart_money_confirmed = (foreignNet > 0 && bigMoneyNet > 0 && p.direction === 'BULLISH') ||
                                       (foreignNet < 0 && bigMoneyNet < 0 && p.direction === 'BEARISH');
        const in_smc_zone = obs.some(o => last.close >= Math.min(o.high, o.low) && last.close <= Math.max(o.high, o.low)) ||
                             fvgs.some(f => { const t = f.top||f.high, b = f.bot||f.low; return last.close >= Math.min(t,b) && last.close <= Math.max(t,b); });

        // % move to target vs % move to stop (for expectancy, not just win rate)
        const rewardPct = Math.abs(p.target_1 - p.entry_price) / p.entry_price * 100;
        const riskPct = Math.abs(p.entry_price - p.stop_loss) / p.entry_price * 100;

        events.push({
          ticker, asOfDate, pattern_type: p.pattern_type, direction: p.direction,
          risk_reward: p.risk_reward, fib_score: p.fib_score,
          conviction_score: ms.master_score, breakdown: ms.breakdown,
          wyckoff_phase: wy.phase, smart_money_confirmed, in_smc_zone, vol_spike,
          outcome, rewardPct, riskPct,
        });
      }
      scanned++;
    }
  }

  console.log(`As-of points scanned: ${scanned}`);
  console.log(`Total pattern events: ${events.length}\n`);

  const decided = events.filter(e => e.outcome !== 'NO_HIT');
  const noHit = events.length - decided.length;
  console.log(`Decided (WIN or LOSS): ${decided.length}, NO_HIT (never resolved in ${MAX_HOLD}d): ${noHit}\n`);

  function winRate(arr) {
    if (!arr.length) return { n: 0, wr: 0 };
    const wins = arr.filter(e => e.outcome === 'WIN').length;
    return { n: arr.length, wr: (wins / arr.length * 100) };
  }

  console.log('='.repeat(80));
  console.log('1. OVERALL WIN RATE + EXPECTANCY (target hit before stop-loss)');
  console.log('='.repeat(80));
  {
    const r = winRate(decided);
    const avgRewardPct = decided.filter(e=>e.outcome==='WIN').reduce((s,e)=>s+e.rewardPct,0) / (decided.filter(e=>e.outcome==='WIN').length || 1);
    const avgRiskPct = decided.filter(e=>e.outcome==='LOSS').reduce((s,e)=>s+e.riskPct,0) / (decided.filter(e=>e.outcome==='LOSS').length || 1);
    const winFrac = r.wr / 100, lossFrac = 1 - winFrac;
    const expectancyPct = winFrac * avgRewardPct - lossFrac * avgRiskPct;
    console.log(`n=${r.n}, winRate=${r.wr.toFixed(1)}%`);
    console.log(`Avg reward on WIN (target distance): +${avgRewardPct.toFixed(2)}%  |  Avg risk on LOSS (stop distance): -${avgRiskPct.toFixed(2)}%`);
    console.log(`Expectancy per trade = winRate*avgReward - lossRate*avgRisk = ${expectancyPct >= 0 ? '+' : ''}${expectancyPct.toFixed(3)}% ${expectancyPct <= 0 ? '<<< NEGATIVE despite high win rate' : ''}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('2. WIN RATE BY PATTERN TYPE');
  console.log('='.repeat(80));
  const types = [...new Set(decided.map(e => e.pattern_type))];
  for (const t of types) {
    const r = winRate(decided.filter(e => e.pattern_type === t));
    console.log(`${t.padEnd(12)}: n=${r.n}, winRate=${r.wr.toFixed(1)}%`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('3. WIN RATE BY CONVICTION SCORE TIER (does the composite score work?)');
  console.log('='.repeat(80));
  const tiers = [[0,25],[25,38],[38,50],[50,62],[62,78],[78,101]];
  for (const [lo,hi] of tiers) {
    const r = winRate(decided.filter(e => e.conviction_score >= lo && e.conviction_score < hi));
    console.log(`score ${String(lo).padStart(3)}-${String(hi-1).padStart(3)}: n=${r.n}, winRate=${r.wr.toFixed(1)}%`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('4. MARGINAL LIFT PER COMPONENT (does this signal alone predict outcome?)');
  console.log('='.repeat(80));
  {
    const wy_favorable = decided.filter(e => ['SPRING','SIGN_OF_STRENGTH','SOS','LPS'].includes(e.wyckoff_phase));
    const wy_other = decided.filter(e => !['SPRING','SIGN_OF_STRENGTH','SOS','LPS'].includes(e.wyckoff_phase));
    console.log(`Wyckoff favorable phase: ${JSON.stringify(winRate(wy_favorable))} vs other: ${JSON.stringify(winRate(wy_other))}`);

    const smc_yes = decided.filter(e => e.in_smc_zone);
    const smc_no = decided.filter(e => !e.in_smc_zone);
    console.log(`In SMC zone (OB/FVG): ${JSON.stringify(winRate(smc_yes))} vs not: ${JSON.stringify(winRate(smc_no))}`);

    const vol_yes = decided.filter(e => e.vol_spike);
    const vol_no = decided.filter(e => !e.vol_spike);
    console.log(`Volume spike: ${JSON.stringify(winRate(vol_yes))} vs not: ${JSON.stringify(winRate(vol_no))}`);

    const sm_yes = decided.filter(e => e.smart_money_confirmed);
    const sm_no = decided.filter(e => !e.smart_money_confirmed);
    console.log(`Smart money confirmed (foreign+bigmoney aligned): ${JSON.stringify(winRate(sm_yes))} vs not: ${JSON.stringify(winRate(sm_no))}`);

    const rr_high = decided.filter(e => e.risk_reward >= 2);
    const rr_low = decided.filter(e => e.risk_reward < 2);
    console.log(`Risk:Reward >= 2: ${JSON.stringify(winRate(rr_high))} vs < 2: ${JSON.stringify(winRate(rr_low))}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('5. SPLIT-HALF VALIDATION (out-of-sample-style regime check)');
  console.log('='.repeat(80));
  {
    const dates = [...new Set(decided.map(e => e.asOfDate))].sort();
    const midDate = dates[Math.floor(dates.length / 2)];
    console.log(`Date range: ${dates[0]} to ${dates[dates.length-1]}, split point: ${midDate}\n`);

    for (const [label, arr] of [['HALF 1 (earlier)', decided.filter(e => e.asOfDate < midDate)], ['HALF 2 (later)', decided.filter(e => e.asOfDate >= midDate)]]) {
      const r = winRate(arr);
      const wins = arr.filter(e => e.outcome === 'WIN');
      const losses = arr.filter(e => e.outcome === 'LOSS');
      const avgRewardPct = wins.reduce((s,e)=>s+e.rewardPct,0) / (wins.length || 1);
      const avgRiskPct = losses.reduce((s,e)=>s+e.riskPct,0) / (losses.length || 1);
      const winFrac = r.wr / 100, lossFrac = 1 - winFrac;
      const expectancyPct = winFrac * avgRewardPct - lossFrac * avgRiskPct;
      console.log(`${label}: n=${r.n}, winRate=${r.wr.toFixed(1)}%, avgReward=+${avgRewardPct.toFixed(2)}%, avgRisk=-${avgRiskPct.toFixed(2)}%, expectancy=${expectancyPct>=0?'+':''}${expectancyPct.toFixed(3)}%`);

      // ABCD-only breakdown (dominant pattern type) since it drives the aggregate
      const abcd = arr.filter(e => e.pattern_type === 'ABCD');
      console.log(`  (ABCD only: n=${abcd.length}, winRate=${winRate(abcd).wr.toFixed(1)}%)`);

      // Smart money confirmed breakdown within this half
      const sm = arr.filter(e => e.smart_money_confirmed);
      const noSm = arr.filter(e => !e.smart_money_confirmed);
      console.log(`  (Smart money confirmed: n=${sm.length}, winRate=${winRate(sm).wr.toFixed(1)}% | not confirmed: n=${noSm.length}, winRate=${winRate(noSm).wr.toFixed(1)}%)`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
