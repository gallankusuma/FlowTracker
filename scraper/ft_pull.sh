#!/bin/bash
# Wrapper for the crontab's flowtracker.id concentration pull.
#
# The crontab previously called the endpoint with a bare curl:
#   curl -s -X POST http://localhost:3100/api/ft-pull
# That worked only because /api/ft-pull had no authentication — and port 3100 is
# bound to 0.0.0.0 with no firewall, so the same call worked from anywhere on the
# internet. The endpoint now requires the admin key, and this wrapper supplies it
# from .env rather than putting a secret in the crontab, where it would be
# visible to `crontab -l` and to anyone reading process arguments in `ps`.
set -u
cd "$(dirname "$0")" || exit 1

if [ -z "${ADMIN_API_KEY:-}" ] && [ -f .env ]; then
  ADMIN_API_KEY=$(grep -E '^ADMIN_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '"'"'")
fi
ADMIN_API_KEY="${ADMIN_API_KEY:?ADMIN_API_KEY must be set or present in .env}"

curl -s -m 300 -X POST http://127.0.0.1:3100/api/ft-pull \
  -H "x-admin-key: $ADMIN_API_KEY" \
  -H 'Content-Type: application/json'
echo ""
