/**
 * The first sweep put the optimum at vetoFrac = 0.40, which was the EDGE of the
 * grid. An edge solution says the grid was too narrow, not that the edge is
 * best, so this pushes past it and asks two questions the headline number
 * cannot answer on its own:
 *
 *   1. Does the curve keep rising past 0.40, and if so, where does it turn?
 *      A monotone climb all the way to a veto that empties the book is not a
 *      strategy improving, it is a strategy disappearing.
 *   2. What is actually IN the book at the top? If a high vetoFrac works by
 *      shrinking the book to two or three names, the return is concentration
 *      risk, not signal.
 *
 * Also resolves the fourth walk-forward fold, which returned exactly 0.00% for
 * both arms - that is either a flat regime with exposure 0 or a block with no
 * executed decision, and the two mean very different things.
 */
// Loaded from the scraper root, not the cwd. Without the explicit path
// dotenv finds nothing here and db_config falls back to its defaults --
// which connects as the OLD shared erp_user with no password and fails
// with a confusing 'Access denied' instead of saying the .env was missed.
const env = require('./env');
env.loadEnv();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPool } = require('../modules/db_config');
const sb = require('../modules/strategy_book');
const exec = require('../modules/execution');

const GOLDEN = path.join(__dirname, '..', 'fixtures', 'strategy_book.golden.json');
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100, TRADING_DAYS_YEAR = 245;
const REBAL_BARS = 10;
const INCUMBENT = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };

const toDateStr = d => d instanceof Date
  ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  : String(d).split('T')[0];
const r6 = v => (v === null || !Number.isFinite(v)) ? null : Math.round(v * 1e6) / 1e6;

async function load(pool) {
  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;
  const [priceRows] = await pool.query(
    'SELECT stock_code, date, open_price, high_price, close_price, volume, value FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC');
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
  return { tradingDates, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series, concStart };
}

function replay(ctx, firstI, lastI, params) {
  const { series, ihsgClose, ihsgSma, tradingDates } = ctx;
  let cash = 1.0;
  const held = new Map();
  const decisions = [], equity = [];
  let trades = 0, costPaid = 0, noFill = 0, sellNoFill = 0;

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    if (execI > lastI + 1) break;
    const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: [...held.keys()], opts: params });
    const pv = cash + exec.markToMarket(held, series, execI).value;
    const tset = new Set(d.target);
    const closed = [], opened = [];
    for (const [t, u] of [...held]) {
      if (tset.has(t)) continue;
      const px = exec.sellFill(series.get(t), execI);
      if (px === null) { sellNoFill++; continue; }
      const fee = u * px * SELL_COST;
      cash += u * px - fee; costPaid += fee; trades++;
      closed.push(t); held.delete(t);
    }
    for (const t of d.target.filter(x => !held.has(x))) {
      const px = series.get(t).open[execI];
      if (!(px > 0)) { noFill++; continue; }
      const spend = Math.min(pv / Math.max(d.target.length, 1) * d.exposure, cash);
      if (spend <= 0) continue;
      const fee = spend * BUY_COST;
      cash -= spend; costPaid += fee; trades++;
      held.set(t, (spend - fee) / px);
      opened.push(t);
    }
    const mv = cash + exec.markToMarket(held, series, execI).value;
    equity.push(r6(mv));
    decisions.push({
      date: tradingDates[i], exposure: d.exposure, eligible: d.eligible,
      vetoed: d.vetoedCount, bookSize: d.target.length,
    });
  }

  let final = cash;
  for (const [t, u] of held) {
    const s = series.get(t);
    for (let j = lastI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; }
  }
  let peak = -Infinity, mdd = 0;
  for (const v of equity.concat([final])) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  const years = (lastI - firstI) / TRADING_DAYS_YEAR;
  return {
    decisions, equity, trades,
    finalEquity: r6(final), maxDrawdown: r6(mdd),
    cagr: r6(Math.pow(final, 1 / years) - 1),
  };
}

(async () => {
  const pool = createPool();
  const ctx = await load(pool);
  const firstI = Math.max(ctx.concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const lastI = ctx.tradingDates.indexOf(g.windowEnd);

  console.log('PUSHING PAST THE EDGE — full sample ' + ctx.tradingDates[firstI] + ' .. ' + ctx.tradingDates[lastI]);
  console.log('  veto   pos   CAGR     finalEq    maxDD    trades   median book   min book   zero-book decisions');
  for (const positions of [6, 8]) {
    for (const vetoFrac of [0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80]) {
      const r = replay(ctx, firstI, lastI, { positions, bufferMult: 2, vetoFrac, exitOnVeto: true });
      const sizes = r.decisions.map(d => d.bookSize).sort((a, b) => a - b);
      const med = sizes[sizes.length >> 1];
      const zero = sizes.filter(x => x === 0).length;
      console.log('  ' + String(vetoFrac).padEnd(6) + String(positions).padEnd(6) +
        (r.cagr * 100).toFixed(2).padStart(7) + '%  ' + r.finalEquity.toFixed(4).padStart(8) +
        '  ' + (r.maxDrawdown * 100).toFixed(2).padStart(6) + '%  ' + String(r.trades).padStart(6) +
        '  ' + String(med).padStart(11) + '  ' + String(sizes[0]).padStart(9) + '  ' + String(zero).padStart(10));
    }
  }

  // The fourth walk-forward fold returned exactly 0.00% for BOTH arms.
  const bars = [];
  for (let i = firstI; i <= lastI; i += REBAL_BARS) bars.push(i);
  const seg = { from: bars[48], to: bars[Math.min(56, bars.length) - 1] };
  const r = replay(ctx, seg.from, seg.to, INCUMBENT);
  console.log('\nWHY FOLD 4 WAS FLAT — ' + ctx.tradingDates[seg.from] + '..' + ctx.tradingDates[seg.to]);
  for (const d of r.decisions) {
    console.log('  ' + d.date + '  exposure ' + d.exposure + '  eligible ' + String(d.eligible).padStart(3) +
      '  vetoed ' + String(d.vetoed).padStart(3) + '  book ' + d.bookSize);
  }
  await pool.end();
})().catch(env.fail);
