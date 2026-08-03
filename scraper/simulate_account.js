/**
 * Account simulation — what using this strategy actually looks like.
 *
 * Every prior experiment reported information coefficients, expectancy in R and
 * excess CAGR. None of them answered the question an actual user has: what does
 * this thing tell me to do, how often does it tell me to do nothing, and what
 * does the account balance look like along the way.
 *
 * Uses modules/strategy_book.js — the same code path as the backtest and the
 * live forward recorder, so this is the tested strategy and not a re-derivation.
 *
 * TWO REALISM ITEMS THE BACKTESTS OMITTED
 *   - IDX trades in lots of 100 shares. You cannot buy 37 shares of anything, so
 *     every position rounds DOWN to a whole lot and the remainder sits in cash.
 *     On a small account, or on expensive stocks, that drag is real.
 *   - The leftover cash earns nothing and is shown explicitly.
 *
 * NOT MODELLED, and each would make results worse, not better:
 *   - minimum brokerage fees per transaction (broker-specific; unknown here)
 *   - ARA/ARB auto-reject: the names this strategy wants are disproportionately
 *     the ones gapping limit-up at the open, i.e. unbuyable at the assumed price
 *   - bid/ask spread beyond the flat slippage assumption
 *   - survivorship bias in the universe, which flatters everything
 *
 * Usage: node simulate_account.js [--capital 100000000] [--positions 8] [--verbose]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const exec = require('./modules/execution');
const sb = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const LOT = 100;                                  // IDX board lot
const FEE_BUY = 0.0015, FEE_SELL = 0.0025, SLIP = 0.0005;
const REBAL_BARS = 10;
const PARAMS = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { capital: 100_000_000, positions: 8, verbose: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--capital') o.capital = Number(a[++i]);
    else if (a[i] === '--positions') o.positions = Number(a[++i]);
    else if (a[i] === '--verbose') o.verbose = true;
  }
  return o;
}

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];
const rp = v => 'Rp ' + Math.round(v).toLocaleString('en-US');
const pc = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';

async function main() {
  const o = parseArgs();
  PARAMS.positions = o.positions;
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const dates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  const n = dates.length;
  const ihsgSma = sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma);

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
  let concStart = Infinity;
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s) continue;
    const v = sb.clipDn(r.dn0, sb.DEFAULTS.dnBound);
    if (v === null) continue;
    s.dn0[i] = v; s.nConc++;
    if (i < concStart) concStart = i;
  }
  // NO UNIVERSE FILTER HERE. Eligibility is decided per decision bar inside
  // strategy_book.crossSection(), from data through bar i only. This loader
  // used to run `if (s.placed < 400 || s.nConc < 200) series.delete(t)` --
  // lifetime counts over the WHOLE sample, so a ticker entered the 2024
  // universe only if the code already knew it would eventually reach 400 bars
  // and 200 broker observations by the end of the data (review P0.2). Deleting
  // here also made strategy_book.js's "ALL INPUTS ARE AS-OF" header vacuous:
  // the Map arrived pre-filtered with future knowledge before the module ran.

  const firstI = Math.max(concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const lastI = n - 2;

  console.log('='.repeat(94));
  console.log(`ACCOUNT SIMULATION — ${rp(o.capital)} starting capital, ${o.positions} positions, biweekly`);
  console.log(`${dates[firstI]} .. ${dates[lastI]}   (${((lastI - firstI) / 245).toFixed(1)} years)`);
  console.log('Board lot 100 shares. Fees 0.15% buy / 0.25% sell + 0.05% slippage each side.');
  console.log('='.repeat(94));

  let cash = o.capital;
  const held = new Map();          // ticker -> {lots, entryPx, entryDate}
  const equityCurve = [];
  const closedTrades = [];
  let decisions = 0, flatDecisions = 0, totalFees = 0, lotDragTotal = 0, sellNoFill = 0;
  let peak = o.capital, maxDD = 0, ddStart = null, worstDDWindow = null;

  const equityAt = (i, field) => {
    let v = cash;
    for (const [t, p] of held) {
      const px = series.get(t)[field][i];
      if (px > 0) v += p.lots * LOT * px;
    }
    return v;
  };

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: [...held.keys()], opts: PARAMS });
    decisions++;
    if (d.exposure === 0) flatDecisions++;

    const equityBefore = equityAt(execI, 'open');
    const lines = [];

    // SELL first, so the proceeds are available to buy with.
    for (const t of d.dropped) {
      const p = held.get(t);
      if (!p) continue;
      // A seller who cannot sell still owns the shares (review P0.1) -- the
      // position stays in the book and is retried at the next rebalance.
      const px = exec.sellFill(series.get(t), execI);
      if (px === null) { sellNoFill++; lines.push(`    HOLD  ${t.padEnd(5)} no fill -- not tradeable at the open`); continue; }
      const gross = p.lots * LOT * px;
      const fee = gross * (FEE_SELL + SLIP);
      cash += gross - fee; totalFees += fee;
      const pnl = (px - p.entryPx) / p.entryPx;
      closedTrades.push({ ticker: t, entryDate: p.entryDate, exitDate: dates[execI], pnl, value: gross });
      lines.push(`    SELL  ${t.padEnd(5)} ${String(p.lots).padStart(5)} lot @ ${String(Math.round(px)).padStart(6)}  = ${rp(gross).padStart(16)}   ${pc(pnl).padStart(8)}`);
      held.delete(t);
    }

    // BUY into the freed slots, equal cash weight, rounded down to whole lots.
    if (d.added.length) {
      const perName = (equityBefore * d.exposure) / Math.max(d.target.length, 1);
      for (const t of d.added) {
        const px = series.get(t).open[execI];
        if (!(px > 0)) continue;
        const costPerLot = LOT * px * (1 + FEE_BUY + SLIP);
        const lots = Math.floor(Math.min(perName, cash) / costPerLot);
        if (lots < 1) { lines.push(`    SKIP  ${t.padEnd(5)} — ${rp(perName)} buys less than one lot at ${Math.round(px)}`); continue; }
        const gross = lots * LOT * px;
        const fee = gross * (FEE_BUY + SLIP);
        const intended = Math.min(perName, cash);
        lotDragTotal += intended - (gross + fee);
        cash -= gross + fee; totalFees += fee;
        held.set(t, { lots, entryPx: px, entryDate: dates[execI] });
        lines.push(`    BUY   ${t.padEnd(5)} ${String(lots).padStart(5)} lot @ ${String(Math.round(px)).padStart(6)}  = ${rp(gross).padStart(16)}   fee ${rp(fee)}`);
      }
    }

    const equityNow = equityAt(execI, 'open');
    equityCurve.push({ date: dates[execI], equity: equityNow, invested: held.size, cash });
    if (equityNow > peak) { peak = equityNow; ddStart = dates[execI]; }
    const dd = peak > 0 ? (peak - equityNow) / peak : 0;
    if (dd > maxDD) { maxDD = dd; worstDDWindow = `${ddStart} -> ${dates[execI]}`; }

    if (o.verbose || lines.length) {
      const tag = d.exposure === 0 ? 'STAND ASIDE' : 'INVESTED';
      console.log(`\n${dates[i]}  ${tag}   equity ${rp(equityNow)}   (${held.size} positions, cash ${rp(cash)})`);
      if (d.exposure === 0 && lines.length) console.log('    reason: IHSG below its own 200-day average');
      lines.forEach(l => console.log(l));
    }
  }

  // Liquidate at the end so the final number is money in hand.
  for (const [t, p] of held) {
    const s = series.get(t);
    for (let j = lastI; j >= 0; j--) {
      if (s.close[j] > 0) {
        const gross = p.lots * LOT * s.close[j];
        const fee = gross * (FEE_SELL + SLIP);
        cash += gross - fee; totalFees += fee;
        closedTrades.push({ ticker: t, entryDate: p.entryDate, exitDate: dates[j], pnl: (s.close[j] - p.entryPx) / p.entryPx, value: gross });
        break;
      }
    }
  }
  const finalEquity = cash;

  // IHSG over the same window, for context.
  const ihsgRet = ihsgClose[lastI] / ihsgClose[firstI + 1] - 1;
  const years = (lastI - firstI) / 245;
  const totalRet = finalEquity / o.capital - 1;

  console.log('\n' + '='.repeat(94));
  console.log('RESULT');
  console.log('='.repeat(94));
  console.log(`  Starting capital        ${rp(o.capital)}`);
  console.log(`  Ending capital          ${rp(finalEquity)}`);
  console.log(`  Profit / loss           ${rp(finalEquity - o.capital)}   ${pc(totalRet)}   over ${years.toFixed(1)} years`);
  console.log(`  Annualised              ${pc(Math.pow(1 + totalRet, 1 / years) - 1)}`);
  console.log(`  IHSG over the same span ${pc(ihsgRet)}`);
  console.log('');
  console.log(`  Worst drawdown          ${pc(-maxDD)}   ${worstDDWindow || ''}`);
  console.log(`  Total fees paid         ${rp(totalFees)}   (${((totalFees / o.capital) * 100).toFixed(1)}% of starting capital)`);
  console.log(`  Cash idle from lot rounding (cumulative intent not deployed): ${rp(lotDragTotal)}`);
  console.log('');
  console.log(`  Rebalance decisions     ${decisions}`);
  console.log(`  ...told you to do nothing: ${flatDecisions}  (${((flatDecisions / decisions) * 100).toFixed(0)}% of the time)`);
  console.log(`  Round trips             ${closedTrades.length}`);

  if (closedTrades.length) {
    const wins = closedTrades.filter(t => t.pnl > 0);
    const sorted = [...closedTrades].sort((a, b) => a.pnl - b.pnl);
    console.log(`  Win rate                ${((wins.length / closedTrades.length) * 100).toFixed(1)}%`);
    console.log(`  Best trade              ${sorted[sorted.length - 1].ticker} ${pc(sorted[sorted.length - 1].pnl)}`);
    console.log(`  Worst trade             ${sorted[0].ticker} ${pc(sorted[0].pnl)}`);
  }

  console.log('\n  What is NOT in these numbers, and each makes them worse:');
  console.log('    - minimum brokerage fees per transaction');
  console.log('    - ARA/ARB: the names this strategy wants are the ones most likely');
  console.log('      to gap limit-up at the open, i.e. unbuyable at the assumed price');
  console.log('    - survivorship bias: delisted names are absent from the universe');

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
