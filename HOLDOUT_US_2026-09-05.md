# US reserved periods, v2 — defined 2026-09-05

The project's only US holdout was spent by EXP-047. This document defines what
replaces it, **before any of the replacement data has been fetched**, so that the
boundary cannot be chosen to suit a result.

Authoritative for S3 on US hypotheses. Subordinate to `PROMOTION_CONTRACT.md`,
which this does not amend.

---

## 1. What is already spent

| segment | period | spent by |
|---|---|---|
| DISCOVERY | 2007-02-28 … 2018-12-31 | EXP-043, EXP-044, EXP-046 |
| VALIDATION | 2019-01-01 … 2023-12-29 | EXP-044, EXP-046 |
| **S3 HOLDOUT** | **2024-01-01 … 2026-09-01** | **EXP-047 — BURNED** |

There is no clean sub-period inside `us_stock_prices` as it stood on 2026-09-04.
Every session from 2007-02-28 to 2026-09-01 has been read. A holdout carved out
of that range would be a holdout in name only.

Two directions remain: **earlier than we ever fetched**, and **later than now**.

---

## 2. RESERVE-US-B — backward, 2001-04-09 … 2006-09-04

- **Bounds are absolute dates.** Fetch with `period1`/`period2`, never with a
  relative `range=` token — `25y` slides one session per day and would make the
  reserve's own boundary a function of when it is opened.
- Measured on a 42-ticker spread of the universe: **1,255 sessions** available
  from 2001-09-05, ≈ 62 non-overlapping anchors at H=20. The full window from
  2001-04-09 should reach ~1,360 sessions / ~68 anchors; the backfill reports the
  true count.
- 38 of 42 probed tickers carry the window; 3 IPO'd later (KHC, SYF, ZTS), 1
  errored (JNPR). Expect ~90% universe coverage, thinning toward the start.

### Why 2001-04-09 and not earlier

**Decimalization.** Nasdaq completed the move to decimal quoting on 2001-04-09
(NYSE 2001-01-29). Before that US equities quoted in sixteenths, so the tick grid
— and therefore bar range, gap geometry and stop-hit mechanics — is a different
instrument. EXP-028 already established on IDX that *30% of bars have geometry the
tick grid dominates*. Extending below this date would knowingly repeat an error
this project has already paid for.

The floor is **not negotiable for any range, stop, volatility or candle
hypothesis.** A hypothesis provably independent of bar geometry may petition to
extend it, in its own pre-registration, before opening.

### Where this reserve is weaker than a forward one — read before trusting it

1. **It runs backward.** A rule fitted on 2007–2023 and tested on 2001–2006
   answers *"does this generalize to another regime"*, not *"will this hold going
   forward"*. Those are different questions and only the second is what live
   capital asks. For a **mechanism** claim the first is a fair test; for a
   **timing or strategy** claim it is not.
2. **Survivorship is worse here than anywhere else in the dataset.** The universe
   is today's S&P 500 projected back. Applied to 2001 that selects companies that
   survived the dot-com bust *and* were later admitted to the index — a far more
   extreme filter than the same projection applied to 2020. Every figure from this
   reserve is biased upward by more than the 2007+ figures are.
3. **My priors about 2001–2006 are not blank.** I know from general knowledge that
   2001–2002 was a bear market and 2003–2006 a low-volatility bull. That is not the
   same as having read our data, but it is not zero: a hypothesis can be chosen to
   suit a regime one already knows. A forward reserve has no such leak. This is
   stated because it cannot be eliminated.

Because of (1), this reserve is admissible for **mechanism** hypotheses and is
**not** sufficient on its own to promote a timing or entry rule to S4.

---

## 3. RESERVE-US-F — forward, from 2026-09-05

Everything from 2026-09-05 onward. Strictly clean: it did not exist when any
prior US experiment ran, and no prior belongs to it.

**Opens** when it holds ≥ 30 non-overlapping anchors at the horizon under test,
and not before:

| horizon | sessions needed | earliest open |
|---|---|---|
| H=5 | 150 | ≈ 2027-04 |
| H=10 | 300 | ≈ 2027-11 |
| H=20 (primary) | 600 | ≈ 2029-01 |

That wait is the honest price of having spent the first one. It is not a reason
to lower the bar.

---

## 4. The gate between them

**A candidate may not consume RESERVE-US-F until it has passed RESERVE-US-B.**

This is the EXP-048 structure, which is the only reason the IDX reserve still
exists: a pre-registered gate refused to open it for a candidate that had not
earned the read. EXP-047 spent the US reserve on a remedy nobody had first
checked on validation, and bought an 8.8% effect with no significance test. The
gate exists so that cannot recur.

---

## 5. Hard rules

1. **Boundaries are fixed dates in this file.** Changing either boundary voids
   the reserve; it does not move it.
2. **Single use.** Opened exactly once, per `PROMOTION_CONTRACT.md` S3. The result
   is recorded whatever it says.
3. **No labelled data until open.** `us_signal_history` is **not** extended below
   2007-02-28. Prices may be backfilled — a price table is not a labelled dataset
   — but forward returns for the reserve window are computed at open time, inside
   the sealed script. Until then the answers do not exist in queryable form.
4. **The backfill must print no statistic about the window.** Row counts, session
   counts, coverage and date bounds are permitted. Any return, factor, IC or
   distribution figure printed over the reserve range **burns it on the spot**.
5. **Scripts refuse it by default**, mirroring `research/candlestick/exp028_oos.js`:
   no reserve data without an explicit `--open-holdout`, and the script's SHA-256
   recorded in the registry before the flag is used.
6. **Universe is frozen** at `modules/us_tickers.js` sha256 `bbf75253052844b3`,
   418 listed / 407 fetchable. If that file changes, the reserve's cross-section
   changes and this definition must be re-issued with a new date.

---

## 6. What this does not fix

Survivorship, in either reserve. Yahoo does not serve delisted symbols, so no
amount of history repairs it. Both reserves inherit the banner that every US
result in `BACKTEST_EXPERIMENTS.md` already carries.

And neither reserve makes a US signal exist. EXP-043 (composite anti-ranks after
2019) and EXP-044 (all nine factors null at the traded horizon) are unaffected by
anything here. A reserve is somewhere to test a candidate; it is not a candidate.
