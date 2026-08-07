/**
 * Float Cost Basis Map — estimated, and it says so everywhere.
 *
 * WHAT THIS IS. Given free float and a price/volume history, it estimates where
 * the tradable shares were acquired: each session some fraction of the float
 * changes hands, the old distribution is decayed proportionally, and the shares
 * that moved are re-assigned across that day's traded range.
 *
 * WHAT THIS IS NOT. It is not a register of holders. Nobody outside KSEI knows
 * who owns what at what price, and this never claims to. The one modelling
 * assumption doing all the work is that traded volume replaces existing holders
 * AT RANDOM, in proportion to what they hold. That is false in a specific and
 * known direction: long-term holders churn far less than day traders, so the
 * model forgets old cost bases faster than reality does. Every label therefore
 * reads "estimated", and every number carries a confidence score.
 *
 * WHY FREE FLOAT IS THE WHOLE GAME. Turnover has to be measured against what
 * can actually trade, not against shares outstanding. A name with 10% float and
 * 2% daily volume-to-shares is rotating 20% of its float per day — its cost
 * distribution converges on recent prices within a week. At 80% float the same
 * volume barely moves it. Using shares outstanding instead would understate
 * rotation by the reciprocal of the float and make every thin, heavily-traded
 * name look like it still has holders down at the old price.
 *
 * Read-only. Lives outside the frozen scraper tree; nothing the IDX engine runs
 * reads any of this.
 *
 * Usage:  node float_cost_map.js TICKER [--days 250]
 */
'use strict';

require('/var/www/flowtracker-scraper/node_modules/dotenv').config({ path: '/var/www/flowtracker-scraper/.env' });
const mysql = require('/var/www/flowtracker-scraper/node_modules/mysql2/promise');

const TICKER = (process.argv[2] || 'BBCA').toUpperCase();
const DAYS = Number((process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : 0)) || 250;

/**
 * Not all traded volume is a genuine change of owner — the same shares are
 * flipped repeatedly intraday, and that inflates apparent rotation. This damps
 * it. It is a free parameter, it is not fitted to anything, and it is printed
 * with the output so nobody mistakes it for a measurement.
 */
const TURNOVER_K = 0.75;
const BUCKETS = 40;

function pctl(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing',
    waitForConnections: true, connectionLimit: 2,
  });

  const [[ff]] = await pool.query('SELECT * FROM idx_free_float WHERE stock_code=?', [TICKER]);
  const [bars] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v, value val
       FROM idx_stock_prices WHERE stock_code=? AND volume > 0
      ORDER BY date DESC LIMIT ?`, [TICKER, DAYS]);
  bars.reverse();

  if (!bars.length) { console.log(`no price history for ${TICKER}`); await pool.end(); return; }
  if (!ff) {
    const [[rej]] = await pool.query(
      'SELECT reason FROM idx_free_float_rejected WHERE stock_code=? ORDER BY id DESC LIMIT 1', [TICKER]);
    console.log(`\n  ${TICKER}: NO FREE FLOAT ON RECORD${rej ? ` — ${rej.reason}` : ''}`);
    console.log('  Without a tradable-share count there is no denominator, so no map is produced.');
    console.log('  A guess here would look exactly like a measurement, which is the failure mode.\n');
    await pool.end(); return;
  }

  const floatShares = Number(ff.float_shares);
  const last = bars[bars.length - 1];
  const price = Number(last.c);

  // THE `value` COLUMN IS NOT A VWAP SOURCE, and checking revealed two things.
  // It has been 0 since 2026-08-03 — an ingestion regression of the same
  // vintage as the broker feed going stale — and on the days it IS populated,
  // value/volume comes back exactly equal to the close. It is volume × close,
  // so it never carried intraday information in the first place.
  //
  // So the day's centre of gravity is the typical price (H+L+C)/3, the standard
  // proxy when true VWAP is unavailable. Naming it vwap would have been a lie
  // that quietly survived into every number below.
  const valueOutage = bars.filter(b => !Number(b.val)).length;
  const typicalPrice = b => (Number(b.h) + Number(b.l) + Number(b.c)) / 3;

  // Volume units decide every rotation figure. If volume were in lots rather
  // than shares, turnover would be understated 100× and a fully-rotated float
  // would read as a quiet one. Checked against the float directly: median daily
  // turnover outside 0.001%–50% of float means the units are not what we think.
  const medTurn = (() => {
    const t = bars.map(b => Number(b.v) / floatShares).sort((a, b) => a - b);
    return t[Math.floor(t.length / 2)] * 100;
  })();
  const volumeUnitsSane = medTurn > 0.001 && medTurn < 50;

  // Corporate actions are the one thing that can make this map confidently
  // wrong rather than merely uncertain: a 1:5 split moves every historical
  // price by 5× while the shares behind them are unchanged, so the old cost
  // basis lands in a bucket that never existed. Not adjusted for — but
  // detected, so the map can say so instead of drawing it.
  const jumps = [];
  for (let i = 1; i < bars.length; i++) {
    const a = Number(bars[i - 1].c), b = Number(bars[i].c);
    if (!a || !b) continue;
    const chg = b / a - 1;
    if (Math.abs(chg) > 0.35) jumps.push({ date: bars[i].date, pct: chg * 100 });
  }

  // ── the model ────────────────────────────────────────────────────────────
  const lo = Math.min(...bars.map(b => Number(b.l)));
  const hi = Math.max(...bars.map(b => Number(b.h)));
  const step = (hi - lo) / BUCKETS;
  const mid = i => lo + step * (i + 0.5);
  let dist = new Array(BUCKETS).fill(0);

  // Everything starts at the first session's average price. The first bar is
  // therefore the least trustworthy part of the map and decays out of it.
  const firstCentre = typicalPrice(bars[0]);
  dist[Math.max(0, Math.min(BUCKETS - 1, Math.floor((firstCentre - lo) / step)))] = floatShares;

  const turnovers = [];
  for (const b of bars) {
    const vol = Number(b.v);
    const centre = typicalPrice(b);
    const raw = vol / floatShares;
    const t = Math.min(1, raw * TURNOVER_K);
    turnovers.push(raw);

    for (let i = 0; i < BUCKETS; i++) dist[i] *= (1 - t);

    // Re-assign the shares that moved across the day's range, weighted toward
    // VWAP — a triangular kernel rather than dumping everything on the close,
    // because the close is one print and the day is a distribution.
    const bl = Number(b.l), bh = Number(b.h);
    const iLo = Math.max(0, Math.floor((bl - lo) / step));
    const iHi = Math.min(BUCKETS - 1, Math.floor((bh - lo) / step));
    const w = [];
    let wsum = 0;
    for (let i = iLo; i <= iHi; i++) {
      const d = Math.abs(mid(i) - centre);
      const span = Math.max(step, (bh - bl) / 2);
      const wi = Math.max(0.05, 1 - d / span);
      w.push(wi); wsum += wi;
    }
    const moved = floatShares * t;
    for (let i = iLo, k = 0; i <= iHi; i++, k++) dist[i] += moved * (w[k] / wsum);
  }

  const total = dist.reduce((a, b) => a + b, 0);
  const share = dist.map(x => x / total);

  const avgCost = dist.reduce((a, x, i) => a + x * mid(i), 0) / total;
  const below = dist.reduce((a, x, i) => a + (mid(i) < price ? x : 0), 0) / total;
  const peakI = dist.indexOf(Math.max(...dist));
  const overhead = dist.reduce((a, x, i) => a + (mid(i) > price ? x : 0), 0) / total;

  const rot = n => turnovers.slice(-n).reduce((a, b) => a + b, 0) * 100;

  // ── smart-money cost, from broker flow ───────────────────────────────────
  // Not modelled: idx_broker_summary carries the price each broker actually
  // bought and sold at. This is the one part of the map that is measured.
  const [brokers] = await pool.query(
    `SELECT broker_code,
            SUM(buy_lot) bl, SUM(sell_lot) sl,
            SUM(buy_lot*buy_avg) bcost,
            MAX(date) last_seen
       FROM idx_broker_summary
      WHERE stock_code=? AND date >= DATE_SUB((SELECT MAX(date) FROM idx_broker_summary), INTERVAL 120 DAY)
      GROUP BY broker_code HAVING bl > 0
      ORDER BY (SUM(buy_lot)-SUM(sell_lot)) DESC LIMIT 5`, [TICKER]);
  const smart = brokers.filter(b => Number(b.bl) - Number(b.sl) > 0)
    .map(b => ({ code: b.broker_code, net: Number(b.bl) - Number(b.sl), avg: Number(b.bcost) / Number(b.bl) }));
  const [[bstale]] = await pool.query('SELECT MAX(date) d FROM idx_broker_summary');

  // ── confidence ───────────────────────────────────────────────────────────
  const brokerLagDays = bstale ? Math.round((new Date(last.date) - new Date(bstale.d)) / 86400000) : 999;
  const conf = [];
  conf.push({ k: 'free float on record', ok: true, w: 25 });
  conf.push({ k: 'price history depth', ok: bars.length >= 200, w: 20, note: `${bars.length} sessions` });
  conf.push({ k: 'volume units sane', ok: volumeUnitsSane, w: 20, note: `median daily turnover ${medTurn.toFixed(2)}% of float` });
  conf.push({ k: 'broker flow fresh', ok: brokerLagDays <= 2, w: 20, note: `${brokerLagDays}d behind prices` });
  conf.push({ k: 'no corporate action in window', ok: jumps.length === 0, w: 15,
    note: jumps.length ? `${jumps.length} jump(s) >35%: ${jumps.slice(0,3).map(j => `${String(j.date).slice(0,10)} ${j.pct.toFixed(0)}%`).join(', ')} — NOT adjusted` : 'none >35% detected (not the same as adjusted)' });
  const score = conf.reduce((a, c) => a + (c.ok ? c.w : 0), 0);

  // ── render ───────────────────────────────────────────────────────────────
  const rp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');
  const shown = [];
  for (let i = BUCKETS - 1; i >= 0; i--) if (share[i] >= 0.005) shown.push(i);
  const maxShare = Math.max(...shown.map(i => share[i]));

  console.log(`\n           ESTIMATED FLOAT COST MAP — ${TICKER}\n`);
  for (const i of shown) {
    const bar = '█'.repeat(Math.max(1, Math.round(share[i] / maxShare * 24)));
    const mark = (price >= mid(i) - step / 2 && price < mid(i) + step / 2) ? ' ← price' : '';
    console.log(`${rp(mid(i)).padStart(8)} │ ${bar.padEnd(25)}${(share[i] * 100).toFixed(1).padStart(5)}%${mark}`);
  }
  console.log(`         └${'─'.repeat(31)}`);

  console.log(`\nCurrent Price        ${rp(price)}`);
  const gap = (price / avgCost - 1) * 100;
  console.log(`Estimated Avg Cost   ${rp(avgCost)}   (price is ${Math.abs(gap).toFixed(1)}% ${gap >= 0 ? 'ABOVE' : 'BELOW'} it)`);
  console.log(`Free float           ${Number(ff.float_pct).toFixed(1)}%  ·  ${(floatShares / 1e9).toFixed(2)}bn shares`);

  console.log(`\n🟢 Estimated in profit      ${(below * 100).toFixed(0)}%`);
  console.log(`🔴 Estimated underwater     ${((1 - below) * 100).toFixed(0)}%`);
  console.log(`🟡 Largest cost cluster     ${rp(mid(peakI) - step / 2)}–${rp(mid(peakI) + step / 2)}  (${(share[peakI] * 100).toFixed(1)}%)`);
  if (smart.length) {
    const lo2 = Math.min(...smart.map(s => s.avg)), hi2 = Math.max(...smart.map(s => s.avg));
    console.log(`🟢 Smart-money cost (measured, not modelled)  ${rp(lo2)}–${rp(hi2)}`);
    console.log(`   top accumulators: ${smart.map(s => `${s.code}@${rp(s.avg)}`).join('  ')}`);
  } else {
    console.log(`🟢 Smart-money cost         no net accumulator in the last 120 sessions`);
  }
  console.log(`⚠  Overhead supply above    ${(overhead * 100).toFixed(0)}%   ${overhead > 0.3 ? 'HIGH' : overhead > 0.12 ? 'MODERATE' : 'LOW'}`);

  console.log(`\nEstimated float rotation (raw turnover, one share can move many times)`);
  console.log(`  last 5      ${rot(5).toFixed(0)}%`);
  console.log(`  last 20     ${rot(20).toFixed(0)}%`);
  console.log(`  last 60     ${rot(60).toFixed(0)}%`);

  console.log(`\nCost Basis Confidence: ${score}/100`);
  for (const c of conf) console.log(`  ${c.ok ? '  ok' : '  **'}  ${c.k.padEnd(28)} ${c.note || ''}`);
  if (score < 60) console.log(`\n  ** Below 60 — do not use this for a signal.`);
  console.log(`\nModel: proportional-replacement chip distribution, turnover coefficient ${TURNOVER_K}, ${BUCKETS} buckets, ${bars.length} sessions.`);
  console.log(`ESTIMATED. Nobody outside KSEI knows the real holders; this is inventory accounting, not ownership.\n`);

  await pool.end();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
