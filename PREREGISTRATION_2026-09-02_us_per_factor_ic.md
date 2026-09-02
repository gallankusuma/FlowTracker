# Pre-registration — which US factors carry anything, one at a time

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.

---

## Why this and not another weighting test

EXP-042 and EXP-043 both asked how to weight the factors. EXP-043 answered
something more useful than its own hypothesis: **the US composite does not rank,
and after 2019 it ranks backwards** — at 40 days, +0.0169 in 2007–2018 and
−0.0393 in 2019–2026, under *every* weighting scheme tried. When every
reallocation of a set of factors fails the same way, the problem is not the
allocation. It is the set.

So this stops asking how to combine them and asks the prior question: **does any
individual factor carry anything at all?**

Nobody has measured that on US. The nine columns have been scored, weighted,
displayed and traded against without a single one being tested on its own.

## The hypothesis

**H1.** For a given factor, its cross-sectional rank IC against forward return is
different from zero.

**H0.** It is not.

**Two-sided, and this matters more here than anywhere.** Every factor is built so
that a higher score means more bullish, so a positive IC means the factor works
as designed and a negative one means it is **inverted**. EXP-016 already found
exactly that for IDX broker accumulation. Fixing a direction in advance would
make an inversion unreportable, which is the opposite of what this is for.

## The factors, and the family

All nine stored columns: **F3, F4, F5, F9, F10, F11, F12, F13, F14**.

F14 is a risk modifier in production, not a directional vote. It is tested
anyway and it is **inside** the family rather than carved out as a descriptive
extra — a carve-out is how a number escapes its own correction and later gets
quoted as a finding. If F14 shows directional information that is a result about
the risk modifier, and it costs the other eight almost nothing in power to learn
it honestly.

**m = 9**, Benjamini-Hochberg, q < 0.05, applied **within each segment
separately**, at the **primary horizon only**.

## The three segments — and the project's first sealed holdout

| segment | dates | ~sessions | 20d anchors | status |
|---|---|---|---|---|
| **DISCOVERY (S1)** | 2007-02-28 … 2018-12-31 | 2,982 | ~149 | opened |
| **VALIDATION (S2)** | 2019-01-01 … 2023-12-31 | ~1,258 | ~62 | opened |
| **HOLDOUT (S3)** | 2024-01-01 … 2026-09-01 | ~670 | ~33 | **SEALED — not opened by this experiment** |

Two things are being paid for here, and both are stated rather than hidden.

**First, an honest disclosure.** EXP-043 already opened 2019-01-01 onward. This
experiment opens part of that same span again, so the validation segment is
**not virgin** — each look at a period costs some of its evidential value, and
this is the second look. It is still chronological, still frozen before the run,
and still a genuine out-of-sample test of a hypothesis EXP-043 did not ask. But
it is not what a first look would have been worth.

**Second, the fix.** The Promotion Contract has recorded since it was frozen that
**nothing has ever reached S3**, and the reason is that no period was ever
reserved. 2024-01-01 onward is reserved now. This experiment does not read it,
does not report it, and does not compute anything from it. Sealing it costs
validation power — 62 anchors instead of 96 — and that price is paid
deliberately, before knowing whether anything would have passed.

Opening it later to compare candidates, or reopening it after a change, **burns
it**, per Promotion Contract v1 S3.

## Statistic and unit of observation

**One value per session.** Per date, per factor: rank IC (Spearman) of the stored
factor value against forward return across that date's cross-section. A date is
used only if at least **30** tickers have a resolved outcome.

Per factor, per segment: the mean IC across **non-overlapping anchors** on the
session index, a two-sided one-sample t against zero, and a 95% CI. Anchors are
every 20th usable session, so no two share a return window.

## Horizon

**Primary: `return_20d`** — about four weeks, the middle of this project's stated
2-to-8-week position holding.

**Secondary, reported but never decisive: `return_10d` and `return_40d`.** They
exist to show whether a factor's behaviour is horizon-specific. EXP-043 is the
reason they cannot be decisive: its only significant cell sat in a secondary
horizon and did not replicate. A factor that passes at 10d and fails at 20d has
**not** passed.

## The economic floor, fixed now

**|IC| >= 0.02.** With 149 anchors, an IC of 0.006 can be statistically
distinguishable from zero and still be worthless. This is the same floor EXP-041
used, chosen there before its run and kept here rather than re-picked.

Statistical significance without the floor is reported as **"real but
negligible"**, never as a carrier.

## Stability screen, fixed now

Within **DISCOVERY only**, split the anchors into **four equal chronological
blocks** and record the sign of the mean IC in each. A factor passes the screen
if its sign agrees with its full-discovery sign in **at least 3 of 4 blocks**.

This is a robustness screen, **not a significance test**, and it is not
independent of the overall mean — it is here because it was the single most
informative thing EXP-043 produced. That run's headline contrast alternated
+0.0220 / −0.0053 / +0.0147 / −0.0110 across four blocks and was carried entirely
by 2007–2011; the discovery/validation split alone had hidden it.

## Decision rule, per factor

**CARRIER** requires all four:

1. DISCOVERY `|IC| >= 0.02`
2. DISCOVERY BH `q < 0.05` within the m = 9 family
3. Stability screen passed (>= 3 of 4 discovery blocks agree in sign)
4. VALIDATION: **same sign** and BH `q < 0.05` within the validation family.
   Per Promotion Contract v1 S2 the effect may shrink; it may not vanish or
   invert.

**INVERTED CARRIER** if all four hold with a **negative** IC. This is a real
finding and is reported as one — but it **licenses nothing**. Flipping a factor's
sign because the data showed the sign is fitting, and would need its own
registered test on data this one has not touched.

**REAL BUT NEGLIGIBLE** if 2, 3 and 4 hold but `|IC| < 0.02`.

**NOT A CARRIER** otherwise, including every case where discovery passes and
validation does not. Non-replication is the expected outcome and will be
reported plainly.

## Power, stated before the result

Discovery n = 149 anchors detects about **d = 0.23** at 80% power before the BH
correction, and less after it; validation n = 62 detects about **d = 0.36**. The
IC translation depends on the per-date IC standard deviation, which is not known
in advance and **will be reported alongside every estimate** so the reader can
judge what the test could and could not have seen.

Validation is the weaker half by construction — that is the cost of sealing the
holdout, and it means a discovery pass that fails validation is genuinely
ambiguous between "not real" and "not powered". Both readings will be given.

## Secondary, descriptive only, never decisive

1. The same table at 10d and 40d.
2. Per-factor IC in each of the four discovery blocks, printed in full.
3. The cross-factor correlation matrix, so a reader can see that a set of
   "independent carriers" may be one carrier with five names — the finding
   EXP-040 and EXP-043 both turned on.

## Known weaknesses

1. **SURVIVORSHIP.** `modules/us_tickers.js` is a present-day S&P 500 snapshot
   and Yahoo does not serve delisted symbols; 11 of 418 could not be fetched at
   all. Scoring 2008 across the banks that *survived* 2008 is close to a
   definition of the bias. **Every number this produces is biased upward.**
2. **Validation is a second look**, as stated above.
3. **Nine tests on one dataset.** BH controls the false-discovery rate, not the
   family-wise error; roughly one in twenty surviving results is expected to be
   spurious, and with nine tests that is a real possibility rather than a
   formality.
4. **This is evidence about US only.** IDX has a different factor set, different
   weights and a different cluster structure.
5. **Rank IC is not profit.** It measures ordering, not tradability, and says
   nothing about the 0.50% round-trip cost this project applies elsewhere. A
   carrier found here would still have to survive a cost-bearing test.

## What a positive result would license

A registered follow-up on the surviving factors — not a weight change, not a
production edit, and **not** an S3 read. The sealed period stays sealed until
something has actually passed S2 with a frozen definition and policy.

## What a null would license

Recording it. A clean null across nine factors on 4,909 sessions would say the
US factor set carries no usable cross-sectional information, which is a
substantive answer and the most likely one given EXP-043.

---

Script: `scraper/research/exp044_us_per_factor_ic.js`, committed with this
document and unchanged when run.
