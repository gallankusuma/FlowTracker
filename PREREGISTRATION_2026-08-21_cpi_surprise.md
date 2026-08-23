# Pre-registration — US Core CPI surprise and the next IHSG session

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.
The value of this document is that git timestamps it earlier than the number it
judges.

---

## Why this is worth one test

Four macro families have now been tested here and none survived correction:
EXP-030 (20 Yahoo indicators), EXP-031 (FX across nine markets), EXP-032 (17 FRED
series), EXP-033 (US inflation expectations across an EM basket). That record is
the reason this is *one* hypothesis and not a screen.

What is new is not another indicator. It is **`consensus`** — what the market
expected. Every previous test used realised levels or changes, which is a
statement about the world; a surprise is a statement about what was *not already
priced*. A 0.3% core CPI print is bullish or bearish depending entirely on
whether 0.2% or 0.4% was expected, and the level cannot tell you which.

## The hypothesis

**H1.** A US core CPI month-on-month print **above** consensus predicts a
**lower** IHSG return in the first Jakarta session after the release.

**H0.** That relationship is zero or positive.

Direction is fixed in advance — higher-than-expected inflation implies a tighter
Fed, a firmer dollar and outflows from emerging markets — so the test is
**one-sided**.

## The predictor

`surprise = actual − consensus`, in percentage points, for
`country = 'United States'`, `event_name = 'Core CPI'`, `measure = 'MOM'`.

**Core rather than headline**, fixed now: it excludes food and energy, so it is
the print that moves rate expectations rather than the one that moves with oil.
Headline is a secondary below and is not decisive.

**Month-on-month rather than year-on-year**, fixed now: the surprise in a monthly
change is the new information; the annual rate mostly restates twelve months
already known.

### Two data corrections this depends on, both made before any return was joined

**`measure` is resolved against FRED, not taken from row order.** A CPI release
puts several rows on the calendar at the same timestamp under the same name, and
`seq` — their position in that group — is **not** a label: measured against
CPIAUCSL, using it would mislabel **50 of 247 rows (20.2%)**, silently averaging
month-on-month and year-on-year into one column. Each row is instead matched to
the nearer of the expected MoM and YoY computed from the FRED index, with the
assignment required to be a bijection. One release (CPI 2020-07-14) is genuinely
ambiguous — MoM 0.48 and YoY 0.72 both round to the printed 0.6 — and is left
unlabelled rather than guessed.

**Five duplicate releases are deduplicated, keeping the LATER.** The feed
occasionally lists the same release under two consecutive dates with identical
actual and consensus: 2017-09-13/14, 2017-10-12/13, 2020-02-12/13, 2021-05-11/12,
2021-11-09/10. The later of each pair is the real one, corroborated internally
rather than from memory — on the later date the weekday-fixed companions line up
(MBA Mortgage Applications on a Wednesday, Initial Jobless Claims on a Thursday),
and it is the date consistent with the filing convention that the other ~119
releases follow.

## The target

IHSG close-to-close, from the **last session on or before the release date** to
the **first session after it**.

The timing is the point. Core CPI is released at 08:30 US Eastern, which is 20:30
in Jakarta — **after the IDX close**. The release-day close therefore genuinely
precedes the information, and the first tradeable reaction is the next session.
Getting this backwards would measure a return that happened before the news, and
it is why the feed's one-day filing offset had to be corrected first.

If either session is missing from `idx_ihsg_history`, the release is dropped, not
carried forward.

## Method, fixed now

- **Window**: 2016-08-01 .. 2026-08-20, the same span as EXP-030 and EXP-032.
- **Sample**: every resolved Core CPI MoM release with both `actual` and
  `consensus` present. Expected n ≈ 119 after deduplication.
- **In-line prints are KEPT.** 43 of 124 releases came in exactly at consensus, a
  surprise of 0.0. Those are real observations of "no surprise", not missing
  data, and dropping them would select on the outcome. Spearman handles the ties.
- **Statistic**: Spearman rank IC of surprise against the forward one-session
  return, one-sided toward negative, Fisher-z p-value.
- **One event, one transform, one horizon, one target. m = 1**, so no
  multiplicity correction applies — that is the entire reason for registering one
  mechanism instead of screening.

## Power, stated before the result

At n ≈ 119 this design detects **|IC| ≥ 0.18** at one-sided p < 0.05.

That is a real limitation and it is written here so it cannot be produced
afterwards as an excuse. Every macro effect this project has measured has an |IC|
below 0.25, and several below 0.15 — so a true effect of ordinary size **would be
missed by this test**. A null result therefore means "not detectable at this
size", not "absent".

## Decision rule

- **CONFIRMED** if the one-sided p < 0.05 **and** the IC is negative.
- **NOT CONFIRMED** otherwise.

**Secondary, descriptive only, never decisive:** headline `CPI` MoM instead of
core; a five-session horizon instead of one; and the mean forward return of the
largest-surprise decile. These are for interpretation. They will not be used to
rescue a failed primary, and none of them will be reported as though it were the
result.

## What would falsify it

One-sided p ≥ 0.05, or a positive IC of any size. No partial credit, no
"directionally encouraging".

## What a confirmation would license

Exactly one thing: a registered experiment into whether a US-inflation-surprise
condition improves the **regime layer** — the component that sets exposure.

It would **not** license changing any production parameter, adding a factor to
the composite, or trading the event itself. IDX opens the next morning with the
move already in the overnight US market; an IC on the next session's close is
evidence about a mechanism, not about a fill anyone could get.

## What has and has not been looked at

The calendar has never been joined to any return series. Individual prints were
read while building the fetcher — the 2026-08 CPI, the five duplicate pairs, the
largest surprises — so the predictor column is not unseen. **No forward return
has been computed against any of it**, which is the sample this test spends.

---

Scripts: `scraper/research/macro/exp034_cpi_surprise.js`, committed with this
document and unchanged when run.
