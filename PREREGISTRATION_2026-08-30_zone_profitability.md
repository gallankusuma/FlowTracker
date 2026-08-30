# Pre-registration — is buying at a volume zone profitable?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## This is not implied by EXP-036, and the difference is the point

EXP-036 found that swing pivots land inside volume shelves about **1.4
percentage points** more often than inside bands matched for width and distance
from price. That is a statement about **where price turns**.

A pivot is a turn in **either direction**. A zone that catches more pivots
catches more tops as well as more bottoms. Nothing in EXP-036 says the turn is
upward, and nothing in it says the move afterwards is large enough to pay for
touching it.

And a pivot is not tradeable. It is only identifiable three bars after the fact —
by which time the price that defined it is gone. Any rule that "buys the pivot"
is using information it could not have had.

So this is a separate, much stronger claim, and it is registered separately.

## The hypothesis

**H1.** Buying an IDX stock when its close enters a **support zone** — a volume
shelf below the recent price, computed from strictly prior data — and holding 20
sessions produces a return, **net of costs**, above what the same stock returned
unconditionally over the same horizon in the same period.

**H0.** It does not.

Direction is fixed in advance, so the test is **one-sided**.

## Long only, and why

Short selling on IDX is impractical for the account this project is built for,
and testing long-at-support and short-at-resistance would be two hypotheses. The
existing strategy is `LONG_ONLY` by default. Resistance zones are out of scope
here; that is a restriction, not a claim that they do not work.

## The rule, fully specified now

- **Zones**: recomputed every 20 sessions from the prior 500, using the deployed
  `zones()` — 60 log-spaced buckets, top 8, 5% merge cap. Held between
  recomputations, which is also how a person would use them.
- **Support zone**: a zone whose upper bound is below the close 20 sessions
  before the signal. It has to be a level being approached from above, not one
  price has been sitting inside all along.
- **Entry trigger**: the close falls into a support zone, having been above it on
  the previous close.
- **Fill**: the **next session's open**. Not the signal close — a close-fill uses
  a price that only existed after the information did.
- **Exit**: the close 20 sessions later. No stop and no target.
- **No overlapping trades** per ticker: a new entry is ignored while one is open.

**No stop, on purpose.** A stop needs to know whether the low came before or
after the high inside a session, and daily bars do not record that. Simulating
one would be inventing intrabar path. The cost is that this measures a
hold-through-anything rule, which is stated rather than hidden.

## Costs, fixed before the result

**0.6% round trip** — roughly 0.15% brokerage in, 0.25% plus the 0.1% sales tax
out, and the remainder for spread. Applied to every trade.

This number decides the experiment more than anything else in it. An edge of
0.4% gross is not an edge. Stating it now stops it being tuned later.

## The benchmark, and why not zero

IDX stocks drift, and a rule that returns +0.3% over 20 sessions has produced
nothing if the stock returned +0.3% over every 20 sessions anyway.

**Primary statistic**: for each ticker, the mean of
`(net zone-trade return) − (that ticker's mean 20-session return over the same
span)`. Beating zero on the raw return is not the test.

## The unit of observation

**The ticker.** Trades within one ticker share zones, regime and the stock's own
drift; treating a few thousand of them as independent would overstate
significance the way overlapping windows do — the error EXP-033, EXP-035 and
EXP-036 were all built around. Each ticker gives one number; the test runs across
100 of them. **m = 1.**

## Method

- **Universe**: the same 100 tickers as EXP-036 — ≥ 1,000 sessions, ranked by
  total traded value.
- **Statistic**: mean per-ticker excess, one-sided t across tickers.
- A ticker producing fewer than 3 trades is dropped, and the count of dropped
  tickers is reported.

## Power, stated before the result

n = 100 tickers detects about **d = 0.25** at 80% power. Given that per-ticker
excess returns are noisy, this can only find a fairly consistent edge. A null is
"not detectable at this size", not "absent".

## Decision rule

- **PROFITABLE** if the one-sided p < 0.05 **and** the mean excess is positive
  **after costs**.
- **NOT PROFITABLE** otherwise.

## Secondary, descriptive only, never decisive

1. The same figures **before** costs, so the size of the cost hurdle is visible.
2. The same rule at proximity-matched arbitrary bands — the EXP-036b control,
   here to show whether any edge is about volume or about buying dips generally.
3. Win rate, mean trade, and trade count.
4. Excess by zone rank.

## What would falsify it

One-sided p ≥ 0.05, or a negative mean excess after costs. **A gross edge smaller
than 0.6% is a failure**, and will be reported as one rather than as "close".

## Survivorship

`backfill_price_history.js` only ever fetched tickers present in
`idx_broker_summary`, and twelve names judged suspended or delisted were removed
in July 2026 — exactly the ones that would have blown up. No as-of predicate can
restore a row that was never written. **This result is survivorship-biased
upward** and carries that banner regardless of outcome.

## What a positive result would license

One thing: a registered forward paper-trading run under the existing virtual
broker, on the frozen rule. Not a production parameter, not a factor, not capital.

## What a negative result would license

Saying so on the page. The zone table would stay as a description of where
transactions happened, with the profitability question answered rather than open.

---

Script: `scraper/research/exp037_zone_profitability.js`, committed with this
document and unchanged when run.
