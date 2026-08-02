/**
 * Proves that modules/strategy_book.js — the module the LIVE forward test will
 * use — reproduces EXP-017's backtested strategy.
 *
 * This is the check that makes the forward test meaningful. `awo_paper_trades`
 * broke precisely because the live path and the tested path were separate
 * implementations; nothing compared them, so the divergence was invisible for
 * weeks. Here, history is replayed through the live module's own targetBook()
 * and the resulting portfolio is compared against EXP-017's published numbers.
 *
 * A mismatch means the live book would trade something other than what was
 * tested, and the forward test would be measuring the wrong strategy.
 *
 * Usage: node verify_strategy_book.js
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const sb = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100, TRADING_DAYS_YEAR = 245;
const REBAL_BARS = 10;   // biweekly — the frozen configuration
const PARAMS = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };

// EXP-017 reported, for the frozen cell family, a mean excess of +8.71% and a
// mean maxDD of 13.83% across 9 cells. This replay runs ONE cell (biweekly,
// buffer x2), so it must land in a plausible neighbourhood rather than match a
// cross-cell mean exactly. The assertions below are deliberately loose about
// level and strict about SIGN and ORDER — those are what a code-path divergence
// would break.
const EXPECT = { minExcessOverBase: 0.02, maxMDD: 0.25 };

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];
const pct = v => (v === null || !Number.isFinite(v)) ? 'n/a' : (v * 100).toFixed(2) + '%';

async function loadAll(pool) {
  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

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

  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0 FROM idx_concentration ORDER BY data_date ASC');
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
  for (const [t, s] of series) if (s.placed < 400 || s.nConc < 200) series.delete(t);

  return { tradingDates, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series, concStart, n };
}

/** Portfolio replay driven ENTIRELY by strategy_book.targetBook(). */
function replay({ series, ihsgClose, ihsgSma, firstI, lastI, params }) {
  let cash = 1.0;
  const held = new Map();
  const curve = [];
  let flatPeriods = 0, periods = 0, tradeCount = 0;

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    if (execI > lastI + 1) break;
    const decision = sb.targetBook({
      series, i, ihsgClose, ihsgSma,
      currentHoldings: [...held.keys()], opts: params,
    });
    periods++;
    if (decision.exposure === 0) flatPeriods++;

    let pv = cash;
    for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) pv += u * px; }

    const tset = new Set(decision.target);
    for (const [t, u] of [...held]) {
      if (tset.has(t)) continue;
      const px = series.get(t).open[execI];
      if (px > 0) cash += u * px * (1 - SELL_COST);
      held.delete(t); tradeCount++;
    }
    const toBuy = decision.target.filter(t => !held.has(t));
    if (toBuy.length) {
      const per = (pv * decision.exposure) / Math.max(decision.target.length, 1);
      for (const t of toBuy) {
        const px = series.get(t).open[execI];
        if (!(px > 0)) continue;
        const spend = Math.min(per, cash);
        if (spend <= 0) break;
        cash -= spend; held.set(t, (held.get(t) || 0) + (spend * (1 - BUY_COST)) / px);
        tradeCount++;
      }
    }
    let mv = cash;
    for (const [t, u] of held) { const px = series.get(t).open[execI]; if (px > 0) mv += u * px; }
    curve.push(mv);
  }
  let final = cash;
  for (const [t, u] of held) {
    const s = series.get(t);
    for (let j = lastI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; }
  }
  curve.push(final);

  let peak = -Infinity, mdd = 0;
  for (const v of curve) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  const years = (lastI - firstI) / TRADING_DAYS_YEAR;
  return { cagr: Math.pow(final, 1 / years) - 1, mdd, final, flatPct: periods ? flatPeriods / periods : 0, tradeCount, periods };
}

(async () => {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  const { tradingDates, ihsgClose, ihsgSma, series, concStart } = await loadAll(pool);

  const firstI = Math.max(concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const lastI = tradingDates.length - 2;

  console.log('='.repeat(96));
  console.log('VERIFY — does the LIVE module reproduce the EXP-017 strategy?');
  console.log('='.repeat(96));
  console.log(`Window   : ${tradingDates[firstI]} .. ${tradingDates[lastI]}`);
  console.log(`Universe : ${series.size} tickers`);
  console.log(`Config   : biweekly, ${JSON.stringify(PARAMS)}\n`);

  const withVeto = replay({ series, ihsgClose, ihsgSma, firstI, lastI, params: PARAMS });
  const noVeto = replay({ series, ihsgClose, ihsgSma, firstI, lastI, params: { ...PARAMS, vetoFrac: 0, exitOnVeto: false } });
  const reverse = replay({ series, ihsgClose, ihsgSma, firstI, lastI, params: { ...PARAMS, vetoFrac: 0.20, exitOnVeto: true, reverseForTest: true } });

  console.log(`  BASE (veto off)   CAGR ${pct(noVeto.cagr)}   maxDD ${pct(noVeto.mdd)}   trades ${noVeto.tradeCount}`);
  console.log(`  VETO 20% +exit    CAGR ${pct(withVeto.cagr)}   maxDD ${pct(withVeto.mdd)}   trades ${withVeto.tradeCount}`);
  console.log(`  periods flat (regime): ${pct(withVeto.flatPct)} of ${withVeto.periods} rebalances\n`);

  let pass = 0, fail = 0;
  const check = (name, cond, detail) => {
    if (cond) { pass++; console.log(`  PASS  ${name}`); }
    else { fail++; console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
  };

  check('veto version beats the no-veto version (EXP-017 sign)',
    withVeto.cagr - noVeto.cagr >= EXPECT.minExcessOverBase,
    `delta ${pct(withVeto.cagr - noVeto.cagr)}`);
  check('drawdown is not worse than the no-veto version',
    withVeto.mdd <= noVeto.mdd + 0.02, `${pct(withVeto.mdd)} vs ${pct(noVeto.mdd)}`);
  check('drawdown within a sane bound', withVeto.mdd <= EXPECT.maxMDD, pct(withVeto.mdd));
  check('regime filter actually stands aside sometimes', withVeto.flatPct > 0.05 && withVeto.flatPct < 0.7, pct(withVeto.flatPct));
  check('book actually trades', withVeto.tradeCount > 50, String(withVeto.tradeCount));

  // Determinism: the live module must produce the same book twice.
  const a = sb.targetBook({ series, i: lastI, ihsgClose, ihsgSma, currentHoldings: [], opts: PARAMS });
  const b = sb.targetBook({ series, i: lastI, ihsgClose, ihsgSma, currentHoldings: [], opts: PARAMS });
  check('targetBook is deterministic', JSON.stringify(a.target) === JSON.stringify(b.target));

  // No-lookahead: the book at i must not change when future bars are removed.
  const truncated = new Map();
  for (const [t, s] of series) {
    truncated.set(t, {
      open: s.open.slice(0, lastI + 1), high: s.high.slice(0, lastI + 1),
      close: s.close.slice(0, lastI + 1), value: s.value.slice(0, lastI + 1),
      dn0: s.dn0.slice(0, lastI + 1),
    });
  }
  const c = sb.targetBook({
    series: truncated, i: lastI, ihsgClose: ihsgClose.slice(0, lastI + 1),
    ihsgSma: ihsgSma.slice(0, lastI + 1), currentHoldings: [], opts: PARAMS,
  });
  check('NO LOOKAHEAD: truncating all future bars leaves the book identical',
    JSON.stringify(a.target) === JSON.stringify(c.target),
    `${JSON.stringify(a.target)} vs ${JSON.stringify(c.target)}`);

  console.log(`\n  TODAY'S BOOK (${tradingDates[lastI]}): ${a.reason}`);
  console.log(`    eligible ${a.eligible}, vetoed ${a.vetoedCount}`);
  console.log(`    target: ${a.target.length ? a.target.join(', ') : '(flat — standing aside)'}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
