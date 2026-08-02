/**
 * EXP-016 — Broker/Bandarmology Factor IC Grid
 *
 * QUESTION
 * --------
 * Does broker concentration predict forward returns on IDX at all, and at what
 * horizon and what lookback?
 *
 * This is the one edge genuinely specific to this market — absent from the
 * global anomaly literature and not arbitraged by foreign quants — and it has
 * never been testable. `idx_concentration` began 2026-01-19, so EXP-011..015
 * were all effectively price-only models. The 2026-08-02 backfill extended it
 * to 2024-01-02 (605 dates), which is what makes this possible.
 *
 * It also matters because EXP-012 showed the price-momentum family is
 * internally correlated 0.49-0.67 — three hats on one bet. A genuinely
 * orthogonal signal source is precisely what the factor set lacks.
 *
 * THE UNTESTED HYPOTHESIS
 * -----------------------
 * The actual bandarmology thesis is PERSISTENCE: a large buyer accumulating
 * quietly over weeks. Nothing in the system has ever tested that. F2 reads a
 * five-day dn window and F8 a short streak — both far shorter than the 2-8 week
 * horizon the system now trades. This grid separates three things that have
 * always been conflated:
 *
 *   raw signal  vs  the production transform   (DN0        vs F1_SCORE)
 *   magnitude   vs  consistency                (DN0_MA20   vs POSFRAC_20)
 *   short       vs  long persistence           (MA5 / MA20 / MA60)
 *
 * The EXP-011 lesson makes the first split load-bearing: raw ROC5 turned out to
 * be anti-predictive while F4 — which wraps it in RSI reversal modifiers —
 * scored as the most valuable factor. A factor's value can live entirely in its
 * transform. Testing only the scored version would hide that again.
 *
 * Ranking-only: no entry timing, no stop, no target, no fees.
 * SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_broker_factor_ic.js [--sampling both|weekly|daily]
 *                                          [--min-adv 5e9] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const cs = require('./modules/cross_sectional');
const awo = require('./modules/awo_factors');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const HORIZONS = [5, 10, 20, 40, 60];
const WARMUP = 60;                  // longest lookback
const MIN_ELIGIBLE_PER_DAY = 20;
const ADV_WINDOW = 20;
const DEFAULT_MIN_ADV = 5e9;
const BOOTSTRAP_RESAMPLES = 2000;
const RANDOM_SEED = 42;
const DN_BOUND = 100;               // documented contract; 84 FT.id rows breach it

const SIGNALS = [
  { key: 'DN0',          note: 'raw concentration today' },
  { key: 'DN0_MA5',      note: '5-day mean (roughly what F2 sees)' },
  { key: 'DN0_MA20',     note: '1-month accumulation persistence' },
  { key: 'DN0_MA60',     note: '3-month accumulation persistence' },
  { key: 'POSFRAC_20',   note: 'share of last 20d with dn0 > 0 (consistency, not size)' },
  { key: 'POSFRAC_60',   note: 'share of last 60d with dn0 > 0' },
  { key: 'STREAK',       note: 'current run of consecutive positive dn0 days' },
  { key: 'NETFLOW_20',   note: 'sum of dn0 x turnover over 20d, / 20d turnover' },
  { key: 'F1_SCORE',     note: 'PRODUCTION f1_concentration(dn0)' },
  { key: 'F2_SCORE',     note: 'PRODUCTION f2_trend([dn0..dn4])' },
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

/** Mean over the trailing w bars, ignoring gaps; null if too few real values. */
function trailingMean(arr, i, w, minReal) {
  let sum = 0, n = 0;
  for (let j = Math.max(0, i - w + 1); j <= i; j++) if (arr[j] !== null) { sum += arr[j]; n++; }
  return n >= minReal ? sum / n : null;
}
function trailingPosFrac(arr, i, w, minReal) {
  let pos = 0, n = 0;
  for (let j = Math.max(0, i - w + 1); j <= i; j++) if (arr[j] !== null) { if (arr[j] > 0) pos++; n++; }
  return n >= minReal ? pos / n : null;
}
function currentStreak(arr, i) {
  let s = 0;
  for (let j = i; j >= 0 && arr[j] !== null; j--) {
    if (arr[j] > 0) s++; else break;
  }
  return s;
}

const fmt = (v, d = 4) => (v === null || v === undefined || !Number.isFinite(v)) ? '   n/a' : v.toFixed(d).padStart(7);

async function main() {
  const opts = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(104));
  console.log('EXP-016 — Broker/Bandarmology Factor IC Grid');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT ***');
  console.log('='.repeat(104));

  const [ihsgRows] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`
  );
  const series = new Map();
  const ensure = t => {
    if (!series.has(t)) series.set(t, {
      close: new Array(n).fill(null), value: new Array(n).fill(null),
      dn0: new Array(n).fill(null), dnWin: new Array(n).fill(null), nConc: 0,
    });
    return series.get(t);
  };
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    const s = ensure(r.stock_code);
    s.close[i] = Number(r.close_price);
    s.value[i] = Number(r.value) || Number(r.close_price) * Number(r.volume || 0);
  }

  const [concRows] = await pool.query(
    `SELECT stock_code, data_date, dn0, dn1, dn2, dn3, dn4 FROM idx_concentration ORDER BY stock_code, data_date ASC`
  );
  let clipped = 0;
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s) continue;
    // Clip to the documented +/-100 contract. 84 FT.id-sourced rows breach it,
    // clustered on two June dates — artifacts, not a different scale (verified
    // 2026-08-02). Clipping is the conservative fix; dropping them would punch
    // holes in the series that the trailing windows would then span silently.
    const clip = v => {
      if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
      const x = Number(v);
      if (Math.abs(x) > DN_BOUND) { clipped++; return Math.sign(x) * DN_BOUND; }
      return x;
    };
    s.dn0[i] = clip(r.dn0);
    s.dnWin[i] = [clip(r.dn0), clip(r.dn1), clip(r.dn2), clip(r.dn3), clip(r.dn4)].filter(v => v !== null);
    if (s.dn0[i] !== null) s.nConc++;
  }
  for (const [t, s] of series) if (s.nConc < 200) series.delete(t);

  const concDates = [...new Set(concRows.map(r => toDateStr(r.data_date)))].sort();
  console.log(`\nConcentration span : ${concDates[0]} .. ${concDates[concDates.length - 1]} (${concDates.length} dates)`);
  console.log(`Universe           : ${series.size} tickers with >= 200 days of concentration`);
  console.log(`Clipped to +/-${DN_BOUND}   : ${clipped} values`);
  console.log(`Liquidity floor    : median ${ADV_WINDOW}d value >= Rp ${(opts.minAdv / 1e9).toFixed(1)}bn\n`);

  const firstI = dateIdx.get(concDates[0]) + WARMUP;
  const maxH = Math.max(...HORIZONS);
  const lastI = dateIdx.get(concDates[concDates.length - 1]) - maxH;

  function signalsAt(s, i) {
    const dn0 = s.dn0[i];
    if (dn0 === null) return null;
    const out = {};
    out.DN0 = dn0;
    out.DN0_MA5 = trailingMean(s.dn0, i, 5, 3);
    out.DN0_MA20 = trailingMean(s.dn0, i, 20, 12);
    out.DN0_MA60 = trailingMean(s.dn0, i, 60, 35);
    out.POSFRAC_20 = trailingPosFrac(s.dn0, i, 20, 12);
    out.POSFRAC_60 = trailingPosFrac(s.dn0, i, 60, 35);
    out.STREAK = currentStreak(s.dn0, i);
    // Turnover-weighted: a 30% concentration on a heavily traded day is a bigger
    // real commitment than the same percentage on a quiet one.
    let num = 0, den = 0;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      if (s.dn0[j] === null || s.value[j] === null) continue;
      num += s.dn0[j] * s.value[j]; den += s.value[j];
    }
    out.NETFLOW_20 = den > 0 ? num / den : null;
    out.F1_SCORE = awo.f1_concentration(dn0);
    const win = s.dnWin[i];
    out.F2_SCORE = (win && win.length) ? awo.f2_trend(win) : null;
    return out;
  }

  const samplings = opts.sampling === 'both' ? ['weekly', 'daily'] : [opts.sampling];
  const report = { samplings: {} };

  for (const sampling of samplings) {
    const step = sampling === 'weekly' ? 5 : 1;
    const acc = new Map(SIGNALS.map(sg => [sg.key, new Map(HORIZONS.map(h => [h, {
      ics: [], byYear: new Map(), d1: { s: 0, n: 0 }, d10: { s: 0, n: 0 }, uni: { s: 0, n: 0 },
    }]))]));
    let datesUsed = 0, sizes = [];

    for (let i = firstI; i <= lastI; i += step) {
      const rows = [];
      for (const [ticker, s] of series) {
        if (s.close[i] === null) continue;
        const adv = rollingMedian(s.value, i, ADV_WINDOW);
        if (adv === null || adv < opts.minAdv) continue;
        const p0 = s.close[i];
        const fwd = HORIZONS.map(h => s.close[i + h]);
        if (!(p0 > 0) || fwd.some(p => p === null || !(p > 0))) continue;
        const sig = signalsAt(s, i);
        if (!sig) continue;
        rows.push({ sig, rets: Object.fromEntries(HORIZONS.map((h, k) => [h, ((fwd[k] - p0) / p0) * 100])) });
      }
      if (rows.length < MIN_ELIGIBLE_PER_DAY) continue;
      datesUsed++; sizes.push(rows.length);
      const year = tradingDates[i].slice(0, 4);

      for (const sg of SIGNALS) {
        const valid = rows.filter(r => r.sig[sg.key] !== null && Number.isFinite(r.sig[sg.key]));
        if (valid.length < MIN_ELIGIBLE_PER_DAY) continue;
        const scores = valid.map(r => r.sig[sg.key]);
        for (const h of HORIZONS) {
          const rets = valid.map(r => r.rets[h]);
          const slot = acc.get(sg.key).get(h);
          const ic = cs.spearmanIC(scores, rets);
          if (ic !== null && Number.isFinite(ic)) {
            slot.ics.push(ic);
            if (!slot.byYear.has(year)) slot.byYear.set(year, []);
            slot.byYear.get(year).push(ic);
          }
          const { buckets, universeMean } = cs.bucketByScore(scores, rets, 10);
          if (buckets[0].meanReturn !== null) { slot.d1.s += buckets[0].meanReturn * buckets[0].n; slot.d1.n += buckets[0].n; }
          if (buckets[9].meanReturn !== null) { slot.d10.s += buckets[9].meanReturn * buckets[9].n; slot.d10.n += buckets[9].n; }
          if (universeMean !== null) { slot.uni.s += universeMean * rets.length; slot.uni.n += rets.length; }
        }
      }
    }

    console.log('='.repeat(104));
    console.log(`SAMPLING: ${sampling.toUpperCase()} — ${datesUsed} ranking dates, median cross-section ${sizes.length ? Math.round(stats.mean(sizes)) : 0}`);
    if (sampling === 'daily') console.log('NOTE: overlapping forward windows make these CIs too narrow. Weekly is the independent read.');
    if (sampling === 'weekly' && datesUsed < 120) console.log(`NOTE: only ${datesUsed} independent dates — this is a THIN sample; treat marginal results as noise.`);
    console.log('='.repeat(104));

    const out = {};
    for (const sg of SIGNALS) {
      console.log(`\n${sg.key}  (${sg.note})`);
      console.log('  horizon    meanIC     IR    %pos    CI_low   CI_high    D10-D1    D10-univ');
      out[sg.key] = {};
      for (const h of HORIZONS) {
        const slot = acc.get(sg.key).get(h);
        const ci = cs.bootstrapMeanCI(slot.ics, { resamples: BOOTSTRAP_RESAMPLES, seed: RANDOM_SEED });
        const ir = cs.icInformationRatio(slot.ics);
        const pctPos = slot.ics.length ? (slot.ics.filter(v => v > 0).length / slot.ics.length) * 100 : null;
        const d1 = slot.d1.n ? slot.d1.s / slot.d1.n : null;
        const d10 = slot.d10.n ? slot.d10.s / slot.d10.n : null;
        const uni = slot.uni.n ? slot.uni.s / slot.uni.n : null;
        const sig = (ci.lower !== null && (ci.lower > 0 || ci.upper < 0)) ? ' *' : '';
        console.log(`   ${String(h).padStart(3)}D    ${fmt(ci.mean)}  ${fmt(ir, 2)}  ${fmt(pctPos, 1)}   ${fmt(ci.lower)}   ${fmt(ci.upper)}   ${fmt(d10 !== null && d1 !== null ? d10 - d1 : null, 2)}%   ${fmt(d10 !== null && uni !== null ? d10 - uni : null, 2)}%${sig}`);
        out[sg.key][h] = { meanIC: ci.mean, ir, pctPositive: pctPos, ciLower: ci.lower, ciUpper: ci.upper, nDates: ci.n, significant: !!sig, spread: (d10 !== null && d1 !== null) ? d10 - d1 : null };
      }
    }
    console.log('\n  * = bootstrap 95% CI excludes zero');

    // Per-year at 40D — the POSITION hold length.
    console.log(`\n${'-'.repeat(104)}`);
    console.log('PER-YEAR mean IC at 40D');
    console.log('-'.repeat(104));
    const years = [...new Set(tradingDates.slice(firstI, lastI).map(d => d.slice(0, 4)))].sort();
    process.stdout.write('  signal          ');
    years.forEach(y => process.stdout.write(y.slice(2).padStart(8)));
    console.log('');
    for (const sg of SIGNALS) {
      const slot = acc.get(sg.key).get(40);
      process.stdout.write('  ' + sg.key.padEnd(16));
      years.forEach(y => {
        const v = slot.byYear.get(y);
        process.stdout.write((v && v.length >= 3 ? stats.mean(v).toFixed(3) : '   -').padStart(8));
      });
      console.log('');
    }
    report.samplings[sampling] = { datesUsed, signals: out };
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const primary = report.samplings.weekly || report.samplings[samplings[0]];
  console.log(`\n${'='.repeat(104)}`);
  console.log('MECHANICAL VERDICT (weekly sampling — the independent one)');
  console.log('='.repeat(104));
  // A signal is INFORMATIVE if its CI excludes zero in EITHER direction. An
  // earlier version of this block only looked for positive IC and therefore
  // printed "no signal" over a table full of strongly significant NEGATIVE
  // results — the exact mistake this experiment exists to avoid. A factor that
  // reliably sorts returns the "wrong" way is not an absence of information.
  const sigPos = [], sigNeg = [];
  for (const [key, hs] of Object.entries(primary.signals))
    for (const [h, m] of Object.entries(hs)) {
      if (!m.significant) continue;
      (m.meanIC > 0 ? sigPos : sigNeg).push({ key, h: Number(h), ...m });
    }
  sigPos.sort((a, b) => b.meanIC - a.meanIC);
  sigNeg.sort((a, b) => a.meanIC - b.meanIC);

  const line = w => `  ${w.key.padEnd(14)} @ ${String(w.h).padStart(3)}D   IC=${w.meanIC.toFixed(4)}  IR=${w.ir === null ? 'n/a' : w.ir.toFixed(2)}  %pos=${w.pctPositive.toFixed(1)}  D10-D1=${w.spread === null ? 'n/a' : w.spread.toFixed(2) + '%'}`;

  if (!sigPos.length && !sigNeg.length) {
    console.log('\n  No broker signal has a CI excluding zero in either direction — no information.');
  } else {
    if (sigPos.length) {
      console.log(`\n  POSITIVE and significant (${sigPos.length}):\n`);
      sigPos.slice(0, 10).forEach(w => console.log(line(w)));
    }
    if (sigNeg.length) {
      console.log(`\n  NEGATIVE and significant (${sigNeg.length}) — informative, with the sign INVERTED`);
      console.log('  relative to the conventional accumulation reading:\n');
      sigNeg.slice(0, 10).forEach(w => console.log(line(w)));
    }
    console.log('\n  Before acting: raw ranking, no costs/timing/stop; many pairs tested; 2.5 years,');
    console.log('  3 calendar years, survivorship-biased. Check the per-year table — a sign that');
    console.log('  flips across years is fatal, not interesting.');
    console.log('  And note what a NEGATIVE IC can and cannot be used for on IDX: retail cannot');
    console.log('  readily short, so the usable form is a VETO on the long book, not a short leg.');
    console.log('  Inverting a negative IC is not automatically a strategy — EXP-013 showed a');
    console.log('  positive IC of similar size die entirely on turnover and walk-forward.');
  }

  if (opts.json) {
    require('fs').writeFileSync(opts.json, JSON.stringify(report, null, 2));
    console.log(`\n  JSON written to ${opts.json}`);
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
