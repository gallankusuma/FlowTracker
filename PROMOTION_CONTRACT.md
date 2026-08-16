# Promotion Contract v1

**Frozen 2026-08-16, before any candidate was tested against it.**

That sentence is the entire point. A bar written after seeing the results is not
a bar, it is a description of whatever passed. This document is therefore
deliberately written while **zero** candidates qualify — candlestick, harmonic
and the composite score have all already failed it, and none of them influenced
a single threshold below.

Changing any criterion mints **v2** and invalidates every prior pass. No
criterion may be relaxed to admit a specific candidate; that is the one
modification this contract forbids outright.

---

## The default is zero

> **Every signal is sized at zero until it has earned otherwise through the
> stages below. Absence of evidence is not a small position — it is no position.**

This is not caution, it is arithmetic. Measured today, after the project's
canonical 0.50% round-trip cost:

| candidate | measured | stage reached |
|---|---|---|
| Candlestick, 14 patterns (EXP-028) | 0 of 14 survive validation FDR | died at **S2** |
| Harmonic (EXP-018) | 20D −0.44%, 40D +0.06%, 60D ≈0.00% | died at **S1** |
| `composite_score` (EXP-026) | rank IC negative at all four horizons | died at **S1** |
| Broker accumulation (EXP-016) | inverted: IC −0.105 | died at **S1**, sign wrong |
| HI52W (EXP-011/012/013) | real but weak; walk-forward falsified the parameters | died at **S2** |

Nothing has reached S3.

---

## Stages

A candidate is a **frozen definition plus a frozen policy**: the rule that emits
the signal, the horizon, the entry/exit policy, and the universe. Changing any of
them makes it a new candidate that starts at S0.

### S0 — ADMISSIBLE

Nothing to do with edge. Can this thing be measured honestly at all?

- outcomes on the **canonical exchange calendar** (`idx_ihsg_history`), never on
  table rows
- every feature **strictly prior** to the decision bar; distance-from-high style
  metrics must exclude the entry bar
- missing input yields `unresolved`, never a neutral default or `false`
- universe membership and window frozen by **digest**, not by prose
- provenance recorded per run: definition version + hash, data source, cost model,
  code commit

*Enforced by:* `modules/breakout.js`, `research/candlestick/context_features.js`,
`MARKET_BREADTH_UNIVERSE_V1` / `MARKET_REGIME_WINDOW_V1` digest guards.

### S1 — DISCOVERY

In-sample evidence that anything is there.

| criterion | threshold |
|---|---|
| statistical unit | **one value per session**, never pooled ticker-days |
| inference at H > 1 | **non-overlapping anchors** on the exchange session index |
| multiple testing | Benjamini-Hochberg within a **pre-declared family**, q < 0.05 |
| reporting | effect size + 95% CI + n + raw p + q. Never q alone |
| sample | ≥ 100 occurrences **and** ≥ 30 independent anchors |
| costs | applied at the project constant, **0.50% round trip** |

Failing S1 is not a defect. It is the answer, and it must be recorded in the
registry as such.

### S2 — VALIDATION

Chronological, never shuffled.

- split fractions frozen **before** the run and hashed
- definitions frozen before validation is opened
- **same sign** as discovery, and survives FDR **within the validation family**
- effect may shrink; it may not vanish or invert

Sign agreement alone is **not** a pass. EXP-028 had 12 of 14 patterns agree on
sign and zero survive — that combination is the signature of low power, and it
means the window cannot resolve effects of that size. Report it as
"unresolvable", never as "directionally promising".

### S3 — HOLDOUT

- opened **exactly once**, after S2 passes and after both definition and policy
  are frozen and hashed
- the result is recorded whatever it says
- opening it to compare candidates, or reopening after a change, **burns it** —
  a burned holdout cannot be un-burned and the candidate cannot reach S4 without
  a fresh reserved period

*Enforced by:* `research/candlestick/exp028_oos.js` refuses the final segment
without `--open-holdout`.

### S4 — FORWARD SHADOW

Real time, real data, **no capital**. This binds to the existing gate rather
than restating it — `modules/forward_gate.js` `GATE` is authoritative:

| criterion | value | source |
|---|---|---|
| rebalance decisions | ≥ 24 | `minRebalanceDecisions` |
| calendar time | ≥ 12 months | `minCalendarMonths` |
| distinct regimes | ≥ 3 | `minDistinctRegimes` |
| fills | ≥ 50 | `minFills` |
| profit factor, net | ≥ 1.10 | `minProfitFactor` |
| excess vs eligible universe, net | ≥ 0 | `minExcessReturn` |

Added here because the gate does not cover them:

- a **control track** runs the unchanged strategy over the identical decisions;
  the candidate must beat the control, not merely be positive
- **no replay decision counts as live** — a decision is live only if it was
  recorded before its outcome existed
- candle/harmonic-derived output stays `actionable=false` throughout

### S5 — CAPITAL

Position size is a **function of measured out-of-sample expectancy**, never of a
conviction score. A conviction score that has not passed S2 carries no
information about size, and using it as if it did is how a zero-edge signal
acquires a large position.

Three numbers are **not mine to choose** and are deliberately left unset:

```
CAPITAL_AT_RISK            = UNSET
MAX_TOLERATED_DRAWDOWN_PCT = UNSET
PATIENCE_DECISIONS         = UNSET   # how long a live candidate may underperform
```

**Unset means zero.** S5 cannot be entered while any of the three is UNSET, and
the system must refuse rather than assume a default. A default here would be me
choosing the user's risk tolerance for them.

---

## Demotion — the direction the current system has no path for

Every gate in this project today is one-way. A promoted candidate has no defined
way back down, which means the first live failure is handled by whoever happens
to notice. That is the same shape as the 47-day silent feed outage and the cron
that reported OK while concentration failed.

So demotion is **automatic and mechanical**:

| trigger, on a rolling window of the last `PATIENCE_DECISIONS` | action |
|---|---|
| net profit factor < 1.00 | → S4 shadow, size 0 |
| net excess vs control < 0 | → S4 shadow, size 0 |
| drawdown > `MAX_TOLERATED_DRAWDOWN_PCT` | → S4 shadow, size 0, **and** kill switch |
| any S0 guarantee breaks (digest mismatch, unresolved inputs) | → immediate S4 shadow |

Demotion needs no human approval. **Re-promotion does**, and restarts at S4 with
a fresh forward window — a candidate that failed live does not resume its old
track record.

---

## Anti-gaming

1. This contract is frozen and versioned. A change mints v2 and **every** prior
   pass is void until re-run.
2. No criterion may be modified to admit a named candidate.
3. Candidates are declared **before** their family's FDR correction is computed;
   adding a candidate afterwards changes `m` and requires a re-run.
4. Selecting the best performers after seeing results is itself a gaming move —
   the family must be declared whole, and the losers reported with the winners.
5. Every stage transition is recorded with the commit hash, the definition hash,
   and the evidence, in `BACKTEST_EXPERIMENTS.md`. Append-only.

---

## What this contract does not claim

It does not make the system profitable, and passing it is not proof of an edge —
it is proof that an edge was not disproven under conditions chosen in advance.
With five candidates already dead at S1 and S2, the realistic expectation is that
most future candidates die too, and the machine's near-term value is as a
**measurement instrument** rather than a trader.

That is the honest reading, and the contract is built to survive it: the default
is zero, the failures are recorded, and nothing reaches capital by drift.
