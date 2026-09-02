# Pre-registration — is the deployed ATR stop miscalibrated, and can F3 fix it?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## What EXP-045 licensed, and this is it

EXP-045 found F3 (volume z-score) predicts the 20-session **range** after
volatility is removed: discovery IC −0.0417, validation −0.0402, 4/4 stability
blocks, and four post-hoc attempts to break it failed. Its pre-registration
licensed exactly one follow-up — *"whether the improved range forecast actually
improves stop placement in `computeTradePlan`, measured on data this run has not
touched."*

This is a different kind of question from the four before it. Those measured rank
IC. **This measures whether a decision changes.** An IC of 0.04 on a continuous
target can easily produce no measurable difference in a binary threshold event,
and that is a real and likely outcome here.

## The incumbent, exactly as deployed

`computeTradePlan` with the POSITION profile:

```
riskUnit = ATR(14) × 2.5
stopLoss = entry − riskUnit          (long)
```

**The support/resistance snap is disabled in this test.** It is a downstream
modification, but its qualifying band is 0.5×–3× the risk unit, so changing the
risk unit does change which levels qualify. Disabling it isolates the mechanism a
candidate would actually change, and the cost is stated: **this measures the
risk-unit rule, not the full deployed function**, and a follow-up would have to
re-check with the snap on.

## Entry-agnostic, and this is the central design decision

EXP-044 established there is no directional signal in this factor set. Any entry
rule chosen here would import a known-null edge and swamp the stop comparison
with noise from the entry.

So **every (ticker, anchor date) opens a hypothetical long at the next session's
open.** The entry carries no information by construction. That is not a
simplification — it is what makes the stop the only thing being measured.

The consequence, stated plainly: **this is not a P&L test.** A better-calibrated
stop is not automatically a more profitable one, and nothing here may be
described as profitable.

## Why daily bars are sufficient here

EXP-037's pre-registration refused to simulate a stop because a daily bar does
not record whether the low came before or after the high, and modelling both a
stop and a target requires that ordering.

This test has **no target**. The only question is whether the low of any of the
next 20 sessions reached the stop, which a daily bar answers unambiguously. The
intrabar problem is avoided structurally rather than assumed away.

## The hypothesis

**H1.** Holding the stop distance in ATR units fixed, the probability of the stop
being hit within 20 sessions depends on F3.

**H0.** It does not.

**Two-sided.** EXP-045 found high F3 precedes a smaller range, which implies low
F3 stocks should hit stops more often — but that was a different outcome
variable, continuous and two-sided, where this one is binary, one-sided in price
and thresholded. A direction established on the first does not transfer strongly
enough to the second to justify buying a factor of two in significance.

## The primary statistic — zero free parameters

Per anchor date:

1. Take every ticker with a complete 20-session forward path.
2. Split into **5 ATR quintiles**, so stop distance in ATR units is constant
   within a bucket by construction.
3. Within each ATR quintile, split into **5 F3 quintiles** (≈ 16 names per cell
   at a 400-name cross-section).
4. `diff = hitRate(F3 bottom quintile) − hitRate(F3 top quintile)`, averaged
   across the 5 ATR quintiles.

One number per date; a two-sided one-sample t across **non-overlapping anchors**
(every 20th session). No coefficient is fitted anywhere in the primary.

## The economic floor, fixed now

**≥ 2 percentage points.**

At 2.5×ATR over 20 sessions the base hit rate will be somewhere around a third to
a half, and a differential below 2pp changes the outcome of fewer than one
position in fifty. That is below what is worth editing production for.

This is a judgment call, not a derivation, and it is written down before the
result so it cannot be moved afterwards. Statistical significance below the floor
is reported as **"real but not worth acting on"**.

## Secondary — can it be fixed? (one fitted parameter, discovery only)

```
riskUnit = ATR(14) × 2.5 × (1 + β · z(F3))
```

`z(F3)` is the within-date standardised F3. **β is estimated on DISCOVERY only**,
chosen to minimise the spread of hit rates across F3 quintiles, then **frozen**
and applied unchanged to validation. The fitted β is reported.

This arm is secondary and cannot produce a pass on its own. Its only job is to
show whether a miscalibration found by the primary is *fixable*, or merely real.

## Segments

| segment | dates | 20d anchors | status |
|---|---|---|---|
| **DISCOVERY (S1)** | 2007-02-28 … 2018-12-31 | ~150 | opened |
| **VALIDATION (S2)** | 2019-01-01 … 2023-12-31 | ~63 | opened |
| **HOLDOUT (S3)** | 2024-01-01 … 2026-09-01 | — | **SEALED — not read** |

This is the **fourth** experiment to open the 2019+ span. It tests a question
none of EXP-043, EXP-044 or EXP-045 asked — a binary stop-hit outcome rather than
an IC — but four looks is four looks, and the segment is worth correspondingly
less. Stated, not hidden. The holdout stays sealed.

## Sensitivity, descriptive only

The same primary at `riskAtrMult` ∈ {1.5, 2.5, 3.5}. 2.5 is the deployed value
and the only one that decides anything; the others exist to show whether a result
is specific to one stop width or is a property of the rule.

## Decision rule

**MISCALIBRATED AND WORTH FIXING** requires all three:

1. DISCOVERY: |diff| ≥ 2pp **and** two-sided p < 0.05
2. VALIDATION: same sign, p < 0.05
3. The secondary arm reduces the hit-rate spread across F3 quintiles in
   validation, using the β frozen on discovery

**MISCALIBRATED BUT NOT WORTH FIXING** if 1's significance holds but |diff| < 2pp,
or if 3 fails — the miscalibration is real and the proposed fix does not work.

**NOT MISCALIBRATED** otherwise.

## Power

Discovery n ≈ 150 anchors, validation n ≈ 63. The per-date `diff` is a difference
of two proportions over ~16-name cells pooled across 5 ATR quintiles, so its
per-date noise will be substantial; the standard deviation of the series is
reported alongside every estimate rather than assumed.

**A null is a genuinely likely outcome and would be informative**: it would say an
|IC| of 0.04 on a continuous target does not survive translation into a
threshold decision, which is exactly the gap between "measurable" and "useful"
that this project keeps having to police.

## Known weaknesses

1. **SURVIVORSHIP, cutting the wrong way again.** Companies that blew up are
   absent, and blowing up is the archetypal stop-hitting event. **Hit rates here
   are understated**, and the names most likely to reveal a miscalibration are the
   ones missing.
2. **Gap risk ignored.** A stop is treated as filled at the stop price; real fills
   gap through it. Both arms share the assumption so the comparison is fair, but
   the absolute cost of being stopped is understated.
3. **Not a P&L test**, as above.
4. **The S/R snap is off**, as above.
5. **Fourth look** at the validation span.
6. **The primary conditions on ATR quintiles**, which is coarser than
   conditioning on ATR continuously. A residual ATR gradient inside a quintile
   could leak into the F3 comparison; the within-quintile ATR spread is reported
   so the reader can see how much room that leaves.

## What a positive result would license

A registered follow-up that puts the adjusted risk unit through the full
`computeTradePlan` — S/R snap enabled, targets included, costs applied — on the
sealed period, and only after the definition and policy are frozen and hashed.
Not a production edit.

## What a null would license

Recording it, and closing the EXP-045 thread. F3's range effect would be real,
measurable, and too small to change a stop — which is a complete answer and ends
the line of work rather than inviting another variation.

---

Script: `scraper/research/exp046_us_stop_calibration.js`, committed with this
document and unchanged when run.
