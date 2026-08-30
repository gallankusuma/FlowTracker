# Pre-registration — do price levels respect volume shelves?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.
The value of this document is that git timestamps it earlier than the number it
judges.

---

## What is on trial

`scraper/deep_analysis.js` reports "zones" — bands of price where the most volume
changed hands — and prints how many times price turned in each. The report is
already deployed and its `NOT COVERED` block says plainly that this has never
been tested. This is that test.

The comparison that matters is not "do pivots land in zones" — of course some do.
It is **whether they land there more than an arbitrary band would collect**. A
scoping look on ADMR already killed Fibonacci retracements on exactly this basis:
Fib levels caught 5.80 pivots on average against 5.15 for any level in the range,
and 36% of arbitrary levels did as well or better. The volume zones get the same
question and the same control.

## THE TRAP THIS DESIGN EXISTS TO AVOID

A volume shelf is high-volume **because price spent time there**, and price spent
time there **because it kept turning there**. Counting the turns that *created*
the shelf and calling them evidence that the shelf works is circular — and it
would produce a large, clean, entirely fake result.

So every zone is computed from data **strictly before** the period it is judged
on. Zones from the 500 sessions ending at `t`; pivots counted in `(t, t+60]`. No
bar contributes to both sides.

This is the single most important line in this document. A version of this test
without it would confirm the hypothesis every time.

## The hypothesis

**H1.** Swing pivots in the next 60 sessions land inside the top volume shelves
of the prior 500 sessions **more often** than inside an equal number of equally
wide bands drawn from the same visited price range.

**H0.** They land there no more often.

Direction is fixed in advance, so the test is **one-sided**.

## The control, and why this one

Not "random levels anywhere". Real zones sit near where price has been, and
future pivots also sit near where price has been, so a control placed anywhere in
the full range would be far from the action and would bias toward confirming.

**The control draws K buckets at random from the buckets price ACTUALLY VISITED
in the prior window** — same count, same width, same visited region. The only
thing that differs is whether the bucket was chosen for its volume.

Random draws use a seeded generator so the run is reproducible; the seed is fixed
in the script before it is run.

## The unit of observation

**The ticker, not the (ticker, date) pair.**

As-of dates 60 sessions apart still share most of their 500-session zone window,
so their observations are heavily dependent. Treating 3,000 of them as
independent would overstate significance the same way overlapping return windows
do — the error EXP-033 and EXP-035 were designed around.

So each ticker yields ONE number: the mean of (real hit rate − control hit rate)
across its as-of dates. The test runs across tickers. **m = 1.**

## Method, fixed now

- **Universe**: tickers with ≥ 1,000 sessions in `idx_stock_prices`, ranked by
  total traded value over the whole history, top 100.
- **Window**: as-of dates every 60 sessions, starting once 500 sessions of prior
  history exist, through the last date allowing a full 60-session forward window.
- **Zones**: `zones()` from `deep_analysis.js` as deployed — 60 log-spaced
  buckets, top 8 after the 5% merge cap.
- **Pivots**: `pivots(bars, 3)` on the forward window, as deployed.
- **Hit**: a pivot whose price falls inside a zone's range.
- **Hit rate**: hits ÷ total pivots in the forward window. An as-of date with no
  forward pivots is dropped.
- **Control**: 50 draws of K visited buckets, merged by the same rule; the
  control hit rate is the mean across draws.
- **Statistic**: mean paired difference across the 100 tickers, one-sided
  t-statistic. A sign test across tickers is reported alongside as a robustness
  check and is **not** the decision.

## Power, stated before the result

At n = 100 tickers a one-sided t-test detects a standardised effect of about
**d = 0.25** at 80% power. In plain terms: if zones capture pivots only a couple
of percentage points better than arbitrary bands, and tickers vary, this will
miss it. A null is "not detectable at this size", not "absent".

## Decision rule

- **CONFIRMED** if the one-sided p < 0.05 **and** the mean difference is positive.
- **NOT CONFIRMED** otherwise.

## Secondary, descriptive only, never decisive

1. The same test restricted to zones with **turns > 0** in the prior window. The
   report claims that column separates a level price respected from one it passed
   through; this is the check, but it is a second hypothesis and will not be used
   to rescue a failed primary.
2. Hit rate by zone rank (does the biggest shelf do better than the eighth?).
3. The median per-ticker difference alongside the mean.

## What would falsify it

One-sided p ≥ 0.05, or a negative mean difference. No partial credit, no
"directionally encouraging".

## What a confirmation would license

The zone table stays in the report and moves **out** of its `NOT COVERED` block,
with the measured effect size printed next to it.

It would **not** license a trading rule, a factor, or any production parameter.
"Pivots land here more than chance" is a statement about where price turns, not
about whether acting on it makes money — and this project has an experiment
(EXP-016) where the obvious action on a real relationship was the wrong sign.

## What a failure would license

Removing the zone table from the report, or keeping it explicitly labelled as a
description of past transactions with no forward content. Either is honest; a
zone table presented as actionable after failing this test is not.

---

Script: `scraper/research/exp036_volume_zones.js`, committed with this document
and unchanged when run.
