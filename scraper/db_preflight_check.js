/**
 * DB credential preflight — a fresh connection, SELECT 1, nothing else.
 *
 * Exists so a bad/rotated credential fails FAST and OBVIOUSLY (this one
 * check, first, before the test suites) instead of surfacing 20 minutes
 * into `predeploy_check.sh`'s integration suite as one confusing failure
 * among many, or worse, not surfacing at all because a stale pooled
 * connection from before a rotation kept the server looking healthy — see
 * modules/db_config.js's header comment for the incident that prompted this.
 *
 * Deliberately no `--require-db` skip flag like the test_*.js files use —
 * this script's entire purpose IS verifying the database, so "run it
 * without a database" isn't a meaningful mode.
 *
 * Usage: node db_preflight_check.js   (also wired as `npm run db:check`)
 */
'use strict';
require('dotenv').config();
const dbConfig = require('./modules/db_config');

(async () => {
  const r = await dbConfig.checkConnection();
  console.log(`DB preflight: host=${r.host} user=${r.user} database=${r.database} config_source=${r.configSource} version=${r.version}`);
  if (r.ok) {
    console.log(`DB preflight: PASS (SELECT 1 in ${r.durationMs}ms)`);
    process.exit(0);
  }
  console.error(`DB preflight: FAIL — ${r.errorCode}: ${r.errorMessage}`);
  process.exit(1);
})();
