# Pre-registration — does the CPI-surprise effect exist outside Indonesia?

**Written and committed BEFORE the test was run.** Nothing here may be edited
once the result is known; a correction gets a new file naming what it supersedes.
The value of this document is that git timestamps it earlier than the number it
judges.

---

## What this is checking, and why it is the right next step

EXP-034 confirmed its pre-registered rule: a US core CPI month-on-month print
above consensus preceded a **lower** IHSG return in the next Jakarta session.
Rank IC **−0.1658**, one-sided p **0.0358**, n **119**.

It cleared narrowly. The registered power floor was |IC| ≥ 0.152 and the measured
effect was barely above it; 41 of 119 prints came in exactly at consensus, so
only 78 observations carried information; and the decile spread rested on eight
observations a side. A single one-sided test at p = 0.036 is one result, not an
edge.

**EXP-031 established what to do about that, and it is the most useful method
this project has.** Waiting for fresh Indonesian data needs a decade to double
n. Moving *across markets* costs nothing and answers the sharper question: an
effect that exists only where it was discovered was never there. That is exactly
how the USDIDR hint from EXP-030 was falsified.

## The hypothesis

**H1.** A US core CPI month-on-month print **above** consensus predicts a
**lower** return on a basket of Asian equity indices in the first session each
trades after the release.

**H0.** That relationship is zero or positive.

Direction is fixed in advance — the same mechanism EXP-034 registered, that a
hawkish US inflation print reprices rates overnight and carries into the Asian
open — so the test is **one-sided**.

## The design problem, and how it is handled

This is the EXP-033 problem, not the EXP-031 one, and the difference decides the
statistic.

EXP-031 combined nine markets with Stouffer legitimately, because each had its
**own currency** and so each was an independent test of a *local* mechanism.

**This predictor is global.** One US release against several co-moving Asian
markets is **not** N independent tests: they move together and the predictor is
identical across them. Combining per-market z-scores would overstate significance
for exactly the reason overlapping windows do.

So the unit of observation is the **release date**. The markets are averaged into
one equal-weighted basket and a **single** IC is computed. `n` is the number of
CPI releases, never the release count times the market count. **m = 1.**

Averaging is not only a correction for dependence — it is also what gives the
test its power. Idiosyncratic local noise cancels while a common reaction does
not, so if the mechanism is real the basket IC should be *larger* than any single
market's, not the average of them.

## The out-of-sample set

Chosen by an explicit rule, fixed before the data was fetched: **every major
Asian index with at least 2,400 sessions in the window that this project has
never read.**

| market | ticker |
|---|---|
| Taiwan | `^TWII` |
| Singapore | `^STI` |
| Hong Kong | `^HSI` |
| Shanghai | `000001.SS` |
| Japan | `^N225` |

The rule is what matters. It excludes India, Thailand, Malaysia, the Philippines
and South Korea — all spent by EXP-031 — and it prevents the set from being
assembled by looking for a helpful one. Availability was checked before this
document was written (2,462–2,545 bars each); **availability is not a result.**

**Asian on purpose.** Core CPI is released at 08:30 US Eastern, which is evening
across Asia. Every market here has already closed, so its next session opens with
the information — the same structure as the Jakarta test, and the reason European
markets are excluded: they are *open* when the release lands and would be testing
a different thing.

**Local currency on purpose.** EXP-034 measured IHSG in rupiah, so a replication
must measure local indices in local currency. Converting to dollars would add the
dollar's own reaction to a hawkish print and test a different claim.

**Two of these are developed markets** (Japan, Singapore; Hong Kong by most
classifications). That is a deliberate consequence of the rule rather than an
oversight. It broadens the mechanism under test from "emerging-market outflows"
to "the overnight US repricing carries into the next Asian session", which is the
claim the data can actually address. It is noted here so that a result cannot
later be described as narrower or broader than what was tested.

## Method, fixed now

- **Predictor**: the identical series EXP-034 used — US `Core CPI`,
  `measure = 'MOM'`, `surprise = actual − consensus`, from `ft_econ_calendar`,
  after the same FRED-anchored MoM/YoY resolution and the same five-duplicate
  deduplication. No re-derivation.
- **Target**: for each market, the close-to-close return from its last session on
  or before the release date to its next session. Equal-weighted mean across the
  markets available for that release.
- **Holidays**: a market whose next session is more than 5 calendar days after
  the release is dropped for that release, never carried forward. A release with
  fewer than 3 of the 5 markets available is dropped entirely.
- **Window**: 2016-08-01 .. 2026-08-20, as EXP-034.
- **Statistic**: Spearman rank IC, one-sided toward negative, Fisher-z.
- **In-line prints are KEPT**, as in EXP-034 — they are real observations of "no
  surprise", and dropping them would select on the outcome.
- **One predictor, one horizon, one basket. m = 1.**

## Power, stated before the result

At n ≈ 119 releases this detects **|IC| ≥ 0.152** one-sided, the same floor as
EXP-034.

**So a failure to replicate would be weak evidence, and that is said now rather
than afterwards.** If the true basket effect equalled EXP-034's −0.166, this test
would clear 0.05 only about half the time. A null therefore does not falsify
EXP-034; it would mean the effect is not large enough to show twice at this
sample size. Only a **positive** basket IC — a drift the wrong way, as EXP-031
found for USDIDR — would be real counter-evidence.

## Decision rule

- **REPLICATED** if the one-sided p < 0.05 **and** the basket IC is negative.
- **NOT REPLICATED** otherwise.

**Secondary, descriptive only, never decisive:** the per-market ICs and the count
of markets with a negative IC. These are for interpretation. They will not be
used to rescue a failed primary, and "4 of 5 negative" will not be reported as
though it were the result.

## What would falsify EXP-034

A **positive** basket IC. That is the EXP-031 signature: an effect present only
in the market it was found in, with the others drifting the other way.

A null with a negative IC falsifies nothing and confirms nothing; it will be
reported as the underpowered result it would be.

## What a replication would license

One registered experiment into whether a US-inflation-surprise condition improves
the **regime layer** — the same thing EXP-034 licensed, now with grounds to
actually spend the effort on it.

It would **not** license a production parameter change, a new composite factor,
or trading the event. The move is already in the overnight US market before any
of these exchanges opens.

---

Scripts: `scraper/research/macro/exp035_fetch.py` and `exp035_cpi_asia.js`,
committed with this document and unchanged when run.
