'use strict';
/**
 * Did the US additions to the nightly cron actually fire? A ONE-TIME check that
 * retires itself.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Three things were wired into runDailyCron() on Saturday 2026-09-05 -- the
 * us_signal_history sync, the S&P factor snapshot, and the fetchAndCacheSP500
 * date fix. The cron fires weekdays after 12:30 UTC, so on the day they were
 * written NONE of them had ever run. Every verification was by invoking the code
 * paths directly, which proves the code works and proves nothing about whether
 * the scheduler reaches it.
 *
 * That distinction is the whole subject of this project's worst bugs. The S&P
 * refresh being fixed here was itself a function that ran nightly, reported
 * ok:true, and did nothing for six weeks.
 *
 * ── WHY IT IS NOT JUST A WATCHDOG CHECK ──────────────────────────────────────
 *
 * The watchdog now covers us_prices / us_signals / us_sp500 and would flag them
 * going stale. But it answers "is the data fresh", not "did the thing I wired on
 * Saturday get reached", and those come apart: us_signal_history could look
 * fresh for days on the manual sync already run, while the cron path stays
 * broken.
 *
 * This asks the narrower question by comparing against the state as it stood
 * BEFORE any cron could have run.
 *
 * ── WHY IT RETIRES ITSELF ────────────────────────────────────────────────────
 *
 * A one-time verification left on a schedule becomes noise, and noise is how the
 * next real signal gets ignored. CRONTAB.md puts it directly: "a fault that
 * self-heals every night is a bug in hiding" -- a check that passes every night
 * forever is the same disease. On a definitive PASS it removes its own crontab
 * line, backs the crontab up first, and refuses to install the result if the
 * other entries did not survive.
 *
 * Usage:
 *   node scraper/verify_us_cron_fired.js            # check, retire on PASS
 *   node scraper/verify_us_cron_fired.js --no-retire
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { execFileSync } = require('child_process');
const fs = require('fs');
const { createPool } = require('./modules/db_config');
const sh = require('./modules/system_health');

const NO_RETIRE = process.argv.includes('--no-retire');
const CRON_MARKER = 'verify_us_cron_fired.js';

/**
 * The state on Saturday 2026-09-05, captured after the wiring and before any
 * weekday cron could have run. These are observations, not configuration --
 * changing them to make the check pass would defeat the only thing it does.
 */
const BASELINE = {
  // RE-CAPTURED after the 2026-09-05 manual fills. The first baseline was taken
  // before them and would have passed on work I did by hand rather than on
  // anything the scheduler reached -- which is the one thing this check exists
  // to distinguish.
  capturedAt: '2026-09-05 (post-fill)',
  usSignalHistoryLatest: '2026-09-04',
  sp500HistoryLatest: '2026-09-04',
  sp500FactorRows: 5003,
};

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);

/** Remove our own line from the crontab, verifying nothing else was lost. */
function retireFromCrontab() {
  let before;
  try { before = execFileSync('crontab', ['-l'], { encoding: 'utf8' }); }
  catch { return { retired: false, reason: 'could not read crontab' }; }

  const lines = before.split('\n');
  const keep = lines.filter(l => !l.includes(CRON_MARKER));
  if (keep.length === lines.length) return { retired: false, reason: 'no crontab entry found' };

  // Everything that is not ours must survive verbatim. Without this a bad
  // filter would silently take the nightly pull with it.
  const otherBefore = lines.filter(l => !l.includes(CRON_MARKER)).join('\n');
  if (keep.join('\n') !== otherBefore) return { retired: false, reason: 'refused: other entries would change' };

  const backup = `/root/crontab.bak.retire-${Date.now()}`;
  try {
    fs.writeFileSync(backup, before);
    execFileSync('crontab', ['-'], { input: keep.join('\n') });
  } catch (e) { return { retired: false, reason: `install failed: ${e.message}` }; }

  const after = execFileSync('crontab', ['-l'], { encoding: 'utf8' });
  if (after.includes(CRON_MARKER)) return { retired: false, reason: 'entry still present after install' };
  return { retired: true, backup, linesBefore: lines.length, linesAfter: after.split('\n').length };
}

(async () => {
  const pool = createPool();
  const started = Date.now();
  const line = s => console.log(s);
  line(`[${new Date().toISOString()}] verify_us_cron_fired`);
  line(`  baseline captured ${BASELINE.capturedAt}, before any weekday cron could run`);

  const [[sig]] = await pool.query('SELECT MAX(data_date) d FROM us_signal_history');
  const [[spx]] = await pool.query('SELECT MAX(date) d FROM sp500_history');
  const [[fac]] = await pool.query('SELECT COUNT(*) n FROM sp500_factor_history');

  const checks = [
    { key: 'us_signal_history advanced', was: BASELINE.usSignalHistoryLatest, now: iso(sig.d),
      ok: iso(sig.d) > BASELINE.usSignalHistoryLatest,
      why: 'the nightly syncUsSignalHistory call' },
    { key: 'sp500_history advanced', was: BASELINE.sp500HistoryLatest, now: iso(spx.d),
      ok: iso(spx.d) > BASELINE.sp500HistoryLatest,
      why: 'the fetchAndCacheSP500 date-comparison fix' },
    // The clearest tell of the three: before Saturday this table could only ever
    // grow when a human opened /api/sp500-factors, so an increase is proof the
    // CRON reached it rather than proof someone browsed.
    { key: 'sp500_factor_history grew', was: `${BASELINE.sp500FactorRows} rows`, now: `${fac.n} rows`,
      ok: Number(fac.n) > BASELINE.sp500FactorRows,
      why: 'the saveSP500FactorSnapshot call — previously only a page view wrote this' },
  ];

  line('');
  for (const c of checks) {
    line(`  ${c.ok ? 'PASS' : 'not yet'}  ${c.key.padEnd(28)} ${String(c.was).padEnd(12)} -> ${String(c.now)}`);
    if (!c.ok) line(`            waiting on: ${c.why}`);
  }

  const passed = checks.every(c => c.ok);
  const weekday = new Date().getUTCDay();
  // Before the first weekday cron has had a chance, "not yet" is the expected
  // answer and must not be recorded as a failure -- a check that cries wolf on
  // Sunday teaches its reader to ignore it on Tuesday.
  const tooEarly = !passed && (weekday === 0 || weekday === 6);

  line('');
  line(`  VERDICT: ${passed ? 'PASS — the cron reached all three'
    : tooEarly ? 'PENDING — no weekday cron has run since the baseline'
      : 'FAIL — a weekday cron has run and at least one addition was not reached'}`);

  let retire = { retired: false, reason: 'not attempted' };
  if (passed && !NO_RETIRE) {
    retire = retireFromCrontab();
    line(`  retire: ${retire.retired
      ? `removed from crontab (backup ${retire.backup}, ${retire.linesBefore} -> ${retire.linesAfter} lines)`
      : `NOT removed — ${retire.reason}`}`);
    if (!retire.retired) line('          remove it by hand; a passing one-time check left running is noise.');
  }

  await sh.recordJobRun(pool, {
    job: 'verify_us_cron_fired',
    status: passed ? 'OK' : tooEarly ? 'OK' : 'FAILED',
    durationMs: Date.now() - started,
    records: checks.filter(c => c.ok).length,
    error: passed ? null
      : `${tooEarly ? 'PENDING' : 'FAIL'}: ` + checks.filter(c => !c.ok).map(c => c.key).join(', '),
  });

  await pool.end();
  process.exitCode = passed || tooEarly ? 0 : 1;
})().catch(e => { console.error('verify_us_cron_fired FAILED:', e.stack || e.message); process.exit(1); });
