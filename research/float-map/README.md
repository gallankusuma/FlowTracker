# Float Map — research scripts

The generator for the Float Cost Map. **The repo is the source of truth**;
`/root/research` on the VPS is a deployed copy. Before this directory existed
the scripts lived only on the box, so changing `TURNOVER_K` from 0.75 to 0.90
would have changed every published number with nothing in git able to say when
or why.

See [MODEL.md](MODEL.md) for what the model does, what each output is worth, and
where it is known to be wrong.

## Files

| | |
|---|---|
| `float_fetch.js` | free float from Yahoo → `idx_free_float`. Weekly. |
| `float_map_daily.js` | whole-universe nightly pass → `idx_float_map_daily` + the JSON snapshot the page reads |
| `float_cost_map.js` | single-ticker map with a confidence score, for inspection at a terminal |
| `exp023_float_map_ic.js` | the IC study behind EXP-2026-08-07-023, with `--from` / `--float-noise` / `--seed` sensitivity switches |

## Deploy

```bash
./sync_research.sh
```

Refuses to run with uncommitted changes in this directory, and stamps
`.model-commit` next to the scripts. That commit travels into every snapshot —
a snapshot stamped with a commit that does not contain the running code would be
worse than one stamped with nothing, because it would look auditable.

## Schedule (system crontab on the VPS)

```
50 13 * * 1-5   float_map_daily.js     # after the IDX nightly chain ends at 13:40
 0  2 * * 0     float_fetch.js 100     # free float moves on corporate actions, not on Tuesdays
```

13:50 UTC is deliberate: the IDX resolve/schedule/mark/reconcile chain runs
13:05–13:40 and is what the operational burn-in measures. This must never
compete with it for the box.

Both commands are dry-run under `env -i PATH=/usr/bin:/bin` before being
trusted — a cron job that cannot find `node` fails silently every night and
looks exactly like a job that ran.

## Isolation

Read-only against everything the IDX engine owns. Nothing lives in
`/var/www/flowtracker-scraper`, which is frozen for the burn-in and whose
`predeploy_check.sh` fails when any `.js` in that tree is newer than the
deployed-commit stamp.

## Snapshot contract

`float_map_daily.js` writes `/var/www/flowtracker/data/float-map.json`, read at
request time by `app/api/float-map/route.ts`. **Not** `public/` — Next 16
snapshots that directory at build time, so a file written afterwards 404s until
the next rebuild.

Every snapshot carries its own provenance and the date of each input, because a
job that stops running still serves HTTP 200 and still looks like today:

```json
{
  "modelVersion": "FLOAT_MAP_V1",
  "modelCommit": "e5dd5e7",
  "turnoverCoefficient": 0.75,
  "generatedAt": "...", "session": "...",
  "priceMaxDate": "...", "brokerMaxDate": "...", "freeFloatAsOf": "..."
}
```

The page reads those dates and **disables the ranking** when the snapshot is
stale, rather than showing an old one that looks current. Stale-but-valid is
more dangerous than missing, because it looks legitimate.
