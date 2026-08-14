/**
 * Reselect the tracked IDX universe by MEASURED liquidity.
 *
 * THE PROBLEM
 * -----------
 * modules/tickers.js costs ~5 Index Alpha calls/ticker/day. A ticker whose
 * 20-day median traded value has never once reached strategy_book's minAdv
 * (Rp 5bn) can never be selected on any date, so every call spent on it is
 * waste. Meanwhile the roster of real IDX codes is ~3.5x larger than what we
 * track, and the quota has spare headroom.
 *
 * THE TEST: "EVER CLEARED", NOT "CLEARS TODAY"
 * -------------------------------------------
 * Selection is on the PEAK trailing 20-day median traded value over a
 * ticker's whole available history — did it EVER clear the bar. Screening on
 * current liquidity instead would rebuild exactly the survivorship bias review
 * item P0.2 exists to remove: a name that was liquid in 2024 and died in 2025
 * is precisely the kind of name a backtest universe must contain, because
 * excluding it means the backtest only ever sees names that survived.
 *
 * The same logic is why removals here are recorded with their measured peak in
 * the tickers.js header rather than quietly deleted. The 12 tickers dropped on
 * 2026-07-22 for looking "suspended/delisted" are the cautionary example: that
 * is a survivorship deletion, made on appearance rather than measurement.
 *
 * HOW LIQUIDITY IS MEASURED
 * -------------------------
 * With strategy_book.js's OWN exported rollingMedian(), on the shared IHSG
 * trading-date axis the backtests build — not a re-implementation. A screen
 * that decides which tickers exist must not be able to disagree with the
 * screen that decides which tickers trade, and the only way to guarantee that
 * is to call the same function.
 *
 * Both sides are directly comparable because idx_stock_prices.value is itself
 * exactly close_price * volume (verified: ratio 1.000000 across sampled
 * tickers), which is what the Yahoo-staged candidates carry too.
 *
 * Reads:  idx_ihsg_history (axis), idx_stock_prices (incumbents),
 *         idx_price_candidates (staged by universe_fetch_candidates.js)
 * Writes: nothing. Prints the proposal; editing tickers.js stays a human step.
 *
 * Usage: node universe_reselect.js [--max-tickers 600] [--min-adv 5e9] [--json out.json]
 */

'use strict';
require('dotenv').config();

const fs = require('fs');
const mysql = require('mysql2/promise');
const { IDX_TICKERS } = require('./modules/tickers');
const { rollingMedian, DEFAULTS } = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

// Taken from strategy_book.js DEFAULTS rather than restated, so a change to the
// strategy's liquidity floor cannot leave this screen silently measuring a
// different bar than the one that actually gates selection.
const MIN_ADV = DEFAULTS.minAdv;
const ADV_WINDOW = DEFAULTS.advWindow;
const CALLS_PER_TICKER = 5; // 1 broker-summary + 4 flow-detail
// idx_broker_summary and idx_concentration both start 2024-01-02. Nothing
// before that date can ever appear in a backtest, so peak liquidity is also
// reported restricted to this window — as context for ordering, never as a
// filter (filtering on it would be the recency screen this script exists to avoid).
const RESEARCH_START = '2024-01-02';
// rollingMedian() accepts a window holding as few as ONE real value — it medians
// whatever it finds. In strategy_book that looseness is harmless because
// minHiWindowBars (200 real bars in the trailing 252) independently blocks any
// name too new or too gappy to be traded. This screen has no such companion
// check, so without a floor a stock's "peak 20-day median" could be its
// listing-day turnover measured across a 1-bar window — WSBP scores Rp 782bn
// that way, off its 2016 IPO, versus Rp 148bn on any genuinely full window.
// Requiring most of the window to be real makes the peak mean what it says.
const MIN_REAL_IN_WINDOW = 15;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { maxTickers: 600, minAdv: MIN_ADV, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--max-tickers') out.maxTickers = parseInt(a[++i], 10);
    else if (a[i] === '--min-adv') out.minAdv = Number(a[++i]);
    else if (a[i] === '--json') out.json = a[++i];
  }
  return out;
}

const fmtBn = v => (v === null || v === undefined ? 'n/a' : `Rp ${(v / 1e9).toFixed(2)}bn`);
const ymd = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/**
 * Peak trailing ADV_WINDOW median traded value, plus when the bar was last
 * cleared. `values` is a gap-padded array on the shared trading-date axis
 * (null where the ticker did not trade), exactly the shape crossSection()
 * passes to rollingMedian — so the window spans 20 IHSG trading days and
 * medians whatever real values fall inside it, gaps and all.
 */
function liquidityProfile(values, axis, minAdv) {
  let peak = 0, peakDate = null;
  let peakResearch = 0, peakResearchDate = null;
  let lastCleared = null, firstCleared = null, clearedBars = 0;
  let bars = 0, first = null, last = null;

  for (let i = 0; i < axis.length; i++) {
    if (values[i] !== null && values[i] !== undefined) {
      bars++;
      if (!first) first = axis[i];
      last = axis[i];
    }
    // Only judge bars on which the ticker actually traded: a stale trailing
    // median carried across a long suspension is not evidence of liquidity.
    if (values[i] === null || values[i] === undefined) continue;
    let real = 0;
    for (let k = Math.max(0, i - ADV_WINDOW + 1); k <= i; k++) {
      if (values[k] !== null && values[k] !== undefined) real++;
    }
    if (real < MIN_REAL_IN_WINDOW) continue;
    const m = rollingMedian(values, i, ADV_WINDOW);
    if (m === null) continue;
    if (m > peak) { peak = m; peakDate = axis[i]; }
    if (axis[i] >= RESEARCH_START && m > peakResearch) { peakResearch = m; peakResearchDate = axis[i]; }
    if (m >= minAdv) {
      clearedBars++;
      lastCleared = axis[i];
      if (!firstCleared) firstCleared = axis[i];
    }
  }
  return {
    bars, first, last,
    peak, peakDate,
    peakResearch, peakResearchDate,
    firstCleared, lastCleared, clearedBars,
    everCleared: peak >= minAdv,
  };
}

/** Gap-padded `value` series per ticker on the shared axis. */
async function loadSeries(pool, table, codes, dateIdx, axisLen) {
  const out = new Map();
  const CHUNK = 60;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const slice = codes.slice(i, i + CHUNK);
    const [rows] = await pool.query(
      `SELECT stock_code, date, close_price, volume, value FROM ${table}
        WHERE stock_code IN (?) AND close_price > 0 ORDER BY stock_code, date ASC`,
      [slice]
    );
    for (const r of rows) {
      const idx = dateIdx.get(ymd(r.date));
      if (idx === undefined) continue; // off-axis day (axis is the IHSG calendar)
      if (!out.has(r.stock_code)) out.set(r.stock_code, new Array(axisLen).fill(null));
      out.get(r.stock_code)[idx] = Number(r.value) || Number(r.close_price) * Number(r.volume || 0);
    }
  }
  return out;
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 4 });

  // ---- shared trading-date axis (same one the backtests build) ------------
  const [ihsgRows] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const axis = ihsgRows.map(r => ymd(r.date));
  const dateIdx = new Map(axis.map((d, i) => [d, i]));
  console.log(`axis ${axis[0]}..${axis[axis.length - 1]} (${axis.length} trading days)\n`);

  // ---- incumbents ---------------------------------------------------------
  const incSeries = await loadSeries(pool, 'idx_stock_prices', IDX_TICKERS, dateIdx, axis.length);
  const incumbents = IDX_TICKERS.map(code => {
    const vals = incSeries.get(code) || new Array(axis.length).fill(null);
    return { code, ...liquidityProfile(vals, axis, opts.minAdv) };
  });

  const keep = incumbents.filter(t => t.everCleared);
  const drop = incumbents.filter(t => !t.everCleared).sort((a, b) => b.peak - a.peak);

  // ---- candidates ---------------------------------------------------------
  const [candRows] = await pool.query(
    `SELECT stock_code, status, bars FROM idx_price_candidate_fetch_log ORDER BY stock_code`
  );
  const fetched = candRows.filter(r => r.status === 'OK').map(r => r.stock_code);
  const noData = candRows.filter(r => r.status !== 'OK');

  const candSeries = await loadSeries(pool, 'idx_price_candidates', fetched, dateIdx, axis.length);
  const candidates = fetched.map(code => {
    const vals = candSeries.get(code) || new Array(axis.length).fill(null);
    return { code, ...liquidityProfile(vals, axis, opts.minAdv) };
  });

  const eligible = candidates.filter(t => t.everCleared);
  const rejected = candidates.filter(t => !t.everCleared);

  // ---- selection ----------------------------------------------------------
  const slots = opts.maxTickers - keep.length;
  // Rank by peak-ever: the same quantity the EVER-cleared test screens on, so
  // ordering and eligibility agree. A name whose peak is old still ranks on it.
  const ranked = [...eligible].sort((a, b) => b.peak - a.peak);
  const adds = ranked.slice(0, Math.max(0, slots));
  const cut = ranked.slice(Math.max(0, slots));

  // ---- report -------------------------------------------------------------
  const L = console.log;
  L('='.repeat(78));
  L(`UNIVERSE RESELECTION  —  bar = trailing ${ADV_WINDOW}-bar median value >= ${fmtBn(opts.minAdv)} (EVER)`);
  L('='.repeat(78));
  L('');
  L(`INCUMBENTS (${incumbents.length})`);
  L(`  ever cleared the bar : ${keep.length}`);
  L(`  NEVER cleared        : ${drop.length}   <- removal set`);
  L('');
  L(`CANDIDATES (roster minus tracked)`);
  L(`  fetched from Yahoo   : ${fetched.length}`);
  L(`  no Yahoo data        : ${noData.length}`);
  L(`  ever cleared the bar : ${eligible.length}   <- promotable`);
  L(`  never cleared        : ${rejected.length}`);
  L('');
  L(`SELECTION (cap ${opts.maxTickers})`);
  L(`  keep ${keep.length} + add ${adds.length} = ${keep.length + adds.length}`);
  if (cut.length) {
    L(`  NOT ADDED (cap reached): ${cut.length} eligible names left out — see below.`);
  }
  L('');
  L(`CALLS/DAY (${CALLS_PER_TICKER} calls/ticker/day)`);
  const before = incumbents.length * CALLS_PER_TICKER;
  const after = (keep.length + adds.length) * CALLS_PER_TICKER;
  const wasted = drop.length * CALLS_PER_TICKER;
  L(`  before : ${incumbents.length} x ${CALLS_PER_TICKER} = ${before}/day  (of which ${wasted}/day on the ${drop.length} unselectable names)`);
  L(`  after  : ${keep.length + adds.length} x ${CALLS_PER_TICKER} = ${after}/day`);
  L(`  monthly (x21 trading days): ${(after * 21).toLocaleString()} vs ~100,000 quota`);
  L('');

  L('-'.repeat(78));
  L(`REMOVALS — incumbents that NEVER cleared ${fmtBn(opts.minAdv)}, with measured peak`);
  L('-'.repeat(78));
  for (const t of drop) {
    L(`  ${t.code.padEnd(6)} peak ${fmtBn(t.peak).padStart(14)} @ ${t.peakDate || 'n/a'}   ` +
      `bars=${String(t.bars).padStart(4)} ${t.first || '?'}..${t.last || '?'}`);
  }
  L('');
  L('-'.repeat(78));
  L(`ADDITIONS — candidates that EVER cleared ${fmtBn(opts.minAdv)} (ranked by peak)`);
  L('-'.repeat(78));
  for (const t of adds) {
    L(`  ${t.code.padEnd(6)} peak ${fmtBn(t.peak).padStart(14)} @ ${t.peakDate}   ` +
      `lastCleared=${t.lastCleared}  clearedBars=${t.clearedBars}  peak2024+=${fmtBn(t.peakResearch)}`);
  }
  if (cut.length) {
    L('');
    L('-'.repeat(78));
    L(`ELIGIBLE BUT NOT ADDED — cap ${opts.maxTickers} reached (logged, not hidden)`);
    L('-'.repeat(78));
    for (const t of cut) {
      L(`  ${t.code.padEnd(6)} peak ${fmtBn(t.peak).padStart(14)} @ ${t.peakDate}   lastCleared=${t.lastCleared}`);
    }
  }
  L('');
  L('-'.repeat(78));
  L('CANDIDATES WITH NO YAHOO DATA (cannot be judged either way)');
  L('-'.repeat(78));
  L('  ' + (noData.map(r => `${r.stock_code}:${r.status}`).join(' ') || '(none)'));
  L('');

  // How stale are the additions? Reported, never filtered on.
  const staleness = adds.reduce((acc, t) => {
    const y = (t.lastCleared || '').slice(0, 4);
    acc[y] = (acc[y] || 0) + 1; return acc;
  }, {});
  L('ADDITION RECENCY (year of last bar that cleared the ADV bar) — reported, not screened:');
  L('  ' + Object.keys(staleness).sort().map(y => `${y}:${staleness[y]}`).join('  '));

  const finalList = [...keep.map(t => t.code), ...adds.map(t => t.code)].sort();
  L('');
  L('-'.repeat(78));
  L(`FINAL LIST (${finalList.length})`);
  L('-'.repeat(78));
  L(JSON.stringify(finalList));

  if (opts.json) {
    fs.writeFileSync(opts.json, JSON.stringify({
      generated: new Date().toISOString(), minAdv: opts.minAdv, advWindow: ADV_WINDOW,
      maxTickers: opts.maxTickers,
      keep, drop, adds, cut, rejectedCount: rejected.length,
      noData: noData.map(r => ({ code: r.stock_code, status: r.status })),
      finalList,
    }, null, 2));
    L(`\nwrote ${opts.json}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
