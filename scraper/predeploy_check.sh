#!/bin/bash
# Run every suite, on the box that has the data. Exits non-zero if any fails.
#
# The 2026-08-04 review's closing note: integration tests are deliberately
# separate from `npm test`, so a deployment must run BOTH or the database tests
# never execute. Splitting the npm scripts was necessary and not sufficient —
# nothing was calling them. This is the thing that calls them.
#
# The GitHub Actions job runs test:unit only, because verify_strategy_book.js
# and the integration suite need two years of real IDX prices in MySQL and would
# otherwise pass against an empty schema. That data lives here.
#
# Usage:  ./predeploy_check.sh          from /var/www/flowtracker-scraper
set -uo pipefail
cd "$(dirname "$0")" || exit 1

fail=0
run() {
  echo ""
  echo "=============================================================="
  echo "  $1"
  echo "=============================================================="
  shift
  if "$@"; then
    echo "  -> PASS"
  else
    echo "  -> FAIL"
    fail=1
  fi
}

# First, always — a bad/rotated DB credential should fail here, in five
# seconds, with a DB_AUTH_FAILED/DB_UNREACHABLE message naming host/user/
# database, not twenty minutes into the integration suite as one confusing
# failure among many (2026-08-12 review, after a rotated password went
# undetected because a stale pooled connection kept the server looking
# healthy — see modules/db_config.js).
run "database credential preflight (fresh connection)" npm run --silent db:check

# The deployed-commit stamp is what the charter records as the code that
# produced a track record. It is written by hand at deploy time and has now been
# forgotten twice, each time freezing a charter that named the wrong commit.
# A stamp older than the newest source file means the code moved and the stamp
# did not.
if [ ! -f .deployed-commit ]; then
  echo ""
  echo "  ** .deployed-commit is MISSING. The charter cannot name the code it runs."
  echo "     Write it before deploying:  git rev-parse --short HEAD > scraper/.deployed-commit"
  fail=1
elif [ -n "$(find . -maxdepth 2 -name '*.js' -newer .deployed-commit -not -path './node_modules/*' -print -quit)" ]; then
  echo ""
  echo "  ** .deployed-commit ($(cat .deployed-commit)) is OLDER than deployed source."
  echo "     Newer than the stamp: $(find . -maxdepth 2 -name '*.js' -newer .deployed-commit -not -path './node_modules/*' -printf '%f ' 2>/dev/null | head -c 200)"
  echo "     Re-stamp before freezing any charter, or it will record the wrong commit."
  fail=1
fi

run "unit suite (no database)"            npm run --silent test:unit
run "golden fixture (needs the database)" npm run --silent test:verify
run "database integration"                npm run --silent test:integration

echo ""
echo "=============================================================="
if [ "$fail" -eq 0 ]; then
  echo "  ALL SUITES PASSED"
else
  echo "  SOMETHING FAILED — do not deploy"
fi
echo "=============================================================="
exit "$fail"
