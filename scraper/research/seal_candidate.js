/**
 * Seal the vetoFrac=0.40 candidate.
 *
 * A prose note saying "we decided 0.40 on 18 August" is worth nothing later —
 * it cannot be checked, and it cannot stop the parameters being nudged once
 * results start arriving. What CAN be checked is the strategy hash: the same
 * identity `strategy_forward.js` computes and `virtual_accounts.strategy_hash`
 * stores, so when the shadow eventually runs, its rows either carry this hash
 * or they are not this candidate.
 *
 * The computation is verified before it is trusted: it must reproduce the
 * INCUMBENT hash that is already live in virtual_accounts (0bd4f452f2ab01b3).
 * If it cannot reproduce a hash we already know, its output for the candidate
 * is not evidence of anything.
 */
//
// TWO MODES, and the difference matters:
//
//   node seal_candidate.js             the real check. Reads virtual_accounts and
//                                      proves the incumbent hash is LIVE. Needs
//                                      scraper/.env. Exit 0 only if it matched.
//   node seal_candidate.js --offline   derives the hashes from source alone. Lets
//                                      a reviewer without database access confirm
//                                      the identity arithmetic. It proves the
//                                      DERIVATION, not that the incumbent hash is
//                                      live, and says so in its own output.
//
// The offline mode exists because the reviewer could not run the DB check and got
// a bare "ERR" instead. It is not a substitute for the liveness proof and must
// never be quoted as one.
const env = require('./env');
const OFFLINE = process.argv.includes('--offline');
env.loadEnv({ optional: OFFLINE });
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sb = require('../modules/strategy_book');

const STRATEGY_ID = 'HI52W_REGIME_BROKERVETO_V1';
const REBAL_BARS = 10;
const BUY_COST = 0.20 / 100, SELL_COST = 0.30 / 100;
const MODEL_VERSION = process.env.AWO_MODEL_VERSION || '1.0.0-forward';
const EXECUTION_LEDGER_VERSION = 2;
const EXECUTION_POLICY_HASH = crypto.createHash('sha256')
  .update(fs.readFileSync(path.join(__dirname, '..', 'modules', 'execution.js')))
  .digest('hex').slice(0, 16);

function hashOf(params) {
  const cfg = {
    ...sb.DEFAULTS, ...params,
    rebalanceBars: REBAL_BARS, buyCost: BUY_COST, sellCost: SELL_COST,
    modelVersion: MODEL_VERSION, executionLedgerVersion: EXECUTION_LEDGER_VERSION,
    executionPolicyHash: EXECUTION_POLICY_HASH,
  };
  return {
    hash: crypto.createHash('sha256')
      .update(JSON.stringify({ id: STRATEGY_ID, cfg: Object.keys(cfg).sort().map(k => [k, cfg[k]]) }))
      .digest('hex').slice(0, 16),
    cfg,
  };
}

const INCUMBENT = { positions: 8, bufferMult: 2, vetoFrac: 0.20, exitOnVeto: true };
const CANDIDATE = { positions: 6, bufferMult: 2, vetoFrac: 0.40, exitOnVeto: true };

const inc = hashOf(INCUMBENT);
const cand = hashOf(CANDIDATE);

console.log('execution policy hash : ' + EXECUTION_POLICY_HASH);
console.log('incumbent  hash       : ' + inc.hash);
console.log('candidate  hash       : ' + cand.hash);
console.log('distinct              : ' + (inc.hash !== cand.hash ? 'YES' : 'NO — the seal would be meaningless'));

if (OFFLINE) {
  console.log();
  console.log('MODE: --offline. The hashes above are derived from source only.');
  console.log('It is NOT proven here that ' + inc.hash + ' is the hash actually stored in');
  console.log('virtual_accounts — run without --offline, with scraper/.env present, for that.');
  console.log();
  console.log('--- CANDIDATE CONFIG AS HASHED ---');
  console.log(JSON.stringify(cand.cfg, Object.keys(cand.cfg).sort(), 2));
  process.exit(0);
}

(async () => {
  const { createPool } = require('../modules/db_config');
  const pool = createPool();
  const [rows] = await pool.query(
    "SELECT DISTINCT strategy_hash h FROM virtual_accounts WHERE strategy_id=? AND strategy_hash <> 'UNSET'", [STRATEGY_ID]);
  const live = rows.map(r => r.h);
  console.log('\nhashes live in virtual_accounts: ' + live.join(', '));
  const ok = live.includes(inc.hash);
  console.log('reproduces the live incumbent  : ' + (ok ? 'YES — the computation is the production one' : 'NO — DO NOT SEAL, the hash function here is not the real one'));

  if (ok) {
    console.log('\n--- SEALED CANDIDATE CONFIG (full effective config, for the record) ---');
    console.log(JSON.stringify(cand.cfg, Object.keys(cand.cfg).sort(), 2));
  }
  await pool.end();
  process.exit(ok ? 0 : 1);
})().catch(env.fail);
