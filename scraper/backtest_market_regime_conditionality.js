/**
 * EXP-026 — MARKET REGIME CONDITIONALITY
 *
 * THE QUESTION, from the 2026-08-11 review round:
 *
 *     "How much does Signal Scanner performance depend on the state of IHSG?"
 *
 * and explicitly NOT "which regime rule is good". The review is clear that
 * picking `IHSG < MA20 = RISK_OFF` up front would be deciding the answer before
 * measuring it, so nothing here proposes a gate. This script measures how the
 * EXISTING scanner behaves conditional on market state, and stops there.
 *
 * WHY THIS COMES BEFORE THE OOS PRECURSOR TEST. EXP-025 described a
 * pre-breakout signature (Momentum/RS/Trend high, Buyer Breadth LOW) in-sample.
 * The review's argument is that any such signature still lives inside some
 * market environment, and that the scanner today answers "which stock is
 * relatively strong?" while the thing being asked of it is "is a long worth
 * taking?". Those are different questions and this experiment is built to keep
 * them apart.
 *
 * THE MEASUREMENT THAT SEPARATES THEM, and it is the point of the whole script:
 *
 *   ABSOLUTE   mean forward return of BUY signals in a regime.
 *              Answers "would a long have made money here".
 *   EXCESS     the same, minus the mean forward return of every scored stock
 *              in that same session.
 *              Answers "did the scanner PICK well here", with the market's own
 *              move divided out.
 *
 * If EXCESS stays positive across regimes while ABSOLUTE goes negative in the
 * bad ones, the review's hypothesis is confirmed in the precise form it was
 * stated: the stock engine is not broken, the market-permission layer is
 * missing. If EXCESS collapses too, that is a different and more serious
 * finding about the engine, and it must not be reported as the first one.
 *
 * DATE-BLOCKING IS NOT OPTIONAL HERE. Every stock in a session shares that
 * session's regime, so 27,719 scored rows are not 27,719 independent
 * observations of a regime effect — they are 121. Every statistic below is
 * computed per session first and aggregated across sessions, and every CI comes
 * from resampling whole sessions (`bootstrapMeanCI`). This is the same
 * correction EXP-025 needed when its "1,236 winner observations" turned out to
 * be 100 sessions.
 *
 * Usage:  node backtest_market_regime_conditionality.js [--horizon 5] [--json out.json]
 */
'use strict';
require('dotenv').config();
const mysql = require('mysql2/promise');
const cs = require('./modules/cross_sectional');

// ── provenance ──────────────────────────────────────────────────────────────
// One source only. `idx_signal_history` also holds 4,131 rows tagged `live`,
// which carry no f5_benchmark_version stamp at all, while the backfill is
// uniformly v1-idx245-2026-08-10. Mixing them would put two different F5
// benchmark definitions inside one cross-section, and F5 (relative strength) is
// precisely the factor this experiment is asking about. The 14 sessions that
// carry rows from both sources are the reason this is a filter and not an
// assumption: there are no duplicate ticker-days, so the two sources SPLIT
// those sessions rather than overlapping, and taking both would compare
// differently-benchmarked stocks inside a single session's ranking.
const SOURCE = 'backfill_v3_f5v1';

// A breakout, defined exactly as EXP-025 defined it, so the two experiments
// mean the same thing by the word: +5% at any point within the 5 forward
// sessions. max_profit is already that quantity, in percent.
const BREAKOUT_PCT = 5;

const iso = d => new Date(d).toISOString().slice(0, 10);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const smaAt = (arr, i, n) => (i + 1 < n ? null : mean(arr.slice(i - n + 1, i + 1)));
const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '  -  ' : v.toFixed(d));

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

/* ── 1. MARKET STATE FEATURES ───────────────────────────────────────────────
   Every feature the review listed, computed from the exchange's own index
   series. Deliberately raw and unweighted: this step describes the market, it
   does not score it. No feature here is combined into a "state" — that is
   EXP-027's job, and doing it now would be the shortcut the review warned
   against. */
function marketFeatures(close, i) {
  const ret = n => (i - n >= 0 ? (close[i] / close[i - n] - 1) * 100 : null);
  const ma20 = smaAt(close, i, 20), ma60 = smaAt(close, i, 60);
  const ma20prev = smaAt(close, i - 5, 20), ma60prev = smaAt(close, i - 5, 60);
  const hi20 = i >= 19 ? Math.max(...close.slice(i - 19, i + 1)) : null;
  const hi60 = i >= 59 ? Math.max(...close.slice(i - 59, i + 1)) : null;

  let vol20 = null;
  if (i >= 20) {
    const r = [];
    for (let k = i - 19; k <= i; k++) r.push((close[k] / close[k - 1] - 1) * 100);
    const m = mean(r);
    vol20 = Math.sqrt(mean(r.map(x => (x - m) ** 2)));
  }
  return {
    ihsgRet1d: ret(1), ihsgRet5d: ret(5), ihsgRet20d: ret(20),
    vsMa20: ma20 ? (close[i] / ma20 - 1) * 100 : null,
    vsMa60: ma60 ? (close[i] / ma60 - 1) * 100 : null,
    ma20Slope: (ma20 && ma20prev) ? (ma20 / ma20prev - 1) * 100 : null,
    ma60Slope: (ma60 && ma60prev) ? (ma60 / ma60prev - 1) * 100 : null,
    ddFrom20dHigh: hi20 ? (close[i] / hi20 - 1) * 100 : null,
    ddFrom60dHigh: hi60 ? (close[i] / hi60 - 1) * 100 : null,
    realizedVol20: vol20,
  };
}

/* ── 2. BREADTH ─────────────────────────────────────────────────────────────
   % of tracked stocks above their own 20-day MA, and % closing up. Computed
   from the price table per ticker rather than read from any factor, so it is an
   independent description of the market and not a restatement of F6. */
async function breadthByDate(pool, fromDate) {
  const [rows] = await pool.query(
    `SELECT stock_code, date, close_price c FROM idx_stock_prices
      WHERE date >= DATE_SUB(?, INTERVAL 60 DAY) ORDER BY stock_code, date ASC`, [fromDate]);
  const byTicker = new Map();
  for (const r of rows) {
    if (!byTicker.has(r.stock_code)) byTicker.set(r.stock_code, []);
    byTicker.get(r.stock_code).push({ d: iso(r.date), c: Number(r.c) });
  }
  const above = new Map(), up = new Map(), total = new Map();
  for (const series of byTicker.values()) {
    const cl = series.map(x => x.c);
    for (let i = 0; i < series.length; i++) {
      const d = series[i].d;
      const ma20 = smaAt(cl, i, 20);
      if (ma20 === null || i === 0) continue;
      total.set(d, (total.get(d) || 0) + 1);
      if (cl[i] > ma20) above.set(d, (above.get(d) || 0) + 1);
      if (cl[i] > cl[i - 1]) up.set(d, (up.get(d) || 0) + 1);
    }
  }
  const out = new Map();
  for (const [d, n] of total) {
    out.set(d, { pctAboveMa20: (above.get(d) || 0) / n * 100, pctUp: (up.get(d) || 0) / n * 100, breadthN: n });
  }
  return out;
}

/* ── 3. PER-SESSION SCANNER STATISTICS ──────────────────────────────────────
   One row per session. This is the unit of observation for everything after
   it — see the date-blocking note in the header. */
function sessionStats(rows, horizonCol) {
  const scored = rows.filter(r => r.composite_score !== null && r[horizonCol] !== null);
  if (scored.length < 10) return null;

  const scores = scored.map(r => Number(r.composite_score));
  const rets = scored.map(r => Number(r[horizonCol]));
  const universeMean = mean(rets);

  const buys = scored.filter(r => r.signal_type === 'BUY' || r.signal_type === 'STRONG BUY');
  const buyRets = buys.map(r => Number(r[horizonCol]));
  const withPath = buys.filter(r => r.max_profit !== null && r.max_drawdown !== null);

  return {
    n: scored.length,
    ic: cs.spearmanIC(scores, rets),
    universeMean,
    buyN: buys.length,
    buyMean: buyRets.length ? mean(buyRets) : null,
    // The whole point of the experiment: the market's own move removed.
    buyExcess: buyRets.length ? mean(buyRets) - universeMean : null,
    buyWinRate: buyRets.length ? buyRets.filter(x => x > 0).length / buyRets.length * 100 : null,
    buyBreakoutRate: withPath.length
      ? withPath.filter(r => Number(r.max_profit) >= BREAKOUT_PCT).length / withPath.length * 100 : null,
    buyMaxDD: withPath.length ? mean(withPath.map(r => Number(r.max_drawdown))) : null,
    // The same breakout rate over EVERY scored name, so the BUY rate can be
    // read against its own session's base rate rather than in the abstract.
    universeBreakoutRate: (() => {
      const w = scored.filter(r => r.max_profit !== null);
      return w.length ? w.filter(r => Number(r.max_profit) >= BREAKOUT_PCT).length / w.length * 100 : null;
    })(),
  };
}

/* ── 4. BUCKETING ───────────────────────────────────────────────────────────
   Terciles of a continuous feature, not a hand-picked threshold. A threshold is
   a rule, and choosing one here would answer EXP-027's question with EXP-026's
   data. Terciles also keep the cells balanced, which matters a great deal in
   this particular window — see the CONTRAST section of the output. */
function terciles(sessions, key) {
  const withVal = sessions.filter(s => s.market[key] !== null && s.market[key] !== undefined);
  if (withVal.length < 12) return null;
  const sorted = [...withVal].sort((a, b) => a.market[key] - b.market[key]);
  const t = Math.floor(sorted.length / 3);
  return [
    { label: 'LOW ', rows: sorted.slice(0, t) },
    { label: 'MID ', rows: sorted.slice(t, 2 * t) },
    { label: 'HIGH', rows: sorted.slice(2 * t) },
  ].map(g => ({
    ...g,
    range: [g.rows[0].market[key], g.rows[g.rows.length - 1].market[key]],
  }));
}

function agg(rows, field) {
  const v = rows.map(r => r.stats[field]).filter(x => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return { mean: null, ci: null, n: 0 };
  const ci = v.length >= 8 ? cs.bootstrapMeanCI(v, { resamples: 2000, seed: 26 }) : null;
  return { mean: mean(v), ci, n: v.length };
}

(async () => {
  const horizonDays = String(arg('horizon', '5'));
  const horizonCol = `return_${horizonDays}d`;
  if (!['return_1d', 'return_3d', 'return_5d', 'return_10d'].includes(horizonCol)) {
    throw new Error(`--horizon must be 1, 3, 5 or 10 (got ${horizonDays})`);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    waitForConnections: true, connectionLimit: 5,
  });

  console.log('='.repeat(94));
  console.log('EXP-026 — MARKET REGIME CONDITIONALITY');
  console.log(`horizon ${horizonDays}D (${horizonCol})   source '${SOURCE}'   breakout = max_profit >= ${BREAKOUT_PCT}% within 5 sessions`);
  console.log('='.repeat(94));

  // index series
  const [ih] = await pool.query('SELECT date, close_price c FROM idx_ihsg_history ORDER BY date ASC');
  const idates = ih.map(r => iso(r.date));
  const iclose = ih.map(r => Number(r.c));
  const idxOf = new Map(idates.map((d, i) => [d, i]));

  // signals
  const [sig] = await pool.query(
    `SELECT data_date, stock_code, composite_score, signal_type,
            return_1d, return_3d, return_5d, return_10d, max_profit, max_drawdown
       FROM idx_signal_history WHERE data_source = ? ORDER BY data_date ASC`, [SOURCE]);
  const byDate = new Map();
  for (const r of sig) {
    const d = iso(r.data_date);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }

  const firstDate = [...byDate.keys()].sort()[0];
  const breadth = await breadthByDate(pool, firstDate);

  // one row per session
  const sessions = [];
  let skippedNoIndex = 0, skippedThin = 0;
  for (const [d, rows] of [...byDate.entries()].sort()) {
    const i = idxOf.get(d);
    if (i === undefined) { skippedNoIndex++; continue; }
    const stats = sessionStats(rows, horizonCol);
    if (!stats) { skippedThin++; continue; }
    sessions.push({
      date: d,
      market: { ...marketFeatures(iclose, i), ...(breadth.get(d) || { pctAboveMa20: null, pctUp: null }) },
      stats,
    });
  }

  console.log(`\nsessions used: ${sessions.length}` +
    (skippedNoIndex ? `   (${skippedNoIndex} had no index bar)` : '') +
    (skippedThin ? `   (${skippedThin} too thin)` : ''));
  console.log(`window: ${sessions[0].date} .. ${sessions[sessions.length - 1].date}`);
  const totalBuy = sessions.reduce((s, x) => s + x.stats.buyN, 0);
  const totalObs = sessions.reduce((s, x) => s + x.stats.n, 0);
  console.log(`scored ticker-sessions: ${totalObs}   BUY/STRONG BUY: ${totalBuy}` +
    `   sessions with >=1 BUY: ${sessions.filter(s => s.stats.buyN > 0).length}`);

  // ── the unconditional picture, so every conditional number has a baseline ──
  const allIC = agg(sessions, 'ic');
  const allExcess = agg(sessions.filter(s => s.stats.buyN > 0), 'buyExcess');
  const allAbs = agg(sessions.filter(s => s.stats.buyN > 0), 'buyMean');
  const allUni = agg(sessions, 'universeMean');
  const icSeries = sessions.map(s => s.stats.ic).filter(x => x !== null);
  console.log('\nUNCONDITIONAL (all sessions pooled — the baseline the tables below move against)');
  console.log('-'.repeat(94));
  console.log(`  rank IC of composite_score vs ${horizonDays}D return : ${fmt(allIC.mean, 4)}` +
    (allIC.ci ? `  95% CI [${fmt(allIC.ci.lower, 4)}, ${fmt(allIC.ci.upper, 4)}]` : '') +
    `   IR ${fmt(cs.icInformationRatio(icSeries), 3)}   n=${allIC.n} sessions`);
  console.log(`  universe mean ${horizonDays}D return                  : ${fmt(allUni.mean)}%   <- what the market did`);
  console.log(`  BUY mean ${horizonDays}D return   (ABSOLUTE)          : ${fmt(allAbs.mean)}%` +
    (allAbs.ci ? `  95% CI [${fmt(allAbs.ci.lower)}, ${fmt(allAbs.ci.upper)}]` : ''));
  console.log(`  BUY minus universe same session (EXCESS)        : ${fmt(allExcess.mean)}%` +
    (allExcess.ci ? `  95% CI [${fmt(allExcess.ci.lower)}, ${fmt(allExcess.ci.upper)}]` : ''));

  // ── conditional tables ──
  const FEATURES = [
    ['ihsgRet20d', 'IHSG return 20D'],
    ['ihsgRet5d', 'IHSG return 5D'],
    ['vsMa20', 'IHSG vs MA20 (%)'],
    ['vsMa60', 'IHSG vs MA60 (%)'],
    ['ma20Slope', 'MA20 slope (5d, %)'],
    ['ma60Slope', 'MA60 slope (5d, %)'],
    ['ddFrom60dHigh', 'drawdown from 60D high'],
    ['realizedVol20', 'realized vol 20D'],
    ['pctAboveMa20', 'breadth: % > own MA20'],
    ['pctUp', 'breadth: % closing up'],
  ];

  const jsonOut = { horizon: horizonDays, source: SOURCE, sessions: sessions.length, unconditional: {
    ic: allIC, buyAbsolute: allAbs, buyExcess: allExcess, universe: allUni }, features: {} };

  for (const [key, label] of FEATURES) {
    const groups = terciles(sessions, key);
    if (!groups) { console.log(`\n${label}: not enough sessions with this feature`); continue; }
    console.log(`\n${label}`);
    console.log('-'.repeat(94));
    console.log('        range                sess  BUYs |  market   BUY abs   BUY excess [95% CI]      IC     breakout');
    const rec = [];
    for (const g of groups) {
      const withBuys = g.rows.filter(r => r.stats.buyN > 0);
      const ic = agg(g.rows, 'ic');
      const uni = agg(g.rows, 'universeMean');
      const abs = agg(withBuys, 'buyMean');
      const exc = agg(withBuys, 'buyExcess');
      const brk = agg(withBuys, 'buyBreakoutRate');
      const ubrk = agg(g.rows, 'universeBreakoutRate');
      const nBuys = g.rows.reduce((s, r) => s + r.stats.buyN, 0);
      console.log(
        `  ${g.label}  ${String(fmt(g.range[0]) + '..' + fmt(g.range[1])).padEnd(18)} ` +
        `${String(g.rows.length).padStart(4)} ${String(nBuys).padStart(5)} | ` +
        `${fmt(uni.mean).padStart(7)}% ${fmt(abs.mean).padStart(8)}% ` +
        `${fmt(exc.mean).padStart(9)}%` +
        `${exc.ci ? ` [${fmt(exc.ci.lower)},${fmt(exc.ci.upper)}]`.padEnd(16) : ' '.repeat(16)} ` +
        `${fmt(ic.mean, 4).padStart(7)} ` +
        `${fmt(brk.mean, 1).padStart(5)}%/${fmt(ubrk.mean, 1)}%`);
      rec.push({ bucket: g.label.trim(), range: g.range, sessions: g.rows.length, buys: nBuys,
                 universeMean: uni.mean, buyAbsolute: abs, buyExcess: exc, ic, breakout: brk.mean, universeBreakout: ubrk.mean });
    }
    jsonOut.features[key] = rec;
  }

  /* ── DECILES: is the score INVERTED, or is the BUY threshold miscalibrated? ──
     Two different faults produce a negative IC and they need different answers.
     If forward return falls monotonically as the score rises, the score itself
     carries inverted information. If instead only the top decile is bad, the
     ranking is fine and the BUY cutoff is sitting in the wrong place.

     EXP-010 is the precedent for asking: it found a ranking whose deciles were
     NON-monotonic, which meant the headline IC was hiding the real shape.
     Computed per session and averaged over sessions, for the same date-blocking
     reason as everything else here. */
  const decilesBySession = [];
  for (const [d, rows] of [...byDate.entries()].sort()) {
    const scored = rows.filter(r => r.composite_score !== null && r[horizonCol] !== null);
    if (scored.length < 30) continue;
    const b = cs.bucketByScore(scored.map(r => Number(r.composite_score)),
                              scored.map(r => Number(r[horizonCol])), 10);
    // EXCESS per decile, so a falling market cannot make every decile look bad.
    decilesBySession.push(b.buckets.map(x => (x.meanReturn === null ? null : x.meanReturn - b.universeMean)));
  }
  console.log(`\n\nSCORE DECILES — mean ${horizonDays}D return MINUS the session's own universe mean`);
  console.log(`(averaged over ${decilesBySession.length} sessions; D1 = lowest composite_score, D10 = highest)`);
  console.log('-'.repeat(94));
  const decileMeans = [];
  for (let k = 0; k < 10; k++) {
    const v = decilesBySession.map(row => row[k]).filter(x => x !== null);
    const m = mean(v);
    decileMeans.push(m);
    const ci = cs.bootstrapMeanCI(v, { resamples: 2000, seed: 26 });
    const bar = m === null ? '' : (m < 0 ? ' '.repeat(Math.max(0, 12 - Math.round(-m * 6))) + '#'.repeat(Math.min(12, Math.round(-m * 6))) + '|'
                                        : ' '.repeat(12) + '|' + '#'.repeat(Math.min(12, Math.round(m * 6))));
    console.log(`  D${String(k + 1).padStart(2)}  ${fmt(m).padStart(7)}%  [${fmt(ci.lower)},${fmt(ci.upper)}]  ${bar}`);
  }
  const topBottom = decileMeans[9] - decileMeans[0];
  console.log(`\n  D10 - D1 = ${fmt(topBottom)} percentage points` +
    `   (a working ranking is POSITIVE here; this is the spread the score is supposed to create)`);
  jsonOut.deciles = { excessByDecile: decileMeans, topMinusBottom: topBottom, sessions: decilesBySession.length };

  // ── ROBUSTNESS: overlapping forward windows ────────────────────────────────
  // modules/cross_sectional.js states the limit its own bootstrap cannot fix:
  // daily sampling with an H-day forward return makes consecutive sessions'
  // statistics serially correlated, so the CIs above are too NARROW. Re-run the
  // headline numbers on a subsample spaced H sessions apart, where the forward
  // windows do not overlap at all.
  const H = Number(horizonDays);
  const spaced = sessions.filter((_, i) => i % H === 0);
  const sIC = agg(spaced, 'ic');
  const sExc = agg(spaced.filter(s => s.stats.buyN > 0), 'buyExcess');
  const sAbs = agg(spaced.filter(s => s.stats.buyN > 0), 'buyMean');
  console.log('\n\nROBUSTNESS — non-overlapping subsample (every ' + H + 'th session, windows cannot overlap)');
  console.log('-'.repeat(94));
  console.log(`  sessions: ${spaced.length} of ${sessions.length}`);
  console.log(`  rank IC        ${fmt(sIC.mean, 4)}` + (sIC.ci ? `  95% CI [${fmt(sIC.ci.lower, 4)}, ${fmt(sIC.ci.upper, 4)}]` : ''));
  console.log(`  BUY absolute   ${fmt(sAbs.mean)}%` + (sAbs.ci ? `  95% CI [${fmt(sAbs.ci.lower)}, ${fmt(sAbs.ci.upper)}]` : ''));
  console.log(`  BUY excess     ${fmt(sExc.mean)}%` + (sExc.ci ? `  95% CI [${fmt(sExc.ci.lower)}, ${fmt(sExc.ci.upper)}]` : ''));
  jsonOut.robustness = { spacedSessions: spaced.length, ic: sIC, buyAbsolute: sAbs, buyExcess: sExc };

  const outFile = arg('json', null);
  if (outFile) {
    require('fs').writeFileSync(outFile, JSON.stringify(jsonOut, null, 1));
    console.log(`\nJSON -> ${outFile}`);
  }

  console.log('\n' + '='.repeat(94));
  console.log('READ THIS BEFORE QUOTING ANY NUMBER ABOVE');
  console.log('='.repeat(94));
  console.log(`  - N is ${sessions.length} SESSIONS, not ${totalObs} rows. Every stock in a session shares its`);
  console.log('    regime, so the rows are not independent observations of a regime effect.');
  console.log('  - ONE window, 2026-01-19 .. 2026-08-06, ~7 months, and a predominantly falling');
  console.log('    one. This is in-sample and describes this period, not IDX in general.');
  console.log('  - No rule is proposed here. Terciles are a way of reading the data, not a gate.');
  console.log('  - BUY counts per bucket are small; treat ABSOLUTE/EXCESS cells with <30 BUYs as');
  console.log('    directional at best. The IC column uses every scored name and is the stronger');
  console.log('    statistic of the two.');

  await pool.end();
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
