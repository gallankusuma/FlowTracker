# FlowTracker Playmaker Queue

Authoritative coordinator: Codex live review

Dispatch revision: `2026-08-16-03`

TEAM ACTION REQUIRED NOW: claim `FT-P0-01A`, change its status from `READY` to
`IN_PROGRESS`, and implement only the first vertical slice defined below. This is an
active work order, not a placeholder awaiting another Codex review. Do not continue
polling unchanged baselines after seeing this revision.

Operating rule: the development team takes only the first `READY` item. Do not start
lower items in parallel unless the active item explicitly says it is safe. After a
commit, update `REVIEW_REMEDIATION_LOG.md` with evidence and set the item to
`AWAITING_REVIEW`. Codex verifies it, updates `review.txt`, and promotes the next item.

Status vocabulary:

- `READY` — safe next task for development
- `IN_PROGRESS` — team has claimed the task
- `AWAITING_REVIEW` — implementation committed; Codex verification pending
- `PARTIAL` — improvement landed but acceptance is incomplete
- `FIXED` — independently verified against all acceptance criteria
- `BLOCKED` — needs a product/authority decision; team must not guess

## Active task

### FT-P0-01A — Decide and enforce the operator boundary

Status: `PARTIAL — production transport exists; blocked by deploy gate and remaining acceptance`

Review state: `PARTIAL — backend boundary verified; production browser path absent`

Review verdict: `REJECTED FOR CORRECTION — 2026-08-16 16:51 ICT`

Accepted evidence from this delivery:

- Unauthorized coverage for all eight slice routes: 401.
- Session GET succeeds; mutation without/wrong CSRF is 403; correct CSRF succeeds.
- Ratchet passes 7/7; guarded count 18→21 and pending count 19→16.
- Full unit command exits zero and production build passes.
- Key value absent from `.next/static` according to the submitted grep evidence.

Correction dispatch `2026-08-16-02 — EXECUTE NOW`:

1. Add bounded login brute-force protection with deterministic tests. This cannot be
   deferred: the slice introduced the public static-key login endpoint.
2. Bind audit actor to a server-controlled accountable identity; generic `operator`
   is a role, not an identity. Do not accept actor from request input.
3. Stop trusting raw forwarded headers unless Express is configured for a trusted
   proxy. Use the direct socket otherwise and test spoofed headers.
4. Make the operator test runner truly await async tests; add missing-pool and failed
   finalization/reconciliation coverage. Report results only after rejected promises
   cause non-zero exit.
5. Add requireOperator-specific ratchet checks for definition-before-use and actual
   delegation to the tested boundary.
6. Fix Admin UI response handling: every protected read/write must check `Response.ok`;
   401/403/503 must remain auth/unavailable/error states, and rejected writes must not
   show success or erase valid data. Wrap login in try/catch/finally.
7. Resolve browser transport for this slice (explicit CORS allowlist or same-origin
   route) and submit an actual UI click-path recording/evidence. A production compile
   does not replace the required affected-flow verification.

After corrections: rerun the full unit suite and build, update
`REVIEW_REMEDIATION_LOG.md`, commit narrowly, and return to `AWAITING_REVIEW`.

Team claim protocol for the next correction returns after FT-P0-02 is independently
verified. Do not deploy this slice around a red predeploy gate.

Committed correction evidence: `0366b257` (2026-08-16 17:25 ICT). Scope contains only
the operator boundary/UI/tests/remediation log; unrelated research changes remain out.

Early correction review — `2026-08-16 16:58 ICT`:

- Rate limiter, server-derived actor, trusted-proxy helpers, missing-pool failure, and
  an awaited runner structure have been drafted.
- **REGRESSION:** `test_operator_session.js` defines `runAll()` but never calls it.
  Independent execution exits zero with **0 passed, 0 failed**. Invoke/await the runner
  before computing the exit code and add a self-test that deliberately rejects.
- Once invoked, update the existing Secure-cookie test: a raw forwarded-proto header
  must no longer enable Secure unless the request app explicitly trusts its proxy.
- `findUnfinalized()` is dead code and only lists rows; it does not alert, retry, or
  reconcile anything. Wire an operational consumer with testable behavior, or narrow
  the contract to an explicit unresolved audit state with health/alert visibility.

Runner follow-up — `2026-08-16 16:59 ICT`:

- The runner invocation/self-check is now present. Independent result is a trustworthy
  **38 passed, 1 failed**, not 0/0.
- The remaining failure is exactly the stale Secure-cookie assertion: it still expects
  an untrusted raw `x-forwarded-proto: https` header to enable Secure. Update the test
  to require explicit proxy trust; retain the passing real-TLS and spoof-rejection tests.

Security-suite checkpoint — `2026-08-16 17:01 ICT`:

- Operator session suite independently passes **39/39** with awaited async assertions.
- Authorization ratchet independently passes **10/10**, including requireOperator
  definition-before-use, delegation, and boundary-refusal checks.
- Corrections 1–5 have credible unit evidence. Remaining before handback: correction 6
  (checked UI responses + login finally), correction 7 (working browser transport and
  actual UI-flow evidence), and an operational consumer/health signal for unresolved
  ATTEMPTED audit rows rather than an unused query helper.

UI-helper checkpoint — `2026-08-16 17:02 ICT`:

- `opJson()` now models auth/forbidden/unavailable/error correctly, but Admin page has
  zero callers and still uses unchecked `opFetch(...).json()` everywhere. Migrate every
  protected read/write to the checked path and render/preserve the resulting state.

UI-migration checkpoint — `2026-08-16 17:03 ICT`:

- Admin protected calls now use opJson, preserve prior data/input on failure, expose an
  alert, expire auth state on 401, and use login try/finally. Production build passes
  with only the two unrelated baseline warnings.
- Correct the broker bulk-save sequencing message: if bulk save and refresh succeed but
  reload-config fails, the current catch reports generic “Save failed” after data was
  actually persisted and dirty edits were cleared. Track/save and reload as separate
  outcomes so the UI says “saved; reload failed” and never invites a duplicate retry.
- Browser transport/click-path and operational unresolved-audit visibility remain.

Handed back 2026-08-16. Both 16:38 checkpoint corrections are fixed with tests
(audit outcome now observed not assumed, with fail-closed defined per verb class;
malformed percent-encoding no longer throws on the authorization boundary).
Route-count delta: guarded 18 -> 21, pending 19 -> 16. Evidence in
REVIEW_REMEDIATION_LOG.md. Browser click-path NOT verified — `npm run dev` is
broken by P1-02.

Claimed: 2026-08-16 by development team (Claude), authorized by the project owner
in-session. Scope held to the first vertical slice: Admin broker-config + Admin
watchlist. No other pending mutation route is touched in this delivery.

Dispatch: `2026-08-16-01 — EXECUTE NOW`

First delivery boundary (keep this commit narrow):

- Inventory the exact Admin broker-config and Admin watchlist frontend callers and
  backend routes.
- Add the smallest server-side operator-session boundary covering that slice, with
  CSRF enforcement and audit identity. Reuse a sound existing session facility if
  one exists; do not invent a public key-forwarding proxy.
- Migrate those callers and add unauthorized, authorized, and CSRF-negative tests.
- Do not touch the other pending mutation routes in this delivery.
- If a required product credential or session authority is genuinely unavailable,
  mark this item `BLOCKED` with the exact missing decision instead of guessing.

Team handback protocol for this delivery:

1. Immediately change this item to `IN_PROGRESS` so ownership is visible.
2. Implement and test the narrow slice.
3. Commit the implementation and append commands/results plus route-count delta to
   `REVIEW_REMEDIATION_LOG.md`.
4. Change this item to `AWAITING_REVIEW`; Codex will independently verify it.

Early review checkpoint — `2026-08-16 16:38 ICT`:

- `scraper/test_operator_session.js`: **17/17 passed**.
- The session/CSRF admission primitive is directionally sound, but do not integrate
  it unchanged yet.
- Required correction: authorization audit cannot be fire-and-forget and label every
  admitted request as HTTP 200 `ALLOWED`. Capture the real response status/outcome
  after the handler completes, and define fail-closed behavior when the durable audit
  record required by acceptance cannot be written.
- Required correction: malformed percent-encoding in the Cookie header currently
  makes `decodeURIComponent()` throw. Parse invalid cookies defensively and prove the
  request is rejected without a 500/crash.
- Required evidence still missing: authenticated session issuance/identity binding,
  logout/revocation, actual route integration, client migration, durable audit test,
  authorization-ratchet delta, affected UI flow, full unit suite, and frontend build.

Integration checkpoint — `2026-08-16 16:39 ICT`:

- `scraper/server.js` now references `requireOperator` on seven slice routes but does
  not yet import or define it. The server will raise `ReferenceError` while registering
  those routes; wire the middleware factory with the pool explicitly.
- `node --check server.js`: pass (syntax only).
- `node test_route_authorization.js`: **6 passed, 1 failed**. The ratchet recognizes
  only `requireAdminKey`, so two previously guarded POST routes are reported as newly
  unauthenticated after switching to `requireOperator`.
- Extend the ratchet parser to recognize the approved `requireOperator` boundary and
  assert that it is defined before use. This is not permission to weaken the pending
  list or broadly accept arbitrary middleware names.

Correction checkpoint — `2026-08-16 16:41 ICT`:

- Malformed-cookie handling is corrected and covered.
- Reported operator-session result is **23/23**, but the three new audit tests are
  async functions executed by a synchronous test harness. They are counted as passed
  before their promises settle, so this is not valid acceptance evidence. Make the
  harness await each test and surface rejected promises/non-zero exit reliably.
- Pre-writing `ATTEMPTED` is a useful fail-closed admission record, but the `finish`
  update remains best-effort; a failed finalization leaves no durable true outcome.
  Add a durable/retryable finalization design (or explicitly model ATTEMPTED as an
  unresolved state and alert/reconcile it) and test the failure path. An inaccurate
  outcome must not silently appear complete.
- `recordAttempt(null, ...)` currently returns null rather than failing. Prove a
  mutating request cannot proceed when the audit pool is absent/miswired.

Follow-up checkpoint — `2026-08-16 16:42 ICT`:

- The previously undefined `requireOperator` reference is now wired lazily to the DB
  pool: that specific blocker is resolved.
- Operator-session test still prints 23/23 with the synchronous async-test flaw
  unchanged; authorization ratchet remains **6 passed, 1 failed**.
- No session issuance/identity binding or client migration exists yet. Continue the
  active task; it is not ready for handback.

Session-endpoint checkpoint — `2026-08-16 16:43 ICT`:

- Login/logout/whoami endpoints now exist, but the public login accepts the static
  admin key with no rate limit/backoff or brute-force test. Add a bounded server-side
  limiter and audit denials without logging credentials.
- `actor: 'operator'` identifies only a shared role, not an accountable operator.
  Bind actor identity to server-controlled credential/configuration; never accept the
  audit actor from the request body.
- Raw `x-forwarded-for` and `x-forwarded-proto` are trusted even when the request did
  not come through a configured trusted proxy. This permits forged audit IPs and can
  produce incorrect Secure-cookie behavior. Use Express trusted-proxy semantics or
  the direct socket unless a proxy is explicitly trusted.
- The Admin client remains unchanged and does not send credentials/CSRF or expose a
  login state. Client migration and end-to-end flow remain required.

Ratchet/client checkpoint — `2026-08-16 16:44 ICT`:

- Authorization ratchet now passes **7/7** and pending routes shrink from 19 to 16.
  This is valid partial progress, not completion of P0-01.
- Add the explicitly requested assertion that `requireOperator` is defined before its
  first guarded route and that its implementation delegates to the tested boundary;
  the current definition-before-use/rejection checks still cover only requireAdminKey.
- The login route comment declares rate limiting “outside FT-P0-01A”. Rejected: this
  slice creates the new internet-facing static-key admission endpoint, so brute-force
  resistance is part of safely completing this slice, not deferred debt.
- `lib/operatorSession.ts` is a reasonable credentialed-fetch primitive. The actual
  Admin page still needs migration, must clear its key input/state immediately after
  login, distinguish 401/403/503 from empty data, and prove the built client contains
  no key value.

UI/build checkpoint — `2026-08-16 16:49 ICT`:

- Admin UI is now session-gated, uses `opFetch`, and clears key state after successful
  exchange. Frontend production build passes; existing CSS late-import and NFT tracing
  warnings remain unrelated.
- Full scraper unit command exits green, including ratchet 7/7, but the operator audit
  async-test runner defect still makes its displayed 23/23 unsuitable as evidence.
- UI acceptance is still incomplete: protected reads call `r.json()` without checking
  `r.ok`, converting 401/403/503 into empty arrays; writes also ignore non-2xx and can
  display success after rejection. Centralize response checking, preserve the auth or
  unavailable state, and never render a failed backend response as valid empty data.
- `handleOperatorLogin` needs `try/finally`: a network/parse exception currently leaves
  the button busy and produces an unhandled rejection.
- Rate limiting, trusted-proxy handling, accountable actor identity, durable audit
  reconciliation, guard-specific ratchet assertions, and live HTTP/UI evidence remain.

Objective: resolve the design decision blocking the remaining 19 unauthenticated
mutation routes without exposing `ADMIN_API_KEY` to public users or breaking the
application's own workflows.

Why this is first: port 3100 is externally reachable and the remaining surface can
modify/delete records or trigger workloads. Candlestick, harmonic, promotion-state,
and new trading features remain behind this containment work.

Required design before implementation:

1. Classify each caller page as public read-only, authenticated operator, or removed.
2. Define a server-side authenticated operator session. Do not solve this with a
   public Next.js proxy that injects the static admin key.
3. Define CSRF protection, session expiry, audit identity, and 401/403 behavior.
4. Map all 19 pending routes to the operator role or retire them.
5. Preserve the deliberate public HTTP-410 `/api/ft-pull` stub.

Implementation scope:

- Centralize authorization policy at the route boundary.
- Migrate one coherent vertical slice first: Admin broker config + Admin watchlist.
- Protect both reads and writes in that slice.
- Update the browser client to use the operator session, not localStorage admin-key
  forwarding for normal production use.
- Shrink `PENDING_UNGUARDED` only for routes actually protected.

Acceptance evidence required:

- Unauthorized requests to every migrated route return 401/403.
- Authorized operator requests succeed.
- CSRF attempt is rejected.
- No admin secret appears in the client bundle, browser storage, URL, or logs.
- Audit record identifies actor, route, action, target, timestamp, and outcome.
- `test_route_authorization.js` passes and its pending count decreases.
- Frontend production build and affected UI flow pass.
- Existing unit suite remains green.

Do not:

- Guard all routes at once while their clients still use plain `fetch()`.
- Embed `ADMIN_API_KEY` in `NEXT_PUBLIC_*`.
- Create an anonymous server proxy that injects the key.
- Relax the authorization ratchet or add new entries to the pending list.

## Next tasks — held until active task review

### FT-P0-02 — Repair the frontend/backend API contract

Status: `IN_PROGRESS — claimed 2026-08-18, scope: audit/codify the existing production route`

Dispatch: `2026-08-16-03 — EXECUTE NOW (dependency unblocker)`

Target outcome: one documented API routing strategy; `/scraper-api` works in local
development and production; backend failures render `DATA UNAVAILABLE`, never valid
zero/neutral market state.

Corrected premise (commit `c01e87d`): production already serves frontend and API from
one origin through nginx `location /scraper-api/ -> 127.0.0.1:3100`. The earlier
absence finding came from a recursive search that did not follow sites-enabled
symlinks. This item remains READY only to make the existing contract auditable and
test its failure semantics; it is not authorization to build a second proxy. No
harmonic/candle/trading expansion is authorized.

Implementation scope:

- Document and test the existing same-site `/scraper-api/*` production contract and
  establish an equivalent local-development path; preserve method, body, query,
  Set-Cookie, Cookie, status, and `X-CSRF-Token` behavior.
- Fail closed when upstream is unavailable. Do not synthesize empty arrays, zeros,
  neutral market states, HTTP 200, or cached success without an explicit stale label.
- Document the authoritative public/browser API base and remove conflicting hardcoded
  origins only where required for this vertical slice.
- Do not create an anonymous proxy that injects `ADMIN_API_KEY` or logs credentials.
- Keep CORS restrictive for any remaining direct API access; same-site proxy is the
  browser-session path.

Acceptance evidence required:

- Local production build served normally: `/admin` login, wrong/correct key, reads,
  CSRF-negative mutation, successful reversible mutation, logout, and post-logout 401.
- Equivalent production routing evidence through `/scraper-api`, with cookie flags and
  storage/URL secret hygiene recorded.
- Upstream-down test renders explicit unavailable state and preserves previous data.
- Proxy tests prove Set-Cookie/Cookie and non-2xx status propagation without key
  injection; authorization suites and full unit suite stay green; frontend build passes.
- `predeploy_check.sh` must be green. The reported pre-existing strategy-book fixture
  failure must be fixed or dispositioned through an explicit reviewed baseline update;
  never bypass, delete, or weaken the gate.

Team protocol: claim this item as `IN_PROGRESS`, commit narrowly, append exact commands
and evidence to REVIEW_REMEDIATION_LOG.md, then set `AWAITING_REVIEW`.

### FT-HARM-01 — Remove harmonic from production recommendations

Status: `BLOCKED` by P0 containment

Target outcome: nightly harmonic output lands in an append-only shadow observation
store, never `ft_recommendations`, user win-rate denominators, or bot inputs.

### FT-CONC-01 — Preserve concentration null semantics

Status: `REGRESSION — NOT READY; unauthorized work detected while FT-P0-02 remains active`

Observed evidence: the focused concentration suite passes 9/9 and the new formula is
integrated, but `dnValues[n] ?? 0` converts the formula's not-applicable null into a
measured neutral zero before persistence.

Required correction before review: keep null through idx_concentration persistence and
all API/downstream consumers; add an integration fixture proving a no-accumulation
session remains null after write/read; prove f2/f8 do not treat missing sessions as
neutral observations; remove superseded dead NG/model state; provide the remaining
reference-session parity fixtures or narrow the five-session claim. This item is not
promoted: FT-P0-02 remains the only READY task.

Follow-up 2026-08-18 09:21 ICT: dead NG/model state is removed and model_version is
now v3, but null-to-zero persistence remains. Status stays REGRESSION; no promotion.

Commit checkpoint: `062d59d` landed; focused suite 9/9, acceptance still fails on
committed `dnValues[0..4] ?? 0`. FT-P0-02 remains the only READY task.

09:30 ICT: documentation now claims 15 reference points, but executable evidence still
contains one real reference fixture. Null persistence remains unfixed; no status change.

Commit `8a6bf36`: focused suite 10/10 and the TLKM sign-flip discriminator is now
executable. Formula-choice evidence improves; null persistence still fails acceptance.

09:35 ICT working tree: verify_strategy_book diagnostics improved and stale NG
commentary removed. Local gate is BLOCKED by ECONNREFUSED localhost:3306; null-to-zero
remains unchanged. No acceptance or promotion.

Commit `eb7c6d0` checkpoint: diagnostics now expose eligible/vetoed population drift,
but the mutable-depth fixture remains red and undispositioned. No gate acceptance;
FT-P0-02 remains READY and FT-CONC-01 remains REGRESSION.

09:44 ICT fixture rewrite is BLOCKED: it changes books, 272 -> 256 trades, final
equity 1.508661 -> 1.396172, drawdown 0.134480 -> 0.163719, CAGR 0.201032 ->
0.158422, and windowEnd 2026-08-05 -> 2026-08-13. Restore the intended frozen
window and regenerate only from an immutable/versioned input snapshot with reviewed
economic deltas. Never green the gate by accepting current mutable database state.

Commit `6710de5` committed the blocked re-baseline and claims 17/17. Status remains
BLOCKED pending immutable input identity, justified windowEnd policy, remediation-log
evidence, and an independent rerun. Do not use the committed fixture alone to unblock
predeploy or FT-P0-02 acceptance.

Working-tree signal 2026-08-18 11:09 ICT: the committed golden was rewritten again
(eligible 75 -> 66 and 88 -> 76; vetoed 15 -> 13 and 17 -> 15; hash changed) while
economic outputs and the shifted 2026-08-13 window remain. Independent verification is
BLOCKED by `ECONNREFUSED localhost:3306`. Restore/generate from an immutable identified
input snapshot and independently rerun before accepting any fixture update.

Commit checkpoint `cc76055`: the second same-day re-baseline landed and attributes the
drift to a 642,433-row price-history backfill. That explains the mutation but does not
freeze or version the input snapshot; independent verification remains unavailable
because localhost MySQL is down. Status stays BLOCKED/REGRESSION.

Working-tree checkpoint 2026-08-18 11:05 ICT: the writer now preserves missing
`dn0..dn4` as null instead of measured zero. Independent syntax validation and the
focused AWO factor suite pass (23/23), including neutral scoring for missing `dn0`.
FT-CONC-01 improves from REGRESSION to PARTIAL, but is not FIXED: submit the required
database write/read fixture plus explicit f2/f8 missing-session evidence and remaining
reference-session parity evidence. FT-P0-02 remains the only READY task.

Commit checkpoint `dcb9052`: the narrow persistence correction landed unchanged and
the same independent syntax/23-of-23 focused checks pass. Status remains PARTIAL; the
commit message's production-history assertion is not a substitute for the missing
executable database round-trip and f2/f8 fixtures.

### FT-FLOW-01 — Align Flow Analyzer transaction-value semantics

Status: `PARTIAL — NOT READY; FT-P0-02 remains the only READY task`

Working-tree evidence: display/filter/sort now use `buyValue` consistently, but visible
labels still say TURNOVER and internal sorting/parsing names retain the doubled-field
meaning. Required correction: label the column and range filters TRANSACTION VALUE or
LAST VAL, align the internal semantic names, add a 10B boundary filter/sort test, and
provide a passing frontend build. Do not promote ahead of FT-P0-02.

Commit `88574a3` checkpoint: numeric field alignment landed, semantic labels and
boundary/build evidence did not. Status remains PARTIAL; no promotion.

### FT-DESIGN-01 — Enforce Promotion Contract lifecycle

Status: `BLOCKED` by P0 containment and incomplete S3 criteria

Target outcome: versioned append-only S0-S5 state machine; skipped stages impossible;
capital requires a valid S5 authorization record; contract change invalidates passes.

Candidate-seal checkpoint 2026-08-18 12:31 ICT: the seal, four research probes, generator,
and experiment note are now staged. All five scripts pass syntax checking; the generator
reproduces incumbent `0bd4f452f2ab01b3`, candidate `3f98982baa68b452`, and execution
policy `c1e3cc7a25dd6e3c` locally. Its mandatory live-database confirmation cannot run
because MySQL is unavailable. This is stronger reproducible identity evidence, but not
a durable seal or runnable shadow until committed. Keep BLOCKED. Required correction:
commit the append-only/versioned seal and generator evidence, wire a zero-capital
candidate/control shadow lifecycle that records pre-outcome decisions, and prove the
deferred trigger cannot mutate parameters or bypass S0-S4.

Commit checkpoint `bc9e90d`: the seven-file EXP-029/seal bundle is now versioned and
all five committed scripts independently pass syntax checking. This satisfies durable
candidate identity/pre-registration, not promotion or shadow activation. Status stays
PARTIAL/BLOCKED pending a DB-backed incumbent-hash rerun and the tested zero-capital
candidate/control lifecycle; FT-P0-02 remains the only READY task.

Commit checkpoint `db41f20` (2026-08-18 18:10 ICT): the five research/seal harnesses
now resolve `scraper/.env` from `__dirname`, so a present environment file is no longer
dependent on the caller's working directory. Independent syntax checks pass for all
five files, the seal prints the unchanged execution/incumbent/candidate hashes from
both the repository root and `scraper/research`, and the full unit suite plus frontend
production build remain green (with the two existing build warnings).

This is PARTIAL reproducibility progress, not the missing DB-backed acceptance. In the
review workspace `scraper/.env` is absent; `dotenv.config()`'s result is ignored, so the
harness still silently falls back to `erp_user` with no password. `db:check` fails with
`DB_UNREACHABLE`, and `seal_candidate.js` prints a blank `ERR` then exits 1 from both
working directories. No `REVIEW_REMEDIATION_LOG.md` update accompanies the commit.
Required correction: fail explicitly on a missing/unreadable named env file (or other
missing required DB configuration), preserve the real nested DB error rather than an
empty message, and submit a reproducible DB-backed run proving the live incumbent hash
without changing the sealed candidate. FT-DESIGN-01 remains PARTIAL/BLOCKED and
FT-P0-02 remains the only READY task.

### FT-CANDLE-01 — Wire Candle Context Engine

Status: `BLOCKED` by P0 containment

Target outcome: numerical candle context attached to primary signals with
`actionable=false`; no F15, veto, sizing, stop, target, or 101-pattern expansion.

## Playmaker protocol

After each team revision:

1. Team commits a narrow change and updates `REVIEW_REMEDIATION_LOG.md`.
2. Codex detects it through the one-minute live-review heartbeat.
3. Codex reviews the diff and executes proportionate verification.
4. Codex updates `review.txt` and this queue.
5. If acceptance passes, Codex marks the item `FIXED` and promotes exactly one next
   item to `READY`.
6. If partial or regressed, the same item stays active with a concrete correction.

No feature reaches production merely because implementation is complete. Evidence
and promotion state, not confidence or urgency, control progression.
