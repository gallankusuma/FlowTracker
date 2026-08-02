/**
 * EXP-013 â€” Buffered HI52W Portfolio: net-of-cost excess over the universe
 *
 * QUESTION
 * --------
 * EXP-012 established that HI52W's top decile earns ~+2.4pp over the universe
 * across 60 days, but churns every ~2.7 weeks, and that ~4.4 round trips at
 * 0.50% would cost ~2.2% over the same window â€” very nearly the whole edge.
 *
 * So: can the SAME factor be traded at position-horizon turnover and still keep
 * a net excess? Two standard portfolio-construction levers, no new alpha bets:
 *   - rebalance frequency (weekly / biweekly / monthly)
 *   - buffering: hold a name until it falls out of the top K, where K > N,
 *     instead of dropping it the moment it leaves the top N.
 *
 * This is the project's first genuine PORTFOLIO backtest â€” positions, cash,
 * costs charged on actual trades, an equity curve, and drawdown â€” rather than a
 * per-signal or ranking study.
 *
 * BENCHMARK is the equal-weighted ELIGIBLE UNIVERSE, not IHSG. The eligible set
 * is already filtered for liquidity, 10-year history and (unavoidably)
 * survivorship; measuring against IHSG would credit the strategy with all of
 * that selection. Beating the universe it is drawn from is the honest bar.
 * IHSG is printed alongside for context only.
 *
 * EXECUTION MODEL
 *   - Rank on date t using closes/highs through t only.
 *   - Trade at t+1 OPEN (same convention as awo_optimizer's evaluateCandidateOutcome).
 *   - Equal cash weight at entry; existing positions are NOT trimmed back to
 *     equal weight on later rebalances. That is both what a retail semi-
 *     autonomous workflow actually does and the LOWER-cost assumption â€” flagged
 *     because it flatters the result slightly versus strict equal-weighting.
 *   - Costs: buy 0.20% (0.15 fee + 0.05 slippage), sell 0.30% (0.25 + 0.05),
 *     0.50% round trip â€” the same total this project assumes everywhere.
 *
 * SURVIVORSHIP: today's ticker list applied backwards; nothing delists mid-test.
 * This inflates a long-only momentum-ish strategy specifically, because the
 * names that went to zero are absent. SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_hi52w_portfolio.js [--positions 8] [--min-adv 5e9] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const cs = require('./modules/cross_sectional');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const WARMUP = 260;
const ADV_WINDOW = 20;
const DEFAULT_MIN_ADV = 5e9;
const MIN_ELIGIBLE = 25;
const BUY_COST = 0.20 / 100;
const SELL_COST = 0.30 / 100;
const HI_BARS = 252;
const TRADING_DAYS_YEAR = 245;

const REBALANCES = [
  { key: 'weekly', bars: 5 },
  { key: 'biweekly', bars: 10 },
  { key: 'monthly', bars: 21 },
];
/** Buffer expressed as a multiple of N: drop a holding only once it falls out
 *  of the top (mult x N) by score. mult=1 is "no buffer". */
const BUFFERS = [1, 2, 3];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { positions: 8, minAdv: DEFAULT_MIN_ADV, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--positions') out.positions = Number(a[++i]);
    else if (a[i] === '--min-adv') out.minAdv = Number(a[++i]);
    else if (a[i] === '--json') out.json = a[++i];
  }
  return out;
}

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];

function rollingMedian(arr, i, w) {
  if (i + 1 < w) return null;
  const s = arr.slice(i - w + 1, i + 1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Max drawdown of an equity curve, as a positive fraction. */
function maxDrawdown(curve) {
  let peak = -Infinity, mdd = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

function annualise(totalReturn, nDays) {
  const years = nDays / TRADING_DAYS_YEAR;
  return years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : null;
}

const pct = (v, d = 2) => (v === null || !Number.isFinite(v)) ? '    n/a' : (v * 100).toFixed(d).padStart(7) + '%';

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(112));
  console.log(`EXP-013 â€” Buffered HI52W Portfolio (${opts.positions} positions, long only, equal cash at entry)`);
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT â€” no ticker delists in this universe ***');
  console.log('='.repeat(112));

  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, close_price, high_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`
  );
  const series = new Map();
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    if (!series.has(r.stock_code)) {
      const n = tradingDates.length;
      series.set(r.stock_code, {
        open: new Array(n).fill(null), close: new Array(n).fill(null),
        high: new Array(n).fill(null), value: new Array(n).fill(null), placed: 0,
      });
    }
    const s = series.get(r.stock_code);
    s.open[i] = Number(r.open_price) || Number(r.close_price);
    s.close[i] = Number(r.close_price);
    s.high[i] = Number(r.high_price) || Number(r.close_price);
    s.value[i] = Number(r.value) || Number(r.close_price) * Number(r.volume || 0);
    s.placed++;
  }
  for (const [t, s] of series) if (s.placed < WARMUP + 100) series.delete(t);
  console.log(`\nAxis ${tradingDates[0]}..${tradingDates[tradingDates.length - 1]} (${tradingDates.length} days)   universe ${series.size} tickers`);
  console.log(`Costs: buy ${(BUY_COST * 100).toFixed(2)}% / sell ${(SELL_COST * 100).toFixed(2)}% (${((BUY_COST + SELL_COST) * 100).toFixed(2)}% round trip)   liquidity floor Rp ${(opts.minAdv / 1e9).toFixed(1)}bn\n`);

  /** Eligible names + HI52W score at bar i. Uses data through i only. */
  function crossSection(i) {
    const out = [];
    for (const [ticker, s] of series) {
      if (s.close[i] === null || i < HI_BARS) continue;
      if (s.open[i + 1] === null || !(s.open[i + 1] > 0)) continue; // must be tradeable next bar
      const adv = rollingMedian(s.value, i, ADV_WINDOW);
      if (adv === null || adv < opts.minAdv) continue;
      let hi = -Infinity;
      for (let j = i - HI_BARS + 1; j <= i; j++) if (s.high[j] !== null && s.high[j] > hi) hi = s.high[j];
      if (!(hi > 0)) continue;
      out.push({ ticker, score: (s.close[i] / hi) * 100 });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  const startIdx = WARMUP + HI_BARS - 260 + 1;
  const firstI = Math.max(WARMUP, HI_BARS);
  const lastI = tradingDates.length - 2; // need i+1 open

  /**
   * Run one variant. Returns equity curve at rebalance points plus stats.
   * mode 'strategy' uses the buffered top-N rule; 'universe' equal-weights
   * every eligible name (the benchmark), paying the same cost model on its own
   * (much smaller) turnover.
   */
  function simulateRange({ rebalBars, bufferMult, mode, lo, hi }) {
    const loI = lo === undefined ? firstI : lo;
    const hiI = hi === undefined ? lastI : hi;
    let cash = 1.0;
    const held = new Map(); // ticker -> units (value = units * price)
    const curve = [], curveDates = [];
    let trades = 0, rebalances = 0, costPaid = 0;

    for (let i = loI; i <= hiI; i += rebalBars) {
      const xs = crossSection(i);
      if (xs.length < MIN_ELIGIBLE) continue;
      const execI = i + 1;

      // Mark existing holdings at execution prices.
      let portValue = cash;
      for (const [t, units] of held) {
        const p = series.get(t).open[execI];
        if (p !== null && p > 0) portValue += units * p;
      }

      let target;
      if (mode === 'universe') {
        target = xs.map(x => x.ticker);
      } else {
        const rank = new Map(xs.map((x, idx) => [x.ticker, idx]));
        const keepLimit = opts.positions * bufferMult;
        // Keep held names still inside the buffer zone, best-ranked first.
        const keep = [...held.keys()]
          .filter(t => rank.has(t) && rank.get(t) < keepLimit)
          .sort((a, b) => rank.get(a) - rank.get(b))
          .slice(0, opts.positions);
        const keepSet = new Set(keep);
        const fill = xs.map(x => x.ticker)
          .filter(t => !keepSet.has(t))
          .slice(0, Math.max(0, opts.positions - keep.length));
        target = [...keep, ...fill];
      }
      const targetSet = new Set(target);

      // SELL everything not in target.
      for (const [t, units] of [...held]) {
        if (targetSet.has(t)) continue;
        const p = series.get(t).open[execI];
        if (p === null || !(p > 0)) { held.delete(t); continue; }
        const proceeds = units * p * (1 - SELL_COST);
        costPaid += units * p * SELL_COST;
        cash += proceeds;
        held.delete(t);
        trades++;
      }

      // BUY new names with an equal share of current portfolio value.
      const toBuy = target.filter(t => !held.has(t));
      if (toBuy.length) {
        const perName = portValue / target.length;
        for (const t of toBuy) {
          const p = series.get(t).open[execI];
          if (p === null || !(p > 0)) continue;
          const spend = Math.min(perName, cash);
          if (spend <= 0) break;
          const units = (spend * (1 - BUY_COST)) / p;
          costPaid += spend * BUY_COST;
          cash -= spend;
          held.set(t, (held.get(t) || 0) + units);
          trades++;
        }
      }

      rebalances++;
      let mv = cash;
      for (const [t, units] of held) {
        const p = series.get(t).open[execI];
        if (p !== null && p > 0) mv += units * p;
      }
      curve.push(mv);
      curveDates.push(tradingDates[execI]);
    }

    // Final liquidation at the last available close within the tested range.
    let final = cash;
    for (const [t, units] of held) {
      const s = series.get(t);
      for (let j = hiI; j >= 0; j--) {
        if (s.close[j] !== null && s.close[j] > 0) { final += units * s.close[j] * (1 - SELL_COST); break; }
      }
    }
    curve.push(final);

    const nDays = hiI - loI;
    const total = final - 1;
    const periodRets = [];
    for (let k = 1; k < curve.length; k++) periodRets.push(curve[k] / curve[k - 1] - 1);
    const perYearVol = periodRets.length > 1
      ? stats.stdDev(periodRets) * Math.sqrt(TRADING_DAYS_YEAR / rebalBars) : null;
    const cagr = annualise(total, nDays);

    return {
      total, cagr, mdd: maxDrawdown(curve), vol: perYearVol,
      sharpeish: perYearVol > 0 ? cagr / perYearVol : null,
      trades, rebalances, costPaid,
      turnoverPerRebal: rebalances ? trades / (2 * rebalances * opts.positions) : null,
      curve, curveDates,
    };
  }

  // â”€â”€ Benchmarks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const uni = simulateRange({ rebalBars: 21, bufferMult: 1, mode: 'universe' });
  const ihsgTotal = (() => {
    const a = ihsgClose[firstI + 1], b = ihsgClose[lastI];
    return a > 0 ? b / a - 1 : null;
  })();
  const nDays = lastI - firstI;

  console.log('BENCHMARKS');
  console.log(`  Eligible universe, equal weight   total ${pct(uni.total)}   CAGR ${pct(uni.cagr)}   maxDD ${pct(uni.mdd)}`);
  console.log(`  IHSG (context only)               total ${pct(ihsgTotal)}   CAGR ${pct(annualise(ihsgTotal, nDays))}`);

  // â”€â”€ Strategy grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\n' + '='.repeat(112));
  console.log('STRATEGY GRID â€” net of costs. "excess" = CAGR minus the equal-weight universe CAGR.');
  console.log('='.repeat(112));
  console.log('  rebalance   buffer      CAGR    excess     maxDD      vol   ret/vol   trades   turnover/rebal   cost paid');

  const results = [];
  for (const rb of REBALANCES) {
    for (const bm of BUFFERS) {
      const r = simulateRange({ rebalBars: rb.bars, bufferMult: bm, mode: 'strategy' });
      const excess = r.cagr - uni.cagr;
      results.push({ rebalance: rb.key, rebalBars: rb.bars, buffer: bm, ...r, excess });
      const label = bm === 1 ? 'none' : `top ${opts.positions * bm}`;
      console.log(
        `  ${rb.key.padEnd(10)} ${label.padEnd(9)} ${pct(r.cagr)} ${pct(excess)} ${pct(r.mdd)} ${pct(r.vol)}    ${(r.sharpeish === null ? 'n/a' : r.sharpeish.toFixed(2)).padStart(5)}   ${String(r.trades).padStart(5)}   ${pct(r.turnoverPerRebal, 1)}      ${pct(r.costPaid, 1)}`
      );
    }
  }

  // â”€â”€ Best variant detail â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const best = results.reduce((a, b) => (b.excess > a.excess ? b : a));
  console.log('\n' + '='.repeat(112));
  console.log(`BEST VARIANT: ${best.rebalance} rebalance, buffer = top ${opts.positions * best.buffer}`);
  console.log('='.repeat(112));
  console.log(`  net CAGR ${pct(best.cagr)}   universe ${pct(uni.cagr)}   excess ${pct(best.excess)}`);
  console.log(`  total cost paid over the run: ${pct(best.costPaid, 1)} of starting capital`);
  console.log(`  gross-of-cost CAGR would be roughly ${pct(annualise(best.total + best.costPaid, nDays))}`);

  // Per-year net excess for the best variant.
  const byYear = new Map();
  for (let k = 1; k < best.curve.length; k++) {
    const y = (best.curveDates[k - 1] || best.curveDates[best.curveDates.length - 1]).slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { s: 1, u: 1 });
    byYear.get(y).s *= best.curve[k] / best.curve[k - 1];
  }
  // Universe on the same rebalance clock, for a like-for-like yearly split.
  const uniSame = simulateRange({ rebalBars: best.rebalBars, bufferMult: 1, mode: 'universe' });
  for (let k = 1; k < uniSame.curve.length; k++) {
    const y = (uniSame.curveDates[k - 1] || uniSame.curveDates[uniSame.curveDates.length - 1]).slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, { s: 1, u: 1 });
    byYear.get(y).u *= uniSame.curve[k] / uniSame.curve[k - 1];
  }
  console.log('\n  PER-YEAR net return, strategy vs equal-weight universe:');
  console.log('    year   strategy   universe    excess');
  const years = [...byYear.keys()].sort();
  let winYears = 0, totYears = 0;
  for (const y of years) {
    const { s, u } = byYear.get(y);
    const sr = s - 1, ur = u - 1;
    if (Number.isFinite(sr) && Number.isFinite(ur)) { totYears++; if (sr > ur) winYears++; }
    console.log(`    ${y}   ${pct(sr)}   ${pct(ur)}  ${pct(sr - ur)}`);
  }
  console.log(`\n  years the strategy beat the universe: ${winYears}/${totYears}`);

  // â”€â”€ Robustness: split-half walk-forward over the SAME grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The full-sample grid above is jumpy across neighbouring parameter cells,
  // which is the signature of fitting noise rather than structure. The question
  // that matters is not "what was the best cell" but "would a cell chosen on the
  // first half have kept working in the second". EXP-004 applied the same test
  // to AWO Full; this applies it to the parameter choice itself.
  const midI = firstI + Math.floor((lastI - firstI) / 2);
  function runGrid(lo, hi, label) {
    const saveFirst = firstI, saveLast = lastI;
    const out = [];
    for (const rb of REBALANCES) {
      for (const bm of BUFFERS) {
        const r = simulateRange({ rebalBars: rb.bars, bufferMult: bm, mode: 'strategy', lo, hi });
        const u = simulateRange({ rebalBars: rb.bars, bufferMult: 1, mode: 'universe', lo, hi });
        out.push({ rebalance: rb.key, buffer: bm, cagr: r.cagr, uni: u.cagr, excess: r.cagr - u.cagr, mdd: r.mdd });
      }
    }
    console.log(`\n  ${label}  (${tradingDates[lo]} .. ${tradingDates[hi]})`);
    console.log('    rebalance   buffer     CAGR   universe    excess     maxDD');
    out.forEach(r => console.log(
      `    ${r.rebalance.padEnd(10)} ${(r.buffer === 1 ? 'none' : 'top ' + opts.positions * r.buffer).padEnd(8)} ${pct(r.cagr)}  ${pct(r.uni)}  ${pct(r.excess)}  ${pct(r.mdd)}`
    ));
    return out;
  }

  console.log('\n' + '='.repeat(112));
  console.log('ROBUSTNESS â€” split-half walk-forward on the parameter grid');
  console.log('='.repeat(112));
  const h1 = runGrid(firstI, midI, 'PERIOD 1');
  const h2 = runGrid(midI, lastI, 'PERIOD 2');

  const bestH1 = h1.reduce((a, b) => (b.excess > a.excess ? b : a));
  const sameCellH2 = h2.find(r => r.rebalance === bestH1.rebalance && r.buffer === bestH1.buffer);
  const bestH2 = h2.reduce((a, b) => (b.excess > a.excess ? b : a));
  console.log(`\n  Best cell in PERIOD 1: ${bestH1.rebalance} / ${bestH1.buffer === 1 ? 'no buffer' : 'top ' + opts.positions * bestH1.buffer} -> excess ${pct(bestH1.excess)}`);
  console.log(`  That SAME cell in PERIOD 2:                          -> excess ${pct(sameCellH2.excess)}`);
  console.log(`  Best cell in PERIOD 2: ${bestH2.rebalance} / ${bestH2.buffer === 1 ? 'no buffer' : 'top ' + opts.positions * bestH2.buffer} -> excess ${pct(bestH2.excess)}`);
  const p1pos = h1.filter(r => r.excess > 0).length, p2pos = h2.filter(r => r.excess > 0).length;
  console.log(`  Cells with positive excess: PERIOD 1 ${p1pos}/9, PERIOD 2 ${p2pos}/9`);
  const meanH1 = stats.mean(h1.map(r => r.excess)), meanH2 = stats.mean(h2.map(r => r.excess));
  console.log(`  MEAN excess across all 9 cells: PERIOD 1 ${pct(meanH1)}, PERIOD 2 ${pct(meanH2)}`);
  console.log('\n  The mean across cells is the honest read â€” the best cell is an upper bound');
  console.log('  chosen with hindsight, and a parameter that only works in one half is noise.');

  // â”€â”€ Verdict â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  console.log('\n' + '='.repeat(112));
  console.log('MECHANICAL VERDICT');
  console.log('='.repeat(112));
  console.log(`\n  Full-sample mean excess across all 9 cells: ${pct(stats.mean(results.map(r => r.excess)))}`);
  const positive = results.filter(r => r.excess > 0);
  if (!positive.length) {
    console.log('\n  NO variant beats the equal-weight eligible universe after costs.');
    console.log('  The HI52W ranking edge does not survive its own turnover at any tested');
    console.log('  rebalance frequency or buffer width. Do not build a strategy on it as-is.');
  } else {
    console.log(`\n  ${positive.length}/${results.length} variants beat the universe after costs; best excess ${pct(best.excess)} CAGR.`);
    console.log('  Before treating this as an edge: (1) survivorship bias flatters a long-only');
    console.log('  concentrated book more than it flatters the universe benchmark, because the');
    console.log('  strategy holds few names and the missing delistings would have been held by');
    console.log('  someone; (2) 9 variants were tested, so the best cell is an upper bound, not');
    console.log('  an expectation; (3) no ARA/ARB constraint is modelled yet â€” names gapping to');
    console.log('  auto-reject at the open are exactly the ones this factor wants to buy.');
  }

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify({
      universe: { total: uni.total, cagr: uni.cagr, mdd: uni.mdd },
      ihsgTotal, positions: opts.positions,
      grid: results.map(({ curve, curveDates, ...r }) => r), best: { rebalance: best.rebalance, buffer: best.buffer, excess: best.excess },
    }, null, 2));
    console.log(`\n  JSON written to ${opts.json}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });

