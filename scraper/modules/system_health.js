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

const CHECKS = [
  // key                 table                  dateCol      maxLagTradingDays  critical
  { key: 'prices',       table: 'idx_stock_prices',    col: 'date',        maxLag: 1, critical: true,
    why: 'Every factor, regime and backtest reads prices. Stale prices mean stale everything.' },
  { key: 'broker',       table: 'idx_broker_summary',  col: 'date',        maxLag: 2, critical: false,
    why: 'Broker flow lags by design (Index Alpha publishes ~19:00 WIB) and only the veto uses it.' },
  { key: 'concentration',table: 'idx_concentration',   col: 'data_date',   maxLag: 2, critical: false,
    why: 'Derived from broker data; the POSFRAC veto degrades gracefully when it is missing.' },
  { key: 'ihsg',         table: 'idx_ihsg_history',    col: 'date',        maxLag: 1, critical: true,
    why: 'The 200-day regime filter is the one layer proven to transfer out of sample. Without a fresh IHSG it cannot be evaluated, and defaulting to "invested" is exactly the wrong failure direction.' },
  // Added 2026-08-03 after finding ft_signals had been stale since 2026-05-30.
  // signal_engine.py had a SyntaxError and, later, an unquoted MySQL reserved
  // word. paper_trader.py kept running eight times a day and logging "Found 0
  // BUY/STRONG_BUY signals", which is indistinguishable from a quiet market.
  // Two months of silence. This check is the whole argument for deriving health
  // from data rather than from whether a job reported an error.
  { key: 'signals',      table: 'ft_signals',          col: 'signal_date', maxLag: 3, critical: false,
    why: 'Feeds paper_trader.py. When it goes stale the paper trader still runs and still reports zero trades, which reads as a quiet market rather than a broken pipeline.' },
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

  const out = [];
  if (reference !== null) {
    const drift = weekdaysSince(reference, today);
    out.push({
      key: 'ingest', table: '(all monitored feeds)', critical: true,
      why: 'Measured against the clock, not against another table. Every per-table lag below is relative to this bar, so if this is stale everything else is fresh relative to a frozen yardstick and a total outage reads as all-green.',
      latest: reference, lagTradingDays: drift, maxLag: MAX_REFERENCE_WEEKDAYS, rows: null,
      ok: drift <= MAX_REFERENCE_WEEKDAYS,
      detail: drift <= MAX_REFERENCE_WEEKDAYS ? 'fresh'
        : `no feed has produced data for ${drift} weekdays (tolerance ${MAX_REFERENCE_WEEKDAYS})`,
    });
  }

  for (const c of CHECKS) {
    try {
      const [r] = await pool.query(`SELECT MAX(${c.col}) AS d, COUNT(*) AS n FROM ${c.table}`);
      const latest = r[0].d;
      if (!latest) {
        out.push({ ...c, latest: null, lagTradingDays: null, ok: false, detail: 'table is empty' });
        continue;
      }
      const d = latest instanceof Date ? latest.toISOString().slice(0, 10) : String(latest).slice(0, 10);
      const lag = await tradingDayLag(pool, d, reference);
      out.push({ key: c.key, table: c.table, critical: c.critical, why: c.why,
                 latest: d, lagTradingDays: lag, maxLag: c.maxLag, rows: Number(r[0].n),
                 ok: lag <= c.maxLag,
                 detail: lag <= c.maxLag ? 'fresh' : `${lag} trading days behind (tolerance ${c.maxLag})` });
    } catch (e) {
      out.push({ ...c, latest: null, lagTradingDays: null, ok: false, detail: `query failed: ${e.message}` });
    }
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
  const reasons = [];
  const fresh = await dataFreshness(pool, opts.today || new Date());

  for (const f of fresh) {
    if (f.ok) continue;
    reasons.push(`${f.critical ? 'STALE_CRITICAL' : 'STALE_NONCRITICAL'}:${f.key}:${f.detail}`);
  }

  const jobs = await jobHealth(pool);
  for (const j of jobs) {
    if (j.consecutiveFailures >= 3) reasons.push(`JOB_FAILING:${j.job_name}:${j.consecutiveFailures} consecutive failures`);
  }

  if (opts.expectedModelVersion && opts.actualModelVersion &&
      opts.expectedModelVersion !== opts.actualModelVersion) {
    reasons.push(`MODEL_VERSION_MISMATCH:${opts.actualModelVersion} != ${opts.expectedModelVersion}`);
  }

  // Only CRITICAL staleness and repeated job failure disable output. A missing
  // broker feed degrades the veto, which is a weaker signal than silently
  // trading on a stale price series — so it warns rather than disables.
  const blocking = reasons.filter(r => r.startsWith('STALE_CRITICAL') || r.startsWith('JOB_FAILING') || r.startsWith('MODEL_VERSION_MISMATCH'));

  return {
    enabled: blocking.length === 0,
    reasons: blocking,
    warnings: reasons.filter(r => !blocking.includes(r)),
    detail: fresh,
    jobs,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = { CHECKS, dataFreshness, recordJobRun, jobHealth, signalState, ensureTable, weekdaysSince, MAX_REFERENCE_WEEKDAYS };
