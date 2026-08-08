# Review Brief — 2026-08-08

**For the review team. This is not a response to a review; it reports a new problem found while doing the Pattern Replay precondition.**

Short version: the IDX signal engine was blind for 8 days, serving stale numbers dated as today, and its own health gate reported "passed" the whole time. Partly fixed. The root cause is not, and cannot be fixed with code.

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

`server.js:6158`. The endpoint now returns **503** instead of passing stale scores off as today.

Verified live:
```
HTTP 503
{"source":"stale-broker-feed","stale":true,"sessionsBehind":5,
 "latestBrokerDate":"2026-07-31","latestSessionDate":"2026-08-07"}
```

**Design decision that most needs review:** the scanner's clock was deliberately **not** moved to the price tables. `idx_stock_prices` is current through 08-07, so moving it would make the endpoint "alive" again — but f1 concentration and the entire broker factor family read from the same dead broker tables. The result would not be fresher signals; it would be confident ones built on inputs that do not exist. Refusing is more honest than inventing. **If the team disagrees, this is the point most worth arguing.**

Zero lines of scoring math changed, so `strategy_hash` does not move.

### 2.4 `brokerDataCurrent` check in the burn-in gate — DEPLOYED

`watchdog.js:521`. Verified live:
```
session_date 2026-08-07 · passed 0 · brokerDataCurrent false
priceDataCurrent true · failures_json ["brokerDataCurrent"]
```

---

## 3. The main finding, and the part that most needs criticism

**The broker feed died on 2026-07-31. All three tables at once:**

| table | newest |
|---|---|
| `idx_broker_summary` | 2026-07-31 |
| `idx_concentration` | 2026-07-31 |
| `idx_broker_flow_detail` | 2026-07-31 |
| `idx_stock_prices` | 2026-08-07 |
| `idx_ihsg_history` | 2026-08-07 |

`/api/signal-scanner` takes its notion of "today" from `idx_broker_summary`, not from prices (`server.js:6152`). So for 8 days the endpoint served 31 July scores, **dated 31 July**, with no staleness indication anywhere in the UI. The snapshot write at the end of the handler rewrote 31 July with identical values, so even the row count never moved — there was no signal at all that anything was wrong.

### 3.1 The burn-in gate was blind in exactly the place it failed

15 checks, all passing, every night:
```json
"priceDataCurrent": true,   ← honestly true, prices were current
"calendarCurrent":  true,   ← honestly true, the calendar was fine
...
```
**Not one check asked whether the broker data was still alive.**

### 3.2 The part that bothers me most: the information already existed, but bound nothing

The watchdog **had** been detecting this, and for a while:

> `broker is stale (idx_broker_summary): 5 trading days behind (tolerance 2). Not auto-repaired: this feed is owned by another job…`

But it was written as a **WARNING**. A warning binds nothing, so the same night the burn-in gate still wrote `passed: 1`. The system knew, said so, and passed itself anyway.

**This is the question for the team, and I think it matters more than the bug:** how many other warnings in this system are in the same position — correct, detected, printed, and binding nothing?

---

## 4. Impact on the burn-in

The Virtual Broker V2 burn-in started **2026-08-05**. The broker feed died **2026-07-31**.

**All three recorded burn-in sessions ran entirely on stale broker data.** Not some — not one session ever saw a live broker feed.

No rows were deleted. The burn-in resets itself correctly: the streak requires consecutive sessions, 08-07 now fails, so the count returns to zero. The three old green sessions remain on record as evidence that the system once misjudged itself. I think that should stay readable rather than be cleaned up.

Additional note: `identity_hash` shifted three times on 05 August alone. The identity running now has only one session. The 10-session count has effectively never really started. **I have not investigated why the identity moves that often — strong candidate for review.**

---

## 5. Still open

1. **The broker feed is still dead.** Its source is the permanently banned flowtracker.id account. Both fixes above make the system **honest about its blindness, not cured of it**. Until a replacement exists, the scanner will refuse every day and the burn-in will never reach a single clean session. That is correct behaviour, not a new bug.
2. **Six real exchange sessions have no snapshots at all:** `2026-06-15, 06-22, 06-29, 07-13, 07-15, 07-16` — their price bars are complete. Plus five August sessions lost to the dead feed. Any H-5…H-1 window crossing these silently becomes a 4-day window while still being labelled 5-day. **Pattern Replay must REFUSE an incomplete window — not shift it, not zero-fill it.**
3. **Snapshots are written as a side effect of an HTTP request**, not a scheduled job. Nothing calls `/api/signal-scanner` from cron. History only grows when a human opens the page. A cron was deliberately **not** installed: installing one on top of a dead clock would only make the system look healthy.
4. **An inconsistency I introduced:** the new check tolerates 1 session, the existing warning tolerates 2. At exactly 2 sessions behind, the gate fails while the warning stays silent. Not dangerous, but two numbers for the same question will confuse someone later. Worth aligning to 2.
5. **The `live` period is only ~22 days.** The winners-vs-controls research (review items 8–10) must be restricted to it. This sample is small — stated now, before any result starts looking convincing.

---

## 6. Corrections to my own statements

Recorded because this team's value comes from catching what slips:

- I said the burn-in started "around 22 July". **Wrong.** 22 July is when signal snapshots became continuous; the burn-in started 5 August. Two different things I conflated.
- I said history was missing **because** the page wasn't being opened. **Incomplete.** That explains the June–July gaps but is not at all why it stopped on 31 July.
- I suspected calling the endpoint **overwrote** the 07-31 snapshot with today's factors. **Wrong.** Diffed against the backup: zero rows changed. No data was corrupted.
- I proposed a source-priority rule for the 27 dates. **Not needed** — zero duplicates.

---

## 7. Deploy status

| | |
|---|---|
| `flowtracker-scraper` | restart 44 → 45, `server.js` + `watchdog.js` deployed, verified live |
| `flowtracker` (frontend) | untouched |
| `strategy_hash` | unmoved (zero scoring-math changes) |
| Backup | `/root/backups/idx_signal_history-before-cleanup-2026-08-08.sql` |
| Commit | `302597a` |

---

## 8. What I am asking you to review

1. **Refusing vs. moving the clock to the price tables** (§2.3) — the most arguable decision here.
2. **Warnings that bind nothing** (§3.2) — a sweep, not just this instance.
3. **`identity_hash` shifting 3× in one day** (§4) — uninvestigated.
4. **The refuse-on-incomplete contract for Pattern Replay** (§5.2), before P1 is built.
5. **Replacement options for the broker feed** — this is what now blocks everything else.
