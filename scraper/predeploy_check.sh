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
