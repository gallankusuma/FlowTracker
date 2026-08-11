'use strict';

/**
 * System health and the signal kill switch.
 *
 * WHY THIS EXISTS (2026-08-03)
 * ----------------------------
 * Two things went wrong on this box that nothing could see:
 *
 *  - `signal_engine.py hk` was scheduled every weekday and had a SyntaxError. It
 *    failed 45 consecutive times. The only trace was a log file nobody reads.
 *  - `idx_ihsg_history` silently went stale for a week in July 2026, which was
 *    only noticed by accident and led to the in-memory `auxRefreshStatus` patch.
 *
 * The existing health signal is `auxRefreshStatus`, an in-process object covering
 * three refreshes. It is lost on restart, it says nothing about the Python cron
 * subsystem, and — the important part — it depends on jobs reporting their own
 * status.
 *
 * A JOB THAT CRASHES CANNOT REPORT THAT IT CRASHED.
 *
 * So health here is derived primarily from DATA rather than from self-reports.
 * If a table has no rows for the expected trading day, that is true regardless of
 * whether any process survived long enough to say so. Self-reported job runs are
 * still recorded, because duration and error text are useful — but they are
 * evidence, not the source of truth.
 *
 * THE KILL SWITCH
 * ---------------
 * `signalState()` returns SIGNAL_ENABLED or SIGNAL_DISABLED with machine-readable
 * reason codes. The intent is stated in Advance.md and repeated by the 2026-08-03
 * team review: a signal computed on stale or broken inputs is worse than no
 * signal, because it looks identical to a good one. Callers must treat DISABLED
 * as "produce no actionable output", not as a warning to display.
 */

/**
 * SEVERITY — what a failed check is ALLOWED to do.
 *
 * WHY THIS REPLACED A BOOLEAN (2026-08-09)
 * ----------------------------------------
 * Severity used to be one flag, `critical`, and `watchdog.js` turned it into a
 * report level with `r.critical ? 'FAIL' : 'WARN'`. Because the broker feed was
 * marked non-critical, the day it died it produced a WARNING — and a warning
 * binds nothing. The same night, the burn-in gate in the same file wrote
 * `passed: 1`. The system detected the fault, said so in plain English, and
 * passed itself anyway, for eight days.
 *
 * The defect was never "broker feed stale". It was DETECTION WITHOUT
 * ENFORCEMENT, and a two-valued flag cannot express the difference between
 * "worth a look" and "the output is wrong". So severity is now a level, and the
 * top two levels BIND:
 *
 *   INFO      observational. Nothing depends on it.
 *   ADVISORY  a human should look. Binds nothing, and is allowed to bind
 *             nothing precisely BECAUSE it does not affect correctness.
 *   DEGRADED  a real input is missing. Output may still be produced, but it must
 *             be LABELLED degraded and is not promotable — and the session is
 *             not clean, so the burn-in fails.
 *   BLOCKING  correctness is compromised. No actionable output at all, and the
 *             burn-in fails.
 *
 * THE RULE, from the 2026-08-08 review, and it is not negotiable:
 *
 *     a condition that affects correctness cannot be WARNING-only
 *
 * Which means: nothing that touches correctness may be given INFO or ADVISORY
 * to keep the dashboard green. If a feed is marked below DEGRADED, the `why`
 * must say what it is that does NOT depend on it.
 */
const SEVERITY = { INFO: 'INFO', ADVISORY: 'ADVISORY', DEGRADED: 'DEGRADED', BLOCKING: 'BLOCKING' };
const SEVERITY_RANK = { INFO: 0, ADVISORY: 1, DEGRADED: 2, BLOCKING: 3 };
/** DEGRADED and above BIND — readiness and the burn-in gate must both honour them. */
const binds = sev => (SEVERITY_RANK[sev] ?? 0) >= SEVERITY_RANK.DEGRADED;

/**
 * WHO a condition affects. Without this the binding is too blunt in one
 * direction and too generous in the other.
 *
 * `ft_signals` feeds paper_trader.py and nothing else. Marking it DEGRADED and
 * letting that reset the Virtual Broker V2 streak would repeat a mistake this
 * codebase has already made twice — throwaway TEST_* accounts entering the
 * burn-in identity, and an experimental account's NAV failing the official
 * checks. A Python paper-trading outage is real, and it is not evidence about
 * the V2 execution chain.
 */
const SUBSYSTEM = {
  SIGNAL_ENGINE:  'signal-engine',   // /api/signal-scanner, AWO factor scoring
  VIRTUAL_BROKER: 'virtual-broker',  // virtual_portfolio + the burn-in
  PAPER_TRADER:   'paper-trader',    // paper_trader.py, driven by ft_signals
};

/**
 * The virtual broker trades what the signal engine produces, so every input the
 * engine needs is transitively an input the broker chain needs. Stated once,
 * here, rather than by repeating SIGNAL_ENGINE in every feed's `affects` — and
 * it is the reason §4 of the review was right that all three burn-in sessions
 * were compromised: not because the broker chain read broker tables directly,
 * but because it acted on scores that did.
 */
const SUBSYSTEM_DEPENDS_ON = {
  [SUBSYSTEM.VIRTUAL_BROKER]: [SUBSYSTEM.SIGNAL_ENGINE],
};

/**
 * BROKER_DATA_MAX_LAG_SESSIONS — the one canonical answer to "how many exchange
 * sessions may broker data lag before a signal built on it is invalid?"
 *
 * DERIVED FROM ARRIVAL TIMES, NOT COPIED FROM AN EXISTING LITERAL. Before this
 * constant existed the codebase held three different answers to the same
 * question — the burn-in gate used 1, this freshness table used 2, and
 * /api/signal-scanner used 1 — none of which came from measuring anything.
 *
 * What the data says (idx_broker_summary.created_at vs the session it is dated
 * for, every session 2026-07-01 .. 2026-07-31, the last month the feed was
 * alive):
 *
 *   broker rows for session D land at   D 12:30:0x-12:30:5x UTC  (19:30 WIB)
 *   the pull completes by               D 12:36     UTC          (~6 minutes)
 *   price rows for session D land at    D 12:31-12:36 UTC        (90-360s LATER)
 *   refresh_ihsg writes the calendar    D 13:05     UTC          (20:05 WIB)
 *   the watchdog and burn-in gate run   D 13:50     UTC          (20:50 WIB)
 *
 * So broker data for session D is the FIRST thing the nightly pipeline writes,
 * and every consumer in this system runs at least 35 minutes — the watchdog, 80
 * minutes — after it. There is no window in which a healthy pipeline leaves a
 * consumer looking at an absent broker bar for the current session.
 *
 *     => 0. Any lag at all means the pull did not happen.
 *
 * Two consequences worth stating, because both were reasons the old values
 * looked defensible:
 *
 *  - "The feed lags by design, Index Alpha publishes ~19:00 WIB" was the stated
 *    justification for tolerance 2. It is true that the SOURCE publishes late in
 *    the day; it is not true that our copy of it lags a session, because our
 *    pull is scheduled after the publication and before every consumer. Source
 *    latency and pipeline lag are different quantities, and the old comment
 *    conflated them.
 *  - A strict 0 cannot false-alarm during the nightly write window, and that is
 *    a measured property rather than a hope: broker precedes prices by 90-360
 *    seconds, so the freshest-feed reference cannot reach session D before the
 *    broker table does.
 *
 * IF THE PIPELINE'S SCHEDULE CHANGES, RE-DERIVE THIS. It is a statement about
 * when jobs run, not a preference. A T+1 source with a morning pull would make
 * it 1, and that would need the same measurement, not an edit.
 */
const BROKER_DATA_MAX_LAG_SESSIONS = 0;

/**
 * The UTC minute by which session D's broker pull must have finished, plus the
 * grace that separates "slow" from "did not run".
 *
 * The pull starts 12:30 UTC and completes by 12:36 in every observed session.
 * 30 minutes of grace puts the deadline at 13:00 UTC — 24 minutes of slack on
 * the observed worst case, and still 50 minutes before the watchdog runs at
 * 13:50, so a dead pull is caught the same night rather than the next.
 */
const BROKER_PIPELINE_CUTOFF_UTC_MINUTES = 12 * 60 + 30;
const BROKER_PIPELINE_GRACE_MINUTES = 30;

const toIso = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : d ? String(d).slice(0, 10) : null);

/**
 * THE SESSION BROKER DATA IS ACTUALLY EXPECTED FOR, AS OF A GIVEN MOMENT.
 *
 * WHY THIS IS NOT `latest exchange session` (2026-08-09, review P1).
 * A tolerance of 0 is correct for a consumer that runs after the pipeline. It is
 * NOT correct for one that can be called at 10:00 WIB, while today's session is
 * still trading and today's EOD pull is not due for another nine hours. Asking
 * `brokerDate === latestExchangeSession` there would report a dead feed for a
 * session whose data nobody has promised yet.
 *
 * The contract is therefore not
 *
 *     brokerDate === latestExchangeSession
 *
 * but
 *
 *     brokerDate === latestRequiredCompletedSession(asOfTime)
 *
 *      before the cutoff:  the previous completed session
 *      after  the cutoff:  today's completed session
 *
 * WHAT SAVED US UNTIL NOW, AND WHY THAT IS NOT GOOD ENOUGH. /api/signal-scanner
 * takes its session axis from `idx_ihsg_history`, and `refresh_ihsg` does not
 * write session D until 20:05 WIB. So intraday the calendar does not yet contain
 * today, `sessionsBehind` computes to 0, and no false refusal occurs. That is a
 * real property of the current schedule and it is why no morning 503 has ever
 * been seen — but it is an accident of cron timing, not a contract. Move
 * refresh_ihsg earlier, or point the axis at any source that knows about today
 * intraday, and the endpoint starts refusing every morning. This codebase has
 * already written down that lesson once, about the resolve/refresh_ihsg ordering:
 * "an ordering that exists only in a crontab is one edit away from being wrong,
 * silently."
 *
 * @returns {Promise<string|null>} ISO date, or null if there is no calendar.
 */
async function expectedBrokerSession(pool, asOf = new Date()) {
  const [rows] = await pool.query(
    'SELECT date FROM idx_ihsg_history ORDER BY date DESC LIMIT 2');
  if (!rows.length) return null;
  const latest = toIso(rows[0].date);
  const previous = rows[1] ? toIso(rows[1].date) : latest;

  // Has session `latest` had its pipeline window? Measured against `latest`
  // itself rather than against the wall clock's own date, so this stays correct
  // over a weekend or a holiday: on Sunday, Friday's cutoff is long past and
  // Friday's data is rightly expected.
  const deadline = Date.parse(`${latest}T00:00:00Z`) +
    (BROKER_PIPELINE_CUTOFF_UTC_MINUTES + BROKER_PIPELINE_GRACE_MINUTES) * 60000;
  return asOf.getTime() >= deadline ? latest : previous;
}

/**
 * THE CENTRAL BROKER-FRESHNESS PRIMITIVE.
 *
 * WHY A LAG NUMBER WAS NOT ENOUGH (2026-08-09, review of R2-A).
 * Everything so far asked one question — how many sessions BEHIND is the feed —
 * and that question cannot express two states that are not lateness at all:
 *
 *   latestBrokerDate  >  expected      a bar for a session that has not closed
 *   latestBrokerDate  not a session    a bar for a day the exchange never traded
 *
 * Both currently read as PERFECTLY FRESH, and that is measured, not feared:
 * `tradingDayLag` ends in `weekdaysSince(fromDate, referenceDate)`, which
 * returns 0 for any date at or beyond the reference. So lag is 0, `lag <=
 * maxLag` holds at tolerance 0, and the feed is reported CURRENT.
 *
 * The second case is not hypothetical either. `idx_stock_prices` carried 75
 * non-session dates — weekends and holidays with carried-forward quotes — and
 * one more appeared on 2026-08-08 from an unguarded writer. Nothing structurally
 * prevents the same class of row in the broker tables, and if one lands as
 * MAX(date) every freshness check in this file currently calls it fresh.
 *
 * A future or non-session bar is WORSE than a stale one. Stale is at least true
 * of some day; these are true of no day, and they present as the healthiest
 * possible state.
 *
 *   latestBrokerDate  <  expected   -> STALE       (refuse)
 *   latestBrokerDate  == expected   -> CURRENT
 *   latestBrokerDate  >  expected   -> FUTURE      (refuse — invalid, not fresh)
 *   latestBrokerDate  not a session -> NON_SESSION (refuse)
 *
 * One primitive, so the scanner, Flow Analyzer, the burn-in gate and the
 * watchdog cannot each grow their own opinion — which is exactly how the three
 * disagreeing lag literals happened.
 */
const BROKER_FRESHNESS = {
  CURRENT: 'CURRENT', STALE: 'STALE', FUTURE: 'FUTURE',
  NON_SESSION: 'NON_SESSION', PREMATURE: 'PREMATURE', NO_DATA: 'NO_DATA',
};

/**
 * @param {string} [opts.notBefore] A session this feed must ALSO have reached,
 *   over and above its own publication deadline. Used to hold the broker family
 *   to each other — see `brokerFamilySession` in dataFreshness. Never relaxes
 *   the deadline; it can only raise the bar.
 */
async function brokerFreshness(pool, { asOf = new Date(), table = 'idx_broker_summary', col = 'date', notBefore = null } = {}) {
  const [[row]] = await pool.query(`SELECT MAX(${col}) AS d FROM ${table}`);
  const latest = toIso(row?.d);
  const expected = await expectedBrokerSession(pool, asOf);

  if (!latest) {
    return { state: BROKER_FRESHNESS.NO_DATA, valid: false, latest: null, expected,
             sessionsBehind: null, detail: `${table} is empty` };
  }
  if (!expected) {
    return { state: BROKER_FRESHNESS.NO_DATA, valid: false, latest, expected: null,
             sessionsBehind: null, detail: 'no exchange calendar to judge against' };
  }

  // A WEEKEND BAR IS NEVER VALID, and this is checked without the calendar
  // because the calendar can never help here: it will never contain a Saturday,
  // so "absent from the calendar" cannot distinguish a weekend from a date the
  // calendar simply has not reached yet.
  const dow = new Date(`${latest}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) {
    return { state: BROKER_FRESHNESS.NON_SESSION, valid: false, latest, expected, sessionsBehind: null,
             detail: `${latest} is a weekend. IDX does not trade Saturday or Sunday, so no broker data can legitimately be dated to it` };
  }

  // FUTURE means later than the exchange's own calendar day, measured in WIB.
  //
  // NOT "later than `expected`" — that was this function's first rule and it was
  // WRONG in a way the tests caught. Broker data lands 12:30 UTC while the
  // pipeline deadline is 13:00, so for thirty minutes every evening the feed
  // legitimately holds a session that `expected` has not advanced to yet. That
  // rule would have refused the freshest possible data, nightly.
  const wib = new Date(asOf.getTime() + 7 * 3600 * 1000);
  const todayWib = wib.toISOString().slice(0, 10);
  if (latest > todayWib) {
    return { state: BROKER_FRESHNESS.FUTURE, valid: false, latest, expected, sessionsBehind: 0,
             detail: `${latest} is dated after today (${todayWib} WIB). A bar for a session that has not happened is invalid, not fresh` };
  }

  // Within the calendar's own range, absence is proof: the index traded on every
  // real session, so a weekday the index has no bar for was a holiday.
  const [calRows] = await pool.query(
    'SELECT 1 AS ok FROM idx_ihsg_history WHERE date = ? LIMIT 1', [latest]);
  const [[calBounds]] = await pool.query(
    'SELECT MIN(date) lo, MAX(date) hi FROM idx_ihsg_history');
  const lo = toIso(calBounds?.lo), hi = toIso(calBounds?.hi);
  // Beyond the newest calendar row the absence of a bar proves nothing — the
  // calendar refreshes 35 minutes after the broker pull, so it is routinely
  // behind. Claiming NON_SESSION there would blame the wrong feed.
  if (lo && hi && latest >= lo && latest <= hi && !calRows.length) {
    return { state: BROKER_FRESHNESS.NON_SESSION, valid: false, latest, expected, sessionsBehind: null,
             detail: `${latest} is a weekday the exchange did not trade — the index has no bar for it, so no broker data can legitimately be dated to it` };
  }

  // Ahead of `expected` but not ahead of today. Correcting the FUTURE rule to
  // allow the evening window made this branch too permissive in the other
  // direction: it accepted a bar for TODAY at any hour, including 10:00 WIB,
  // when this is an END-OF-DAY feed whose earliest legitimate publication is
  // 12:30 UTC / 19:30 WIB. A today-dated bar before the session has even closed
  // is not early data, it is implausible data — the same class of fault as a
  // future date, arriving through the exemption written for the legitimate case.
  if (latest > expected) {
    const publishFrom = Date.parse(`${latest}T00:00:00Z`) + BROKER_PIPELINE_CUTOFF_UTC_MINUTES * 60000;
    if (asOf.getTime() < publishFrom) {
      return { state: BROKER_FRESHNESS.PREMATURE, valid: false, latest, expected, sessionsBehind: 0,
               detail: `${latest} carries broker data before its EOD publication window opens (${new Date(publishFrom).toISOString()}). This feed is end-of-day; a bar for a session still trading cannot be real` };
    }
  }

  // THE SESSION THIS FEED MUST HAVE REACHED.
  //
  // `expected` alone is a statement about the CLOCK: has this feed's publication
  // window closed? That is necessary and not sufficient, because two feeds can
  // both be inside their window and still disagree about which session they
  // cover — and a score is built from all of them at once.
  //
  // Found live 2026-08-10 19:37 WIB, in the nightly job's own record: the
  // snapshot stage failed with "concentration:1 trading session(s) behind".
  // Broker rows for 08-10 had landed at 12:30 UTC, concentration was still
  // derived only through 08-07, and the calendar had not yet advanced (that runs
  // 13:05 UTC) so `expected` was still 08-07. Judged against the clock alone,
  // BOTH feeds were legitimately current — while covering sessions three days
  // apart. Scoring there would date itself by MAX(broker) = 08-10 and read
  // concentration from 08-07: the "confident score built on inputs that do not
  // exist" this whole gate exists to refuse.
  //
  // So the bar is the LATER of the two: the feed's own deadline, and whatever
  // session its siblings have already reached. This never relaxes the deadline —
  // it only ever raises the requirement.
  const required = (notBefore && notBefore > expected) ? notBefore : expected;

  if (latest >= required) {
    return { state: BROKER_FRESHNESS.CURRENT, valid: true, latest, expected, sessionsBehind: 0,
             detail: latest === expected ? 'current' : `current (${latest} landed ahead of the ${expected} deadline)` };
  }

  const [behind] = await pool.query(
    'SELECT COUNT(*) n FROM idx_ihsg_history WHERE date > ? AND date <= ?', [latest, required]);
  let sessionsBehind = Number(behind[0]?.n) || 0;
  // The calendar is written 35 minutes AFTER the broker pull, so `required` is
  // routinely a session it does not yet contain — and counting rows inside a
  // window the calendar cannot see returns 0, which would report a feed that is
  // demonstrably behind its own siblings as current. Same blindness, and the
  // same correction, as `tradingDayLag`'s calEnd clamp.
  if (sessionsBehind === 0 && latest < required) sessionsBehind = 1;

  return {
    state: sessionsBehind > BROKER_DATA_MAX_LAG_SESSIONS ? BROKER_FRESHNESS.STALE : BROKER_FRESHNESS.CURRENT,
    valid: sessionsBehind <= BROKER_DATA_MAX_LAG_SESSIONS,
    latest, expected, sessionsBehind,
    detail: sessionsBehind > BROKER_DATA_MAX_LAG_SESSIONS
      ? `${sessionsBehind} exchange session(s) behind ${required}` +
        (required === expected ? '' : ` (the session its own feed family has already reached)`) +
        ` (tolerance ${BROKER_DATA_MAX_LAG_SESSIONS})`
      : 'current',
  };
}

/**
 * A REUSABLE COMPLETENESS CONTRACT (2026-08-09, review P2).
 *
 * "5D" must mean FIVE CONSECUTIVE CANONICAL EXCHANGE SESSIONS, not five rows
 * that happened to be available. The difference is not pedantry: this sweep
 * proved `idx_broker_summary` is missing 2024-05-29, 2026-06-15, 06-22 and
 * 06-29 — real sessions with prices and an index bar — so a window crossing one
 * of them silently spans four observations while still being labelled five.
 *
 * Deliberately NOT built inside Pattern Replay. If each consumer writes its own
 * check, they will disagree about what a session is, and the one that gets it
 * wrong will be the one nobody reads. Same reasoning as `phantomSessions` being
 * the single definition that both the detector and the purge script call.
 *
 * Intended callers: Pattern Replay, research windows, backtests, signal-history
 * validation, broker factor computation.
 *
 * SCOPE, STATED HONESTLY. This answers "does this dataset have usable rows for
 * every canonical session in the window". It does NOT answer per-ticker
 * completeness — a session where 3 of 245 tickers reported counts as observed.
 * That is a different question and a caller needing it must ask it separately;
 * saying so here is cheaper than someone later assuming this covered it.
 *
 * @param {string}  table          dataset to check
 * @param {string}  col            its session-date column
 * @param {string}  [startSession] ISO date, inclusive. Omit and pass `count`.
 * @param {string}  [endSession]   ISO date, inclusive. Defaults to the newest session.
 * @param {number}  [count]        window length in sessions, counted back from endSession
 * @param {string[]}[requiredFields] a session counts as observed only if at least
 *                                 one of its rows has all of these non-null
 */
async function assertCompleteSessions(pool, {
  table, col, startSession = null, endSession = null, count = null,
  requiredFields = [], calendar = 'idx_ihsg_history', calendarCol = 'date',
} = {}) {
  if (!table || !col) throw new Error('assertCompleteSessions: table and col are required');

  // IDENTIFIERS ARE VALIDATED, NOT TRUSTED (review P2).
  //
  // Table, column and requiredFields are interpolated into SQL because MySQL
  // cannot parameterise identifiers. Every caller today is internal, so this is
  // hardening rather than an open hole — but this is deliberately a REUSABLE
  // primitive, offered to Pattern Replay, research windows and backtests, and
  // the next caller may well pass something derived from a request. A guard
  // that only holds while everyone remembers the rule is not a guard.
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  for (const [label, value] of [['table', table], ['col', col],
                                ['calendar', calendar], ['calendarCol', calendarCol]]) {
    if (!IDENT.test(String(value))) {
      throw new Error(`assertCompleteSessions: ${label} '${value}' is not a valid SQL identifier`);
    }
  }
  for (const f of requiredFields) {
    if (!IDENT.test(String(f))) {
      throw new Error(`assertCompleteSessions: requiredFields entry '${f}' is not a valid SQL identifier`);
    }
  }

  if (!endSession) {
    const [[e]] = await pool.query(`SELECT MAX(${calendarCol}) d FROM ${calendar}`);
    endSession = toIso(e?.d);
  }
  if (!endSession) {
    return { complete: false, expectedSessions: 0, observedSessions: 0, missingSessions: [],
             window: null, reason: 'NO_CALENDAR' };
  }

  // The canonical session list. The calendar is the exchange's own index series,
  // so this is the axis, not an approximation of it.
  let sessions;
  if (startSession) {
    const [rows] = await pool.query(
      `SELECT ${calendarCol} d FROM ${calendar} WHERE ${calendarCol} BETWEEN ? AND ? ORDER BY ${calendarCol}`,
      [startSession, endSession]);
    sessions = rows.map(r => toIso(r.d));
  } else {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) throw new Error('assertCompleteSessions: pass startSession or a positive count');
    const [rows] = await pool.query(
      `SELECT ${calendarCol} d FROM ${calendar} WHERE ${calendarCol} <= ? ORDER BY ${calendarCol} DESC LIMIT ?`,
      [endSession, n]);
    sessions = rows.map(r => toIso(r.d)).reverse();
  }

  if (!sessions.length) {
    return { complete: false, expectedSessions: 0, observedSessions: 0, missingSessions: [],
             window: { from: startSession, to: endSession }, reason: 'NO_SESSIONS_IN_WINDOW' };
  }

  // A window the calendar cannot fully cover is INCOMPLETE, not shortened. Asking
  // for 5 sessions and silently returning 4 is the exact defect this exists to
  // stop, so a short calendar is reported rather than absorbed.
  const shortBy = count && sessions.length < Number(count) ? Number(count) - sessions.length : 0;

  const notNull = requiredFields.length
    ? ' AND ' + requiredFields.map(f => `${f} IS NOT NULL`).join(' AND ')
    : '';
  const [present] = await pool.query(
    `SELECT DISTINCT ${col} d FROM ${table} WHERE ${col} IN (?)${notNull}`, [sessions]);
  const have = new Set(present.map(r => toIso(r.d)));

  const missingSessions = sessions.filter(s => !have.has(s));
  return {
    complete: missingSessions.length === 0 && shortBy === 0,
    expectedSessions: count ? Number(count) : sessions.length,
    observedSessions: sessions.length - missingSessions.length,
    missingSessions,
    window: { from: sessions[0], to: sessions[sessions.length - 1], sessions: sessions.length },
    ...(shortBy ? { reason: 'CALENDAR_SHORTER_THAN_WINDOW', shortBy } : {}),
    ...(requiredFields.length ? { requiredFields } : {}),
  };
}

/**
 * WHICH YARDSTICK A CHECK IS MEASURED AGAINST.
 *
 * WHY THIS FIELD EXISTS (2026-08-11). Seen live at 18:55 WIB on 2026-08-10:
 * /api/signal-scanner and /api/flow-analyzer were returning 503 for a broker feed
 * that was, by the module's own central primitive, perfectly CURRENT. Two
 * definitions of freshness had grown in one file:
 *
 *   brokerFreshness()  judged the feed against `expectedBrokerSession(asOf)` —
 *                      time-aware, so before the evening pull the PREVIOUS
 *                      session is the one being promised.
 *   dataFreshness()    judged it against the FRESHEST DATE ANY FEED HAD, with a
 *                      tolerance of 0.
 *
 * Those agree only while every feed advances together, and one does not.
 * `refreshIHSG` writes session D as soon as the WIB day passes 16:15 (see
 * modules/ihsg.js) and it is called on page open, while the broker pull is the
 * 19:30 WIB job. So on any day somebody opened the app after the close, the
 * calendar reached D around 16:15 and the broker table stayed at D-1 until 19:30.
 * For those ~3¼ hours the freshest-feed reference was D, broker lag computed to 1
 * against a tolerance of 0, the check went BLOCKING, and both endpoints refused —
 * every trading day, healing itself at 19:30 so it never looked like a fault.
 *
 * The scanner was not wrong to refuse a stale feed. It was measuring lateness
 * against a feed that is SCHEDULED to run ahead of it, which is not lateness at
 * all. The freshest-feed reference is right for feeds that land together in the
 * nightly job; it is wrong for a feed with its own publication deadline, and that
 * deadline is exactly what `expectedBrokerSession` already knew.
 *
 *   'freshest-feed'   lag vs the newest date any monitored feed has produced.
 *   'broker-pipeline' the verdict comes from brokerFreshness() itself — the same
 *                     call the scanner, Flow Analyzer and the burn-in gate make.
 *                     Not "the same tolerance" or "the same rule restated": the
 *                     same function, because this file has now twice proved that
 *                     two implementations of one question drift.
 *
 * A total ingest outage is still caught, and not by this: the calendar freezes
 * too, so `expected` freezes with it and the broker feed looks current — which is
 * precisely what the synthetic `ingest` row below measures against the WALL CLOCK
 * rather than against another table. That backstop is the reason it is safe for a
 * per-feed check to be judged relative to its own schedule.
 */
const REFERENCE = { FRESHEST_FEED: 'freshest-feed', BROKER_PIPELINE: 'broker-pipeline' };

const CHECKS = [
  { key: 'prices',       table: 'idx_stock_prices',    col: 'date',        maxLag: 1,
    severity: SEVERITY.BLOCKING,
    affects: [SUBSYSTEM.SIGNAL_ENGINE, SUBSYSTEM.VIRTUAL_BROKER, SUBSYSTEM.PAPER_TRADER],
    why: 'Every factor, regime and backtest reads prices, and the NAV mark values positions from them. Stale prices mean stale everything. Tolerance is 1 rather than 0 because broker rows land 90-360s BEFORE prices in the same nightly job, so the freshest-feed reference briefly reaches session D while the price loop is still writing.' },

  { key: 'broker',       table: 'idx_broker_summary',  col: 'date',        maxLag: BROKER_DATA_MAX_LAG_SESSIONS,
    reference: REFERENCE.BROKER_PIPELINE,
    severity: SEVERITY.BLOCKING,
    affects: [SUBSYSTEM.SIGNAL_ENGINE],
    why: 'BLOCKING, and it was the feed marked non-critical when it died. /api/signal-scanner takes its notion of "today" from this table — it is the clock, not merely a factor input — and the f1 concentration family is computed from it. A score dated to a session this table does not cover is not a stale score, it is a confident score built on inputs that do not exist.' },

  { key: 'concentration',table: 'idx_concentration',   col: 'data_date',   maxLag: BROKER_DATA_MAX_LAG_SESSIONS,
    reference: REFERENCE.BROKER_PIPELINE,
    severity: SEVERITY.BLOCKING,
    affects: [SUBSYSTEM.SIGNAL_ENGINE],
    why: 'Broker-derived, and f1 reads dn0..dn4 from it directly. Listed separately from `broker` even though the same outage takes both, because the derivation step can fail on its own: fresh broker rows with no concentration computed from them is a state the engine would otherwise score straight through.' },

  // Added 2026-08-09 by the severity sweep. It was never monitored, and it
  // feeds live scoring (server.js:6245, the foreign/domestic divergence factor).
  { key: 'flow_detail',  table: 'idx_broker_flow_detail', col: 'date',     maxLag: BROKER_DATA_MAX_LAG_SESSIONS,
    reference: REFERENCE.BROKER_PIPELINE,
    severity: SEVERITY.DEGRADED,
    affects: [SUBSYSTEM.SIGNAL_ENGINE],
    why: 'The foreign/domestic split. DEGRADED rather than BLOCKING because it is one factor family and not the clock: with it absent the engine can still date and score a session, but it must say the divergence factor is missing rather than report a neutral value as a measurement.' },

  { key: 'ihsg',         table: 'idx_ihsg_history',    col: 'date',        maxLag: 1,
    severity: SEVERITY.BLOCKING,
    affects: [SUBSYSTEM.SIGNAL_ENGINE, SUBSYSTEM.VIRTUAL_BROKER],
    why: 'Two jobs at once: the 200-day regime filter (the one layer proven to transfer out of sample, where defaulting to "invested" is exactly the wrong failure direction) and the exchange session calendar that virtual_portfolio, the gap detectors and the burn-in all take their date axis from. Tolerance 1 is scheduled, not slack: refresh_ihsg runs 13:05 UTC, 35 minutes after the pull that lands prices and broker.' },

  // Added 2026-08-03 after finding ft_signals had been stale since 2026-05-30.
  // signal_engine.py had a SyntaxError and, later, an unquoted MySQL reserved
  // word. paper_trader.py kept running eight times a day and logging "Found 0
  // BUY/STRONG_BUY signals", which is indistinguishable from a quiet market.
  // Two months of silence. This check is the whole argument for deriving health
  // from data rather than from whether a job reported an error.
  { key: 'signals',      table: 'ft_signals',          col: 'signal_date', maxLag: 3,
    severity: SEVERITY.DEGRADED,
    affects: [SUBSYSTEM.PAPER_TRADER],
    why: 'Feeds paper_trader.py. When it goes stale the paper trader still runs and still reports zero trades, which reads as a quiet market rather than a broken pipeline — so DEGRADED, never advisory. Scoped to paper-trader on purpose: it is not an input to the signal engine or the V2 execution chain, and letting it reset the V2 burn-in would be the same scope error as the TEST_* accounts that once entered the official identity hash.' },
];

/**
 * Trading days between `fromDate` and the reference bar, using the IHSG
 * calendar to skip weekends and IDX holidays.
 *
 * FIXED 2026-08-03. This used to compare every table against
 * `(SELECT MAX(date) FROM idx_ihsg_history)` — including the `ihsg` check
 * itself, which therefore compared MAX(date) with MAX(date) and returned 0 no
 * matter how stale the table was. The one check whose own comment says it
 * exists because "idx_ihsg_history silently went stale for a week in July 2026"
 * was structurally incapable of detecting that.
 *
 * It was also wrong for the other tables, in the dangerous direction: with the
 * axis frozen, every table is fresh relative to a frozen yardstick, so a total
 * ingest outage reports all-green.
 *
 * `referenceDate` is now passed in by the caller — the freshest date ANY
 * monitored feed has produced — so one dead feed cannot make the others look
 * healthy, and `absoluteStaleness` below measures that reference against the
 * actual clock so a complete outage is still caught.
 */
async function tradingDayLag(pool, fromDate, referenceDate) {
  const [[cal]] = await pool.query('SELECT MAX(date) AS d FROM idx_ihsg_history');
  const maxCal = cal.d ? (cal.d instanceof Date ? cal.d.toISOString().slice(0, 10) : String(cal.d).slice(0, 10)) : null;

  // The calendar can only speak for dates it actually contains. If the
  // reference has moved past the calendar's own last row, the calendar is
  // itself behind, and counting rows inside a window it cannot see returns 0 --
  // which is precisely how the ihsg check reported "fresh" while stale. The
  // portion beyond the calendar is counted in weekdays instead.
  const calEnd = (maxCal && maxCal < referenceDate) ? maxCal : referenceDate;
  let lag = 0;
  if (fromDate < calEnd) {
    const [r] = await pool.query(
      'SELECT COUNT(*) AS n FROM idx_ihsg_history WHERE date > ? AND date <= ?', [fromDate, calEnd]);
    lag = Number(r[0].n) || 0;
  }
  const beyond = fromDate > calEnd ? fromDate : calEnd;
  return lag + weekdaysSince(beyond, new Date(`${referenceDate}T12:00:00Z`));
}

/**
 * Weekdays between a date and today. Deliberately does NOT consult the IHSG
 * calendar: this is the check that has to work when that calendar is the thing
 * that has stopped. It over-counts across an IDX holiday, which is the safe
 * direction — a false "stale" prompts a look, a false "fresh" does not.
 */
function weekdaysSince(dateStr, today = new Date()) {
  const from = new Date(`${dateStr}T00:00:00Z`);
  const to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  if (!(from < to)) return 0;
  let n = 0;
  const d = new Date(from);
  while (d < to) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

/**
 * Freshness of every monitored table, measured in TRADING days rather than
 * calendar days — a Monday check must not report the weekend as two days of
 * staleness.
 */
/**
 * Absolute tolerance for the reference feed itself, in weekdays. Generous
 * enough to ride out a long IDX holiday, tight enough that a dead ingest is
 * caught within a week rather than the two months the signal pipeline managed.
 */
const MAX_REFERENCE_WEEKDAYS = 5;

async function dataFreshness(pool, today = new Date()) {
  // The reference bar is the freshest date ANY monitored feed has produced, so
  // one dead feed cannot make the rest look healthy by freezing the yardstick.
  let reference = null;
  for (const c of CHECKS) {
    try {
      const [r] = await pool.query(`SELECT MAX(${c.col}) AS d FROM ${c.table}`);
      if (!r[0].d) continue;
      const d = r[0].d instanceof Date ? r[0].d.toISOString().slice(0, 10) : String(r[0].d).slice(0, 10);
      if (reference === null || d > reference) reference = d;
    } catch { /* a broken table is reported per-check below */ }
  }

  // THE SESSION THE BROKER FAMILY HAS COLLECTIVELY REACHED.
  //
  // The broker pipeline is one pull and one derivation, and its three tables are
  // meant to cover the same session. Holding each to its own deadline alone lets
  // them drift apart inside the nightly window — see the 2026-08-10 19:37 WIB
  // incident quoted in brokerFreshness. Holding them to EACH OTHER closes that
  // without reintroducing the bug this file was just fixed for, because the
  // reference is drawn from the broker family ONLY: prices and the index
  // calendar run on their own schedules and can no longer make it refuse.
  let brokerFamilySession = null;
  for (const c of CHECKS) {
    if (c.reference !== REFERENCE.BROKER_PIPELINE) continue;
    try {
      const [r] = await pool.query(`SELECT MAX(${c.col}) AS d FROM ${c.table}`);
      const d = toIso(r[0]?.d);
      if (d && (brokerFamilySession === null || d > brokerFamilySession)) brokerFamilySession = d;
    } catch { /* reported per-check below */ }
  }

  // `critical` is still emitted alongside `severity` because the Trade Desk
  // reads it (app/trade-desk/page.tsx). Derived, never authored: one source of
  // truth, so the two can never disagree the way the gate and the warning did.
  const decorate = row => ({
    ...row,
    critical: row.severity === SEVERITY.BLOCKING,
    binds: binds(row.severity),
  });

  const out = [];
  if (reference !== null) {
    const drift = weekdaysSince(reference, today);
    out.push(decorate({
      key: 'ingest', table: '(all monitored feeds)',
      severity: SEVERITY.BLOCKING,
      affects: [SUBSYSTEM.SIGNAL_ENGINE, SUBSYSTEM.VIRTUAL_BROKER, SUBSYSTEM.PAPER_TRADER],
      why: 'Measured against the clock, not against another table. Every per-table lag below is relative to this bar, so if this is stale everything else is fresh relative to a frozen yardstick and a total outage reads as all-green.',
      latest: reference, lagTradingDays: drift, maxLag: MAX_REFERENCE_WEEKDAYS, rows: null,
      ok: drift <= MAX_REFERENCE_WEEKDAYS,
      detail: drift <= MAX_REFERENCE_WEEKDAYS ? 'fresh'
        : `no feed has produced data for ${drift} weekdays (tolerance ${MAX_REFERENCE_WEEKDAYS})`,
    }));
  }

  for (const c of CHECKS) {
    try {
      const [r] = await pool.query(`SELECT MAX(${c.col}) AS d, COUNT(*) AS n FROM ${c.table}`);
      const latest = r[0].d;

      // A FEED WITH ITS OWN PUBLICATION DEADLINE IS JUDGED BY IT, not by how far
      // another feed has run ahead. The verdict is brokerFreshness()'s, verbatim,
      // so this row and the one the scanner reads cannot disagree — which they
      // did, daily, between 16:15 and 19:30 WIB. See REFERENCE above.
      //
      // It also carries the validity states a lag number cannot express: an empty
      // table, a weekend bar, a future date, a today-dated bar published before
      // the EOD window opened. Those were previously asked ONLY of
      // idx_broker_summary, by readiness(); concentration and flow_detail were
      // checked for lateness alone and would have called a Saturday row fresh.
      if (c.reference === REFERENCE.BROKER_PIPELINE) {
        const f = await brokerFreshness(pool, {
          asOf: today, table: c.table, col: c.col, notBefore: brokerFamilySession });
        out.push(decorate({ key: c.key, table: c.table, severity: c.severity, affects: c.affects, why: c.why,
          latest: f.latest, lagTradingDays: f.sessionsBehind, maxLag: c.maxLag,
          rows: latest ? Number(r[0].n) : 0,
          ok: f.valid,
          // The state code travels in the text because `blocking` entries are
          // `key:detail` strings and callers match on them.
          detail: f.valid ? f.detail : `${f.state}: ${f.detail}`,
          expected: f.expected,
          freshness: f }));
        continue;
      }

      if (!latest) {
        out.push(decorate({ ...c, latest: null, lagTradingDays: null, ok: false, detail: 'table is empty' }));
        continue;
      }
      const d = latest instanceof Date ? latest.toISOString().slice(0, 10) : String(latest).slice(0, 10);
      const lag = await tradingDayLag(pool, d, reference);
      out.push(decorate({ key: c.key, table: c.table, severity: c.severity, affects: c.affects, why: c.why,
                 latest: d, lagTradingDays: lag, maxLag: c.maxLag, rows: Number(r[0].n),
                 ok: lag <= c.maxLag,
                 detail: lag <= c.maxLag ? 'fresh'
                   : `${lag} trading session(s) behind (tolerance ${c.maxLag})` }));
    } catch (e) {
      out.push(decorate({ ...c, latest: null, lagTradingDays: null, ok: false, detail: `query failed: ${e.message}` }));
    }
  }
  return out;
}

/**
 * THE READINESS CONTRACT, from §2.3 of the 2026-08-08 review.
 *
 *     SIGNAL_DATE = latest exchange session for which
 *                   ALL REQUIRED INPUT FAMILIES are current
 *
 *     not max(price_date), and not max(broker_date)
 *
 * The scanner's original bug was that it HAD a clock — it read
 * MAX(idx_broker_summary.date) and called that today. When the feed froze, the
 * clock froze with it and the endpoint kept answering. A clock cannot notice
 * that it has stopped. A readiness contract can, because it asks a different
 * question: not "what time is it?" but "is every input I need present for the
 * session I am about to speak for?"
 *
 * `signalDate` here is the oldest of the required feeds' latest dates, which is
 * the correct answer only while those feeds have no holes BEHIND their newest
 * row. They do — idx_broker_summary is missing 2026-06-15, 06-22 and 06-29
 * outright. MAX(date) cannot see a hole, which is the same blindness that let
 * the IHSG series lose 2026-08-03 while every check stayed green. Hole detection
 * is `missingSessions`, reported by the watchdog, deliberately NOT folded in
 * here: this function answers "can we speak for the newest session", and a
 * window query asking "are the last N sessions complete" is a different question
 * that Pattern Replay needs and must ask for itself.
 *
 * @param {string[]} subsystems  which subsystems to judge; dependencies are
 *                               resolved through SUBSYSTEM_DEPENDS_ON.
 */
async function readiness(pool, { subsystems = Object.values(SUBSYSTEM), today = new Date(), freshness = null } = {}) {
  const fresh = freshness || await dataFreshness(pool, today);

  const wanted = new Set();
  const expand = s => {
    if (wanted.has(s)) return;
    wanted.add(s);
    for (const dep of SUBSYSTEM_DEPENDS_ON[s] || []) expand(dep);
  };
  for (const s of subsystems) expand(s);

  const relevant = fresh.filter(f => (f.affects || []).some(a => wanted.has(a)));
  const failed = relevant.filter(f => !f.ok);

  const blocking = failed.filter(f => f.severity === SEVERITY.BLOCKING)
    .map(f => `${f.key}:${f.detail}`);
  const degraded = failed.filter(f => f.severity === SEVERITY.DEGRADED)
    .map(f => `${f.key}:${f.detail}`);
  const advisory = failed.filter(f => !binds(f.severity))
    .map(f => `${f.key}:${f.detail}`);

  // VALIDITY, not just lateness — a broker bar dated to a session that has not
  // closed, or to a day the exchange never traded, is invalid rather than fresh.
  //
  // THIS USED TO ASK THE QUESTION ITSELF (fixed 2026-08-11). It called
  // brokerFreshness() a second time and pushed the non-STALE states into
  // `blocking`, deliberately skipping STALE so as not to double-count "the lag
  // check". That split was the bug: STALE was left to a lag check measured
  // against a DIFFERENT yardstick, so the two could — and every evening did —
  // return opposite verdicts about the same feed. dataFreshness now carries the
  // primitive's own verdict for all of its states, so this reads the result
  // rather than recomputing it. One call, one answer, no branch that decides
  // which faults each half is allowed to report.
  const brokerRow = fresh.find(f => f.key === 'broker');
  const brokerState = [...wanted].some(s => s === SUBSYSTEM.SIGNAL_ENGINE)
    ? (brokerRow?.freshness || null)
    : null;

  // The session we can honestly speak for: the oldest "latest" among the
  // required feeds. A feed with no rows at all makes this null rather than
  // being skipped — an empty table is not a table that agrees with everyone.
  let signalDate = null, limitedBy = null;
  for (const f of relevant) {
    if (f.key === 'ingest') continue;          // synthetic, has no session of its own
    if (!f.latest) { signalDate = null; limitedBy = f.key; break; }
    if (signalDate === null || f.latest < signalDate) { signalDate = f.latest; limitedBy = f.key; }
  }

  return {
    ready: blocking.length === 0 && degraded.length === 0,
    enabled: blocking.length === 0,        // BLOCKING stops output; DEGRADED only labels it
    degradedMode: blocking.length === 0 && degraded.length > 0,
    subsystems: [...wanted],
    signalDate, limitedBy,
    blocking,
    degraded,
    advisory,
    brokerFreshness: brokerState,
    detail: relevant,
  };
}

/**
 * Trading sessions the reference calendar has but a table does NOT — holes in
 * the middle of a series, as opposed to the end of it.
 *
 * WHY THIS EXISTS (2026-08-04). Every check above measures MAX(date). A series
 * missing 2026-08-03 while holding 2026-08-04 is perfectly fresh by that
 * measure and perfectly wrong for anything that reads a window: the 200-day SMA
 * silently averages 199 real sessions and one that is not there, and the regime
 * line moves. That happened — the IHSG series lost 2026-08-03 and every
 * freshness check stayed green.
 *
 * Worse, it could not heal. `refreshIHSG` skipped whenever MAX(date) reached the
 * last closed session, so once a later bar landed the hole behind it was
 * permanent and no scheduled run would ever look again. Detection alone would
 * not have fixed that; the guard itself had to learn about holes.
 *
 * The reference is `idx_stock_prices`, the IDX trading calendar as this system
 * observes it. If a day is missing from BOTH, it is treated as a non-trading day
 * — which is the safe direction: this reports holes it can prove, not holes it
 * guesses at.
 */
async function missingSessions(pool, {
  table, col, reference = 'idx_stock_prices', referenceCol = 'date', days = 260,
  exclude = [],
} = {}) {
  const [[bounds]] = await pool.query(
    `SELECT MIN(${col}) AS lo, MAX(${col}) AS hi FROM ${table}`);
  if (!bounds.lo || !bounds.hi) return { missing: [], checked: 0, window: null };

  // WEEKENDS ARE EXCLUDED FROM THE CALENDAR, and not as a nicety. Found
  // 2026-08-04: idx_stock_prices holds 10 weekend dates whose rows are verbatim
  // copies of the preceding Friday (identical high, low, close and volume).
  // IDX does not trade on a Saturday, so those are phantom bars — and taking the
  // price table as the calendar without this filter made the gap detector demand
  // index closes for sessions that never happened, which no refetch could ever
  // supply. A detector that reports unfixable faults every night trains people
  // to ignore it. The phantom bars themselves are reported separately by
  // `phantomSessions` rather than quietly filtered away and forgotten.
  //
  // Never look before the table's own first row either: a series that
  // legitimately starts later than the calendar is not full of holes.
  // `exclude` carries the dates phantomSessions has already proven are not
  // sessions. Without it the detector demands an index close for every IDX
  // public holiday the price scraper wrote a placeholder bar on, no refetch can
  // ever supply one, and it reports the same unfixable fault every night. A
  // check that cries wolf nightly is a check people learn to skip, which is the
  // same silence it was built to end.
  const skip = exclude.length ? exclude : ['1000-01-01'];
  const [rows] = await pool.query(
    `SELECT DISTINCT r.${referenceCol} AS d
       FROM ${reference} r
      WHERE r.${referenceCol} >= GREATEST(?, DATE_SUB(?, INTERVAL ? DAY))
        AND r.${referenceCol} <= ?
        AND DAYOFWEEK(r.${referenceCol}) NOT IN (1, 7)
        AND r.${referenceCol} NOT IN (?)
        AND NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.${col} = r.${referenceCol})
      ORDER BY r.${referenceCol}`,
    [bounds.lo, bounds.hi, days, bounds.hi, skip]);

  const [[count]] = await pool.query(
    `SELECT COUNT(DISTINCT ${referenceCol}) AS n FROM ${reference}
      WHERE ${referenceCol} >= GREATEST(?, DATE_SUB(?, INTERVAL ? DAY)) AND ${referenceCol} <= ?
        AND DAYOFWEEK(${referenceCol}) NOT IN (1, 7)
        AND ${referenceCol} NOT IN (?)`,
    [bounds.lo, bounds.hi, days, bounds.hi, skip]);

  const iso = d => (d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10));

  return {
    missing: rows.map(r => iso(r.d)),
    checked: Number(count.n),
    window: { from: iso(bounds.lo), to: iso(bounds.hi), days },
  };
}

/**
 * Dates in the price table that cannot be real trading sessions.
 *
 * Found 2026-08-04 while building the gap detector, and the first reading of it
 * was WRONG. The initial spot check (2026-07-25, a Saturday) repeated the
 * previous Friday verbatim, so the conclusion was "weekend rows are copies of
 * Friday". Checking more dates broke that story: 2026-06-13 is a Saturday whose
 * close (5550) appears on neither the Friday before nor the Monday after, and
 * 2026-05-14 and 2026-05-27 are WEEKDAYS carrying open=high=low=close with zero
 * volume. Those two are IDX public holidays.
 *
 * So there is no single explanation, and pretending otherwise would make the
 * detector miss two thirds of it. Three independent signatures, each reported
 * with its own label:
 *
 *   WEEKEND           IDX does not trade Saturday or Sunday. Not an inference.
 *   ZERO_VOLUME_FLAT  open=high=low=close and no volume, across the whole date.
 *                     That is a placeholder bar, not a session — this is what a
 *                     public holiday looks like in this table.
 *   DUPLICATE_OF_PRIOR  the date's row count, close sum and volume sum all match
 *                     the previous date exactly. Across hundreds of tickers that
 *                     is not a coincidence, it is a carried-forward write.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Every rolling window in this system counts
 * BARS, not calendar days: ADV20, ATR14, the 252-day high, the 200-day SMA. A
 * phantom bar shifts all of them, and the return across it is 0% by
 * construction, which dilutes every volatility and momentum measure computed
 * over that span.
 *
 * Reported, never auto-deleted. Removing rows from the production price series
 * is irreversible, and re-ingesting the affected range may be the better fix —
 * that is a decision, not a repair.
 */
async function phantomSessions(pool, { table = 'idx_stock_prices', col = 'date', useIndexCalendar = true } = {}) {
  const [rows] = await pool.query(
    `SELECT ${col} AS d, COUNT(*) AS n,
            SUM(volume = 0 AND open_price = high_price AND high_price = low_price
                            AND low_price = close_price) AS flat,
            SUM(close_price) AS closeSum, SUM(volume) AS volSum,
            DAYOFWEEK(${col}) AS dow
       FROM ${table} GROUP BY ${col} ORDER BY ${col}`);

  // NO_INDEX_BAR — the strongest signature, and the one the three heuristics
  // below miss. ^JKSE is the exchange's own index: if it has no bar for a date,
  // IDX did not trade, whatever the price table says. This catches the holidays
  // whose price rows look ordinary enough to pass a flat-ratio test (2026-05-01,
  // 2026-06-01 and 2026-06-16 carried 31 to 120 tickers of plausible-looking
  // data for days the exchange was shut).
  //
  // Bounded to the index series' own range on purpose: outside it, absence of a
  // bar says nothing. And it is a WEAKER claim than the others in one specific
  // way — if the INDEX series itself has a hole, a real session would be flagged.
  // Callers repair index gaps before trusting this, and the label is reported
  // separately so that judgement stays visible rather than baked in.
  let indexed = null;
  if (useIndexCalendar) {
    try {
      const [[b]] = await pool.query('SELECT MIN(date) lo, MAX(date) hi FROM idx_ihsg_history');
      if (b.lo && b.hi) {
        const [idx] = await pool.query('SELECT date FROM idx_ihsg_history');
        indexed = {
          lo: b.lo, hi: b.hi,
          set: new Set(idx.map(r => (r.date instanceof Date
            ? `${r.date.getFullYear()}-${String(r.date.getMonth() + 1).padStart(2, '0')}-${String(r.date.getDate()).padStart(2, '0')}`
            : String(r.date).slice(0, 10)))),
        };
      }
    } catch { /* no index series: fall back to the heuristics alone */ }
  }

  const iso = d => (d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : String(d).slice(0, 10));

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], prev = rows[i - 1];
    const n = Number(r.n);
    const signatures = [];

    if (Number(r.dow) === 1 || Number(r.dow) === 7) signatures.push('WEEKEND');
    // A handful of flat bars is normal (an illiquid name that did not trade).
    // A date that is ALMOST ENTIRELY flat-and-volumeless is not a session.
    if (n > 0 && Number(r.flat) / n >= 0.8) signatures.push('ZERO_VOLUME_FLAT');
    if (prev && Number(prev.n) === n &&
        Number(prev.closeSum) === Number(r.closeSum) &&
        Number(prev.volSum) === Number(r.volSum)) signatures.push('DUPLICATE_OF_PRIOR');

    const d = iso(r.d);
    if (indexed && d >= iso(indexed.lo) && d <= iso(indexed.hi) && !indexed.set.has(d)) {
      signatures.push('NO_INDEX_BAR');
    }

    if (signatures.length) out.push({ date: d, rows: n, signatures });
  }
  return out;
}

/** Persistent job registry — survives restarts, unlike auxRefreshStatus. */
async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ft_system_health (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_name VARCHAR(64) NOT NULL,
      started_at TIMESTAMP NULL,
      finished_at TIMESTAMP NULL,
      status ENUM('OK','FAILED','RUNNING') NOT NULL,
      duration_ms INT NULL,
      records INT NULL,
      data_date DATE NULL,
      error TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_job (job_name, created_at)
    )`);
}

async function recordJobRun(pool, { job, status, durationMs, records, dataDate, error }) {
  try {
    await ensureTable(pool);
    await pool.query(
      `INSERT INTO ft_system_health (job_name, started_at, finished_at, status, duration_ms, records, data_date, error)
       VALUES (?, NOW() - INTERVAL ? SECOND, NOW(), ?, ?, ?, ?, ?)`,
      [job, Math.round((durationMs || 0) / 1000), status, durationMs ?? null,
       records ?? null, dataDate ?? null, error ? String(error).slice(0, 2000) : null]
    );
  } catch (e) {
    // Health recording must never break the job it is recording.
    console.error('[health] could not record job run:', e.message);
  }
}

/** Last outcome per job, plus a consecutive-failure count. */
async function jobHealth(pool) {
  try {
    await ensureTable(pool);
    const [rows] = await pool.query(`
      SELECT h.job_name, h.status, h.finished_at, h.duration_ms, h.records, h.error
        FROM ft_system_health h
        JOIN (SELECT job_name, MAX(id) AS id FROM ft_system_health GROUP BY job_name) l
          ON l.id = h.id
       ORDER BY h.job_name`);
    const out = [];
    for (const r of rows) {
      const [f] = await pool.query(
        `SELECT COUNT(*) AS n FROM ft_system_health
          WHERE job_name = ? AND id > COALESCE((SELECT MAX(id) FROM ft_system_health WHERE job_name = ? AND status = 'OK'), 0)
            AND status = 'FAILED'`, [r.job_name, r.job_name]);
      out.push({ ...r, consecutiveFailures: Number(f[0].n) || 0 });
    }
    return out;
  } catch { return []; }
}

/**
 * The kill switch.
 *
 * DISABLED means: produce no actionable output. Not "show a warning" — a warning
 * next to a signal still reads as a signal.
 *
 * @returns {{enabled:boolean, reasons:string[], detail:object[], checkedAt:string}}
 */
async function signalState(pool, opts = {}) {
  const fresh = await dataFreshness(pool, opts.today || new Date());
  const subsystems = opts.subsystems || [SUBSYSTEM.SIGNAL_ENGINE];
  const ready = await readiness(pool, { subsystems, today: opts.today || new Date(), freshness: fresh });

  // SEVERITY DECIDES, NOT A BOOLEAN. This function used to disable only on
  // `critical` staleness, and the reason given was that "a missing broker feed
  // degrades the veto, which is a weaker signal than silently trading on a stale
  // price series". That reasoning did not survive contact with the outage: the
  // scanner takes its DATE from the broker table, so a dead broker feed is not a
  // weakened veto, it is a stopped clock. Checked on 2026-08-09 with the feed
  // five sessions dead, this function still returned enabled:true — the kill
  // switch was green through the exact failure it exists to catch.
  const reasons = ready.blocking.map(r => `STALE_BLOCKING:${r}`);
  const warnings = [
    ...ready.degraded.map(r => `STALE_DEGRADED:${r}`),
    ...ready.advisory.map(r => `STALE_ADVISORY:${r}`),
    // Feeds outside the requested subsystems are still reported, so that
    // scoping the gate never becomes a way of not hearing about a dead feed.
    ...fresh.filter(f => !f.ok && !ready.detail.includes(f))
            .map(f => `OUT_OF_SCOPE:${f.severity}:${f.key}:${f.detail}`),
  ];

  // INCIDENT CARDINALITY (2026-08-09, review P2).
  //
  // With the broker feed dead this returned three reasons — broker stale,
  // concentration stale, and JOB_FAILING:watchdog — for ONE upstream fault. The
  // watchdog fails *because* the inputs it checks are stale, so counting its
  // failure as an independent problem inflates a single incident into several
  // and makes an operator triage three things that are one thing.
  //
  // watchdog.js already refuses to do this to itself: checkJobRegistry skips its
  // own rows because "the watchdog recording last night's failure and then
  // reporting that record as a fresh finding is circular". Same rule, applied
  // where it was missing.
  //
  // A monitor failing with NO stale input to explain it is still a real,
  // independent reason — it means the monitor broke on its own — so the
  // demotion is conditional, never blanket.
  const symptoms = [];
  const jobs = await jobHealth(pool);
  for (const j of jobs) {
    if (j.consecutiveFailures < 3) continue;
    const entry = `JOB_FAILING:${j.job_name}:${j.consecutiveFailures} consecutive failures`;
    if (reasons.length && /^watchdog/.test(String(j.job_name))) symptoms.push(entry);
    else reasons.push(entry);
  }

  if (opts.expectedModelVersion && opts.actualModelVersion &&
      opts.expectedModelVersion !== opts.actualModelVersion) {
    reasons.push(`MODEL_VERSION_MISMATCH:${opts.actualModelVersion} != ${opts.expectedModelVersion}`);
  }

  if (ready.blocking.length) {
    symptoms.push('SCANNER_BLOCKED:/api/signal-scanner returns 503');
    symptoms.push('BURN_IN_BLOCKED:no session can be recorded clean');
  }

  // One named cause, with the consequences hanging off it, rather than a flat
  // list in which cause and effect look alike.
  const rootCause = ready.blocking.length
    ? { code: 'INPUT_DATA_STALE',
        inputs: ready.blocking.map(b => b.split(':')[0]),
        detail: ready.blocking }
    : (reasons.length ? { code: reasons[0].split(':')[0], detail: [reasons[0]] } : null);

  return {
    enabled: reasons.length === 0,
    rootCause,
    symptoms,
    // DEGRADED does not stop output, but it must travel WITH it. A caller that
    // renders `enabled` and drops this is back to a warning beside a signal,
    // which still reads as a signal.
    degraded: ready.degradedMode,
    degradedReasons: ready.degraded,
    signalDate: ready.signalDate,
    limitedBy: ready.limitedBy,
    reasons,
    warnings,
    detail: fresh,
    jobs,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  CHECKS, dataFreshness, missingSessions, phantomSessions, recordJobRun, jobHealth,
  signalState, readiness, ensureTable, weekdaysSince,
  expectedBrokerSession, assertCompleteSessions, brokerFreshness, BROKER_FRESHNESS,
  MAX_REFERENCE_WEEKDAYS, BROKER_DATA_MAX_LAG_SESSIONS, REFERENCE,
  BROKER_PIPELINE_CUTOFF_UTC_MINUTES, BROKER_PIPELINE_GRACE_MINUTES,
  SEVERITY, SEVERITY_RANK, binds, SUBSYSTEM, SUBSYSTEM_DEPENDS_ON,
};
