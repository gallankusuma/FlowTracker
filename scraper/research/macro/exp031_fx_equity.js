'use strict';
/**
 * EXP-031 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-20_fx_equity.md.
 *
 * H1: in an emerging market, a rise in USD/local over the prior 20 sessions
 *     (the local currency weakening) predicts a LOWER local equity return over
 *     the following 20 sessions. One-sided; direction fixed in advance.
 *
 * Nine markets this project has never queried for returns. Indonesia is run too
 * but reported SEPARATELY and excluded from the statistic — it is the in-sample
 * observation that motivated the hypothesis, and scoring it would be marking the
 * exam with the answer sheet.
 *
 * One horizon, one transform, one test. m = 1, so no multiplicity correction
 * applies, which is the whole reason for registering a mechanism instead of
 * screening eighty.
 *
 * Usage: node scraper/research/macro/exp031_fx_equity.js
 * Requires: yfinance data fetched by the companion Python helper (see --fetch).
 */
const fs = require('fs');
const path = require('path');
const stats = require('../../modules/statistics');

const H = 20;                 // horizon, sessions
const CHG = 20;               // feature lookback, sessions
const DATA = path.join(__dirname, 'exp031_data.json');

const MARKETS = [
  ['India',       '^BSESN',   'INR=X'],
  ['Thailand',    '^SET.BK',  'THB=X'],
  ['Philippines', 'PSEI.PS',  'PHP=X'],
  ['Malaysia',    '^KLSE',    'MYR=X'],
  ['Brazil',      '^BVSP',    'BRL=X'],
  ['Mexico',      '^MXX',     'MXN=X'],
  ['Turkey',      'XU100.IS', 'TRY=X'],
  ['SouthAfrica', '^J203.JO', 'ZAR=X'],
  ['Korea',       '^KS11',    'KRW=X'],
];
const INSAMPLE = ['Indonesia', '^JKSE', 'IDR=X'];

/** Spearman rank IC, plus a one-sided p in the PREDICTED (negative) direction. */
function spearmanOneSided(xs, ys) {
  const n = xs.length;
  if (n < 8) return { ic: null, z: null, p: null, n };
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
  if (!Number.isFinite(ic) || Math.abs(ic) >= 1) return { ic, z: null, p: null, n };
  const z = 0.5 * Math.log((1 + ic) / (1 - ic)) * Math.sqrt(n - 3);
  // One-sided toward NEGATIVE ic: p = P(Z <= z) under the null.
  const p = stats.normalCDF(z);
  return { ic, z, p: Math.min(1, Math.max(0, p)), n };
}

function analyse(eqSeries, fxSeries) {
  // Align on dates where BOTH have a close. Never carry a value forward: a
  // holiday in one market is missing data, not a repeat of yesterday.
  const fx = new Map(fxSeries.map(r => [r.d, r.c]));
  const rows = eqSeries
    .filter(r => fx.has(r.d))
    .map(r => ({ d: r.d, eq: r.c, fx: fx.get(r.d) }))
    .sort((a, b) => (a.d < b.d ? -1 : 1));

  const anchors = [];
  for (let i = CHG; i + H < rows.length; i += H) {   // spacing H => non-overlapping
    const f0 = rows[i - CHG].fx, f1 = rows[i].fx;
    if (!(f0 > 0) || !(f1 > 0)) continue;
    const chg = f1 / f0 - 1;
    const fwd = rows[i + H].eq / rows[i].eq - 1;
    if (!Number.isFinite(chg) || !Number.isFinite(fwd)) continue;
    anchors.push({ chg, fwd });
  }
  return { anchors, ...spearmanOneSided(anchors.map(a => a.chg), anchors.map(a => a.fwd)) };
}

if (!fs.existsSync(DATA)) {
  console.error('Missing ' + DATA);
  console.error('Fetch it first:  .venv/bin/python3 research/macro/exp031_fetch.py');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));

console.log('EXP-031 — pre-registered: USD/local up 20d  ->  local equity down over the next 20d');
console.log('  one-sided, direction fixed in PREREGISTRATION_2026-08-20_fx_equity.md');
console.log('  m = 1 hypothesis, so no multiplicity correction applies');
console.log('');
console.log('OUT-OF-SAMPLE MARKETS (never queried by this project before today)');
console.log('  market          n     IC        z        one-sided p');

const results = [];
for (const [name, eq, fxs] of MARKETS) {
  if (!raw[eq] || !raw[fxs]) { console.log(`  ${name.padEnd(14)} (data missing)`); continue; }
  const r = analyse(raw[eq], raw[fxs]);
  results.push({ name, ...r });
  console.log('  ' + name.padEnd(14) +
    String(r.n).padStart(4) + '  ' +
    (r.ic === null ? '   n/a' : (r.ic >= 0 ? ' ' : '') + r.ic.toFixed(4)).padStart(8) + '  ' +
    (r.z === null ? '   n/a' : (r.z >= 0 ? ' ' : '') + r.z.toFixed(3)).padStart(8) + '  ' +
    (r.p === null ? '  n/a' : r.p.toFixed(4)).padStart(10));
}

// ── primary test: Stouffer across markets, equally weighted ──────────────────
const usable = results.filter(r => Number.isFinite(r.z));
const combinedZ = usable.reduce((s, r) => s + r.z, 0) / Math.sqrt(usable.length);
const combinedP = stats.normalCDF(combinedZ);

console.log('');
console.log('PRIMARY TEST — Stouffer combined Z, one-sided toward negative');
console.log(`  markets combined : ${usable.length}`);
console.log(`  combined Z       : ${combinedZ.toFixed(4)}`);
console.log(`  combined p       : ${combinedP.toFixed(5)}`);
console.log(`  VERDICT          : ${combinedP < 0.05 ? 'CONFIRMED' : 'NOT CONFIRMED'} at the pre-registered 0.05`);

// ── secondary, descriptive only ─────────────────────────────────────────────
const neg = usable.filter(r => r.ic < 0).length;
console.log('');
console.log(`SECONDARY (descriptive, not decisive): ${neg} of ${usable.length} markets negative`);

// ── in-sample, reported apart and excluded from the statistic ───────────────
const [inName, inEq, inFx] = INSAMPLE;
if (raw[inEq] && raw[inFx]) {
  const r = analyse(raw[inEq], raw[inFx]);
  console.log('');
  console.log('IN-SAMPLE, EXCLUDED FROM THE TEST (this is what motivated the hypothesis)');
  console.log(`  ${inName}: n=${r.n}  IC=${r.ic === null ? 'n/a' : r.ic.toFixed(4)}  ` +
    `one-sided p=${r.p === null ? 'n/a' : r.p.toFixed(4)}`);
  console.log('  Not evidence. Included only so the comparison is visible.');
}
