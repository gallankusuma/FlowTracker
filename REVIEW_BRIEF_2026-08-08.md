# Review Brief — 2026-08-08 (rev 2)

**For the review team.** Rev 2 applies the review verdict *APPROVE AFTER MINOR REVISION (9.3/10)*: all 5 P1 and 3 P2 items. Raw feedback preserved in `REVIEW_BRIEF_2026-08-08_reviewer_feedback.md`. Change log in §9.

Short version: for 8 days the IDX signal engine served 31 July data as the latest available state, without a staleness refusal or an explicit warning, while its own burn-in gate recorded `passed` for every session it judged. Partly fixed. The root cause is external to this codebase; local code can only fail closed until the upstream source is replaced.

---

## 1. How this surfaced

The Pattern Replay review set one precondition before any feature work:

> "berapa hari history yang benar-benar lengkap? … Karena kalau hari yang hilang diperlakukan nol, pattern-nya palsu."

Auditing `idx_signal_history` to answer that is what opened everything else. The precondition was right and it saved us from building on rotten data.

---

## 2. Done and verified

### 2.1 Nine phantom dates purged — DONE

979 rows on 9 non-session dates deleted from `idx_signal_history`:
`2026-05-01, 05-14, 05-15, 05-23, 05-27, 05-28, 05-30, 06-01, 06-06`

Verified through two independent paths before deleting: **zero** price bars and **zero** IHSG bars on all nine. Three are Saturdays, the rest IDX holidays. All sourced `backfill_v2`, so this is a backfill-generator defect, not the live feed.

Pre-delete backup: `/root/backups/idx_signal_history-before-cleanup-2026-08-08.sql` (VPS).
After: 17,183 rows, 119 days, zero non-session dates remaining.

Same defect class as the 2026-08-04 phantom price-session purge.

### 2.2 The "27 multi-source dates" concern — DID NOT HOLD

I originally proposed a source-priority rule (`live` wins). **Not needed.** The query returns **zero** duplicate `(data_date, stock_code)` pairs. Those dates simply carry different tickers from different sources; no rows collide, and no look-ahead comes from it. My proposal was wrong and is withdrawn.

### 2.3 Staleness refusal in `/api/signal-scanner` — DEPLOYED

`server.js:6158`. The endpoint now returns **503** instead of presenting stale scores as the current state.

Verified live:
```
HTTP 503
{"source":"stale-broker-feed","stale":true,"sessionsBehind":5,
 "latestBrokerDate":"2026-07-31","latestSessionDate":"2026-08-07"}
```

The scanner's clock was deliberately **not** moved to the price tables. `idx_stock_prices` is current through 08-07, so moving it would make the endpoint look alive again — but f1 concentration and the broker factor family read from the same frozen tables. That combination is worse than a stale response:

```
fresh timestamp + incomplete factor state = false freshness
```

**Review outcome: the team agreed with REFUSE, and sharpened it into a contract we should adopt.** The scanner should not have a clock at all; it should have a readiness contract:

```
SIGNAL_DATE = latest exchange session for which
              ALL REQUIRED INPUT FAMILIES are current

not max(price_date), and not max(broker_date)
```

```
required inputs:            SIGNAL ENGINE
  PRICE   current ✓         READY = false
  IHSG    current ✓         reason: BROKER_DATA_STALE
  BROKER  current ✗
  CONC    current ✗
```

The deployed fix is the degenerate case of this contract (one input family checked). Generalising it to a declared input-family list is **open work**, not done.

Zero lines of scoring math changed, so `strategy_hash` does not move.

### 2.4 `brokerDataCurrent` check in the burn-in gate — DEPLOYED

`watchdog.js:521`. Verified live:
```
session_date 2026-08-07 · passed 0 · brokerDataCurrent false
priceDataCurrent true · failures_json ["brokerDataCurrent"]
```

---

## 3. The main finding, and the part that most needs criticism

**The broker-data pipeline stopped advancing on 2026-07-31.** The source table and the broker-derived tables all froze on the same date — `idx_concentration` is derived from broker data, so this is one pipeline failing, not three independent feeds:

| table | newest | role |
|---|---|---|
| `idx_broker_summary` | 2026-07-31 | source |
| `idx_broker_flow_detail` | 2026-07-31 | source |
| `idx_concentration` | 2026-07-31 | broker-derived |
| `idx_stock_prices` | 2026-08-07 | unaffected |
| `idx_ihsg_history` | 2026-08-07 | unaffected |

`/api/signal-scanner` took its notion of "today" from `idx_broker_summary`, not from prices (`server.js:6152`). For 8 days it served 31 July scores, dated 31 July, with no staleness indication in the UI — correct as a date stamp, misleading as a presentation, because nothing told the reader the engine could not see past it. The snapshot write at the end of the handler rewrote 31 July with identical values, so even the row count never moved; there was no signal at all that anything was wrong.

### 3.1 The burn-in gate was blind in exactly the place it failed

For each of the **three recorded burn-in sessions** (2026-08-05, 08-06, 08-07), the gate ran its checks and recorded `passed: 1`:

```json
"priceDataCurrent": true,   ← honestly true, prices were current
"calendarCurrent":  true,   ← honestly true, the calendar was fine
```

**Not one check asked whether the broker data was still advancing.** I am scoping this claim to the three sessions actually on record; I have no evidence about nights before the burn-in began.

### 3.2 The part that bothers me most: the information already existed, but bound nothing

The watchdog **had** been detecting this:

> `broker is stale (idx_broker_summary): 5 trading days behind (tolerance 2). Not auto-repaired: this feed is owned by another job…`

But it was written as a **WARNING**. A warning binds nothing, so the same night the burn-in gate still wrote `passed: 1`. The system knew, said so, and passed itself anyway.

The real defect is not *broker feed stale*. It is **detection without enforcement**.

**Review outcome: the team escalated this and specified the remedy.** Sweep the whole health system and classify every condition:

```
INFO · ADVISORY · DEGRADED · BLOCKING
```

with a hard rule:

```
condition affects correctness
        ↓
cannot be WARNING-only
        ↓
must bind readiness / burn-in
```

Examples: disk at 70% → ADVISORY. Optional analytics stale → DEGRADED. Required broker input stale → BLOCKING. Exchange calendar unknown → BLOCKING. Reconciliation mismatch → BLOCKING. Severity must not be decided by whether someone reached for `console.warn()` or `console.error()`.

This sweep is **open work**.

---

## 4. Impact on the burn-in

The Virtual Broker V2 burn-in started **2026-08-05**. The broker pipeline froze **2026-07-31**.

**All three recorded burn-in sessions used stale broker-dependent inputs, while their price and calendar inputs remained current.** No session ever ran with a live broker feed.

No rows were deleted. The burn-in resets itself correctly: the streak requires consecutive sessions, 08-07 now fails, so the count returns to zero. The three old green sessions stay on record as evidence that the system once misjudged itself. That should remain readable rather than be cleaned up.

### 4.1 Identity churn — evidence

The review asked for the actual hashes rather than an observation. `virtual_burnin`, all rows:

| id | session_date | identity_hash | engine_version | created_at |
|---|---|---|---|---|
| 3 | 2026-08-05 | `legacy` | 0 | 2026-08-05 13:50:08 |
| 5 | 2026-08-05 | `0de1a38e0a5fd471` | 2 | 2026-08-06 04:41:27 |
| 6 | 2026-08-05 | `b5c7583de4c1bd19` | 2 | 2026-08-06 07:36:57 |
| 7 | 2026-08-05 | `09e1fac7efc8c23b` | 2 | 2026-08-06 10:29:48 |
| 8 | 2026-08-06 | `be3804cec6fa1e37` | 2 | 2026-08-06 13:48:16 |
| 53 | 2026-08-07 | `3689a8284af11825` | 2 | 2026-08-07 13:50:07 |

This corrects my own earlier framing. It is **not** three intra-day shifts in production. It is **four verdicts for one session date (2026-08-05)**, written across two calendar days, with `engine_version` moving 0 → 2 — i.e. re-runs during a period of active deploys, each re-run minting a new identity for the same session.

That is the more worrying shape, not the less: every identity that has ever judged a session has judged exactly one. The 10-session count has never actually started. The question the review poses stands, and I cannot answer it from the data alone:

> **What exactly invalidates burn-in comparability?** Strategy change? Execution semantics? Risk semantics? Protocol? Infra implementation? UI? A watchdog-only patch?

If a watchdog-only patch resets the evidence window while strategy behaviour is unchanged, the hash is too broad — and note that **my own fix in §2.4 is exactly such a patch**, so this is not hypothetical. Open work.

---

## 5. Still open

1. **The broker pipeline is still stopped.** Its source is the permanently banned flowtracker.id account. Both fixes above make the system **honest about its blindness, not cured of it**. Until a replacement exists, the scanner refuses every day and the burn-in cannot reach a clean session. That is correct fail-closed behaviour, not a new bug.
2. **Six real exchange sessions have no snapshots at all:** `2026-06-15, 06-22, 06-29, 07-13, 07-15, 07-16` — their price bars are complete. Plus five August sessions lost to the stopped pipeline. **Failure mode to prevent:** an H-5…H-1 window crossing these *would silently become* a 4-day window while still being labelled 5-day. The required behaviour, which the review approved firmly:
   ```
   Expected  H-5 H-4 H-3 H-2 H-1
              ✓   ✓   ✗   ✓   ✓

   not "use four observations"
   not "shift H-6 into H-5"
   not "missing = 0"

   → WINDOW_INCOMPLETE · eligible = false · missingSession = 2026-07-15
   ```
   Because **5 observations ≠ 5 consecutive exchange sessions.** Pattern research must run on the canonical exchange-session sequence.
3. **Snapshot persistence is architecture debt, not a missing cron.** Snapshots are written as a side effect of an HTTP GET; nothing calls `/api/signal-scanner` from cron, so history only grows when a human opens the page. A cron was deliberately not installed while the pipeline is dead. But once the source is restored, the fix is **not** a cron that GETs the endpoint:
   ```
   daily pipeline → validate required inputs → compute snapshot → persist → API only READS
   ```
   A GET endpoint should not be the scheduler or the history mechanism. Pattern Replay needs deterministic historical evidence, so snapshot persistence must become a first-class scheduled stage.
4. **One canonical lag constant — value still undecided.** I previously wrote "worth aligning to 2". The review rejected that reasoning and it is withdrawn: align the *semantics*, not the existing number. The question to answer first is *how many exchange sessions may broker data lag before a signal is invalid?* For an EOD scanner running after the pipeline should have finished, the answer may well be **0**; if the pipeline is T+1 by design, **1**. If anyone proposes 2, they must explain why a signal built on two-day-old broker state is still valid. Then define one constant:
   ```
   BROKER_DATA_MAX_LAG_SESSIONS
   ```
   used by scanner readiness, watchdog warning, burn-in gate, Trust Center, and Pattern Replay completeness. **No literal 1 in one place and 2 in another.** Today the deployed code has exactly that split (gate 1, warning 2) — a known defect, recorded rather than papered over.
5. **The `live` period is ~22 sessions, and row count will overstate it.** Winners-vs-controls research (items 8–10) must be restricted to it. 22 dates × ~100 stocks is **not** 2,200 independent observations: names on the same date share IHSG regime, macro events and liquidity conditions. An `N = 2,000, p < 0.01` would be false confidence. Use date-blocked splits and bootstrap, not row-random splits, and label every result from this window **EXPLORATORY / NOT PROMOTABLE** until the time-series sample grows.

---

## 6. Corrections to my own statements

Recorded because this team's value comes from catching what slips:

- I said the burn-in started "around 22 July". **Wrong.** 22 July is when signal snapshots became continuous; the burn-in started 5 August.
- I said history was missing **because** the page wasn't being opened. **Incomplete.** That explains the June–July gaps but is not why it stopped on 31 July.
- I suspected calling the endpoint **overwrote** the 07-31 snapshot with today's factors. **Wrong.** Diffed against the backup: zero rows changed. No data was corrupted.
- I proposed a source-priority rule for the 27 dates. **Not needed** — zero duplicates.
- I described the identity churn as "three shifts in one day". **Imprecise.** It is four verdicts for one session date across two days (§4.1).
- I proposed aligning the lag tolerance to 2. **Wrong reasoning** — copying the existing number instead of deriving it (§5.4).

---

## 7. Deploy status

| | |
|---|---|
| Implementation + deploy commit | `302597a` — `server.js`, `watchdog.js` |
| Brief (rev 1, English) | `72f3fc0` |
| Brief (rev 2, this revision) | see git log |
| `flowtracker-scraper` | restart 44 → 45, deployed, verified live |
| `flowtracker` (frontend) | untouched |
| `strategy_hash` | unmoved (zero scoring-math changes) |
| Backup | `/root/backups/idx_signal_history-before-cleanup-2026-08-08.sql` |

---

## 8. Hold on Pattern Replay

Per the review's closing instruction, **Pattern Replay P1 does not start** until both hold:

1. the broker source has a replacement, and
2. the snapshot writer is separated from the HTTP request path.

Otherwise we build careful analytics on top of history whose holes are structural.

---

## 9. Rev 2 change log

| Sev | Section | Change |
|---|---|---|
| P1 | Short version | "stale numbers dated as today" → "serving 31 July data as the latest available state without a staleness refusal or explicit warning" (it *was* correctly dated; the failure was the absence of a refusal) |
| P1 | Short version | "cannot be fixed with code" → "external to this codebase; local code can only fail closed until the upstream source is replaced" |
| P1 | §3 | "all three tables at once" → one broker-data pipeline; `idx_concentration` labelled broker-derived |
| P1 | §4 | "ran entirely on stale broker data" → "used stale broker-dependent inputs, while price and calendar inputs remained current" |
| P1 | §3.1 | Scoped to the three recorded burn-in sessions; no claim about earlier nights |
| P1 | §5.4 | "align to 2" withdrawn; replaced with deriving one canonical `BROKER_DATA_MAX_LAG_SESSIONS` from the operating contract |
| P1 | §7 | Both commits distinguished (implementation vs brief) |
| P2 | §5.2 | "becomes a 4-day window" → "would silently become" (failure mode to prevent) |
| P2 | §4.1 | Identity hashes, engine versions and timestamps added; my "3× in one day" corrected |
| P2 | §5.5 | Added N-inflation trap, date-blocked bootstrap, EXPLORATORY / NOT PROMOTABLE labelling |
| — | §2.3, §3.2 | Reviewer's readiness contract and INFO/ADVISORY/DEGRADED/BLOCKING taxonomy adopted as open work |
| — | §5.3 | Reframed from "install a cron later" to architecture debt with the pipeline-owns-persistence target |
| — | §8 | Added the hold on Pattern Replay P1 |

---

## 10. Severity sweep — 2026-08-09

Closes §3.2 (the taxonomy) and §5.4 (the canonical constant). Appended rather
than edited into the sections above, so the reviewed text stays as reviewed.

### 10.1 The constant, derived rather than chosen

§5.4 asked what the tolerance should be and refused to let it be copied. Measured
from `idx_broker_summary.created_at` against the session each row is dated for,
every session 2026-07-01 .. 2026-07-31 — the last month the feed was alive:

```
broker rows for session D land   D 12:30 UTC   19:30 WIB   <- FIRST write of the job
prices for session D land        D 12:31-12:36 UTC          90-360s LATER
refresh_ihsg writes the calendar D 13:05 UTC   20:05 WIB
watchdog + burn-in gate run      D 13:50 UTC   20:50 WIB
```

**`BROKER_DATA_MAX_LAG_SESSIONS = 0`.** Every consumer runs at least 35 minutes
after the broker write, the watchdog 80. Any lag at all means the pull did not
run. The old justification for 2 — "the feed lags by design, Index Alpha
publishes ~19:00 WIB" — conflated *source* latency with *pipeline* lag: the
source does publish late in the day, and our copy of it still lands before
anything reads it.

A strict 0 cannot false-alarm during the nightly write window, and that is
measured rather than hoped: broker precedes prices, so the freshest-feed
reference cannot reach session D before the broker table has.

The three literals (gate 1, warning 2, scanner 1) are now one constant, asserted
by test.

### 10.2 Severity is a level, and the top two bind

`critical` was replaced by `INFO / ADVISORY / DEGRADED / BLOCKING`, plus an
`affects` list per feed so binding is scoped rather than blunt.

| feed | severity | affects | note |
|---|---|---|---|
| `ingest`, `prices`, `ihsg` | BLOCKING | all / engine+broker | unchanged in effect |
| `broker`, `concentration` | **BLOCKING** | signal-engine | was non-critical — the feed that died |
| `flow_detail` | DEGRADED | signal-engine | **was not monitored at all** |
| `signals` | DEGRADED | paper-trader | scoped: cannot reset the V2 streak |

`DEGRADED` labels output and fails the burn-in; `BLOCKING` also stops output.
Both bind, so nothing touching correctness is warning-only.

`signals` is scoped to paper-trader deliberately. Binding a Python
paper-trading outage to the V2 burn-in would repeat a scope error this codebase
has already made twice (TEST_* accounts in the identity hash; an experimental
account failing official checks).

### 10.3 A second instance of the same defect, in the kill switch

The sweep was scoped to `watchdog.js:433`. `signalState()` had it too, and worse:
checked live on 2026-08-09 with the broker feed **five sessions dead**, the kill
switch returned `enabled: true`. The switch whose stated purpose is "produce no
actionable output on stale inputs" was green through the exact failure it exists
to catch, for the same reason — it disabled only on `critical`, and broker was
not critical. Now `enabled: false`, with `signalDate` and `limitedBy` naming the
feed that limits us.

The lesson is not about this switch. **One boolean was consulted in two places,
and fixing the place we had found would have left the other reading `true`.**

### 10.4 Found while sweeping, not looked for

1. **A live phantom-session writer.** `runDailyCron` has its own price-write loop
   that the 2026-08-05 phantom fix never reached — that fix guarded
   `fetchAndSaveStockPrices` and `/api/stock-prices` and left the third writer
   open. On Saturday 2026-08-08 a PM2 restart re-armed the startup catch-up, the
   loop ran with `date = 2026-08-08`, and Yahoo returned Friday's quotes: 245
   rows byte-identical to 2026-08-07, stamped on a day IDX was shut. Same shape
   as the F9-F13 availability bug — a fix applied at one call site while a
   duplicate site kept the defect. Guarded now.

2. **Every restart was firing the full nightly pipeline.** The startup catch-up
   had no weekday check, and its trigger is `MAX(broker.date) < today` — which,
   with the feed dead, is *permanently true*. Logs show it firing four times for
   2026-08-06 and again on Saturday. **Deploying means restarting, so every
   deploy triggered a pull.** Now gated on a weekday, on the exchange calendar,
   and on a persistent record of whether today's pull already completed
   (`nightly_cron` in `ft_system_health` — that job was the only one in the
   system with no durable trace, which is ironic given the module's thesis).

3. **The watchdog was about to write a NAV for the Saturday.** Its repair targets
   came from `MAX(idx_stock_prices.date)`, which the phantom bar moved, so the
   dry run proposed resolving and marking a session that never happened — the
   watchdog committing the fault it exists to report, in the ledger rather than a
   price table. Targets now walk the exchange calendar backwards, which makes
   phantom dates unreachable by construction rather than by cleanup order.

4. **Mid-series holes in the broker series that nothing had ever looked for.**
   Every broker check reads `MAX(date)` and is blind behind it — the third time
   this blindness has been found here. `idx_broker_summary` and
   `idx_concentration` are missing **2024-05-29, 2026-06-15, 2026-06-22,
   2026-06-29**; `idx_broker_flow_detail` the last three. All four are real
   sessions with prices and an index bar. Three are consecutive Mondays.
   Now detected, split recent (BLOCKING) / historical (ADVISORY) so an
   unrepairable hole cannot fail the burn-in nightly — there is no repair at any
   severity, the source is the banned account. **This is §5.2's failure mode with
   confirmed dates: research windows crossing them must report
   `WINDOW_INCOMPLETE`, not average four observations and call it five.**

### 10.5 Verified live

```
/api/signal-scanner        HTTP 503  sessionsBehind 5     (via the constant, not a literal)
/api/system/signal-state   enabled false  signalDate 2026-07-31  limitedBy broker
watchdog --dry-run         broker/concentration BLOCKING, flow_detail DEGRADED — all FAIL
burn-in 2026-08-07         FAILED: requiredInputsReady, brokerDataCurrent, noPhantomSessions
restart 2026-08-09         "Startup catch-up skipped — not a trading session (WEEKEND)"
```

343 tests across 16 suites, 0 failures. One existing test asserted the opposite —
*"stale broker feed does NOT disable"* — and passed for as long as it was wrong.
Inverted and annotated rather than deleted.

### 10.6 Still open after this

- ~~The 2026-08-08 phantom row is still in the table.~~ **Purged on user
  approval**, 245 rows, backup `/root/backups/phantom-prices-2026-08-09-0056.sql`
  (replayable INSERTs, verified before any DELETE). `verify_strategy_book.js`
  still passes 17/17 — the flagship strategy takes its date axis from
  `idx_ihsg_history`, so phantom price dates were never visited, exactly as the
  2026-08-04 purge established. The watchdog now reports "every date looks like a
  real session", and the burn-in fails on **one** root cause instead of two.
- `signalState` counts `JOB_FAILING:watchdog` as a reason alongside the staleness
  that *caused* the watchdog to fail — one fault, counted twice. `checkJobRegistry`
  already skips its own rows for this reason; `signalState` does not. Harmless
  (both point at a real condition, and it self-clears on one clean run) but it
  overstates the number of independent problems.
- Nothing yet consumes `paper-trader` readiness — the consumer is Python and
  outside this module. Recorded here rather than left implicit, because
  unenforced detection is the defect this whole sweep is about.

---

## 11. Review of the sweep — all three items applied

Verdict was *approve the direction, no new features, fix two small hardenings*.
Both were already on my own open list in §10.6, which is the useful signal: the
review found no defect I had not found, and framed two of them better than I had.

### 11.1 P1 — freshness must be time-aware, not merely session-aware

**The review is right, and it is worth being precise about what was wrong.** This
was NOT producing false 503s. `/api/signal-scanner` takes its session axis from
`idx_ihsg_history`, and `refresh_ihsg` does not write session D until 20:05 WIB —
so at 10:00 WIB the calendar does not yet contain today, `sessionsBehind`
computes to 0, and no morning refusal has ever occurred.

That is the problem. **It was correct by cron timing, not by contract.** Move
refresh_ihsg earlier, or point the axis at any source that knows about today
intraday, and the endpoint starts refusing every morning — a behaviour change
with no code change, which is the shape of bug this codebase has already written
down once, about the resolve/refresh_ihsg ordering: *"an ordering that exists
only in a crontab is one edit away from being wrong, silently."*

Implemented as the review specified:

```
brokerDate === latestRequiredCompletedSession(asOfTime)

  before the cutoff:  previous completed session
  after  the cutoff:  today's completed session
```

`expectedBrokerSession(pool, asOf)`, cutoff 12:30 UTC + 30 min grace = 13:00 UTC.
The grace is derived like the constant it accompanies: the pull completes by
12:36 in every observed session, so 13:00 leaves 24 minutes of slack while still
landing 50 minutes before the watchdog runs — a dead pull is still caught the
same night. The deadline is measured against *the session's own date*, so a
weekend does not reset it: on Sunday, Friday's data is still expected.

The scanner now reports both dates, so the refusal says what it wanted as well as
what it has:
```
latestBrokerDate 2026-07-31   expectedBrokerDate 2026-08-07   sessionsBehind 5
```

### 11.2 P2 — incident cardinality

Adopted exactly as framed. One upstream fault no longer reads as three problems:

```
rootCause  INPUT_DATA_STALE  inputs [broker, concentration]
symptoms   JOB_FAILING:watchdog
           SCANNER_BLOCKED:/api/signal-scanner returns 503
           BURN_IN_BLOCKED:no session can be recorded clean
reasons    STALE_BLOCKING:broker, STALE_BLOCKING:concentration
```

The demotion is **conditional, never blanket**: a watchdog failing with every
input fresh has broken on its own, and stays a first-class reason. Tested both
ways. Dedupe changes counting, never severity — `enabled` is still `false`.

`watchdog.js` already refused to do this to itself (`checkJobRegistry` skips its
own rows as circular). This applies the same rule where it was missing.

### 11.3 P2 — completeness as a reusable primitive

Built as `assertCompleteSessions()` in `modules/system_health.js`, not inside
Pattern Replay — same reasoning as `phantomSessions()` being the one definition
both the detector and the purge script call. If each consumer writes its own,
they will disagree about what a session is, and the one that gets it wrong is the
one nobody reads.

```js
assertCompleteSessions(pool, { table, col, startSession|count, endSession, requiredFields })
→ { complete, expectedSessions, observedSessions, missingSessions, window }
```

**Tested against the real defect rather than a fixture** — `test_completeness.js`,
now in `npm run test:integration`. A 5-session window ending 2026-06-26:

```json
{"complete":false,"expectedSessions":5,"observedSessions":4,
 "missingSessions":["2026-06-22"],"window":{"from":"2026-06-22","to":"2026-06-26"}}
```

and the control that makes it evidence rather than a tautology — **prices over
the same window are complete**, so the primitive discriminates instead of
reporting holes everywhere. A window longer than the calendar returns
`CALENDAR_SHORTER_THAN_WINDOW` rather than silently shortening, which is the §5.2
failure mode at the primitive level.

One scope limit stated in the code rather than discovered later: this answers
"does the dataset have usable rows for every canonical session", **not** per-ticker
completeness — a session where 3 of 245 tickers reported counts as observed.

### 11.4 Also fixed: the test harness could not fail

Adding the first async assertions exposed that `test()` is synchronous — it calls
`fn()`, receives a pending promise, and counts a pass before the assertion runs.
Every async test would have reported ✓ regardless, and a rejection would have
surfaced as an unhandled rejection rather than a failure. Added `atest()`, and
proved it fails on both a false assertion and a throw before trusting it.

Worth recording because it is the same disease as the rest of this brief: a check
that cannot report failure is worse than no check, since it manufactures
confidence instead of evidence.

### 11.5 Accepted without change

- **Burn-in 0/10 is the correct state.** No attempt will be made to make it
  runnable before the feed is replaced. Neutralising a missing broker input, or
  carrying the last known one forward, would return us precisely to the
  pre-audit condition this whole exercise removed.
- **Broker replacement is a P0 project dependency**, and the acceptance
  criterion is per-broker × per-ticker × per-session with the full buy/sell
  value/lot/avg and net columns. A market-wide foreign net-buy figure or a daily
  broker leaderboard does **not** replace the information content — dn0..dn4,
  concentration and top-accumulation cannot be reconstructed from either.

356 tests across 17 suites, 0 failures. Verified live.
