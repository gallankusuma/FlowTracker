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

**CORRECTION 2026-08-18 — the second half of that finding was wrong.** I wrote
that no nginx site proxies `/scraper-api`, so the production page had no route to
the API. That was an artefact of my own command: I searched with `grep -r`, and
every entry in `sites-enabled` is a symlink, which `-r` does not follow. `grep -R`
finds it immediately. The proxy exists and always did:

```
/etc/nginx/sites-available/flowtracker-direct   (listen 3200)
  location /scraper-api/ -> proxy_pass http://127.0.0.1:3100
  location /             -> proxy_pass http://127.0.0.1:3201   (Next.js)
```

Frontend and API are therefore served from **one origin**, which is exactly the
condition `SameSite=Strict` needs. Verified against the live box through the
public port, not inferred:

```
GET  :3200/scraper-api/api/operator/whoami  -> 401
GET  :3200/scraper-api/api/admin/watchlist  -> 401
POST :3200/scraper-api/api/operator/login   -> {"error":"invalid operator key","attemptsRemaining":4}
GET  :3200/scraper-api/api/health           -> 200
```

So the mechanism above still holds — only a same-site route can carry the
session, and CORS could never have substituted for one — but the conclusion drawn
from it does not. **FT-P0-01A is not blocked on transport; the transport is
already there.** FT-P0-02 remains worth doing on its own merits, and the reviewer
promoted it partly on my incorrect claim, so that promotion deserves re-reading
rather than being treated as settled. Machine callers on `x-admin-key` are
unaffected throughout.

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

---

## FT-DESIGN-01 / EXP-029 harness — env-path review corrections — **AWAITING_REVIEW**

Against `RESEARCH HARNESS ENV-PATH REVIEW 2026-08-18 18:10 ICT`. The reviewer
accepted `path.join(__dirname, '..', '.env')` as the correct resolution rule and
then found the defect the path change had left standing.

**The finding was right, and it is the one I should have caught.** `db41f20`
fixed WHERE the file is looked for and never checked WHETHER it was found: the
return of `dotenv.config()` was ignored. On a checkout without credentials the
harness therefore still fell through to `db_config`'s defaults and connected as
the old shared `erp_user` with no password — reported as *Access denied*, which
names a credential nobody chose, for a question nobody asked. I replaced one
silent fallback with a quieter one.

| # | correction | where |
|---|---|---|
| 1 | required input is checked **before any pool is constructed**, naming the file and why it matters | `scraper/research/env.js` `loadEnv()` |
| 2 | `AggregateError`/nested detail preserved — mysql2 connection failures carry an EMPTY `.message`, which printed as a bare `ERR` and looked handled | `env.js` `describeError()` walks `errors[]`, `cause`, then `code`, then the class name |
| 3 | this log entry | here |
| 4 | a reproducible invocation that does not need a database | `seal_candidate.js --offline` |

**Evidence, run from two working directories on a box with NO `scraper/.env`
(the reviewer's condition):**

```
node scraper/research/seal_candidate.js              -> exit 1, names the missing file
node scraper/research/seal_candidate.js --offline    -> exit 0
  execution policy hash : c1e3cc7a25dd6e3c
  incumbent  hash       : 0bd4f452f2ab01b3
  candidate  hash       : 3f98982baa68b452
  MODE: --offline. The hashes above are derived from source only.
```

Identical from `scraper/research/` and from the repository root, so cwd
independence holds.

**And the authoritative check, on the box that has the database:**

```
hashes live in virtual_accounts: 0bd4f452f2ab01b3
reproduces the live incumbent  : YES — the computation is the production one
exit=0
```

**On the two modes, deliberately not blurred.** `--offline` proves the identity
*arithmetic* and prints that it does not prove the incumbent hash is live. Only
the database-backed run does that, and it is the one that gates the seal. The
offline mode exists so a reviewer without credentials can reproduce the
derivation instead of receiving a blank `ERR` — it is not a substitute and its
own output says so.

**The sealed candidate was not touched.** `3f98982baa68b452` and the recorded
parameters are byte-identical to `CANDIDATE_SEAL_2026-08-18_vetofrac040.md`;
altering them to make a check pass is the one thing a seal must never permit.

Still open from the same review, and not claimed here: no candidate/control
shadow lifecycle exists yet, and it cannot accumulate anything while the regime
filter holds exposure at 0. `FT-P0-02` remains the only `READY` task.

---

## FT-P0-02 — frontend/backend API contract — **AWAITING_REVIEW**

Claimed `IN_PROGRESS` per the team protocol before any code was written.

### The corrected premise held, and the gap was the local half

Production was already right: nginx on `:3200` serves the app and proxies
`location /scraper-api/` to `127.0.0.1:3100`, so frontend and API share an
origin — the only arrangement a `SameSite=Strict` session cookie can travel
over. No second production proxy was built; `next.config.ts` returns no rewrite
under `NODE_ENV=production` unless `SCRAPER_UPSTREAM` is set deliberately.

What did not exist was the **local** equivalent. Nothing served `/scraper-api`
under `next dev`, so browser-side calls 404'd against the app itself.
`next.config.ts` now rewrites `/scraper-api/:path*` to `SCRAPER_UPSTREAM`,
defaulting to `127.0.0.1:3100` outside production. Documented in
`API_ROUTING.md`, including the trap that **`next start` bakes rewrites at BUILD
time**, so setting the variable only at runtime does nothing.

### P1-02 fixed as a prerequisite

`next dev` returned HTTP 500 for every page, so "works in local development"
could not be shown at all. The cause was not what the error line said:
`app/globals.css` is 245 lines with its imports at the top, but `@import
"tailwindcss"` expands INLINE and pushed the font import below ~1300 generated
rules, where `@import` is illegal. Font import now precedes tailwind.
`next build` had tolerated it — the broken path was the one no CI ran.

### A live regression this work uncovered, and it was mine

The deployed `app/admin/page.tsx` was dated **29 May** and `lib/operatorSession.ts`
was **absent from the box entirely**. FT-P0-01A guarded the server routes and the
frontend half was never deployed with them. In production the Admin page was
calling `/api/admin/*` with a plain `fetch` and no session, receiving 401 on
every call, and swallowing it with `.catch(() => {})` — rendering empty broker and
watchlist tables with no indication why. A fail-open UI over a fail-closed API,
which is the exact defect this task exists to remove. Exactly 2 of 41 tracked
frontend files had drifted; both are now deployed and the frontend rebuilt.

### Commands and evidence

Proxy contract, run against a stub upstream behind a real dev server
(`npm run test:routing`, kept out of `test:unit` because it spawns a server):

```
14 passed, 0 failed
  method / path rewrite / query / body survive
  Cookie and X-CSRF-Token reach upstream
  Set-Cookie returns with HttpOnly and SameSite=Strict intact
  401 and 503 propagate — not coerced to 200; error body survives
  no ADMIN_API_KEY or Authorization is ever injected
```

Local **production build** (`SCRAPER_UPSTREAM=http://127.0.0.1:3100 npm run build`
then `npx next start -p 3210`), driven in a browser over the same-origin path:

```
/admin unauthenticated        operator sign-in gate; panel withheld
wrong key                     "invalid operator key"
correct key                   panel renders, operator:optest-p002
read  GET /admin/watchlist    200, 122 rows
MUTATION, cookie but NO CSRF  403 {"error":"missing CSRF token"}
MUTATION, WRONG CSRF token    403
toggle BBTN (UI)              121 aktif / 122
toggle back (UI)              122 aktif / 122   — reversible, state restored
logout                        gate returns
post-logout GET watchlist     401
post-logout GET whoami        401
post-logout replayed mutation 401 {"error":"no valid operator session"}
```

Storage and URL hygiene, read from the page while signed in:

```
localStorage (empty)   sessionStorage (empty)
document.cookie        ft_csrf only        ft_op readable by JS: false
operator key anywhere client-side: false   URL: http://localhost:3210/admin
```

Upstream cut **mid-session** (tunnel killed while the page was open):

```
proxy /scraper-api/api/health   500   — not 200, not an empty body
badge                           ● API OFFLINE
watchlist                       122 aktif / 122 total, all rows still shown
reload action                   ❌ Reload failed - HTTP 500
```

Failure stated, previous data preserved, nothing zeroed or emptied.

Production routing through `/scraper-api` on `:3200`:

```
/api/health 200   /api/operator/whoami 401   /api/admin/watchlist 401
/api/admin/broker-config 401
login, wrong key -> {"error":"invalid operator key","attemptsRemaining":4}
Set-Cookie: ft_op=;   Path=/; SameSite=Strict; Max-Age=0; HttpOnly
Set-Cookie: ft_csrf=; Path=/; SameSite=Strict; Max-Age=0
```

Cookie attributes survive nginx unchanged.

### Two defects fixed that the evidence run exposed

- **The health badge reported cached success.** Fetched once on mount and never
  re-checked, it read `API ONLINE` after the upstream had gone. Now polled every
  30s with `cache: "no-store"`, `r.ok` checked before parsing, interval cleared
  on unmount, and four states so that "not checked yet" and "stale" are not
  disguised as "online".
- **`TampermonkeyPanel` was nearly "fixed" into breakage.** Its absolute origin
  lives inside a userscript that runs on rti.co.id and stockbit.com, where a
  relative `/scraper-api` would resolve against THOSE origins. `test_api_origins.js`
  now separates legitimate absolute origins from real debt, and asserts each
  legitimate entry is either the apiConfig authority or a genuine userscript.

### Ratchet

`scraper/test_api_origins.js` enumerates the four pages that still bypass the
same-site contract (`daily-picks`, `journey`, `screener`, `stockbit-connector`).
The list may only shrink; a new hardcoded origin fails the suite. They are
outside this slice and none can carry an operator session.

### The gate, and what its previous greens did not cover

`predeploy_check.sh` — **`ALL SUITES PASSED`, exit 0, 4 of 4 steps** (credential
preflight, unit, golden fixture, integration), run alone with nothing else
touching the database.

It took two attempts, and the first failure is worth more than the pass.
Syncing `scraper/package.json` from the repository turned the gate red with
`Cannot find module .../test_candle_geometry.js`. The file had never been
deployed, **and the box's own `package.json` did not reference it** — the two
were consistent in the same omission, so nothing ever complained.

So every earlier "ALL SUITES PASSED" on that box, including the ones cited in
this log today, meant *"every suite this machine happens to list passed"*, not
*"every suite in the repository passed"*. The same shape as the defects this
slice removes: a check that looks total while its scope has quietly shrunk.

Fixed, and verified by enumeration rather than by trusting the fix: all 24 files
referenced by `test:unit`, `test:verify` and `test:integration` are now present on
the box. `.deployed-commit` stamped `c9ddf97`.

**Not claimed:** that the two `--update-golden` re-baselines earlier today are
accepted. The reviewer blocked them for regenerating from mutable database state,
and that objection is unaffected by this run.

---

## Golden fixture — identified input — **AWAITING_REVIEW**

Against the standing objection: *"Never green the gate by accepting current
mutable database state... generate from an immutable/versioned input snapshot
with reviewed economic deltas."*

**The objection was right and the diagnosis was precise.** The fixture pinned an
OUTPUT computed from an input nobody recorded, so a change in the database was
indistinguishable from a change in the code — the hash moved and the diff blamed
whichever line had been touched last. That is how two re-baselines landed in a
single day, each explaining an output that had moved for reasons outside the file
being edited.

**What was built.** Storing the input itself is impractical (1.15M price rows).
Storing its *identity* is not, and "identified" is the word the objection uses.
`verify_strategy_book.js` now digests the exact three result sets `load()` reads —
`idx_ihsg_history`, `idx_stock_prices WHERE close_price > 0`, `idx_concentration` —
with a per-table breakdown, and the fixture carries it:

```
input digest e8933bb2ce97f61c
  idx_ihsg_history      2,422   2016-08-01 .. 2026-08-14   8adbe4d9dbd31d76
  idx_stock_prices  1,145,730   2016-08-01 .. 2026-08-14   f15984dbbbb5bdae
  idx_concentration   100,457   2024-01-02 .. 2026-08-14   7444d08670f5a236
```

An input change is now reported **as** an input change, before any output is
compared:

```
FAIL  the INPUT changed since this fixture was taken
        fixture input cafebabecafebabe   now d44db1c538bb936e
        ~ idx_stock_prices: 1145430 -> 1146330 rows (+900), 2016-08-01..2026-08-18
        A fixture is a claim about OUTPUT GIVEN INPUT. Regenerating it now
        would record a different claim, not repair this one.
```

**Proven by injection, not asserted.** A false identity written into the fixture
produced exactly the above, naming the table and the delta; restoring the fixture
returned the check to PASS.

**Bounded by `windowEnd`, and the bound is what makes it usable.** The first
version hashed whole tables, so the session that arrived today moved the digest —
the fixture would have failed every morning for a reason unrelated to the code.
That is the same mistake `windowEnd` already exists to prevent, and this file's
own comment warns that a daily-red check is one people regenerate without
reading. Caught before commit. Bounded, the digest moves only when data INSIDE
the window changes — a backfill, a recalculation, a repaired hole — which is
precisely the event that must not pass unnoticed. Demonstrated: bounding drops
2,423 -> 2,422 ihsg rows, 1,146,330 -> 1,145,730 prices, 101,031 -> 100,457
concentration, all of it today's session.

**Determinism:** identical digest across consecutive runs (`e8933bb2ce97f61c`).

**This re-baseline moves no economic number.** trades 256, finalEquity 1.396172,
maxDrawdown 0.163719, output hash `9b41c9d4c5b2512992c607777e0ede14` — all
unchanged from the committed fixture. It records which input the already-passing
fixture corresponds to, which is the opposite of greening a gate by accepting
whatever the database happened to hold. 18 passed, 0 failed.

**Gate, run alone after the change:** `predeploy_check.sh` exit 0,
`ALL SUITES PASSED`, 4 of 4 steps, and inside it the fixture step now reports

```
input digest e8933bb2ce97f61c  ihsg_history=2422  stock_prices=1145730  concentration=100457
PASS  the input is the one this fixture was taken from (e8933bb2ce97f61c)
```

so the gate's own log carries the identity of the data it passed against.
`.deployed-commit` stamped `3ebf3af`.

**What this does NOT do, stated plainly:** it does not make the check runnable
without a database, and it does not retroactively validate the two earlier
re-baselines. It makes the next one impossible to perform silently.

---

## FT-CONC-01 — the three acceptance gaps — **AWAITING_REVIEW**

Against `CONCENTRATION NULL-PERSISTENCE FOLLOW-UP 2026-08-18 11:05 ICT`: *"no
database round-trip fixture, no explicit f2/f8 missing-session fixture, and no
remaining reference-session parity fixtures."* All three, in that order.

### 1. The 15-point parity claim is now executable, not documented

The module comment asserted *"across all 15 reference points per-side is off by a
mean 0.089, by-magnitude by 3.732"* while the suite contained **one** real
fixture. The reviewer's phrasing was exact — that is documentation. A number
nobody can re-run is a claim about a computation that happened once.

`scraper/fixtures/concentration_reference_15.json` now carries the **raw
per-broker nets** for all fifteen ticker-sessions as read from
`idx_broker_summary`, with the value flowtracker.id published for each. It is
frozen in the repository rather than re-queried, so a later backfill cannot move
the evidence the way one moved the strategy-book fixture. The suite iterates it:

```
15 individual session assertions (value within 0.35, sign must agree)
+ mean |err| <= 0.089 across all 15
+ per-side beats by-magnitude by >20x on the same set
+ the three discriminating sessions EXIST and still discriminate by >10 points
+ a digest of the raw nets, so editing the data invalidates the claim
```

`node test_concentration_formula.js` — **29 passed, 0 failed** (was 10).

The discriminator test is the one that matters most. Fifteen green sessions prove
nothing about *which* reading is right if all fifteen happen to split 3/3, so the
suite asserts by name that BBCA 2026-08-11, TLKM 2026-08-11 and TLKM 2026-08-14
are present and that the rival reading is still >10 points worse on each.

### 2. The database round-trip, and what it found

`scraper/test_concentration_nullability.js`, wired into `test:integration`.
A unit test cannot answer this: the null has four more places to die after the
formula returns it — a `NOT NULL` column, the INSERT, the **`ON DUPLICATE KEY
UPDATE` path** (a second writer, where `COALESCE(VALUES(dn1), dn1)` would leave
yesterday's number standing in place of today's gap), and the API serializer.

Isolated under `stock_code = '__NULTEST'` on 1999 dates, deleted pass or fail.
**14 passed, 0 failed** against production MySQL, including a real zero stored
next to a null so the pair stays distinguishable, and a live census —
**1,168 of 4,447 rows since 2026-08-01 carry at least one null**, which is the
assertion that fails if the writer ever returns to `?? 0`.

### 3. f2/f8 over a missing session — this was not just a missing test

The reviewer asked for evidence. Writing it found a defect that had been in
production the whole time, and it is worse than the coercion it was meant to
check for.

Both factors opened with `dnValues.filter(v => v !== null)`, and four call sites
filtered again before calling them. `dn0..dn4` are five **consecutive** sessions,
so filtering closes the hole up and **renumbers the days**. `f8_streak` then
counted a run straight through the session nobody observed.

Live on 2026-08-20, `BEEF` read `[23.12, 4.61, 44.8, null, 0.1]`. Compacted, the
engine published a **four-session accumulation streak**. Four sessions were not
observed in a row. This does not merely treat missing data as neutral — it
manufactures evidence of continuity out of an absence of data.

**Not rare:** 2,087 of 34,447 rows since 2026-01-01 (**6.1%**) carry an interior gap.

Fixed in `modules/awo_factors.js`: `runToGap()` ends a run at the first
unobserved session, and `positionalWeightedAvg()` gives recency weight to the day
that actually held the value. The acceleration bonus now requires three
*consecutive observed* sessions. The four call sites that pre-filtered
(`score_engine.js`, two in `server.js`) no longer do.

**Blast radius, measured before and after on live data (34,447 rows):**

| | changed | max move |
|---|---|---|
| f2 | 2,831 (8.22%) | 8.00 pts |
| f8 | 682 (1.98%) | 35 pts |

**In 682 of 682 cases the OLD value was the more extreme claim.** The fix only
ever withdraws confidence; it never invents a stronger signal. A complete window
scores byte-identically, which the suite asserts.

`node test_awo_factors.js` — **31 passed, 0 failed** (was 23). The eight new tests
were written first and five of them failed against the old code.

### Gate

`predeploy_check.sh` on the box, run alone: credential preflight **PASS**, unit
**PASS**, golden fixture **PASS**, integration **PASS**. The script still exits 1,
and correctly — `.deployed-commit` was older than the source I had just copied
across, which is exactly the stamp-drift check it exists for. Re-stamped and
re-run below.

**Not claimed:** this does not revisit the strategy-book fixture dispute, and the
`?? 0` on the READ side of `f1`/`f7` is untouched — for those two a stored 0 and a
null both map to a neutral 50, so it is currently harmless, but it is a coercion
and it is written down here rather than quietly left.

---

## FT-FLOW-01 — the UI contract, the boundary, the build — **AWAITING_REVIEW**

Against `FLOW ANALYZER VALUE REVIEW 2026-08-18 10:50 ICT`: *"Rename the visible
labels to TRANSACTION VALUE / LAST VAL (and preferably the internal key/helper),
add a focused filter/sort fixture at the 10B boundary, then run the frontend
build before acceptance."*

**The finding was right and it was the important half.** `88574a3` moved display,
filter and sort onto one-sided `buyValue` and left every name saying TURNOVER —
the two-sided figure, `SUM(buy_val + sell_val)`, exactly 2x the value that
changed hands. Correct arithmetic under a label that contradicts it is not a fix:
a user reading TURNOVER and typing "min 10" is asking for something the column
does not contain, and nothing on screen says so.

### Renamed, all the way through

| | before | after |
|---|---|---|
| column header | `TURNOVER` | `LAST VAL` |
| filter labels | `TURNOVER MIN/MAX (B)` | `LAST VAL MIN/MAX (B)` |
| sort key | `"turnover"` | `"lastVal"` |
| parser | local `parseLastVal`, comment about turnover | `lib/lastVal.js`, documented as one-sided |

The `turnover`/`turnoverRaw` fields stay in the row type with a comment saying
what they are and that nothing reads them. The API still sends them; deleting
them from the type would misdescribe the payload rather than remove it.

### The 10B boundary — and why the helper had to move first

A boundary cannot be pinned by a component that only runs in a browser. The
parser and the range predicate now live in `lib/lastVal.js`, plain CommonJS on
purpose: the page imports it through webpack and `scraper/test_last_val.js`
requires it directly, so **the code under test is the code that ships**. The
suite asserts that too — if the page grows its own `parseLastVal` again, the test
fails rather than quietly testing a copy.

`node scraper/test_last_val.js` — **15 passed, 0 failed**:

- exactly `10.0B` passes a min of 10 **and** a max of 10; the bound is inclusive,
  because the row a number names must survive the filter that names it, and an
  exclusive bound drops it invisibly
- `9.99B` out, `10.01B` in
- the defect itself, stated as a test: a 5B one-sided stock prints 10B of
  turnover, and must **not** survive a 10B floor
- an empty box matches everything — `NaN` means "not filtering", not "nothing
  matches", and reversing that empties the table the moment a user clears a field
- every suffix `formatVal` emits, including the `929.2K` and bare-number cases
  that used to read a million and a billion times too large
- filter and sort share a scale: no kept row may sort below a dropped one
- no *rendered* label says TURNOVER (comments may still discuss it)

The frontend tree is located rather than assumed — on the VPS it is a **sibling**
of the scraper, not its parent, the same correction `test_api_origins.js` needed.

### Build

`npx tsc --noEmit` clean. `npm run build` **exit 0, compiled successfully**, with
the single pre-existing Turbopack NFT warning about `next.config.ts` and no CSS
warning (that one was the `@import` ordering fixed under P1-02).

`npm run test:unit` — **25 suites, 0 failures**, with `test_last_val.js` wired
into `test` and `test:unit`.
