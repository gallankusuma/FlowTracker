'use strict';
/**
 * EXP-032 — do the 17 FRED series predict IHSG?
 *
 * These have never been tested. EXP-030 burned its holdout on the 20 Yahoo
 * indicators; these series did not exist in the table then, so their holdout is
 * clean. That is the one advantage this experiment has, and it is spent here.
 *
 * ── THE TRAP THAT WOULD INVALIDATE EVERYTHING ────────────────────────────────
 *
 * FRED dates an observation by the PERIOD IT DESCRIBES, not by when it was
 * published. July CPI carries the date 2026-07-01 and is released around
 * 13 August. Aligning it to the session of 1 July hands the model six weeks of
 * future knowledge, and the resulting "predictive power" is the release itself
 * leaking backwards.
 *
 * That defect is invisible in the output: it produces strong, stable,
 * plausible-looking ICs. It would have been the most convincing wrong answer
 * this project has produced.
 *
 * So every series carries a PUBLICATION LAG, and a value becomes visible only at
 * the first exchange session on or after (period_end + lag). Lags are set from
 * the actual release calendars and rounded UP -- when unsure, later.
 *
 * ── METHOD, otherwise as EXP-030 ─────────────────────────────────────────────
 *
 *   - step function of last-known values, so a monthly series is flat between
 *     releases and its change appears on the session the market learned it
 *   - non-overlapping anchors H sessions apart on the exchange calendar
 *   - Spearman rank IC; Benjamini-Hochberg across the whole family
 *   - chronological holdout, read once
 *
 * 17 series x 2 transforms x 2 horizons = 68 hypotheses. At alpha 0.05 roughly
 * three clear by chance, which is why the correction covers the family.
 *
 * Usage: node scraper/research/macro/exp032_fred_ic.js
 */
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');
const stats = require('../../modules/statistics');
const mt = require('../candlestick/multiple_testing');

const HORIZONS = [20, 60];
const ZWIN = 250;
const CHGWIN = 20;
const SPLIT = '2025-02-01';
const ALPHA = 0.05;

/**
 * Calendar days from the end of the period an observation describes to the day
 * the public could act on it. Rounded up; when unsure, later.
 */
const PUB_LAG_DAYS = {
  // daily market-based series: on FRED the next business day
  YIELD_2Y: 1, YIELD_CURVE_10Y2Y: 1, INFL_EXP_5Y: 1, INFL_EXP_10Y: 1, REVERSE_REPO: 1,
  // weekly
  JOBLESS_CLAIMS: 5,          // Thursday, for the week ending the prior Saturday
  FED_BALANCE_SHEET: 2,       // H.4.1, Thursday
  // monthly
  PAYROLLS: 10,               // employment situation, first Friday-ish
  UNEMPLOYMENT: 10,           // same release
  MFG_EMPLOYMENT: 10,         // same release
  CPI: 18,                    // mid-following-month
  CONSUMER_SENT: 3,           // final reading near month end
  PCE_PRICE: 32,              // personal income & outlays, ~end of following month
  M2: 32,                     // H.6, ~4 weeks
  M2_REAL: 32,
  FED_RATE: 3,                // monthly average, published early the next month
  // quarterly
  GDP_GROWTH: 30,             // advance estimate, ~1 month after quarter end
};

const toDateStr = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Period END for an observation, given the series' own spacing. */
function periodEnd(iso, medianSpacingDays) {
  if (medianSpacingDays >= 80) {          // quarterly: date is the quarter START
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 3); d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  }
  if (medianSpacingDays >= 25) {          // monthly: date is the month START
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0);
    return d.toISOString().slice(0, 10);
  }
  return iso;                              // weekly/daily: the date IS the period
}

function spearman(xs, ys) {
  const n = xs.length;
  if (n < 8) return { ic: null, p: null, n };
  const rank = arr => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ic = stats.correlation(rank(xs), rank(ys));
  if (!Number.isFinite(ic) || Math.abs(ic) >= 1) return { ic, p: null, n };
  const z = 0.5 * Math.log((1 + ic) / (1 - ic)) * Math.sqrt(n - 3);
  return { ic, p: Math.min(1, Math.max(0, 2 * (1 - stats.normalCDF(Math.abs(z))))), n };
}

(async () => {
  const pool = createPool();

  const [ihsg] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const dates = ihsg.map(r => toDateStr(r.date));
  const close = ihsg.map(r => Number(r.close_price));
  const n = dates.length;

  const [macro] = await pool.query(
    "SELECT indicator, date, value FROM ft_macro_data WHERE source = 'FRED' ORDER BY indicator, date ASC");
  const byInd = new Map();
  for (const r of macro) {
    if (!byInd.has(r.indicator)) byInd.set(r.indicator, []);
    byInd.get(r.indicator).push({ d: toDateStr(r.date), v: Number(r.value) });
  }

  console.log('EXP-032 — do the FRED series predict IHSG?');
  console.log(`  IHSG sessions   : ${n}  (${dates[0]} .. ${dates[n - 1]})`);
  console.log(`  FRED indicators : ${byInd.size}`);
  console.log(`  holdout         : from ${SPLIT} — CLEAN for these series, never read before`);
  console.log('  every series lagged to its publication date, not its period date');
  console.log('');
  console.log('  series               freq      lag  first visible');

  const results = [];

  for (const [indicator, series] of byInd) {
    if (series.length < 24) continue;

    // Median spacing tells us the frequency without hardcoding it per series.
    const gaps = [];
    for (let i = 1; i < series.length; i++) {
      gaps.push((new Date(series[i].d) - new Date(series[i - 1].d)) / 86400000);
    }
    gaps.sort((a, b) => a - b);
    const spacing = gaps[gaps.length >> 1];
    const lag = PUB_LAG_DAYS[indicator] ?? 32;      // unknown series: assume slow
    const freq = spacing >= 80 ? 'quarterly' : spacing >= 25 ? 'monthly' : spacing >= 5 ? 'weekly' : 'daily';

    // Step function: at each session, the newest value ALREADY PUBLISHED.
    const known = new Array(n).fill(null);
    let si = 0, cur = null;
    const visible = series.map(o => ({ v: o.v, at: addDays(periodEnd(o.d, spacing), lag) }));
    visible.sort((a, b) => (a.at < b.at ? -1 : 1));
    for (let i = 0; i < n; i++) {
      while (si < visible.length && visible[si].at <= dates[i]) { cur = visible[si].v; si++; }
      known[i] = cur;
    }
    const firstVisible = known.findIndex(v => v !== null);
    console.log('  ' + indicator.padEnd(20) + freq.padEnd(10) + String(lag).padStart(3) + 'd  ' +
      (firstVisible >= 0 ? dates[firstVisible] : 'never'));

    for (const H of HORIZONS) {
      const candidates = [];
      for (let i = 0; i < n; i++) {
        if (i + H >= n || known[i] === null) continue;

        const back = i - CHGWIN >= 0 ? known[i - CHGWIN] : null;
        const chg20 = (back && back !== 0) ? (known[i] / back - 1) : null;

        let z250 = null;
        const win = [];
        for (let k = Math.max(0, i - ZWIN + 1); k <= i; k++) if (known[k] !== null) win.push(known[k]);
        if (win.length >= ZWIN * 0.8) {
          const m = stats.mean(win), sd = stats.stdDev(win);
          if (sd > 0) z250 = (known[i] - m) / sd;
        }

        candidates.push({ sessionIndex: i, date: dates[i], chg20, z250, fwd: close[i + H] / close[i] - 1 });
      }

      const anchors = mt.nonOverlappingAnchors(candidates, H);
      for (const transform of ['chg20', 'z250']) {
        const usable = anchors.filter(a => Number.isFinite(a[transform]));
        const train = usable.filter(a => a.date < SPLIT);
        const hold = usable.filter(a => a.date >= SPLIT);
        const tr = spearman(train.map(a => a[transform]), train.map(a => a.fwd));
        const ho = spearman(hold.map(a => a[transform]), hold.map(a => a.fwd));
        results.push({
          indicator, transform, H, freq,
          nTrain: tr.n, icTrain: tr.ic, p: tr.p,
          nHold: ho.n, icHold: ho.ic, tier: mt.evidenceTier(tr.n),
        });
      }
    }
  }

  const fdr = mt.benjaminiHochberg(results, ALPHA);
  results.sort((a, b) => (a.p ?? 1) - (b.p ?? 1));

  console.log('');
  console.log('RANK IC, ranked by p');
  console.log('  indicator            transf   H   nTr  IC_train      p       q     FDR | nHo  IC_hold  sign');
  for (const r of results.slice(0, 20)) {
    const same = (Number.isFinite(r.icTrain) && Number.isFinite(r.icHold) &&
      Math.sign(r.icTrain) === Math.sign(r.icHold)) ? 'same' : 'FLIP';
    console.log('  ' + r.indicator.padEnd(20) + r.transform.padEnd(8) + String(r.H).padStart(3) + '  ' +
      String(r.nTrain).padStart(4) + '  ' +
      (r.icTrain === null ? '   n/a' : (r.icTrain >= 0 ? ' ' : '') + r.icTrain.toFixed(4)).padStart(8) + '  ' +
      (r.p === null ? '  n/a' : r.p.toFixed(4)).padStart(7) + ' ' +
      (r.q === null ? '  n/a' : r.q.toFixed(4)).padStart(7) + ' ' +
      (r.rejected ? 'PASS' : '  - ') + ' | ' +
      String(r.nHold).padStart(3) + '  ' +
      (r.icHold === null ? '   n/a' : (r.icHold >= 0 ? ' ' : '') + r.icHold.toFixed(4)).padStart(8) + '  ' + same);
  }

  console.log('');
  console.log(`FDR: ${fdr.rejected} of ${fdr.m} hypotheses survive at alpha ${ALPHA}` +
    (fdr.threshold !== null ? ` (p <= ${fdr.threshold.toFixed(5)})` : ''));

  const survivors = results.filter(r => r.rejected);
  if (!survivors.length) {
    console.log(`NOTHING SURVIVES. With ${fdr.m} hypotheses about ${Math.round(fdr.m * ALPHA)} would clear an`);
    console.log('uncorrected 0.05 by chance, which is why the correction covers the family.');
  } else {
    console.log('\nSURVIVORS — candidates for a SEPARATE pre-registered test, not findings:');
    for (const r of survivors) {
      const same = Math.sign(r.icTrain) === Math.sign(r.icHold);
      console.log(`  ${r.indicator} ${r.transform} H=${r.H}: train ${r.icTrain.toFixed(4)} (n=${r.nTrain}, ${r.tier})` +
        ` -> holdout ${Number.isFinite(r.icHold) ? r.icHold.toFixed(4) : 'n/a'} (n=${r.nHold})` +
        ` ${same ? 'SAME SIGN' : 'SIGN FLIPPED — not a finding'}`);
    }
  }

  console.log('');
  console.log('The holdout for these 17 series has now been read, and is burned.');
  await pool.end();
})().catch(env.fail);
