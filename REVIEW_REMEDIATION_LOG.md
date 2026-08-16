# Review remediation log

Against `review.txt` (Codex deep application review, 2026-08-16), following the
LIVE REVIEW STATUS protocol: every entry carries **FIXED / PARTIAL / REGRESSION /
BLOCKED** and evidence produced *after* the change.

Evidence is re-run per entry rather than cited from an earlier session. Where a
finding is about exposure, verification is done from **outside the VPS** — a
route table cannot tell you whether a port is reachable.

---

## [P0-01] Unauthenticated mutating endpoints — **PARTIAL**

**2 of 21 routes closed.** The finding is not resolved and should not be marked
so; the remaining 19 need a client change first (see below).

### Correction to the finding: the count is 21, not 22

`POST /api/ft-pull` is deliberately unguarded and should be excluded. It is a
retired stub that returns HTTP 410 and performs no work, with the reasoning in
place at `scraper/server.js:1481`:

> *"No requireAdminKey: the point of this stub is to TELL a stale caller what
> happened, and a 401 does not do that. Nothing here is sensitive — it performs
> no work and reveals only that a retired endpoint is retired."*

Guarding it would make a stale caller receive 401 instead of the explanation.

### The exposure is confirmed, not theoretical

The review inferred risk. Measured on 2026-08-16:

```
VPS:    LISTEN 0.0.0.0:3100      ufw: inactive      iptables INPUT: ACCEPT, no rules
Outside VPS:  GET http://76.13.22.155:3100/api/health  ->  HTTP 200
```

So every unguarded mutation route was anonymously callable from the internet.
That includes `DELETE /api/recommendations/:id` — a table already wiped once,
52 rows to 0 on 2026-08-07, that time by an internal bug. No destructive endpoint
was exercised to establish this; the health GET is sufficient.

### Closed

| route | server.js | why safe to close now |
|---|---|---|
| `POST /api/sectors/pull` | 2279 | no caller in `app/`, `components/`, `lib/` |
| `POST /api/sectors/pull-broker` | 2310 | same |

`/api/sectors/pull` was more than a workload trigger: it takes `endpoint` from
the request body, concatenates it onto `SECTORS_BASE` and forwards our
`Authorization` header. Concatenation keeps requests on sectors.app — an absolute
URL lands as a path segment and `../` normalises within the origin — so it is not
a route to arbitrary hosts, but anonymous callers could spend our paid vendor key
against any path there.

**Evidence, after deploy, from outside the VPS:**

```
POST /api/sectors/pull         -> HTTP 401
POST /api/sectors/pull-broker  -> HTTP 401
GET  /api/health               -> HTTP 200   (control: intentionally public)
```

Unit suite 452 passing, 0 failing. Commit `c64e8d7`. Guarded mutation routes
16 -> 18; unguarded 22 -> 20 (of which 1 is the intentional stub above).

### Not closed, and why

The other 19 are all called by the frontend with plain `fetch()`. Adding
`requireAdminKey` without moving the client first would return 401 to the
application's own pages. A full inventory of 38 mutation routes against every
caller in `app/`, `components/` and `lib/` shows the work concentrates in **four
files**:

- `app/signal-scanner/page.tsx` — dominant caller: `POST /api/recommendations`
  x10, `DELETE /api/recommendations/:id` x5, `PATCH` x5,
  `DELETE /api/backtest/:runId` x6, plus `scanner/run`, `backtest/run`,
  `daily-picks/run`, `scan-weights`
- `app/simulation/page.tsx`, `app/admin/page.tsx`, `app/daily-picks/page.tsx`

`adminFetch` already exists in `lib/adminKey.ts` and is currently used by exactly
one page (`app/awo-dashboard/page.tsx`), which is the substance of P0-03.

**Open design question blocking the rest:** `adminFetch` puts the admin key in
the browser. That is reasonable for a single-operator panel and wrong for a page
served to the public. Which of those four pages are operator-only has to be
settled before the remaining routes can be closed correctly — otherwise the fix
moves a shared secret into public JavaScript rather than protecting anything.

---

## Not yet started

`P0-02`, `P0-03`, `P1-01` … `P2-03` — no work claimed.

Two entries under FAIL/BLOCKED in the review are environment gaps rather than
application defects, and are noted here so they are not weighted as equals to the
findings above: `scraper npm run db:check` and `test:verify` failed because the
reviewer's machine has no `.env`. The database is on the VPS and the repository
deliberately carries no credentials. The real defect is that the documented local
setup does not say so — a documentation fix, not a broken system.
