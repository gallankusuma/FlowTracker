# Pre-registration — are the composite's weights an accident of naming?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Where this came from

EXP-040 found that fourteen factors measure far fewer than fourteen things. The
natural inference — "so drop the redundant ones" — is wrong: several noisy
measurements of one quantity, averaged, estimate that quantity better than any
one of them. Dropping F9–F12 would make the momentum reading noisier, not
sharper.

What redundancy actually corrupts is **weighting**. `RAW_F1_13_SHARES` assigns a
share to each factor by name. If five names describe one thing, that thing
receives the sum of five shares — and nobody chose that number.

Measured on the 145 sessions in `idx_signal_history` (2026-01-19 … 2026-09-01,
39,430 rows), clustering F1–F13 by cross-sectional Spearman correlation with
**single linkage at |rho| >= 0.5** — the same redundancy threshold
`modules/signal_map.js` already uses, not a new choice — gives **K = 5**:

| cluster | members | current share | equal-cluster share |
|---|---|---|---|
| broker flow + breadth | F1, F2, F6, F7, F8 | **48.5%** | 20.0% |
| momentum / oscillator | F4, F9, F10, F11, F12 | **33.0%** | 20.0% |
| volume | F3 | 8.2% | 20.0% |
| relative strength | F5 | 7.2% | 20.0% |
| support/resistance | F13 | 3.1% | 20.0% |

Two clusters hold **81.5%** of the directional vote. F13 holds 3.1%.

**A correction, recorded here rather than quietly fixed.** In conversation I
described this as four clusters with broker at 38.1% and breadth separate at
10.3%. At the registered threshold F6 links to F1 at rho = -0.52 and joins the
broker cluster, making it five clusters and 48.5%. The spoken figure was wrong.

## The hypothesis

**H1.** A composite that weights each **cluster** equally ranks IDX stocks
better, by rank IC against forward return, than the deployed per-factor weights.

**H0.** It does not.

**Two-sided.** I have a story for why cluster weighting should win, and I do not
believe it enough to buy a factor of two in significance with it. The current
weights may encode something real that nobody wrote down. Direction is not fixed.

## Zero free parameters — this is not optimisation

Equal-per-cluster is a prior, not a fit. There is no knob to turn and nothing is
chosen by looking at returns. The cluster membership comes from
**factor-to-factor** correlation only; no forward return touches the clustering
step. That is what makes this registrable at all, and it is the sole reason a
145-session window is not immediately fatal to it.

## The three schemes

| scheme | definition |
|---|---|
| `W_current` | `DEFAULT_WEIGHTS` from `modules/score_engine.js`, unchanged |
| `W_cluster` | 1/K to each cluster, split equally within it |
| `W_flat` | 1/13 to every factor |

**`W_flat` is the control that decides the interpretation, and it is why this
test is worth running.** If `W_cluster` beats `W_current` but `W_flat` beats it
by about as much, the finding is *"the current weights are bad"* — not
*"clustering is right"*. Without this arm the result would be unreadable, and I
would have read it the flattering way.

## Scoring path

`combineFactorScores()` from `modules/score_engine.js`, the production function —
`finalScore`, including confidence and the F14 risk modifier. Not a
re-implementation. F14 stays a modifier and receives no directional weight,
exactly as deployed.

Availability per factor is `value !== null`, which is `weightedComposite`'s own
contract. Stored nulls stay null; missing is not zero.

## Statistic and unit of observation

**One value per session.** Within a date, tickers share the market move; pooling
39,430 ticker-days would overstate significance the way overlapping windows do.

Per date: rank IC (Spearman) of `finalScore` against forward return, under each
scheme. The test statistic is the **paired per-date difference**, which is far
less noisy than either IC alone because both schemes see the same factors on the
same tickers on the same day.

Inference on **non-overlapping anchors** on the session index, per Promotion
Contract v1 S1.

## The horizon problem, stated before the run

S1 requires >= 30 independent anchors. With 145 sessions:

| horizon | non-overlapping anchors | S1 anchor bar |
|---|---|---|
| `return_10d` | **14** | **FAILS** |
| `return_5d` | 29 | **FAILS** |
| `return_3d` | 48 | passes |

**The horizon this project actually trades cannot be tested admissibly today.**
Position holding is 2–8 weeks; `return_10d` is already the short end of that, and
145 sessions do not reach 30 non-overlapping 10-day anchors. Thirty of them needs
about 300 sessions — roughly **April 2027** at ~21 sessions a month.

So:

- **PRIMARY, admissible:** `return_3d`, 48 non-overlapping anchors. This tests the
  *weighting mechanism*. It is **not** the traded horizon and a pass here is not a
  tradeable claim.
- **SECONDARY, inadmissible, reported anyway:** `return_10d` and `return_5d`,
  stamped as failing the anchor bar. They are the horizons of interest and hiding
  them would be worse than showing them under a warning.
- **Re-run date** for an admissible `return_10d` arm: when `idx_signal_history`
  holds >= 300 sessions.

## Multiple testing

Pre-declared family, primary horizon only: `{cluster - current, flat - current,
cluster - flat}`. **m = 3**, Benjamini-Hochberg, q < 0.05. Effect size, 95% CI, n,
raw p and q all reported; never q alone.

## Decision rule

**CLUSTER WEIGHTING BETTER** requires all three:

1. `IC_cluster - IC_current > 0` at q < 0.05, and
2. `IC_cluster - IC_flat > 0` at q < 0.05 — otherwise the result belongs to
   flattening, not to clustering, and
3. **`IC_cluster > 0` on its own.** `composite_score` already died at S1 with
   negative rank IC at all four horizons (Promotion Contract v1). Beating a losing
   configuration by being less negative is not a pass, and will be reported as
   *"the difference is between two losing schemes"*.

**CURRENT WEIGHTING BETTER** if the paired difference is significantly negative.

**INCONCLUSIVE** otherwise — including every case where the sign is right and the
interval spans zero. Given 48 anchors, inconclusive is the likely outcome and
saying so now stops it being narrated as promising later.

## Power, stated before the result

At n = 48 anchors, 80% power detects about **d = 0.41** — a large, consistent
difference. This test cannot find a small one. **A null here means "not
detectable in 145 sessions", never "no difference".**

## What a positive result would license

**Not a production weight change.** One thing: a sealed candidate entering the
existing S2 path under Promotion Contract v1, with the definition and policy
frozen and hashed first. Weights are the parameter this project has already been
burned on twice (the 2026-07-19 overfitting incident, the 2026-07-31 challenger
threshold mismatch), and a diagnostic on one regime does not get to move them.

## What a negative or inconclusive result would license

Recording in `BACKTEST_EXPERIMENTS.md` that the weighting question is open and
unanswerable at the current sample size, and leaving `DEFAULT_WEIGHTS` alone.

## Known weaknesses

1. **One regime.** All 145 sessions sit inside one IHSG drawdown. Factor-to-factor
   correlations travel between regimes; ICs do not.
2. **Single linkage chains.** F6 enters the broker cluster on a single rho = -0.52
   edge. A sensitivity at |rho| >= 0.6 (which separates F6 and gives K = 6) is
   registered as a secondary and reported whatever it says.
3. **Clusters and test share a window.** Membership uses no returns, so this is
   not target leakage, but it is not an independent sample either.
4. **Survivorship.** `backfill_price_history.js` only ever fetched tickers present
   in `idx_broker_summary`. Biased upward regardless of outcome.

---

Script: `scraper/research/exp042_cluster_weights.js`, committed with this document
and unchanged when run.
