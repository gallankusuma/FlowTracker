'use strict';
/**
 * EXP-036b — a POST-HOC diagnostic on EXP-036. NOT a registered test.
 *
 * EXP-036 confirmed its rule with a mean +5.67pp and t = 8.53. That is a large
 * effect, and the size is the reason to look harder rather than to celebrate.
 *
 * ── THE CONFOUND THE REGISTERED CONTROL DOES NOT FULLY REMOVE ────────────────
 *
 * The registered control drew K buckets at random from the buckets price had
 * VISITED. That fixes the worst version of the problem -- a control scattered
 * across the whole range would sit far from the action -- but "visited" is a
 * weak match. A bucket visited for two days at the top of a spike counts as
 * visited and is nowhere near where price is now.
 *
 * Meanwhile the top volume shelves are, almost by construction, close to where
 * price has been sitting. And future pivots also cluster near where price is.
 *
 * So a large part of +5.67pp may be "these bands are near the current price",
 * which is true of any band near the current price and says nothing about
 * VOLUME. The registered test cannot separate the two.
 *
 * ── WHAT THIS DOES INSTEAD ───────────────────────────────────────────────────
 *
 * The control band is matched on DISTANCE FROM THE AS-OF PRICE. For each real
 * zone, a control is drawn from visited buckets whose log-distance from the last
 * close is within a tight tolerance of the real zone's. Same width, same
 * proximity, same visited region -- so the only remaining difference is whether
 * the bucket was chosen for its volume.
 *
 * If the effect survives this, volume is doing work. If it collapses, EXP-036
 * measured proximity and the honest reading of the zone table changes.
 *
 * THIS IS POST-HOC. It was not in the pre-registration, so it cannot change
 * EXP-036's verdict -- only what that verdict should be understood to mean.
 *
 * Usage: node scraper/research/exp036b_proximity_control.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const { pivots } = require('../deep_analysis');
const stats = require('../modules/statistics');

const PRIOR = 500, FORWARD = 60, STEP = 60;
const NBUCKETS = 60, TOPN = 8, MAX_WIDTH_PCT = 5;
const DRAWS = 50, TICKERS = 100, MIN_SESSIONS = 1000;
const SEED = 20260830;
const PROX_TOL = 0.25;   // control must sit within 25% of the real zone's log-distance

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
  return { vol, edge };
}

function bandsFrom(indices, edge) {
  const sorted = indices.slice().sort((a, b) => a - b);
  const out = [];
  for (const i of sorted) {
    const prev = out[out.length - 1];
    const wouldSpan = prev ? (edge(i + 1) / prev.lo - 1) * 100 : 0;
    if (prev && i === prev.iEnd + 1 && wouldSpan <= MAX_WIDTH_PCT) { prev.iEnd = i; prev.hi = edge(i + 1); }
    else out.push({ iStart: i, iEnd: i, lo: edge(i), hi: edge(i + 1) });
  }
  return out;
}
const hitRate = (piv, bands) =>
  piv.length ? piv.filter(p => bands.some(b => p.p >= b.lo && p.p <= b.hi)).length / piv.length : null;

(async () => {
  const pool = createPool();
  const rand = rng(SEED);

  console.log('EXP-036b — POST-HOC diagnostic, not a registered test');
  console.log('  Question: is EXP-036\'s +5.67pp about VOLUME, or about being near the price?');
  console.log(`  The control band is now matched on log-distance from the as-of close (+/-${PROX_TOL * 100}%),`);
  console.log('  so proximity is held constant and only "chosen for volume" differs.');
  console.log('');

  const [uni] = await pool.query(`
    SELECT stock_code, COUNT(*) n, SUM(close_price * volume) val
      FROM idx_stock_prices WHERE close_price > 0 AND volume > 0
     GROUP BY stock_code HAVING n >= ? ORDER BY val DESC LIMIT ?`, [MIN_SESSIONS, TICKERS]);

  const perTicker = [];
  let matchFailures = 0, matched = 0;
  const realDist = [], loosDist = [];

  for (const u of uni) {
    const [px] = await pool.query(
      `SELECT date, high_price h, low_price l, close_price c, volume v
         FROM idx_stock_prices WHERE stock_code = ? AND close_price > 0 AND volume > 0 ORDER BY date ASC`,
      [u.stock_code]);
    const bars = px.map(r => ({ h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
    if (bars.length < PRIOR + FORWARD + 10) continue;

    const diffs = [];
    for (let t = PRIOR; t + FORWARD < bars.length; t += STEP) {
      const prior = bars.slice(t - PRIOR, t), forward = bars.slice(t, t + FORWARD);
      const bv = bucketVolumes(prior);
      if (!bv) continue;
      const piv = pivots(forward, 3);
      if (!piv.length) continue;

      const asOf = prior[prior.length - 1].c;
      const ranked = bv.vol.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
      const visited = bv.vol.map((v, i) => ({ i, v })).filter(x => x.v > 0).map(x => x.i);
      const realBands = bandsFrom(ranked.slice(0, TOPN * 2).map(x => x.i), bv.edge).slice(0, TOPN);
      const real = hitRate(piv, realBands);
      if (real === null) continue;

      // How far each bucket sits from the as-of price, in log terms.
      const dist = i => Math.abs(Math.log((bv.edge(i) + bv.edge(i + 1)) / 2 / asOf));
      // Diagnostic: are the real zones in fact closer to price than a visited
      // bucket picked at random? This is the confound, measured directly.
      realDist.push(mean(realBands.map(b => dist(b.iStart))));
      loosDist.push(mean(visited.map(dist)));

      const ctrl = [];
      for (let d = 0; d < DRAWS; d++) {
        const pick = [];
        let failed = false;
        for (const rb of realBands) {
          const target = dist(rb.iStart);
          // Candidates at a comparable distance from price, excluding the real
          // buckets themselves so the control cannot simply reproduce them.
          const cand = visited.filter(i =>
            Math.abs(dist(i) - target) <= PROX_TOL * Math.max(target, 0.02) &&
            !realBands.some(b => i >= b.iStart && i <= b.iEnd));
          if (!cand.length) { failed = true; break; }
          const span = rb.iEnd - rb.iStart + 1;
          const start = cand[Math.floor(rand() * cand.length)];
          for (let k = 0; k < span; k++) pick.push(Math.min(NBUCKETS - 1, start + k));
        }
        if (failed) continue;
        ctrl.push(hitRate(piv, bandsFrom([...new Set(pick)], bv.edge)));
      }
      // A window where no proximity-matched control could be built is DROPPED,
      // not silently replaced by a looser one -- swapping in an easier control
      // when the strict one fails is how a diagnostic becomes a rubber stamp.
      if (ctrl.length < DRAWS / 2) { matchFailures++; continue; }
      matched++;
      diffs.push(real - mean(ctrl));
    }
    if (diffs.length) perTicker.push({ code: u.stock_code, diff: mean(diffs), n: diffs.length });
  }

  const d = perTicker.map(x => x.diff);
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  const tStat = m / (sd / Math.sqrt(d.length));
  const p = 1 - stats.normalCDF(tStat);

  console.log('THE CONFOUND, MEASURED');
  console.log(`  mean log-distance from price, REAL zones      : ${mean(realDist).toFixed(4)}`);
  console.log(`  mean log-distance from price, ANY visited bucket: ${mean(loosDist).toFixed(4)}`);
  console.log(`  -> the top shelves sit ${((1 - mean(realDist) / mean(loosDist)) * 100).toFixed(0)}% closer to the as-of price`);
  console.log('     than the registered control did. That difference alone buys hits.');
  console.log('');
  console.log('WITH PROXIMITY HELD CONSTANT');
  console.log(`  windows matched  : ${matched}  (${matchFailures} dropped, no comparable control existed)`);
  console.log(`  tickers          : ${d.length}`);
  console.log(`  mean difference  : ${(m * 100).toFixed(3)} pp     (EXP-036 registered: +5.668 pp)`);
  console.log(`  median           : ${(median(d) * 100).toFixed(3)} pp`);
  console.log(`  t                : ${tStat.toFixed(3)}          (EXP-036: 8.530)`);
  console.log(`  one-sided p      : ${p.toFixed(6)}`);
  const positive = d.filter(x => x > 0).length;
  console.log(`  tickers positive : ${positive} of ${d.length}`);
  console.log('');
  const share = m / 0.05668;
  console.log(`  Volume survives ${(share * 100).toFixed(0)}% of the registered effect once proximity is held constant.`);
  console.log('  POST-HOC: this cannot change EXP-036\'s verdict, only what it means.');

  await pool.end();
})().catch(env.fail);
