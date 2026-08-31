# Pre-registration — buying into a resistance zone

**Written and committed BEFORE the test was run.**

---

## Why this is TWO-SIDED, which is the most important line here

EXP-037 tested the mirror rule and found that buying into a **support** zone
underperformed simply holding by **1.6%** per trade. The natural reading of that
is momentum: price falling into a level kept falling. If that reading is right,
the mirror should also hold — price **rising** into a resistance zone keeps
rising, and buying there should **out**perform.

The conventional reading says the opposite. Resistance is supposed to reject, so
buying into it should be the worst possible entry.

**I have a real prior pointing one way and the textbook pointing the other, so I
cannot claim a direction in good faith.** Registering the textbook direction
would be posturing; registering the momentum direction would be fitting the
hypothesis to a result I have already seen. The test is therefore **two-sided**,
and the power cost is accepted and stated below.

## The hypothesis

**H1.** Buying an IDX stock when its close enters a **resistance zone** — a
volume shelf above the recent price, approached from below, computed from
strictly prior data — and holding 20 sessions produces a return, net of costs,
**different** from what the same stock returned unconditionally over the same
horizon.

**H0.** It does not differ.

**Two-sided.**

## The rule, identical to EXP-037 except for one predicate

Everything is the mirror of the registered support rule, so the two are
comparable by construction:

- **Zones**: prior 500 sessions, refreshed every 20, deployed `zones()` —
  60 log-spaced buckets, top 8, 5% merge cap.
- **Resistance zone**: a zone whose lower bound is **above** the close 20
  sessions before the signal.
- **Entry trigger**: the close rises **into** the zone, having been **below** it
  on the previous close.
- **Fill**: the next session's open.
- **Exit**: the close 20 sessions later. No stop, no target.
- **Costs**: 0.6% round trip.
- **Benchmark**: the ticker's own unconditional 20-session mean over the same
  span — not zero.
- **No overlapping trades** per ticker.
- **Unit of observation**: the ticker. n ≈ 99. **m = 1.**

The only change from EXP-037 is the predicate that selects the zone and the
direction of approach. Nothing else is retuned; retuning anything else would make
the two results incomparable, which is half of what this test is for.

## Power, stated before the result

Two-sided at n ≈ 99 detects about **d = 0.28** at 80% power, slightly worse than
EXP-037's one-sided 0.25. That is the price of not knowing the direction, and it
is the correct price to pay here.

## Decision rule

- **DIFFERENT** if the two-sided p < 0.05.
- **NO DIFFERENCE** otherwise.

The **sign** is then reported as measured, and only the sign that the two-sided
test licenses — no directional claim is made if p ≥ 0.05.

## Secondary, descriptive only, never decisive

1. **The paired support-vs-resistance difference per ticker.** Both rules run the
   same machinery over the same tickers, so this is the cleanest view of whether
   the two sides behave differently at all. It is the number I most expect to be
   quoted and it is still not the decision.
2. Gross figures before the 0.6% cost.
3. Win rate, trade count, excess by zone rank.

## What this would license

If resistance-buying **underperforms**: a long-only avoidance reading — evidence
for not adding into a resistance shelf. That is actionable without shorting, and
it would be registered separately before being acted on.

If resistance-buying **outperforms**: a momentum reading, and a registered
follow-up on breakout continuation. Not a production change either way.

**Nothing here licenses shorting.** Short selling IDX is impractical for this
account, so a negative result is an avoidance signal, not a trade.

## Survivorship

Same banner as EXP-037: `backfill_price_history.js` only ever fetched tickers
present in `idx_broker_summary`, and twelve suspended or delisted names were
removed in July 2026. **Biased upward**, whichever way the result falls.

---

Script: `scraper/research/exp038_resistance_zones.js`, committed with this
document and unchanged when run.
