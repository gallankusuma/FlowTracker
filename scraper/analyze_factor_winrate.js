/**
 * For each of the 14 AWO factors, split live-tracked signals into
 * "strong" (factor score > 50) vs "weak" (<=50) and compute the win rate of
 * each bucket, to answer: which individual factors, when high, actually
 * correlate with good outcomes — the same question the user is asking from
 * eyeballing today's closes vs signals, generalized across all factors.
 *
 * Uses idx_signal_history WHERE data_source='live' only (the 885 'backfill'
 * rows were flagged contaminated during the 2026-07-19 overfitting incident —
 * see project memory — so they're excluded here to keep this clean).
 *
 * "Good outcome" reported two ways per the user's own framing (neutral-to-profit
 * counts as fine, not just strict wins):
 *   - winRateStrict = WIN / (WIN+LOSS)              (NEUTRAL excluded)
 *   - winRateLoose  = (WIN+NEUTRAL) / (WIN+LOSS+NEUTRAL)  ("neutral hingga profit")
 *
 * Usage: node analyze_factor_winrate.js
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

const FACTORS = [
  { col: 'f1_concentration',        label: 'F1 Smart Money' },
  { col: 'f2_trend',                label: 'F2 Trend Consistency' },
  { col: 'f3_volume_z',             label: 'F3 Volume Z-Score' },
  { col: 'f4_momentum',             label: 'F4 Price Momentum' },
  { col: 'f5_rel_strength',         label: 'F5 Rel. Strength' },
  { col: 'f6_breadth',              label: 'F6 Buyer Breadth' },
  { col: 'f7_alignment',            label: 'F7 Price-Broker' },
  { col: 'f8_streak',               label: 'F8 Accum Streak' },
  { col: 'f9_rsi',                  label: 'F9 RSI' },
  { col: 'f10_macd',                label: 'F10 MACD' },
  { col: 'f11_bollinger',           label: 'F11 Bollinger %B' },
  { col: 'f12_ema_trend',           label: 'F12 EMA Trend' },
  { col: 'f13_support_resistance',  label: 'F13 Support/Resistance' },
  { col: 'f14_atr',                 label: 'F14 ATR (Volatility)' },
];

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });

  const [rows] = await pool.query(
    `SELECT ${FACTORS.map(f => f.col).join(', ')}, outcome
     FROM idx_signal_history
     WHERE data_source = 'live' AND outcome IS NOT NULL`
  );
  console.log(`Live, outcome-resolved signals: ${rows.length}\n`);

  const results = [];
  for (const f of FACTORS) {
    const strong = rows.filter(r => Number(r[f.col]) > 50);
    const weak = rows.filter(r => Number(r[f.col]) <= 50);

    function stats(arr) {
      const win = arr.filter(r => r.outcome === 'WIN').length;
      const loss = arr.filter(r => r.outcome === 'LOSS').length;
      const neutral = arr.filter(r => r.outcome === 'NEUTRAL').length;
      const decided = win + loss;
      const total = win + loss + neutral;
      return {
        n: arr.length,
        winRateStrict: decided > 0 ? (win / decided * 100) : null,
        winRateLoose: total > 0 ? ((win + neutral) / total * 100) : null,
      };
    }

    results.push({ label: f.label, strong: stats(strong), weak: stats(weak) });
  }

  results.sort((a, b) => (b.strong.winRateLoose ?? 0) - (a.strong.winRateLoose ?? 0));

  console.log('Ranked by win rate when factor is STRONG (score > 50), "neutral-to-profit" counted as good:\n');
  console.log('Factor'.padEnd(26) + 'n(strong)'.padStart(10) + '  WR-loose  WR-strict  |  n(weak)'.padStart(10) + '  WR-loose  WR-strict');
  for (const r of results) {
    const s = r.strong, w = r.weak;
    console.log(
      r.label.padEnd(26) +
      String(s.n).padStart(10) + '  ' +
      (s.winRateLoose !== null ? s.winRateLoose.toFixed(1) + '%' : 'n/a').padStart(7) + '   ' +
      (s.winRateStrict !== null ? s.winRateStrict.toFixed(1) + '%' : 'n/a').padStart(7) + '   |' +
      String(w.n).padStart(9) + '  ' +
      (w.winRateLoose !== null ? w.winRateLoose.toFixed(1) + '%' : 'n/a').padStart(7) + '   ' +
      (w.winRateStrict !== null ? w.winRateStrict.toFixed(1) + '%' : 'n/a').padStart(7)
    );
  }

  console.log('\nLift (strong winRateLoose − weak winRateLoose), sorted:');
  const lifts = results.map(r => ({ label: r.label, lift: (r.strong.winRateLoose ?? 0) - (r.weak.winRateLoose ?? 0), nStrong: r.strong.n, nWeak: r.weak.n }));
  lifts.sort((a, b) => b.lift - a.lift);
  for (const l of lifts) {
    console.log(`  ${l.label.padEnd(26)} lift=${l.lift >= 0 ? '+' : ''}${l.lift.toFixed(1)}pp  (n strong=${l.nStrong}, n weak=${l.nWeak})`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
