/**
 * When does the strategy come back?
 *
 * Re-entry needs IHSG close > its own 200-session SMA. Today that is 6402 vs
 * 7472, a 16.7% gap — which sounds hopeless until you notice the SMA is FALLING
 * fast, because the window is still rolling off the 8000–8600 prints from
 * Sep 2025 – Feb 2026. The gap closes from both ends.
 *
 * So this projects the SMA forward under flat prices (the deliberately
 * pessimistic case: no recovery at all) and reports the crossing date. It also
 * reports what price today would be needed to cross on each future date, which
 * is the version a person can actually watch for.
 *
 * Projection only. No new information about the future is being claimed — this
 * is arithmetic on prints that already exist.
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
  const P = sb.DEFAULTS.regimeSma;
  const sma = sb.smaSeries(closes, P);
  const n = closes.length;
  const last = closes[n - 1], lastSma = sma[n - 1];

  console.log('today  ' + dates[n - 1] + '  close ' + last + '  sma200 ' + lastSma.toFixed(0) +
    '  gap ' + ((last / lastSma - 1) * 100).toFixed(1) + '%');
  console.log('drawdown from the 2025-12 peak: ' + ((last / Math.max(...closes.slice(-260)) - 1) * 100).toFixed(1) + '%');

  // What rolls OUT of the window over the next months — this is the engine of
  // the SMA's decline and it is already fully determined.
  console.log('\nwhat the SMA is still carrying (about to roll off):');
  for (let k = 0; k < 6; k++) {
    const idx = n - P + k * 21;
    if (idx < 0 || idx >= n) continue;
    console.log('  rolls off in ~' + String(k * 21).padStart(3) + ' sessions: ' + dates[idx] + '  close ' + closes[idx]);
  }

  // Flat-price projection: assume every future close equals today's.
  const proj = closes.slice();
  let crossAt = null;
  for (let step = 1; step <= 300; step++) {
    proj.push(last);
    const m = proj.length;
    let run = 0;
    for (let j = m - P; j < m; j++) run += proj[j];
    const s = run / P;
    if (last > s) { crossAt = { step, sma: s }; break; }
  }
  console.log('\nFLAT-PRICE PROJECTION (price frozen at ' + last + ', the pessimistic case)');
  if (crossAt) {
    console.log('  crosses back above the SMA in ~' + crossAt.step + ' trading sessions' +
      '  (~' + (crossAt.step / 21).toFixed(1) + ' months), SMA then ' + crossAt.sma.toFixed(0));
  } else {
    console.log('  does NOT cross within 300 sessions at a flat price');
  }

  // The watchable version: what close is needed on each horizon.
  console.log('\nWHAT IT WOULD TAKE — close needed to be ABOVE the SMA at each horizon');
  console.log('  sessions ahead   ~date offset   SMA if price stays flat   close needed   move from today');
  for (const h of [0, 21, 42, 63, 84, 126]) {
    const p2 = closes.slice();
    for (let k = 0; k < h; k++) p2.push(last);
    const m = p2.length;
    let run = 0;
    for (let j = m - P; j < m; j++) run += p2[j];
    const s = run / P;
    console.log('  ' + String(h).padStart(14) + '   ' + String('~' + (h / 21).toFixed(0) + ' months').padStart(12) +
      '   ' + s.toFixed(0).padStart(22) + '   ' + s.toFixed(0).padStart(12) + '   ' +
      ((s / last - 1) * 100).toFixed(1).padStart(13) + '%');
  }

  // How long have past stand-asides lasted? Sets an expectation for this one.
  console.log('\nPAST STAND-ASIDE SPELLS (consecutive sessions below the SMA)');
  const spells = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (sma[i] === null) continue;
    const below = !(closes[i] > sma[i]);
    if (below && start < 0) start = i;
    if (!below && start >= 0) { spells.push({ from: dates[start], to: dates[i - 1], len: i - start }); start = -1; }
  }
  if (start >= 0) spells.push({ from: dates[start], to: dates[n - 1], len: n - start, ongoing: true });
  spells.sort((a, b) => b.len - a.len);
  for (const s of spells.slice(0, 6)) {
    console.log('  ' + s.from + ' .. ' + s.to + '  ' + String(s.len).padStart(4) + ' sessions' + (s.ongoing ? '   <-- ONGOING' : ''));
  }
  console.log('  total spells: ' + spells.length + ', median length ' +
    spells.map(s => s.len).sort((a, b) => a - b)[spells.length >> 1] + ' sessions');

  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
