/**
 * The burn-in streak — one definition, used everywhere.
 *
 * WHY THIS IS A SHARED MODULE
 * ---------------------------
 * watchdog.js and server.js each computed the streak with their own loop. Two
 * implementations of the same claim drift, and the first time they disagree the
 * dashboard and the monitor are telling the operator two different stories about
 * whether the record is valid. There is one function now and both call it.
 *
 * TWO THINGS THE OLD LOOP GOT WRONG, both found by the 2026-08-06 review:
 *
 * 1. SILENCE COUNTED AS EVIDENCE. It walked the rows that happened to exist and
 *    stopped at the first failure. If Tuesday's watchdog never ran there was no
 *    Tuesday row at all, so Monday, Wednesday and Thursday read as three
 *    consecutive clean sessions. They are not: nothing is known about Tuesday,
 *    and "nothing is known" is not "nothing went wrong". The streak now walks
 *    the IHSG session calendar and stops the moment a session has no verdict.
 *
 * 2. A FAILURE COULD BE PROMOTED TO A PASS. The verdict row was upserted, so a
 *    second watchdog run on a repaired system rewrote passed=0 to passed=1 and
 *    the session joined the streak. The burn-in's own rule is that any failure
 *    in a session breaks it — so attempts are append-only and the day's verdict
 *    is the WORST attempt, not the latest.
 */
'use strict';

const iso = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : d ? String(d).slice(0, 10) : null);

async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_burnin_attempt (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_date DATE NOT NULL,
      identity_hash VARCHAR(32) NOT NULL,
      engine_version INT NOT NULL DEFAULT 0,
      passed TINYINT(1) NOT NULL,
      checks_json TEXT NULL,
      failures_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_session (identity_hash, session_date)
    )`);
}

/**
 * Record one attempt and return the session's verdict.
 *
 * The attempt row is INSERTed, never updated — the history of what each run saw
 * is the audit trail. The verdict row in `virtual_burnin` is then derived as the
 * worst attempt for that session, so a repaired re-run can never lift a session
 * that has already failed.
 */
async function recordAttempt(pool, { sessionDate, identityHash, engineVersion, passed, checks, failures }) {
  await ensureTables(pool);
  await pool.query(
    `INSERT INTO virtual_burnin_attempt
       (session_date, identity_hash, engine_version, passed, checks_json, failures_json)
     VALUES (?,?,?,?,?,?)`,
    [sessionDate, identityHash, engineVersion, passed ? 1 : 0,
     JSON.stringify(checks), failures && failures.length ? JSON.stringify(failures) : null]);

  // The worst attempt wins. MIN(passed) is 0 if any attempt failed.
  const [[worst]] = await pool.query(
    `SELECT MIN(passed) p, COUNT(*) attempts FROM virtual_burnin_attempt
      WHERE identity_hash=? AND session_date=?`, [identityHash, sessionDate]);
  const verdict = Number(worst.p) === 1;

  // Every failure this session ever produced, so the verdict row explains itself.
  const [failRows] = await pool.query(
    `SELECT failures_json FROM virtual_burnin_attempt
      WHERE identity_hash=? AND session_date=? AND passed=0 ORDER BY id`, [identityHash, sessionDate]);
  const allFailures = failRows.flatMap(r => (r.failures_json ? JSON.parse(r.failures_json) : []));

  await pool.query(
    `INSERT INTO virtual_burnin (session_date, identity_hash, engine_version, passed, checks_json, failures_json)
     VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       -- LEAST, never VALUES(): a session that has failed cannot be promoted.
       passed = LEAST(passed, VALUES(passed)),
       checks_json = VALUES(checks_json),
       failures_json = VALUES(failures_json)`,
    [sessionDate, identityHash, engineVersion, verdict ? 1 : 0,
     JSON.stringify(checks), allFailures.length ? JSON.stringify(allFailures) : null]);

  return { verdict, attempts: Number(worst.attempts), allFailures };
}

/**
 * Consecutive clean sessions, counted along the exchange calendar.
 *
 * Walks back from the latest session in `idx_ihsg_history`. A session with no
 * verdict row stops the count exactly as a failed one does — the whole point is
 * that an unobserved night cannot be assumed clean.
 */
async function computeStreak(pool, identityHash, latestSession = null) {
  await ensureTables(pool);
  const [[last]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const end = latestSession || iso(last?.d);
  if (!end) return { streak: 0, sessions: [], stoppedBy: 'NO_CALENDAR' };

  // Enough calendar to cover any plausible streak, newest first.
  const [sessions] = await pool.query(
    'SELECT date FROM idx_ihsg_history WHERE date <= ? ORDER BY date DESC LIMIT 120', [end]);
  const [rows] = await pool.query(
    `SELECT session_date, passed FROM virtual_burnin WHERE identity_hash=?`, [identityHash]);
  const byDate = new Map(rows.map(r => [iso(r.session_date), Number(r.passed)]));

  const walked = [];
  let streak = 0, stoppedBy = 'END_OF_CALENDAR';
  for (const s of sessions) {
    const d = iso(s.date);
    const v = byDate.get(d);
    if (v === undefined) { stoppedBy = `NO_EVIDENCE_FOR_${d}`; walked.push({ date: d, state: 'MISSING' }); break; }
    if (!v) { stoppedBy = `FAILED_${d}`; walked.push({ date: d, state: 'FAILED' }); break; }
    walked.push({ date: d, state: 'CLEAN' });
    streak++;
  }
  return { streak, sessions: walked, stoppedBy };
}

module.exports = { ensureTables, recordAttempt, computeStreak, iso };
