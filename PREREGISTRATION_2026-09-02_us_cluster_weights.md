# Pre-registration — cluster weighting on US, where the test can actually have power

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Why this exists

EXP-042 asked whether the composite's weights are an accident of naming and came
back **unresolvable**. Not because the design was weak — because
`idx_signal_history` holds 145 sessions, which at the traded horizon is 12
non-overlapping anchors against Promotion Contract v1 S1's bar of 30.

`us_signal_history` now holds **4,909 sessions** (2007-02-28 … 2026-09-01,
1,869,884 rows, 407 tickers). At 20 sessions that is **245 anchors**, and there
is enough of it to hold a chronological validation segment back. This is the
same question asked where it can be answered.

## The US cluster structure, and why it is a sharper case

The US composite carries eight directional factors: F1, F2, F6, F7 and F8 need
per-broker data that does not exist for US equities. `US_TECH_WEIGHTS`
renormalizes the surviving eight to 1.0 — which silently redistributes the 48.4%
those five held on IDX across the survivors, **proportionally**, and five of the
eight survivors describe momentum.

Clustering F3–F13 by cross-sectional Spearman, single linkage at |rho| >= 0.5 —
the threshold `modules/signal_map.js` uses — gives **K = 4**:

| cluster | members | current share | equal-cluster |
|---|---|---|---|
| momentum / oscillator | F4, F9, F10, F11, F12 | **64.1%** | 25.0% |
| volume | F3 | 15.9% | 25.0% |
| relative strength | F5 | 14.0% | 25.0% |
| support/resistance | F13 | 6.0% | 25.0% |

**One idea holds 64.1% of the vote**, against 33.1% for the same cluster on IDX.
Nobody chose either number; both are counts of how many names an idea happens to
have, and the US figure is worse precisely because dropping the broker factors
concentrated it further.

**The clustering is not threshold-sensitive here.** At |rho| >= 0.6 the
membership is *identical*. That was not true on IDX, where F6 chained into the
broker cluster on a single 0.52 edge. So the sensitivity arms are moved to 0.4
and 0.7, where membership does change:

- **|rho| >= 0.4** → F5 joins momentum via F4 (0.45): K = 3.
- **|rho| >= 0.7** → F4's strongest tie is 0.68, so it splits off: K = 5,
  clusters [F9,F10,F11,F12], [F4], [F5], [F3], [F13].

Both are reported descriptively. Neither can change the verdict.

## The hypothesis

**H1.** A composite that weights each **cluster** equally ranks S&P 500 stocks
better, by rank IC against forward return, than the deployed per-factor weights.

**H0.** It does not.

**Two-sided.** EXP-042 found `cluster − current` positive at all three IDX
horizons, which is a directional hint — but it was **unresolvable**, on a
different market, with a different cluster structure and a different weight
table. That is not strong enough to buy a factor of two in significance.
Direction is not fixed.

## Zero free parameters

Equal-per-cluster is a prior, not a fit. Cluster membership comes from
**factor-to-factor** correlation only; no forward return touches the clustering
step. There is no knob to turn.

## The three schemes

| scheme | definition |
|---|---|
| `W_current` | `US_TECH_WEIGHTS` from `modules/us_score_engine.js`, unchanged |
| `W_cluster` | 1/K to each cluster, split equally within it |
| `W_flat` | 1/8 to every factor |

**`W_flat` decides the interpretation.** If `W_cluster` beats `W_current` but
`W_flat` beats it by about as much, the finding is *"the current weights are
bad"*, not *"clustering is right"*. On US this arm matters even more than on
IDX: with 5 of 8 factors in one cluster, flat-1/8 already gives momentum 62.5%,
so `W_flat` and `W_cluster` are genuinely different objects and the contrast
between them is informative rather than cosmetic.

## Scoring path

`combineFactorScores` is IDX-only. The US composite is
`combineFinalScore(weighted8, computeConfidence(undefined), computeRiskModifier(f14))`
exactly as `modules/us_score_engine.js` computes it — the experiment re-weights
the stored factor columns through that same arithmetic rather than through a
re-derivation. F14 stays a risk modifier and receives no directional weight.

Rank IC is scale-free, so the fact that the US composite spans only 34–77 and
never reaches the STRONG BUY threshold is **irrelevant here**: only the ordering
is used. That compression is recorded as a separate observation, not a
confound.

## Statistic and unit of observation

**One value per session.** Per date: rank IC (Spearman) of the composite against
forward return, under each scheme. The test statistic is the **paired per-date
difference**, which is far less noisy than either IC alone because both schemes
see the same factors on the same tickers on the same day.

A date is used only if at least **30** tickers have a resolved outcome.
(Cross-section on this table: min 35, median 388, max 407.)

Inference on **non-overlapping anchors** on the session index.

## Horizons

**Primary: `return_20d`** — about four weeks, the middle of this project's stated
2-to-8-week position holding. 245 anchors across the full span.

Secondary, reported but not decisive: `return_10d` (490 anchors) and
`return_40d` (122 anchors). Both clear the S1 bar; they are secondary because the
primary must be named in advance and 20d is the horizon actually traded.

## The frozen split — the thing IDX could never support

Fixed here, before the run:

| segment | dates | sessions | 20d anchors |
|---|---|---|---|
| **DISCOVERY (S1)** | 2007-02-28 … 2018-12-31 | 2,982 | **149** |
| **VALIDATION (S2)** | 2019-01-01 … 2026-09-01 | 1,927 | **96** |

Chronological, never shuffled. Discovery covers the GFC and the 2010s bull run;
validation covers COVID, the 2021 melt-up and the 2022 drawdown. Both segments
clear the 30-anchor bar on their own.

Validation is **not** a Promotion Contract S3 holdout and is not treated as one —
opening it here does not burn a holdout, because none has been reserved for this
candidate. If this ever reaches S3, a fresh reserved period is required.

## Multiple testing

Pre-declared family, primary horizon, **within each segment separately**:
`{cluster − current, flat − current, cluster − flat}`. **m = 3**,
Benjamini-Hochberg, q < 0.05. Effect size, 95% CI, n, raw p and q all reported;
never q alone.

## Decision rule

**CLUSTER WEIGHTING BETTER** requires all four:

1. In **DISCOVERY**: `IC_cluster − IC_current > 0` at q < 0.05.
2. In **DISCOVERY**: `IC_cluster − IC_flat > 0` at q < 0.05 — otherwise the
   result belongs to flattening, not to clustering.
3. In **VALIDATION**: the same contrasts hold the **same sign** and survive BH
   within the validation family. Per Promotion Contract v1 S2 the effect may
   shrink; **it may not vanish or invert**.
4. **`IC_cluster > 0` on its own, in both segments.** EXP-042 found every IDX
   scheme negative at every horizon. Beating a losing configuration by being less
   negative is not a pass and will be reported as *"the difference is between two
   losing schemes"*.

**CURRENT WEIGHTING BETTER** if the discovery difference is significantly
negative.

**UNRESOLVABLE** if signs agree across segments and horizons but nothing clears
significance — the EXP-028 signature. It will be reported with that word, never
as "directionally promising".

**INCONCLUSIVE** otherwise.

## Power, stated before the result

Discovery n = 149 anchors detects about **d = 0.23** at 80% power; validation
n = 96 detects about **d = 0.29**. Compare EXP-042's d = 0.46. This test can find
a moderate effect, not merely a large one — which is the entire reason for
building the US table.

A null here is a much stronger statement than a null on IDX was, and will be
reported as such rather than as "not detectable".

## Secondary, descriptive only, never decisive

1. The `|rho| >= 0.4` (K=3) and `|rho| >= 0.7` (K=5) weightings.
2. The contrast within each of four equal chronological blocks, to show whether a
   result is carried by one period.
3. Mean IC per scheme per segment, so the absolute level is visible next to the
   difference.

## Known weaknesses

1. **SURVIVORSHIP, and it is worse than on IDX.** `modules/us_tickers.js` is a
   present-day S&P 500 snapshot and Yahoo does not serve delisted symbols.
   Twenty years of history for today's members excludes every company that
   failed or was acquired out of the index — 11 of 418 could not be fetched at
   all. Scoring 2008 across the banks that *survived* 2008 is close to a
   definition of the bias. **Every number this produces is biased upward.**
2. **This does not transfer back to IDX.** Different factor set, different
   weights, different cluster structure. A US result is evidence about US.
3. **Clusters and test share a window.** Membership uses no returns, so this is
   not target leakage, but it is not an independent sample either.
4. **Early sessions are thinner.** The minimum cross-section is 35 tickers, in
   2007. Those dates carry the same weight as a 407-ticker date in the anchor
   average; this is stated rather than corrected, because weighting dates by
   breadth would be a free parameter.

## What a positive result would license

**Not a production weight change**, and not one on IDX under any circumstances.
One thing: a sealed US candidate entering S3 with a freshly reserved period,
definition and policy frozen and hashed first.

## What a negative, unresolvable or inconclusive result would license

Recording it in `BACKTEST_EXPERIMENTS.md` and leaving `US_TECH_WEIGHTS` alone. A
null at this sample size is a real answer, not a waiting room.

---

Script: `scraper/research/exp043_us_cluster_weights.js`, committed with this
document and unchanged when run.
