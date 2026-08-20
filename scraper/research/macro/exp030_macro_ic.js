'use strict';
/**
 * EXP-030 — does any macro indicator predict IHSG, and is it worth a place in
 * the regime layer?
 *
 * THE QUESTION IS DELIBERATELY NOT "add a 15th factor". The regime switch is the
 * one part of this system with a demonstrated effect — it held exposure at zero
 * through a 30% fall — and it currently sees only IHSG against its own 200-day
 * average. Purely endogenous. Macro is the obvious candidate for making that
 * decision better, and a per-stock score is the wrong home for a market-wide
 * variable anyway.
 *
 * METHOD, and every choice here is a defence against a known way of fooling
 * yourself:
 *
 *   - STRICTLY PRIOR. The feature at anchor t uses data through t only; the
 *     target is the IHSG return from t to t+H. No feature reads its own future.
 *   - NON-OVERLAPPING ANCHORS. Daily sampling with a 20-day forward window
 *     overlaps 19/20, which inflates significance enormously. Anchors are spaced
 *     H sessions apart on the exchange calendar, using the same helper EXP-026
 *     used, so n is small and honest rather than large and fake.
 *   - RANK IC, not Pearson. Macro series have fat tails and a single 2022 print
 *     should not carry a correlation.
 *   - BENJAMINI-HOCHBERG across every test in the family. 20 indicators x 2
 *     transforms x 2 horizons is 80 hypotheses; at alpha 0.05 four "findings"
 *     are expected from noise alone. Reporting the best one without FDR is how
 *     EXP-001 happened.
 *   - CHRONOLOGICAL HOLDOUT. Rank in-sample, then look once at the out-of-sample
 *     period. The holdout is burned the moment it is read, and that is recorded.
 *
 * Two transforms per indicator, chosen before seeing results:
 *   chg20  — 20-session percentage change. Momentum: is the dollar rising?
 *   z250   — z-score against the trailing 250 sessions. Level: is the dollar
 *            unusually high for where it has been?
 *
 * Usage: node scraper/research/macro/exp030_macro_ic.js
 */
const env = require("../env");
env.loadEnv();

const { createPool } = require('../../modules/db_config');
const stats = require('../../modules/statistics');
const mt = require('../candlestick/multiple_testing');

const HORIZONS = [20, 60];          // ~1 month and ~3 months of sessions
const ZWIN = 250;                   // trailing window for the level transform
const CHGWIN = 20;                  // lookback for the momentum transform
const SPLIT = '2025-02-01';         // chronological train/holdout boundary
const ALPHA = 0.05;

const toDateStr = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Spearman rank correlation, and a normal-approximation p-value. */
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
      const avg = (i + j) / 2 + 1;              // average rank for ties
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ic = stats.correlation(rank(xs), rank(ys));
  if (!Number.isFinite(ic) || Math.abs(ic) >= 1) return { ic, p: null, n };
  // Fisher z. Normal approximation is adequate here and matches the p-value
  // convention already used by multiple_testing.oneSampleP.
  const z = 0.5 * Math.log((1 + ic) / (1 - ic)) * Math.sqrt(n - 3);
  const p = 2 * (1 - stats.normalCDF(Math.abs(z)));
  return { ic, p: Math.min(1, Math.max(0, p)), n };
}

(async () => {
  const pool = createPool();

  // ── IHSG, the target, on the exchange's own calendar ──────────────────────
  const [ihsg] = await pool.query(
    'SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const dates = ihsg.map(r => toDateStr(r.date));
  const close = ihsg.map(r => Number(r.close_price));
  const sessionOf = new Map(dates.map((d, i) => [d, i]));

  // ── the macro panel ───────────────────────────────────────────────────────
  const [macro] = await pool.query(
    "SELECT indicator, date, value FROM ft_macro_data WHERE source <> 'FRED' ORDER BY indicator, date ASC");
  const byInd = new Map();
  for (const r of macro) {
    if (!byInd.has(r.indicator)) byInd.set(r.indicator, []);
    byInd.get(r.indicator).push({ d: toDateStr(r.date), v: Number(r.value) });
  }

  console.log('EXP-030 — macro predictive value for IHSG');
  console.log(`  IHSG sessions      : ${dates.length}  (${dates[0]} .. ${dates[dates.length - 1]})`);
  console.log(`  macro indicators   : ${byInd.size}`);
  console.log(`  horizons           : ${HORIZONS.join(', ')} sessions`);
  console.log(`  train / holdout    : up to ${SPLIT} / after`);
  console.log('');

  const results = [];

  for (const [indicator, series] of byInd) {
    // Align the macro series onto exchange sessions. A macro print on a day the
    // exchange was shut belongs to no session and is dropped rather than being
    // nudged onto a neighbour.
    const onSession = series
      .map(x => ({ i: sessionOf.get(x.d), v: x.v }))
      .filter(x => x.i !== undefined && Number.isFinite(x.v))
      .sort((a, b) => a.i - b.i);
    if (onSession.length < ZWIN + 60) continue;

    const valAt = new Map(onSession.map(x => [x.i, x.v]));

    for (const H of HORIZONS) {
      // Candidate anchors: sessions where the feature is computable AND the
      // forward window fits entirely inside the data.
      const candidates = [];
      for (const { i } of onSession) {
        if (i + H >= close.length) continue;

        // chg20 — strictly prior
        const back = valAt.get(i - CHGWIN);
        const cur = valAt.get(i);
        const chg20 = (back && back !== 0 && Number.isFinite(cur)) ? (cur / back - 1) : null;

        // z250 — strictly prior, over the trailing window only
        const win = [];
        for (let k = i - ZWIN + 1; k <= i; k++) {
          const v = valAt.get(k);
          if (Number.isFinite(v)) win.push(v);
        }
        let z250 = null;
        if (win.length >= ZWIN * 0.8) {
          const m = stats.mean(win);
          const sd = stats.stdDev(win);
          if (sd > 0) z250 = (cur - m) / sd;
        }

        const fwd = close[i + H] / close[i] - 1;
        if (!Number.isFinite(fwd)) continue;
        candidates.push({ sessionIndex: i, date: dates[i], chg20, z250, fwd });
      }

      const anchors = mt.nonOverlappingAnchors(candidates, H);

      for (const transform of ['chg20', 'z250']) {
        const usable = anchors.filter(a => Number.isFinite(a[transform]));
        const train = usable.filter(a => a.date < SPLIT);
        const hold = usable.filter(a => a.date >= SPLIT);

        const tr = spearman(train.map(a => a[transform]), train.map(a => a.fwd));
        const ho = spearman(hold.map(a => a[transform]), hold.map(a => a.fwd));

        results.push({
          indicator, transform, H,
          nTrain: tr.n, icTrain: tr.ic, p: tr.p,
          nHold: ho.n, icHold: ho.ic,
          tier: mt.evidenceTier(tr.n),
        });
      }
    }
  }

  // ── FDR across the whole family, not per indicator ────────────────────────
  const fdr = mt.benjaminiHochberg(results, ALPHA);

  results.sort((a, b) => (a.p ?? 1) - (b.p ?? 1));

  console.log('IN-SAMPLE RANK IC (non-overlapping anchors), ranked by p');
  console.log('  indicator      transf   H   nTr  IC_train      p       q     FDR  | nHo  IC_hold   sign');
  for (const r of results.slice(0, 18)) {
    const same = (Number.isFinite(r.icTrain) && Number.isFinite(r.icHold) &&
      Math.sign(r.icTrain) === Math.sign(r.icHold)) ? 'same' : 'FLIP';
    console.log(
      '  ' + r.indicator.padEnd(14) +
      r.transform.padEnd(8) +
      String(r.H).padStart(3) + '  ' +
      String(r.nTrain).padStart(4) + '  ' +
      (r.icTrain === null ? '   n/a' : (r.icTrain >= 0 ? ' ' : '') + r.icTrain.toFixed(4)).padStart(8) + '  ' +
      (r.p === null ? '  n/a' : r.p.toFixed(4)).padStart(7) + ' ' +
      (r.q === null ? '  n/a' : r.q.toFixed(4)).padStart(7) + '  ' +
      (r.rejected ? 'PASS' : '  - ') + '  | ' +
      String(r.nHold).padStart(3) + '  ' +
      (r.icHold === null ? '   n/a' : (r.icHold >= 0 ? ' ' : '') + r.icHold.toFixed(4)).padStart(8) + '  ' + same);
  }

  console.log('');
  console.log(`FDR: ${fdr.rejected} of ${fdr.m} hypotheses survive at alpha ${ALPHA}` +
    (fdr.threshold !== null ? ` (p <= ${fdr.threshold.toFixed(5)})` : ''));

  const survivors = results.filter(r => r.rejected);
  if (!survivors.length) {
    console.log('');
    console.log(`NOTHING SURVIVES. With ${fdr.m} hypotheses about ${Math.round(fdr.m * ALPHA)} would clear an`);
    console.log('uncorrected 0.05 by chance alone, which is why the correction is');
    console.log('applied to the whole family rather than to the winner.');
  } else {
    console.log('');
    console.log('SURVIVORS, and whether the holdout agrees on SIGN:');
    for (const r of survivors) {
      const same = Math.sign(r.icTrain) === Math.sign(r.icHold);
      console.log(`  ${r.indicator} ${r.transform} H=${r.H}: train IC ${r.icTrain.toFixed(4)} ` +
        `(n=${r.nTrain}, ${r.tier}) -> holdout IC ${Number.isFinite(r.icHold) ? r.icHold.toFixed(4) : 'n/a'} ` +
        `(n=${r.nHold}) ${same ? 'SAME SIGN' : 'SIGN FLIPPED — not a finding'}`);
    }
  }

  console.log('');
  console.log('The holdout has now been read. It is burned for this family of');
  console.log('hypotheses and cannot serve as clean evidence for them again.');

  await pool.end();
})().catch(env.fail);
