/**
 * Why has exposure been 0 since April 2026?
 *
 * `exposure = belowSma ? 0 : 1` — one binary switch on IHSG close vs its own
 * 200-day SMA. So there are only three possible answers and they need very
 * different responses:
 *
 *   a) the market really is below its 200d SMA — the filter is doing its job
 *   b) idx_ihsg_history is stale, gappy or wrong — a data fault wearing the
 *      costume of a market call
 *   c) the SMA is computed over a series with holes, so it is not a 200-SESSION
 *      average at all
 *
 * Prints the raw series so the answer is readable rather than asserted.
 */
// Loaded from the scraper root, not the cwd. Without the explicit path
// dotenv finds nothing here and db_config falls back to its defaults --
// which connects as the OLD shared erp_user with no password and fails
// with a confusing 'Access denied' instead of saying the .env was missed.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createPool } = require('../modules/db_config');
const sb = require('../modules/strategy_book');

const toDateStr = d => d instanceof Date
  ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  : String(d).split('T')[0];

(async () => {
  const pool = createPool();
  const [rows] = await pool.query('SELECT date, close_price FROM idx_ihsg_history ORDER BY date ASC');
  const dates = rows.map(r => toDateStr(r.date));
  const closes = rows.map(r => Number(r.close_price));
  const sma = sb.smaSeries(closes, sb.DEFAULTS.regimeSma);

  console.log('idx_ihsg_history: ' + rows.length + ' sessions, ' + dates[0] + ' .. ' + dates[dates.length - 1]);

  // (b) freshness and holes
  const [px] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  console.log('newest idx_stock_prices session: ' + toDateStr(px[0].d));
  let gaps = 0, worst = null;
  for (let i = 1; i < dates.length; i++) {
    const a = new Date(dates[i - 1]), b = new Date(dates[i]);
    const days = Math.round((b - a) / 86400000);
    if (days > 4) { gaps++; if (!worst || days > worst.days) worst = { from: dates[i - 1], to: dates[i], days }; }
  }
  console.log('calendar gaps > 4 days: ' + gaps + (worst ? '  (largest ' + worst.from + ' -> ' + worst.to + ', ' + worst.days + ' days)' : ''));

  // zero / null closes would drag the SMA without ever looking wrong
  const bad = closes.filter(c => !(c > 0)).length;
  console.log('non-positive closes: ' + bad);

  // (a) the actual series, monthly, from 2025
  console.log('\nlast trading day of each month — close vs 200d SMA');
  console.log('  date         close      sma200     gap%     regime');
  const seen = new Set();
  const monthEnd = [];
  for (let i = dates.length - 1; i >= 0; i--) {
    const m = dates[i].slice(0, 7);
    if (seen.has(m)) continue;
    seen.add(m); monthEnd.push(i);
    if (seen.size >= 20) break;
  }
  for (const i of monthEnd.reverse()) {
    if (sma[i] === null) continue;
    const gap = (closes[i] / sma[i] - 1) * 100;
    const reg = sb.marketRegime(closes, sma, i);
    console.log('  ' + dates[i] + '  ' + closes[i].toFixed(2).padStart(9) + '  ' + sma[i].toFixed(2).padStart(9) +
      '  ' + gap.toFixed(2).padStart(7) + '%  ' + (closes[i] > sma[i] ? 'ABOVE' : 'below') + '  ' + (reg || '-'));
  }

  // when exactly did it cross, and has it been continuous since?
  let lastAbove = -1;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (sma[i] !== null && closes[i] > sma[i]) { lastAbove = i; break; }
  }
  console.log('\nlast session ABOVE the 200d SMA: ' + (lastAbove < 0 ? 'never' : dates[lastAbove] +
    '  (' + (dates.length - 1 - lastAbove) + ' sessions ago)'));

  // how much of the whole sample sits below — is standing aside the normal state?
  let below = 0, total = 0;
  for (let i = 0; i < dates.length; i++) {
    if (sma[i] === null) continue;
    total++; if (!(closes[i] > sma[i])) below++;
  }
  console.log('share of all sessions below the SMA: ' + (100 * below / total).toFixed(1) + '% of ' + total);

  // and over the strategy window only
  const winStart = dates.indexOf('2024-04-03');
  let b2 = 0, t2 = 0;
  for (let i = winStart; i < dates.length; i++) {
    if (sma[i] === null) continue;
    t2++; if (!(closes[i] > sma[i])) b2++;
  }
  console.log('over the strategy window 2024-04-03 onward: ' + (100 * b2 / t2).toFixed(1) + '% of ' + t2 + ' sessions below');

  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
