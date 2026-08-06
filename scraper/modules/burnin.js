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

/**
 * THE RULES THEMSELVES ARE PART OF THE IDENTITY.
 *
 * experimentIdentity moves when the strategy hash, policy hash, engine version
 * or roster change — everything about WHAT is being measured. It does not move
 * when the way of measuring changes, and on 2026-08-06 that changed materially:
 * a failure became permanent, attempts became append-only, and an unobserved
 * session began breaking the streak. Sessions recorded under the loose rules
 * would otherwise have counted toward a streak the strict rules define.
 *
 * Five development sessions marked clean under v1 plus one clean night under v2
 * would have read 6/10. The official count has to start structurally at 0.
 *
 * BUMP THIS whenever a change would make an older session's verdict mean
 * something different: what counts as clean, how a verdict is decided, or how
 * the streak is walked. The old rows stay exactly where they are; they simply
 * belong to a protocol that is no longer being run.
 *
 * History:
 *   1  latest attempt won; a missing session was skipped over  (2026-08-05)
 *   2  failure sticky, attempts append-only, worst attempt wins,
 *      streak walks the exchange calendar                      (2026-08-06)
 */
const BURNIN_PROTOCOL_VERSION = 2;

/**
 * The identity a burn-in row belongs to: the experiment AND the protocol used
 * to judge it. Kept separate from experimentIdentity so the dashboard can still
 * show which strategy this is, without the two being conflated.
 */
function burninIdentity(experimentIdentity) {
  return require('crypto').createHash('sha256')
    .update(JSON.stringify({ experimentIdentity, burninProtocolVersion: BURNIN_PROTOCOL_VERSION }))
    .digest('hex').slice(0, 16);
}

const iso = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : d ? String(d).slice(0, 10) : null);

/**
 * ALL of the burn-in schema, in one place.
 *
 * `virtual_burnin` was created inside watchdog.recordBurnIn while the attempt
 * table was created here, so on a fresh database — a new environment, a disaster
 * recovery, a test that calls recordAttempt without running the watchdog first —
 * recordAttempt wrote to a table that did not exist. Schema ownership belongs
 * with the module that uses it.
 */
async function ensureTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_burnin (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_date DATE NOT NULL,
      identity_hash VARCHAR(32) NOT NULL DEFAULT 'legacy',
      engine_version INT NOT NULL DEFAULT 0,
      passed TINYINT(1) NOT NULL,
      checks_json TEXT NULL,
      failures_json TEXT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_session (identity_hash, session_date)
    )`);

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

  // ONE TRANSACTION. These were four separate statements, so a crash after the
  // attempt INSERT and before the summary UPSERT left the attempt saying FAILED
  // while the summary still said CLEAN. computeStreak reads the attempts now,
  // so that window could no longer produce a wrong streak — but a summary that
  // disagrees with its own source is still a lie waiting to be read.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO virtual_burnin_attempt
         (session_date, identity_hash, engine_version, passed, checks_json, failures_json)
       VALUES (?,?,?,?,?,?)`,
      [sessionDate, identityHash, engineVersion, passed ? 1 : 0,
       JSON.stringify(checks), failures && failures.length ? JSON.stringify(failures) : null]);

    // The worst attempt wins. MIN(passed) is 0 if any attempt failed.
    const [[worst]] = await conn.query(
      `SELECT MIN(passed) p, COUNT(*) attempts FROM virtual_burnin_attempt
        WHERE identity_hash=? AND session_date=?`, [identityHash, sessionDate]);
    const verdict = Number(worst.p) === 1;

    // Every failure this session ever produced, so the verdict row explains itself.
    const [failRows] = await conn.query(
      `SELECT failures_json FROM virtual_burnin_attempt
        WHERE identity_hash=? AND session_date=? AND passed=0 ORDER BY id`, [identityHash, sessionDate]);
    const allFailures = failRows.flatMap(r => (r.failures_json ? JSON.parse(r.failures_json) : []));

    await conn.query(
      `INSERT INTO virtual_burnin (session_date, identity_hash, engine_version, passed, checks_json, failures_json)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         passed = LEAST(passed, VALUES(passed)),
         checks_json = VALUES(checks_json),
         failures_json = VALUES(failures_json)`,
      [sessionDate, identityHash, engineVersion, verdict ? 1 : 0,
       JSON.stringify(checks), allFailures.length ? JSON.stringify(allFailures) : null]);

    await conn.commit();
    return { verdict, attempts: Number(worst.attempts), allFailures };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally { conn.release(); }
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

  // FROM THE APPEND-ONLY ATTEMPTS, not the summary. `virtual_burnin` is a cache
  // for the dashboard; if a crash ever left it behind its own source, reading it
  // here would count a session clean whose failure is sitting in the attempt
  // table. The source of truth is the thing that is only ever appended to.
  const [rows] = await pool.query(
    `SELECT session_date, MIN(passed) passed FROM virtual_burnin_attempt
      WHERE identity_hash=? GROUP BY session_date`, [identityHash]);
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

module.exports = { ensureTables, recordAttempt, computeStreak, iso,
                   BURNIN_PROTOCOL_VERSION, burninIdentity };
