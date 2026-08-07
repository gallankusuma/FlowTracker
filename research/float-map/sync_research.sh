#!/usr/bin/env bash
#
# Deploy the Float Map research scripts to the VPS.
#
# The repo is the source of truth; /root/research is a copy. Before this
# existed the scripts lived ONLY on the box, so changing the turnover
# coefficient from 0.75 to 0.90 would have changed every published number with
# nothing in git able to say when or why.
#
# The commit is stamped alongside them and travels into every snapshot, so any
# stored number can be traced back to the exact source that produced it.
#
# Deliberately NOT into /var/www/flowtracker-scraper: the IDX engine is frozen
# for its operational burn-in, and scraper/predeploy_check.sh fails when any
# .js in that tree is newer than the deployed-commit stamp.
set -euo pipefail

HOST="${1:-root@76.13.22.155}"
DEST=/root/research
HERE="$(cd "$(dirname "$0")" && pwd)"

COMMIT="$(git -C "$HERE" rev-parse --short HEAD)"
DIRTY="$(git -C "$HERE" status --porcelain -- "$HERE" | head -1)"
if [ -n "$DIRTY" ]; then
  # A snapshot stamped with a commit that does not contain the running code is
  # worse than one stamped with nothing, because it looks auditable.
  echo "** research/float-map has uncommitted changes — commit them first."
  git -C "$HERE" status --short -- "$HERE"
  exit 1
fi

echo "deploying $COMMIT to $HOST:$DEST"
ssh "$HOST" "mkdir -p $DEST"
for f in model.js test_model.js float_fetch.js float_cost_map.js float_map_daily.js exp023_float_map_ic.js; do
  scp -q "$HERE/$f" "$HOST:$DEST/$f"
  echo "  $f"
done
echo "$COMMIT" | ssh "$HOST" "cat > $DEST/.model-commit"

echo "verifying"
ssh "$HOST" "cd $DEST && node -c float_map_daily.js && echo '  syntax ok' && echo \"  .model-commit = \$(cat .model-commit)\""
