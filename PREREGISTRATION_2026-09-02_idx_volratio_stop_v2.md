# Pre-registration v2 — a volatility-ratio-adjusted stop on IDX

**Supersedes `PREREGISTRATION_2026-09-02_idx_volratio_stop.md` (commit `b5afa35`),
which produced a VOID run (registry entry EXP-050).** Written and committed
BEFORE the v2 run. Nothing here may be edited once the result is known.

---

## Why there is a v2, and exactly what changed

The v1 positive control demanded that the script reproduce EXP-049b's IDX figure
of **−0.1698** for `VOL_RATIO` vs the 20-session forward range. It returned
**+0.0773** and voided the run before Stage 0 was computed.

The data did not disagree with itself. **My control did.** EXP-049b measured that
IC *residualised on the volatility level*; v1's control measured the **raw**
correlation. The acceptance band came from one statistic and the code computed
another.

**Exactly one thing changes in v2: the control now computes the residualised
statistic its band was always written for.** The hypothesis, the segments, the
gate, the floor, the fitted parameter and the secondary axis are all unchanged.

## What was seen before the void, stated so the reader can discount it

**Seen:** raw IC **+0.0773**, residualised IC **−0.1698**.
**Not seen:** Stage 0's stop-hit gap, Stage 1's β, Stage 2's gate — the script
exited before computing any of them. The hypothesis below is untouched by v1.

## The sign flip is a warning, and it downgrades my own prior

Raw `VOL_RATIO` → range is **positive**; residualised on the level it is
**negative**. High recent volatility relative to the longer run mostly just means
high volatility, and high volatility means a bigger forward range. The
mean-reversion term only appears once the level is removed.

**This is the same suppression structure that killed the F3 finding in EXP-049c.**
It does not make the mean-reversion effect wrong — EXP-049b's non-parametric
checks held inside level quintiles — but it means:

1. The effect must never be described as unconditionally true.
2. **v1's claim that the Stage 0 prediction is "near-mechanical" was overstated.**
   Which sign shows up in stop-hit rates depends on how completely the ATR-quintile
   conditioning strips the level, and that is an empirical question, not
   arithmetic. Stage 0 is now genuinely uncertain in direction, and the two-sided
   test was already the right choice.

---

## Where this comes from

EXP-049c overturned the volume story. Adding a **volatility-ratio** control —
`VOL_RATIO = ln(sd20/sd60)`, recent realised volatility against its own
longer-run level — removed **82.2%** of F3's range IC and **80.4%** of the
stop-hit gap. What remained, and what is large in both markets, is volatility
mean-reversion itself: IC **−0.2553** on US and **−0.1698** on IDX against the
20-session forward range.

`computeTradePlan` sizes the risk unit as `ATR(14) × 2.5`. ATR is a **level**. It
carries no information about whether that level is currently above or below the
stock's own recent norm, and therefore no information about which way it is about
to move.

This asks whether that omission is measurable in stop outcomes, and whether one
parameter fixes it.

## Market, and why IDX

- The **US holdout is burned** (EXP-047), so the US chain cannot be completed.
- The **IDX reserve (2024-01-01 … 2026-09-01) is intact** — EXP-048's gate
  refused to spend it.
- EXP-049b confirmed the underlying effect is strong on IDX (−0.1698).
- **IDX is the market this project actually trades**, and `computeTradePlan`'s
  POSITION profile there is deployed behaviour, not a parallel layer.

| segment | dates | ~anchors | status |
|---|---|---|---|
| **FIT** | 2016-08-01 … 2020-12-31 | ~51 | opened |
| **CHECK** | 2021-01-01 … 2023-12-31 | ~36 | opened |
| **RESERVED** | 2024-01-01 … 2026-09-01 | ~32 | **SEALED — the script cannot read it** |
| forward reserve | 2026-09-02 onward | — | **permanently reserved** |

## Hypothesis

**H1.** Holding the stop distance in ATR units fixed, the probability of the stop
being hit within 20 sessions depends on `VOL_RATIO`.

**H0.** It does not.

**Two-sided.** The direction above is a strong prior, not a certainty — how fast
volatility reverts relative to a 20-session horizon is an empirical quantity, and
`ATR(14)` is not `sd20`. Fixing the direction would buy significance with an
assumption.

## The statistic — zero fitted parameters in Stage 0

Per anchor date: split into **5 ATR quintiles** so stop width in ATR units is
constant by construction; within each, split into **5 VOL_RATIO quintiles**;

```
gap = hitRate(VOL_RATIO bottom quintile) − hitRate(VOL_RATIO top quintile)
```

averaged across the ATR quintiles. Two-sided one-sample t across non-overlapping
anchors (every 20th session).

Entry-agnostic: every eligible ticker-date opens a hypothetical long at the next
open. **Not a P&L test.** No target, so no intrabar ordering is needed.

## Positive controls — registered this time, and they VOID the run

EXP-048 omitted a positive control and had to supply it post-hoc. Two are fixed
here, and a failure of either means nothing else in the run is read:

1. **`VOL_RATIO` vs 20-session forward range, RESIDUALISED ON THE VOLATILITY
   LEVEL, must reproduce EXP-049b**: IC in **[−0.22, −0.12]** with p < 0.01. The
   word *residualised* is the whole correction in v2 — v1 computed this raw,
   which is a different quantity with the opposite sign. The **raw** IC is also
   printed, labelled, and is **not** a pass/fail criterion.
2. **Residual ATR inside an ATR quintile must still move the hit rate**
   (EXP-048b measured −1.58pp, t −2.22). If the stop machinery cannot see that,
   it cannot see anything.

## Stage 0 — replicate, or stop

**|gap| ≥ 2pp and p < 0.05 on FIT**, else the experiment ends. Nothing is fitted,
nothing is sealed, the reserve stays shut.

## Stage 1 — fit β on FIT only

```
riskUnit = ATR(14) × 2.5 × (1 + β · z(VOL_RATIO))     floored at 0.2
```

β chosen on a grid to minimise **|gap|** — the statistic that carries signal, not
the max-minus-min spread that failed in EXP-046.

## Stage 2 — THE GATE, on CHECK, with β frozen

Both must hold:

- |gap| reduced by **≥ 40%** versus the incumbent, and
- the paired per-anchor improvement is positive at **p < 0.05**.

**If the gate fails the reserve is NOT opened**, and the result is recorded as a
failure. That is what EXP-047 lacked and EXP-048 proved is worth having.

## The lesson from today, applied — a second control axis

EXP-045 failed because four kill attempts all conditioned on the same variable.
So a **registered secondary** asks what else `VOL_RATIO` could be:

**The gap measured inside ATR × recent-return buckets.** A stock with a high
volatility ratio is often one that recently moved a lot, so the effect could be
reversal or momentum wearing volatility's clothes. If the gap collapses under
return-conditioning the way F3's collapsed under vol-ratio-conditioning, that is
reported as the finding.

Descriptive, cannot pass or fail the gate — but it is reported **before** the
verdict, not after.

## Eligibility

As EXP-048: ≥ 60 prior sessions, volume > 0 on ≥ 48 of the last 60, ATR(14) > 0,
complete 20-session forward path, ≥ 100 eligible names per date.

## Power

FIT ≈ 51 anchors, CHECK ≈ 36. If the gap is of the size the −0.1698 range IC
suggests, it should be large and easy to see; **a small gap would be the
surprising outcome** and would itself be informative about how ATR(14) relates to
20-session realised volatility.

## Known weaknesses

1. **Near-mechanical prior**, as stated above. Stage 0 is not the interesting part.
2. **Whole-rupiah ticks** — eligible median price is Rp 368, so one tick is
   ~0.27% and stop crossings are coarse for cheap names. Both arms share it.
3. **Survivorship** — blow-ups absent, and blowing up is the archetypal
   stop-hitting event. Hit rates understated.
4. **Gap risk ignored** — stops fill at the stop price.
5. **`ATR(14)` and `sd20` are not the same estimator**, so part of any gap could
   be the mismatch between the two windows rather than mean-reversion. The
   secondary conditioning does not separate that; it is a known limit.
6. **Not a P&L test.** A better-calibrated stop is not automatically a more
   profitable one.

## What a pass would license

Writing a candidate seal with a config hash and a script hash, and opening the
IDX reserve **once**. Not a production edit. `trade_policy` is untouched by this
experiment under every outcome.

## What a failure would license

Recording it. A Stage 0 failure would be genuinely surprising and would say
`ATR(14)` already absorbs the mean-reversion; a Stage 2 failure would say the
effect is real and one parameter does not fix it — the distinction EXP-047 could
not make.

---

Script: `scraper/research/exp051_idx_volratio_stop_v2.js`, committed with this
document and unchanged when run. It has no flag to open the reserve.
