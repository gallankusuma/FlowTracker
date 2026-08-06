/**
 * The charter — an account's identity and its evaluation gate, frozen BEFORE
 * any result exists.
 *
 * WHY THIS IS A MODULE AND NOT A PARAGRAPH IN A README
 * ----------------------------------------------------
 * The 2026-08-05 review asked for the pass/fail criteria to be fixed before the
 * track record starts accumulating, and for parameters not to be adjusted after
 * a few bad trades. That is pre-registration, and it only works if the
 * criteria are written down somewhere that refuses to be edited afterwards.
 *
 * So the gate lives in the database, one immutable row per account identity,
 * and `freezeCharter` REFUSES to overwrite one. Changing the gate means a new
 * identity — new strategy hash or new execution policy hash — which means a new
 * account starting again from Rp100 juta. There is no path that lets a
 * disappointing result be met with an easier target.
 *
 * IDENTITY INCLUDES THE CODE COMMIT, and that is not decoration. The execution
 * policy hash covers the CONFIGURATION: fees, slippage, caps, the risk layer.
 * It does not move when the ALGORITHM changes — gap handling, opening-NAV
 * sizing, whether an unreadable bar blocks the walk. Two of those changed on
 * 2026-08-05 without the hash moving an inch. A record that cannot say which
 * code produced it is not reproducible, so the commit is part of the identity.
 */
'use strict';

const { execSync } = require('child_process');

/**
 * The commit this code was deployed from.
 *
 * The VPS has no git repository — deploys are scp, which is exactly why the
 * first attempt at freezing a charter recorded `unknown`. A charter that cannot
 * name the code that produced its record fails at the one job it has, so the
 * deploy writes `.deployed-commit` alongside the source and that file is the
 * authority here. `git rev-parse` still works locally and in CI.
 */
function codeCommit() {
  const fromFile = (() => {
    try {
      const v = require('fs').readFileSync(`${__dirname}/../.deployed-commit`, 'utf8').trim();
      return v || null;
    } catch { return null; }
  })();
  if (fromFile) return fromFile;
  try {
    return execSync('git rev-parse --short HEAD', { cwd: `${__dirname}/..`, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim() || null;
  } catch { return process.env.CODE_COMMIT || null; }
}

/**
 * The evaluation gates, per exit policy.
 *
 * POSITION is on trial: it has to clear a bar to be called anything.
 *
 * INTRADAY_EOD IS NOT. It is the control, and giving a control a profit target
 * would be a category error — EXP-019 already measured the same-day rule at
 * -0.951% per trade on this system's own BUY days (n=2,204, t=-18.5) against a
 * -0.673% base rate. Its job is to show forward whether closing on the entry
 * day destroys the edge. It "passes" by producing enough clean trades to answer
 * that question, whatever the answer is. Tuning it until it profits would
 * destroy the only thing it is for.
 */
const GATES = {
  POSITION: {
    kind: 'CANDIDATE',
    minTradingDays: 60,
    minClosedTrades: 30,
    maxDrawdown: 0.12,
    minProfitFactor: 1.20,
    requirePositiveNetReturn: true,
    requireNoLedgerViolations: true,
    requireNoPolicyChange: true,
    note: 'On trial. Net return is measured AFTER fees and slippage.',
  },
  INTRADAY_EOD: {
    kind: 'CONTROL',
    minTradingDays: 60,
    minClosedTrades: 30,
    maxDrawdown: null,
    minProfitFactor: null,
    requirePositiveNetReturn: false,
    requireNoLedgerViolations: true,
    requireNoPolicyChange: true,
    note: 'A CONTROL, not a candidate. EXP-019 measured this rule at -0.951%/trade ' +
          '(n=2,204, t=-18.5) vs a -0.673% base rate, so it is EXPECTED to lose. It ' +
          'succeeds by producing enough clean trades to confirm or refute that ' +
          'forward. It must not be tuned until it profits — that would destroy the ' +
          'only thing it is for.',
  },
};

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS virtual_charter (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_code VARCHAR(32) NOT NULL,
      strategy_id VARCHAR(64) NOT NULL,
      strategy_hash VARCHAR(32) NOT NULL,
      execution_policy_hash VARCHAR(32) NOT NULL,
      -- The ALGORITHM's identity, deliberate and human-set, not the git commit.
      -- The commit moves when a comment is edited; this moves when execution
      -- BEHAVIOUR moves, which is the thing that makes records incomparable.
      execution_engine_version INT NOT NULL DEFAULT 1,
      config_version INT NOT NULL,
      code_commit VARCHAR(40) NULL,
      starting_capital DECIMAL(20,2) NOT NULL,
      -- NULLABLE, and one-way. There is no way to know at freeze time which
      -- session the account will first trade on: a historical table holds no
      -- future dates, so every attempt to compute it fell back to today or
      -- earlier -- a date the account provably could not have traded, because it
      -- did not exist yet. It is resolved once, from the first official NAV mark.
      official_start_date DATE NULL,
      gate_json TEXT NOT NULL,
      frozen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      -- One charter per identity, and the code below never updates a row. The
      -- gate cannot be softened after a bad month.
      UNIQUE KEY uq_charter (account_code, strategy_id, strategy_hash, execution_policy_hash, execution_engine_version)
    )`);

  // Existing installations predate the engine column and the wider key.
  const [[col]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_charter' AND COLUMN_NAME='execution_engine_version'`);
  if (!Number(col.n)) {
    await pool.query(
      'ALTER TABLE virtual_charter ADD COLUMN execution_engine_version INT NOT NULL DEFAULT 1 AFTER execution_policy_hash');
  }
  // official_start_date became nullable on 2026-08-05. Checked and altered
  // explicitly rather than ALTER-and-swallow: a swallowed migration error is how
  // this codebase has repeatedly reported a schema ready when it was not.
  const [[nullable]] = await pool.query(
    `SELECT IS_NULLABLE ok FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_charter' AND COLUMN_NAME='official_start_date'`);
  if (nullable && nullable.ok === 'NO') {
    await pool.query('ALTER TABLE virtual_charter MODIFY COLUMN official_start_date DATE NULL');
    const [[after]] = await pool.query(
      `SELECT IS_NULLABLE ok FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_charter' AND COLUMN_NAME='official_start_date'`);
    if (after.ok !== 'YES') throw new Error('virtual_charter.official_start_date is still NOT NULL after the ALTER');
  }

  const [[key]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_charter'
        AND INDEX_NAME='uq_charter' AND COLUMN_NAME='execution_engine_version'`);
  if (!Number(key.n)) {
    const [[has]] = await pool.query(
      `SELECT COUNT(*) n FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='virtual_charter' AND INDEX_NAME='uq_charter'`);
    if (Number(has.n)) await pool.query('ALTER TABLE virtual_charter DROP INDEX uq_charter');
    await pool.query(
      'ALTER TABLE virtual_charter ADD UNIQUE KEY uq_charter (account_code, strategy_id, strategy_hash, execution_policy_hash, execution_engine_version)');
  }
}

/**
 * Write the charter for an identity, once.
 *
 * Returns { frozen: true } the first time and { alreadyFrozen: true, charter }
 * afterwards. It never rewrites, and it reports a DIFFERENT gate as a conflict
 * rather than quietly keeping either version.
 */
async function freezeCharter(pool, {
  accountCode, strategyId, strategyHash, executionPolicyHash, executionEngineVersion,
  configVersion, startingCapital, officialStartDate, exitPolicy,
}) {
  await ensureTable(pool);
  const gate = GATES[exitPolicy];
  if (!gate) throw new Error(`no evaluation gate defined for exit policy ${exitPolicy}`);


  // NO COMMIT, NO CHARTER. The execution policy hash covers the configuration
  // and not the algorithm — gap handling and missing-bar rules both changed on
  // 2026-08-05 without moving it — so the commit is the only thing that says
  // which code produced the record. Freezing one without it happened on the
  // first attempt and produced a charter reading `unknown`, which is a charter
  // that cannot do its job. Refusing is better than recording a blank.
  const commit = codeCommit();
  if (!commit) {
    throw new Error(
      'refusing to freeze a charter with no code commit: write scraper/.deployed-commit ' +
      'at deploy time, or set CODE_COMMIT. A record that cannot name the code that ' +
      'produced it is not reproducible.');
  }

  const [existing] = await pool.query(
    `SELECT * FROM virtual_charter
      WHERE account_code=? AND strategy_id=? AND strategy_hash=? AND execution_policy_hash=?
        AND execution_engine_version=?`,
    [accountCode, strategyId, strategyHash, executionPolicyHash, executionEngineVersion]);

  if (existing.length) {
    const stored = JSON.parse(existing[0].gate_json);
    const drifted = JSON.stringify(stored) !== JSON.stringify(gate);
    return { alreadyFrozen: true, charter: existing[0], gateDrift: drifted };
  }

  await pool.query(
    `INSERT INTO virtual_charter
       (account_code, strategy_id, strategy_hash, execution_policy_hash, execution_engine_version,
        config_version, code_commit, starting_capital, official_start_date, gate_json)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [accountCode, strategyId, strategyHash, executionPolicyHash, executionEngineVersion, configVersion,
     commit, startingCapital, officialStartDate, JSON.stringify(gate)]);

  const [[row]] = await pool.query(
    `SELECT * FROM virtual_charter
      WHERE account_code=? AND strategy_id=? AND strategy_hash=? AND execution_policy_hash=?
        AND execution_engine_version=?`,
    [accountCode, strategyId, strategyHash, executionPolicyHash, executionEngineVersion]);
  return { frozen: true, charter: row };
}

/**
 * Measure an account against its own frozen gate.
 *
 * Reports NOT_YET_ELIGIBLE separately from FAILED. They are different states and
 * conflating them is how a record that has not run long enough gets read as a
 * verdict — in either direction.
 */
async function evaluate(pool, charter, stats) {
  const gate = JSON.parse(charter.gate_json);
  const criteria = [];
  const add = (name, ok, detail) => criteria.push({ name, ok, detail });

  const enoughDays = stats.tradingDays >= gate.minTradingDays;
  const enoughTrades = stats.closedTrades >= gate.minClosedTrades;
  add('minimum period', enoughDays, `${stats.tradingDays} of ${gate.minTradingDays} trading days`);
  add('minimum closed trades', enoughTrades, `${stats.closedTrades} of ${gate.minClosedTrades}`);

  if (gate.maxDrawdown !== null) {
    add('maximum drawdown', stats.maxDrawdown <= gate.maxDrawdown,
      `${(stats.maxDrawdown * 100).toFixed(2)}% against a ${(gate.maxDrawdown * 100).toFixed(0)}% limit`);
  }
  if (gate.minProfitFactor !== null) {
    add('profit factor', stats.profitFactor !== null && stats.profitFactor >= gate.minProfitFactor,
      stats.profitFactor === null ? 'not computable yet' : `${stats.profitFactor.toFixed(2)} against ${gate.minProfitFactor}`);
  }
  if (gate.requirePositiveNetReturn) {
    add('net return after costs', stats.netReturn > 0, `${(stats.netReturn * 100).toFixed(2)}%`);
  }
  if (gate.requireNoLedgerViolations) {
    add('no ledger violations', stats.ledgerViolations === 0, `${stats.ledgerViolations} recorded`);
  }
  if (gate.requireNoPolicyChange) {
    add('no policy change mid-record', !stats.policyChanged,
      stats.policyChanged ? 'the account was retired or its contract changed' : 'unchanged');
  }

  const verdict = !(enoughDays && enoughTrades) ? 'NOT_YET_ELIGIBLE'
    : criteria.every(c => c.ok) ? 'PASSED' : 'FAILED';

  return { kind: gate.kind, verdict, criteria, gate };
}

/**
 * Resolve the official start ONCE, from the first NAV mark the account actually
 * produced. One-way: NULL -> a real session, and never rewritten.
 *
 * Computing it at freeze time was impossible and the code pretended otherwise —
 * a historical table holds no future sessions, so the "next session" query never
 * matched and the fallback recorded today or earlier. That is a date on which
 * the account could not have traded, because it did not exist yet.
 */
async function resolveOfficialStart(pool) {
  const [rows] = await pool.query(
    `SELECT c.id, c.account_code, c.frozen_at
       FROM virtual_charter c WHERE c.official_start_date IS NULL`);
  const resolved = [];
  for (const c of rows) {
    const [[nav]] = await pool.query(
      `SELECT MIN(v.mark_date) d FROM virtual_nav v
         JOIN virtual_accounts a ON a.id = v.account_id
        WHERE a.account_code = ? AND v.created_at >= ?`, [c.account_code, c.frozen_at]);
    if (!nav?.d) continue;
    const d = nav.d instanceof Date
      ? `${nav.d.getFullYear()}-${String(nav.d.getMonth() + 1).padStart(2, '0')}-${String(nav.d.getDate()).padStart(2, '0')}`
      : String(nav.d).slice(0, 10);
    await pool.query(
      'UPDATE virtual_charter SET official_start_date=? WHERE id=? AND official_start_date IS NULL', [d, c.id]);
    resolved.push({ accountCode: c.account_code, officialStartDate: d });
  }
  return resolved;
}

module.exports = { GATES, ensureTable, freezeCharter, evaluate, codeCommit, resolveOfficialStart };
