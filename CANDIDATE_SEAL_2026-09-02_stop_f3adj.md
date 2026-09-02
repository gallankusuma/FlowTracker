# Sealed candidate — F3-adjusted ATR risk unit (`US_STOP_F3ADJ_V1`)

**Sealed 2026-09-02 at commit `d492891`. Nothing below may be edited.** A
correction gets a new file that says what it supersedes; changing this one
destroys the only thing it is for.

**This seal exists to open the project's only reserved period. Reading it burns
it.** Promotion Contract v1 S3: *"opened exactly once, after S2 passes and after
both definition and policy are frozen and hashed … opening it to compare
candidates, or reopening after a change, burns it — a burned holdout cannot be
un-burned."*

---

## The identity being sealed

| | |
|---|---|
| candidate id | `US_STOP_F3ADJ_V1` |
| **config hash** | **`0c3d3a0451ca2446`** |
| **script SHA-256** | **`5f18ba3d0aa1781219bb09d69477be09d61e7ad5649db22ad8e88c373e982f04`** |
| script | `scraper/research/exp047_us_stop_holdout.js` |
| incumbent | `computeTradePlan` POSITION profile, unmodified |
| changed from incumbent | risk unit multiplied by `(1 − 0.020·z(F3))`, floored at 0.2 |

The script prints its own SHA-256 at the top of every run. If it does not match
the value above, the file changed after sealing and the run is void.

Full effective configuration, exactly as it enters the hash:

```json
{"adjFloor":0.2,"anchorStep":20,"atrPeriod":14,"beta":-0.02,
 "bullishSignals":["STRONG BUY","BUY","WATCH"],"candidateId":"US_STOP_F3ADJ_V1",
 "holdoutEnd":"2026-09-01","holdoutStart":"2024-01-01","maxHoldSessions":20,
 "minCross":100,"nonInferiorityMarginPct":0.1,"quintiles":5,"riskAtrMult":2.5,
 "roundTripCostPct":0.5,"sameBarAmbiguity":"STOP","target1R":1.5,"target2R":2.5}
```

## The evidence that got it here

| stage | experiment | result |
|---|---|---|
| S1 discovery | EXP-045 | F3 predicts 20-session range after volatility is removed: IC −0.0417 (t −7.55) |
| S2 validation | EXP-045 | −0.0402 (t −5.19), 4/4 stability blocks; four post-hoc kill attempts failed |
| decision relevance | EXP-046 | the deployed 2.5×ATR stop is hit **+2.98pp** (disc, t 4.05) and **+4.65pp** (val, t 4.44) more often for low-F3 names at the same ATR distance; residual-ATR explanation ruled out and points the wrong way |
| fix | EXP-046b | **post-hoc**: β = −0.020 halves it out of sample (val +4.65pp → +2.69pp) |

**β is frozen at −0.020 and is not re-estimated on the holdout.** It was fitted
on discovery only.

## Stated honestly before opening: the fix arm was never registered

EXP-046's registered secondary **failed**, and its verdict — *"MISCALIBRATED BUT
NOT WORTH FIXING"* — stands. It failed because the objective I chose
(max-minus-min hit rate over five ~16-name cells) is ~23pp of sampling noise
against a 3–5pp effect. The corrected refit is **post-hoc**.

So this seal carries a candidate whose *miscalibration* is registered and
replicated, but whose *remedy* is not. That is a weaker position than a clean S2
pass and it is written here rather than discovered later.

## What the run does

The full deployed path, which EXP-046 deliberately did not use:

- `computeTradePlan` unmodified, **S/R snap ON, targets ON**
- entry at the next session's open on rows the deployed signal calls bullish
  (`STRONG BUY` / `BUY` / `WATCH`) — what production would journal
- exit at the first of stop / target1 / 20-session time exit
- **same-bar stop-and-target ambiguity resolves to STOP**, the project's existing
  convention, conservative
- **0.50% round-trip cost**, the project constant
- non-overlapping anchors, every 20th session

The candidate is applied by feeding `computeTradePlan` an F3-adjusted ATR, which
is exactly an adjusted risk unit — so the S/R snap band (0.5×–3× risk unit)
scales with it the way it would in production.

**Both arms see identical entries on identical dates.** EXP-044 showed the
composite has no directional edge; the entry does not need to be good, it needs
to be fixed, and whatever edge it has or lacks cancels in the paired difference.

## Decision rule, fixed before opening

**CANDIDATE HOLDS** requires both:

- **A (efficacy)** — the candidate's |stop-out rate difference between F3 bottom
  and top quintile| is **smaller** than the incumbent's.
- **B (no harm)** — the paired difference in net return per trade is
  **non-inferior**: the lower bound of its 95% CI exceeds **−0.10%**.

Anything else is a failure, and each failure mode is named separately in the
output so a partial result cannot be narrated as a partial success.

A hold licenses **S4 forward shadow, no capital** — nothing else, and no
production edit.

## Power, stated before opening

The holdout spans 2024-01-01 … 2026-09-01, roughly **670 sessions → ~33
non-overlapping anchors**. Barely over the 30-anchor bar.

Scaling EXP-046's validation result (t 4.44 at n = 62) gives an expected
t ≈ 3.2 for arm A **if the effect persists at the same size**, so A is
adequately powered. **Arm B is not.** A per-anchor mean of trade returns at
n = 33 will carry a wide interval, so non-inferiority here is a weak test and the
CI is reported rather than a bare yes/no.

Burning a 33-anchor holdout is a real cost for a weak second arm. It is being
spent deliberately, with that stated in advance.

## What cannot be fixed by this run

- **Survivorship.** Today's S&P 500 projected back; companies that blew up are
  absent, and blowing up is the archetypal stop-hitting event. Biased upward.
- **Gap risk.** Stops fill at the stop price. Shared by both arms, so the
  comparison is fair, but the absolute cost of being stopped is understated.
- **No directional edge exists.** The absolute P&L of both arms is expected to be
  poor. Only the **difference** is being read.

---

Result recorded in `BACKTEST_EXPERIMENTS.md` as EXP-047, whatever it says.
