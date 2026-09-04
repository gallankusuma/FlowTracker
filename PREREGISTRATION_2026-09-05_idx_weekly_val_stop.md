# Pre-registration — the WEEKLY value-area low as a stop, on IDX

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Why this exists: EXP-052 tested the wrong object

EXP-052 compared a Value-Area-Low stop against the ATR stop and found it **9
percentage points worse**, replicated. But its VAL came from the deployed
`zones()`, which profiles **500 sessions — about two years.** The source
prescribes a **weekly** volume profile.

The tell was in the numbers: the median VAL distance came out at **18.11%**. A
weekly value-area low sits a few percent from price, not eighteen. So EXP-052's
second arm measured our two-year value area, which happens to share a name with
the thing under discussion, and its −9pp result says nothing about a weekly
profile.

This tests the weekly one.

## And a correction to my own decision code

EXP-052's gate printed **"GATE PASSED"** on a result that rejected the
hypothesis. It checked sign *consistency* across segments plus significance and
the floor, and never checked the sign **against the hypothesis**. A two-sided
test's "consistent and significant" rendered as a win when the direction was a
rejection.

**In this experiment the direction check is explicit and is the first condition**,
stated below and asserted in code. That was the fifth specification error of this
arc and all five are the same family: careful hypothesis, careless success
criterion.

## The honest limitation, before anything else

A true weekly Market Profile is built from **intraday** data — 30-minute TPO or
tick volume across five sessions. This project has **daily bars only**. A weekly
profile from five daily bars is a coarse proxy: at most five overlapping ranges
spread across the bucket grid, so its "value area" is close to *the middle of
last week's range*.

That is a legitimate, simple definition and it is arguably what a weekly VAL
means in practice. **It is not the same object he uses**, and a null here would
be weak evidence against his rule rather than strong. Fetching intraday history
for 580 tickers across ten years is not feasible against Yahoo, so this is the
best available and it is stated rather than glossed.

## Hypothesis

**H1.** At the same median risk budget, a stop placed just below the **weekly**
value-area low is hit **less often** within 20 sessions than a stop at a
volatility multiple.

**H0.** It is not.

**Two-sided**, and the direction required for a pass is stated separately in the
decision rule so the two cannot be confused again.

## The arms

| arm | stop |
|---|---|
| **WEEKLY VAL** | `zones(last 5 sessions).valueArea.lo` minus a 0.2 × ATR buffer |
| **ATR** | `entry − k × ATR(14)`, with **k fitted on FIT only** so the two arms' **median** distances match |

`k` is fitted to equalise **distance** and never to improve **hit rate**, and it
is frozen before CHECK. Median rather than mean, because structural distances are
right-skewed.

Placement and distance are the same quantity for one stop below an entry — match
the distance and the price is identical — so the rescale is what makes this a
test of *where*, not of *how wide*. That reasoning is carried over from EXP-052
unchanged.

## VOID condition — the guard against repeating EXP-052

**If the median WEEKLY VAL distance on FIT exceeds 12%, the run is VOID.**

At that distance the object is not a weekly value area regardless of what the
code is called, and reading the result as one would repeat the exact error this
experiment exists to correct. 12% is set now, from the observation that EXP-052's
two-year VAL sat at 18.11% and a weekly level should sit far closer.

## Positive controls — registered with their expected values

1. **Monotonicity.** ATR hit rate must **fall** as k rises across {1.5, 2.5, 3.5}.
   Mechanical; a failure means the simulation is wrong. (EXP-052 measured
   53.1% / 30.2% / 16.3%, so this also checks the two runs agree.)
2. **Distance match.** After fitting k, the arms' median distances must agree
   within **5% relative** on FIT.

Either failure voids the run.

## Statistic

Entry-agnostic: every eligible ticker-date opens a hypothetical long at the next
session's open, both arms on identical entries. **Not a P&L test.** No target, so
"did any of the next 20 lows reach the stop" needs no intrabar ordering.

Per anchor date: `gap = hitRate(ATR) − hitRate(WEEKLY VAL)`. **Positive means the
weekly VAL is hit less, which is the direction H1 requires.** Two-sided
one-sample t across **non-overlapping anchors** (every 20th session).

## Segments — the reserve stays shut

| segment | dates | ~anchors | status |
|---|---|---|---|
| **FIT** | 2016-08-01 … 2020-12-31 | ~51 | opened |
| **CHECK** | 2021-01-01 … 2023-12-31 | ~36 | opened |
| **RESERVED** | 2024-01-01 … 2026-09-01 | ~32 | **SEALED — no flag can open it** |
| forward reserve | 2026-09-02 onward | — | **permanently reserved** |

A 5-session profile needs almost no warmup, so the FIT segment recovers the ~51
anchors EXP-052 lost to its 500-bar window (it ran on 28, below the 30 bar).

## Decision rule — direction first

**WEEKLY VAL BETTER** requires, in order:

1. **Direction**: `gap > 0` on FIT. If the gap is negative the hypothesis is
   **rejected** and no later condition can rescue it, whatever its significance.
2. FIT: `|gap| ≥ 2pp` and `p < 0.05`.
3. CHECK: **same sign, still positive**, `|gap| ≥ 2pp`, `p < 0.05`.

**WEEKLY VAL WORSE** if the gap is significantly negative — reported as a
rejection in plain words, not as a "pass".

**NOT DETECTABLE** otherwise.

Only a pass licenses a candidate seal and one read of the reserve. **This script
has no flag to open it.**

## Sensitivity, descriptive only

The same comparison at profile windows of **10 and 20 sessions**, printed
alongside 5 and next to EXP-052's 500-session figure (−9.26pp), so the reader
sees how the result moves with window length. **Only the 5-session arm decides
anything**; the others exist because "the window was wrong" is this experiment's
own premise and it should be visible rather than asserted.

## The second control axis

Carried from EXP-052 and kept: the gap measured inside **recent-return** buckets
and **volatility** buckets, printed **before** the verdict. A weekly VAL sits
close after a quiet week and far after a volatile one, so it is entangled with
both.

## Eligibility

≥ 60 prior sessions, volume > 0 on ≥ 48 of the last 60, ATR(14) > 0, complete
20-session forward path, ≥ 100 eligible names per date. The weekly VAL must exist
and sit **below** the entry; rows where it does not are dropped and **counted**.

**This fraction is expected to be large.** A five-session profile sits close to
price, so on any day price is near its weekly low the VAL will be above the entry
and the rule is silent. A rule with no answer on a large share of days is a
weaker rule, and the share is part of the result rather than a footnote.

## Power

FIT ≈ 51 anchors, CHECK ≈ 36. EXP-046 detected 2.98pp at t 4.05 on 150 anchors;
a similar effect here would show at t ≈ 2.4. **This finds a large difference and
not a small one**, and a null is "not detectable at this size".

## Known weaknesses

1. **Daily bars, not intraday** — the central one, stated above.
2. **Whole-rupiah ticks**; eligible median price around Rp 368, so stop crossings
   are coarse for cheap names. Shared by both arms.
3. **Survivorship** — blow-ups absent, and blowing up is the archetypal
   stop-hitting event. Hit rates understated in both arms.
4. **Gap risk ignored** — stops fill at the stop price.
5. **Matched on median, not per trade.**
6. **Still only the location half.** The order-flow execution layer is absent, and
   the entry half already failed on IDX (EXP-037: −1.6% versus holding).

## What a pass would license

A candidate seal with a config hash and a script hash, and one read of the IDX
reserve. Not a production edit; `computeTradePlan` and `trade_policy` are
untouched under every outcome.

## What a rejection would license

Recording it, and closing the location question for IDX across both window
lengths. Together with EXP-037 and EXP-052 that would say the volume-profile
framework's *measurable* half does not hold here — leaving only the order-flow
layer, for which no data exists.

---

Script: `scraper/research/exp053_idx_weekly_val_stop.js`, committed with this
document and unchanged when run.
