# Pre-registration — can anything predict how far a stock will MOVE, beyond volatility?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Why the question changes shape here

EXP-042, EXP-043 and EXP-044 all asked variations of *"which stock will go up?"*
and all returned nothing. EXP-044 in particular tested nine factors individually
across 4,240 sessions and the largest |t| in the table was 1.60.

After three nulls the tempting move is to hunt for a subset or a transformation
that survives. That is exactly what EXP-044 demonstrated is dangerous — F5 at a
secondary horizon looked like a carrier at q = 0.029 and inverted in validation.

So this changes the **target**, not the search. Instead of direction, it asks
about **magnitude**: not *which stock rises*, but *which stock will travel far*.

That is structurally different in a way the previous three were not:

- Direction has been null in every test. Magnitude has a strong prior in the
  literature — volatility clusters, returns do not.
- It is **actionable through a different mechanism**. `computeTradePlan` already
  places stops and targets off ATR, and that placement has never been validated
  on this data. A better range forecast changes stop distance and position size,
  not what to buy.

## The target

`range_20d = max_profit_20d − max_drawdown_20d`

The total excursion of the next 20 sessions, in percent, from the as-of close.
Both columns are already stored (populated on 1,861,748 of 1,869,884 rows,
99.6%), computed from intraday highs and lows on the ticker's own session index
and NULL when the path is incomplete.

**It is sign-free by construction**, which is the point. Asymmetric alternatives
were considered and rejected: `max_profit + max_drawdown` is very nearly a
monotone transform of the 20-day return, so testing it would be re-running
EXP-044 in a costume. Range cannot be, because it is a magnitude with the
direction divided out.

## The hypothesis

**H1.** For a given factor, its cross-sectional rank IC against `range_20d`,
**after removing what volatility already explains**, is different from zero.

**H0.** It is not.

**Two-sided.** No direction is fixed for any factor.

## The controls, and why the incremental form is the only interesting one

Volatility predicting future volatility is one of the most robust facts in
finance. A raw test would "pass" for anything correlated with volatility and
would tell us nothing we did not already know. So volatility is **controlled
for**, and the hypothesis is about what remains.

**Two control variables, both known at decision time:**

1. **`PRIOR_VOL`** — the standard deviation of daily percentage change over
   sessions [t−19, t] for that ticker, computed from `us_stock_prices`. Every bar
   used is at or before the as-of date. This is the strong, continuous control.
2. **F14** — the deployed ATR score. Included as well, because it is what
   production actually uses.

F14 is deliberately not the only control. `scoreATR` is a **six-level step
function** (80 / 70 / 55 / 40 / 25 / …), so residualising against it alone would
leave most of the volatility information in the residual and manufacture a
"beyond ATR" pass. That soft-control failure is the kind this project has been
burned by before, so the continuous measure carries the weight.

Residualisation is a two-predictor OLS on **within-date ranks** (factor rank
regressed on PRIOR_VOL rank and F14 rank); the IC is then Spearman of the
residual against `range_20d`.

## Positive control — the experiment is VOID if this fails

Before any hypothesis is read:

- **`PRIOR_VOL` vs `range_20d`** must have IC **>= +0.10** with q < 0.01 in
  discovery. Volatility clusters; if this pipeline cannot see that, it cannot see
  anything and no other number in the run may be reported.
- **F14 vs `range_20d`** must be **negative**. `scoreATR` returns 80 for a tight
  ATR and 25 for a wild one, so its relationship to future range is inverted **by
  construction**. A positive sign here would mean the column does not hold what
  its own scoring function says it holds.

Both directions are fixed **now**, from the code, not from the data. A positive
control is a validity check and **cannot produce a finding**: passing it confirms
only that the measurement works.

## The family

The eight non-F14 factors: **F3, F4, F5, F9, F10, F11, F12, F13**.
**m = 8**, Benjamini-Hochberg, q < 0.05, applied within each segment.

F14 is excluded from the family because it is a control here, not a candidate.
That is the opposite of the choice made in EXP-044, and the reason is that its
role has changed: there it was a candidate tested against return, here it is a
regressor removed from the residual. A variable cannot be both.

## Segments

| segment | dates | 20d anchors | status |
|---|---|---|---|
| **DISCOVERY (S1)** | 2007-02-28 … 2018-12-31 | ~150 | opened |
| **VALIDATION (S2)** | 2019-01-01 … 2023-12-31 | ~63 | opened |
| **HOLDOUT (S3)** | 2024-01-01 … 2026-09-01 | — | **SEALED — not read** |

The holdout sealed in EXP-044 stays sealed. This is the **third** experiment to
open the 2019+ span; it is a genuine out-of-sample test of a question neither
EXP-043 nor EXP-044 asked, but the segment has now been looked at three times and
is worth correspondingly less. Stated, not hidden.

Only one horizon exists for this target — the path columns are 20-session by
construction — so there is **no horizon scan available to mine**. That removes
the specific trap EXP-044 caught, structurally rather than by discipline.

## The economic floor

**|IC| >= 0.02**, the same floor EXP-041 fixed and EXP-044 reused.

**Honest caveat**: that number was chosen for *return* prediction. There is no
principled mapping from a range-forecast IC to money, and inventing one now would
be a threshold picked to fit. It is reused for consistency and flagged as
under-justified rather than dressed up.

## Stability screen

Within DISCOVERY only, four equal chronological blocks; a factor passes if its
sign agrees with its full-discovery sign in **at least 3 of 4**. Robustness
screen, not a significance test — same as EXP-044, where it was the check that
mattered.

## Decision rule, per factor

**CARRIER** requires all four:

1. DISCOVERY `|residual IC| >= 0.02`
2. DISCOVERY BH `q < 0.05` within the m = 8 family
3. Stability screen passed (>= 3 of 4 discovery blocks agree in sign)
4. VALIDATION: same sign and BH `q < 0.05`

**REAL BUT NEGLIGIBLE** if 2, 3 and 4 hold but `|IC| < 0.02`.

**BELONGS TO VOLATILITY** if the factor passes on the **raw** IC but not on the
residual. Reported explicitly, because that is the most likely way to get an
exciting-looking number here and it is not a finding.

**NOT A CARRIER** otherwise.

Everything is void if the positive control fails.

## Power

Discovery n = 150 anchors detects about **d = 0.23** at 80% power before BH;
validation n = 63 detects about **d = 0.36**. Per-date IC standard deviations are
reported with every estimate so the reader can see what the test could have seen.

Range is a smoother, more autocorrelated quantity than return, so the per-date IC
series should be less noisy than EXP-044's — which would make this the
best-powered test in the series. Whether that is so is reported, not assumed.

## Known weaknesses

1. **SURVIVORSHIP.** Today's S&P 500 projected back twenty years; 11 of 418 were
   unfetchable. Companies that blew up are absent, and blow-ups are precisely the
   large-range events this target measures. **The bias here is not just upward on
   returns — it removes the right tail of the thing being predicted.** This is a
   more serious problem for a range experiment than it was for a return one, and
   it is the single biggest reason to distrust a positive result.
2. **Third look at the validation span.**
3. **Range is not tradeable on its own.** A wider forecast range widens both
   tails. It informs stop distance and position size; it does not say which way
   to bet. A carrier here is an input to risk management, not a signal.
4. **No cost model applies**, because no trade is being simulated. That also
   means nothing here can be called profitable.
5. **Eight tests on one dataset**; BH controls the false-discovery rate, not the
   family-wise error.

## What a positive result would license

A registered follow-up asking whether the improved range forecast actually
improves stop placement in `computeTradePlan` — measured, on data this run has
not touched. Not a production edit, and not an S3 read.

## What a null would license

Recording it. Together with EXP-042 through EXP-044 it would say the factor set
carries neither directional nor incremental-magnitude information, which is a
complete and useful answer about this feature family.

---

Script: `scraper/research/exp045_us_path_range.js`, committed with this document
and unchanged when run.
