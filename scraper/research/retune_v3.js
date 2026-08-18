/**
 * Re-tune HI52W_REGIME_BROKERVETO_V1 against the v3 concentration model.
 *
 * THE CONSTRAINT THAT SHAPES EVERYTHING: the window holds 56 rebalance
 * decisions. Sweeping a grid over that and reporting the best cell is not
 * tuning, it is picking the luckiest of N draws — and this project already has
 * one overfitting incident on record. So:
 *
 *   1. The harness must first REPRODUCE the golden fixture exactly. If the hash
 *      does not match, this is not the engine that runs in production and
 *      nothing below means anything.
 *   2. Selection happens WALK-FORWARD. Train on everything up to a point, pick
 *      a parameter, apply it to the next block only, roll forward. The score is
 *      built exclusively from blocks the parameter had not seen.
 *   3. The incumbent is replayed over the IDENTICAL out-of-sample blocks, so
 *      the comparison is like with like.
 *   4. The FULL grid is printed with its dispersion. A winner that beats the
 *      field by less than the field's own spread is noise wearing a rosette.
 */
// Loaded from the scraper root, not the cwd. Without the explicit path
// dotenv finds nothing here and db_config falls back to its defaults --
// which connects as the OLD shared erp_user with no password and fails
// with a confusing 'Access denied' instead of saying the .env was missed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
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

// loader, verbatim from verify_strategy_book.js
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

// replay, verbatim, plus an optional opening portfolio so walk-forward blocks
// chain instead of resetting to cash at every boundary
function replay(ctx, firstI, lastI, params, start) {
  const { series, ihsgClose, ihsgSma, tradingDates } = ctx;
  let cash = start ? start.cash : 1.0;
  const held = start ? new Map(start.held) : new Map();
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
      vetoed: d.vetoedCount, book: d.target.slice().sort(),
      opened: opened.sort(), closed: closed.sort(),
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
    decisions, equity, trades, noFill, sellNoFill,
    costPaid: r6(costPaid), finalEquity: r6(final), maxDrawdown: r6(mdd),
    cagr: r6(Math.pow(final, 1 / years) - 1),
    endState: { cash, held: new Map(held) },
    hash: crypto.createHash('sha256')
      .update(JSON.stringify({ decisions, equity, trades, noFill, sellNoFill, costPaid: r6(costPaid), finalEquity: r6(final) }))
      .digest('hex').slice(0, 32),
  };
}

// Deliberately SMALL. vetoFrac is the parameter the concentration model
// actually feeds — posfrac ranks the cross-section, vetoFrac decides how much
// of the top gets cut. positions is included because book size interacts with
// how many names survive a veto. Everything else stays frozen: with 56
// decisions every extra axis multiplies the chances of getting lucky.
const GRID = [];
for (const vetoFrac of [0, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40])
  for (const positions of [6, 8, 10])
    GRID.push({ positions, bufferMult: 2, vetoFrac, exitOnVeto: vetoFrac > 0 });

const key = p => 'veto=' + String(p.vetoFrac).padEnd(4) + ' pos=' + p.positions;

(async () => {
  const pool = createPool();
  const ctx = await load(pool);
  const firstI = Math.max(ctx.concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  const lastI = ctx.tradingDates.indexOf(g.windowEnd);
  if (lastI < 0) throw new Error('fixture windowEnd is not in the series');

  console.log('window ' + ctx.tradingDates[firstI] + ' .. ' + ctx.tradingDates[lastI] + '  universe ' + ctx.series.size);

  const base = replay(ctx, firstI, lastI, INCUMBENT);
  const same = base.hash === g.hash;
  console.log('\nHARNESS CHECK  hash   ' + base.hash);
  console.log('               golden ' + g.hash + '  -> ' + (same ? 'IDENTICAL' : 'MISMATCH - everything below is void'));
  if (!same) { await pool.end(); process.exit(1); }
  console.log('incumbent full-sample: CAGR ' + (base.cagr * 100).toFixed(2) + '%  finalEq ' + base.finalEquity +
    '  maxDD ' + (base.maxDrawdown * 100).toFixed(2) + '%  decisions ' + base.decisions.length);

  const bars = [];
  for (let i = firstI; i <= lastI; i += REBAL_BARS) bars.push(i);
  const TRAIN = 24, STEP = 8;
  console.log('\nWALK-FORWARD  ' + bars.length + ' decision bars - train ' + TRAIN + ' - step ' + STEP);

  const segments = [];
  for (let s = TRAIN; s < bars.length; s += STEP) {
    segments.push({
      trainFrom: bars[0], trainTo: bars[s - 1],
      testFrom: bars[s], testTo: bars[Math.min(s + STEP, bars.length) - 1],
    });
  }

  const rows = [];
  let tunedState = null, incumbState = null;
  let tunedCap = 1, incumbCap = 1;

  for (const seg of segments) {
    let best = null;
    for (const p of GRID) {
      const r = replay(ctx, seg.trainFrom, seg.trainTo, p);
      if (!best || r.finalEquity > best.r.finalEquity) best = { p, r };
    }
    const t = replay(ctx, seg.testFrom, seg.testTo, best.p, tunedState || { cash: tunedCap, held: new Map() });
    const c = replay(ctx, seg.testFrom, seg.testTo, INCUMBENT, incumbState || { cash: incumbCap, held: new Map() });
    const tRet = t.finalEquity / tunedCap, cRet = c.finalEquity / incumbCap;
    tunedCap = t.finalEquity; incumbCap = c.finalEquity;
    tunedState = t.endState; incumbState = c.endState;
    rows.push({ seg, p: best.p, isEq: best.r.finalEquity, tRet, cRet, tCap: tunedCap, cCap: incumbCap });
  }

  console.log('\nwhat each fold chose, and what it then earned OUT of sample');
  console.log('  test window            picked            IS eq    OOS tuned   OOS incumbent');
  for (const r of rows) {
    console.log('  ' + ctx.tradingDates[r.seg.testFrom] + '..' + ctx.tradingDates[r.seg.testTo] +
      '  ' + key(r.p) + '  ' + r.isEq.toFixed(4) +
      '   ' + ((r.tRet - 1) * 100).toFixed(2).padStart(7) + '%   ' + ((r.cRet - 1) * 100).toFixed(2).padStart(7) + '%');
  }
  console.log('\nchained OUT-OF-SAMPLE equity   tuned ' + tunedCap.toFixed(4) + '   incumbent ' + incumbCap.toFixed(4));
  const beat = rows.filter(r => r.tRet > r.cRet).length;
  console.log('folds where tuning won: ' + beat + ' of ' + rows.length);

  console.log('\nFULL-SAMPLE GRID (context only - NOT a selection criterion)');
  const full = GRID.map(p => ({ p, r: replay(ctx, firstI, lastI, p) }))
    .sort((a, b) => b.r.finalEquity - a.r.finalEquity);
  for (const { p, r } of full) {
    const mark = (p.vetoFrac === INCUMBENT.vetoFrac && p.positions === INCUMBENT.positions) ? '  <-- incumbent' : '';
    console.log('  ' + key(p) + '  CAGR ' + (r.cagr * 100).toFixed(2).padStart(6) + '%  finalEq ' + r.finalEquity.toFixed(4) +
      '  maxDD ' + (r.maxDrawdown * 100).toFixed(2).padStart(5) + '%  trades ' + String(r.trades).padStart(4) + mark);
  }
  const eqs = full.map(x => x.r.finalEquity);
  const mean = eqs.reduce((a, b) => a + b, 0) / eqs.length;
  const sd = Math.sqrt(eqs.reduce((a, b) => a + (b - mean) ** 2, 0) / eqs.length);
  console.log('\n  grid spread: best ' + Math.max(...eqs).toFixed(4) + '  worst ' + Math.min(...eqs).toFixed(4) +
    '  mean ' + mean.toFixed(4) + '  sd ' + sd.toFixed(4));

  await pool.end();
})().catch(e => { console.error('ERR', e.message, e.stack); process.exit(1); });
