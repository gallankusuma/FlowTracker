# Pre-registration — currency weakness and forward equity returns

**Written and committed BEFORE the test was run.** Nothing below may be edited
after the result is known; a correction gets a new file that says what it
supersedes. The point of this document is that it exists in git history with a
timestamp earlier than the result it judges.

---

## Why this is being pre-registered rather than searched

EXP-030 screened 80 hypotheses across 20 macro indicators. Nothing survived
Benjamini-Hochberg, and the leaderboard reshuffled completely when the sample was
doubled — the signature of noise. Its holdout has been read twice and is burned.

Continuing to search that window would produce a number and no knowledge. So:
**one hypothesis, chosen on mechanism rather than on rank**, tested on data this
project has never touched.

`USDIDR` was not the strongest row in EXP-030 (train IC −0.131, p=0.19 —
not significant even uncorrected). It is chosen because it is the only candidate
with a reason to be true that does not depend on the data that suggested it: a
weakening local currency raises the cost of imported inputs, drains foreign
portfolio flows, and tightens local financial conditions. Picking the top of a
burned leaderboard is selection; picking a mechanism is a hypothesis.

## The hypothesis

**H1.** In an emerging market, a rise in USD/local over the prior 20 trading
sessions (i.e. the local currency weakening) predicts a **lower** local equity
index return over the following 20 sessions.

Formally: the Spearman rank correlation between `chg20(USD/local)` at anchor *t*
and the local index return from *t* to *t+20* is **negative**.

**H0.** That correlation is zero or positive.

Direction is specified in advance, so the test is **one-sided**.

## The out-of-sample set

Nine markets, none of which this project has ever queried for returns:

| market | index | FX |
|---|---|---|
| India | `^BSESN` | `INR=X` |
| Thailand | `^SET.BK` | `THB=X` |
| Philippines | `PSEI.PS` | `PHP=X` |
| Malaysia | `^KLSE` | `MYR=X` |
| Brazil | `^BVSP` | `BRL=X` |
| Mexico | `^MXX` | `MXN=X` |
| Turkey | `XU100.IS` | `TRY=X` |
| South Africa | `^J203.JO` | `ZAR=X` |
| Korea | `^KS11` | `KRW=X` |

Indonesia (`^JKSE` / `IDR=X`) is **excluded from the test** and reported
separately as the in-sample observation that motivated it. Including it would be
scoring the exam with the answer sheet.

Availability was verified before writing this (2,400–2,600 bars each over ten
years). Availability is not a result.

## Method, fixed now

- **Strictly prior features.** `chg20` at anchor *t* uses closes at *t* and
  *t−20* only.
- **Non-overlapping anchors**, spaced 20 sessions apart on each market's own
  trading calendar. Overlapping windows would inflate significance.
- **Spearman rank IC**, not Pearson: FX series have fat tails.
- **One horizon (20 sessions) and one transform (`chg20`).** No variants. The
  discipline being bought here is that there is nothing to select from.
- **Ten years** of available history per market.
- Anchors requiring an FX and an index close on the same date; dates without
  both are dropped, never carried forward.

## The statistic and the decision rule

**Primary test — Stouffer's combined Z** across the nine markets, one-sided in
the predicted (negative) direction, each market weighted equally.

- **CONFIRMED** if combined one-sided p < 0.05.
- **NOT CONFIRMED** otherwise.

Because this is a single pre-registered hypothesis, m = 1 and no multiplicity
correction applies. That is the entire reason for registering one mechanism
instead of screening eighty.

**Secondary, descriptive only, not decisive:** the count of markets with negative
IC, and the per-market ICs. Reported for interpretation, and explicitly *not*
used to rescue a failed primary test.

## What would falsify it

- Combined one-sided p ≥ 0.05.
- Or a combined Z in the positive direction, whatever its size.

There is no partial credit and no "directionally encouraging". If the test does
not confirm, H1 is not supported and the macro layer stays a display layer.

## What a confirmation would and would not license

It would license **one** thing: opening a registered experiment into whether a
rupiah condition improves the **regime layer** — the component that decides
exposure, not a per-stock score.

It would **not** license changing any production parameter, adding a factor to
the composite, or treating the IHSG result from EXP-030 as validated. A
cross-market mechanism holding does not establish the Indonesian magnitude, and
the Indonesian window remains burned.

---

Script: `scraper/research/macro/exp031_fx_equity.js`, committed alongside this
document and unchanged when run.
