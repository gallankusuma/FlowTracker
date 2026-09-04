# Pre-registration — a structural stop against the ATR stop, on IDX

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Where the question comes from

A cheat sheet summarising Patrick Nill's method places the stop **objectively
just outside the consolidation range** — below the Value Area Low for a long —
rather than at a volatility multiple. `computeTradePlan` does the reverse: it
sizes the risk unit at `ATR(14) × 2.5` and only *snaps* to a support level if one
happens to sit between 0.5× and 3× that unit. **Structure is a modifier in our
code and the primary in his.**

That difference is measurable with data we already hold, it touches the
production path this project actually trades, and it has never been tested.

**What is NOT being tested, and it is most of his method.** The execution layer —
15-minute footprint charts and the order book — needs order-flow data this
project does not have. He is explicit that the zone only says *where* to look and
the order flow says *whether* to act. A test of the location rule alone is a test
of half the method, and no result here says anything about the other half.

**And the source adds no evidence.** A world-championship winner is one sample
from thousands of entrants, in a contest that rewards return rather than return
per unit of risk. His risk rules are sound and uncontroversial; the claim
"champion" does not make the location rule true. That is why it is being measured
rather than adopted.

## What has already been measured, so this is not re-run

EXP-036/037/038 tested the **entry** half of the same framework on IDX. Buying a
close into a support zone and holding 20 sessions returned **1.6% less** than
simply holding the same stock (significant); resistance zones, 0.6% less (not
significant), and the two sides could not be told apart. The ping-pong rule —
buy VAL, sell VAH — is the one part of this already answered here, and it lost.

**This experiment is about the stop, not the entry, and the entry is deliberately
uninformative.**

## The design decision that shapes everything

For a single stop below an entry, **placement and distance are the same
quantity.** Match the distance and the stop price is identical; there is no
second axis. So the two rules differ *only* in how far away they put the stop,
and the claim under test is that the structural distance is better calibrated to
where price actually goes.

The test therefore asks: **at the same average risk budget, which rule is hit
less often?**

A rule that is simply wider is hit less often and is not thereby better — that is
why the ATR arm is rescaled to match, rather than run at its deployed 2.5.

## The two arms

| arm | stop |
|---|---|
| **STRUCTURE** | the structural level, minus a 0.2 × ATR buffer |
| **ATR** | `entry − k × ATR(14)`, with **k fitted on FIT only** so the two arms' **median** distances match |

Median rather than mean: structural distances are right-skewed (an old swing low
can sit 40% away) and a mean would let a handful of extreme names set the scale.
Both mean and median distances are reported for each arm so the match is visible
rather than asserted.

`k` is the only fitted quantity, it is fitted to equalise **distance** and never
to improve **hit rate**, and it is frozen before CHECK.

## The structural level — two operationalisations, both primary

**m = 2**, Benjamini-Hochberg, q < 0.05, two-sided.

1. **Last swing low**, from the deployed `structure()` at k = 3. This is what the
   Deep Analysis page already prints as `invalidation.below`, so a result here is
   immediately actionable in code that exists.
2. **Value Area Low**, from the deployed `zones()`. This is Nill's own version.

I do not know which is the better operationalisation and naming one primary would
be an arbitrary choice I would regret if the other passed. Two is cheap at BH.

## Positive controls — registered, and they VOID the run

EXP-048 omitted a control and had to add it post-hoc; EXP-050 registered one that
measured a different statistic from its own acceptance band. Both are corrected
here by stating the statistic and the expected value together:

1. **Monotonicity.** The ATR arm's hit rate must **fall** as `k` rises across
   {1.5, 2.5, 3.5}. This is mechanical — a wider stop cannot be hit more often —
   so a failure means the simulation is wrong.
2. **Distance match.** After fitting `k`, the two arms' median distances must
   agree within **5% relative** on FIT. If they do not, the comparison is between
   different risk budgets and nothing else may be read.

## Statistic

Entry-agnostic: every eligible ticker-date opens a hypothetical long at the next
session's open, both arms on identical entries. **Not a P&L test.**

No target, so "did any of the next 20 lows reach the stop" needs no intrabar
ordering — the reason EXP-037 refused to simulate stops does not apply.

Per anchor date: `gap = hitRate(ATR arm) − hitRate(STRUCTURE arm)`. Positive means
structure is hit less often at the same budget. Two-sided one-sample t across
**non-overlapping anchors** (every 20th session).

## Segments — the reserve stays shut

| segment | dates | ~anchors | status |
|---|---|---|---|
| **FIT** | 2016-08-01 … 2020-12-31 | ~51 | opened |
| **CHECK** | 2021-01-01 … 2023-12-31 | ~36 | opened |
| **RESERVED** | 2024-01-01 … 2026-09-01 | ~32 | **SEALED — the script cannot read it** |
| forward reserve | 2026-09-02 onward | — | **permanently reserved** |

## The gate, between the fit and any seal

**Stage 0 (FIT):** |gap| ≥ **2pp** (the same floor EXP-046 fixed) and q < 0.05.
If it fails, the experiment ends — nothing is sealed and the reserve is not
touched.

**Stage 1 (CHECK):** same sign, q < 0.05, and |gap| ≥ 2pp.

Only if both pass does a candidate seal get written and the reserve opened once.
**This script has no flag to open it.**

## The second control axis — today's lesson, applied up front

EXP-045 died because four kill attempts all conditioned on the same variable. So
a registered secondary asks what else a structural distance could be:

A swing low sits **close** when a stock has climbed steadily and **far** after a
drop, so the structural distance is entangled with recent return and with
volatility. The gap is therefore also measured **inside recent-return buckets**
and **inside volatility buckets**, and both are printed **before** the verdict.

If the gap collapses under either, that is the finding.

## Eligibility

As EXP-048/051: ≥ 60 prior sessions, volume > 0 on ≥ 48 of the last 60,
ATR(14) > 0, a complete 20-session forward path, ≥ 100 eligible names per date.
Additionally the structural level must exist and sit **below** the entry; rows
where it does not are dropped and **counted**, because a rule that has no answer
on some fraction of days is a weaker rule and the fraction is part of the result.

## Power

FIT ≈ 51 anchors, CHECK ≈ 36. EXP-046 detected a 2.98pp gap at t 4.05 on 150 US
anchors; a similar effect here would show at t ≈ 2.4, which is marginal. **This
test can find a large difference and not a small one**, and a null will be
reported as "not detectable at this size" rather than as equivalence.

## Known weaknesses

1. **Half the method.** No order flow, as stated above.
2. **A swing low is confirmed with a lag.** `structure()` needs 3 bars each side,
   so the level is at least 3 sessions old. That is inherent to the definition and
   is what a trader would also face, but it means the "current" range low can be
   newer than the level used.
3. **Whole-rupiah ticks** on IDX; eligible median price is around Rp 368, so stop
   crossings are coarse for cheap names. Shared by both arms.
4. **Survivorship** — blow-ups absent, and blowing up is the archetypal
   stop-hitting event. Hit rates understated in both arms.
5. **Gap risk ignored** — stops fill at the stop price.
6. **Matched on median, not per trade.** Individual trades still differ in
   distance; only the budget is equalised in aggregate.

## What a pass would license

A candidate seal with a config hash and a script hash, and one read of the IDX
reserve. Not a production edit. `trade_policy` and `computeTradePlan` are
untouched by this experiment under every outcome.

## What a failure would license

Recording it. A Stage 0 failure says a structural level is no better placed than
a volatility multiple at the same budget, which would close the location question
for IDX and leave the deployed rule as it is.

---

Script: `scraper/research/exp052_idx_structural_stop.js`, committed with this
document and unchanged when run. It cannot read either reserved period.
