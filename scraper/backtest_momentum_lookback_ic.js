/**
 * EXP-011 — Momentum Lookback x Forward-Horizon IC Grid (10-year data)
 *
 * QUESTION
 * --------
 * Before rewriting F4 (currently ROC5x0.6 + ROC3x0.4 — a 3-5 day reading) to
 * something position-appropriate, does ANY momentum lookback actually predict
 * forward returns on IDX, and at which forward horizon?
 *
 * EXP-010 found the 6-factor blended momentum composite has ~zero IC at 5/10/20D
 * and a weak +0.010 at 60D. But a blend can hide a good sub-factor behind bad
 * ones, and it was measured on ~2 years of data. The registry's own named next
 * step was "isolate single sub-factor ICs before concluding momentum has no
 * signal in this market at all". This is that step, on the 10-year history
 * backfilled 2026-08-02.
 *
 * Deliberately NOT a strategy test: no entry timing, no stop, no target, no
 * fees. Pure "does this ranking sort future returns". A signal that fails here
 * cannot be rescued by a timing layer, so this gates the F4/F12/F2 rewrite.
 *
 * METHOD
 * ------
 * - Canonical trading-date axis from idx_ihsg_history (a ticker's own gaps must
 *   not shift its lookback windows relative to its peers).
 * - Per date: rank every eligible ticker by each lookback, correlate those ranks
 *   against forward returns at each horizon (tie-aware Spearman IC).
 * - Aggregate per (lookback, horizon): mean IC, IC information ratio, % positive
 *   dates, date-block bootstrap 95% CI, decile spread, top-decile excess.
 * - Also reported per calendar year, because a 10-year mean can hide a factor
 *   that worked until 2021 and inverted after.
 *
 * SAMPLING: weekly (every 5th trading day) is the PRIMARY read. Daily sampling
 * makes consecutive dates share almost all of their forward window, so the
 * per-date ICs are serially correlated and the bootstrap CI comes out too
 * narrow. Daily is also reported, for comparability with EXP-010 which used it.
 *
 * NO-LOOKAHEAD
 * ------------
 * Scores at date t use closes at t and earlier only. Forward returns use closes
 * strictly after t. A (ticker, date) pair lacking either a full lookback window
 * or a full forward window is SKIPPED, never zero-filled.
 *
 * SURVIVORSHIP: the universe is today's tracked ticker list applied backwards
 * over 10 years. Delisted/suspended names are absent. Results are
 * SURVIVORSHIP-BIASED RESEARCH RESULTS (Review.md item 4b) and the bias
 * inflates long-horizon momentum returns specifically, because the names that
 * went to zero are the ones missing.
 *
 * Usage: node backtest_momentum_lookback_ic.js [--sampling weekly|daily|both]
 *                                              [--min-adv 5e9] [--json out.json]
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

// ── Parameters ──────────────────────────────────────────────────────────────
const HORIZONS = [5, 10, 20, 40, 60];      // trading days forward; 40 = the POSITION max hold
const WARMUP = 273;                         // longest lookback (252) + skip (21)
const MIN_ELIGIBLE_PER_DAY = 25;            // a thinner cross-section makes IC meaningless
const ADV_WINDOW = 20;
const DEFAULT_MIN_ADV = 5e9;                // Rp 5bn median daily value — retail-tradeable floor
const BOOTSTRAP_RESAMPLES = 2000;
const RANDOM_SEED = 42;

/**
 * Lookbacks under test. `skip` implements the classic 12-1 convention: measure
 * momentum up to `skip` days ago, so the most recent month — which carries a
 * well-documented short-term REVERSAL effect that fights momentum — is excluded.
 */
const LOOKBACKS = [
  { key: 'ROC5',        bars: 5,   skip: 0,  note: 'what F4 effectively reads today' },
  { key: 'ROC20',       bars: 20,  skip: 0,  note: '1 month' },
  { key: 'ROC60',       bars: 60,  skip: 0,  note: '3 months' },
  { key: 'ROC120',      bars: 120, skip: 0,  note: '6 months' },
  { key: 'ROC252',      bars: 252, skip: 0,  note: '12 months' },
  { key: 'ROC252_sk21', bars: 252, skip: 21, note: 'classic 12-1 momentum' },
  { key: 'ROC120_sk21', bars: 120, skip: 21, note: '6-1 momentum' },
  { key: 'HI52W',       bars: 252, skip: 0,  note: 'proximity to 52w high', kind: 'hi52w' },
  { key: 'EMA50slope',  bars: 20,  skip: 0,  note: 'EMA50 slope over 20d', kind: 'ema50slope' },
];

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { sampling: 'both', minAdv: DEFAULT_MIN_ADV, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--sampling') out.sampling = a[++i];
    else if (a[i] === '--min-adv') out.minAdv = Number(a[++i]);
    else if (a[i] === '--json') out.json = a[++i];
  }
  return out;
}

function toDateStr(d) {
  return d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).split('T')[0];
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < period) continue;
    if (prev === null) {
      let s = 0;
      for (let j = i - period + 1; j <= i; j++) s += values[j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/** Rolling median of `value` over the prior `w` bars, ending at i inclusive. */
function rollingMedian(arr, i, w) {
  if (i + 1 < w) return null;
  const slice = arr.slice(i - w + 1, i + 1).filter(Number.isFinite).sort((a, b) => a - b);
  if (!slice.length) return null;
  const m = Math.floor(slice.length / 2);
  return slice.length % 2 ? slice[m] : (slice[m - 1] + slice[m]) / 2;
}

/** Score for one lookback at bar i, or null if the window isn't fully available. */
function scoreAt(series, i, lb) {
  const { closes, ema50, highs } = series;
  if (lb.kind === 'ema50slope') {
    const a = ema50[i], b = ema50[i - lb.bars];
    if (a === null || a === undefined || b === null || b === undefined || !(b > 0)) return null;
    return ((a - b) / b) * 100;
  }
  if (lb.kind === 'hi52w') {
    if (i < lb.bars) return null;
    let hi = -Infinity;
    for (let j = i - lb.bars + 1; j <= i; j++) if (highs[j] > hi) hi = highs[j];
    if (!(hi > 0)) return null;
    return (closes[i] / hi) * 100; // 100 = at the 52w high
  }
  const endIdx = i - lb.skip;
  const startIdx = endIdx - lb.bars;
  if (startIdx < 0) return null;
  const a = closes[endIdx], b = closes[startIdx];
  if (!(b > 0) || !(a > 0)) return null;
  return ((a - b) / b) * 100;
}

function fmt(v, d = 4) {
  return v === null || v === undefined || !Number.isFinite(v) ? '   n/a' : v.toFixed(d).padStart(7);
}

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(100));
  console.log('EXP-011 — Momentum Lookback x Forward-Horizon IC Grid');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT — universe is today\'s ticker list applied backwards ***');
  console.log('='.repeat(100));

  // ── Canonical trading-date axis ───────────────────────────────────────────
  const [ihsgRows] = await pool.query(
    'SELECT date FROM idx_ihsg_history ORDER BY date ASC'
  );
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  console.log(`\nCanonical axis: ${tradingDates.length} trading dates, ${tradingDates[0]} .. ${tradingDates[tradingDates.length - 1]}`);

  // ── Load candles ──────────────────────────────────────────────────────────
  const [priceRows] = await pool.query(
    `SELECT stock_code, date, close_price, high_price, volume, value
       FROM idx_stock_prices
      WHERE close_price > 0
      ORDER BY stock_code, date ASC`
  );
  const byTicker = new Map();
  for (const r of priceRows) {
    if (!byTicker.has(r.stock_code)) byTicker.set(r.stock_code, []);
    byTicker.get(r.stock_code).push({
      date: toDateStr(r.date),
      close: Number(r.close_price),
      high: Number(r.high_price) || Number(r.close_price),
      value: Number(r.value) || (Number(r.close_price) * Number(r.volume || 0)),
    });
  }
  console.log(`Loaded ${priceRows.length} bars across ${byTicker.size} tickers`);

  // ── Project each ticker onto the canonical axis ───────────────────────────
  // Index by canonical position so every ticker's lookback window spans the same
  // wall-clock period. Missing dates stay null and are skipped, never forward-filled.
  const series = new Map();
  let dropped = 0;
  for (const [ticker, candles] of byTicker) {
    if (candles.length < WARMUP + Math.max(...HORIZONS) + 10) { dropped++; continue; }
    const n = tradingDates.length;
    const closes = new Array(n).fill(null);
    const highs = new Array(n).fill(null);
    const values = new Array(n).fill(null);
    let placed = 0;
    for (const c of candles) {
      const i = dateIdx.get(c.date);
      if (i === undefined) continue;
      closes[i] = c.close; highs[i] = c.high; values[i] = c.value; placed++;
    }
    if (placed < WARMUP + Math.max(...HORIZONS) + 10) { dropped++; continue; }
    series.set(ticker, { closes, highs, values, ema50: emaSeries(closes.map(c => c === null ? NaN : c), 50) });
  }
  console.log(`Eligible tickers: ${series.size} (dropped ${dropped} for insufficient history)`);
  console.log(`Liquidity floor: median ${ADV_WINDOW}-day value >= Rp ${(opts.minAdv / 1e9).toFixed(1)}bn\n`);

  const samplings = opts.sampling === 'both' ? ['weekly', 'daily'] : [opts.sampling];
  const report = { generatedFor: 'EXP-011', minAdv: opts.minAdv, samplings: {} };

  for (const sampling of samplings) {
    const step = sampling === 'weekly' ? 5 : 1;
    // acc[lookback][horizon] = { ics: [], byYear: Map<year, ics[]>, buckets: [...] }
    const acc = new Map();
    for (const lb of LOOKBACKS) {
      const perH = new Map();
      for (const h of HORIZONS) {
        perH.set(h, {
          ics: [], byYear: new Map(),
          bucketSums: Array.from({ length: 10 }, () => ({ sum: 0, n: 0 })),
          universeSum: 0, universeN: 0,
        });
      }
      acc.set(lb.key, perH);
    }

    const maxH = Math.max(...HORIZONS);
    let datesUsed = 0, datesSkippedThin = 0;

    for (let i = WARMUP; i < tradingDates.length - maxH; i += step) {
      // Liquidity + availability screen, computed once per date for all lookbacks.
      const eligible = [];
      for (const [ticker, s] of series) {
        if (s.closes[i] === null) continue;
        const adv = rollingMedian(s.values, i, ADV_WINDOW);
        if (adv === null || adv < opts.minAdv) continue;
        eligible.push({ ticker, s });
      }
      if (eligible.length < MIN_ELIGIBLE_PER_DAY) { datesSkippedThin++; continue; }

      const year = tradingDates[i].slice(0, 4);
      let usedThisDate = false;

      for (const lb of LOOKBACKS) {
        const scores = [], perHorizonReturns = new Map(HORIZONS.map(h => [h, []]));
        for (const { s } of eligible) {
          const sc = scoreAt(s, i, lb);
          if (sc === null || !Number.isFinite(sc)) continue;
          // Require EVERY horizon's forward bar so the same cross-section backs
          // every column — otherwise horizons are computed on different samples.
          const p0 = s.closes[i];
          const fwd = HORIZONS.map(h => s.closes[i + h]);
          if (!(p0 > 0) || fwd.some(p => p === null || !(p > 0))) continue;
          scores.push(sc);
          HORIZONS.forEach((h, hi) => perHorizonReturns.get(h).push(((fwd[hi] - p0) / p0) * 100));
        }
        if (scores.length < MIN_ELIGIBLE_PER_DAY) continue;
        usedThisDate = true;

        for (const h of HORIZONS) {
          const rets = perHorizonReturns.get(h);
          const ic = cs.spearmanIC(scores, rets);
          const slot = acc.get(lb.key).get(h);
          if (ic !== null && Number.isFinite(ic)) {
            slot.ics.push(ic);
            if (!slot.byYear.has(year)) slot.byYear.set(year, []);
            slot.byYear.get(year).push(ic);
          }
          const { buckets, universeMean } = cs.bucketByScore(scores, rets, 10);
          buckets.forEach((b, bi) => {
            if (b.meanReturn !== null) { slot.bucketSums[bi].sum += b.meanReturn * b.n; slot.bucketSums[bi].n += b.n; }
          });
          if (universeMean !== null) { slot.universeSum += universeMean * rets.length; slot.universeN += rets.length; }
        }
      }
      if (usedThisDate) datesUsed++;
    }

    console.log('\n' + '='.repeat(100));
    console.log(`SAMPLING: ${sampling.toUpperCase()} (every ${step} trading day${step > 1 ? 's' : ''}) — ${datesUsed} ranking dates used, ${datesSkippedThin} skipped as too thin`);
    if (sampling === 'daily') {
      console.log('NOTE: consecutive daily dates share most of their forward window; the CIs below are too narrow.');
    }
    console.log('='.repeat(100));

    const samplingOut = { datesUsed, lookbacks: {} };

    for (const lb of LOOKBACKS) {
      console.log(`\n${lb.key}  (${lb.note})`);
      console.log('  horizon    meanIC     IR   %pos    CI_low   CI_high   D10-D1    D10-univ');
      const lbOut = {};
      for (const h of HORIZONS) {
        const slot = acc.get(lb.key).get(h);
        const ci = cs.bootstrapMeanCI(slot.ics, { resamples: BOOTSTRAP_RESAMPLES, seed: RANDOM_SEED });
        const ir = cs.icInformationRatio(slot.ics);
        const pctPos = slot.ics.length ? (slot.ics.filter(v => v > 0).length / slot.ics.length) * 100 : null;
        const d1 = slot.bucketSums[0].n ? slot.bucketSums[0].sum / slot.bucketSums[0].n : null;
        const d10 = slot.bucketSums[9].n ? slot.bucketSums[9].sum / slot.bucketSums[9].n : null;
        const univ = slot.universeN ? slot.universeSum / slot.universeN : null;
        const spread = d10 !== null && d1 !== null ? d10 - d1 : null;
        const excess = d10 !== null && univ !== null ? d10 - univ : null;
        const sig = ci.lower !== null && ci.upper !== null && (ci.lower > 0 || ci.upper < 0) ? ' *' : '';
        console.log(
          `   ${String(h).padStart(3)}D    ${fmt(ci.mean)}  ${fmt(ir, 2)}  ${fmt(pctPos, 1)}   ${fmt(ci.lower)}   ${fmt(ci.upper)}  ${fmt(spread, 2)}%   ${fmt(excess, 2)}%${sig}`
        );
        lbOut[h] = {
          meanIC: ci.mean, ir, pctPositive: pctPos, ciLower: ci.lower, ciUpper: ci.upper,
          nDates: ci.n, decile1: d1, decile10: d10, universeMean: univ, spread, excess,
          significant: !!sig,
        };
      }
      samplingOut.lookbacks[lb.key] = lbOut;
    }
    console.log('\n  * = bootstrap 95% CI excludes zero');

    // ── Per-year stability for the 40D horizon (the POSITION hold length) ────
    const H_FOCUS = 40;
    console.log(`\n${'-'.repeat(100)}`);
    console.log(`PER-YEAR mean IC at ${H_FOCUS}D (does any of this hold up across regimes?)`);
    console.log('-'.repeat(100));
    const years = [...new Set(tradingDates.map(d => d.slice(0, 4)))].sort();
    process.stdout.write('  lookback      ');
    years.forEach(y => process.stdout.write(y.slice(2).padStart(7)));
    console.log('');
    for (const lb of LOOKBACKS) {
      const slot = acc.get(lb.key).get(H_FOCUS);
      process.stdout.write('  ' + lb.key.padEnd(14));
      for (const y of years) {
        const v = slot.byYear.get(y);
        process.stdout.write((v && v.length >= 3 ? stats.mean(v).toFixed(3) : '  -').padStart(7));
      }
      console.log('');
    }

    report.samplings[sampling] = samplingOut;
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const primary = report.samplings.weekly || report.samplings[samplings[0]];
  console.log(`\n${'='.repeat(100)}`);
  console.log('MECHANICAL VERDICT (weekly sampling — the independent one)');
  console.log('='.repeat(100));
  const survivors = [];
  for (const [key, hs] of Object.entries(primary.lookbacks)) {
    for (const [h, m] of Object.entries(hs)) {
      if (m.significant && m.meanIC > 0) survivors.push({ key, h: Number(h), ...m });
    }
  }
  survivors.sort((a, b) => b.meanIC - a.meanIC);
  if (!survivors.length) {
    console.log('\nNo (lookback, horizon) pair has a mean IC whose 95% CI excludes zero on the positive side.');
    console.log('Reading: cross-sectional price momentum does not sort forward returns on this universe.');
    console.log('DO NOT rewrite F4/F12/F2 to be "slower" — there is no slow momentum signal here to capture.');
  } else {
    console.log(`\n${survivors.length} (lookback, horizon) pair(s) with positive IC and a CI excluding zero:\n`);
    survivors.slice(0, 12).forEach(s => {
      console.log(`  ${s.key.padEnd(14)} @ ${String(s.h).padStart(3)}D   IC=${s.meanIC.toFixed(4)}  IR=${s.ir === null ? 'n/a' : s.ir.toFixed(2)}  %pos=${s.pctPositive.toFixed(1)}  D10-D1=${s.spread === null ? 'n/a' : s.spread.toFixed(2) + '%'}`);
    });
    console.log('\nCaveats before acting: (1) this is a raw ranking with no costs, no entry timing and no');
    console.log('stop — a positive IC is necessary but nowhere near sufficient for a tradeable edge;');
    console.log('(2) many pairs were tested, so treat marginal survivors as multiple-testing noise unless');
    console.log('the per-year table shows the sign is stable; (3) results are survivorship-biased.');
  }

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify(report, null, 2));
    console.log(`\nJSON written to ${opts.json}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
