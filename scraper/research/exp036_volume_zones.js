'use strict';
/**
 * EXP-036 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-30_volume_zones.md.
 *
 * H1: swing pivots in the next 60 sessions land inside the top volume shelves of
 *     the prior 500 sessions MORE OFTEN than inside an equal number of equally
 *     wide bands drawn from the same visited price range.
 *     One-sided; direction fixed in advance.
 *
 * ── THE TRAP THIS EXISTS TO AVOID ────────────────────────────────────────────
 *
 * A volume shelf is high-volume BECAUSE price spent time there, and price spent
 * time there BECAUSE it kept turning there. Counting the turns that CREATED the
 * shelf as evidence the shelf works is circular, and it would produce a large,
 * clean, entirely fake result.
 *
 * So zones come from the 500 sessions ending at t, and pivots are counted in
 * (t, t+60]. No bar contributes to both sides. This is the whole design.
 *
 * ── AND THE CONTROL IS NOT "RANDOM LEVELS ANYWHERE" ──────────────────────────
 *
 * Real zones sit near where price has been; future pivots also sit near where
 * price has been. A control placed anywhere in the range would be far from the
 * action and would bias toward confirming. So the control draws K buckets from
 * the buckets price ACTUALLY VISITED -- same count, same widths, same region.
 * The only difference is whether the bucket was picked for its volume.
 *
 * Usage: node scraper/research/exp036_volume_zones.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { pivots } = require('../deep_analysis');
const stats = require('../modules/statistics');

const PRIOR = 500;        // sessions used to build zones
const FORWARD = 60;       // sessions the zones are judged on
const STEP = 60;          // as-of dates this far apart
const NBUCKETS = 60;      // as deployed
const TOPN = 8;           // as deployed
const MAX_WIDTH_PCT = 5;  // as deployed
const DRAWS = 50;         // control draws per as-of date
const TICKERS = 100;
const MIN_SESSIONS = 1000;
const SEED = 20260830;    // fixed before the run; the result must be reproducible

/** Mulberry32 — small, seeded, and deterministic. Math.random would make this unrepeatable. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

/** Log-spaced bucket volumes over a window — the shared substrate for zones and controls. */
function bucketVolumes(bars) {
  const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return null;
  const lnLo = Math.log(lo), w = (Math.log(hi) - lnLo) / NBUCKETS;
  const edge = i => Math.exp(lnLo + i * w);
  const at = p => Math.max(0, Math.min(NBUCKETS - 1, Math.floor((Math.log(p) - lnLo) / w)));
  const vol = new Array(NBUCKETS).fill(0);
  for (const b of bars) {
    const a = at(b.l), z = at(b.h);
    const share = b.v / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i] += share;
  }
  return { vol, edge, lo, hi };
}

/**
 * Merge a set of bucket indices into bands, capped at the same 5% the deployed
 * report uses. Applied identically to the real zones and to the control, so the
 * comparison is not decided by the merge.
 */
function bandsFrom(indices, edge) {
  const sorted = indices.slice().sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    const prev = out[out.length - 1];
    const wouldSpan = prev ? (edge(i + 1) / prev.lo - 1) * 100 : 0;
    if (prev && i === prev.iEnd + 1 && wouldSpan <= MAX_WIDTH_PCT) {
      prev.iEnd = i; prev.hi = edge(i + 1);
    } else {
      out.push({ iStart: i, iEnd: i, lo: edge(i), hi: edge(i + 1) });
    }
  }
  return out;
}

const hitRate = (piv, bands) =>
  piv.length ? piv.filter(p => bands.some(b => p.p >= b.lo && p.p <= b.hi)).length / piv.length : null;

(async () => {
  const pool = createPool();
  const rand = rng(SEED);

  console.log('EXP-036 — pre-registered: do pivots land in volume shelves more than in arbitrary bands?');
  console.log('  one-sided, direction fixed in PREREGISTRATION_2026-08-30_volume_zones.md');
  console.log(`  zones from the prior ${PRIOR} sessions, pivots counted in the NEXT ${FORWARD} — no bar on both sides`);
  console.log(`  control: ${DRAWS} draws of K buckets from those price actually VISITED, same widths`);
  console.log('  unit of observation: the TICKER, because as-of windows overlap heavily');
  console.log('');

  const [uni] = await pool.query(`
    SELECT stock_code, COUNT(*) n, SUM(close_price * volume) val
      FROM idx_stock_prices WHERE close_price > 0 AND volume > 0
     GROUP BY stock_code HAVING n >= ? ORDER BY val DESC LIMIT ?`, [MIN_SESSIONS, TICKERS]);
  console.log(`universe: ${uni.length} tickers with >= ${MIN_SESSIONS} sessions, by total traded value`);

  const perTicker = [];
  let asOfTotal = 0, droppedNoPivots = 0;
  const rankHits = new Array(TOPN).fill(0), rankOpps = new Array(TOPN).fill(0);
  const turnsDiffs = [];

  for (const u of uni) {
    const [px] = await pool.query(
      `SELECT date, high_price h, low_price l, close_price c, volume v
         FROM idx_stock_prices WHERE stock_code = ? AND close_price > 0 AND volume > 0 ORDER BY date ASC`,
      [u.stock_code]);
    const bars = px.map(r => ({ d: r.date.toISOString().slice(0, 10), h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
    if (bars.length < PRIOR + FORWARD + 10) continue;

    const diffs = [], turnDiffs = [];
    for (let t = PRIOR; t + FORWARD < bars.length; t += STEP) {
      const prior = bars.slice(t - PRIOR, t);
      const forward = bars.slice(t, t + FORWARD);
      const bv = bucketVolumes(prior);
      if (!bv) continue;

      const piv = pivots(forward, 3);
      if (!piv.length) { droppedNoPivots++; continue; }
      asOfTotal++;

      // REAL: the top buckets by volume, merged as the report merges them.
      const ranked = bv.vol.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
      const visited = bv.vol.map((v, i) => ({ i, v })).filter(x => x.v > 0).map(x => x.i);
      const topIdx = ranked.slice(0, TOPN * 2).map(x => x.i);
      const realBands = bandsFrom(topIdx, bv.edge).slice(0, TOPN);
      const K = realBands.reduce((a, b) => a + (b.iEnd - b.iStart + 1), 0);
      const real = hitRate(piv, realBands);
      if (real === null) continue;

      // CONTROL: K buckets drawn from those price actually visited.
      const ctrl = [];
      for (let d = 0; d < DRAWS; d++) {
        const pick = new Set();
        const pool_ = visited.slice();
        while (pick.size < Math.min(K, pool_.length)) {
          pick.add(pool_[Math.floor(rand() * pool_.length)]);
        }
        ctrl.push(hitRate(piv, bandsFrom([...pick], bv.edge)));
      }
      diffs.push(real - mean(ctrl));

      // SECONDARY 1: zones that had turns in the PRIOR window (the report's claim
      // about that column). Still measured out of sample.
      const priorPiv = pivots(prior, 3);
      const withTurns = realBands.filter(b => priorPiv.some(p => p.p >= b.lo && p.p <= b.hi));
      if (withTurns.length) {
        const rt = hitRate(piv, withTurns);
        const kT = withTurns.reduce((a, b) => a + (b.iEnd - b.iStart + 1), 0);
        const ct = [];
        for (let d = 0; d < DRAWS; d++) {
          const pick = new Set();
          while (pick.size < Math.min(kT, visited.length)) pick.add(visited[Math.floor(rand() * visited.length)]);
          ct.push(hitRate(piv, bandsFrom([...pick], bv.edge)));
        }
        if (rt !== null) turnDiffs.push(rt - mean(ct));
      }

      // SECONDARY 2: does rank matter? Each band judged on its own.
      realBands.forEach((b, k) => {
        if (k >= TOPN) return;
        rankOpps[k] += piv.length;
        rankHits[k] += piv.filter(p => p.p >= b.lo && p.p <= b.hi).length;
      });
    }

    if (diffs.length) perTicker.push({ code: u.stock_code, diff: mean(diffs), n: diffs.length });
    if (turnDiffs.length) turnsDiffs.push(mean(turnDiffs));
  }

  // ── the one test ──────────────────────────────────────────────────────────
  const d = perTicker.map(x => x.diff);
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  const tStat = m / (sd / Math.sqrt(d.length));
  // Normal approximation to the one-sided t p-value. At n=100 the difference
  // from the exact t is in the fourth decimal; stated rather than hidden.
  const p = 1 - stats.normalCDF(tStat);

  console.log(`as-of windows used : ${asOfTotal}  (${droppedNoPivots} dropped for having no forward pivots)`);
  console.log(`tickers with a result: ${perTicker.length}`);
  console.log('');
  console.log('PRIMARY TEST — mean paired difference in hit rate, across tickers');
  console.log(`  mean difference  : ${(m * 100).toFixed(3)} percentage points`);
  console.log(`  median           : ${(median(d) * 100).toFixed(3)} pp`);
  console.log(`  sd across tickers: ${(sd * 100).toFixed(3)} pp`);
  console.log(`  t                : ${tStat.toFixed(3)}`);
  console.log(`  one-sided p      : ${p.toFixed(6)}`);
  const confirmed = p < 0.05 && m > 0;
  console.log(`  VERDICT          : ${confirmed ? 'CONFIRMED' : 'NOT CONFIRMED'} against the pre-registered rule`);

  const better = d.filter(x => x > 0).length;
  console.log('');
  console.log('SECONDARY (descriptive, NOT decisive)');
  console.log(`  sign test        : ${better} of ${d.length} tickers positive` +
    ` (${(better / d.length * 100).toFixed(0)}%)`);
  if (turnsDiffs.length) {
    const mt = mean(turnsDiffs);
    console.log(`  zones WITH prior turns: mean difference ${(mt * 100).toFixed(3)} pp over ${turnsDiffs.length} tickers` +
      `  (all zones: ${(m * 100).toFixed(3)} pp)`);
  }
  console.log('  hit rate by zone rank (rank 1 = most volume):');
  for (let k = 0; k < TOPN; k++) {
    if (!rankOpps[k]) continue;
    console.log(`    rank ${k + 1}: ${(rankHits[k] / rankOpps[k] * 100).toFixed(2)}% of forward pivots`);
  }

  const sorted = perTicker.slice().sort((a, b) => b.diff - a.diff);
  console.log('');
  console.log('  best 5 : ' + sorted.slice(0, 5).map(x => `${x.code} ${(x.diff * 100).toFixed(1)}pp`).join(', '));
  console.log('  worst 5: ' + sorted.slice(-5).map(x => `${x.code} ${(x.diff * 100).toFixed(1)}pp`).join(', '));

  console.log('');
  console.log(`POWER, as registered: n=${d.length} detects about d=0.25 at 80%.`);
  console.log('  A null means "not detectable at this size", not "absent".');
  console.log('');
  console.log('This sample is now spent.');
  await pool.end();
})().catch(env.fail);
