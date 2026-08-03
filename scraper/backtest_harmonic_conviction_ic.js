/**
 * EXP-018 — Harmonic conviction: does it predict, and is its heaviest input inverted?
 *
 * TWO QUESTIONS, THE SECOND IS THE SHARP ONE
 * ------------------------------------------
 * 1. Does calcUltraConviction's master score actually sort forward returns?
 *    modules/conviction.js currently tells users "Smart money confirmed — 73%→87%
 *    win rate, replicated across 2 market regimes". That number comes from
 *    backtest_harmonic_winrate.js, whose own header flags it provisional; it was
 *    computed with the F4/F6/F7/dn0 formulas that were fixed on 2026-07-28 and
 *    has never been regenerated. It is also a WIN RATE, which EXP-013 showed
 *    hides turnover and cost entirely.
 *
 * 2. Is broker_flow — the single heaviest category at 30 of 100 points, more than
 *    harmonic (20), smc (20), wyckoff (15) or volume_profile (15) — pointing the
 *    wrong way? Its E1 component awards +10 when the last three dn0 readings are
 *    all positive for a BULLISH setup. EXP-016 measured exactly that persistence
 *    and found it predicts UNDERperformance, more strongly the longer the window
 *    (POSFRAC_60: IC −0.105, IR −0.83, sign stable across all three years).
 *
 *    If that holds here, up to 30% of the conviction score is being awarded on an
 *    inverted premise — rewarding setups that go on to lose.
 *
 * HOW THE INVERSION IS TESTED
 * ---------------------------
 * Without touching harmonicEngine.js. The broker_flow block is entirely
 * sign-driven (posConc/negConc counts, bmDir/fDir direction matches), so passing
 * negated brokerData produces exactly the mirrored component and leaves the other
 * four categories untouched. Three variants:
 *    AS_IS     production behaviour
 *    INVERTED  brokerData sign flipped
 *    OFF       broker_flow weight set to 0, other categories renormalised
 *
 * Ranking-only: forward returns, no entry timing beyond T+1, no stop/target.
 * The question is whether the SCORE carries information, which is prior to any
 * question about exits.
 *
 * SURVIVORSHIP-BIASED RESEARCH RESULT.
 *
 * Usage: node backtest_harmonic_conviction_ic.js [--step 10] [--json out.json]
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');
const cs = require('./modules/cross_sectional');
const {
  detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
  detectFairValueGaps, detectLiquiditySweeps, buildVolumeProfile,
  calcUltraConviction, DEFAULT_WEIGHTS,
} = require('./harmonicEngine');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const WINDOW = 180;          // trailing bars for detection — matches production
const FRESH_BARS = 5;        // only patterns whose D-point formed recently
const HORIZONS = [20, 40, 60];
const MIN_ADV = 5e9, ADV_WINDOW = 20;
const ROUND_TRIP = 0.50;     // % — the project-wide cost assumption
const SEED = 42;

const VARIANTS = [
  { key: 'AS_IS',    invert: false, weights: DEFAULT_WEIGHTS },
  { key: 'INVERTED', invert: true,  weights: DEFAULT_WEIGHTS },
  { key: 'OFF',      invert: false, weights: { ...DEFAULT_WEIGHTS, broker_flow: 0 } },
];

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { step: 10, json: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--step') o.step = Number(a[++i]);
    else if (a[i] === '--json') o.json = a[++i];
  }
  return o;
}
const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];
const fmt = (v, d = 4) => (v === null || !Number.isFinite(v)) ? '   n/a' : v.toFixed(d).padStart(7);

async function main() {
  const o = parseArgs();
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  console.log('='.repeat(100));
  console.log('EXP-018 — Harmonic conviction IC, and the broker_flow inversion test');
  console.log('*** SURVIVORSHIP-BIASED RESEARCH RESULT ***');
  console.log('='.repeat(100));

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, low_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`);
  const byTicker = new Map();
  for (const r of priceRows) {
    if (!byTicker.has(r.stock_code)) byTicker.set(r.stock_code, []);
    byTicker.get(r.stock_code).push({
      date: toDateStr(r.date), open: +r.open_price || +r.close_price,
      high: +r.high_price || +r.close_price, low: +r.low_price || +r.close_price,
      close: +r.close_price, volume: +r.volume || 0,
      value: +r.value || (+r.close_price) * (+r.volume || 0),
    });
  }

  // Broker context, indexed by ticker -> sorted [{date, dn0..dn2}]
  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0, dn1, dn2 FROM idx_concentration ORDER BY data_date ASC');
  const concBy = new Map();
  for (const r of concRows) {
    if (!concBy.has(r.stock_code)) concBy.set(r.stock_code, []);
    concBy.get(r.stock_code).push({ date: toDateStr(r.data_date), dn0: +r.dn0 || 0, dn1: +r.dn1 || 0, dn2: +r.dn2 || 0 });
  }
  const [flowRows] = await pool.query(
    `SELECT stock_code, date, investor_type, SUM(net_val) net FROM idx_broker_flow_detail GROUP BY stock_code, date, investor_type`);
  const flowBy = new Map();
  for (const r of flowRows) {
    const k = r.stock_code;
    if (!flowBy.has(k)) flowBy.set(k, new Map());
    const d = toDateStr(r.date);
    const e = flowBy.get(k).get(d) || { foreignNet: 0, bigMoneyNet: 0 };
    if (r.investor_type === 'foreign') e.foreignNet += Number(r.net) || 0;
    else e.bigMoneyNet += Number(r.net) || 0;
    flowBy.get(k).set(d, e);
  }

  const latestConc = (t, d) => {
    const arr = concBy.get(t); if (!arr) return null;
    let out = null;
    for (const e of arr) { if (e.date <= d) out = e; else break; }
    return out;
  };

  console.log(`\nTickers with price history: ${byTicker.size}`);
  console.log(`Concentration coverage    : ${concBy.size} tickers`);
  console.log(`Flow-detail coverage      : ${flowBy.size} tickers (starts 2025-12, so many patterns have zero net)`);
  console.log(`Detection window ${WINDOW} bars, sampling every ${o.step}, horizons ${HORIZONS.join('/')}D\n`);

  // acc[variant][horizon] = { scores:[], rets:[], byYear:Map }
  const acc = new Map(VARIANTS.map(v => [v.key, new Map(HORIZONS.map(h => [h, { s: [], r: [], byYear: new Map() }]))]));
  let patternsFound = 0, tickersScanned = 0;
  const maxH = Math.max(...HORIZONS);

  for (const [ticker, candles] of byTicker) {
    if (candles.length < WINDOW + maxH + 10) continue;
    tickersScanned++;
    for (let i = WINDOW; i < candles.length - maxH; i += o.step) {
      // Liquidity screen, as of the decision bar only.
      const advSlice = candles.slice(i - ADV_WINDOW + 1, i + 1).map(c => c.value).filter(Number.isFinite).sort((a, b) => a - b);
      if (!advSlice.length) continue;
      const adv = advSlice[advSlice.length >> 1];
      if (adv < MIN_ADV) continue;

      const win = candles.slice(i - WINDOW + 1, i + 1);
      const asOf = candles[i].date;
      let patterns = [];
      try { patterns = detectHarmonicPatterns(win, ticker) || []; } catch { continue; }
      if (!patterns.length) continue;
      // Only fresh setups — a pattern whose D-point formed long ago is stale.
      patterns = patterns.filter(p => (p.d_index === undefined) || (win.length - 1 - p.d_index) <= FRESH_BARS);
      if (!patterns.length) continue;

      let structureData, wyckoffData, smcData, vp;
      try {
        wyckoffData = detectWyckoffPhase(win);
        smcData = {
          orderBlocks: detectOrderBlocks(win), fairValueGaps: detectFairValueGaps(win),
          liquiditySweeps: detectLiquiditySweeps(win),
        };
        vp = buildVolumeProfile(win);
        structureData = { ohlc: win };
      } catch { continue; }

      const conc = latestConc(ticker, asOf) || { dn0: 0, dn1: 0, dn2: 0 };
      const fl = (flowBy.get(ticker) && flowBy.get(ticker).get(asOf)) || { foreignNet: 0, bigMoneyNet: 0 };
      const brokerRaw = { dn0: conc.dn0, dn1: conc.dn1, dn2: conc.dn2, foreignNet: fl.foreignNet, bigMoneyNet: fl.bigMoneyNet };
      // Sign flip mirrors the entire broker_flow block, which is purely
      // sign-driven, and leaves the other four categories untouched.
      const brokerInv = { dn0: -conc.dn0, dn1: -conc.dn1, dn2: -conc.dn2, foreignNet: -fl.foreignNet, bigMoneyNet: -fl.bigMoneyNet };

      const p0 = candles[i].close;
      if (!(p0 > 0)) continue;
      const year = asOf.slice(0, 4);

      for (const p of patterns) {
        patternsFound++;
        const dirMul = (p.direction === 'BEARISH') ? -1 : 1;   // score a bearish setup against a fall
        for (const v of VARIANTS) {
          let ms;
          try {
            ms = calcUltraConviction(p, structureData, wyckoffData, smcData, vp,
                                     v.invert ? brokerInv : brokerRaw, v.weights);
          } catch { continue; }
          const score = ms && Number.isFinite(ms.master_score) ? ms.master_score : null;
          if (score === null) continue;
          for (const h of HORIZONS) {
            const pf = candles[i + h];
            if (!pf || !(pf.close > 0)) continue;
            const ret = dirMul * ((pf.close - p0) / p0) * 100 - ROUND_TRIP;
            const slot = acc.get(v.key).get(h);
            slot.s.push(score); slot.r.push(ret);
            if (!slot.byYear.has(year)) slot.byYear.set(year, { s: [], r: [] });
            slot.byYear.get(year).s.push(score);
            slot.byYear.get(year).r.push(ret);
          }
        }
      }
    }
  }

  console.log(`Scanned ${tickersScanned} tickers, found ${patternsFound} fresh pattern instances\n`);
  if (!patternsFound) { console.log('No patterns — nothing to report.'); await pool.end(); return; }

  console.log('='.repeat(100));
  console.log('CONVICTION SCORE vs FORWARD RETURN  (net of the 0.50% round trip, direction-adjusted)');
  console.log('='.repeat(100));
  console.log('  variant    horizon      n      IC     top-decile   bot-decile    spread    mean');
  const out = {};
  for (const v of VARIANTS) {
    out[v.key] = {};
    for (const h of HORIZONS) {
      const { s, r } = acc.get(v.key).get(h);
      const ic = cs.spearmanIC(s, r);
      const { buckets, universeMean } = cs.bucketByScore(s, r, 10);
      const d10 = buckets[9].meanReturn, d1 = buckets[0].meanReturn;
      console.log(`  ${v.key.padEnd(9)} ${String(h).padStart(4)}D  ${String(s.length).padStart(6)}  ${fmt(ic)}   ${fmt(d10, 2)}%   ${fmt(d1, 2)}%  ${fmt(d10 !== null && d1 !== null ? d10 - d1 : null, 2)}%  ${fmt(universeMean, 2)}%`);
      out[v.key][h] = { n: s.length, ic, d10, d1, mean: universeMean };
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('PER-YEAR IC at 40D — is any of this stable?');
  console.log('='.repeat(100));
  const years = [...new Set([].concat(...VARIANTS.map(v => [...acc.get(v.key).get(40).byYear.keys()])))].sort();
  process.stdout.write('  variant   ');
  years.forEach(y => process.stdout.write(y.slice(2).padStart(8)));
  console.log('');
  for (const v of VARIANTS) {
    process.stdout.write('  ' + v.key.padEnd(10));
    for (const y of years) {
      const e = acc.get(v.key).get(40).byYear.get(y);
      const ic = e && e.s.length >= 30 ? cs.spearmanIC(e.s, e.r) : null;
      process.stdout.write((ic === null ? '   -' : ic.toFixed(3)).padStart(8));
    }
    console.log('');
  }

  console.log('\n' + '='.repeat(100));
  console.log('VERDICT');
  console.log('='.repeat(100));
  const a40 = out.AS_IS[40], i40 = out.INVERTED[40], f40 = out.OFF[40];
  console.log(`\n  AS_IS    IC ${fmt(a40.ic)}   (production behaviour)`);
  console.log(`  INVERTED IC ${fmt(i40.ic)}   (broker data sign flipped)`);
  console.log(`  OFF      IC ${fmt(f40.ic)}   (broker_flow weight 0)`);
  console.log('');
  if (i40.ic !== null && a40.ic !== null && i40.ic > a40.ic + 0.01) {
    console.log('  >> Inverting the broker input IMPROVES the score. The heaviest category is');
    console.log('     awarding points on a premise EXP-016 already measured as backwards.');
  } else if (f40.ic !== null && a40.ic !== null && f40.ic > a40.ic + 0.01) {
    console.log('  >> Removing broker_flow improves the score: it is contributing noise, though');
    console.log('     not cleanly inverted.');
  } else {
    console.log('  >> Neither inverting nor removing broker_flow clearly helps at this sample size.');
  }
  console.log('\n  Note the mean column: if the mean forward return is broadly negative, these');
  console.log('  patterns lose money on average regardless of score, and any IC only tells you');
  console.log('  which ones lose less. Read the level before the ranking.');

  if (o.json) { require('fs').writeFileSync(o.json, JSON.stringify(out, null, 2)); console.log(`\n  JSON -> ${o.json}`); }
  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
