'use strict';
/**
 * The signal map — which of our factors are actually different from each other.
 *
 * EXP-040 measured this once and the answer reframed the project: fourteen
 * factors are about FOUR distinct things. F1 and F8 correlate 0.91; F11 and F12
 * correlate -0.83. Those are not related measurements, they are the same
 * measurement under different names.
 *
 * That fact is operationally useful, not just interesting, which is why it lives
 * in a module a page can call rather than in a research script that ran once:
 * before adding any indicator, the question is which cluster it lands in.
 * Another oscillator adds nothing to a system that already has five.
 *
 * ── CROSS-SECTIONAL, NOT TIME-SERIES ─────────────────────────────────────────
 *
 * These factors RANK tickers against each other on a date, and the ranking is
 * what gets traded. Two factors can move together through time and still order
 * the cross-section differently, so the correlation that matters is computed
 * within each date and averaged, never across the pooled panel.
 *
 * ── THE HALF OF THIS THAT IS FRAGILE ─────────────────────────────────────────
 *
 * Correlations between factors are structural and travel between regimes. The
 * ICs do not: they are measured over whatever window idx_signal_history happens
 * to hold, which at the time of writing is about seven months inside one IHSG
 * drawdown. Callers must show them as the weaker number, and `meta.regimeWarning`
 * carries that sentence so a page cannot forget to.
 */

const CACHE_MS = 30 * 60 * 1000;
let cache = null;

const FACTORS = [
  ['f1_concentration', 'F1', 'Concentration (dn0)'],
  ['f2_trend', 'F2', 'Trend (dn0..dn4)'],
  ['f3_volume_z', 'F3', 'Volume z-score'],
  ['f4_momentum', 'F4', 'Momentum'],
  ['f5_rel_strength', 'F5', 'Relative strength'],
  ['f6_breadth', 'F6', 'Breadth'],
  ['f7_alignment', 'F7', 'Price/flow alignment'],
  ['f8_streak', 'F8', 'Accumulation streak'],
  ['f9_rsi', 'F9', 'RSI'],
  ['f10_macd', 'F10', 'MACD'],
  ['f11_bollinger', 'F11', 'Bollinger %B'],
  ['f12_ema_trend', 'F12', 'EMA trend'],
  ['f13_support_resistance', 'F13', 'Support/resistance'],
  ['f14_atr', 'F14', 'ATR (risk, not direction)'],
];

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

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
  if (a.length < 3) return null;
  const ma = mean(a), mb = mean(b);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));

/**
 * @param {import('mysql2/promise').Pool} pool
 * @param {{target?: string, minCross?: number, redundant?: number, force?: boolean}} [opts]
 */
async function computeSignalMap(pool, opts = {}) {
  const target = opts.target === 'return_5d' ? 'return_5d' : 'return_10d';
  const minCross = opts.minCross || 30;
  const redundant = opts.redundant ?? 0.5;

  const [[latest]] = await pool.query('SELECT MAX(data_date) d FROM idx_signal_history');
  if (!latest || !latest.d) return { error: 'idx_signal_history is empty' };
  const asOf = latest.d.toISOString().slice(0, 10);
  const key = `${asOf}|${target}|${redundant}`;
  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.data, cached: true };
  }

  const cols = FACTORS.map(f => f[0]).join(', ');
  const [rows] = await pool.query(
    `SELECT data_date, ${cols}, ${target} FROM idx_signal_history ORDER BY data_date`);

  const byDate = new Map();
  for (const r of rows) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }
  const dates = [...byDate.keys()].sort().filter(d => byDate.get(d).length >= minCross);

  const N = FACTORS.length;
  const pair = Array.from({ length: N }, () => Array.from({ length: N }, () => []));
  const icAcc = FACTORS.map(() => []);

  for (const d of dates) {
    const cross = byDate.get(d);
    const vals = FACTORS.map(f => cross.map(r => Number(r[f[0]])));
    const tgt = cross.map(r => (r[target] === null ? null : Number(r[target])));
    const ok = tgt.map(v => v !== null && Number.isFinite(v));
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const c = spearman(vals[i], vals[j]);
        if (c !== null && Number.isFinite(c)) pair[i][j].push(c);
      }
      const xs = [], ys = [];
      for (let k = 0; k < cross.length; k++) if (ok[k]) { xs.push(vals[i][k]); ys.push(tgt[k]); }
      if (xs.length >= minCross) {
        const ic = spearman(xs, ys);
        if (ic !== null && Number.isFinite(ic)) icAcc[i].push(ic);
      }
    }
  }

  const corr = Array.from({ length: N }, (_, i) =>
    Array.from({ length: N }, (_, j) => (i === j ? 1 : mean(pair[Math.min(i, j)][Math.max(i, j)]))));

  const factors = FACTORS.map((f, i) => {
    const a = icAcc[i];
    const m = mean(a);
    const s = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : null;
    const ir = s ? m / s : null;
    return {
      key: f[0], short: f[1], label: f[2], index: i,
      ic: m === null ? null : Math.round(m * 1e4) / 1e4,
      ir: ir === null ? null : Math.round(ir * 100) / 100,
      // t is what says whether an IC is distinguishable from zero at all, and it
      // is the number a reader should look at before the IC itself.
      t: ir === null ? null : Math.round(ir * Math.sqrt(a.length) * 100) / 100,
      dates: a.length,
    };
  });

  // Greedy: keep the strongest carrier, drop whatever is redundant with it.
  // Deliberately crude — the question is "four signals or fifty", not a factor model.
  const order = factors.slice().sort((a, b) => Math.abs(b.ic ?? 0) - Math.abs(a.ic ?? 0));
  const kept = [], dropped = [];
  for (const cand of order) {
    const clash = kept.find(k => Math.abs(corr[k.index][cand.index] ?? 0) > redundant);
    if (clash) dropped.push({ ...cand, redundantWith: clash.short, rho: Math.round(corr[clash.index][cand.index] * 100) / 100 });
    else kept.push(cand);
  }

  const data = {
    asOf, target, redundantAbove: redundant,
    meta: {
      rows: rows.length, dates: dates.length,
      from: dates[0] || null, to: dates[dates.length - 1] || null,
      regimeWarning:
        'Correlations between factors are structural and travel between regimes. The ICs do NOT — ' +
        'they are measured over one window, and at the time of writing that window sits inside a ' +
        'single IHSG drawdown. Read the ICs as the fragile half, and the t-column before the IC.',
    },
    factors,
    corr: corr.map(row => row.map(v => (v === null ? null : Math.round(v * 100) / 100))),
    independent: kept.map(k => ({ short: k.short, label: k.label, ic: k.ic })),
    redundantFactors: dropped.map(d => ({ short: d.short, label: d.label, ic: d.ic, redundantWith: d.redundantWith, rho: d.rho })),
    carriers: kept.filter(k => Math.abs(k.ic ?? 0) >= 0.02).length,
  };
  cache = { key, at: Date.now(), data };
  return { ...data, cached: false };
}

module.exports = { computeSignalMap, FACTORS };
