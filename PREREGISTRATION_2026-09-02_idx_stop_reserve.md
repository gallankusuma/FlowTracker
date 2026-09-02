# Pre-registration — the stop miscalibration on IDX, with a reserved period that stays shut until it is earned

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Why this exists, and what went wrong last time

EXP-046 found the deployed `2.5 × ATR` stop is hit more often for low-volume
names at the same ATR-relative distance. EXP-047 opened the project's only
reserved period against a fix and got a technically-passing, substantively
marginal result — **0.67pp of a 7.61pp gap, 8.8%** — where the post-hoc refit had
promised 42%.

Two of my design errors caused that, and both are corrected here:

1. **The sealed rule had no magnitude bar.** It asked only whether the gap got
   *smaller*. Fixed below with a **≥ 40% reduction** requirement — the same figure
   the refit claimed, chosen now so it cannot be moved later.
2. **No paired significance test of the improvement was sealed**, so 0.67pp could
   not be distinguished from zero. Fixed below: the paired difference
   `(incumbent gap − candidate gap)` must clear p < 0.05.

And the sequencing error that mattered most: **β was fitted with an objective
that had already failed, and the holdout was spent before anything checked that
the fit worked.** This design puts a **gate** between the fit and the seal. The
reserved period is not opened unless the gate is passed.

## The new data, and exactly how fresh it is

**IDX.** `idx_stock_prices`: 1,152,350 rows, 651 tickers, **2,433 sessions
(2016-08-01 … 2026-09-01)**, 495 tickers with ≥ 1,000 sessions.

This is a **genuinely independent market** — different exchange, different
microstructure, different investor base — and it is the market this project
actually trades. `computeTradePlan` with the POSITION profile is the IDX
production path, so a finding here is directly about deployed behaviour rather
than about a parallel layer.

**What prior contact this data has had, stated rather than glossed:** EXP-036 /
EXP-037 / EXP-038 used `idx_stock_prices` for volume-zone questions on 100
tickers, and EXP-042 used `idx_signal_history` (145 sessions, 2026 only) for
factor weighting. **No experiment has ever examined stop-hit rates conditional on
volume on IDX.** The hypothesis is new to this data even though the data is not
untouched. That is weaker than virgin data and stronger than re-reading a burned
period, and it is what is actually available.

## Segments, frozen now

| segment | dates | ~sessions | 20d anchors | status |
|---|---|---|---|---|
| **FIT** | 2016-08-01 … 2020-12-31 | ~1,080 | ~54 | opened |
| **CHECK** | 2021-01-01 … 2023-12-31 | ~730 | ~36 | opened |
| **RESERVED** | 2024-01-01 … 2026-09-01 | ~650 | ~32 | **SEALED — opened only if the gate passes** |

All three clear the 30-anchor bar. The split is chronological and never shuffled.

**Plus a standing forward reserve.** Everything from **2026-09-02 onward** is
reserved permanently and may not be read by this experiment or any successor
without its own seal. This project has been consuming its own history without
ever setting aside forward data; that stops here.

## The stages, and the gate between them

**STAGE 0 — does the miscalibration replicate on IDX at all?** *(on FIT)*

Same statistic as EXP-046: per anchor date, split into 5 ATR quintiles; within
each, split into 5 F3 quintiles; `gap = hitRate(F3 bottom) − hitRate(F3 top)`,
averaged across ATR quintiles. Two-sided one-sample t across anchors.

If |gap| < 2pp or p ≥ 0.05, **the whole thing stops here**. Nothing is fitted,
nothing is sealed, the reserved period stays shut, and the report says the US
finding did not travel.

**STAGE 1 — fit β.** *(on FIT only)*

`riskUnit = ATR(14) × 2.5 × (1 + β·z(F3))`, floored at 0.2, z within date.
β is chosen on a grid to minimise **|gap|** — the statistic that carries the
signal — explicitly **not** the max-minus-min spread that failed in EXP-046.

**STAGE 2 — the gate.** *(on CHECK, with β frozen)*

Both must hold:

- the candidate reduces |gap| by **≥ 40%** versus the incumbent, and
- the paired per-anchor difference `(incumbent gap − candidate gap)` is positive
  at **p < 0.05** two-sided.

**If the gate fails, the reserved period is NOT opened.** The result is recorded
as a failure and the line of work ends without spending anything. That sentence
is the entire reason this document exists.

**STAGE 3 — the reserved period.** Only after the gate passes, and only after the
β, the eligibility rules and the decision rule are frozen in a candidate seal
with a config hash and a script hash, exactly as `CANDIDATE_SEAL_2026-09-02_stop_f3adj.md`
did. **This pre-registration does not open it and the script refuses to.**

## Eligibility, fixed now

A ticker is eligible on date *t* if:

- it has ≥ 60 prior sessions in `idx_stock_prices`,
- **volume > 0 on at least 48 of the last 60 sessions** — IDX carries genuinely
  illiquid names whose zero-volume days would make a volume z-score meaningless,
- ATR(14) > 0 at *t*, and
- a complete 20-session forward path exists.

A date is used only if **≥ 100 eligible names** clear those tests, so the 5×5
grid has at least ~4 names per cell.

F3 is the production `f3_volumeZ(volumes.slice(-60), priceDirection)` — the same
function and the same 60-bar window the deployed scorer uses — not a
re-derivation.

## Entry-agnostic, again, and for the same reason

Every eligible ticker-date opens a hypothetical long at the next session's open.
EXP-044 showed the composite has no directional edge, so an entry rule would
import a known-null edge and bury the comparison. **This is not a P&L test**, and
Stage 3 — not this run — is where the full `computeTradePlan` with targets and
costs gets applied.

No target here means the intrabar-ordering problem does not arise: "did any of
the next 20 lows reach the stop" is answerable from daily bars.

## Power

FIT n ≈ 54 anchors, CHECK n ≈ 36. EXP-046 measured this gap at t 4.05 (n = 150)
and t 4.44 (n = 62) on US. If IDX carries an effect of similar size, CHECK at
n = 36 gives an expected t ≈ 3.4 for Stage 0's statistic — adequate. The gate's
paired test is a difference of differences and will be noisier; its CI is
reported rather than a bare verdict.

**A Stage 0 null is a real possibility** and would be the cleanest outcome
available: it would say the US result does not generalise to IDX, which is worth
knowing before any IDX production change is ever contemplated.

## Known weaknesses

1. **IDX prices are whole rupiah.** Low-priced names have coarse ticks, so a stop
   level can be crossed by a single tick increment. This biases hit rates upward
   for cheap stocks and is not corrected; the median price of the eligible
   universe is reported so the reader can judge.
2. **Survivorship**, same as everywhere: `backfill_price_history.js` only fetched
   tickers present in `idx_broker_summary`, and twelve delisted names were
   removed in July 2026. Blow-ups are the archetypal stop-hitting event, so hit
   rates are understated.
3. **Gap risk ignored** — stops fill at the stop price. Shared by both arms.
4. **The data is not virgin**, as disclosed above.
5. **One fitted parameter.** β is estimated on FIT and frozen; with ~54 anchors a
   one-parameter fit is modest but not free, and the gate on CHECK exists
   precisely because a fit is not evidence.

## What a pass would license

Writing a candidate seal and opening the IDX reserved period **once**. Not a
production edit. `trade_policy` is not touched by this experiment under any
outcome.

## What a failure would license

Recording it, and leaving `computeTradePlan` alone. A Stage 0 failure closes the
question on IDX; a Stage 2 failure says the effect is real there but this
one-parameter remedy does not fix it, and the reserved period survives for a
better candidate.

---

Script: `scraper/research/exp048_idx_stop_reserve.js`, committed with this
document and unchanged when run. It has no `--open-holdout` flag and cannot read
the reserved period.
