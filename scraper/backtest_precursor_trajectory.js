/**
 * EXP-024 — do winners look different in the five sessions BEFORE they move?
 *
 * The question Pattern Replay was built to ask: take stocks that subsequently
 * rose, take controls from the SAME sessions, and compare their H-5..H-1 factor
 * trajectories. If F5 crossing 50 early is a precursor, it should show here.
 *
 * METHOD, and why each constraint is here rather than convenient:
 *
 *  - DATE-BLOCKED. Winners and controls are compared within the same session,
 *    never pooled across dates. Names on one day share IHSG regime, macro and
 *    liquidity; pooling them turns ~120 independent days into a fake N of
 *    thousands, which is how "N=2,000, p<0.01" gets reported for something that
 *    is really a hundred-ish observations.
 *  - COMPLETE WINDOWS ONLY. H-5..H-1 must be five consecutive canonical
 *    sessions with a snapshot for that ticker. A window with a hole describes a
 *    sequence that did not happen, and the sequence IS the claim.
 *  - CLEAN SOURCES ONLY. 'backfill' is the 885 contaminated rows from the
 *    2026-07-19 leakage incident.
 *  - NO LOOKAHEAD. Factors come from sessions strictly BEFORE the entry date;
 *    the outcome comes strictly after.
 *
 * EXPLORATORY / NOT PROMOTABLE. This measures association on a short history,
 * not edge. It cannot become a rule without out-of-sample confirmation.
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const stats = require('./modules/statistics');

const DB = { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'erp_user',
             password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'erp_manufacturing' };

const CLEAN = ['live', 'backfill_v2', 'backfill_v3_f5v1'];
const WIN_THRESHOLD = Number(process.argv.includes('--win') ? process.argv[process.argv.indexOf('--win') + 1] : 5);
const HORIZON = 5;          // forward sessions
const LOOKBACK = 5;         // H-5..H-1

const FACTORS = [
  ['f5_rel_strength', 'F5 RelStrength'], ['f1_concentration', 'F1 SmartMoney'],
  ['f2_trend', 'F2 Trend'], ['f4_momentum', 'F4 Momentum'],
  ['f3_volume_z', 'F3 VolumeZ'], ['f6_breadth', 'F6 Breadth'],
];

const iso = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : String(d).slice(0, 10));

(async () => {
  const pool = mysql.createPool({ ...DB, connectionLimit: 4 });

  const [calRows] = await pool.query('SELECT date FROM idx_ihsg_history ORDER BY date');
  const sessions = calRows.map(r => iso(r.date));
  const idxOf = new Map(sessions.map((d, i) => [d, i]));

  const [snapRows] = await pool.query(
    `SELECT data_date, stock_code, ${FACTORS.map(f => f[0]).join(', ')}
       FROM idx_signal_history WHERE data_source IN (?)`, [CLEAN]);
  const snap = new Map();
  for (const r of snapRows) snap.set(`${r.stock_code}|${iso(r.data_date)}`, r);

  const [pxRows] = await pool.query('SELECT stock_code, date, close_price FROM idx_stock_prices');
  const px = new Map();
  for (const r of pxRows) px.set(`${r.stock_code}|${iso(r.date)}`, Number(r.close_price));

  const tickers = [...new Set(snapRows.map(r => r.stock_code))];
  console.log(`sessions ${sessions.length} · tickers ${tickers.length} · snapshots ${snapRows.length}`);
  console.log(`winner = forward ${HORIZON}-session return >= +${WIN_THRESHOLD}%\n`);

  // Per session: split into winners/controls, then average each factor's
  // H-5..H-1 path WITHIN that session before combining across sessions.
  const perDate = [];
  for (let i = LOOKBACK; i < sessions.length - HORIZON; i++) {
    const entry = sessions[i], exit = sessions[i + HORIZON];
    const win = [], ctl = [];

    for (const t of tickers) {
      const p0 = px.get(`${t}|${entry}`), p1 = px.get(`${t}|${exit}`);
      if (!p0 || !p1) continue;
      // The window must be complete for THIS ticker: five consecutive sessions,
      // each with a clean snapshot.
      const path = [];
      let whole = true;
      for (let k = LOOKBACK; k >= 1; k--) {
        const s = snap.get(`${t}|${sessions[i - k]}`);
        if (!s) { whole = false; break; }
        path.push(s);
      }
      if (!whole) continue;
      const ret = ((p1 - p0) / p0) * 100;
      (ret >= WIN_THRESHOLD ? win : ctl).push(path);
    }
    if (win.length < 3 || ctl.length < 10) continue;   // too thin to compare
    perDate.push({ entry, win, ctl });
  }

  console.log(`comparable sessions: ${perDate.length}`);
  if (!perDate.length) { console.log('nothing to compare'); await pool.end(); return; }
  const totalWin = perDate.reduce((a, d) => a + d.win.length, 0);
  console.log(`winner observations ${totalWin} · control observations ${perDate.reduce((a, d) => a + d.ctl.length, 0)}`);
  console.log(`\nEffective N for significance is the SESSION count (${perDate.length}), not the observation count —`);
  console.log(`names on one day share regime, so they are not independent draws.\n`);

  const mean = xs => (xs.length ? stats.mean(xs) : null);
  const avgAt = (paths, col, k) => mean(paths.map(p => p[k]?.[col]).filter(v => v !== null && v !== undefined).map(Number));

  for (const [col, label] of FACTORS) {
    // Per session, winner-minus-control at each step; then average those
    // per-session differences. One vote per day.
    const diffs = [];       // diffs[k] = array of per-session differences
    for (let k = 0; k < LOOKBACK; k++) diffs.push([]);
    for (const d of perDate) {
      for (let k = 0; k < LOOKBACK; k++) {
        const w = avgAt(d.win, col, k), c = avgAt(d.ctl, col, k);
        if (w === null || c === null) continue;
        diffs[k].push(w - c);
      }
    }
    const line = diffs.map(a => {
      const m = mean(a);
      return m === null ? '   —  ' : (m >= 0 ? '+' : '') + m.toFixed(2).padStart(5);
    }).join(' ');
    // Sign consistency across sessions at H-1: how often winners were higher.
    const last = diffs[LOOKBACK - 1];
    const share = last.length ? (last.filter(v => v > 0).length / last.length) * 100 : 0;
    console.log(`${label.padEnd(16)} H-5..H-1  ${line}   |  winners higher at H-1 on ${share.toFixed(0)}% of sessions (n=${last.length})`);
  }

  // The specific hypothesis: does F5 cross 50 earlier for winners?
  console.log('\nF5 crossing 50 during H-5..H-1:');
  let wCross = 0, wTot = 0, cCross = 0, cTot = 0;
  for (const d of perDate) {
    for (const p of d.win) {
      const v = p.map(s => Number(s.f5_rel_strength)).filter(Number.isFinite);
      if (v.length === LOOKBACK) { wTot++; if (v[0] < 50 && v[v.length - 1] >= 50) wCross++; }
    }
    for (const p of d.ctl) {
      const v = p.map(s => Number(s.f5_rel_strength)).filter(Number.isFinite);
      if (v.length === LOOKBACK) { cTot++; if (v[0] < 50 && v[v.length - 1] >= 50) cCross++; }
    }
  }
  console.log(`  winners  ${wCross}/${wTot} (${wTot ? (wCross / wTot * 100).toFixed(1) : 0}%)`);
  console.log(`  controls ${cCross}/${cTot} (${cTot ? (cCross / cTot * 100).toFixed(1) : 0}%)`);

  console.log('\nEXPLORATORY / NOT PROMOTABLE — association on a short history, not edge.');
  await pool.end();
})().catch(e => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
