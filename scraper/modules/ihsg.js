/**
 * IHSG history refresh — the single implementation, used by both server.js and
 * the standalone nightly script.
 *
 * WHY THIS MODULE EXISTS (2026-08-04)
 * -----------------------------------
 * `fetchAndCacheIHSG()` lived inside server.js and had NO scheduled caller. It
 * ran only when someone hit /api/ihsg, /api/ihsg-factors, /api/signal-scanner
 * or POSTed /api/sectors/pull-broker — and none of the 18 cron entries calls an
 * HTTP endpoint. So the index series refreshed if and only if a human happened
 * to open a page.
 *
 * That matters more than it sounds. The 200-day SMA regime filter is the layer
 * this strategy leans on hardest, and modules/system_health.js marks a stale
 * `idx_ihsg_history` as CRITICAL for exactly that reason. Found stale by two
 * trading days while idx_stock_prices was current, because nobody visited the
 * dashboard on the Monday.
 *
 * THE PARTIAL-BAR GUARD
 * ---------------------
 * Yahoo returns the CURRENT session as a candle while it is still trading. The
 * old code wrote it straight in, so between 09:00 and 16:00 WIB the database
 * could hold a provisional close, and the SMA and the regime decision would read
 * it as final. It gets overwritten that evening, which makes the error
 * temporary and invisible rather than harmless. Any candle dated on a session
 * that has not closed yet is now dropped.
 */
'use strict';

/** IDX regular trading closes 16:00 WIB; 16:15 leaves room for the closing auction. */
const IDX_CLOSE_WIB_MINUTES = 16 * 60 + 15;
const WIB_OFFSET_MINUTES = 7 * 60;

/**
 * A date column as YYYY-MM-DD, whether the driver hands back a Date or a string.
 *
 * THE BUG THIS REPLACES, and it is the real reason the series went stale. The
 * original code did `String(latestRow.d).split('T')[0]`, which on a Date object
 * yields "Fri Jul 31 2026 07:00:00 GM" — there is no 'T' to split on. It then
 * compared that against an ISO "2026-08-03". Every weekday name begins with a
 * letter, every letter sorts above every digit, so the comparison was TRUE for
 * any row that existed, on any date. `fetchAndCacheIHSG` therefore returned
 * `{ skipped: true }` every single time it was called, from the moment the table
 * had one row.
 *
 * So the diagnosis "it has no scheduled caller" was correct but incomplete: even
 * the on-request callers did nothing. The data present came from a manual
 * backfill run, which is exactly why the series stops on the day that ran.
 */
function toDateStr(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return String(d).slice(0, 10);
}

/** Today's date in WIB, and how far into that day we are, from a UTC instant. */
function wibNow(now = new Date()) {
  const shifted = new Date(now.getTime() + WIB_OFFSET_MINUTES * 60000);
  return {
    date: shifted.toISOString().slice(0, 10),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * Drop any candle for a session that has not finished.
 *
 * Deliberately conservative: a bar is kept only once the WIB day it belongs to
 * is over, or is today AND the close has passed. Dropping a real bar costs one
 * day of lag that the next run fixes; keeping a provisional one puts a number
 * that is not a closing price into the series the regime filter reads.
 */
function dropUnclosedSession(candles, now = new Date()) {
  const { date: today, minutes } = wibNow(now);
  const sessionOver = minutes >= IDX_CLOSE_WIB_MINUTES;
  return candles.filter(c => {
    const d = String(c.date).slice(0, 10);
    if (d < today) return true;
    if (d > today) return false;          // never trust a future-dated bar
    return sessionOver;
  });
}

/**
 * Refresh idx_ihsg_history from Yahoo.
 *
 * @param {import('mysql2/promise').Pool} pool
 * @param {(ticker: string, range: string, suffix?: string) => Promise<{candles: Array}>} fetchCandles
 * @param {{ now?: Date, force?: boolean, range?: string }} [opts]
 */
async function refreshIHSG(pool, fetchCandles, opts = {}) {
  const now = opts.now || new Date();
  const range = opts.range || '2y';

  const [[latestRow]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const latest = toDateStr(latestRow?.d);

  // Skip only when the series already reaches the last CLOSED session. The old
  // guard compared against "yesterday" by wall-clock, which on a Monday morning
  // meant Sunday — so a Friday-latest series looked stale enough to refetch but
  // a Saturday-latest one did not, for reasons unrelated to trading.
  const { date: today, minutes } = wibNow(now);
  const lastClosed = minutes >= IDX_CLOSE_WIB_MINUTES ? today : null;

  // A HOLE BEHIND THE LATEST BAR MUST DEFEAT THE SKIP.
  //
  // Found live 2026-08-04: the series held 2026-08-04 but not 2026-08-03. Every
  // freshness check measures MAX(date) and stayed green, and this guard — which
  // only asks whether MAX(date) has reached the last closed session — refused to
  // refetch. The hole was therefore PERMANENT: no scheduled run would ever look
  // at it again, and the 200-day SMA the regime filter reads was averaging a
  // window with a session missing from it.
  //
  // So the guard now asks a second question. Missing sessions are proven against
  // idx_stock_prices, not guessed, and one refetch of the full range fills them
  // because the upsert is keyed on date.
  let gaps = { missing: [] };
  if (!opts.skipGapCheck) {
    try {
      gaps = await require('./system_health').missingSessions(pool, {
        table: 'idx_ihsg_history', col: 'date', days: opts.gapWindowDays || 260,
      });
    } catch { /* a gap check that cannot run must not block the refresh */ }
  }

  if (!opts.force && !gaps.missing.length && latest && lastClosed && latest >= lastClosed) {
    return { skipped: true, reason: 'already current through the last closed session', latest };
  }

  const { candles } = await fetchCandles('^JKSE', range, '');
  if (!candles || !candles.length) return { skipped: true, reason: 'no data from Yahoo', latest };

  const usable = dropUnclosedSession(candles, now);
  const dropped = candles.length - usable.length;
  if (!usable.length) return { skipped: true, reason: 'every candle belongs to an unclosed session', latest, dropped };

  const values = [];
  for (let i = 0; i < usable.length; i++) {
    const c = usable[i];
    const prevClose = i > 0 ? usable[i - 1].close : c.close;
    const changePct = prevClose > 0 ? ((c.close - prevClose) / prevClose) * 100 : 0;
    values.push([c.date, c.open, c.high, c.low, c.close, c.volume, Math.round(changePct * 10000) / 10000]);
  }
  const [result] = await pool.query(
    `INSERT INTO idx_ihsg_history (date, open_price, high_price, low_price, close_price, volume, change_pct)
     VALUES ?
     ON DUPLICATE KEY UPDATE open_price=VALUES(open_price), high_price=VALUES(high_price),
       low_price=VALUES(low_price), close_price=VALUES(close_price), volume=VALUES(volume), change_pct=VALUES(change_pct)`,
    [values]
  );
  const [[after]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');

  // Re-check, so the caller learns whether the refetch actually closed the
  // holes. A repair that reports success without verifying the thing it was
  // repairing is the failure mode this whole module exists to end.
  let gapsAfter = { missing: [] };
  if (gaps.missing.length) {
    try {
      gapsAfter = await require('./system_health').missingSessions(pool, {
        table: 'idx_ihsg_history', col: 'date', days: opts.gapWindowDays || 260,
      });
    } catch { /* ignore */ }
  }

  return {
    saved: result.affectedRows,
    candles: usable.length,
    dropped,
    latest: toDateStr(after?.d) || latest,
    previousLatest: latest,
    gapsBefore: gaps.missing,
    gapsRemaining: gapsAfter.missing,
    gapsFilled: gaps.missing.filter(d => !gapsAfter.missing.includes(d)),
    // The dates the SOURCE actually has. ^JKSE is the exchange's own index, so
    // this is the authoritative IDX trading calendar: no index bar, no session.
    // A caller can therefore tell a real index gap ("the source has this day and
    // we do not") from a date that was never a trading day at all — without
    // which the check reports the same unfixable holiday every night forever.
    sourceDates: usable.map(c => String(c.date).slice(0, 10)),
  };
}

module.exports = { refreshIHSG, dropUnclosedSession, wibNow, toDateStr, IDX_CLOSE_WIB_MINUTES };
