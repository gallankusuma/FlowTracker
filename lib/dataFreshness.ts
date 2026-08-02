/**
 * Detects whether broker-flow data (idx_broker_summary) shown in the UI is
 * older than what the 19:30 WIB daily cron should have already pulled.
 *
 * WIB has no DST, so a fixed UTC+7 offset is safe. Doesn't account for IDX
 * public holidays (only skips Sat/Sun) — worst case is an occasional false
 * "stale" warning on a market holiday, never a silent false negative.
 */

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
const CRON_HOUR_WIB = 19;
const CRON_MINUTE_WIB = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

function toWibShifted(utcMs: number): Date {
  return new Date(utcMs + WIB_OFFSET_MS);
}

function isWeekend(wibShifted: Date): boolean {
  const day = wibShifted.getUTCDay();
  return day === 0 || day === 6;
}

function toDateStr(wibShifted: Date): string {
  const y = wibShifted.getUTCFullYear();
  const m = String(wibShifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(wibShifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Most recent trading date (YYYY-MM-DD, WIB) that should already be pulled. */
export function getExpectedLatestTradingDateWIB(referenceUtcMs: number = Date.now()): string {
  let cursor = toWibShifted(referenceUtcMs);

  const pastCutoffToday =
    cursor.getUTCHours() > CRON_HOUR_WIB ||
    (cursor.getUTCHours() === CRON_HOUR_WIB && cursor.getUTCMinutes() >= CRON_MINUTE_WIB);

  if (!isWeekend(cursor) && pastCutoffToday) {
    return toDateStr(cursor);
  }

  do {
    cursor = new Date(cursor.getTime() - DAY_MS);
  } while (isWeekend(cursor));

  return toDateStr(cursor);
}

export interface DataFreshness {
  stale: boolean;
  actual: string | null;
  expected: string;
}

export function checkDataFreshness(
  d0: string | null | undefined,
  referenceUtcMs: number = Date.now()
): DataFreshness {
  const expected = getExpectedLatestTradingDateWIB(referenceUtcMs);
  if (!d0) return { stale: false, actual: null, expected };

  const actual = d0.split('T')[0];
  return { stale: actual < expected, actual, expected };
}
