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
