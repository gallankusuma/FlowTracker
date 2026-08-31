'use strict';
/**
 * EXP-038 — the single pre-registered hypothesis from
 * PREREGISTRATION_2026-08-30_resistance_zones.md.
 *
 * H1: buying when the close rises INTO a RESISTANCE zone and holding 20 sessions
 *     returns something DIFFERENT, net of costs, from what the same stock
 *     returned unconditionally. TWO-SIDED.
 *
 * ── WHY TWO-SIDED, WHICH IS THE POINT OF THIS FILE ───────────────────────────
 *
 * EXP-037 found buying into SUPPORT underperformed holding by 1.6%. The natural
 * reading is momentum -- price falling into a level kept falling -- and if that
 * is right, the mirror should hold too: price rising into resistance keeps
 * rising, and buying there should OUTperform.
 *
 * The textbook says the opposite: resistance rejects, so this should be the
 * worst entry available.
 *
 * I have a real prior pointing one way and the convention pointing the other.
 * Claiming a direction would be either posturing or fitting the hypothesis to a
 * result already seen, so the test is two-sided and the power cost is accepted.
 *
 * ── IDENTICAL TO EXP-037 EXCEPT ONE PREDICATE ────────────────────────────────
 *
 * Same zones, same refresh, same next-open fill, same 20-session hold, same 0.6%
 * cost, same per-ticker benchmark, same unit of observation. Only the zone
 * selection and the direction of approach are mirrored. Retuning anything else
 * would make the two incomparable, and comparing them is half the point.
 *
 * *** SURVIVORSHIP-BIASED RESEARCH RESULT — biased UPWARD ***
 *
 * Usage: node scraper/research/exp038_resistance_zones.js
 */
const env = require('./env');
env.loadEnv();

const { createPool } = require('../modules/db_config');
const stats = require('../modules/statistics');

const PRIOR = 500;          // sessions used to build zones
const REFRESH = 20;         // zones recomputed this often, and held between
const HOLD = 20;            // sessions held
const LOOKBACK_ABOVE = 20;  // the zone must sit below the close this far back
const COST = 0.006;         // 0.6% round trip, fixed before the run
const NBUCKETS = 60, TOPN = 8, MAX_WIDTH_PCT = 5;
const TICKERS = 100, MIN_SESSIONS = 1000, MIN_TRADES = 3;

const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const median = a => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

function bucketVolumes(bars) {
  const lows = bars.map(b => b.l).filter(v => v > 0);
  const lo = Math.min(...lows), hi = Math.max(...bars.map(b => b.h));
  // A zero or NULL low makes Math.log(lo) -Infinity and every edge NaN. 930 such
  // rows exist (0.09%); EXP-036 tolerated them because the damage was symmetric,
  // but here a NaN zone would silently produce zero trades for that ticker, so
  // the bad lows are excluded from the grid rather than left to poison it.
  if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return null;
  const lnLo = Math.log(lo), w = (Math.log(hi) - lnLo) / NBUCKETS;
  const edge = i => Math.exp(lnLo + i * w);
  const at = p => Math.max(0, Math.min(NBUCKETS - 1, Math.floor((Math.log(p) - lnLo) / w)));
  const vol = new Array(NBUCKETS).fill(0);
  for (const b of bars) {
    if (!(b.l > 0)) continue;
    const a = at(b.l), z = at(b.h);
    const share = b.v / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i] += share;
  }
  return { vol, edge };
}

function bandsFrom(indices, edge) {
  const out = [];
  for (const i of indices.slice().sort((a, b) => a - b)) {
    const prev = out[out.length - 1];
    const wouldSpan = prev ? (edge(i + 1) / prev.lo - 1) * 100 : 0;
    if (prev && i === prev.iEnd + 1 && wouldSpan <= MAX_WIDTH_PCT) { prev.iEnd = i; prev.hi = edge(i + 1); }
    else out.push({ iStart: i, iEnd: i, lo: edge(i), hi: edge(i + 1), rank: out.length });
  }
  return out;
}

(async () => {
  const pool = createPool();

  console.log('EXP-038 — pre-registered: what happens when you buy INTO a resistance zone?');
  console.log('  TWO-SIDED — I hold a prior from EXP-037 and the textbook says the opposite;');
  console.log('  claiming a direction would be posturing.');
  console.log('  Registered in PREREGISTRATION_2026-08-30_resistance_zones.md');
  console.log(`  entry at the NEXT OPEN after the close rises INTO a resistance zone; hold ${HOLD} sessions`);
  console.log(`  cost ${(COST * 100).toFixed(1)}% round trip, fixed before the run`);
  console.log("  benchmark: the ticker's OWN unconditional 20-session mean, not zero");
  console.log('  unit of observation: the TICKER. m = 1.');
  console.log('');
  console.log('  *** SURVIVORSHIP-BIASED: delisted names were never fetched. Biased UP. ***');
  console.log('');

  const [uni] = await pool.query(`
    SELECT stock_code, COUNT(*) n, SUM(close_price * volume) val
      FROM idx_stock_prices WHERE close_price > 0 AND volume > 0
     GROUP BY stock_code HAVING n >= ? ORDER BY val DESC LIMIT ?`, [MIN_SESSIONS, TICKERS]);

  const perTicker = [];
  let tradesTotal = 0, droppedThin = 0, noOpen = 0;
  const rankNet = new Array(TOPN).fill(0).map(() => []);
  const allNet = [], allGross = [];

  for (const u of uni) {
    const [px] = await pool.query(
      `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
         FROM idx_stock_prices WHERE stock_code = ? AND close_price > 0 AND volume > 0 ORDER BY date ASC`,
      [u.stock_code]);
    const bars = px.map(r => ({
      d: r.date.toISOString().slice(0, 10),
      o: r.o === null ? null : +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v,
    }));
    if (bars.length < PRIOR + HOLD + 40) continue;

    // The benchmark: this ticker's own unconditional HOLD-session return, over
    // exactly the span the rule could have traded in.
    const bench = [];
    for (let i = PRIOR; i + HOLD < bars.length; i++) bench.push(bars[i + HOLD].c / bars[i].c - 1);
    const benchMean = mean(bench);
    if (benchMean === null) continue;

    let zoneSet = null, zoneAt = -1, openUntil = -1;
    const netTrades = [], grossTrades = [];

    for (let t = PRIOR; t + HOLD + 1 < bars.length; t++) {
      // Zones are refreshed on a schedule and held between, which is both cheaper
      // and closer to how a person uses them than redrawing every session.
      if (zoneAt < 0 || t - zoneAt >= REFRESH) {
        const bv = bucketVolumes(bars.slice(t - PRIOR, t));
        if (bv) {
          const ranked = bv.vol.map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
          zoneSet = bandsFrom(ranked.slice(0, TOPN * 2).map(x => x.i), bv.edge).slice(0, TOPN);
        } else zoneSet = null;
        zoneAt = t;
      }
      if (!zoneSet || t <= openUntil) continue;

      const close = bars[t].c, prevClose = bars[t - 1].c;
      const refClose = bars[t - LOOKBACK_ABOVE].c;

      // A RESISTANCE zone: one price was BELOW LOOKBACK_ABOVE sessions ago, that
      // the close has just risen into having been under it the session before.
      // The exact mirror of EXP-037's predicate -- nothing else differs.
      const hit = zoneSet.find(z =>
        z.lo > refClose && close >= z.lo && close <= z.hi && prevClose < z.lo);
      if (!hit) continue;

      const entryBar = bars[t + 1];
      if (!(entryBar.o > 0)) { noOpen++; continue; }   // never fill at a price we do not have
      const exit = bars[t + 1 + HOLD];
      if (!exit) continue;

      const gross = exit.c / entryBar.o - 1;
      const net = gross - COST;
      grossTrades.push(gross); netTrades.push(net);
      allNet.push(net); allGross.push(gross);
      if (hit.rank < TOPN) rankNet[hit.rank].push(net - benchMean);
      openUntil = t + HOLD;                            // no overlapping trades
      tradesTotal++;
    }

    if (netTrades.length < MIN_TRADES) { droppedThin++; continue; }
    perTicker.push({
      code: u.stock_code,
      trades: netTrades.length,
      excessNet: mean(netTrades) - benchMean,
      excessGross: mean(grossTrades) - benchMean,
      meanNet: mean(netTrades),
      bench: benchMean,
      winRate: netTrades.filter(x => x > 0).length / netTrades.length,
    });
  }

  const d = perTicker.map(x => x.excessNet);
  const m = mean(d);
  const sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (d.length - 1));
  const tStat = m / (sd / Math.sqrt(d.length));
  // TWO-SIDED, as registered. A one-sided p here would be choosing the
  // direction after seeing it.
  const p = 2 * (1 - stats.normalCDF(Math.abs(tStat)));

  console.log(`tickers with >= ${MIN_TRADES} trades : ${perTicker.length}  (${droppedThin} dropped as too thin)`);
  console.log(`trades total                  : ${tradesTotal}` + (noOpen ? `  (${noOpen} skipped: no open price to fill at)` : ''));
  console.log('');
  console.log('PRIMARY TEST — mean per-ticker excess over the ticker\'s own 20-session return, NET of costs');
  console.log(`  mean excess NET  : ${(m * 100).toFixed(3)}%`);
  console.log(`  median           : ${(median(d) * 100).toFixed(3)}%`);
  console.log(`  sd across tickers: ${(sd * 100).toFixed(3)}%`);
  console.log(`  t                : ${tStat.toFixed(3)}`);
  console.log(`  two-sided p      : ${p.toFixed(5)}`);
  const different = p < 0.05;
  console.log(`  VERDICT          : ${different ? 'DIFFERENT' : 'NO DIFFERENCE'} against the pre-registered rule`);
  if (different) {
    console.log(`  direction        : buying into resistance ${m > 0 ? 'OUTPERFORMED' : 'UNDERPERFORMED'} holding` +
      ` by ${Math.abs(m * 100).toFixed(3)}%`);
    console.log(`                     ${m > 0 ? 'momentum reading — the EXP-037 mirror holds'
      : 'the textbook reading — resistance rejects'}`);
  } else {
    console.log('  NO directional claim is made: a two-sided test that does not clear');
    console.log('  licenses no statement about the sign, however suggestive it looks.');
  }
  console.log(`  (EXP-037, buying SUPPORT: -1.643%, t -3.567)`);

  const g = perTicker.map(x => x.excessGross);
  const mg = mean(g);
  console.log('');
  console.log('SECONDARY (descriptive, NOT decisive)');
  console.log(`  mean excess GROSS (before the ${(COST * 100).toFixed(1)}% cost): ${(mg * 100).toFixed(3)}%`);
  console.log(`  -> the cost hurdle is ${(COST * 100).toFixed(1)}%; the gross edge is ${(mg * 100).toFixed(3)}%` +
    `, so costs ${mg > COST ? 'do NOT' : 'DO'} eat it`);
  console.log(`  mean raw trade return NET : ${(mean(perTicker.map(x => x.meanNet)) * 100).toFixed(3)}%`);
  console.log(`  mean benchmark (same span): ${(mean(perTicker.map(x => x.bench)) * 100).toFixed(3)}%`);
  console.log(`  win rate                  : ${(mean(perTicker.map(x => x.winRate)) * 100).toFixed(1)}%`);
  console.log(`  tickers with positive net excess: ${d.filter(x => x > 0).length} of ${d.length}`);
  console.log('  excess by zone rank (rank 1 = most volume):');
  for (let k = 0; k < TOPN; k++) {
    if (rankNet[k].length < 20) continue;
    console.log(`    rank ${k + 1}: ${(mean(rankNet[k]) * 100).toFixed(3)}%  over ${rankNet[k].length} trades`);
  }

  const sorted = perTicker.slice().sort((a, b) => b.excessNet - a.excessNet);
  console.log('');
  console.log('  best 5 : ' + sorted.slice(0, 5).map(x => `${x.code} ${(x.excessNet * 100).toFixed(1)}%`).join(', '));
  console.log('  worst 5: ' + sorted.slice(-5).map(x => `${x.code} ${(x.excessNet * 100).toFixed(1)}%`).join(', '));

  console.log('');
  console.log(`POWER, as registered: two-sided at n=${d.length} detects about d=0.28 at 80%.`);
  console.log('  *** SURVIVORSHIP-BIASED RESEARCH RESULT — biased UPWARD ***');
  console.log('This sample is now spent.');
  await pool.end();
})().catch(env.fail);
