'use strict';
/**
 * EXP-040 — how many INDEPENDENT signals do we actually have?
 *
 * A DIAGNOSTIC. No verdict, no hypothesis, and nothing here may be quoted as a
 * finding.
 *
 * ── THE QUESTION, AND WHY IT IS DIFFERENT FROM EVERY EARLIER ONE ─────────────
 *
 * Medallion has no "strategy". It has thousands of weak signals combined, and
 * not one of them would survive the tests this project runs -- because those
 * tests ask "does this make money", which is the wrong question for a component.
 *
 * Our whole apparatus is built to REJECT, and rejection at the individual level
 * is exactly what would be observed even if a profitable ensemble existed. A
 * signal with an IC of 0.05 is useless alone and valuable as one of fifty
 * uncorrelated ones.
 *
 * So the question changes: not "does this pay" but "does this carry information
 * the others do not". Two things have to be true at once, and the pair is the
 * whole point:
 *
 *   1. the signal is not redundant with the ones we already have, and
 *   2. it carries a non-zero IC of its own.
 *
 * Either alone is worthless. Fifty copies of the same signal are one signal;
 * fifty independent zeros are still zero.
 *
 * ── WHAT IS MEASURED ─────────────────────────────────────────────────────────
 *
 * Cross-sectional rank correlation, not time-series. These factors are used to
 * RANK tickers against each other on a date, so two factors that move together
 * over time can still order the cross-section differently, and it is the
 * ordering that is traded.
 *
 * Source is idx_signal_history -- the values production actually computed and
 * stored, not a recomputation that might differ from what shipped.
 *
 * ── WHAT THIS CANNOT TELL US ─────────────────────────────────────────────────
 *
 * The window is 2026-01-19 to 2026-08-31: SEVEN AND A HALF MONTHS, one market
 * period. Correlations between factors are structural and travel reasonably;
 * ICs measured over one regime do not. The IC column here is the weaker half of
 * this file and is labelled as such.
 *
 * F14 is a RISK multiplier, not a directional score. A directional IC near zero
 * is what it is designed to produce, and it is included only so that absence
 * shows up as a measurement rather than as a gap.
 *
 * Usage: node scraper/research/exp040_orthogonality.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const FACTORS = [
  ['f1_concentration', 'F1 concentration (dn0)'],
  ['f2_trend', 'F2 trend (dn0..dn4)'],
  ['f3_volume_z', 'F3 volume z'],
  ['f4_momentum', 'F4 momentum'],
  ['f5_rel_strength', 'F5 rel strength'],
  ['f6_breadth', 'F6 breadth'],
  ['f7_alignment', 'F7 alignment'],
  ['f8_streak', 'F8 streak'],
  ['f9_rsi', 'F9 RSI'],
  ['f10_macd', 'F10 MACD'],
  ['f11_bollinger', 'F11 Bollinger'],
  ['f12_ema_trend', 'F12 EMA trend'],
  ['f13_support_resistance', 'F13 support/resistance'],
  ['f14_atr', 'F14 ATR (risk, not direction)'],
];
const TARGET = 'return_10d';
const MIN_CROSS = 30;        // a cross-section smaller than this says nothing
const REDUNDANT = 0.5;       // |rho| above this counts as the same signal

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Ranks with ties averaged. */
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
  const r = new Array(a.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length;
  if (n < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));

(async () => {
  const pool = createPool();
  const cols = FACTORS.map(f => f[0]).join(', ');
  const [rows] = await pool.query(
    `SELECT data_date, stock_code, ${cols}, ${TARGET} FROM idx_signal_history ORDER BY data_date`);

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= MIN_CROSS);

  console.log('EXP-040 — how many INDEPENDENT signals do we actually have? A DIAGNOSTIC.');
  console.log(`  ${rows.length} stored factor rows, ${dates.length} usable cross-sections`);
  console.log(`  ${dates[0]} .. ${dates[dates.length - 1]} — SEVEN AND A HALF MONTHS, one regime.`);
  console.log('  Correlations travel; the ICs below do not. Read them accordingly.');
  console.log('');

  // ── pairwise cross-sectional rank correlation ─────────────────────────────
  const N = FACTORS.length;
  const corr = Array.from({ length: N }, () => new Array(N).fill(null));
  const perDate = Array.from({ length: N }, () => Array.from({ length: N }, () => []));
  const icAcc = FACTORS.map(() => []);

  for (const d of dates) {
    const cross = byDate.get(d);
    const vals = FACTORS.map(f => cross.map(r => Number(r[f[0]])));
    const tgt = cross.map(r => (r[TARGET] === null ? null : Number(r[TARGET])));
    const ok = tgt.map(v => v !== null && Number.isFinite(v));

    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const c = spearman(vals[i], vals[j]);
        if (c !== null && Number.isFinite(c)) perDate[i][j].push(c);
      }
      const xs = [], ys = [];
      for (let k = 0; k < cross.length; k++) if (ok[k]) { xs.push(vals[i][k]); ys.push(tgt[k]); }
      if (xs.length >= MIN_CROSS) {
        const ic = spearman(xs, ys);
        if (ic !== null && Number.isFinite(ic)) icAcc[i].push(ic);
      }
    }
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    corr[i][j] = corr[j][i] = mean(perDate[i][j]);
  }

  console.log('PAIRWISE CROSS-SECTIONAL RANK CORRELATION (mean over dates)');
  console.log('        ' + FACTORS.map((_, i) => ('F' + (i + 1)).padStart(6)).join(''));
  for (let i = 0; i < N; i++) {
    console.log(('F' + (i + 1)).padStart(6) + '  ' + FACTORS.map((_, j) =>
      (i === j ? '  1.00' : corr[i][j] === null ? '     ·' : corr[i][j].toFixed(2).padStart(6))).join(''));
  }

  console.log('');
  console.log(`STANDALONE RANK IC vs ${TARGET} — the weak half of this file, one regime only`);
  console.log('  factor                          mean IC    IR    dates');
  const ics = FACTORS.map((f, i) => {
    const a = icAcc[i];
    const m = mean(a);
    const s = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : null;
    return { i, name: f[1], ic: m, ir: s ? m / s : null, n: a.length };
  });
  ics.slice().sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic)).forEach(x =>
    console.log('  ' + x.name.padEnd(32) + (x.ic === null ? '  n/a' : x.ic.toFixed(4).padStart(7)) +
      (x.ir === null ? '     n/a' : x.ir.toFixed(2).padStart(7)) + String(x.n).padStart(9)));

  // ── the greedy independent set ────────────────────────────────────────────
  //
  // Take the strongest carrier, drop everything redundant with it, repeat. This
  // is deliberately crude: the point is an order-of-magnitude answer to "do we
  // have fifty signals or four", not a factor model.
  console.log('');
  console.log(`INDEPENDENT SET — greedy, dropping anything with |rho| > ${REDUNDANT} of a kept factor`);
  const order = ics.slice().sort((a, b) => Math.abs(b.ic) - Math.abs(a.ic));
  const kept = [], dropped = [];
  for (const cand of order) {
    const clash = kept.find(k => Math.abs(corr[k.i][cand.i] ?? 0) > REDUNDANT);
    if (clash) dropped.push({ ...cand, because: clash.name, rho: corr[clash.i][cand.i] });
    else kept.push(cand);
  }
  kept.forEach(k => console.log(`  KEEP  ${k.name.padEnd(32)} IC ${k.ic.toFixed(4)}`));
  dropped.forEach(d => console.log(`  drop  ${d.name.padEnd(32)} IC ${d.ic.toFixed(4)}   rho ${d.rho.toFixed(2)} with ${d.because}`));

  const carriers = kept.filter(k => Math.abs(k.ic) >= 0.02);
  console.log('');
  console.log(`  independent factors            : ${kept.length} of ${N}`);
  console.log(`  ...that also carry |IC| >= 0.02: ${carriers.length}`);
  console.log('  Both conditions matter: copies of one signal are one signal, and');
  console.log('  independent zeros are still zero.');

  // ── does combining them beat the best single one? ──────────────────────────
  console.log('');
  console.log('THE MEDALLION QUESTION — does an equal-weight blend of the independent set');
  console.log('beat the best single factor?');
  const blendIC = [];
  for (const d of dates) {
    const cross = byDate.get(d);
    const tgt = cross.map(r => (r[TARGET] === null ? null : Number(r[TARGET])));
    const usable = cross.map((_, k) => tgt[k] !== null && Number.isFinite(tgt[k]));
    if (usable.filter(Boolean).length < MIN_CROSS) continue;
    // Each factor ranked within the date, signed by its own IC so a negative
    // carrier contributes its information instead of cancelling a positive one.
    const parts = carriers.map(c => {
      const v = cross.map(r => Number(r[FACTORS[c.i][0]]));
      const rk = ranks(v);
      const sign = c.ic >= 0 ? 1 : -1;
      return rk.map(x => sign * x / rk.length);
    });
    if (!parts.length) break;
    const blend = cross.map((_, k) => mean(parts.map(p => p[k])));
    const xs = [], ys = [];
    for (let k = 0; k < cross.length; k++) if (usable[k]) { xs.push(blend[k]); ys.push(tgt[k]); }
    const ic = spearman(xs, ys);
    if (ic !== null && Number.isFinite(ic)) blendIC.push(ic);
  }
  const bm = mean(blendIC);
  const bs = blendIC.length > 1 ? Math.sqrt(blendIC.reduce((x, y) => x + (y - bm) ** 2, 0) / (blendIC.length - 1)) : null;
  const best = carriers.length ? carriers.reduce((a, b) => (Math.abs(b.ic) > Math.abs(a.ic) ? b : a)) : null;
  if (best && bm !== null) {
    console.log(`  best single carrier : ${best.name} — |IC| ${Math.abs(best.ic).toFixed(4)}, IR ${best.ir.toFixed(2)}`);
    console.log(`  equal-weight blend  : |IC| ${Math.abs(bm).toFixed(4)}, IR ${(bs ? bm / bs : 0).toFixed(2)}  over ${blendIC.length} dates`);
    console.log(`  -> the blend ${Math.abs(bm) > Math.abs(best.ic) ? 'BEATS' : 'does NOT beat'} the best single factor` +
      ` (${((Math.abs(bm) / Math.abs(best.ic) - 1) * 100).toFixed(0)}%)`);
    console.log('     IR matters more than IC here: combining is supposed to buy STABILITY,');
    console.log('     not a bigger number.');
  } else {
    console.log('  no carrier cleared the |IC| floor, so there is nothing to blend.');
  }

  console.log('');
  console.log('NO VERDICT. One regime, no holdout, and the ICs are the fragile half.');
  await pool.end();
})().catch(env.fail);
