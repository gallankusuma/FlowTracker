# DB credential lifecycle

## Why this exists

2026-08-11: `erp_user`'s MySQL password was rotated on the VPS and
`scraper/.env` was never updated. Production kept running anyway — the
scraper's connection pool had been opened *before* the rotation, and a
30-second cron kept those connections busy, so MySQL's `wait_timeout` never
reaped them. `/api/health` doesn't touch MySQL at all, so it reported
`status: ok` the entire time. Meanwhile every FRESH connection — any CLI
script run by hand, any future `pm2 restart` — was silently broken with
`ER_ACCESS_DENIED_ERROR`. Nothing in the stack opened a fresh connection on
a schedule, so nothing could have caught it automatically.

Separately: `erp_user`/`erp_manufacturing` is shared with several unrelated
apps on the same box (erp-backend, erp-genjaya-\*, xfact, cylo, idxflash).
Whoever rotated it almost certainly wasn't thinking about FlowTracker at
all — the credential's blast radius was bigger than any one app's operator
would reasonably account for. FlowTracker now runs as its own dedicated
MySQL user, `flowtracker_app`, scoped to the same `erp_manufacturing` schema
(no data migration — see the cutover record at the bottom of this file). A
future `erp_user` rotation, for any of the other apps' sake, can no longer
touch FlowTracker.

## Architecture

`scraper/modules/db_config.js` is the single source of truth for connection
config. It exports:
- `createPool(overrides?)` — for long-lived processes (`server.js`).
- `checkConnection()` — opens a genuinely fresh, non-pooled connection,
  runs `SELECT 1`, returns a structured `{ok, host, user, database,
  configSource, version, errorCode, errorMessage}` result. **Never includes
  the password** — there is no field to accidentally log.
- `safeConfigInfo()` — the same non-secret fields, synchronously, no I/O.

**What uses it today**: `server.js` (the production path),
`db_preflight_check.js` (the `npm run db:check` command below), `dbcheck.js`
(a debug utility that used to hardcode `user: 'erp_user'`).

**What doesn't, and why that's still safe**: roughly 50 other top-level
scripts (`backtest_*.js`, `backfill_*.js`, most `test_*.js`, `watchdog.js`,
`universe_reselect.js`, etc.) still build their own `{host: process.env.DB_HOST
|| 'localhost', ...}` object inline. Every one of them resolves
`user`/`host`/`database` from the SAME environment variables `db_config.js`
does — the env var always wins over the fallback — so a credential change
in `.env` already propagates to all of them with zero code touched. What
`db_config.js` adds is centralizing the boilerplate and, more importantly,
the `checkConnection()` preflight primitive those scripts don't have.
**New top-level scripts should `require('./modules/db_config')`** rather
than hand-roll the object; backfilling the existing ~50 is a known,
intentionally deferred, mechanical follow-up — not an oversight.

`check-db.sh` (a raw-SQL debug script) reads `DB_USER`/`DB_NAME` from env
now too, defaulting to the pre-cutover values only as a convenience fallback.

## Routine password rotation (same user, new password)

No code deploy is needed for this — credential rotation and code deploy are
independent operations.

```bash
# On the VPS, as MySQL root (passwordless via auth_socket):
mysql -u root -e "ALTER USER 'flowtracker_app'@'localhost' IDENTIFIED BY '<new password>'; FLUSH PRIVILEGES;"

# Validate standalone, BEFORE touching any file:
mysql -u flowtracker_app -p'<new password>' -h localhost erp_manufacturing -e "SELECT 1;"
# If this fails, stop and fix the ALTER USER / GRANT — do not touch .env.

# Only once the above passes:
#   edit scraper/.env on the VPS — DB_PASSWORD only, DB_USER/DB_HOST/DB_NAME unchanged

cd /var/www/flowtracker-scraper
npm run db:check              # first time the app's OWN config path validates it
./predeploy_check.sh          # db:check first, then the full test suite chain
pm2 restart flowtracker-scraper
pm2 logs flowtracker-scraper --lines 50   # look for the new [DB] ... -> PASS line
curl -s http://127.0.0.1:3100/api/health/db | head -c 300
curl -s "http://127.0.0.1:3100/api/broker-summary?code=MG&date=<a recent date>" | head -c 300
```

Confirm the last two return real data, not just HTTP 200 — `/api/health`
alone proves nothing about DB connectivity, which is the entire point of
this document.

## Changing WHO FlowTracker authenticates as (rarer)

This is what the `flowtracker_app` cutover itself was — see the dated
record at the bottom of this file for the exact sequence that was run and
verified. Use it as the template if this ever needs to happen again (e.g.
if `flowtracker_app` itself needs replacing for some future reason).
The short version: inspect the current user's grants before writing new
ones (`SHOW GRANTS FOR '<user>'@'<host>'`), create the new user scoped to
the same schema, validate the NEW credential standalone via the raw `mysql`
CLI *before* touching `.env`, only then edit `.env`, then
`db:check` → `predeploy_check.sh` → `pm2 restart` → verify with a real
data endpoint. Never rotate/replace the OLD user in the same step — keep it
untouched until the new one is proven, so rollback is always just "put the
old two `.env` lines back and restart."

## What `predeploy_check.sh` checks, in order

1. `npm run db:check` — fresh-connection credential preflight (added
   2026-08-12; this is new).
2. `.deployed-commit` freshness stamp.
3. `npm run test:unit` — no database required.
4. `npm run test:verify` — `verify_strategy_book.js`, needs the database.
5. `npm run test:integration` — the `--require-db` test chain.

A bad credential now fails at step 1, in a few seconds, with a
`DB_AUTH_FAILED`/`DB_UNREACHABLE` message naming host/user/database —
instead of surfacing twenty minutes later as one confusing failure buried
inside step 4 or 5.

**GitHub Actions deliberately does NOT run `db:check`** — the CI job only
runs `test:unit`, because no MySQL exists in that environment and `db:check`
would always fail there. That's expected, not a gap to "fix."

## Troubleshooting `errorCode`

| `errorCode` | Likely cause |
|---|---|
| `DB_AUTH_FAILED` | Wrong password, wrong username, or the user's `@host` scope doesn't match the connecting host (e.g. user is `'flowtracker_app'@'localhost'` but the app connects via a different hostname/IP). |
| `DB_UNREACHABLE` | MySQL isn't running, is firewalled, or `DB_HOST`/network config is wrong. |
| `DB_UNKNOWN_ERROR` | Check `errorMessage` for the embedded mysql2 error code — often a missing privilege (e.g. `CREATE`/`ALTER` denied) surfacing from `setupDB()`'s DDL statements rather than the initial connection itself. |

## Never log the password

`checkConnection()`/`safeConfigInfo()` never include `password` in their
return value — by construction, not by convention. Anyone extending
`modules/db_config.js` must preserve that: if a new field genuinely needs
the raw config, keep it in a separate, clearly-internal function (like
`getPoolConfig()`) that nothing logs or serializes to an HTTP response.

## Cutover record: dedicated `flowtracker_app` user

**2026-08-12.** `erp_user` was left completely untouched — still live for
erp-backend/erp-genjaya-\*/xfact/cylo/idxflash. FlowTracker was moved to a
new user, `flowtracker_app`, scoped to `erp_manufacturing.*` (same schema,
no table migration — the deliberately lower-risk option). Grants mirrored
whatever `erp_user` actually had at cutover time (checked via `SHOW GRANTS`
first, not assumed). Password generated on the VPS via `openssl rand
-base64 24`, never composed locally or pasted through chat. Validated
standalone via the raw `mysql` CLI before `.env` was touched. `.env.example`
updated afterward to document `DB_USER=flowtracker_app` and drop the
"coordinate with other apps before rotating" warning, which is no longer
true for FlowTracker's own credential.
