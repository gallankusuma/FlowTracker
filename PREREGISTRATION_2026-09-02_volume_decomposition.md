# Pre-registration — where does the volume→range effect live, and why is it US-only?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## The question, and what it is NOT

EXP-045 found volume predicts the 20-session range after volatility is removed
(US, |IC| ≈ 0.04, replicated). EXP-046 showed it is large enough to bias the
deployed stop (+2.98 / +4.65 / +7.61pp across three periods). EXP-048 found
**none of it on IDX** (+0.77pp, t 0.55), with a passing positive control.

This asks **why**. It is mechanism-seeking, and it carries a hard limit:

> **This experiment cannot strengthen the F3 finding.** Whatever it reports, the
> evidence for the effect remains exactly EXP-045 and EXP-046. A mechanism that
> "makes sense" is not additional confirmation — it is a story fitted to a result
> that already exists, and stories are cheap.

It also licenses **no production change of any kind**, on either market.

## The hypothesis being distinguished

**H-EVENT.** A volume spike in a US large cap is typically an **event that
resolves uncertainty** — earnings above all, where a scheduled announcement is
followed by a well-documented collapse in implied and realised volatility. If
that is the mechanism, the effect must live in the **transient** part of volume:
today unusual against its own recent past. Persistently elevated volume is a
different animal — an active, contested stock — and should not shrink the range,
and might widen it.

**H-ACTIVITY.** Volume simply proxies for something continuous about the stock's
state, in which case the **persistent** component should carry the effect and the
split will show no interesting asymmetry.

These make opposite predictions and the test separates them.

## The decomposition, fixed now

For a ticker on session *t*, from prices only:

```
VOL_TRANSIENT  = ln( volume_t / mean(volume, t-19 .. t) )
VOL_PERSISTENT = ln( mean(volume, t-19 .. t) / mean(volume, t-59 .. t) )
```

Today against the recent past; the recent past against the longer past. Both use
only bars at or before *t*. Logs because volume is right-skewed by orders of
magnitude and a ratio in levels would be dominated by the largest names.

They are near-orthogonal by construction, and their measured correlation is
reported so a reader can see how near.

## Target and controls — unchanged from EXP-045 on purpose

- **Target**: `range_20d = max_profit_20d − max_drawdown_20d`, sign-free.
- **Control**: `PRIOR_VOL`, the 20-session realised volatility ending at *t*.
  Each predictor is residualised on it within date, and the IC is Spearman of the
  residual against range.

Keeping these identical to EXP-045 is deliberate: if the machinery changed, a
difference in result could be the machinery.

## Positive control — the run is VOID without it

**`PRIOR_VOL` vs `range_20d` must be ≥ +0.10 at p < 0.01, in each market
separately.**

This was **omitted from EXP-048's pre-registration** and had to be supplied
post-hoc — the third design lapse of the arc. It is not omitted again. If a
market's control fails, that market's results are not read at all.

## The family

`{VOL_TRANSIENT, VOL_PERSISTENT} × {US, IDX}` = **m = 4**, Benjamini-Hochberg,
q < 0.05, two-sided. Both directions are live: the event story predicts a
negative transient IC, but nothing is fixed in advance.

## Segments and data

| market | window | source |
|---|---|---|
| US | 2007-02-28 … 2023-12-31 | `us_signal_history` + `us_stock_prices` |
| IDX | 2016-08-01 … 2023-12-31 | `idx_stock_prices` |

Both stop before 2024-01-01. **The IDX reserve (2024-01-01 … 2026-09-01) stays
sealed and the script cannot read it.** The US holdout is already burned by
EXP-047 and is excluded here anyway, so this run spends nothing new.

Eligibility mirrors EXP-048 on IDX (≥ 60 prior sessions, volume > 0 on ≥ 48 of
the last 60, complete forward path) and EXP-045 on US. Dates need ≥ 100 eligible
names. Non-overlapping anchors, every 20th session.

## The liquidity question, and why it may be the whole answer

The US universe is the S&P 500. The IDX eligible universe has a **median price of
Rp 368** and includes names that trade thinly enough to fail a zero-volume
screen. These may not be comparable populations at all.

So the run reports, descriptively:

1. The **dollar-volume distribution of each universe**, converted at a flat
   **16,000 IDR/USD** — a rough constant that affects nothing within a market and
   exists only to put the two on one axis.
2. The transient-component IC **by dollar-volume quintile**, in each market.

If IDX's most liquid quintile sits below US's least liquid quintile, then
"US-only" is more honestly stated as **"liquid-only"**, and the cross-market
difference stops being about the market at all. That possibility is written down
now so it cannot be presented later as a discovery.

These are **descriptive and cannot decide anything.** A gradient across five
buckets after the fact is a subgroup analysis.

## Decision rule

For each market, for each component:

- **CARRIES** if |IC| ≥ 0.02 and q < 0.05.
- **DOES NOT CARRY** otherwise.

Then, mechanically:

- **H-EVENT SUPPORTED** if on US the transient component carries and the
  persistent one does not.
- **H-ACTIVITY SUPPORTED** if the persistent component carries and the transient
  does not.
- **BOTH** or **NEITHER** are reported as such, and neither is dressed up.

No outcome licenses a change to `f3_volumeZ`, to `trade_policy`, or to anything
else. A supported mechanism would license **one** thing: a pre-registered test of
a transient-only volume measure on the IDX reserve or the forward reserve — which
is a separate document and a separate seal.

## Power

US ≈ 200 anchors, IDX ≈ 87. EXP-045 measured |IC| 0.04 at t 7.55 on 212 US
anchors, so a component carrying half the effect would still be visible on US. On
IDX, EXP-048's power check showed a US-sized effect would have surfaced at
t ≈ 3.1, so **an IDX null here is again informative rather than merely quiet.**

The decomposition splits one signal into two, so each half is weaker than the
whole by construction. A result where **neither** component clears while the
combined F3 did is a real possible outcome and would mean the split destroyed the
signal, not that the signal is absent.

## Known weaknesses

1. **No earnings dates.** H-EVENT is tested through the *shape* of the volume
   pattern, not by identifying actual announcements. A transient-component result
   would be **consistent with** the earnings story without demonstrating it. Saying
   otherwise would be overclaiming, and the report will not.
2. **Survivorship**, both markets. Worth noting one thing it cannot explain: the
   US effect is **strongest in 2024–2026**, the period where survivorship bias is
   weakest because almost every name still exists. That runs against a
   survivorship account rather than for it.
3. **The two universes differ in construction**, which is the point of the
   liquidity section but also means no cross-market comparison here is clean.
4. **Already-seen data.** Nothing here is out of sample for the F3 effect. That is
   why this cannot confirm anything.

---

Script: `scraper/research/exp049_volume_decomposition.js`, committed with this
document and unchanged when run. It cannot read either reserved period.
