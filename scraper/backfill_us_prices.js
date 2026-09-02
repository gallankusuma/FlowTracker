'use strict';
/**
 * Deep-backfill `us_stock_prices` from Yahoo.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Two problems, one fix.
 *
 * 1. DEPTH. The table held 2026-01-26 .. 2026-08-31 — about 150 sessions, the
 *    same shallow window that just made EXP-042 unresolvable on IDX. At a
 *    10-session horizon 150 sessions give ~15 non-overlapping anchors against
 *    Promotion Contract v1's bar of 30. The whole argument for building a US
 *    layer is that US history is deep enough to power the tests IDX cannot, and
 *    that argument is worth nothing until the history is actually here.
 *
 * 2. PRECISION. `refreshUSStockPrices()` moved onto `yahoo-candles.js`'s fetcher
 *    around 2026-07, and that fetcher rounds prices to whole units because IDX
 *    quotes whole rupiah. Every US row from 2026-08 onward is a whole dollar:
 *    AAPL stored as 317, not 317.42. Measured before this ran: 2.0% of rows had
 *    a whole-dollar close through June (the natural rate), 46% in July, 100% in
 *    August.
 *
 * Because this upserts, the deep fetch REPAIRS the rounded rows as a side
 * effect — Yahoo returns the true prices for those same dates. Fixing the
 * fetcher without rewriting the damaged rows would have left the corruption
 * frozen in place, and it sits inside the most recent window, which is the part
 * every scanner reads.
 *
 * ── WHAT THIS DOES NOT FIX ───────────────────────────────────────────────────
 *
 * SURVIVORSHIP. `modules/us_tickers.js` is a present-day S&P 500 snapshot, and
 * Yahoo does not serve delisted symbols. Backfilling 20 years of today's index
 * members reconstructs a universe that excludes, by construction, every company
 * that failed or was acquired out of the index. That biases every backward
 * result upward and no amount of history repairs it — exactly the defect the
 * IDX side carries from `backfill_price_history.js`. Anything built on this
 * table inherits the banner.
 *
 * Usage:
 *   node scraper/backfill_us_prices.js                 # 20y, all tickers
 *   node scraper/backfill_us_prices.js --range 10y
 *   node scraper/backfill_us_prices.js --only AAPL,MSFT
 *   node scraper/backfill_us_prices.js --resume        # skip tickers already deep
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createPool } = require('./modules/db_config');
const { fetchYahooCandles } = require('./yahoo-candles');
const { US_TICKERS } = require('./modules/us_tickers');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const RANGE = arg('--range', '20y');
const ONLY = arg('--only', null);
const RESUME = argv.includes('--resume');
const DELAY_MS = Number(arg('--delay', 900));      // Yahoo throttles; be polite
const CHUNK = 1000;                                 // rows per INSERT
const DEEP_ENOUGH = 2000;                           // sessions that count as "already backfilled"
const MAX_RETRY = 3;

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const pool = createPool();
  const tickers = ONLY ? ONLY.split(',').map(s => s.trim().toUpperCase()) : US_TICKERS;

  console.log('Deep-backfill us_stock_prices');
  console.log(`  range=${RANGE}  tickers=${tickers.length}  delay=${DELAY_MS}ms  resume=${RESUME}`);
  console.log('  prices are fetched with roundPrices:false — US equities are quoted in cents');
  console.log('  SURVIVORSHIP: today\'s S&P 500 members projected backwards. Biased upward. Stated, not fixed.');

  const [[before]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT ticker) tk, MIN(date) mn, MAX(date) mx,
            SUM(close_price = ROUND(close_price)) whole FROM us_stock_prices`);
  console.log(`  before: ${before.n} rows, ${before.tk} tickers, ${before.mn && before.mn.toISOString().slice(0, 10)} .. ` +
    `${before.mx && before.mx.toISOString().slice(0, 10)}, ${before.whole} whole-unit closes\n`);

  let deep = new Set();
  if (RESUME) {
    const [rows] = await pool.query(
      'SELECT ticker FROM us_stock_prices GROUP BY ticker HAVING COUNT(*) >= ?', [DEEP_ENOUGH]);
    deep = new Set(rows.map(r => r.ticker));
    console.log(`  resume: skipping ${deep.size} tickers already at >= ${DEEP_ENOUGH} sessions\n`);
  }

  let ok = 0, skipped = 0, failed = 0, written = 0;
  const failures = [];

  for (let n = 0; n < tickers.length; n++) {
    const ticker = tickers[n];
    if (deep.has(ticker)) { skipped++; continue; }

    let candles = null, lastErr = null;
    for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
      try {
        const r = await fetchYahooCandles(ticker, RANGE, '', { roundPrices: false });
        candles = r.candles;
        break;
      } catch (e) {
        lastErr = e;
        // Back off on throttling rather than hammering — a 429 answered
        // immediately just earns a longer ban.
        await sleep(DELAY_MS * attempt * 3);
      }
    }

    if (!candles || !candles.length) {
      failed++;
      failures.push(`${ticker}: ${lastErr ? lastErr.message : 'no candles'}`);
      console.log(`  [${n + 1}/${tickers.length}] ${ticker.padEnd(6)} FAILED — ${lastErr ? lastErr.message : 'no candles'}`);
      await sleep(DELAY_MS);
      continue;
    }

    // change_pct across the WHOLE fetched series. The live 5-day refresh can
    // only ever see four predecessors, so its first bar of each window gets 0;
    // computing it here over the full history fixes those too.
    const values = candles.map((c, i) => {
      const prev = i > 0 ? candles[i - 1].close : null;
      const chg = prev > 0 ? ((c.close - prev) / prev) * 100 : 0;
      return [ticker, c.date, c.open, c.high, c.low, c.close, c.volume, Math.round(chg * 1e4) / 1e4];
    });

    for (let i = 0; i < values.length; i += CHUNK) {
      await pool.query(
        `INSERT INTO us_stock_prices (ticker, date, open_price, high_price, low_price, close_price, volume, change_pct)
         VALUES ? ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
           low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume),
           change_pct=VALUES(change_pct)`,
        [values.slice(i, i + CHUNK)]);
    }
    written += values.length;
    ok++;
    if (ok % 25 === 0 || n === tickers.length - 1) {
      console.log(`  [${n + 1}/${tickers.length}] ${ticker.padEnd(6)} ${String(values.length).padStart(5)} bars ` +
        `${candles[0].date} .. ${candles[candles.length - 1].date}   (ok ${ok}, failed ${failed}, rows ${written})`);
    }
    await sleep(DELAY_MS);
  }

  const [[after]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT ticker) tk, MIN(date) mn, MAX(date) mx,
            COUNT(DISTINCT date) sessions, SUM(close_price = ROUND(close_price)) whole FROM us_stock_prices`);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`fetched ${ok}, skipped ${skipped}, failed ${failed}, rows written ${written}`);
  console.log(`after: ${after.n} rows, ${after.tk} tickers, ${after.sessions} distinct sessions`);
  console.log(`       ${after.mn && after.mn.toISOString().slice(0, 10)} .. ${after.mx && after.mx.toISOString().slice(0, 10)}`);
  console.log(`       ${after.whole} whole-unit closes (was ${before.whole}) — the residue is genuine round closes`);
  console.log(`anchors now available at a 10-session horizon: ~${Math.floor(after.sessions / 10)} (S1 needs >= 30)`);
  if (failures.length) {
    console.log(`\nFAILED TICKERS (${failures.length}) — these are almost always renamed or delisted symbols:`);
    for (const f of failures) console.log(`  ${f}`);
  }
  await pool.end();
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
