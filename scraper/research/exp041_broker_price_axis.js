'use strict';
/**
 * EXP-041 — is there anything in the EMPTY quadrant?
 *
 * A DIAGNOSTIC. No verdict, no hypothesis, nothing quotable as a finding.
 *
 * ── WHAT EXP-040 ACTUALLY SAID, AND WHAT IT DID NOT ──────────────────────────
 *
 * Fourteen factors turned out to be about four distinct things, and "broker
 * data" is NOT one of the empty quadrants -- F1, F2, F7 and F8 are already a
 * dense cluster correlating 0.47 to 0.91. Adding another measure of how MUCH the
 * top brokers bought would land straight in it.
 *
 * What is genuinely absent from that matrix is two other dimensions of the same
 * dataset:
 *
 *   PRICE.    idx_broker_summary carries buy_avg / sell_avg per broker per day,
 *             so the price the accumulating side actually PAID is knowable.
 *             Nothing in F1-F14 measures a price relationship of any kind --
 *             they all measure magnitude, direction or momentum.
 *
 *   IDENTITY. Concentration counts the top three brokers by net value and does
 *             not care who they are. The registry now separates measured foreign
 *             flow from retail platforms, and EXP-016's inverted finding is
 *             precisely the kind of thing an identity split could explain --
 *             if "accumulation" predicts underperformance, it matters enormously
 *             whether the accumulator was a foreign desk or a retail app.
 *
 * The test that matters is NOT whether these have a big IC. It is whether they
 * sit outside the existing clusters AND carry something. Either alone is
 * worthless: a fifteenth momentum measure is redundant, and an independent zero
 * is still zero.
 *
 * ── ONE HONEST WEAKNESS, STATED UP FRONT ─────────────────────────────────────
 *
 * The foreign share per broker is a CONSTANT computed over all of
 * idx_broker_flow_detail (2025-12 onward) and applied backwards. A broker's
 * client mix can change, so this is a static classification projected onto
 * history. It is the best available and it is not free of assumption.
 *
 * Usage: node scraper/research/exp041_broker_price_axis.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { loadRegistry } = require('../modules/broker_registry');

const WINDOW = 60;           // sessions of broker history behind each signal date
const SHORT = 20;            // sessions for the flow-direction signals
const TARGET = 'return_10d';
const MIN_CROSS = 30;
const FOREIGN_FLOOR = 50;    // measured % of value tagged foreign

const EXISTING = [
  'f1_concentration', 'f2_trend', 'f3_volume_z', 'f4_momentum', 'f5_rel_strength',
  'f6_breadth', 'f7_alignment', 'f8_streak', 'f9_rsi', 'f10_macd',
  'f11_bollinger', 'f12_ema_trend', 'f13_support_resistance', 'f14_atr',
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

/** The new signals, all built from price and identity rather than magnitude. */
const NEW = [
  { key: 'costBasisGap', label: 'cost-basis gap (close vs what buyers paid)' },
  { key: 'buyerDispersion', label: 'buyer price dispersion' },
  { key: 'foreignNet', label: 'foreign-flow net share' },
  { key: 'retailNet', label: 'retail-platform net share' },
  { key: 'foreignMinusRetail', label: 'foreign minus retail divergence' },
];

(async () => {
  const pool = createPool();
  const reg = await loadRegistry(pool);
  const isForeign = c => (reg.byCode.get(c)?.foreignPct ?? 0) >= FOREIGN_FLOOR;
  const isRetail = c => reg.byCode.get(c)?.clientBase === 'RETAIL_PLATFORM';

  const [hist] = await pool.query(
    `SELECT data_date, stock_code, ${EXISTING.join(', ')}, ${TARGET}
       FROM idx_signal_history ORDER BY stock_code, data_date`);
  // Grouped once. Filtering `hist` inside the per-ticker loop would be 648 x
  // 38,830 comparisons for no reason.
  const histByTicker = new Map();
  for (const r of hist) {
    if (!histByTicker.has(r.stock_code)) histByTicker.set(r.stock_code, []);
    histByTicker.get(r.stock_code).push(r);
  }
  const tickers = [...histByTicker.keys()];
  const from = hist.reduce((a, r) => (a && a < r.data_date ? a : r.data_date), null);

  console.log('EXP-041 — is there anything in the EMPTY quadrant? A DIAGNOSTIC.');
  console.log('  EXP-040 showed F1/F2/F7/F8 are one dense cluster, so "broker data" is not');
  console.log('  an empty quadrant. PRICE and IDENTITY are. Nothing in F1-F14 measures');
  console.log('  what the accumulating side PAID, or WHO it was.');
  console.log(`  ${hist.length} stored rows, ${tickers.length} tickers, target ${TARGET}`);
  console.log('  Foreign share is a per-broker CONSTANT projected onto history — stated,');
  console.log('  not hidden.');
  console.log('');

  // key = `${ticker}|${date}` -> the five new values
  const built = new Map();
  let noBroker = 0;

  for (const t of tickers) {
    const [bk] = await pool.query(
      `SELECT date, broker_code, buy_val, buy_lot, sell_val, sell_lot, net_val
         FROM idx_broker_summary WHERE stock_code = ? AND date >= DATE_SUB(?, INTERVAL 140 DAY)
         ORDER BY date ASC`, [t, from]);
    if (!bk.length) { noBroker++; continue; }

    const byDate = new Map();
    for (const r of bk) {
      const d = r.date.toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }
    const dateList = [...byDate.keys()].sort();
    const idxOf = new Map(dateList.map((d, i) => [d, i]));

    for (const row of histByTicker.get(t)) {
      const d = row.data_date.toISOString().slice(0, 10);
      const at = idxOf.get(d);
      if (at === undefined) continue;

      const wide = dateList.slice(Math.max(0, at - WINDOW + 1), at + 1).flatMap(x => byDate.get(x));
      const short = dateList.slice(Math.max(0, at - SHORT + 1), at + 1).flatMap(x => byDate.get(x));
      if (!wide.length) continue;

      // ── PRICE: what the net buyers actually paid, over the wide window ─────
      const net = new Map();
      for (const r of wide) {
        const e = net.get(r.broker_code) || { net: 0, bv: 0, bl: 0 };
        e.net += +r.net_val; e.bv += +r.buy_val; e.bl += +r.buy_lot;
        net.set(r.broker_code, e);
      }
      const buyers = [...net.values()].filter(x => x.net > 0 && x.bl > 0);
      const lots = buyers.reduce((a, x) => a + x.bl, 0);
      const vwap = lots ? buyers.reduce((a, x) => a + x.bv, 0) / lots : null;

      // Dispersion: are the accumulators clustered at one price or spread out?
      // A tight cluster is a different situation from many buyers at many prices,
      // and no existing factor distinguishes them.
      let disp = null;
      if (buyers.length >= 3 && vwap > 0) {
        const px = buyers.map(x => x.bv / x.bl);
        const m = mean(px);
        disp = Math.sqrt(px.reduce((a, x) => a + (x - m) ** 2, 0) / (px.length - 1)) / m;
      }

      // ── IDENTITY: who was on which side, over the short window ────────────
      let fgn = 0, ret = 0, tot = 0;
      for (const r of short) {
        const v = +r.buy_val + +r.sell_val;
        tot += v;
        if (isForeign(r.broker_code)) fgn += +r.net_val;
        if (isRetail(r.broker_code)) ret += +r.net_val;
      }
      const fShare = tot > 0 ? fgn / tot : null;
      const rShare = tot > 0 ? ret / tot : null;

      built.set(`${t}|${d}`, {
        costBasisGap: null,      // needs the close; filled in the pass below
        _vwap: vwap, buyerDispersion: disp,
        foreignNet: fShare, retailNet: rShare,
        foreignMinusRetail: fShare !== null && rShare !== null ? fShare - rShare : null,
      });
    }
  }

  // costBasisGap needs the close, which lives in the price table.
  const [px] = await pool.query(
    `SELECT stock_code, date, close_price c FROM idx_stock_prices
      WHERE close_price > 0 AND date >= DATE_SUB(?, INTERVAL 5 DAY)`, [from]);
  const closeOf = new Map(px.map(r => [`${r.stock_code}|${r.date.toISOString().slice(0, 10)}`, +r.c]));
  for (const [k, v] of built) {
    const c = closeOf.get(k);
    v.costBasisGap = (c > 0 && v._vwap > 0) ? c / v._vwap - 1 : null;
  }

  console.log(`built for ${built.size} of ${hist.length} rows` + (noBroker ? `  (${noBroker} tickers had no broker history)` : ''));

  // ── measure ───────────────────────────────────────────────────────────────
  const byDate = new Map();
  for (const r of hist) {
    const d = r.data_date.toISOString().slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(r);
  }

  const corrAcc = NEW.map(() => EXISTING.map(() => []));
  const icAcc = NEW.map(() => []);
  const cover = NEW.map(() => 0);

  for (const [d, cross] of byDate) {
    const withNew = cross.map(r => built.get(`${r.stock_code}|${d}`)).map(x => x || {});
    NEW.forEach((sig, si) => {
      const vals = withNew.map(x => x[sig.key]);
      const ok = vals.map(v => v !== null && v !== undefined && Number.isFinite(v));
      cover[si] += ok.filter(Boolean).length;
      if (ok.filter(Boolean).length < MIN_CROSS) return;

      EXISTING.forEach((ex, ei) => {
        const a = [], b = [];
        cross.forEach((r, k) => { if (ok[k] && r[ex] !== null) { a.push(vals[k]); b.push(Number(r[ex])); } });
        if (a.length >= MIN_CROSS) {
          const c = spearman(a, b);
          if (c !== null && Number.isFinite(c)) corrAcc[si][ei].push(c);
        }
      });

      const xs = [], ys = [];
      cross.forEach((r, k) => {
        const tg = r[TARGET];
        if (ok[k] && tg !== null && Number.isFinite(Number(tg))) { xs.push(vals[k]); ys.push(Number(tg)); }
      });
      if (xs.length >= MIN_CROSS) {
        const ic = spearman(xs, ys);
        if (ic !== null && Number.isFinite(ic)) icAcc[si].push(ic);
      }
    });
  }

  console.log('');
  console.log('CORRELATION WITH THE EXISTING FOURTEEN (mean cross-sectional rank rho)');
  console.log('  signal                                   ' + EXISTING.map((_, i) => ('F' + (i + 1)).padStart(6)).join(''));
  NEW.forEach((sig, si) => {
    console.log('  ' + sig.label.padEnd(42) + EXISTING.map((_, ei) => {
      const m = mean(corrAcc[si][ei]);
      return m === null ? '     ·' : m.toFixed(2).padStart(6);
    }).join(''));
  });
  console.log('');
  console.log('  max |rho| against any existing factor:');
  NEW.forEach((sig, si) => {
    const maxes = EXISTING.map((ex, ei) => ({ ex, m: mean(corrAcc[si][ei]) })).filter(x => x.m !== null);
    if (!maxes.length) { console.log('  ' + sig.label.padEnd(42) + 'n/a'); return; }
    const worst = maxes.reduce((a, b) => (Math.abs(b.m) > Math.abs(a.m) ? b : a));
    console.log('  ' + sig.label.padEnd(42) + Math.abs(worst.m).toFixed(2).padStart(5) + '  (' + worst.ex + ')' +
      (Math.abs(worst.m) < 0.5 ? '   <- OUTSIDE every existing cluster' : '   <- redundant'));
  });

  console.log('');
  console.log(`STANDALONE RANK IC vs ${TARGET} — the fragile half, one regime`);
  console.log('  signal                                    mean IC     IR   dates   coverage');
  NEW.forEach((sig, si) => {
    const a = icAcc[si];
    const m = mean(a);
    const s = a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : null;
    console.log('  ' + sig.label.padEnd(42) +
      (m === null ? '    n/a' : m.toFixed(4).padStart(8)) +
      (s ? (m / s).toFixed(2).padStart(7) : '    n/a') +
      String(a.length).padStart(8) + String(cover[si]).padStart(11));
  });

  console.log('');
  console.log('BOTH CONDITIONS TOGETHER — outside the clusters AND carrying something');
  let any = false;
  NEW.forEach((sig, si) => {
    const maxes = EXISTING.map((_, ei) => mean(corrAcc[si][ei])).filter(x => x !== null).map(Math.abs);
    const maxRho = maxes.length ? Math.max(...maxes) : null;
    const ic = mean(icAcc[si]);
    if (maxRho !== null && maxRho < 0.5 && ic !== null && Math.abs(ic) >= 0.02) {
      any = true;
      console.log(`  ${sig.label.padEnd(42)} rho ${maxRho.toFixed(2)}  IC ${ic.toFixed(4)}`);
    }
  });
  if (!any) console.log('  NOTHING clears both. Either redundant, or independent and empty.');

  console.log('');
  console.log('NO VERDICT. One regime, no holdout, static broker classification.');
  await pool.end();
})().catch(env.fail);
