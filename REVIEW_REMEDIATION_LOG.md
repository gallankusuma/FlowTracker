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

**Dispatch 2026-08-16-02 returned this PARTIAL with seven corrections. All seven
are done, each with a test that fails without the fix:**

| # | Correction | Where |
|---|------------|-------|
| 1 | Brute-force bound on `/api/operator/login` — 5 failures per client, 15-minute window and lockout, `429` with `attemptsRemaining` | `operator_session.js` `loginState` |
| 2 | Actor identity bound server-side; a caller can no longer name itself. The audit records a key **fingerprint**, never the key | `serverActorIdentity()` |
| 3 | `Secure` set from the real socket, not from a spoofable `X-Forwarded-Proto`; `X-Forwarded-For` honoured only behind a trusted proxy | `requestIsSecure`/`clientIp` |
| 4 | Test runner actually awaits, plus coverage for a missing pool and for unfinalized audit rows | `test_operator_session.js` |
| 5 | Ratchet now proves `requireOperator` is defined before use **and delegates to the tested module** — a local lookalike that waved everything through would have satisfied every other check | `test_route_authorization.js` |
| 6 | UI stopped treating refusals as data. `opJson()` throws a typed `OpError`; 401/403/503 no longer arrive as `d.data \|\| []`, which rendered "no brokers configured" — a claim about the data — when the truth was "you are signed out". Pending edits survive a rejected write | `lib/operatorSession.ts`, `app/admin/page.tsx` |
| 7 | Browser transport resolved and the click-path actually driven — see below | this entry |

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

Suites: `test_operator_session.js` **39/39**, `test_route_authorization.js`
**10/10**. Frontend production build compiled successfully, 30/30 static pages.

The `23/23` figure previously printed here was not evidence. Codex found the
runner was `try { fn() }` with no `await`, so every async test resolved after the
`catch` had already gone by; a deliberately broken probe (`assert.strictEqual(1,
2)`) still reported PASS. The runner now awaits each case, and carries a
self-check that registers a rejecting test and asserts the runner sees it —
so the suite proves it can fail before it claims anything passed.

**Scope kept narrow.** No route on the pending list was touched.
`/api/admin/reload-config` was included because `handleSaveBrokers()` calls it
immediately after a bulk save, so leaving it on the key guard would have
half-broken the very flow being migrated; it was already guarded, so the pending
count is unaffected — it moved from key to session, it was not opened.

**Browser click-path — now actually driven, 2026-08-16.**

The previous entry said the click-path was unproven and offered a compiled build
in its place. Codex correctly refused that, so it was driven for real.

*Rig.* Production build served on `localhost:3210`; a throwaway instance of the
API on an isolated port, reached through an SSH tunnel so the page and the API
are **same-site**. That detail is not incidental — see the finding below. The
throwaway instance ran with its own one-shot key and with the daily cron and the
600-ticker Yahoo warm-up patched out, because a temporary process must not
schedule work. The live process on 3100 was never restarted, and the temporary
copy was deleted afterwards. The production `ADMIN_API_KEY` was never used.

*Observed, in order, in the browser:*

```
/admin unauthenticated      -> operator sign-in gate renders; the panel does not
sign in, wrong key          -> "invalid operator key"; panel still withheld
sign in, correct key        -> panel renders, header reads operator:optest-c7
Watchlist tab               -> 122 active / 122 total, read via the session
click "Nonaktifkan" BBTN    -> 121 active / 122; row flips to NONAKTIF
click "Aktifkan" BBTN       -> 122 active / 122  (state restored)
click "sign out"            -> gate returns
```

*Network, same run* — every mutation preflighted, then carried the cookie:

```
GET  /api/operator/whoami        401     POST /api/operator/login    401  (wrong key)
POST /api/operator/login         200     GET  /api/operator/whoami   200
GET  /api/admin/broker-config    200     GET  /api/admin/watchlist   200
OPTIONS /api/admin/watchlist/BBTN 204 -> PUT /api/admin/watchlist/BBTN 200   (x2)
```

*Storage, read from the page while signed in* — this is the acceptance criterion
that is easiest to pass by accident and hardest to notice failing:

```
localStorage                     (empty)
sessionStorage                   (empty)
document.cookie                  ft_csrf=... only
ft_op readable by JS             false      <- httpOnly holds
operator key anywhere in storage/URL   false
```

*Logout is a real revocation, not a UI state change.* After signing out, a direct
`fetch` from the page returned **401** for both the read and `whoami`, and a
mutation **replayed with the still-valid-looking CSRF token** was refused
`401 no valid operator session`. A logout that only hides the panel is the
fail-open version of this feature, so it was tested as a server question.

*The audit trail recorded the whole path, denials included:*

```
anonymous          none     GET /api/admin/watchlist      DENIED  401
anonymous          login    POST /api/operator/login      DENIED  401
operator:optest-c7 login    POST /api/operator/login      ALLOWED 200
operator:optest-c7 session  PUT /api/admin/watchlist/BBTN ALLOWED 200   (x2, target BBTN)
operator           logout   POST /api/operator/logout     ALLOWED 200
anonymous          none     PUT /api/admin/watchlist/BBTN DENIED  401
```

**A finding that changes the choice the review offered.** The dispatch allowed
"explicit CORS allowlist **or** same-origin route". Only the second works. The
session cookie is `SameSite=Strict`, so no CORS grant can make a browser send it
cross-site — CORS governs whether a response may be *read*, never whether a
cookie is *sent*. A CORS allowlist is therefore sufficient only when the frontend
is already same-site with the API, which is the case this rig had to construct.
The allowlist half was verified anyway and behaves correctly: an allowlisted
origin is echoed back with `Access-Control-Allow-Credentials: true`, and a
non-allowlisted origin receives **no** `Access-Control-Allow-Origin` header at
all. No code change was needed — `cors` already reflects when given an array.

This makes **FT-P0-02 a prerequisite for the browser half of every future slice**,
not an independent item: today `API_BASE` resolves to `/scraper-api`, and no nginx
site on the box proxies that path, so the production page has no working route to
the API at all. Machine callers on `x-admin-key` are unaffected throughout.

**Deploy status: NOT deployed, deliberately.** `predeploy_check.sh` ends in
`SOMETHING FAILED — do not deploy`. The failure is `verify_strategy_book.js`
(*"every per-date target book, open and close matches"*, *"overall hash matches"* —
15 passed, 2 failed) and it is **pre-existing**: the VPS files were restored to
their as-found hashes and the fixture still fails identically, so it is not caused
by this slice. Every other suite in the gate reports 0 failures. The gate was
honoured — the running process on 3100 was left untouched and the corrected files
were rolled back off the box, so disk and memory still agree. This work deploys
when the golden fixture is resolved (open finding, 2026-08-11).

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
