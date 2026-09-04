'use strict';
/**
 * Record IDX 1-minute bars, because in seven days they are gone.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * NOT an order book. NOT footprint. NOT order flow. It has no bid, no ask, no
 * depth and no trade direction, so it cannot answer the question that motivated
 * it -- whether a level holds because large resting orders defend it.
 *
 * That question needs L2 data, and for IDX there is no legitimate route to it
 * here. Checked 2026-09-05: Yahoo's v7 quote endpoint (which once carried
 * bid/ask) returns `Unauthorized`, and the chart endpoint carries OHLCV only.
 * Live depth exists inside broker platforms -- Stockbit, IPOT, Mirae -- as part
 * of an account, with no API and no archive. Historical IDX tick or book data is
 * an enterprise licence, not something bought retail.
 *
 * ── SO WHY BUILD IT ──────────────────────────────────────────────────────────
 *
 * Because 1-minute bars are the finest granularity legitimately reachable, and
 * **Yahoo discards them after seven days.** Verified: `range=7d` returns 3,045
 * bars for BBCA.JK, `range=1mo` is refused outright. Nobody sells IDX minute
 * history retail either. So every session not captured this week is lost for
 * good, and the clock only starts when something writes them down.
 *
 * What a minute bar does buy, that a daily bar cannot: where inside the session
 * volume actually happened, how much of the daily range was built in the first
 * and last thirty minutes, whether a level was touched once or twenty times, and
 * how the close behaved against the rest of the day. None of that is order flow;
 * all of it is currently invisible to every experiment in this project.
 *
 * ── THE HONEST ARITHMETIC ────────────────────────────────────────────────────
 *
 * At the 20-session horizon this project tests, 30 non-overlapping anchors needs
 * about 600 sessions -- roughly **2.4 years** of recording before anything built
 * on this can clear Promotion Contract v1 S1. That is the real cost, and it is
 * time rather than money. Starting today is the only thing that shortens it.
 *
 * The 7-day lookback is deliberate redundancy: a run may be missed for up to six
 * days and the gap still fills itself on the next successful run.
 *
 * Usage:
 *   node scraper/record_intraday_1m.js --create        # table only
 *   node scraper/record_intraday_1m.js                 # default universe
 *   node scraper/record_intraday_1m.js --limit 600
 *   node scraper/record_intraday_1m.js --only BBCA,TLKM
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { createPool } = require('./modules/db_config');
const https = require('https');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CREATE_ONLY = argv.includes('--create');
const ONLY = arg('--only', null);
const LIMIT = Number(arg('--limit', 300));
const RANGE = arg('--range', '7d');
const DELAY_MS = Number(arg('--delay', 700));
const MIN_VALUE = Number(arg('--min-value', 1e9));   // Rp/day median over the screen window
const CHUNK = 2000;
const PARTIAL_MS = 120000;   // a bar younger than this has not closed
// Exit non-zero when this share of the universe fails. A recorder scheduled to
// run unattended for two years must not fail silently: cron only notices a
// non-zero exit, and a run that fetched 40 of 380 tickers is a broken run that
// would otherwise log cheerfully and be discovered as a hole in the data years
// later. Set --fail-threshold 1 to disable.
const FAIL_THRESHOLD = Number(arg('--fail-threshold', 0.25));

const DDL = `
CREATE TABLE IF NOT EXISTS idx_intraday_1m (
  stock_code VARCHAR(10) NOT NULL,
  ts DATETIME NOT NULL COMMENT 'UTC. IDX 09:00-16:15 WIB = 02:00-09:15 UTC',
  open_price DECIMAL(12,2) NULL,
  high_price DECIMAL(12,2) NULL,
  low_price DECIMAL(12,2) NULL,
  close_price DECIMAL(12,2) NULL,
  volume BIGINT NOT NULL DEFAULT 0,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (stock_code, ts),
  KEY idx_ts (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Yahoo 1m for one symbol. `fetchYahooCandles` collapses to a date string and
 * rounds prices, so neither is usable here -- a minute recorder needs the
 * minute, and IDX prices are whole rupiah but the rounding path is the one that
 * silently destroyed us_stock_prices, so this keeps its own parser.
 */
function fetchMinuteBars(code, range) {
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${code.toUpperCase()}.JK?interval=1m&range=${range}`,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
        Referer: 'https://finance.yahoo.com',
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          const r = j?.chart?.result?.[0];
          if (!r) return reject(new Error(j?.chart?.error?.description || 'no result'));
          const ts = r.timestamp || [];
          const q = r.indicators?.quote?.[0] || {};
          const now = Date.now();
          let partial = 0;
          const bars = [];
          for (let i = 0; i < ts.length; i++) {
            const close = q.close?.[i];
            // Yahoo pads the grid with nulls for minutes that did not trade.
            // A null is not a zero and must not be written as one.
            if (close === null || close === undefined || !(close > 0)) continue;
            const ms = ts[i] * 1000;
            // The running bar has a partial volume and a close that is just the
            // last print. deep_analysis.js learned this the hard way; the same
            // rule applies here. Upsert repairs it tomorrow regardless.
            if (now - ms < PARTIAL_MS) { partial++; continue; }
            bars.push({
              ts: new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
              o: q.open?.[i] ?? null, h: q.high?.[i] ?? null,
              l: q.low?.[i] ?? null, c: close, v: q.volume?.[i] ?? 0,
            });
          }
          resolve({ bars, partial });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

(async () => {
  const pool = createPool();
  await pool.query(DDL);
  console.log('idx_intraday_1m ready');
  if (CREATE_ONLY) { await pool.end(); return; }

  console.log('Recording IDX 1-minute bars.');
  console.log('  NOT an order book: no bid, no ask, no depth, no trade direction.');
  console.log(`  Yahoo discards these after 7 days (range=1mo is refused), so a session not`);
  console.log('  captured this week is lost permanently. That is the whole reason this exists.');
  console.log(`  range=${RANGE} gives redundancy: up to six missed runs still self-heal.\n`);

  let tickers;
  if (ONLY) {
    tickers = ONLY.split(',').map(s => s.trim().toUpperCase());
  } else {
    const [uni] = await pool.query(`
      SELECT stock_code, AVG(close_price * volume) val
        FROM idx_stock_prices
       WHERE date >= DATE_SUB((SELECT MAX(date) FROM idx_stock_prices), INTERVAL 60 DAY)
         AND close_price > 0 AND volume > 0
       GROUP BY stock_code HAVING val >= ? ORDER BY val DESC LIMIT ?`, [MIN_VALUE, LIMIT]);
    tickers = uni.map(r => r.stock_code);
    console.log(`universe: ${tickers.length} names with >= Rp ${(MIN_VALUE / 1e9).toFixed(1)}bn ` +
      `average daily value over the last 60 sessions (cap ${LIMIT})`);
  }

  const t0 = Date.now();
  let ok = 0, failed = 0, rows = 0, partialDropped = 0;
  const failures = [];

  for (let i = 0; i < tickers.length; i++) {
    const code = tickers[i];
    let res = null, err = null;
    for (let attempt = 1; attempt <= 3 && !res; attempt++) {
      try { res = await fetchMinuteBars(code, RANGE); }
      catch (e) { err = e; await sleep(DELAY_MS * attempt * 2); }
    }
    if (!res || !res.bars.length) {
      failed++;
      failures.push(`${code}: ${err ? err.message : 'no bars'}`);
      await sleep(DELAY_MS);
      continue;
    }
    partialDropped += res.partial;
    const values = res.bars.map(b => [code, b.ts, b.o, b.h, b.l, b.c, b.v]);
    for (let k = 0; k < values.length; k += CHUNK) {
      await pool.query(
        `INSERT INTO idx_intraday_1m (stock_code, ts, open_price, high_price, low_price, close_price, volume)
         VALUES ? ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
           low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume)`,
        [values.slice(k, k + CHUNK)]);
    }
    rows += values.length;
    ok++;
    if (ok % 50 === 0) {
      console.log(`  ${String(i + 1).padStart(3)}/${tickers.length} ${code.padEnd(6)} ` +
        `${String(values.length).padStart(5)} bars   total ${rows}   ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    await sleep(DELAY_MS);
  }

  const [[sum]] = await pool.query(
    `SELECT COUNT(*) n, COUNT(DISTINCT stock_code) tk, COUNT(DISTINCT DATE(ts)) sessions,
            MIN(ts) mn, MAX(ts) mx FROM idx_intraday_1m`);
  console.log(`\n${'='.repeat(72)}`);
  console.log(`fetched ${ok}, failed ${failed}, rows upserted ${rows}, running bars dropped ${partialDropped}`);
  console.log(`table: ${sum.n} rows, ${sum.tk} tickers, ${sum.sessions} distinct sessions`);
  console.log(`       ${sum.mn ? sum.mn.toISOString().slice(0, 16).replace('T', ' ') : '?'} .. ` +
    `${sum.mx ? sum.mx.toISOString().slice(0, 16).replace('T', ' ') : '?'} UTC`);
  const need = 600;
  console.log(`\nsessions recorded: ${sum.sessions} of the ~${need} needed for 30 non-overlapping`);
  console.log(`20-session anchors (Promotion Contract v1 S1). At ~21 sessions a month that is`);
  console.log(`about ${Math.max(0, ((need - sum.sessions) / 21)).toFixed(1)} more months of recording.`);
  if (failures.length) {
    console.log(`\nFAILED (${failures.length}):`);
    for (const f of failures.slice(0, 15)) console.log(`  ${f}`);
    if (failures.length > 15) console.log(`  ... and ${failures.length - 15} more`);
  }
  console.log(`\nelapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  await pool.end();

  const attempted = ok + failed;
  const rate = attempted ? failed / attempted : 0;
  if (attempted && rate > FAIL_THRESHOLD) {
    console.error(`
EXIT 1: ${failed}/${attempted} tickers failed (${(rate * 100).toFixed(1)}%), ` +
      `over the ${(FAIL_THRESHOLD * 100).toFixed(0)}% threshold. Treat this run as broken.`);
    process.exit(1);
  }
})().catch(e => { console.error(e.stack || e.message); process.exit(1); });
