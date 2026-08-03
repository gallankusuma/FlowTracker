/**
 * Exact verification of modules/strategy_book.js — the module the live forward
 * test and every backtest now share.
 *
 * WHAT THIS USED TO BE, AND WHY IT WAS WORTHLESS
 * ----------------------------------------------
 * The previous version asserted the replay landed in a "plausible
 * neighbourhood": excess over baseline >= 2%, drawdown <= 25%. Those pass for a
 * very wide range of broken modules. It also built a `reverse` variant by
 * passing `reverseForTest: true` — a flag strategy_book.js never read — and then
 * never asserted on the result or even printed it. A control that is computed
 * and discarded is worse than no control: it produces the appearance of rigour
 * with none of the substance. The 2026-08-03 review caught both.
 *
 * WHAT IT IS NOW
 * --------------
 * 1. GOLDEN FIXTURE. The replay records the exact target book on every decision
 *    date, every open and close, trade count, costs, final equity and max
 *    drawdown, then hashes the whole thing. Any change to the module that moves
 *    any of those numbers fails this test loudly. Regenerate deliberately with
 *    --update-golden when a change is intended, and the diff in the fixture
 *    file is then the record of what changed.
 *
 * 2. A REVERSE CONTROL THAT ACTUALLY RUNS. Now possible because strategy_book
 *    exposes `vetoSelector`. Banning the LEAST-accumulated names must HURT
 *    relative to banning the most-accumulated; if it helps, the effect has
 *    nothing to do with the signal's direction and EXP-017 is measuring an
 *    artifact.
 *
 * 3. NO-LOOKAHEAD. Truncating every bar after the decision must leave the book
 *    byte-identical.
 *
 * Usage: node verify_strategy_book.js [--update-golden]
 */
'use strict';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const exec = require('./modules/execution');
const sb = require('./modules/strategy_book');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const GOLDEN = path.join(__dirname, 'fixtures', 'strategy_book.golden.json');
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100, TRADING_DAYS_YEAR = 245;
const REBAL_BARS = 10;
const PARAMS = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };

const toDateStr = d => d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).split('T')[0];
const r6 = v => (v === null || !Number.isFinite(v)) ? null : Math.round(v * 1e6) / 1e6;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '\n          ' + detail : ''}`); }
}

async function load(pool) {
  const [ihsgRows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const tradingDates = ihsgRows.map(r => toDateStr(r.date));
  const ihsgClose = ihsgRows.map(r => Number(r.close_price));
  const dateIdx = new Map(tradingDates.map((d, i) => [d, i]));
  const n = tradingDates.length;

  const [priceRows] = await pool.query(
    `SELECT stock_code, date, open_price, high_price, close_price, volume, value
       FROM idx_stock_prices WHERE close_price > 0 ORDER BY stock_code, date ASC`);
  const series = new Map();
  for (const r of priceRows) {
    const i = dateIdx.get(toDateStr(r.date));
    if (i === undefined) continue;
    if (!series.has(r.stock_code)) series.set(r.stock_code, {
      open: new Array(n).fill(null), high: new Array(n).fill(null),
      close: new Array(n).fill(null), value: new Array(n).fill(null),
      dn0: new Array(n).fill(null), placed: 0, nConc: 0,
    });
    const s = series.get(r.stock_code);
    const c = Number(r.close_price);
    s.open[i] = Number(r.open_price) || c; s.high[i] = Number(r.high_price) || c;
    s.close[i] = c; s.value[i] = Number(r.value) || c * Number(r.volume || 0);
    s.placed++;
  }
  const [concRows] = await pool.query('SELECT stock_code, data_date, dn0 FROM idx_concentration');
  let concStart = Infinity;
  for (const r of concRows) {
    const i = dateIdx.get(toDateStr(r.data_date));
    if (i === undefined) continue;
    const s = series.get(r.stock_code);
    if (!s) continue;
    const v = sb.clipDn(r.dn0, sb.DEFAULTS.dnBound);
    if (v === null) continue;
    s.dn0[i] = v; s.nConc++;
    if (i < concStart) concStart = i;
  }
  // NO UNIVERSE FILTER HERE. Eligibility is decided per decision bar inside
  // strategy_book.crossSection(), from data through bar i only. This loader
  // used to run `if (s.placed < 400 || s.nConc < 200) series.delete(t)` --
  // lifetime counts over the WHOLE sample, so a ticker entered the 2024
  // universe only if the code already knew it would eventually reach 400 bars
  // and 200 broker observations by the end of the data (review P0.2). Deleting
  // here also made strategy_book.js's "ALL INPUTS ARE AS-OF" header vacuous:
  // the Map arrived pre-filtered with future knowledge before the module ran.
  return { tradingDates, ihsgClose, ihsgSma: sb.smaSeries(ihsgClose, sb.DEFAULTS.regimeSma), series, concStart };
}

/**
 * Replay driven entirely by strategy_book.targetBook(), recording everything the
 * golden fixture pins — not just the headline return.
 */
function replay(ctx, firstI, lastI, params) {
  const { series, ihsgClose, ihsgSma, tradingDates } = ctx;
  let cash = 1.0;
  const held = new Map();
  const decisions = [], equity = [];
  let trades = 0, costPaid = 0, noFill = 0, sellNoFill = 0;

  for (let i = firstI; i <= lastI; i += REBAL_BARS) {
    const execI = i + 1;
    if (execI > lastI + 1) break;
    const d = sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: [...held.keys()], opts: params });

    // Halted holdings mark off their last real close, not zero (review P0.1).
    const pv = cash + exec.markToMarket(held, series, execI).value;

    const tset = new Set(d.target);
    const closed = [], opened = [];
    for (const [t, u] of [...held]) {
      if (tset.has(t)) continue;
      // A seller who cannot sell still owns the shares (review P0.1).
      const px = exec.sellFill(series.get(t), execI);
      if (px === null) { sellNoFill++; continue; }
      const fee = u * px * SELL_COST;
      cash += u * px - fee; costPaid += fee; trades++;
      closed.push(t); held.delete(t);
    }
    for (const t of d.target.filter(x => !held.has(x))) {
      const px = series.get(t).open[execI];
      if (!(px > 0)) { noFill++; continue; }
      const spend = Math.min(pv / Math.max(d.target.length, 1) * d.exposure, cash);
      if (spend <= 0) continue;
      const fee = spend * BUY_COST;
      cash -= spend; costPaid += fee; trades++;
      held.set(t, (spend - fee) / px);
      opened.push(t);
    }

    const mv = cash + exec.markToMarket(held, series, execI).value;
    equity.push(r6(mv));
    decisions.push({
      date: tradingDates[i], exposure: d.exposure, eligible: d.eligible,
      vetoed: d.vetoedCount, book: d.target.slice().sort(),
      opened: opened.sort(), closed: closed.sort(),
    });
  }

  let final = cash;
  for (const [t, u] of held) {
    const s = series.get(t);
    for (let j = lastI; j >= 0; j--) if (s.close[j] > 0) { final += u * s.close[j] * (1 - SELL_COST); break; }
  }
  let peak = -Infinity, mdd = 0;
  for (const v of equity.concat([final])) { if (v > peak) peak = v; if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak); }
  const years = (lastI - firstI) / TRADING_DAYS_YEAR;

  return {
    decisions, equity,
    trades, noFill, sellNoFill,
    costPaid: r6(costPaid),
    finalEquity: r6(final),
    maxDrawdown: r6(mdd),
    cagr: r6(Math.pow(final, 1 / years) - 1),
    hash: crypto.createHash('sha256')
      .update(JSON.stringify({ decisions, equity, trades, noFill, sellNoFill, costPaid: r6(costPaid), finalEquity: r6(final) }))
      .digest('hex').slice(0, 32),
  };
}

(async () => {
  const update = process.argv.includes('--update-golden');
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  const ctx = await load(pool);

  const firstI = Math.max(ctx.concStart + sb.DEFAULTS.posfracWindow, sb.DEFAULTS.hiBars, sb.DEFAULTS.regimeSma);
  const lastI = ctx.tradingDates.length - 2;

  console.log('='.repeat(92));
  console.log('VERIFY strategy_book.js — exact fixture comparison, not a plausibility range');
  console.log('='.repeat(92));
  console.log(`Window ${ctx.tradingDates[firstI]} .. ${ctx.tradingDates[lastI]}   universe ${ctx.series.size}\n`);

  const run = replay(ctx, firstI, lastI, PARAMS);
  console.log(`  decisions ${run.decisions.length}  trades ${run.trades}  buy NO_FILL ${run.noFill}  sell NO_FILL ${run.sellNoFill}`);
  console.log(`  finalEquity ${run.finalEquity}  maxDD ${(run.maxDrawdown * 100).toFixed(2)}%  cagr ${(run.cagr * 100).toFixed(2)}%`);
  console.log(`  hash ${run.hash}\n`);

  if (update) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(run, null, 1));
    console.log(`  GOLDEN FIXTURE WRITTEN -> ${GOLDEN}`);
    console.log('  Commit it. From now on any change to these numbers fails the test.');
    await pool.end();
    return;
  }

  console.log('GOLDEN FIXTURE COMPARISON');
  if (!fs.existsSync(GOLDEN)) {
    console.log('  FAIL  no fixture — run once with --update-golden and commit the result');
    fail++;
  } else {
    const g = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    check('decision count matches', g.decisions.length === run.decisions.length,
      `${g.decisions.length} vs ${run.decisions.length}`);
    check('trade count matches', g.trades === run.trades, `${g.trades} vs ${run.trades}`);
    check('buy NO_FILL count matches', g.noFill === run.noFill, `${g.noFill} vs ${run.noFill}`);
    check('sell NO_FILL count matches', g.sellNoFill === run.sellNoFill, `${g.sellNoFill} vs ${run.sellNoFill}`);
    check('costs paid match', g.costPaid === run.costPaid, `${g.costPaid} vs ${run.costPaid}`);
    check('final equity matches', g.finalEquity === run.finalEquity, `${g.finalEquity} vs ${run.finalEquity}`);
    check('max drawdown matches', g.maxDrawdown === run.maxDrawdown, `${g.maxDrawdown} vs ${run.maxDrawdown}`);
    check('full equity curve matches', JSON.stringify(g.equity) === JSON.stringify(run.equity),
      'the curve diverged — diff the fixture to see where');

    // Per-date book comparison, reporting the FIRST divergence rather than only that one exists.
    let firstDiff = null;
    for (let k = 0; k < Math.min(g.decisions.length, run.decisions.length); k++) {
      const a = g.decisions[k], b = run.decisions[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) { firstDiff = { k, a, b }; break; }
    }
    check('every per-date target book, open and close matches', firstDiff === null,
      firstDiff ? `first divergence on ${firstDiff.b.date}:\n          golden ${JSON.stringify(firstDiff.a.book)}\n          now    ${JSON.stringify(firstDiff.b.book)}` : '');
    check('overall hash matches', g.hash === run.hash, `${g.hash} vs ${run.hash}`);
  }

  // ── The reverse control, this time actually wired ────────────────────────
  console.log('\nREVERSE CONTROL (now genuinely wired via vetoSelector)');
  const leastAccumulatedSelector = (rows, p) => {
    const withPf = rows.filter(r => r.posfrac !== null).sort((a, b) => a.posfrac - b.posfrac);
    const k = Math.floor(withPf.length * p.vetoFrac);
    const banned = new Set();
    for (let z = 0; z < k; z++) banned.add(withPf[z].ticker);
    return banned;
  };
  const reverse = replay(ctx, firstI, lastI, { ...PARAMS, vetoSelector: leastAccumulatedSelector });
  const noVeto = replay(ctx, firstI, lastI, { ...PARAMS, vetoFrac: 0, exitOnVeto: false });

  console.log(`  veto most-accumulated  CAGR ${(run.cagr * 100).toFixed(2)}%`);
  console.log(`  veto least-accumulated CAGR ${(reverse.cagr * 100).toFixed(2)}%   <- must be WORSE`);
  console.log(`  no veto                CAGR ${(noVeto.cagr * 100).toFixed(2)}%`);

  check('reverse control produces a DIFFERENT book (proves the hook is wired)',
    reverse.hash !== run.hash, 'identical hash means vetoSelector was ignored — the old bug');
  check('vetoing the least-accumulated is WORSE than vetoing the most-accumulated',
    reverse.cagr < run.cagr, `${(reverse.cagr * 100).toFixed(2)}% vs ${(run.cagr * 100).toFixed(2)}%`);

  // ── No lookahead ─────────────────────────────────────────────────────────
  //
  // TRUNCATE AT A MIDDLE BAR, NOT THE LAST ONE. The earlier version of this test
  // truncated at lastI, where it could not fail: at the final bar a count over
  // the whole array and a count over data through `i` are numerically identical,
  // so it could not tell an as-of counter from the lifetime counter that review
  // P0.2 was about. Truncating with real future data present is what makes the
  // assertion bite. Both bars are checked — the middle one for the strength, the
  // last one because that is the bar production actually decides on.
  console.log('\nNO-LOOKAHEAD');
  const midI = Math.floor((firstI + lastI) / 2);
  const truncateAt = (cut) => {
    const m = new Map();
    for (const [t, s] of ctx.series) m.set(t, {
      open: s.open.slice(0, cut + 1), high: s.high.slice(0, cut + 1),
      close: s.close.slice(0, cut + 1), value: s.value.slice(0, cut + 1), dn0: s.dn0.slice(0, cut + 1),
    });
    return m;
  };
  const bookAt = (series, i, ihsgClose, ihsgSma) =>
    sb.targetBook({ series, i, ihsgClose, ihsgSma, currentHoldings: [], opts: PARAMS });

  for (const cut of [midI, lastI]) {
    const full = bookAt(ctx.series, cut, ctx.ihsgClose, ctx.ihsgSma);
    const trunc = bookAt(truncateAt(cut), cut, ctx.ihsgClose.slice(0, cut + 1), ctx.ihsgSma.slice(0, cut + 1));
    const label = cut === lastI ? `last bar ${ctx.tradingDates[cut]}` : `mid-sample bar ${ctx.tradingDates[cut]} (${lastI - cut} future bars discarded)`;
    check(`truncating every future bar leaves the book identical — ${label}`,
      JSON.stringify(full.target) === JSON.stringify(trunc.target),
      `${JSON.stringify(full.target)}\n          vs ${JSON.stringify(trunc.target)}`);
    check(`eligible count is unchanged by truncation — ${label}`,
      full.eligible === trunc.eligible, `${full.eligible} vs ${trunc.eligible}`);
  }

  const a = bookAt(ctx.series, lastI, ctx.ihsgClose, ctx.ihsgSma);
  const c = bookAt(ctx.series, lastI, ctx.ihsgClose, ctx.ihsgSma);
  check('targetBook is deterministic', JSON.stringify(a.target) === JSON.stringify(c.target));

  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
