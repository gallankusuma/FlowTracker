# Pre-registration — US inflation expectations and emerging-market equities

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.
The value of this document is that git timestamps it earlier than the number it
judges.

---

## Where the candidate came from

EXP-032 screened 68 hypotheses across 17 FRED series against forward IHSG
returns. Nothing survived Benjamini-Hochberg. Two rows were nonetheless coherent:

| series | H | IC train (n=102) | p | IC holdout (n=18) |
|---|---|---|---|---|
| `INFL_EXP_5Y` chg20 | 20 | −0.240 | 0.0149 | **−0.335** |
| `INFL_EXP_10Y` chg20 | 20 | −0.218 | 0.0277 | **−0.320** |

Same sign out of sample, and *stronger* there — the opposite of the decay that
killed EXP-011. The mechanism is not invented after the fact: higher expected US
inflation implies a tighter Fed, a firmer dollar, and capital leaving emerging
markets.

It is still not a finding. q = 0.51 and 0.63, the holdout holds 18 points, and
the two series are near-duplicates of one measure — their agreement is close to a
single observation, not corroboration.

## The hypothesis

**H1.** A rise in US 5-year breakeven inflation over the prior 20 trading
sessions predicts a **lower** forward 20-session return on emerging-market
equities.

**H0.** That relationship is zero or positive.

Direction is fixed in advance, so the test is **one-sided**.

## The design problem this must avoid, and how

EXP-031 tested a **local** mechanism — each market had its own currency, so nine
markets were nine genuinely independent tests, and Stouffer's combination was
legitimate.

**This predictor is global.** One US series against many correlated EM markets is
**not** N independent tests: the markets co-move, and the predictor is identical
across them. Combining per-market z-scores would overstate significance badly —
the same error as counting overlapping windows as independent observations.

So the unit of observation is the **anchor date**, not the market-date pair. The
six markets are averaged into one equal-weighted basket and a single IC is
computed against it. `n` comes from the number of non-overlapping anchors
(≈120), not from multiplying by market count.

## The out-of-sample set

Six **USD-denominated** country ETFs, none of which this project has ever
queried:

| market | ticker |
|---|---|
| Vietnam | `VNM` |
| Colombia | `GXG` |
| Peru | `EPU` |
| Saudi Arabia | `KSA` |
| Chile | `ECH` |
| Poland | `EPOL` |

Availability was verified before writing this (2,488–2,513 bars over ten years).
Availability is not a result.

**Deliberately excluded, with reasons:**

- **The nine EXP-031 markets** (India, Thailand, Philippines, Malaysia, Brazil,
  Mexico, Turkey, South Africa, Korea). Their return series have already been
  read once. The hypothesis is different, so the risk is small — but "already
  read" is a fact worth respecting rather than explaining away.
- **Indonesia.** It is the in-sample market the candidate came from.
- **Argentina (`^MERV`).** Nominal peso returns under triple-digit inflation
  measure currency collapse, not equity performance.
- **Taiwan (`^TWII`).** Local currency; mixing it with USD ETFs would make the
  basket inhomogeneous.

USD denomination is chosen on purpose: it is the return a global allocator
actually experiences, and it removes local-currency noise that would otherwise
compete with the very mechanism under test.

## Method, fixed now

- **Predictor**: `INFL_EXP_5Y` (FRED `T5YIE`) from `ft_macro_data`, `chg20` — the
  20-session change of the last **published** value, carrying the same 1-day
  publication lag EXP-032 used. Strictly prior.
- **Target**: equal-weighted mean of the six ETFs' forward 20-session returns.
- **Anchors**: non-overlapping, 20 sessions apart, on the shared trading calendar
  of the six ETFs. Dates where any ETF lacks a close are dropped, never carried
  forward.
- **Statistic**: Spearman rank IC, one-sided toward negative, Fisher-z p-value.
- **Window**: ten years of available history.
- **One transform, one horizon, one basket. m = 1**, so no multiplicity
  correction applies — that is the entire reason for registering one mechanism
  rather than screening.

## Decision rule

- **CONFIRMED** if the one-sided p < 0.05 **and** the IC is negative.
- **NOT CONFIRMED** otherwise.

**Secondary, descriptive only, never decisive:** the per-market ICs and the count
of markets with a negative IC. These are for interpretation. They will not be
used to rescue a failed primary test, and a "5 of 6 negative" will not be
reported as though it were the result.

## What would falsify it

One-sided p ≥ 0.05, or a positive IC of any size. No partial credit, no
"directionally encouraging".

## What a confirmation would license

Exactly one thing: a registered experiment into whether a US-inflation-expectation
condition improves the **regime layer** — the component that sets exposure.

It would **not** license changing any production parameter, adding a factor to
the composite, or treating EXP-032's Indonesian result as validated. A mechanism
holding across a basket does not establish the Indonesian magnitude, and that
window is burned.

---

Scripts: `scraper/research/macro/exp033_fetch.py` and
`exp033_inflexp_em.js`, committed with this document and unchanged when run.
