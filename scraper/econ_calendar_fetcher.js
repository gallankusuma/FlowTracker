'use strict';
/**
 * Economic calendar — actual, CONSENSUS and previous, per release.
 *
 * ── WHY THIS SOURCE AND NOT investing.com ────────────────────────────────────
 *
 * investing.com is the calendar everyone means, and it is closed to us:
 * `/economic-calendar/`, the `getCalendarFilteredData` AJAX endpoint, and even
 * `robots.txt` all return 403 from this box — Cloudflare blocks the datacenter
 * ASN outright — and their terms forbid automated collection regardless. Working
 * around that would be both fragile and against their rules.
 *
 * Nasdaq publishes the SAME feed, licensed from Fusion Media. That is not a
 * guess: the event descriptions Nasdaq returns still contain
 * `investing.com/academy/...` links. It needs no key and serves history.
 *
 * ── WHAT IS ACTUALLY NEW HERE, STATED HONESTLY ───────────────────────────────
 *
 * Not a macro predictor. EXP-030/031/032/033 tested four families and NOTHING
 * has ever survived correction in this project. One field is genuinely new:
 *
 *   CONSENSUS. FRED gives only the realised value. What moves a market is the
 *   SURPRISE -- actual minus what was expected -- and we have never had the
 *   expectation. A CPI print of 3.1% is bullish or bearish depending entirely on
 *   whether 3.0% or 3.2% was priced.
 *
 * Second: the RELEASE DATE. EXP-032 had to guess publication lags as constants
 * (CPI 18 days, PCE 32, rounded up, "when unsure, later") because FRED dates an
 * observation by the period it describes. This gives the real one.
 *
 * ── FOUR TRAPS IN THIS FEED, EACH FOUND BY LOOKING ───────────────────────────
 *
 * 1. EVERY ROW IS FILED ONE DAY LATE, AND THE CLOCK IS NOT WHAT IT SAYS.
 *    Two separate offsets, both verified against releases whose real schedule is
 *    public and fixed, not assumed:
 *
 *      DATE, +1 day. Three independent weekly anchors, unanimous:
 *        MBA Mortgage Applications  Wednesday 07:00 ET -> filed Thursday, 9/9
 *        Initial Jobless Claims     Thursday  08:30 ET -> filed Friday,   9/9
 *        Crude Oil Inventories      Wednesday 10:30 ET -> filed Thursday, 6/9
 *                                   (the 3 Fridays are holiday weeks, when EIA
 *                                    itself slips a day -- the exception proves
 *                                    the rule rather than breaking it)
 *      Monthly prints agree: December-2022 CPI, released 2023-01-12, is filed
 *      under 2023-01-13; December-2022 payrolls (223K), released 2023-01-06, is
 *      filed under 2023-01-07.
 *
 *      CLOCK, a FIXED GMT-4. The field is named `gmt` and is not GMT: it is
 *      Eastern *Daylight* time applied all year. NFIB is 06:00 ET year-round and
 *      prints 06:00 in August but 07:00 in November and January. So the printed
 *      clock equals ET in summer and runs an hour ahead of it in winter.
 *
 *    Neither offset is cosmetic. For an event study a one-day error puts the
 *    "before the release" close AFTER the release, which inverts the very thing
 *    being measured; and for Jakarta the hour decides whether a US print lands
 *    before or after the session that is supposed to react to it.
 *
 *    So the raw `feed_date`/`feed_time` are kept for audit, and the columns
 *    anything should actually read are `release_date`, `release_time_et` and
 *    `release_utc`, derived by `feedToRelease()` and pinned by named fixtures in
 *    test_econ_calendar.js.
 *
 * 2. MISSING VALUES ARRIVE AS `" "` OR `"&nbsp;"`, never as an absent field.
 *    Coerced with `Number(x) || 0` they become a consensus of ZERO -- a forecast
 *    of "no change" that nobody made, and the surprise computed against it would
 *    be pure fiction. They are stored NULL. This is the same missing-is-not-zero
 *    rule that has now bitten concentration, macro scoring and the UI.
 *
 * 3. ONE NAME CAN BE SEVERAL SERIES. On a US CPI day there are five rows at
 *    08:30 named CPI/Core CPI: month-on-month and year-on-year for each, plus
 *    index levels. `Existing Home Sales` appears twice at 10:00, once in
 *    millions and once as a percent change. Name plus time is NOT a key, so the
 *    row's position within its group is stored as `seq`. Row order was verified
 *    stable across repeated fetches of the same date before relying on it.
 *
 * 4. `fromdate`/`todate` ARE SILENTLY IGNORED. Passing them returns the default
 *    day with a 200. And the rows carry no date field at all, so a range
 *    response could not be attributed even if it worked. One request per day is
 *    not a choice.
 *
 * ── LIMITS, so nobody discovers them later as a surprise ─────────────────────
 *
 *   - NO INDONESIA. Twelve countries: US, UK, Euro Zone, Germany, Switzerland,
 *     Japan, China, India, Australia, Brazil, Russia, South Africa. For an
 *     IDX-only system that is the biggest gap in this dataset, and no local
 *     source fills it -- bps.go.id and idx.co.id are both WAF-blocked here.
 *   - HISTORY IS THINNER THAN TODAY. Recent days carry the full slate; older
 *     days carry fewer events. Measured per year rather than assumed -- see the
 *     coverage census the experiment depends on.
 *   - NO IMPORTANCE RATING. investing.com's one/two/three-bull rating is not in
 *     the licensed feed. "Important" has to be OUR definition, kept in
 *     modules/econ_events.js as an explicit list, not borrowed from the source.
 *
 * Usage:
 *   node econ_calendar_fetcher.js                    today and the last 7 days
 *   node econ_calendar_fetcher.js --days 30          the last 30 days
 *   node econ_calendar_fetcher.js --from 2023-01-01 --to 2026-08-21
 */

require('dotenv').config();
const { createPool } = require('./modules/db_config');

const API = 'https://api.nasdaq.com/api/calendar/economicevents';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const DELAY_MS = 500;          // per worker; see the pool size in main()

const sleep = ms => new Promise(r => setTimeout(r, ms));
const toISO = d => d.toISOString().slice(0, 10);

/** Every date from `from` to `to` inclusive. Weekends included -- releases happen on them. */
function dateRange(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); toISO(d) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(toISO(d));
  }
  return out;
}

/**
 * Turn a printed figure into a number plus its unit.
 *
 * Returns `{ value: null, unit: null }` for anything not measured. NEVER 0 --
 * see trap 2 above.
 */
function parseFigure(raw) {
  if (raw === null || raw === undefined) return { value: null, unit: null };
  const s = String(raw).replace(/&nbsp;/gi, ' ').replace(/,/g, '').trim();
  if (!s || s === '-' || s === '--') return { value: null, unit: null };

  const m = s.match(/^(-?\d*\.?\d+)\s*([%KMBT])?$/i);
  if (!m) return { value: null, unit: null };

  const value = parseFloat(m[1]);
  if (!Number.isFinite(value)) return { value: null, unit: null };
  return { value, unit: m[2] ? m[2].toUpperCase() : null };
}

/**
 * The unit of a row, taken from whichever of the three figures printed one.
 * `actual` first because it is the authoritative print; a blank consensus must
 * not decide the unit of a release that has one.
 */
function rowUnit(...figures) {
  for (const f of figures) if (f.unit) return f.unit;
  return null;
}

/**
 * Undo the feed's two offsets and return the real release instant.
 *
 * The feed files a row under (release date + 1 day) and prints its clock in a
 * FIXED GMT-4. Both are verified in test_econ_calendar.js against releases whose
 * schedule is public and unchanging, so this is a measured correction rather
 * than a guess:
 *
 *   feed 2023-01-13 09:30  ->  2023-01-12 13:30 UTC  ->  08:30 ET   (Dec-22 CPI)
 *   feed 2026-08-13 08:30  ->  2026-08-12 12:30 UTC  ->  08:30 ET   (a summer CPI)
 *   feed Thursday   08:00  ->  Wednesday     12:00 UTC ->  07:00 ET  (MBA weekly)
 *
 * Note the first two land on the SAME ET clock time from different printed
 * times -- which is exactly what a fixed GMT-4 does either side of a DST change,
 * and is the strongest single check that the rule is right.
 *
 * @returns {{releaseDate:string, releaseTimeEt:string|null, releaseUtc:Date|null}}
 *   releaseUtc is null when the row printed no time; the DATE correction still
 *   applies, because it is a filing-convention offset and has nothing to do with
 *   the clock.
 */
function feedToRelease(feedDate, feedTime) {
  const back = new Date(feedDate + 'T00:00:00Z');
  back.setUTCDate(back.getUTCDate() - 1);
  const releaseDate = back.toISOString().slice(0, 10);

  const m = /^(\d{1,2}):(\d{2})$/.exec(String(feedTime || '').trim());
  // The shape is not enough: Date.UTC happily rolls "99:99" over into 03:39 the
  // NEXT day, which would file a garbled row under a date nobody meant. Bad
  // input has to become no time, never a plausible one.
  const hh = m ? Number(m[1]) : null, mm = m ? Number(m[2]) : null;
  if (!m || hh > 23 || mm > 59) return { releaseDate, releaseTimeEt: null, releaseUtc: null };

  // GMT-4 -> UTC is +4h. The Date rolls over correctly on its own.
  const utc = new Date(Date.UTC(
    Number(releaseDate.slice(0, 4)), Number(releaseDate.slice(5, 7)) - 1,
    Number(releaseDate.slice(8, 10)), hh + 4, mm));

  // Real Eastern, DST and all -- so a winter row reads 08:30 like a summer one.
  const et = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(utc).reduce((a, p) => (a[p.type] = p.value, a), {});

  return {
    // The ET calendar date, which is what a US release belongs to. It can differ
    // from releaseDate only for rows printed between 00:00 and 00:59, i.e. Asian
    // sessions, where ET is still the previous evening.
    releaseDate: `${et.year}-${et.month}-${et.day}`,
    releaseTimeEt: `${et.hour === '24' ? '00' : et.hour}:${et.minute}`,
    releaseUtc: utc,
  };
}

/**
 * One day, with retries.
 *
 * The first unretried backfill lost 6 of its first 50 dates to transient
 * failures. That is not a 12% inconvenience -- a dropped date is indistinguish-
 * able downstream from a day with no releases, so the sample would carry holes
 * that look like quiet weeks. Retry, and if it still fails, say so loudly at the
 * end rather than letting the gap pass as data.
 */
async function fetchDay(date, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${API}?date=${date}`, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // An empty day is a legitimate answer (holidays) and is not an error. A
      // MISSING `data` object is -- that is the shape changing under us.
      if (!json || !json.data) throw new Error('response has no data object');
      return json.data.rows || [];
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1000 * Math.pow(3, i));
    }
  }
  throw lastErr;
}

async function setup(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_econ_calendar (
      id INT AUTO_INCREMENT PRIMARY KEY,
      -- WHAT TO READ. The real release, after undoing the feed's +1 day filing
      -- offset and its fixed GMT-4 clock. See feedToRelease().
      release_date DATE NOT NULL,
      release_time_et VARCHAR(5) NULL,
      release_utc DATETIME NULL,
      -- WHAT ARRIVED. Kept so the correction can be re-derived from the original
      -- rather than from its own last interpretation -- the same reason the raw
      -- figure strings are kept below.
      feed_date DATE NOT NULL,
      feed_time VARCHAR(5) NULL,
      country VARCHAR(64) NOT NULL,
      event_name VARCHAR(160) NOT NULL,
      -- Position within (release, country, name, time). A CPI day carries five
      -- rows that share a name; this is what tells them apart.
      seq TINYINT NOT NULL DEFAULT 0,
      unit VARCHAR(4) NULL,
      actual DOUBLE NULL,
      consensus DOUBLE NULL,
      previous DOUBLE NULL,
      actual_raw VARCHAR(48) NULL,
      consensus_raw VARCHAR(48) NULL,
      previous_raw VARCHAR(48) NULL,
      fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_event (release_date, country, event_name, release_time_et, seq),
      INDEX idx_release (release_date),
      INDEX idx_country_event (country, event_name, release_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function saveDay(pool, feedDate, rows) {
  if (!rows.length) return { written: 0, withConsensus: 0 };

  // seq is assigned by ORDER WITHIN THE GROUP, and the order was verified stable
  // across repeated fetches of the same date before this was relied on.
  const seen = new Map();
  const values = [];
  let withConsensus = 0;

  for (const r of rows) {
    const feedTime = (r.gmt || '').trim().slice(0, 5) || null;
    const name = String(r.eventName || '').trim().slice(0, 160);
    const country = String(r.country || '').trim().slice(0, 64);
    if (!name || !country) continue;

    // Undo the feed's filing offset and its fixed GMT-4 clock BEFORE keying, so
    // the unique key is on the real release rather than on the archive's
    // bookkeeping. Keying on the feed values would make two rows for the same
    // release collide or not, depending on which side of midnight it printed.
    const rel = feedToRelease(feedDate, feedTime);

    const k = `${country}|${name}|${rel.releaseTimeEt}`;
    const seq = seen.get(k) || 0;
    seen.set(k, seq + 1);

    const a = parseFigure(r.actual), c = parseFigure(r.consensus), p = parseFigure(r.previous);
    if (c.value !== null) withConsensus++;

    values.push([
      rel.releaseDate, rel.releaseTimeEt,
      rel.releaseUtc ? rel.releaseUtc.toISOString().slice(0, 19).replace('T', ' ') : null,
      feedDate, feedTime,
      country, name, seq, rowUnit(a, p, c),
      a.value, c.value, p.value,
      String(r.actual ?? '').slice(0, 48),
      String(r.consensus ?? '').slice(0, 48),
      String(r.previous ?? '').slice(0, 48),
    ]);
  }

  if (!values.length) return { written: 0, withConsensus: 0 };

  // VALUES(), not COALESCE(): a figure that has become unmeasured must be able
  // to overwrite a number, exactly as with idx_concentration. A revised release
  // that withdraws a consensus should not leave the old one standing.
  await pool.query(`
    INSERT INTO ft_econ_calendar
      (release_date, release_time_et, release_utc, feed_date, feed_time,
       country, event_name, seq, unit,
       actual, consensus, previous, actual_raw, consensus_raw, previous_raw)
    VALUES ?
    ON DUPLICATE KEY UPDATE
      release_utc=VALUES(release_utc), feed_date=VALUES(feed_date),
      feed_time=VALUES(feed_time), unit=VALUES(unit),
      actual=VALUES(actual), consensus=VALUES(consensus), previous=VALUES(previous),
      actual_raw=VALUES(actual_raw), consensus_raw=VALUES(consensus_raw),
      previous_raw=VALUES(previous_raw), fetched_at=NOW()
  `, [values]);

  return { written: values.length, withConsensus };
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };

  const today = toISO(new Date());
  let from = arg('--from'), to = arg('--to') || today;
  if (!from) {
    const days = Number(arg('--days') || 7);
    const d = new Date(today + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - days);
    from = toISO(d);
  }

  const dates = dateRange(from, to);
  console.log(`econ calendar: ${dates.length} dates, ${from} .. ${to}`);
  console.log('  source: Nasdaq (the licensed investing.com feed) — one request per day');
  console.log('  the feed files each row one day LATE on a fixed GMT-4 clock;');
  console.log('  release_date / release_time_et / release_utc are the corrected values');

  const pool = createPool();
  await setup(pool);

  let ok = 0, empty = 0, failed = 0, rowsTotal = 0, consensusTotal = 0, done = 0;
  const failures = [];

  // A few workers rather than one. Serial, a ten-year backfill is six hours;
  // three workers bring it under an hour while staying near one request per
  // second in aggregate, which is a reasonable load to put on a free endpoint
  // for a one-off backfill. Each worker keeps its own delay.
  // Two, not three. At three, one date in ten failed even after three retries
  // each -- a rate that tracks the concurrency rather than the data, since the
  // repair pass below recovers them when run alone. Fewer workers is the cheaper
  // fix than more retries.
  const WORKERS = 2;
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= dates.length) return;
      const date = dates[i];
      try {
        const rows = await fetchDay(date);
        const { written, withConsensus } = await saveDay(pool, date, rows);
        rowsTotal += written; consensusTotal += withConsensus;
        if (written) ok++; else empty++;
      } catch (e) {
        failed++;
        failures.push(`${date}: ${e.message}`);
      }
      done++;
      if (done % 200 === 0 || done === dates.length) {
        console.log(`  ${done}/${dates.length}  rows ${rowsTotal}  with consensus ${consensusTotal}  failed ${failed}`);
      }
      await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: WORKERS }, worker));

  // ── REPAIR PASS ───────────────────────────────────────────────────────────
  //
  // The concurrent run leaves failures behind -- roughly one date in ten on the
  // first full backfill, even with three retries each, which points at the
  // concurrency itself rather than at missing data. A failed date is invisible
  // afterwards: it looks exactly like a week with no releases.
  //
  // So whatever failed is retried ONCE MORE, alone and slowly. What survives
  // that is a real hole and gets named. This also answers the question the
  // failure count alone cannot: rate-limited, or genuinely absent?
  if (failures.length) {
    const retryDates = failures.map(f => f.split(':')[0]);
    console.log('');
    console.log(`repair pass: ${retryDates.length} failed dates, retried serially`);
    failures.length = 0;
    let repaired = 0;
    for (const date of retryDates) {
      try {
        const rows = await fetchDay(date, 4);
        const { written, withConsensus } = await saveDay(pool, date, rows);
        rowsTotal += written; consensusTotal += withConsensus;
        if (written) ok++; else empty++;
        failed--; repaired++;
      } catch (e) {
        failures.push(`${date}: ${e.message}`);
      }
      await sleep(1500);
    }
    console.log(`  recovered ${repaired} of ${retryDates.length}; ${failures.length} still failing`);
    if (repaired > retryDates.length * 0.5) {
      console.log('  Most recovered when run alone, so the concurrent failures were');
      console.log('  rate limiting rather than absent data.');
    }
  }

  console.log('');
  console.log(`dates with events : ${ok}`);
  console.log(`dates with none   : ${empty}`);
  console.log(`dates FAILED      : ${failed}`);
  console.log(`rows written      : ${rowsTotal}`);
  console.log(`  carrying a consensus: ${consensusTotal} (${rowsTotal ? (consensusTotal / rowsTotal * 100).toFixed(1) : 0}%)`);
  if (failures.length) {
    console.log('');
    console.log('FAILED DATES — these are holes, not empty days:');
    // Every one, not the first twenty. A truncated hole list is a hole list
    // nobody can act on.
    failures.forEach(f => console.log('  ' + f));
  }

  await pool.end();
  process.exit(failed ? 1 : 0);
}

module.exports = { parseFigure, rowUnit, dateRange, feedToRelease, setup, saveDay };

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}
