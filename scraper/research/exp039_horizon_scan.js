'use strict';
/**
 * EXP-039 — a HORIZON SCAN. Explicitly a diagnostic, explicitly NOT a test.
 *
 * ── WHY A SCAN AND NOT A HYPOTHESIS ──────────────────────────────────────────
 *
 * The idea being followed is the Simons cost lesson, inverted. Medallion's edge
 * per trade is SMALLER than our 0.6% round trip, and it works only because their
 * costs are basis points. Ours are fixed, so the only lever we control is TIME:
 * the same 0.6% spread over 120 sessions instead of 20 is the same rupiah
 * against a return distribution roughly sqrt(6) times wider.
 *
 * The obvious move -- re-run EXP-037 at several horizons and keep the one that
 * clears -- is specification search, and it is exactly what this project's
 * apparatus exists to prevent. Worse, it would be pointless here: EXP-037's
 * GROSS excess was -1.043%, already negative before a rupiah of cost. A longer
 * hold does not rescue a negative gross edge; it gives it more time to be
 * negative.
 *
 * So this asks the question that must come first, and answers nothing:
 *
 *     which signals, if any, have a POSITIVE gross excess that is merely
 *     smaller than the cost hurdle -- and at what horizon?
 *
 * Only those can be rescued by holding longer. Everything else is dead at every
 * horizon and should be dropped rather than re-tested.
 *
 * ── THE SPLIT THAT KEEPS THIS HONEST ─────────────────────────────────────────
 *
 * Scanning and then registering at the best cell is still selection. So the
 * universe is split by rank parity: ODD-ranked tickers are scanned here, EVEN-
 * ranked ones are RESERVED and not touched. Whatever this points at gets
 * pre-registered and tested on the reserved half, where the selection has not
 * been made.
 *
 * The reserved half is spent once. This file must never be pointed at it.
 *
 * *** SURVIVORSHIP-BIASED — delisted names were never fetched. Biased UP. ***
 *
 * Usage: node scraper/research/exp039_horizon_scan.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');

const PRIOR = 500, REFRESH = 20, LOOKBACK = 20;
const HORIZONS = [5, 10, 20, 40, 60, 120];
const COST = 0.006;
const NBUCKETS = 60, TOPN = 8, MAX_WIDTH_PCT = 5;
const TICKERS = 200, MIN_SESSIONS = 1000, MIN_TRADES = 30;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = a => { const m = mean(a); return m === null || a.length < 2 ? null
  : Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function bucketVolumes(bars) {
  const lows = bars.map(b => b.l).filter(v => v > 0);
  if (!lows.length) return null;
  const lo = Math.min(...lows), hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo) || !isFinite(lo)) return null;
  const lnLo = Math.log(lo), w = (Math.log(hi) - lnLo) / NBUCKETS;
  const edge = i => Math.exp(lnLo + i * w);
  const at = p => Math.max(0, Math.min(NBUCKETS - 1, Math.floor((Math.log(p) - lnLo) / w)));
  const vol = new Array(NBUCKETS).fill(0);
  for (const b of bars) { if (!(b.l > 0)) continue;
    const a = at(b.l), z = at(b.h), sh = b.v / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i] += sh; }
  return { vol, edge };
}
function bandsFrom(idx, edge) {
  const out = [];
  for (const i of idx.slice().sort((a, b) => a - b)) {
    const prev = out[out.length - 1];
    const span = prev ? (edge(i + 1) / prev.lo - 1) * 100 : 0;
    if (prev && i === prev.iEnd + 1 && span <= MAX_WIDTH_PCT) { prev.iEnd = i; prev.hi = edge(i + 1); }
    else out.push({ iStart: i, iEnd: i, lo: edge(i), hi: edge(i + 1) });
  }
  return out;
}

/**
 * The signals to scan. Each returns true on the bar that triggers it.
 *
 * Every one is computable from data strictly prior to the bar, and each is
 * something this project already builds or already tested -- nothing is invented
 * here to give the scan a better chance.
 */
const SIGNALS = [
  { name: 'zone support touch',
    why: 'EXP-037 rule, kept as a control: it should stay negative at every horizon',
    fire: c => c.zones.some(z => z.hi < c.refClose && c.close >= z.lo && c.close <= z.hi && c.prevClose > z.hi) },
  { name: 'zone resistance touch',
    why: 'EXP-038 rule, same role',
    fire: c => c.zones.some(z => z.lo > c.refClose && c.close >= z.lo && c.close <= z.hi && c.prevClose < z.lo) },
  { name: 'above all volume zones',
    why: 'price in thin air above every shelf — no overhead supply, untested',
    fire: c => c.zones.length > 0 && c.zones.every(z => c.close > z.hi) },
  { name: 'below all volume zones',
    why: 'the mirror, untested',
    fire: c => c.zones.length > 0 && c.zones.every(z => c.close < z.lo) },
  { name: 'near 52w high (<3%)',
    why: 'the flagship strategy already leans on HI52W; here for calibration',
    fire: c => c.hi52 > 0 && c.close >= c.hi52 * 0.97 },
  { name: 'drawdown >20% from 52w high',
    why: 'the opposite end of the same axis',
    fire: c => c.hi52 > 0 && c.close <= c.hi52 * 0.8 },
];

(async () => {
  const pool = createPool();

  console.log('EXP-039 — HORIZON SCAN. A DIAGNOSTIC, NOT A TEST. No verdict is issued.');
  console.log('  Question: which signals have a POSITIVE gross excess merely smaller than');
  console.log('  the cost hurdle, and at what horizon? Only those can be rescued by time.');
  console.log(`  Cost ${(COST * 100).toFixed(1)}% round trip. Benchmark: each ticker's own`);
  console.log('  unconditional return AT THE SAME HORIZON, not zero.');
  console.log('');
  console.log('  SPLIT: odd-ranked tickers are scanned. EVEN-ranked are RESERVED and');
  console.log('  untouched, so whatever this points at can be tested where the selection');
  console.log('  was not made.');
  console.log('');
  console.log('  *** SURVIVORSHIP-BIASED — biased UP ***');
  console.log('');

  const [uni] = await pool.query(`
    SELECT stock_code, COUNT(*) n, SUM(close_price*volume) val FROM idx_stock_prices
     WHERE close_price>0 AND volume>0 GROUP BY stock_code HAVING n>=? ORDER BY val DESC LIMIT ?`,
    [MIN_SESSIONS, TICKERS]);
  const scanHalf = uni.filter((_, i) => i % 2 === 0);
  console.log(`universe ${uni.length}; scanning ${scanHalf.length} odd-ranked, reserving ${uni.length - scanHalf.length}`);

  // acc[signal][horizon] = { ex: [per-trade excess], n }
  const acc = SIGNALS.map(() => HORIZONS.map(() => []));
  // The hurdle-to-noise ratio needs no signal at all: it is a property of the
  // market and the cost, and it is the whole argument for holding longer.
  const noise = HORIZONS.map(() => []);

  for (const u of scanHalf) {
    const [px] = await pool.query(
      `SELECT open_price o, high_price h, low_price l, close_price c, volume v
         FROM idx_stock_prices WHERE stock_code=? AND close_price>0 AND volume>0 ORDER BY date ASC`,
      [u.stock_code]);
    const bars = px.map(r => ({ o: r.o === null ? null : +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
    const maxH = Math.max(...HORIZONS);
    if (bars.length < PRIOR + maxH + 60) continue;

    // Benchmark and noise per horizon, over exactly the span the signals can fire in.
    const bench = HORIZONS.map(H => {
      const r = [];
      for (let i = PRIOR; i + H < bars.length; i++) r.push(bars[i + H].c / bars[i].c - 1);
      return { mean: mean(r), sd: sd(r) };
    });
    HORIZONS.forEach((H, hi) => { if (bench[hi].sd) noise[hi].push(bench[hi].sd); });

    let zones = null, zoneAt = -1;
    const openUntil = SIGNALS.map(() => HORIZONS.map(() => -1));

    for (let t = PRIOR; t + maxH + 1 < bars.length; t++) {
      if (zoneAt < 0 || t - zoneAt >= REFRESH) {
        const bv = bucketVolumes(bars.slice(t - PRIOR, t));
        zones = bv ? bandsFrom(bv.vol.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v)
          .slice(0, TOPN * 2).map(x => x.i), bv.edge).slice(0, TOPN) : [];
        zoneAt = t;
      }
      const win = bars.slice(Math.max(0, t - 250), t + 1);
      const ctx = {
        zones: zones || [], close: bars[t].c, prevClose: bars[t - 1].c,
        refClose: bars[t - LOOKBACK].c, hi52: Math.max(...win.map(b => b.h)),
      };
      const entry = bars[t + 1];
      if (!(entry && entry.o > 0)) continue;

      SIGNALS.forEach((sig, si) => {
        let fired;
        try { fired = sig.fire(ctx); } catch { fired = false; }
        if (!fired) return;
        HORIZONS.forEach((H, hi) => {
          if (t <= openUntil[si][hi]) return;           // no overlapping trades
          const exit = bars[t + 1 + H];
          if (!exit || bench[hi].mean === null) return;
          acc[si][hi].push((exit.c / entry.o - 1) - bench[hi].mean);
          openUntil[si][hi] = t + H;
        });
      });
    }
  }

  console.log('THE ARITHMETIC THAT MOTIVATES THIS, before any signal');
  console.log('  horizon   median return sd   cost as % of that sd');
  HORIZONS.forEach((H, hi) => {
    const s = noise[hi].slice().sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    console.log(`  ${String(H).padStart(5)}    ${(med * 100).toFixed(1).padStart(13)}%   ${(COST / med * 100).toFixed(1).padStart(18)}%`);
  });
  console.log('  A fixed cost shrinks against a widening return distribution. That is the');
  console.log('  entire case for holding longer, and it is arithmetic, not a result.');

  console.log('');
  console.log('GROSS EXCESS BY SIGNAL AND HORIZON (%), before costs');
  console.log('  signal                        ' + HORIZONS.map(h => String(h).padStart(8)).join(''));
  const survivors = [];
  SIGNALS.forEach((sig, si) => {
    const row = HORIZONS.map((H, hi) => {
      const a = acc[si][hi];
      return a.length >= MIN_TRADES ? mean(a) : null;
    });
    console.log('  ' + sig.name.padEnd(30) +
      row.map(v => (v === null ? '     n/a' : (v * 100).toFixed(2).padStart(8))).join(''));
    row.forEach((v, hi) => {
      if (v !== null && v > 0) survivors.push({ sig: sig.name, H: HORIZONS[hi], gross: v, n: acc[si][hi].length });
    });
  });

  console.log('');
  console.log('  trade counts ' + HORIZONS.map(h => String(h).padStart(8)).join(''));
  SIGNALS.forEach((sig, si) => console.log('  ' + sig.name.padEnd(30) +
    HORIZONS.map((H, hi) => String(acc[si][hi].length).padStart(8)).join('')));

  console.log('');
  console.log(`NET EXCESS, after the ${(COST * 100).toFixed(1)}% hurdle (%)`);
  console.log('  signal                        ' + HORIZONS.map(h => String(h).padStart(8)).join(''));
  SIGNALS.forEach((sig, si) => {
    console.log('  ' + sig.name.padEnd(30) + HORIZONS.map((H, hi) => {
      const a = acc[si][hi];
      return a.length >= MIN_TRADES ? ((mean(a) - COST) * 100).toFixed(2).padStart(8) : '     n/a';
    }).join(''));
  });

  console.log('');
  console.log('WHAT COULD BE RESCUED BY TIME — positive gross, sorted');
  if (!survivors.length) {
    console.log('  NOTHING. Every signal is negative gross at every horizon, which means no');
    console.log('  holding period saves any of them and none is worth a registered test.');
  } else {
    survivors.sort((a, b) => b.gross - a.gross).slice(0, 10).forEach(s =>
      console.log(`  ${s.sig.padEnd(30)} H=${String(s.H).padStart(3)}  gross ${(s.gross * 100).toFixed(2)}%` +
        `  net ${((s.gross - COST) * 100).toFixed(2)}%  n=${s.n}`));
  }

  console.log('');
  console.log('NO VERDICT. This is a scan on half the universe; the numbers above are');
  console.log('selected by inspection and cannot be quoted as findings. The other half is');
  console.log('untouched and is where any of this gets tested.');
  await pool.end();
})().catch(env.fail);
