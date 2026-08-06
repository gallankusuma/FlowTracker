/**
 * Watchdog — find what broke tonight, repair what is safely repairable, and be
 * loud about what is not.
 *
 * WHY THIS EXISTS
 * ---------------
 * The recurring failure in this system is not that things break. It is that
 * they break while reporting success:
 *
 *   - `signal_engine.py hk` failed 45 nights running; the only trace was a log.
 *   - `ft-pull` returned `success: true, stocks: 0` for 47 days.
 *   - `fetchAndCacheIHSG()` returned `{ skipped: true }` forever on a string bug.
 *   - `idx_ihsg_history` lost 2026-08-03 while every freshness check stayed green,
 *     and the "already current" guard made the hole permanent.
 *   - `strategy_forward.js fill` died at setup() on 2026-08-04 and the two later
 *     stages ran fine, so nothing looked wrong the next morning.
 *
 * Every one of those was found by a human happening to look. That is not a
 * monitoring strategy, it is luck with a rota.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO
 * -----------------------------------------
 * Repairs here are limited to actions that are (a) idempotent, (b) sourced from
 * real upstream data, and (c) verified afterwards. Re-running a refetch is a
 * repair. Interpolating a missing bar is NOT — a fabricated close would make the
 * regime filter confident about a session that never happened, which is worse
 * than the hole.
 *
 * ONE ATTEMPT PER RUN. Not a retry loop. If one attempt does not fix it, the
 * problem is not transient and hammering it only buries the evidence.
 *
 * A SELF-HEALING FAILURE IS STILL A FAILURE.
 * This is the part that is easy to get wrong. A watchdog that quietly repairs
 * the same fault every single night has not fixed anything — it has converted a
 * loud bug into a silent one, which is precisely the disease. So every repair is
 * recorded, and a repair that keeps recurring is ESCALATED: `RECURRING` is
 * reported as a failure even though the repair itself worked.
 *
 * Exit codes:  0 all clear (or everything repaired and not recurring)
 *              1 something is broken, or a repair keeps having to happen
 *
 * Usage:  node watchdog.js            detect and repair
 *         node watchdog.js --dry-run  detect only, change nothing
 */
'use strict';
require('dotenv').config();

const mysql = require('mysql2/promise');
const sh = require('./modules/system_health');
const ihsgModule = require('./modules/ihsg');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'erp_user',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'erp_manufacturing',
};

/** A repair that fires on this many of the last RECUR_WINDOW nights is not a repair, it is a symptom. */
const RECUR_THRESHOLD = 3;
const RECUR_WINDOW = 7;

const DRY = process.argv.includes('--dry-run');

const findings = [];
const report = (o) => { findings.push(o); return o; };

const line = (s = '') => console.log(s);
const iso = d => (d instanceof Date
  ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  : d ? String(d).slice(0, 10) : null);

/**
 * How many of the last RECUR_WINDOW days already logged this repair. Reads the
 * job registry rather than any in-process state, so a restart cannot reset a
 * recurring problem's counter back to zero.
 */
async function repairRecurrence(pool, job) {
  const [[r]] = await pool.query(
    `SELECT COUNT(DISTINCT DATE(finished_at)) n FROM ft_system_health
      WHERE job_name = ? AND status = 'OK' AND finished_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [job, RECUR_WINDOW]);
  return Number(r.n) || 0;
}

async function runRepair(pool, { job, what, fix, verify }) {
  if (DRY) {
    report({ level: 'WOULD_REPAIR', what, detail: 'dry run — nothing was changed' });
    line(`  would repair: ${what}`);
    return;
  }
  const started = new Date();
  let result, error = null;
  try { result = await fix(); }
  catch (e) { error = e; }

  const stillBroken = error ? true : await verify();
  await sh.recordJobRun(pool, {
    job, status: stillBroken ? 'FAILED' : 'OK',
    durationMs: Date.now() - started.getTime(),
    error: error ? error.message : (stillBroken ? 'repair ran but the fault is still present' : null),
  });

  if (stillBroken) {
    report({ level: 'FAIL', what, detail: error ? error.message : 'repair ran and the fault is STILL present' });
    line(`  ** REPAIR FAILED: ${what}`);
    line(`     ${error ? error.message : 'the fault is still present after the repair ran'}`);
    return;
  }

  // Repaired — but how often has this had to happen?
  const seen = await repairRecurrence(pool, job);
  if (seen >= RECUR_THRESHOLD) {
    report({
      level: 'RECURRING', what,
      detail: `repaired, but this repair has fired on ${seen} of the last ${RECUR_WINDOW} days — the underlying cause is not fixed`,
    });
    line(`  ** REPAIRED, BUT RECURRING: ${what}`);
    line(`     ${seen} of the last ${RECUR_WINDOW} days. A repair this regular is hiding a bug, not fixing one.`);
  } else {
    report({ level: 'REPAIRED', what, detail: JSON.stringify(result || {}).slice(0, 300) });
    line(`  repaired: ${what}`);
  }
}

/* ── check 1: holes in the middle of the index series ──────────────────────
   Repairable, and the repair is real: refetch the range from Yahoo. The upsert
   is keyed on date, so this fills holes without touching anything else. */
async function checkIhsgGaps(pool, phantomDates = []) {
  line('\nIHSG series — holes behind the latest bar');
  // The calendar is idx_stock_prices MINUS the dates already proven not to be
  // sessions. Without that subtraction this demanded an index close for every
  // IDX public holiday the price scraper wrote a placeholder bar on — seven of
  // them, none of which Yahoo can ever supply, failing every night forever.
  const gaps = await sh.missingSessions(pool, {
    table: 'idx_ihsg_history', col: 'date', exclude: phantomDates });
  if (!gaps.missing.length) {
    line(`  ok — ${gaps.checked} trading sessions ${gaps.window?.from}..${gaps.window?.to}, none missing`);
    return;
  }
  line(`  ${gaps.missing.length} session(s) missing: ${gaps.missing.slice(0, 12).join(', ')}${gaps.missing.length > 12 ? ' …' : ''}`);
  line('  every freshness check reads MAX(date) and cannot see these.');

  let sourceDates = null;
  await runRepair(pool, {
    job: 'watchdog:ihsg_gaps',
    what: `${gaps.missing.length} missing IHSG session(s)`,
    fix: async () => {
      const { fetchYahooCandles } = require('./yahoo-candles');
      const r = await ihsgModule.refreshIHSG(pool, fetchYahooCandles, { force: true, range: '2y' });
      sourceDates = new Set(r.sourceDates || []);
      return r;
    },
    verify: async () => {
      const after = await sh.missingSessions(pool, {
        table: 'idx_ihsg_history', col: 'date', exclude: phantomDates });
      if (!after.missing.length) return false;

      // ^JKSE is the exchange's own index, so the source's calendar decides what
      // a session is. A date the source does not have was never a trading day —
      // the fault is a phantom PRICE row, not a missing index bar, and calling
      // it an index gap would fail every night on a holiday that cannot be
      // fixed. That is how a monitor teaches people to ignore it.
      const unfixable = sourceDates ? after.missing.filter(d => !sourceDates.has(d)) : [];
      const real = after.missing.filter(d => !unfixable.includes(d));

      if (unfixable.length) {
        line(`     ${unfixable.length} of these are not sessions at all: ${unfixable.join(', ')}`);
        line('     ^JKSE has no bar for them, so IDX did not trade. The real fault is on the');
        line('     PRICE side: idx_stock_prices carries rows for days the exchange was shut.');
        report({
          level: 'WARN',
          what: `${unfixable.length} date(s) in idx_stock_prices that IDX never traded`,
          detail: `${unfixable.join(', ')}. The index source has no bar for them. Reported against the price table, not as an index gap — an index gap here is unfixable by definition and would fail forever.`,
        });
      }
      if (real.length) {
        line(`     STILL MISSING and the source HAS them: ${real.join(', ')}`);
        line('     NOT interpolated — a made-up close would make the regime filter');
        line('     confident about a day it has no price for.');
      }
      return real.length > 0;
    },
  });
}

/* ── check 1b: sessions that cannot have happened ──────────────────────────
   Reported, never auto-deleted: dropping rows from the production price series
   is irreversible, and re-ingesting the affected range may be the better fix.
   That is a decision, not a repair. */
async function checkPhantomSessions(pool) {
  line('\nPrice series — dates that cannot be trading sessions');
  const phantom = await sh.phantomSessions(pool);
  if (!phantom.length) { line('  ok — every date looks like a real session'); return []; }

  line(`  ${phantom.length} date(s) carrying ${phantom.reduce((a, p) => a + p.rows, 0)} rows:`);
  for (const p of phantom) line(`    ${p.date}  ${String(p.rows).padStart(4)} rows   ${p.signatures.join(' + ')}`);
  line('  WEEKEND            IDX does not trade Saturday or Sunday.');
  line('  ZERO_VOLUME_FLAT   open=high=low=close with no volume — a placeholder bar,');
  line('                     which is what an IDX public holiday looks like here.');
  line('  DUPLICATE_OF_PRIOR row count, close sum and volume sum all match the');
  line('                     previous date exactly — a carried-forward write.');
  line('  Every rolling window in this system counts BARS: ADV20, ATR14, the 252-day');
  line('  high, the 200-day SMA. A phantom bar shifts all of them.');
  // RECENT phantoms mean the ingest is producing them NOW — that is a live
  // fault. Old ones are data debt: real, worth fixing, but scoring them as a
  // failure every night would hold the burn-in streak hostage to 2017 forever,
  // and a check that can never be satisfied is a check people route around.
  const [[sess]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const cutoff = (() => {
    const base = iso(sess?.d) || new Date().toISOString().slice(0, 10);
    const d = new Date(`${base}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const recent = phantom.filter(p => p.date >= cutoff);
  const historical = phantom.filter(p => p.date < cutoff);

  if (historical.length) {
    report({
      level: 'WARN',
      what: `${historical.length} historical phantom date(s) in idx_stock_prices (data debt)`,
      detail: `oldest ${historical[0].date}, newest ${historical[historical.length - 1].date}. Not scored against the daily burn-in: the ingest guard stops new ones, and blocking the streak on years-old rows would make it unreachable. Purge or re-ingest deliberately with purge_phantom_sessions.js.`,
    });
    line(`  ${historical.length} of these are older than ${cutoff} — data debt, reported but not scored daily.`);
  }
  if (!recent.length) return phantom.map(p => p.date);

  const byYear = {};
  for (const p of recent) (byYear[p.date.slice(0, 4)] ||= []).push(p.date);
  report({
    level: 'FAIL',
    what: `${recent.length} phantom date(s) written since ${cutoff} — the ingest is producing them now`,
    // Summarised by year. The full list is printed above; repeating 72 dates in
    // the summary makes the one line a reader actually sees unreadable.
    detail: `${Object.entries(byYear).map(([y, d]) => `${y}: ${d.length}`).join(', ')}` +
      `. Most recent: ${phantom.slice(-3).map(p => p.date).join(', ')}.` +
      ' NOT auto-deleted: removing production price rows is irreversible and re-ingesting the range may be the better fix.',
  });
  return phantom.map(p => p.date);
}

/* ── check 1c: real sessions the price table is missing ────────────────────
   The mirror of the gap check, and it only became meaningful once the phantom
   rows were purged on 2026-08-04: eight of those dates had genuine ^JKSE bars
   with real volume, so the exchange DID trade and the price rows were a scraper
   failure rather than a holiday. Deleting them was right — an absent bar is
   honest where a fabricated flat one is not — but it leaves real holes, and a
   hole nothing looks for is how this all started. Not auto-repaired: back-filling
   per-stock OHLC for 2018 needs a historical source this system does not have. */
async function checkPriceGaps(pool) {
  line('\nPrice series — trading sessions the index has and prices do not');
  const gaps = await sh.missingSessions(pool, {
    table: 'idx_stock_prices', col: 'date', reference: 'idx_ihsg_history', referenceCol: 'date',
    days: 4000,
  });
  if (!gaps.missing.length) { line(`  ok — ${gaps.checked} sessions, all present`); return; }

  line(`  ${gaps.missing.length} session(s) with an index bar but no prices:`);
  line(`    ${gaps.missing.join(', ')}`);
  report({
    level: 'WARN',
    what: `${gaps.missing.length} trading session(s) missing from idx_stock_prices`,
    detail: `${gaps.missing.join(', ')}. The index traded on these days. Not auto-repaired: back-filling per-stock OHLC for these dates needs a historical source this system does not have.`,
  });
}

/* ── check 2: the forward test's nightly stages ────────────────────────────
   fill/plan/mark are idempotent by construction (`plan already exists — never
   recomputed`), so re-running a stage that died is safe. */
async function checkForwardStages(pool) {
  line('\nForward paper test — did tonight\'s stages actually run');
  const [[plan]] = await pool.query(
    `SELECT as_of_date, status FROM ft_strategy_plan
      WHERE run_mode='LIVE' ORDER BY as_of_date DESC LIMIT 1`).catch(() => [[null]]);
  if (!plan) {
    report({ level: 'FAIL', what: 'no LIVE plan exists at all', detail: 'strategy_forward.js has never produced one' });
    line('  ** no LIVE plan has ever been written');
    return;
  }

  const [[nav]] = await pool.query(
    `SELECT MAX(mark_date) d FROM ft_strategy_nav`).catch(() => [[{ d: null }]]);
  const [[px]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const priceDate = iso(px.d);
  const navDate = iso(nav?.d);

  line(`  latest plan ${iso(plan.as_of_date)} (${plan.status}) · latest NAV mark ${navDate || 'none'} · prices ${priceDate}`);

  // The mark is the stage with an unambiguous daily artifact: if prices exist
  // for a session and no NAV was marked for it, `mark` did not run or died.
  if (navDate && priceDate && navDate < priceDate) {
    await runRepair(pool, {
      job: 'watchdog:forward_mark',
      what: `NAV not marked for ${priceDate} (last mark ${navDate})`,
      fix: async () => {
        const sf = require('./strategy_forward');
        await sf.setup(pool);
        // cmdMark takes the loaded series as its second argument, not options —
        // it marks against the trading-date axis, so it cannot build one itself.
        const ctx = await sf.loadSeries(pool);
        return sf.cmdMark(pool, ctx, true);
      },
      verify: async () => {
        const [[n]] = await pool.query('SELECT MAX(mark_date) d FROM ft_strategy_nav');
        return !(iso(n.d) >= priceDate);
      },
    });
  } else {
    line('  ok — the NAV mark is current with the price series');
  }
}

/* ── check 3: the virtual portfolio's nightly stages ───────────────────────
   Every stage is idempotent and that is TESTED (test_virtual_portfolio.js runs
   resolve twice and asserts the second run moves no cash), which is what makes
   re-running one safe to automate. */
async function checkVirtualPortfolio(pool) {
  line('\nVirtual portfolio — ledger marked, and does it still reconcile');
  // PRODUCTION ONLY. This read every ACTIVE account and a GLOBAL MAX(mark_date),
  // so an experimental account with a fresher mark could make the watchdog
  // report "already marked" while the official accounts were not — the watchdog
  // and the burn-in contradicting each other about the same night.
  const vpScope = require('./virtual_portfolio');
  const [accounts] = await pool.query(
    `SELECT id, account_code FROM virtual_accounts WHERE strategy_id=? AND status='ACTIVE'`,
    [vpScope.SOURCE_STRATEGY]).catch(() => [[]]);
  if (!accounts.length) { line('  no active official accounts — nothing to check'); return; }
  const acctIds = accounts.map(a => a.id);

  const [[px]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  const priceDate = iso(px.d);
  const [[cal]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const sessionDate = iso(cal?.d);
  // COUNT, not MAX. With POSITION marked today and INTRADAY still on yesterday,
  // MAX(mark_date) reads "today" and the watchdog reports current while the
  // burn-in reports a failure — two monitors contradicting each other about the
  // same night.
  const [[nav]] = await pool.query(
    'SELECT MAX(mark_date) d FROM virtual_nav WHERE account_id IN (?)', [acctIds]);
  const navDate = iso(nav?.d);
  const [[markedToday]] = await pool.query(
    `SELECT COUNT(DISTINCT account_id) n FROM virtual_nav WHERE account_id IN (?) AND mark_date=?`,
    [acctIds, navDate]);
  const partial = navDate && Number(markedToday.n) !== acctIds.length;
  if (partial) {
    report({
      level: 'FAIL',
      what: `only ${markedToday.n} of ${acctIds.length} official accounts are marked for ${navDate}`,
      detail: 'MAX(mark_date) hides this: one account current and one behind still reads as current.',
    });
    line(`  ** partial mark: ${markedToday.n} of ${acctIds.length} accounts have a ${navDate} NAV`);
  }
  line(`  latest NAV mark ${navDate || 'none'} · prices ${priceDate} · session ${sessionDate}`);

  // ALL THREE MUST AGREE, not merely "the NAV is not behind". `navDate >=
  // priceDate` passes when the mark is dated a session the prices have not
  // reached, which is the very state PRICE_DATA_STALE exists to catch.
  if (navDate && priceDate && sessionDate && !(navDate === priceDate && priceDate === sessionDate)) {
    report({
      level: 'FAIL',
      what: 'the NAV mark, the price series and the session calendar do not agree',
      detail: `nav ${navDate}, prices ${priceDate}, session ${sessionDate}. A NAV dated to a session nothing is priced in looks exactly like a real valuation.`,
    });
    line('  ** these three dates must be identical; they are not');
  }

  if (!navDate || navDate < priceDate || partial) {
    await runRepair(pool, {
      job: 'watchdog:vp_mark',
      what: `virtual NAV not marked for ${priceDate} (last mark ${navDate || 'none'})`,
      fix: async () => {
        const vp = require('./virtual_portfolio');
        await vp.setup(pool, true);
        const resolved = await vp.cmdResolve(pool, true);
        // The repair must respect the resolver's own refusal. Marking straight
        // after a blocked resolve would stamp a NAV on data the engine just
        // declined to touch — the watchdog undoing a guard it exists to enforce.
        // `failed` as well as `blocked`. cmdMark's own gate already refuses when
        // the resolve checkpoint is not OK, so this could not have produced a
        // false NAV — but the watchdog reporting "repair ran" for a session that
        // never settled is the wrong story about the same night.
        if (resolved?.blocked || resolved?.failed) {
          throw new Error(
            `virtual resolve did not settle: ${resolved.blocked || resolved.failures?.join('; ') || 'FAILED'}`);
        }
        return vp.cmdMark(pool, true);
      },
      verify: async () => {
        const [[n]] = await pool.query(
          `SELECT COUNT(DISTINCT account_id) n FROM virtual_nav
            WHERE account_id IN (?) AND mark_date = ?`, [acctIds, priceDate]);
        // EVERY official account, on the price date. Not "the newest mark is not
        // behind" — that is the check that let a partial mark pass.
        return Number(n.n) !== acctIds.length;
      },
    });
  } else {
    line('  ok — marked through the latest price bar');
  }

  // The ledger invariants. NOT auto-repairable on purpose: cash that does not
  // match the positions means a transaction went half-in, and guessing which
  // half to "fix" would destroy the evidence of what actually happened.
  try {
    const vp = require('./virtual_portfolio');
    const problems = await vp.cmdReconcile(pool);
    if (problems.length) {
      report({
        level: 'FAIL', what: `${problems.length} ledger invariant(s) broken`,
        detail: problems.join(' | '),
      });
      line('  ** the ledger does not reconcile. NOT auto-repaired — deliberately:');
      line('     a half-committed transaction is evidence, and a guessed correction destroys it.');
    }
  } catch (e) {
    report({ level: 'FAIL', what: 'reconcile could not run', detail: e.message });
  }
}

/* ── check 4: everything the freshness checks already cover ────────────────
   Not repaired here. These feeds belong to other subsystems (the nightly scrape,
   the Python signal engine) and re-running them from a watchdog would be a
   second uncoordinated writer. Reported, and reported as failures. */
async function checkFreshness(pool) {
  line('\nFeed freshness');
  const rows = await sh.dataFreshness(pool);
  for (const r of rows) {
    const tag = r.ok ? 'ok  ' : (r.critical ? '**  ' : ' !  ');
    line(`  ${tag}${String(r.key).padEnd(15)} ${r.latest || '(empty)'}  ${r.detail}`);
    if (!r.ok) {
      report({
        level: r.critical ? 'FAIL' : 'WARN',
        what: `${r.key} is stale (${r.table})`,
        detail: `${r.detail}. Not auto-repaired: this feed is owned by another job, and a watchdog writing it would be a second uncoordinated writer.`,
      });
    }
  }
}

/* ── check 5: jobs that reported a failure and never recovered ─────────────*/
async function checkJobRegistry(pool) {
  line('\nJob registry');
  const jobs = await sh.jobHealth(pool);
  if (!jobs.length) { line('  no jobs have reported yet'); return; }
  for (const j of jobs) {
    // Skip our own rows. The watchdog recording last night's failure and then
    // reporting that record as a fresh finding is circular: the same fault gets
    // counted twice and the summary fills with the monitor talking about itself.
    // Whatever is actually still wrong is found again by the checks above.
    if (String(j.job_name).startsWith('watchdog')) continue;
    const failing = j.status === 'FAILED';
    line(`  ${failing ? '**  ' : 'ok  '}${String(j.job_name).padEnd(28)} ${j.status}${j.consecutiveFailures ? `  ${j.consecutiveFailures} consecutive failure(s)` : ''}`);
    if (failing) {
      report({
        level: 'FAIL', what: `${j.job_name} last run FAILED`,
        detail: `${j.consecutiveFailures || 1} consecutive failure(s): ${j.error || 'no error text recorded'}`,
      });
    }
  }
}

/**
 * BURN-IN — consecutive clean trading days, counted by the machine.
 *
 * The 2026-08-05 review asked for ten consecutive sessions with no manual
 * database repair and no invariant failure, and for the count to RESTART on any
 * bug. Counting that by hand is exactly the "remember to check" habit this
 * watchdog exists to replace, and a streak a human maintains is a streak a human
 * can be generous about.
 *
 * One row per session, written by the watchdog after everything else has run.
 * The streak is derived by walking backwards until a failure — never stored as a
 * number that could drift from the rows it summarises.
 *
 * A day with no data at all does not count as clean. Silence is not evidence.
 */
async function recordBurnIn(pool) {
  // Schema is owned by modules/burnin.js so a fresh database gets both tables.
  await require('./modules/burnin').ensureTables(pool);

  const [[sess]] = await pool.query('SELECT MAX(date) d FROM idx_ihsg_history');
  const sessionDate = iso(sess?.d);
  if (!sessionDate) { line('\nBurn-in — no session calendar yet, nothing to record'); return null; }

  // WHOSE streak this is. Strategy hash, engine version and the exact set of
  // live accounts, hashed together: change any of them and the count starts
  // again, because the thing being burned in is no longer the same thing.
  // Without this, eight clean days under engine v2 plus two under a brand-new
  // v3 reported ten — and v3 had run for two.
  const vb = require('./modules/virtual_broker');
  // THE OFFICIAL STRATEGY ONLY. Every account row used to be included, so while
  // the integration suite was running its throwaway TEST_* accounts entered the
  // identity hash and the checks — a test able to move, or break, the official
  // streak. The burn-in measures the production chain and nothing else.
  //
  // ONE definition of identity, shared with the cycle checkpoint. Two similar
  // hashes computed in two places is how they drift into disagreeing about
  // whether the same run is the same experiment.
  const vp0 = require('./virtual_portfolio');
  // The EXPERIMENT identity, not the cycle one. cycleIdentity deliberately omits
  // the strategy hash so the four nightly processes can find each other's
  // checkpoints; using it here would let strategy A's eight clean sessions and
  // strategy B's two add up to ten.
  const burnin = require('./modules/burnin');
  const experimentHash = await vp0.experimentIdentity(pool, vp0.SOURCE_STRATEGY);
  // The rules used to judge a session are part of what a session's verdict
  // MEANS, so they belong in the key. Without this, five sessions marked clean
  // under the old loose protocol would have counted toward a streak the strict
  // one defines — 6/10 on the official record's first real night.
  const identityHash = burnin.burninIdentity(experimentHash);
  const [idRows] = await pool.query(
    `SELECT account_code FROM virtual_accounts
      WHERE strategy_id=? AND status IN ('ACTIVE','RETIRING') ORDER BY account_code`,
    [vp0.SOURCE_STRATEGY]);

  // The checklist the review specified, each answered from data rather than
  // from whether a job claimed success.
  const checks = {};
  const [[px]] = await pool.query('SELECT MAX(date) d FROM idx_stock_prices');
  checks.priceDataCurrent = iso(px?.d) === sessionDate;
  // Excluding the dates already proven not to be sessions, the same subtraction
  // checkIhsgGaps makes. Without it this reported IDX public holidays as missing
  // index bars and failed the burn-in every night, for a fault no refetch can fix.
  // HARD signatures only for the calendar exclusion. Excluding NO_INDEX_BAR
  // dates here would hide a real index gap behind the very absence that defines
  // it — the same circularity the check order above exists to break.
  const hardPhantom = (await sh.phantomSessions(pool, { useIndexCalendar: false })).map(p => p.date);
  const allPhantom = (await sh.phantomSessions(pool)).map(p => p.date);
  checks.calendarCurrent = !(await sh.missingSessions(pool,
    { table: 'idx_ihsg_history', col: 'date', exclude: hardPhantom })).missing.length;
  // A phantom row is a burn-in failure only when the INGEST produced one
  // recently. Scoring the whole history here would have held the streak hostage
  // to years-old data debt: the count could never reach ten while a single 2017
  // holiday bar existed, no matter how clean the engine ran. Historical debt is
  // real and reported separately by checkPhantomSessions; what the daily burn-in
  // asks is whether TODAY's pipeline behaved.
  const BURNIN_LOOKBACK_DAYS = 30;
  const recentCutoff = (() => {
    const d = new Date(`${sessionDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - BURNIN_LOOKBACK_DAYS);
    return d.toISOString().slice(0, 10);
  })();
  const phantomDates = allPhantom.filter(d => d >= recentCutoff);
  checks.noPhantomSessions = phantomDates.length === 0;
  if (allPhantom.length && !phantomDates.length) {
    line(`  (${allPhantom.length} historical phantom date(s) outside the ${BURNIN_LOOKBACK_DAYS}-day window — reported separately, not counted here)`);
  }

  const [accts] = await pool.query(
    `SELECT id, account_code, cash_balance, total_nav, performance_eligible
       FROM virtual_accounts WHERE strategy_id=? AND status IN ('ACTIVE','RETIRING')`,
    [vp0.SOURCE_STRATEGY]);
  checks.accountsExist = accts.length > 0;
  checks.cashNonNegative = accts.every(a => Number(a.cash_balance) >= -1e-6);
  checks.performanceEligible = accts.every(a => Number(a.performance_eligible) === 1);

  // Scoped to the accounts that are actually live. Counting every marked
  // account_id compared 4 marks (two of them retired earlier the same evening)
  // against 2 live accounts, and failed for no real reason.
  // One list, declared once: these are the OFFICIAL accounts and every scoped
  // query below uses it. (It was `liveIds` here and `officialIds` further down,
  // with the second declared AFTER its first use -- a temporal dead zone that
  // would have thrown the moment this ran.)
  const officialIds = accts.map(a => a.id);
  const [[marked]] = officialIds.length
    ? await pool.query(
        `SELECT COUNT(DISTINCT account_id) n FROM virtual_nav WHERE mark_date=? AND account_id IN (?)`,
        [sessionDate, officialIds])
    : [[{ n: 0 }]];
  checks.navMarkedToday = accts.length > 0 && Number(marked.n) === accts.length;

  // SCOPED. The earlier comment here claimed this was "deliberately unscoped so
  // a retired account's NAV identity holds too" — which was wrong reasoning: a
  // broken test or experimental account could fail the OFFICIAL burn-in.
  const [[navOk]] = officialIds.length
    ? await pool.query(
        `SELECT COUNT(*) bad FROM virtual_nav
          WHERE mark_date = ? AND account_id IN (?)
            AND ABS(total_nav - (cash_value + market_value)) > 1`, [sessionDate, officialIds])
    : [[{ bad: 0 }]];
  checks.navIdentityHolds = Number(navOk.bad) === 0;

  const [[dupes]] = officialIds.length
    ? await pool.query(
        `SELECT COUNT(*) n FROM (
           SELECT order_id FROM virtual_positions WHERE account_id IN (?)
            GROUP BY order_id HAVING COUNT(*) > 1) x`, [officialIds])
    : [[{ n: 0 }]];
  checks.noDuplicateFills = Number(dupes.n) === 0;

  const [[blockedRows]] = officialIds.length
    ? await pool.query(
        `SELECT COUNT(*) n FROM virtual_trade_events
          WHERE event='DATA_BLOCKED' AND event_date=? AND account_id IN (?)`, [sessionDate, officialIds])
    : [[{ n: 0 }]];
  checks.noSkippedUnknownBar = Number(blockedRows.n) === 0;

  // EVERY STAGE MUST HAVE COMPLETED. Without this a schedule recorded FAILED
  // still produced a "clean" session, because schedule creates orders for the
  // NEXT session and its failure does not disturb tonight's NAV or reconcile.
  // A day is clean when the whole chain ran, not when the numbers happen to
  // survive one part of it not running.
  const cycleHash = await vp0.cycleIdentity(pool, vp0.SOURCE_STRATEGY);
  const [stageRows] = await pool.query(
    `SELECT stage, status, ever_failed, first_failure_reason FROM virtual_cycle_stage
      WHERE session_date=? AND identity_hash=?`, [sessionDate, cycleHash]).catch(() => [[]]);
  const stageMap = Object.fromEntries(stageRows.map(r => [r.stage, r]));
  // OK **and never failed**. A retry that fixed the pipeline is allowed to let
  // the chain continue; it is not allowed to make the SESSION clean. Otherwise
  // "any failure restarts the count" is only true until someone re-runs it.
  const stageClean = st => stageMap[st] && stageMap[st].status === 'OK' && Number(stageMap[st].ever_failed) === 0;
  checks.resolveStageOk = stageClean('resolve');
  checks.scheduleStageOk = stageClean('schedule');
  checks.markStageOk = stageClean('mark');

  let reconcileProblems = [];
  try {
    const vp = require('./virtual_portfolio');
    reconcileProblems = await vp.cmdReconcile(pool, { strategyId: vp.SOURCE_STRATEGY });
  } catch (e) { reconcileProblems = [`reconcile could not run: ${e.message}`]; }
  checks.reconcileClean = reconcileProblems.length === 0;

  checks.watchdogHealthy = !findings.some(f => f.level === 'FAIL' || f.level === 'RECURRING');

  const failures = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  // Name the actual stage status, not just which check failed: "scheduleStageOk"
  // alone does not say whether it was BLOCKED, FAILED or never run.
  for (const st of ['resolve', 'schedule', 'mark']) {
    const r = stageMap[st];
    if (!r) { failures.push(`${st} stage NOT_RUN`); continue; }
    if (r.status !== 'OK') { failures.push(`${st} stage ${r.status}`); continue; }
    if (Number(r.ever_failed) === 1) {
      failures.push(`${st} stage recovered but FAILED earlier this session (${r.first_failure_reason || 'no reason recorded'})`);
    }
  }
  if (reconcileProblems.length) failures.push(...reconcileProblems.map(p => `reconcile: ${p}`));
  const passed = failures.length === 0;

  // Append-only attempt, then the session's verdict as the WORST attempt. A
  // repaired re-run can no longer promote a failed session to clean.
  const rec = await burnin.recordAttempt(pool, {
    sessionDate, identityHash, engineVersion: vb.EXECUTION_ENGINE_VERSION,
    passed, checks, failures,
  });

  // ONE definition, shared with the dashboard. It walks the exchange calendar,
  // so a session with no verdict stops the count just as a failed one does.
  const { streak, stoppedBy } = await burnin.computeStreak(pool, identityHash, sessionDate);

  line('\nBurn-in');
  line(`  session ${sessionDate}: attempt ${passed ? 'CLEAN' : 'FAILED'}, ` +
       `session verdict ${rec.verdict ? 'CLEAN' : 'FAILED'} (${rec.attempts} attempt(s))`);
  if (passed && !rec.verdict) {
    line('  this attempt was clean but the session already failed — a session that has');
    line('  failed is never promoted, however well a later run goes.');
  }
  for (const [k, v] of Object.entries(checks)) line(`    ${v ? 'ok  ' : '**  '}${k}`);
  if (failures.length) for (const f of failures) line(`    -> ${f}`);
  line(`  consecutive clean sessions: ${streak} of 10   (stopped by ${stoppedBy})`);
  if (!rec.verdict) {
    line('  the count RESTARTS. Ten clean sessions means ten in a row, not ten in total.');
    report({ level: 'FAIL', what: `burn-in session ${sessionDate} failed`,
             detail: (rec.allFailures.length ? rec.allFailures : failures).join('; ') });
  } else if (streak >= 10) {
    line('  TEN CONSECUTIVE CLEAN SESSIONS. Operationally stable.');
    line('  This says nothing whatsoever about whether the strategy makes money.');
  }
  return { sessionDate, identityHash, passed, verdict: rec.verdict, streak, stoppedBy, checks, failures };
}

async function main() {
  const pool = mysql.createPool({ ...DB, waitForConnections: true, connectionLimit: 5 });
  const started = Date.now();
  try {
    await sh.ensureTable(pool);
    line('='.repeat(72));
    line(`WATCHDOG  ${new Date().toISOString()}${DRY ? '   (DRY RUN — nothing will be changed)' : ''}`);
    line('='.repeat(72));

    // Order matters: repair the index series before anything that reads it.
    // THE CIRCULARITY THIS ORDER BREAKS.
    // phantomSessions can label a date NO_INDEX_BAR purely because the IHSG
    // table lacks it — but that is exactly what a real index gap looks like. Feed
    // those dates to the gap detector as exclusions and a genuine missing session
    // is classified as "never a session", excluded from repair, and never fixed.
    // The evidence for the exclusion was the fault itself.
    //
    // So: exclude only the HARD signatures (weekend, zero-volume-flat,
    // duplicate) while repairing gaps; classify NO_INDEX_BAR afterwards, once
    // the index series has had its chance to be complete.
    const hardPhantom = (await sh.phantomSessions(pool, { useIndexCalendar: false })).map(p => p.date);
    await checkIhsgGaps(pool, hardPhantom);
    const phantomDates = await checkPhantomSessions(pool);
    await checkPriceGaps(pool);
    await checkFreshness(pool);
    await checkForwardStages(pool);
    await checkVirtualPortfolio(pool);
    await checkJobRegistry(pool);

    // Last of all: today's burn-in verdict, computed from everything above.
    await recordBurnIn(pool);

    // WOULD_REPAIR counts as unresolved. A dry run that finds 17 broken sessions
    // and exits 0 is reporting success about a system it just found broken.
    const bad = findings.filter(f => f.level === 'FAIL' || f.level === 'RECURRING' || f.level === 'WOULD_REPAIR');
    const warn = findings.filter(f => f.level === 'WARN');
    const fixed = findings.filter(f => f.level === 'REPAIRED');

    line('\n' + '='.repeat(72));
    if (fixed.length) {
      line(`REPAIRED ${fixed.length}:`);
      for (const f of fixed) line(`  - ${f.what}`);
    }
    if (warn.length) {
      line(`WARNINGS ${warn.length}:`);
      for (const f of warn) line(`  - ${f.what}: ${f.detail}`);
    }
    if (bad.length) {
      line(`UNRESOLVED ${bad.length}:`);
      for (const f of bad) line(`  - [${f.level}] ${f.what}: ${f.detail}`);
      line('');
      line('These need a human. The watchdog will not paper over them.');
    } else {
      line(fixed.length ? 'Everything else is healthy.' : 'All checks passed.');
    }
    line('='.repeat(72));

    await sh.recordJobRun(pool, {
      job: 'watchdog',
      status: bad.length ? 'FAILED' : 'OK',
      durationMs: Date.now() - started,
      records: findings.length,
      error: bad.length ? bad.map(f => `${f.level}: ${f.what}`).join(' | ').slice(0, 900) : null,
    });

    process.exitCode = bad.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}

module.exports = { checkIhsgGaps, checkPhantomSessions, checkPriceGaps, checkForwardStages, recordBurnIn, checkVirtualPortfolio, RECUR_THRESHOLD, RECUR_WINDOW };

if (require.main === module) {
  main().catch(e => {
    // The watchdog dying silently would be the joke writing itself.
    console.error('WATCHDOG ITSELF FAILED:', e.stack || e.message);
    process.exit(1);
  });
}
