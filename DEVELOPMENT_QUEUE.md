# FlowTracker Playmaker Queue

Authoritative coordinator: Codex live review

Dispatch revision: `2026-08-16-01`

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

Status: `AWAITING_REVIEW`

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

Status: `BLOCKED` by FT-P0-01A sequencing

Target outcome: one documented API routing strategy; `/scraper-api` works in local
development and production; backend failures render `DATA UNAVAILABLE`, never valid
zero/neutral market state.

### FT-HARM-01 — Remove harmonic from production recommendations

Status: `BLOCKED` by P0 containment

Target outcome: nightly harmonic output lands in an append-only shadow observation
store, never `ft_recommendations`, user win-rate denominators, or bot inputs.

### FT-DESIGN-01 — Enforce Promotion Contract lifecycle

Status: `BLOCKED` by P0 containment and incomplete S3 criteria

Target outcome: versioned append-only S0-S5 state machine; skipped stages impossible;
capital requires a valid S5 authorization record; contract change invalidates passes.

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
