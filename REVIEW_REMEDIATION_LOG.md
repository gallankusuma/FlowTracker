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

### Update 2026-08-16 — authorization ratchet added

The review's remaining acceptance criteria included *"automated authorization
tests that enumerate every Express route"* and *"CI fails when a new mutation
route is registered without an auth policy"*. Both are now satisfied by
`scraper/test_route_authorization.js`, wired into `test:unit`.

It is a **ratchet**, not a flat assertion, because 19 routes genuinely cannot be
closed today and a permanently-red test is one nobody reads. Every mutation route
must fall into exactly one of three declared buckets:

```
38 mutation routes
  guarded by requireAdminKey : 18
  intentionally public       :  1   (POST /api/ft-pull, with the reason recorded)
  pending (P0-01)            : 19   (enumerated by name; the list may only SHRINK)
```

Anything outside all three fails the suite immediately. **Verified by injection**
rather than assumed: adding `DELETE /api/__injected_probe/:id` to server.js made
the test fail naming that exact route, and reverting restored green.

The test also guards against regression on what is already closed — both
Sectors.app routes must keep `requireAdminKey` — and checks that
`requireAdminKey` itself still returns 401/403, compares in constant time, and
refuses with 503 when `ADMIN_API_KEY` is unset rather than falling open.

Suite 459 passing, 0 failing.

**One discrepancy with the review's Evidence list, in the stricter direction.**
That list carries 18 routes; the pending set here carries 19. The extra is
`POST /api/sectors/configure` (`server.js:2268`), which sets the Sectors.app API
key at runtime and is called from `components/SectorsApiPanel.tsx:18`. It belongs
in the count.

### FT-P0-01A — operator boundary, Admin slice — **AWAITING_REVIEW**

Route-count delta: **guarded 18 → 21, pending 19 → 16, intentionally public 1 → 3.**

Codex's 16:38 checkpoint raised two corrections. Both were real defects in the
first draft and both are fixed with tests that fail without the fix:

- **Audit was fire-and-forget and stamped every admitted request `200 ALLOWED`
  before the handler ran.** It now writes an `ATTEMPTED` row first and stamps the
  REAL `res.statusCode` on `finish`, so a handler that 500s is recorded `FAILED`.
  Fail-closed is defined rather than assumed: **mutations refuse with 503 when
  the attempt cannot be recorded** (a state change that cannot be attributed must
  not happen), **reads are best-effort but logged loudly** (a GET leaves nothing
  to attribute, and refusing it protects nobody), and **denials are never
  upgraded** (a 401 must not become a 503, or the audit path becomes a probe).
- **`decodeURIComponent` threw on malformed percent-encoding.** The Cookie header
  is attacker-controlled, so that was a crash reachable anonymously on the
  authorization boundary. Undecodable values are now kept raw and simply fail to
  match. My original test used `%20` — valid encoding — so it proved tolerance of
  malformed *structure* while leaving malformed *encoding* untested; the new test
  uses `%ZZ`, a lone `%`, and a truncated UTF-8 sequence.

**Design.** No session facility existed to reuse (deps are cors, dotenv, express,
mysql2, puppeteer), so `modules/operator_session.js` is ~200 lines with no new
dependency. Two admission paths, deliberately different: a **browser** path on an
httpOnly `ft_op` cookie, which is ambient and therefore requires CSRF on every
mutation; and a **machine** path on `x-admin-key`, which is not ambient — no
browser attaches it cross-site — so demanding CSRF there would protect nothing
and break the cron and CLI callers. The CSRF token is compared against the
**session**, not against the cookie: the usual double-submit mistake passes for
anyone able to write both.

**Evidence, live against `76.13.22.155:3100` after deploy.**

Unauthorized — all eight routes in the slice:

```
GET    /api/admin/broker-config      -> 401      POST   /api/admin/watchlist          -> 401
PUT    /api/admin/broker-config/AK   -> 401      PUT    /api/admin/watchlist/BBCA     -> 401
POST   /api/admin/broker-config/bulk -> 401      DELETE /api/admin/watchlist/BBCA     -> 401
GET    /api/admin/watchlist          -> 401      POST   /api/admin/reload-config      -> 401
```

Login, session, CSRF:

```
login, wrong key                            -> 401
login, correct key                          -> 200   ft_op HttpOnly=yes, ft_csrf HttpOnly=no
session GET  /api/admin/watchlist           -> 200   (reads need no CSRF token)
session PUT  /api/admin/watchlist/BBCA      -> 403   no CSRF token
session PUT  /api/admin/watchlist/BBCA      -> 403   wrong CSRF token
session PUT  /api/admin/watchlist/BBCA      -> 200   correct CSRF token
machine GET  /api/admin/broker-config       -> 200   x-admin-key, no CSRF needed
```

Audit trail, read back from `ft_operator_audit` — actor, route, action, target,
timestamp and outcome, with the real status:

```
anonymous          none       PUT    /api/admin/watchlist/BBCA   BBCA  DENIED   401
anonymous          login      POST   /api/operator/login         -     DENIED   401
operator           login      POST   /api/operator/login         -     ALLOWED  200
operator           session    PUT    /api/admin/watchlist/BBCA   BBCA  ALLOWED  200
machine:admin-key  admin-key  GET    /api/admin/broker-config    -     ALLOWED  200
```

Secret hygiene: the production `ADMIN_API_KEY` **value** was grepped for across
`.next/static` and is **absent**. The literal string `ADMIN_API_KEY` does appear —
in UI copy on `app/awo-dashboard/page.tsx`, which is the legacy
`lib/adminKey.ts` localStorage path. That page is outside this slice and was not
touched, but it is exactly the pattern this task replaces and is the obvious next
migration.

Suites: `test_operator_session.js` 23/23, `test_route_authorization.js` 7/7, full
unit suite **482 passing, 0 failing** across 22 files. Frontend production build
compiled successfully, 30/30 static pages.

**Scope kept narrow.** No route on the pending list was touched.
`/api/admin/reload-config` was included because `handleSaveBrokers()` calls it
immediately after a bulk save, so leaving it on the key guard would have
half-broken the very flow being migrated; it was already guarded, so the pending
count is unaffected — it moved from key to session, it was not opened.

**Not verified, and stated rather than implied:** the browser UI flow end to end.
`npm run dev` returns HTTP 500 from `app/globals.css:1322` (P1-02), so the page
could not be exercised in a live browser. The production build passes and every
server-side behaviour above is verified by request, but the click-path is
unproven. Related: with no `CORS_ALLOWED_ORIGINS` set, the API still answers
`Access-Control-Allow-Origin: *`, and browsers refuse to send cookies to a
wildcard origin — so the browser session needs either the same-origin routing
FT-P0-02 is heading for, or that variable set. Machine callers are unaffected.

---

## Candlestick architecture decision — ACKNOWLEDGED

The 2026-08-16 decision (**RETAIN AS SHADOW CONTEXT; NO-GO AS A STANDALONE SIGNAL
SYSTEM**) is accepted as written. Recorded here so the constraints are not
rediscovered later:

- no standalone candlestick BUY/SELL, no hard veto, no F15, no change to the AWO
  composite, no sizing/stop/target effect
- **no expansion to a 101-pattern production taxonomy** — this closes the open
  question of translating the remaining definitions
- no selecting only the best discovery patterns after seeing results
- runtime mode stays `CANDLE_MODE=SHADOW`, all candle output non-actionable

Worth noting for whoever builds the Candle Context Engine: the required output
contract is almost exactly what the research modules already emit — `resolved`,
`unresolvedReason`, `geometryReliable`, `ticksInRange`, `bodyRatio`,
`upperWickRatio`, `lowerWickRatio`, `closeLocation`, `rangeVsAtr`, gap versus
prior close, strictly-prior trend/location context, and taxonomy version/hash.
Shadow wiring is therefore an integration task, not a rebuild.

Per the review's own priority ruling, this work stays **behind** P0-01, P0-02,
P0-03, the hardcoded API origins, and restoring development/integration testing.
No production wiring has been started.

---

## Not yet started

`P0-02`, `P0-03`, `P1-01` … `P2-03` — no work claimed.

Two entries under FAIL/BLOCKED in the review are environment gaps rather than
application defects, and are noted here so they are not weighted as equals to the
findings above: `scraper npm run db:check` and `test:verify` failed because the
reviewer's machine has no `.env`. The database is on the VPS and the repository
deliberately carries no credentials. The real defect is that the documented local
setup does not say so — a documentation fix, not a broken system.
