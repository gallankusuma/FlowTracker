# Backtest Experiment Registry

Permanent record of every backtest run against real historical data, per `Advance.md` §6 (Experiment Registry). **Entries are appended, never edited or overwritten** — if a result turns out to be wrong or superseded, a new entry corrects it and says so; the old entry stays as-is so the history of what was tried and found stays intact.

This project has no git, so there is no code-commit-hash field to record — scripts are noted by filename, and the exact logic is what's described in each entry below (the underlying formula/model version, `AWO_MODEL_VERSION`, is recorded where relevant).

---

## EXP-2026-07-29-001 — Baseline Comparison (ATR/SR-based exit)

- **Script**: `scraper/backtest_baseline_comparison.js`
- **Model/formula version**: `AWO_MODEL_VERSION = 3.3-awo`
- **Market universe**: IDX, 145 tickers with ≥260 days of price history in `idx_stock_prices`
- **Period tested**: 2025-12-01 to 2026-07-28 (per-ticker window: last ~160 trading days before each ticker's latest available date)
- **Direction**: Long only
- **Execution assumption**: Entry at T+1 open; same-bar stop/target ambiguity resolves to STOP (conservative)
- **Exit rule**: Stop-loss and target from `computeTradePlan` (ATR-based risk unit, snapped to nearest support/resistance if one sits in a sane band), max holding 15 trading days, else TIME_EXIT at close
- **Transaction cost**: 0.15% buy fee + 0.25% sell fee + 0.10% assumed slippage = 0.50% round-trip — **labeled assumption (typical IDX retail order of magnitude), not this user's confirmed real broker fee schedule**
- **Compared**: AWO Full (F), AWO Technical-Only/no broker factors (E), EMA9/21 golden-cross (C), Random Entry seeded/count-reference (D), Buy & Hold (A), IHSG (B)

**Result:**

| Strategy | n | Win Rate | Expectancy | Profit Factor | Net return/trade |
|---|---|---|---|---|---|
| AWO Full | 156 | 23.1% | **-0.529R** | **0.27** | -4.96% |
| AWO Technical-Only | 1009 | 27.5% | -0.288R | 0.54 | -3.02% |
| EMA9/21 Crossover | 495 | 32.5% | -0.217R | 0.62 | -2.03% |
| Random Entry | 2316 | 32.3% | -0.232R | 0.62 | -1.71% |
| Buy & Hold (passive) | — | — | — | — | -19.59% avg |
| IHSG (passive) | — | — | — | — | -13.49% |

**Finding**: AWO Full is the worst performer of the four signal-based strategies — worse than a dumb EMA crossover, worse than pure random entry, worse than AWO with broker factors removed entirely. All four lost money, but the whole test window was a bad one to be long IDX in (Buy & Hold -19.6%, IHSG -13.5%), so absolute loss isn't the alarming part — AWO Full losing meaningfully *more* than doing nothing smart at all is.

**Caveats**: (1) the `maxDD` column this script also prints is not comparable across strategies with very different trade counts (raw summed-R, not normalized) — not included above for that reason; (2) single ~7.5-month window — Advance.md's own Gate Stability explicitly warns against generalizing from one period; (3) not yet checked for a replay/implementation bug, though it reuses the same tested, production functions (`weightedComposite`, `combineFinalScore`, `computeTradePlan`).

**Status**: PRELIMINARY — real result, not yet replicated across a second time window.

---

## EXP-2026-07-29-002 — Baseline Comparison (fixed 2% stop / 10% target, unlimited hold)

- **Script**: `scraper/backtest_baseline_comparison.js` (same file, modified same day: exit rule swapped from ATR/SR to fixed %, holding-period cap removed)
- **Model/formula version**: `AWO_MODEL_VERSION = 3.3-awo`
- **Market universe / period / direction / execution / cost**: same as EXP-001
- **Exit rule**: Fixed stop-loss = entry × 0.98 (2% below), fixed target = entry × 1.10 (10% above), **no holding-period cap** — walks forward until stop/target hit or the ticker's data runs out (unresolved trades at data-end are excluded from win-rate/expectancy, reported as an open-position count instead)

**Result:**

| Strategy | n (resolved) | Win Rate | Expectancy | Profit Factor | Avg Hold | Still open at data-end |
|---|---|---|---|---|---|---|
| AWO Full | 180 | 5.6% | **-0.988R** | **0.21** | 2.3d | 8 |
| AWO Technical-Only | 1001 | 9.4% | -0.759R | 0.37 | 2.5d | 12 |
| EMA9/21 Crossover | 515 | 11.8% | -0.613R | 0.47 | 3.6d | 25 |
| Random Entry | 2221 | 13.4% | -0.522R | 0.54 | 4.1d | 79 |
| Buy & Hold (passive) | — | — | — | — | — | -16.37% avg |
| IHSG (passive) | — | — | — | — | — | -13.49% |

**Finding**: Win rates crash across the board vs. EXP-001 (2% stop is tight relative to IDX daily volatility — mechanical, expected, applies equally to every strategy tested). The *relative* ranking not only holds but widens: AWO Full's expectancy (-0.988R) is nearly double Random Entry's (-0.522R). Since every strategy uses the identical exit rule here, the "stop too tight" effect can't explain away AWO Full's underperformance — it's a fair, apples-to-apples comparison and AWO Full is still worst.

**Status**: PRELIMINARY — replicates EXP-001's qualitative finding (AWO Full < Technical-Only < EMA/Random) under a completely different exit-rule configuration, which is a real robustness check across *rule design*, but still the same single time window.

---

## EXP-2026-07-29-003 — Stop-Loss × Holding-Time Parameter Sweep (TP fixed 10%)

- **Script**: `scraper/backtest_param_sweep.js`
- **Model/formula version**: `AWO_MODEL_VERSION = 3.3-awo`
- **Market universe / period / direction / execution / cost**: same as EXP-001/002
- **Free variables**: Stop Loss % ∈ {1, 1.5, 2, 2.5, 3, 4, 5, 6, 8}, Max Holding Days ∈ {5, 10, 15, 20, 30, 45, 60} — 63 combinations
- **Fixed variable**: Take Profit = 10%
- **Signals tested**: AWO Full (188 BUY signals, same 188 entries replayed at every grid cell), Random Entry (2300 signals, same reference role as EXP-001/002)

**Result — AWO Full expectancy (R), full grid:**

| Stop\Hold | 5d | 10d | 15d | 20d | 30d | 45d | 60d |
|---|---|---|---|---|---|---|---|
| 1% | -1.40 | -1.44 | -1.45 | -1.45 | -1.45 | -1.45 | -1.45 |
| 1.5% | -1.05 | -1.08 | -1.10 | -1.10 | -1.10 | -1.10 | -1.10 |
| 2% | -0.89 | -0.90 | -0.90 | -0.88 | -0.91 | -0.91 | -0.91 |
| 2.5% | -0.79 | -0.80 | -0.78 | -0.76 | -0.79 | -0.79 | -0.79 |
| 3% | -0.71 | -0.74 | -0.72 | -0.70 | -0.72 | -0.72 | -0.72 |
| 4% | -0.57 | -0.58 | -0.59 | -0.58 | -0.61 | -0.61 | -0.61 |
| 5% | -0.48 | -0.51 | -0.52 | -0.54 | -0.56 | -0.57 | -0.57 |
| 6% | -0.45 | -0.48 | -0.51 | -0.54 | -0.56 | -0.57 | -0.58 |
| **8%** | **-0.35** | -0.37 | -0.42 | -0.45 | -0.49 | -0.50 | -0.51 |

**Best cell**: stop=8%, hold=5d → expectancy=-0.35R, profit factor=0.29, win rate=27.1%, n=188.
**Random Entry at that same cell**: expectancy=-0.16R (n=2300) — **still beats AWO Full's best-found parameter combination.**

**Finding**: Every one of the 63 cells is negative — there is no (Stop%, Hold) combination with TP fixed at 10% where AWO Full is profitable in this window. The response surface is smooth and monotonic (expectancy improves steadily as stop widens from 1%→8%, roughly flat across hold length) — a genuine plateau, not an isolated lucky point, so this isn't a curve-fitting artifact per Advance.md §9. But it's a plateau of losses, and Random Entry beats AWO Full's own best cell. This is the strongest, most direct evidence yet that AWO Full's BUY signal *selection* is not adding value over picking entries at random, in this window.

**Status**: PRELIMINARY — third consecutive backtest (three different exit-rule designs) all pointing the same direction. Still one time window; the next real test is whether this replicates in a different period.

---

## EXP-2026-07-30-004 — Walk-Forward Split Validation (Period 1 vs Period 2)

- **Script**: `scraper/backtest_walkforward_split.js`
- **Model/formula version**: `AWO_MODEL_VERSION = 3.3-awo`
- **Why**: EXP-001/002/003 all shared the exact same ~7.5-month window — the single biggest open risk per Advance.md's own Gate Stability ("tidak bergantung pada satu periode"). True multi-year walk-forward (Advance.md §11's example) is **not possible with current data** — `idx_concentration` (F1/F2/F7/F8's source) only exists from 2026-01-19 onward, and EXP-001-003 already used nearly all of it. Best honest alternative: split the one available window into two non-overlapping halves and check independently.
- **Market universe**: same 145 tickers as EXP-001-003
- **Periods**: Period 1 = 2026-01-19 to 2026-04-19 (avg 80% ticker-day broker-data coverage — genuinely novel, not tested before); Period 2 = 2026-04-20 to 2026-07-29 (avg 72% coverage; tail end already partially covered by EXP-001-003)
- **Exit rule**: ATR/SR-based via `computeTradePlan` (same as EXP-001 — the most production-faithful version, since this validates what the live system's actual trade-plan logic would produce), max hold 15 days
- **Cost assumption**: same 0.50% round-trip as all prior experiments

**Result:**

| Strategy | Period 1 (n / expectancy / PF) | Period 2 (n / expectancy / PF) |
|---|---|---|
| **AWO Full** | 103 / **-0.478R** / 0.33 | 53 / **-0.627R** / 0.15 |
| AWO Technical-Only | 379 / -0.278R / 0.55 | 279 / -0.483R / 0.26 |
| EMA9/21 Crossover | 174 / -0.361R / 0.43 | 166 / -0.174R / 0.63 |
| Random Entry | 869 / -0.324R / 0.51 | 965 / -0.314R / 0.48 |

**Finding**: **AWO Full is the worst-performing strategy of the four in BOTH independent periods.** This is no longer a single-window artifact — it replicates. One nuance: the *relative order among the other three* baselines is NOT stable between periods (Technical-Only best in P1, EMA best in P2) — that part is noisy/small-sample, but it doesn't matter for the one question that counts: AWO Full has now finished last in every single test run across 3 different exit-rule designs and 2 independent, non-overlapping time periods.

**Status**: The core finding is now REPLICATED, not preliminary. AWO Full's underperformance is a stable characteristic of this model within the data available, not a one-off. Sample size caution remains for Period 2's AWO Full (n=53) — directionally consistent with Period 1 (n=103), but smaller.

---

## EXP-2026-07-30-005 — Per-Factor Ablation (F1-F13 individually + Risk Modifier off)

- **Script**: `scraper/backtest_factor_ablation.js`
- **Model/formula version**: `AWO_MODEL_VERSION = 3.3-awo`
- **Why**: EXP-001/002/004 showed removing ALL broker factors (F1/F2/F6/F7/F8) as one block beats keeping them — but that doesn't say WHICH factor(s) specifically are the problem. This isolates each one.
- **Market universe / window**: same 145 tickers, full concentration-covered span 2026-01-19 to 2026-07-29 (maximize sample for this diagnostic pass — replication across periods already established in EXP-004, this pass is about *which factor*, not re-proving *that* it happens)
- **Method**: for each of F1-F13, generate its own signals from a composite computed WITHOUT that one factor (weight excluded, not just data-unavailable), simulate trades with the same ATR/SR exit as EXP-001/004. Also tested a 14th variant, Risk Modifier forced off (1.0x, confidence still applies) — since F14 isn't a summed factor anymore, this asks whether the confidence/risk multiplier layer itself helps or hurts.
- **Cost assumption**: same 0.50% round-trip as all prior experiments

**Result** (Δexpectancy = variant's expectancy minus FULL's -0.529R; positive Δ means removing that factor helped):

| Variant | n | Expectancy | Δ vs FULL | Reading |
|---|---|---|---|---|
| FULL (baseline) | 156 | -0.529R | — | — |
| NO_RISK_MODIFIER | 804 | -0.440R | **+0.089R** | Removing the confidence×risk multiplier lets 5x more signals through AND improves expectancy — the multiplier isn't filtering for quality well right now |
| NO_F9 (RSI) | 178 | -0.455R | +0.074R | Mild drag |
| NO_F6 (Buyer Breadth) | 302 | -0.471R | +0.058R | Mild drag — broker factor |
| NO_F11 (Bollinger) | 239 | -0.491R | +0.038R | Mild drag |
| NO_F7 (Price-Broker Alignment) | 105 | -0.497R | +0.032R | Mild drag — broker factor |
| NO_F13 (Support/Resistance) | 141 | -0.530R | -0.001R | Neutral |
| NO_F8 (Accum Streak) | 92 | -0.534R | -0.005R | Neutral — broker factor |
| NO_F2 (Trend) | 45 | -0.563R | -0.034R | Mildly helpful — broker factor |
| NO_F10 (MACD) | 88 | -0.578R | -0.049R | Helpful |
| NO_F5 (Rel Strength) | 72 | -0.618R | -0.089R | Helpful |
| NO_F1 (Concentration) | 49 | -0.638R | -0.109R | Helpful — broker factor |
| NO_F3 (Volume Z) | 76 | -0.644R | -0.115R | Helpful |
| NO_F12 (EMA Trend) | 85 | -0.646R | -0.117R | Helpful |
| NO_F4 (Momentum) | 62 | -0.693R | **-0.164R** | Most valuable single factor — removing it hurts the most |

**Finding — NOT what the "remove all broker factors" result implied.** It is *not* uniformly "broker factors bad, technical factors good": within the broker family, F6 (Buyer Breadth) and F7 (Price-Broker Alignment) look like genuine drags, but F1 (Concentration) and F2 (Trend) actually look *helpful* — removing them makes things worse. Among purely technical factors, F4 (Momentum), F12 (EMA Trend), F3 (Volume Z), F5 (Rel Strength), and F10 (MACD) are the most valuable factors in the whole model; F9 (RSI) and F11 (Bollinger) are mild drags. Technical-Only beating Full in EXP-001/002/004 is consistent with this — removing F6+F7 (harmful) evidently outweighs losing F1+F2 (helpful) — but the real story is two specific broker factors, not the whole family.

**Separately notable**: disabling the Risk Modifier entirely gave the single biggest improvement AND a 5x larger sample — the confidence×risk-modifier layer built earlier this week (2026-07-29) is currently suppressing volume without correlating well to trade quality. Worth its own dedicated look before trusting it as currently calibrated.

**Caveats**: (1) sample sizes are small per variant (45-300 trades for most; only NO_RISK_MODIFIER has a large sample) — these deltas are *suggestive rankings*, not statistically confirmed; no formal significance test (two-proportion z-test) has been run on them yet. (2) Single window/pass — not yet checked whether this ranking replicates across Period 1 vs Period 2 the way the FULL-vs-baseline finding was. (3) Diagnostic only — no proposal yet to actually remove/reweight F6, F7, F9, F11, or fix the Risk Modifier; that would need its own validated decision, not an automatic action off one ablation pass.

**Status**: PRELIMINARY — first per-factor breakdown, directionally informative, not yet replicated or statistically tested.

**RETRACTED-THEN-RECONFIRMED 2026-07-30**: an external review found `calcMACD()` had a real EMA-misalignment bug (fast EMA skipped ~14 bars of recursive updates), confirmed via independent reference calculation to cause outright sign flips in the histogram. Every backtest above (EXP-001 through EXP-005) scored F10 using the BUGGY calculation, so F10's ablation result was flagged unreliable pending a re-run — see EXP-006 below, which re-ran this exact experiment after the fix deployed. **Result: F10's finding held up.**

---

## EXP-2026-07-30-006 — Per-Factor Ablation RE-RUN (post MACD fix)

- **Script**: `scraper/backtest_factor_ablation.js` (unchanged — only `awo_technical.js`'s `calcMACD` changed underneath it)
- **Why**: confirm whether EXP-005's ranking — specifically F10's "-0.049R, helpful" result — survives now that the MACD sign-flip bug is fixed.
- **Same window, same method as EXP-005** (2026-01-19 to 2026-07-29, 145 tickers, ATR/SR exit).

**Result — old (buggy MACD) vs new (fixed MACD), sorted by old ranking:**

| Variant | Old Δexpectancy | New Δexpectancy | Moved? |
|---|---|---|---|
| NO_RISK_MODIFIER | +0.089R | +0.085R | no |
| NO_F9 | +0.074R | +0.063R | no |
| NO_F6 | +0.058R | +0.051R | no |
| NO_F11 | +0.038R | +0.022R | no |
| NO_F7 | +0.032R | +0.018R | no |
| NO_F13 | -0.001R | -0.010R | no |
| NO_F8 | -0.005R | -0.014R | no |
| NO_F2 | -0.034R | -0.055R | no |
| **NO_F10** | **-0.049R** | **-0.059R** | **no — same rank, similar magnitude** |
| NO_F5 | -0.089R | -0.115R | no |
| NO_F1 | -0.109R | -0.123R | no |
| NO_F12 | -0.117R | -0.128R | swapped with F3 (both near-tied either way) |
| NO_F3 | -0.115R | -0.139R | swapped with F12 (both near-tied either way) |
| NO_F4 | -0.164R | -0.173R | no — stays the single most valuable factor |

**Finding**: the MACD bug fix did NOT overturn any conclusion — F10 stays exactly where it was (8th of 14, a genuinely helpful factor, "removing it costs ~-0.05 to -0.06R"), every other factor's rank is identical except a meaningless F3/F12 swap between two already near-tied values. The full ranking from EXP-005 (F6/F7/F9/F11/Risk-Modifier harmful; F1/F2/F3/F4/F5/F10/F12 helpful; F8/F13 neutral) is now CONFIRMED stable across the MACD fix, not just a bug-era artifact.

**Status**: CONFIRMED (post-fix) — same caveats as EXP-005 still apply (small samples, no formal significance test, single window/pass not yet checked against Period 1/2 split) — this re-run addressed the MACD-validity caveat specifically, not those others.

---

## EXP-2026-07-30-007 — Full re-validation sweep of every remaining MACD-affected experiment

Per an explicit follow-up request ("invalidasi dan rerun semua eksperimen terdampak MACD"), re-ran the 3 experiments EXP-006 hadn't covered — everything that scores F10 through `calcTechnicalFactors`/`scoreMACD` is affected, which is all of them.

| Experiment | Metric | Before fix | After fix | Changed? |
|---|---|---|---|---|
| EXP-002 (fixed 2%/10%, unlimited hold) | AWO Full expectancy | -0.988R | -0.992R | no |
| EXP-004 Period 1 (ATR/SR, split) | AWO Full expectancy | -0.478R | -0.465R | no |
| EXP-004 Period 2 (ATR/SR, split) | AWO Full expectancy | -0.627R | -0.627R | **identical** |
| EXP-003 (stop×hold sweep) | Best cell expectancy | -0.35R | -0.34R | no |

Every single conclusion from EXP-001 through EXP-005 holds after the MACD fix — AWO Full is still the worst strategy in every configuration, the sweep is still a plateau of losses, Random Entry still beats AWO Full's own best parameter cell. (IHSG's passive-benchmark number shifted from -13.49% to -16.81% between runs — unrelated to MACD, caused by the `idx_ihsg_history` staleness fix earlier the same day extending/correcting the stored index history; does not affect any strategy-vs-strategy comparison.)

**Status**: All backtest experiments (EXP-001 through EXP-007) are now confirmed consistent post-MACD-fix. No further re-runs needed for this specific issue.

---

## EXP-2026-07-30-008 — Regime Gate Shadow Mode (retroactive)

- **Script**: `scraper/backtest_regime_gate_shadow.js`
- **Why**: `modules/regime_engine.js`'s `detectPriceRegime()` was built 2026-07-29 deliberately as an informational badge, never a gate — explicit lesson from the Counter-trend hard gate that got adopted from one backtest, then had to be retracted. Its own doc comment calls for exactly this next step: "watch it against real outcomes, only promote it to something that filters/sizes signals once it's been validated." This is that validation — run in SHADOW MODE (verdict computed and logged, nothing ever blocked) both retroactively here and going forward live (see below).
- **Gate rule tested**: a signal is "would-BLOCK" if (a) regime = HIGH_VOLATILITY (any direction — §5 frames this as un-actionable risk regardless of direction), or (b) a BUY/STRONG BUY fires while regime = TREND_DOWN, or (c) a SELL/STRONG SELL fires while regime = TREND_UP. Otherwise "would-ALLOW". See `regimeGateVerdict()`.
- **Market universe / window / cost**: same 145 tickers, 2026-01-19 to 2026-07-29, same 0.50% round-trip assumption as all prior experiments.
- **Method**: AWO Full composite (DEFAULT_WEIGHTS) computed per ticker-day exactly like EXP-005; wherever it classifies BUY/STRONG BUY/SELL/STRONG SELL, `detectPriceRegime` is recomputed AS OF that day (candles sliced to that point only — no lookahead), the shadow verdict is derived, and the REAL future-path outcome is evaluated via `evaluateCandidateOutcome` — the exact same function the live optimizer uses (T+1 entry, ATR/SR stop/target, fee+slippage, 15-day max hold).

**Result — regime distribution across all 233 directional signals:**

| Regime | n |
|---|---|
| RANGE | 110 |
| HIGH_VOLATILITY | 51 |
| TREND_UP | 40 |
| TREND_DOWN | 32 |

**Result — pooled:**

| Group | n | Win Rate | Expectancy | Profit Factor |
|---|---|---|---|---|
| FULL (ungated) | 233 | 31.3% | -0.331R | 0.45 |
| Shadow gate: ALLOW | 172 | 33.7% | -0.250R | 0.56 |
| Shadow gate: BLOCK | 61 | 24.6% | **-0.556R** | 0.21 |

Pooled Δexpectancy (BLOCK − ALLOW) = **-0.306R** — at face value this says BLOCK trades are meaningfully worse, i.e. the gate would have helped.

**Result — broken down by regime (this is the important part, not the pooled number above):**

| Regime × Verdict | n | Win Rate | Expectancy | Profit Factor |
|---|---|---|---|---|
| HIGH_VOLATILITY \| BLOCK | 51 | 19.6% | -0.633R | 0.16 |
| RANGE \| ALLOW | 110 | 31.8% | -0.275R | 0.52 |
| TREND_DOWN \| ALLOW (SELL, aligned) | 26 | 42.3% | **+0.012R** | 1.02 |
| TREND_DOWN \| BLOCK (BUY, counter-trend) | 6 | 50.0% | -0.293R | 0.41 |
| TREND_UP \| ALLOW (BUY, aligned) | 36 | 33.3% | -0.365R | 0.42 |
| TREND_UP \| BLOCK (SELL, counter-trend) | 4 | 50.0% | +0.029R | 1.07 |

**Finding — the pooled headline is misleading; do NOT report it on its own.** 51 of the 61 "BLOCK" trades (84%) are HIGH_VOLATILITY, a *different* hypothesis (avoid trading in extreme volatility, regardless of direction) than "counter-trend" (fight the regime's direction) — and HIGH_VOLATILITY alone (-0.633R) is bad enough to drag the whole BLOCK bucket down by itself. Isolating the actual counter-trend comparison tells a much weaker, mixed story:
- **TREND_DOWN**: aligned SELLs (n=26) come out roughly breakeven (+0.012R, PF 1.02) — the best-performing bucket in the whole table — while counter-trend BUYs (n=6) are worse (-0.293R). This direction is *consistent* with the counter-trend hypothesis, but n=6 is far too small to trust.
- **TREND_UP**: the OPPOSITE of the hypothesis — aligned BUYs (n=36) are worse (-0.365R) than counter-trend SELLs (n=4, +0.029R). Also too small a sample (n=4) to trust, but it directly contradicts the simple "counter-trend is bad" story.

**Honest reading**: there is real, if preliminary, support for a volatility filter (HIGH_VOLATILITY signals are bad regardless of direction — the single cleanest signal in this whole result). There is NOT yet clean, believable evidence for the counter-trend component specifically — the two trend regimes point in different directions on samples of 4 and 6. This is exactly the kind of oversimplified pooled read that caused the original Counter-trend gate to be adopted, then retracted, once a cleaner look showed it didn't hold — worth naming that risk explicitly rather than repeating it.

**Went live too (shadow mode, ongoing)**: `regimeGateVerdict()` is now also computed on every live `/api/signal-scanner` call and both exposed in the API response (`regimeGateShadow: {wouldBlock, reason}`) and persisted to `idx_signal_history` (`price_regime_at_signal`, `regime_gate_would_block`, `regime_gate_reason`) — never blocking anything, purely accumulating a live, forward-looking dataset that avoids the "only one backtest window" trap this whole exercise is trying to learn from. This retroactive run is the FIRST look, not the only one intended.

**Caveats**: (1) small samples in the cells that actually matter (per-regime counter-trend comparison, n=4-36) — no formal significance test run; (2) single time window, same one as EXP-001-006, not yet checked against a second period; (3) the HIGH_VOLATILITY-vs-counter-trend conflation above is itself worth fixing before drawing further conclusions — consider testing them as two separate, independently-toggleable rules rather than one combined gate, so a future re-run can tell which piece is actually doing the work.

**Status**: PRELIMINARY. Directionally suggestive for a volatility filter; NOT sufficient evidence yet for a counter-trend gate specifically — same discipline as every other "not yet a gate" decision on this project. No gate is enabled by this experiment.

---

## 2026-07-31 — Optimizer methodology overhaul (external review round 2)

Not a new EXP-number backtest — a fix to the LIVE optimizer (`awo_optimizer.js`) itself, prompted by a second external review that found the optimizer's ranking/adoption logic still selected candidates by win rate, not profitability, and several other leakage/identity bugs. Full detail: `REVIEW_RESPONSE_2026-07-31.md`. Summary relevant to this registry:

- **Ranking objective changed from win rate to expectancy**, with hard rejection gates (OOS expectancy > 0, OOS profit factor >= 1.20) added before a candidate can be adopted.
- **Concrete catch on first live run post-fix**: `/api/awo/optimize/run` against production data (15,613 signals) found a candidate with win-rate improvement +3.3% (would have cleared the OLD `MIN_MARGIN=2` bar and been adopted) but expectancy -0.292R and profit factor 0.51 — correctly REJECTED by the new gates. This is direct empirical confirmation that the old win-rate-only objective was a real, live risk, not just a theoretical one.
- **F14 contamination bug**: found (deeper than the review's own framing) that `weightedComposite()` was silently including F14's weight in the directional composite as a phantom neutral-50 contributor, pulling every live score toward 50 in proportion to F14's weight share — verified empirically (13 factors at 80 produced composite 79.1, not 80.0). Fixed at the `combineFactorScores()` level; F14 also removed entirely from the optimizer's search space.
- **Train/validate split** changed from row-count-based to unique-date-based with a purge gap (`OUTCOME_MAX_HOLD` trading days before the boundary) — 1,950 of 15,613 signals purged on the same live run above.
- **Candidate generation seeded** (mulberry32, same PRNG already used by `backtest_baseline_comparison.js`'s Random Entry baseline) — every `/run` result now records `candidateSeed` for reproducibility.
- **Paper trading** (see the earlier P1 follow-up #18 entry) redesigned around a "frozen challenger" (`awo-challenger.json`) instead of the ever-changing daily `AWO_RESULT_FILE`, since unseeded nightly search would otherwise almost never re-find a bit-identical candidate two nights running — without this, no candidate could realistically accumulate enough paper-trading days to ever clear promotion.

Any EXP-001 through EXP-008 result above is UNAFFECTED by this — those are all standalone backtest/analysis scripts with their own independent replay logic, not calls into `awo_optimizer.js`'s internal train/validate/adopt pipeline. This entry only concerns the live optimizer's own candidate-selection behavior going forward.

---

## 2026-07-31 (same day) — Optimizer overhaul round 2: paper trading was structurally broken

A second, sharper external review — this one actually RAN the code rather than just reading it — found that the paper-trading system built earlier the same day had a candidate-key bug (`generatePaperTrades` recomputed its own key without the `modelVersion` the challenger was frozen with) that meant **paper trades were always filed under a different key than the challenger looked up — zero trades would ever be visible to any challenger, ever**. Combined with a second bug (`profitFactor` was referenced by the promotion gate but never actually computed, so that check silently no-op'd), the whole paper-trading safety mechanism from the earlier round-1 entry above was non-functional despite passing its own unit tests (which tested `candidateKeyFromWeights` correctly in isolation, but never an end-to-end challenger→paper-trade→summary round trip).

Also found and fixed: `evaluateCandidateOutcome` forced a `TIME_EXIT` on any signal with fewer than 15 real future bars available (i.e. every signal 2-14 days old — the bulk of what the optimizer's query even considers), scoring it as if the full holding period had elapsed; a genuine long/short inconsistency across the optimizer/paper-trading/threshold-optimization (now standardized on `TRADE_DIRECTION_MODE=LONG_ONLY`, matching what this registry has claimed all along); the win-rate significance test replaced with a date-block bootstrap on expectancy (2000 resamples, ~360ms for 20 candidates — no performance concern); the 24h re-optimization cooldown was checking the wrong table (`awo_optimization_log`, which only gets a row on an actual PROMOTION — rare — not on every `/run`) and was in practice barely enforced at all, now fixed plus a new minimum-200-new-signals gate; and a weight-generation numerical bug where the [0.02, 0.18] cap could be exceeded after renormalization (verified empirically: ~4.9% of 150,000 generated candidates violated it, up to 0.197) — fixed with a proper iterative capped-simplex projection, re-verified violation-free across 3,000,000 candidates.

Full detail: `REVIEW_RESPONSE_2026-07-31.md`'s "Ronde 2" section. 98 tests passing (up from 80), all fixes deployed and verified live against production data, including watching the new hard gates actually reject a candidate in real time.

---

## 2026-07-31 (same day) — Optimizer overhaul round 3: challenger validated against the wrong thresholds, and the availability bug was bigger than reported

A third external review, same day, found a bug that undermined every round-2 safeguard's meaning: the challenger frozen into `awo-challenger.json` was validated (expectancy, profit factor, bootstrap significance, monotonicity — all of round 2's new gates) using `DEFAULT_THRESHOLDS`, but `optimizeThresholds(trainSet, weights)` was then called ONCE MORE, outside the safeguard loop, only for the already-chosen candidate — so the thresholds actually frozen (and used every night by `generatePaperTrades`) were never the ones any gate had checked. Fixed by moving `optimizeThresholds()` inside the safeguard walk loop, per-candidate, so every gate evaluates the exact weights+thresholds pair that ends up frozen.

The review also re-examined round 2's own P1 fix for technical-factor availability (`scoreAtTimestamp`'s `technicalAvailable = candles.length >= 15`, applied identically to F9-F13 despite each needing different minimums — RSI 15, Bollinger/Support-Resistance 20, EMA-trend 21, MACD 35) and found it still wrong at the per-indicator level. Tracing it further turned up the **same bug independently duplicated in two more live-scoring call sites in `server.js`** that round 2 never touched: `computeStockFactorsLive()` (per-stock detail endpoint) and, more importantly, **`/api/signal-scanner` itself — the main endpoint real users hit every day**. Both had the identical pattern (one shared bar-count gate for F9-F13, then an `availability` object passed to `combineFactorScores()` that didn't even include F9-F13 keys, so a fake-50 was always scored as fully available). Fixed at the root: `calcTechnicalFactors()` in `awo_technical.js` no longer has a blanket `candles.length < 26` shortcut (each `scoreX()` already null-guards to 50 independently at its own real minimum) and now returns a `factorAvailable: {f9..f14}` map reflecting exactly which indicators got real data this call. All three call sites (`score_engine.js`, `computeStockFactorsLive`, `/api/signal-scanner`) now read per-factor availability from that map instead of sharing one flag. Verified live: 101/245 tracked tickers currently show `missingFactors: ["f9"..."f13"]` with `factorCoverage: 0.74` (broker/breadth factors still counted, technical ones correctly excluded) where before they'd have shown `factorCoverage: 1.0` with fake data silently included.

Also fixed this round: the 200-new-signal reopt gate was measured in raw rows, not unique trading dates (its own comment already said "20 trading days," but a burst of same-day rows could satisfy 200 without a single new validation day passing) — now `uniqueDatesCount`-based, threshold 20 dates; a frozen challenger's `modelVersion` was never checked against the server's current `AWO_MODEL_VERSION`, so a challenger paper-tested under an old scoring formula could keep occupying the slot indefinitely after the formula changed — now auto-archived (`REJECTED`, `STALE_MODEL_VERSION`) on mismatch; `factorValidity()`'s predictiveness check used win-rate lift and `Math.abs(ic)`, meaning a factor working exactly backwards from its intended direction (high score → worse outcome) could still pass if its correlation was merely strong — now expectancy-lift + signed `ic`, verified live to correctly reject F10/F14 (both negative-ic on the live run below) that the old logic would have accepted; `candidateKeyFromWeights` was hashing `optimizeThresholds`'s entire return object, including research metrics (`winRate`, `sampleSize`, `expectancy`, `profitFactor`) that have nothing to do with runtime behavior — now hashes only the five behavioral threshold fields; manual `POST /api/awo/optimize/run` never called `getOrFreezeChallenger` (only the cron pipeline did), so a manually-triggered eligible candidate could never actually become paper-testable despite the response telling the caller to `/promote` it — field renamed `eligibleForPromotion` → `eligibleForChallenger`, and `/run` now freezes a challenger itself when eligible (cron, which calls `/run` over HTTP anyway, now just reads the result instead of duplicating the freeze call); and `DEFAULT_WEIGHTS` summed to 0.97 after F14's removal from the search space — renormalized to exactly 1.0 with rounding-drift correction.

**Concrete live evidence from this round's verification**: a forced `/run` against current production data (15,613 signals, 118 unique dates) rejected all 20 top-ranked candidates, with `factorValidity` showing F10 (`lift: -0.199, ic: -0.095`) and F14 (`lift: -0.154, ic: -0.099`) both correctly marked non-predictive — under the OLD `Math.abs(ic) > 0.05` logic both would have passed, since their |ic| clears the bar despite working backwards. Worth noting honestly, not as a new bug but as a real observation: the current LIVE baseline weights (identical to `DEFAULT_WEIGHTS`, since nothing has ever been promoted) themselves scored `validateExpectancy: -0.334R, validateProfitFactor: 0.45` on this validate split (n=91) — small sample, one time slice, not definitive, but consistent with this registry's standing "no proven edge yet" conclusion (EXP-001 onward), now measured with materially tighter safeguards than existed even this morning.

Full detail: `REVIEW_RESPONSE_2026-07-31.md`'s "Ronde 3" section. 113 tests passing (up from 98), all fixes deployed and verified live, including the forced `/run` above and a direct `/api/signal-scanner` check of the availability fix on real tickers.

---

## EXP-2026-08-01-009 — Momentum Leadership + Breakout (Setup A), Standalone Backtest

A further external review, having confirmed AWO Full is consistently negative-expectancy on this registry's own evidence (underperforms technical-only, EMA9/21, and random entry, on two periods), recommended abandoning further AWO Full weight optimization in favor of a new, evidence-backed strategy: cross-sectional Momentum Leadership with a Breakout entry — directly supported by this project's own per-factor ablation (F4 Momentum most valuable; F12/F3/F5/F10 also helpful; F9/F11/F6/F7 drags; HIGH_VOLATILITY periods -0.633R/PF 0.16, EXP-2026-07-30-008) and momentum/trend-following literature the reviewer cited. Scope agreed with the project owner: a standalone backtest only, no live wiring, until it clears its own evidence bar — same discipline AWO Full itself has never cleared.

**Method**: New script `backtest_momentum_leadership.js`. Universe: `BIG_CAP_100` (91/100 tickers meet a >=260-bar history gate). Cross-sectional composite ranking computed per canonical trading date (IHSG's own calendar, 483 dates total): 30% RS-6m vs IHSG + 25% RS-3m vs IHSG + 20% 52-week-high proximity + 10% EMA50 slope + 10% volume Z-score + 5% MACD histogram normalized by ATR, each percentile-ranked within that date's eligible set (88-91 tickers/date — stable, no collapse) before weighting. Top 10% and top 15% cutoffs both tested. Setup A trigger (N=20 and N=55 day breakout lookback both tested): close > EMA50 > EMA200, positive EMA50 slope, within 90% of the 252-day high, close breaks the prior N-day high, volume-Z >= 1.5, strong close-in-range, no excessive gap. Rejects: extreme ATR percentile, large upper wick, over-extension from EMA21, risk:reward < 1.5 (`computeTradePlan`), and — reusing EXP-2026-07-30-008's own finding on an apples-to-apples basis (identical stock-level `detectPriceRegime` input) — HIGH_VOLATILITY regime; IHSG in a confirmed downtrend skips the whole date (41/223 candidate dates skipped this way). Trade simulation via `awo_optimizer.js`'s `evaluateCandidateOutcome` (now exported for reuse, extended with a `holdDays` field), same T+1 entry / ATR-SR stop-target / 15-bar hold / 0.50% cost as every other simulation in this project. Baselines: seeded Random Entry (exact-count rate-matched via a seeded Fisher-Yates sample over the same eligible-pair pool, not a probability threshold), EMA9/21 crossover (no strategy filters applied, by design — the point of that baseline is being the dumbest plausible trend rule).

**Finding — mechanically verified correct, but statistically INCONCLUSIVE due to a hard data-depth ceiling, not evidence against the strategy**:

- Every ticker in `idx_stock_prices` is capped at the same ~2-year window (`overall_earliest = 2024-07-17`, `overall_latest = 2026-07-31`, max 502 bars for any ticker) — almost certainly `backfill_price_history.js`'s documented `--range 2y` default, confirmed empirically via a direct DB query, not an assumption. After the 260-bar warmup this leaves only 223 candidate trading dates (182 actually ranked). A strategy requiring simultaneous top-decile cross-sectional rank AND a clean breakout AND volume confirmation AND a favorable regime, on this short a window, produced **only 8 signals for the largest variant (Momentum 20D top10%/top15%) and 3 for the 55-day variants** — nowhere near enough to distinguish real edge from noise (`Momentum 20D top10%`: n=7 resolved, expectancy -0.337R; `55D top10%`: n=2, expectancy -0.913R; Random Entry count-matched to n=8: expectancy +0.132R). At n=2-8, none of these numbers are trustworthy in either direction — this is explicitly NOT "Setup A failed," it's "not enough data existed to test it yet."
- What IS trustworthy from this run: the harness itself. `buildAtrSeries`/`buildMacdHistogramSeries` (new series-builder helpers, needed to avoid O(n²) full-history recomputation) verified byte-identical to the existing, tested `calcATR`/`calcMACD` at 6 sample points on real BBCA data. The EMA9/21 crossover baseline (n=382 resolved, 415 fired) landed at expectancy -0.043R, PF 0.91 — same losing direction as every prior EMA9/21 result in this registry (EXP-001: -0.217R/PF 0.62; EXP-002: -0.613R/PF 0.47; EXP-004 both periods: -0.361R and -0.174R), no unexplained directional flip despite a different universe/date-range/cooldown mechanism, which is exactly the cross-check this experiment's verification plan called for. A manual hand-check of one real fired signal (TLKM, 2025-11-24: close 3700 breaking a real prior 20-day high of 3690 on ~2.4x normal volume, closing at the day's high) confirmed the breakout/volume/close-position math by hand against raw SQL data — no off-by-one bug found. Reject-reason tally is well-distributed (no single filter silently eating >42% of candidates, nothing at 0% or 100%) and reran byte-identical (same seed, same signal list both runs) — reproducible, not flaky.

**Status**: Backtest only, not promoted (per scope). **INCONCLUSIVE — insufficient sample size**, not a negative result. The natural next step is extending the price-history backfill window before this strategy can be properly evaluated (flagged as a real infrastructure decision — API cost/time/quota, not a code change — for the project owner rather than done unilaterally here). Setup B (Pullback) intentionally out of scope for this pass, same reasoning.

---

## EXP-2026-08-02-010 — Momentum Rank Alpha Diagnostic

A further external review looked at EXP-009's inconclusive result and gave a sharp diagnosis, confirmed sound by inspecting this project's own code and history: engineering and implementation were fine ("kegagalan bukan pada kode strategi, melainkan keterbatasan data untuk menguji strategi low-frequency") — before testing (or re-testing) any entry-timing mechanics, test whether the RANKING ITSELF has predictive power, since that can be measured on every (ticker, date) pair rather than only the rare days where every Setup A condition aligns. Reviewer's own stated decision rule: monotonic deciles + positive mean IC → proceed to layer-decomposition/timing-layer follow-ups; not monotonic + IC<=0 → the ranking formula itself needs revisiting first.

**Method**: New script `backtest_momentum_rank_diagnostic.js`. Same universe (`BIG_CAP_100`, 91/100 tickers) and same exact composite ranking formula as EXP-009 (30% RS-6m vs IHSG + 25% RS-3m vs IHSG + 20% 52-week-high proximity + 10% EMA50 slope + 10% volume Z-score + 5% MACD-normalized, percentile-ranked cross-sectionally per date) — ported, not re-derived, and directly cross-checked byte-identical against EXP-009's own Pass 2 for two spot-check dates (19/19 compositeScore values matched to 4 decimal places). **Deliberate difference from EXP-009**: the IHSG-downtrend skip EXP-009 applied for trade timing was NOT applied here — every date clearing only the 20-eligible-ticker floor is included (223/223 dates, 0 skipped for thinness), since it's more informative to know whether the ranking holds up during downtrends too, not just cherry-picked "safe" dates. For every ranked date, the eligible universe is split into 10 deciles by composite score and FORWARD returns (no stop/target/entry-timing at all) are measured at 5/10/20/60 trading-day horizons — turning EXP-009's 2-8 trades into ~1,500-2,000 observations per decile per horizon. Reports per horizon: decile table, Spearman Information Coefficient (new `rankTransform`+`correlation` composition, average-rank tie-handling on both sides — deliberately tie-aware on the return side too, since IDX's ARA/ARB daily price-limit mechanism means multiple stocks can post identical capped moves same-day, a real feature of this data not a theoretical edge case), IC mean/stdDev/Information-Ratio/%positive-dates, decile-rank monotonicity (same `spearmanIC` applied to decile-rank vs decile-avg-return), top-decile return (gross and after 0.50% cost), top-minus-bottom spread, top-decile-vs-IHSG and vs-universe-average (paired same-date diffs), decile-10 turnover, and a date-block bootstrap 95% CI on mean IC.

**Finding — mechanically verified correct, and the answer is NOT favorable to the ranking formula as currently weighted**:

- Mean Spearman IC across all 4 horizons is close to zero and mostly negative: 5D −0.0032, 10D −0.0220, 20D −0.0209, 60D +0.0100 — none distinguishable from zero (bootstrap 95% CIs all straddle or nearly straddle 0: 5D `[-0.029, 0.023]`, 10D `[-0.048, 0.005]`, 20D `[-0.042, 0.003]`, 60D `[-0.007, 0.025]`). %-of-dates-with-positive-IC hovers right around a coin flip (51.4%, 48.1%, 51.7%, 60.8%).
- Deciles are NOT cleanly monotonic at any horizon (decile-rank-vs-return Spearman IC: 5D 0.78, 10D 0.50, 20D 0.70, 60D 0.59 — none exceed the 0.8 "strong ordering" bar used for the automated read). The decile tables are genuinely messy: at 10D, decile 7 (not decile 10) has the best average return (+0.850% vs decile 10's +0.266%); at 20D, decile 7 again leads (+1.680%) while decile 10 lags most of the upper deciles (+0.138%).
- Most notable: at 60D, decile 10 (strongest momentum) has the **worst** average forward return of all ten deciles (−6.739%, worse even than decile 1 at −7.658% only by a hair, and worse than deciles 3-9). Decile-10-vs-universe-average is **negative** at 60D (−2.59 percentage points) — the top-ranked momentum names underperformed the pooled universe average over the next 60 trading days in this window. (One concrete, verified illustration: TOBA, decile-10 leader on 2025-08-26 with the single highest composite score that date, was −41.5% sixty trading days later — a real momentum-crash case, exactly the failure mode the reviewer's own cited literature warns momentum strategies are exposed to.)
- Decile-10 DOES beat IHSG itself at every horizon (+0.7pp, +1.3pp, +2.5pp, +2.7pp) — but this is much more likely just BIG_CAP_100's own selection bias (large, liquid, currently-relevant names tend to beat the broad index) than evidence the ranking adds value within that universe; the vs-universe-average comparison (weak-to-negative) is the more diagnostic one and does not support the same conclusion.
- The harness itself is trustworthy despite the discouraging numbers: `rankTransform`/`spearmanIC` verified against hand-computed toy cases (perfect +1.0/-1.0, correct tie-averaging); the composite-score computation verified byte-identical to EXP-009's own Pass 2 (19/19 spot-checked values, 2 dates); one forward-return calculation (TOBA, 2025-08-26, 5D) hand-verified against raw `idx_stock_prices` SQL, exact match; the bootstrap CI collapses correctly on a constant-value toy series and matches the theoretical normal-approximation width (`stdDev/sqrt(n)`) closely on a known-spread toy series; `datesRanked` (223) exactly equals EXP-009's own `datesRanked + datesSkippedIhsgDowntrend` (182+41), confirming the only behavioral difference between the two scripts is the intended one (the removed downtrend gate).

**Status**: Diagnostic only, no promotion decision implied. Per the reviewer's own explicit decision rule (not monotonic + IC<=0 at most horizons), the mechanical read is **RANKING FORMULA NEEDS REVISITING** at 5D/10D/20D, with only a weak, barely-positive signal at 60D that itself comes with the worst-decile-10-return red flag above. This is a materially different, more informative conclusion than EXP-009's "inconclusive, needs more data" — EXP-009's small trade count was a real limitation, but this diagnostic shows the underlying composite ranking does not currently demonstrate reliable forward-return predictive power in this dataset, independent of sample-size concerns. Do not proceed to Setup B (Pullback) or further timing-layer work on TOP OF this exact ranking formula without first revisiting it (candidate next steps per the reviewer's own roadmap: layer-in single sub-factors individually — e.g. isolate RS-6m or RS-3m alone rather than the blended 6-factor composite — before concluding momentum has no signal in this market at all; also worth checking whether the negative 60D decile-10 result is dominated by a small number of extreme momentum-crash names, same pattern as TOBA above, which a simple volatility/extension filter on the RANKING side itself — not just the entry-timing side — might address).

---

## 2026-08-02 — Infrastructure change: 10-year price history + horizon moved from SWING to POSITION

Not an experiment — a change to the measuring instrument, recorded here because it **breaks comparability with every entry above**.

**1. Price history extended from ~2 years to ~10 years.** `backfill_price_history.js --range 10y` against the 245-ticker Index Alpha universe: `idx_stock_prices` went from 73,392 rows (253 tickers, 2024-07-17 → 2026-07-31, max 502 bars/ticker) to **513,172 rows (2016-08-01 → 2026-07-31)**, 0 errors, 114 seconds. Depth distribution: 171 tickers with 9-10y, 32 with 5-9y, 38 with 2-5y, 12 with <2y (genuinely young listings, e.g. GOTO IPO'd 2022-04). This removes the binding constraint flagged in EXP-009 (2-8 signals per variant) and gives real multi-regime coverage — BBCA alone now spans the 2018 correction, the 2020 COVID crash (low 4430 vs high 6950), the 2021-22 commodity bull, and the 2025-26 drawdown (10950 in 2024 → 4850 in 2026).

Two caveats that must travel with any result computed on this data:
- **Survivorship bias is unchanged and now matters much more.** The universe is still today's tracked ticker list applied retroactively over 10 years. Per Review.md item 4b, results must be labeled **SURVIVORSHIP-BIASED RESEARCH RESULT** until a point-in-time universe exists. A 10-year backtest on today's survivors is a strictly stronger version of the same bias than a 2-year one.
- **Yahoo's `quote` OHLC is split-adjusted but not rights-issue-adjusted.** IDX rights issues in particular may leave artificial gaps in older bars. Not yet audited.

Also fixed while doing this: `--range max` was silently unsafe. Yahoo downgrades `interval=1d` to **monthly** bars for `max` (verified: BBCA `max` = 265 bars spanning 2004-2026, dated to month-ends). Those month-end dates are real trading days, so they would have INSERTed into the daily table as ordinary-looking daily rows and corrupted every downstream indicator. `backfill_price_history.js` now refuses non-daily-safe ranges and additionally rejects any per-ticker response whose bar cadence falls below ~60 bars/year.

**2. Trading horizon moved from a 1-3 week SWING profile to a 2-8 week POSITION profile.** The horizon had been three unrelated hardcoded constants (`OUTCOME_MAX_HOLD=15` in `awo_optimizer.js`, `MAX_HOLD_DAYS=15` in `modules/paper_trading.js`, `1.5×ATR` risk with `1.5R/2.5R` targets in `awo_technical.js`, plus a fixed 30-day journal expiry in `server.js`). They are now a single profile in **`scraper/modules/trade_policy.js`**, selectable via `AWO_HORIZON`:

| | SWING (all entries above) | POSITION (active from 2026-08-02) |
|---|---|---|
| Max hold | 15 bars | 40 bars |
| Risk unit | 1.5 × ATR | 2.5 × ATR |
| Targets | 1.5R / 2.5R | 2R / 4R |
| Journal expiry | 30 days | 75 days |
| Round-trip cost at 2% ATR | ~0.17R | ~0.10R |

**Every experiment above ran under SWING and is not directly comparable to anything measured under POSITION.** This is not a minor recalibration: under SWING, holding past bar 15 was not merely discouraged but *unrepresentable* — `evaluateCandidateOutcome` force-labelled a TIME_EXIT there and the paper trader closed the position. A 2-8 week holding period could not previously be measured at all.

`AWO_MODEL_VERSION` bumped `4.0.0-research` → `4.1.0-research`, because the exit policy is not part of `candidateKeyFromWeights` and a challenger frozen under the old horizon would otherwise accumulate paper trades resolved under the new one. No challenger and no paper trades existed at the time of the change (`awo-challenger.json` and `awo-weights.json` both absent; `awo_paper_trades` empty), so nothing was invalidated in practice — live scoring was and still is on `DEFAULT_WEIGHTS`.

**Known mismatch, deliberately left open:** this change moves the EXIT horizon and the PLAN geometry, but **not the speed of the factors**. F4 still reads a 3-5 day ROC (`roc5×0.6 + roc3×0.4`), F12 still uses EMA9/21, F2 still reads a 5-day `dn0..dn4` window. The system now holds swing-speed signals for position-length durations. That is a real mismatch and an expected finding of the next backtest round — not a bug. Note that EXP-005 found F4 (a 5-day momentum reading) to be the single *most valuable* factor, which means whatever small edge the model had was a short-horizon effect; slowing the factors may well remove it rather than improve it, and that is exactly the thing worth measuring.

Regression suite extended to 8 files / 139 tests (added `test_trade_policy.js`, 27 tests). `test_optimizer_fixes.js` now pins `AWO_HORIZON=SWING` explicitly: its hand-computed fixtures encode the old geometry, and four mechanics tests silently began asserting against `null` when the default profile changed — a mechanics test must not change meaning when an unrelated config does.

---

## EXP-2026-08-02-011 — Momentum Lookback × Forward-Horizon IC Grid (10-year data)

**Script**: `scraper/backtest_momentum_lookback_ic.js` (new), on `scraper/modules/cross_sectional.js` (new, 26 tests in `test_cross_sectional.js`)

**Question**: before rewriting F4 (currently `ROC5×0.6 + ROC3×0.4`, a 3-5 day reading) to something position-appropriate, does *any* momentum lookback actually predict forward returns on IDX, and at which horizon? EXP-010 found the blended 6-factor composite has ~zero IC, but a blend can hide a good sub-factor behind bad ones, and it ran on ~2 years. This is the registry's own named next step ("isolate single sub-factor ICs") on the 10-year history.

**Design**: 9 lookbacks × 5 forward horizons (5/10/20/40/60D). No entry timing, no stop, no target, no fees — pure "does this ranking sort future returns", so a signal that fails here cannot be rescued by a timing layer. Canonical trading-date axis from `idx_ihsg_history`; liquidity floor of Rp 5bn median 20-day value (binding: ~101 of 220 tickers pass on a typical date); ≥25 names required per cross-section; tie-aware Spearman IC (ARA/ARB makes exact return ties routine); date-block bootstrap 95% CI. **Weekly sampling (every 5th trading day, 416 ranking dates) is the primary read** — daily sampling makes consecutive dates share nearly all of their forward window, so its CIs are too narrow; daily is reported alongside for comparability with EXP-010.

**Process note — a first run of this experiment was invalid and is superseded by the numbers below.** It reported only 30 ranking dates over 2024-07..2026-07 despite 10 years of price data being present. Cause: `idx_ihsg_history` is the canonical date axis and was still on the cron's rolling `2y` window, so the axis silently capped the study at the old range — the stock data was there and simply unreachable. Fixed by `scraper/backfill_ihsg_history.js` (IHSG now 2412 bars, 2016-08-01..2026-07-31) and re-run. Recorded because the failure mode is invisible: nothing errors, the script just quietly studies a shorter period than it claims.

### Results (weekly sampling, 416 ranking dates, * = bootstrap 95% CI excludes zero)

| Lookback | 20D IC | 40D IC | 60D IC | 60D IR | 60D %pos | 60D D10−D1 |
|---|---|---|---|---|---|---|
| **HI52W** (proximity to 52w high) | **+0.0225 \*** | **+0.0332 \*** | **+0.0440 \*** | 0.25 | 64.9% | +4.42% |
| ROC252_sk21 (classic 12-1) | +0.0128 | **+0.0199 \*** | **+0.0193 \*** | 0.12 | 56.5% | +5.51% |
| ROC120_sk21 (6-1) | +0.0062 | +0.0156 | **+0.0153 \*** | 0.10 | 57.0% | +8.35% |
| ROC252 (raw 12m) | +0.0056 | +0.0076 | +0.0091 | 0.06 | 56.3% | +5.79% |
| ROC120 (raw 6m) | +0.0019 | +0.0039 | +0.0085 | 0.05 | 53.4% | +9.27% |
| ROC60 (raw 3m) | −0.0100 | −0.0168 \* | −0.0101 | −0.06 | 50.5% | +6.19% |
| ROC20 (raw 1m) | −0.0089 | −0.0174 \* | −0.0099 | −0.06 | 51.9% | +3.71% |
| **ROC5** (what F4 reads today) | −0.0138 | −0.0100 | −0.0092 | −0.06 | 50.0% | +1.71% |
| EMA50slope (20d) | −0.0167 | −0.0262 \* | −0.0122 | −0.06 | 47.4% | +4.99% |

Per-year mean IC at 40D, HI52W: `17:−0.072  18:+0.024  19:+0.051  20:−0.061  21:+0.064  22:+0.111  23:+0.117  24:+0.030  25:−0.041  26:+0.122` — positive in 7 of 10 years, and the three negatives are interpretable (2020 = COVID crash, when being near your high was maximally bad).

### Findings

1. **F4's momentum component is mildly ANTI-predictive.** ROC5 has negative mean IC at every horizon, significant at 5D under weekly sampling and at *all five* horizons under daily. This is not a contradiction of EXP-005 (which found F4 the most valuable factor): F4 is not pure ROC5 — it adds RSI reversal modifiers (+8 oversold-bounce, −8 overbought-drop). The reasonable reading is that whatever value F4 carries comes from its *mean-reversion* modifiers, not its momentum term, which is consistent with a raw short-horizon ROC being negatively predictive.

2. **Skipping the most recent month matters.** `ROC252_sk21` and `ROC120_sk21` are significant at 40-60D while their raw counterparts `ROC252`/`ROC120` are not. Same lookback, same data — the only difference is excluding the last 21 days. That is exactly the short-term reversal effect showing up as contamination, and it corroborates finding 1 from the other direction.

3. **Proximity to the 52-week high is the strongest signal found in this project so far.** It is the only factor whose IC is *monotone in horizon* (+0.0225 → +0.0332 → +0.0440 from 20D to 60D), all three significant, with the highest IR (0.25) and the highest share of positive dates (64.9%). Notably it stayed positive in 2026 (+0.122) exactly when classic 12-month momentum crashed (−0.162) — consistent with HI52W measuring resilience/relative strength rather than raw run-up, which is what makes it survive the momentum-crash pattern EXP-010 flagged in decile 10.

4. **EMA50 slope is anti-predictive at 40D** (−0.0262 \*), so F12's trend concept should not be widened into a slope-based directional input.

**Multiple testing**: 45 pairs tested, ~2.3 false positives expected at α=0.05; 6 were significant-positive. HI52W supplies 3 of them, monotone in horizon and stable in sign across 7 of 10 years — that is structure rather than noise. The marginal single-cell survivors should not be treated as established. HI52W would not individually survive a strict Bonferroni correction on CI width; the per-year consistency is the stronger evidence, not the CI.

**Verification**: one date's HI52W 60D cross-section (2022-10-03, 101 names after the liquidity screen) recomputed end-to-end from raw SQL with an independently written O(n²) rank routine and a separate Pearson implementation — IC matched `modules/cross_sectional.spearmanIC` to 6 decimals (0.150187 both ways); BBCA's inputs hand-checked against a separate SQL `MAX(high_price)` query (close 8500, 252-day high 8875, HI52W 95.77 — exact match).

**Status**: The honest size of this is small. IC 0.044 and IR 0.25 are weak; the top decile beats the universe by ~3.1% over 60 days *before costs*, against a ~0.5% round trip, and the whole result is survivorship-biased in the direction that flatters it (the names that went to zero are missing). It is not a tradeable edge as it stands. But it is the first factor in this project to show consistent positive predictive power at all, and it does so at 40-60 days — precisely the horizon the system was reconfigured to on the same day. Worth noting that the 52-week-high effect is a well-documented published anomaly (George & Hwang, 2004), so finding it here is a replication rather than a discovery, which *raises* rather than lowers confidence that it is not a data-mining artifact.

**Decision this drives**: do NOT rewrite F4/F12/F2 as "the same factors, slower" — raw slow ROC has no significant IC and EMA50 slope is negative. Build the position-horizon factor around 52-week-high proximity and skip-a-month momentum instead, and treat F4's reversal modifiers as a separate effect worth isolating rather than collateral damage.

---

## EXP-2026-08-02-012 — Factor Independence, Combination, Turnover, Liquidity Tiers

**Script**: `scraper/backtest_factor_combination_ic.js`. Same universe/axis/screen as EXP-011 (416 weekly ranking dates, median cross-section 84 names after the Rp 5bn liquidity floor). Ranking-only; still no costs, timing or stops — this decides *what factor is worth taking to a real strategy test*.

### 1. The three survivors are not three signals

| pair | mean cross-sectional rank correlation | |
|---|---|---|
| HI52W ~ MOM12_1 | 0.487 | related but distinct |
| HI52W ~ MOM6_1 | 0.559 | related but distinct |
| MOM12_1 ~ MOM6_1 | 0.665 | heavily overlapping |

The two skip-a-month momentum lookbacks are largely the same bet — using both is duplication. HI52W is genuinely a different signal from momentum (r ≈ 0.5), which is what makes it worth having.

### 2. Blending does not beat HI52W alone

| combo | IC 20D | IC 40D | IC 60D | IR 60D | %pos 60D |
|---|---|---|---|---|---|
| **HI52W only** | +0.0210 \* | +0.0315 \* | **+0.0414 \*** | 0.24 | 64.2% |
| HI + MOM12 (70/30) | +0.0223 \* | +0.0330 \* | +0.0407 \* | 0.24 | **66.6%** |
| HI + MOM12 (50/50) | +0.0204 \* | +0.0312 \* | +0.0365 \* | 0.22 | 62.3% |
| all three (equal) | +0.0161 | +0.0263 \* | +0.0291 \* | 0.18 | 58.4% |
| MOM12_1 only | +0.0129 | +0.0198 \* | +0.0192 \* | 0.12 | 56.5% |

Adding momentum to HI52W does not improve IC — it dilutes it. The 70/30 blend buys ~2pp more positive dates for slightly lower IC, essentially a wash. **Use the single factor**; there is no evidence here for a multi-factor blend.

### 3. The effect is TOP-DECILE ONLY, not a smooth ranking

60D forward return by decile (universe mean 1.70%):

`D1 0.6 | D2 2.4 | D3 1.3 | D4 1.3 | D5 1.1 | D6 1.2 | D7 1.1 | D8 1.8 | D9 2.1 | D10 4.1`

Not monotone at any horizon. D3-D7 are flat around 1.1-1.3%, and D1 (0.6%) is not much worse than the middle. Essentially all the information is in **D10 (4.1% vs 1.70% universe, +2.4pp)**.

Two consequences. Negative: no long-short can be built from this — the bottom decile is not reliably bad, so a short leg would add cost and risk without expected return. Positive: **the IC understates the tradeable value**, because IC scores the whole ranking while only the top matters, and D10 at a median cross-section of 84 is ~8 names — exactly the 5-10 position concentrated long-only portfolio the intended style calls for.

### 4. Turnover is the finding that changes everything

| combo | top-decile replaced per week | implied avg membership |
|---|---|---|
| **HI52W only** | **36.8%** | **2.7 weeks** |
| HI + MOM12 (70/30) | 32.8% | 3.0 weeks |
| HI + MOM12 (50/50) | 26.7% | 3.7 weeks |
| all three (equal) | 24.6% | 4.1 weeks |
| MOM6_1 only | 19.0% | 5.3 weeks |
| MOM12_1 only | 14.0% | 7.1 weeks |

HI52W's top decile churns completely every ~2.7 weeks — **below the 2-8 week holding horizon the system was just configured for**. A slot turning over every 2.7 weeks does ~4.4 round trips per 60-day window; at the 0.50% assumed round trip that is **~2.2% of cost against a 2.4pp gross excess**. The edge is very nearly consumed by its own turnover, and no amount of IC improvement fixes that.

This is invisible in EXP-011's IC table and is the single most important number produced so far. Note the inverse relationship across the table: the factors with the strongest IC have the worst turnover, and the slowest factor (MOM12_1, 7.1 weeks) has the weakest IC. The naive "pick the highest IC" choice is the worst cost-adjusted choice.

### 5. It survives in large caps — so it is tradeable at size

| horizon | large-cap half | small-cap half |
|---|---|---|
| 20D | +0.0204 | +0.0257 |
| 40D | +0.0303 | +0.0412 |
| 60D | +0.0416 | +0.0512 |

Stronger in the smaller half, as expected for most anomalies, but clearly present in the liquid half too. This is not an effect that lives only in untradeable names.

### 6. Per-year stability (40D)

`17: −0.066 | 18: +0.002 | 19: +0.021 | 20: −0.061 | 21: +0.055 | 22: +0.111 | 23: +0.122 | 24: +0.031 | 25: −0.029 | 26: +0.124` — 7/10 positive, negatives in 2017, 2020 (COVID) and 2025.

**Status**: HI52W alone is confirmed as the factor to build on — distinct from momentum, present in liquid names, stable in sign across most regimes, and concentrated in a top decile whose size matches the intended portfolio. But its natural turnover very nearly eats the gross excess, so **it is not yet a strategy**. The next question is not "can we find a better factor" but "can the same factor be traded at position-horizon turnover" — i.e. buffering / hysteresis (hold until a name falls out of the top ~20-30% rather than the top 10%), monthly instead of weekly reranking, and blending toward the slower momentum factor purely as a turnover damper rather than as an alpha source. Those are standard, well-understood portfolio-construction techniques, not new bets, and they are cheap to test.

---

## EXP-2026-08-02-013 — Buffered HI52W Portfolio: net-of-cost excess, and a failed walk-forward

**Script**: `scraper/backtest_hi52w_portfolio.js`. The project's first genuine portfolio backtest — positions, cash, costs charged on actual trades, equity curve, drawdown — rather than a per-signal or ranking study. 8 positions, long only, equal cash at entry, trade at T+1 open, buy 0.20% / sell 0.30% (0.50% round trip). Benchmark is the **equal-weighted eligible universe**, not IHSG, so the strategy is not credited with the liquidity/history/survivorship screening it inherits.

**Question**: EXP-012 showed HI52W's top decile earns ~+2.4pp per 60 days but churns every ~2.7 weeks, costing ~2.2% over the same window. Can the same factor be traded at position-horizon turnover and keep a net excess? Levers: rebalance frequency (weekly/biweekly/monthly) × buffer width (drop a holding when it leaves the top 8 / 16 / 24).

### Full-sample grid (2017-08 .. 2026-07)

Universe equal-weight CAGR **1.15%**, maxDD 42.5%. IHSG CAGR 0.59% (context only).

| rebalance | buffer | CAGR | excess | maxDD | ret/vol |
|---|---|---|---|---|---|
| weekly | none | 9.20% | +8.06% | 51.7% | 0.39 |
| weekly | top 16 | 13.03% | +11.88% | 44.2% | 0.61 |
| weekly | top 24 | 12.41% | +11.26% | 45.0% | 0.53 |
| biweekly | none | 10.48% | +9.34% | 42.1% | 0.46 |
| **biweekly** | **top 16** | **13.39%** | **+12.24%** | 37.1% | 0.56 |
| biweekly | top 24 | 4.22% | +3.07% | 43.1% | 0.20 |
| monthly | none | 3.97% | +2.82% | 39.7% | 0.16 |
| monthly | top 16 | 6.98% | +5.84% | 35.8% | 0.28 |
| monthly | top 24 | 7.70% | +6.55% | 41.1% | 0.31 |

All 9 cells positive, mean excess **+8.00%**. Buffering does what it was supposed to: weekly turnover per rebalance falls from 39.1% (no buffer) to 16.7% (top 16), and cost paid over the run falls from 175.8% of starting capital to 88.7%, while CAGR *rises*.

Taken alone this looks like a strategy. **It is not**, and the surface says so before the walk-forward does: biweekly goes +12.24% at top-16 but +3.07% at top-24, a 9pp swing from one adjacent parameter cell to its neighbour. A real edge produces a smooth plateau (the standard EXP-003 applied to AWO Full); this is a cliff, which is the signature of fitting noise.

### Split-half walk-forward — the parameter choice does not transfer

| | Period 1 (2017-08..2022-01) | Period 2 (2022-01..2026-07) |
|---|---|---|
| cells with positive excess | **9 / 9** | **5 / 9** |
| mean excess across all 9 cells | **+10.42%** | **+1.29%** |
| best cell | weekly / top 16 → **+17.96%** | monthly / none → +7.92% |

**The best Period-1 cell (weekly / top 16) delivers −1.58% in Period 2.** The best Period-2 cell (monthly / no buffer) was only the 6th-best cell in Period 1. Any parameter a researcher would have chosen at the halfway point would have underperformed afterwards.

### Findings

1. **The full-sample "+12.24% excess" is an artifact of hindsight** — the maximum of 9 cells fitted on the whole sample. The honest out-of-sample estimate is the Period-2 mean across cells: **+1.29% CAGR excess**, against drawdowns of 25-52%. That is not a strategy; on a risk-adjusted basis it is not clearly better than holding the universe.

2. **The factor itself did not vanish — the tradeable edge did.** The mean excess stays positive in both halves (+10.42% → +1.29%), so HI52W is not noise. But an ~8× collapse between halves is consistent with a published anomaly (George & Hwang 2004) decaying as it is arbitraged, and/or with regime dependence. Notably EXP-011's per-year IC was *strongest* in Period 2 (2022 +0.111, 2023 +0.122, 2026 +0.124) while portfolio excess was weakest — high ranking IC with low tradeable excess points at costs and top-decile-specific weakness, not at the ranking breaking down.

3. **Drawdown, not return, is the disqualifying number.** Every cell runs 25-52% maxDD, versus 42.5% for the universe. The strategy has no risk layer at all: no volatility targeting, no market-regime overlay, no position-level stop, no exposure cap. It is a concentrated long-only book that happens to be rebalanced by a ranking rule. Whatever the return, a 37-52% drawdown makes this untradeable for the intended semi-autonomous use.

**Status**: HI52W is confirmed as a real but weak and decaying signal, and is **not tradeable as a standalone strategy at any tested parameter setting**. Do not promote, do not tune further on this data — tuning is exactly what the walk-forward just falsified.

**Decision this drives**: stop searching the signal axis and move to the risk axis. The recurring gap across EXP-001..013 is that this project has repeatedly tested *what to buy* and has never once tested *how much, when to stand aside, and what caps apply*. Concretely, the next experiments should hold the factor fixed and add, one at a time and each measured against the same benchmark: volatility targeting / inverse-vol sizing, a market-regime exposure switch (reduce or go flat when IHSG is below its own long-term trend — 2020, 2022 and 2026 are where all the damage is), a per-position stop, and a sector/correlation cap. If a 37% drawdown becomes a 15% drawdown at the same modest excess, that is a usable system; if the drawdown cannot be controlled, the factor should be shelved rather than traded.

---

## EXP-2026-08-02-014 — Risk layers on a fixed HI52W book, and the market-timing control

**Script**: `scraper/backtest_risk_layers.js`. EXP-013 showed the disqualifying number is drawdown, not return, and that tuning the ranking does not survive a walk-forward. So the factor and the ranking rule are held **fixed** and risk layers are added one at a time.

**Discipline**: every layer is scored as the **mean across all 9 (rebalance × buffer) cells**, never on a selected cell — EXP-013 proved a hindsight-selected cell delivers −1.58% out of sample. Nothing here is tuned: the 2.5×ATR stop distance is the risk unit already set in `modules/trade_policy.js`, and the regime rule is a plain 200-day SMA.

### Full sample, mean of 9 cells

| layer | CAGR | excess | maxDD | worst cell maxDD | ret/vol | +cells |
|---|---|---|---|---|---|---|
| BASE | 9.06% | +6.67% | 42.21% | 51.69% | 0.39 | 9/9 |
| **REGIME_FLAT** | 6.20% | +3.81% | **30.88%** | **38.91%** | 0.34 | 8/9 |
| REGIME_HALF | 8.02% | +5.63% | 36.41% | 47.06% | 0.39 | 9/9 |
| INVVOL | 5.69% | +3.30% | 41.15% | 50.06% | 0.28 | 8/9 |
| STOP | 5.85% | +3.46% | 41.52% | 51.89% | 0.26 | 9/9 |
| COMBINED | 4.21% | +1.82% | 30.45% | 42.81% | 0.26 | 7/9 |

Split-half maxDD — the transfer test: BASE 36.82% / 37.84%; **REGIME_FLAT 19.15% / 25.48%** (improved in both halves); STOP 29.70% / 36.93% (only the first); INVVOL 35.75% / 34.51% (barely moves).

### Two layers actively hurt

**Per-position stops hurt.** 257 stop exits on average; excess falls 6.67% → 3.46%, ret/vol 0.39 → 0.26, and maxDD barely moves (42.21% → 41.52%). A 2.5×ATR stop on a 2-8 week hold is hit by noise and sells exactly the strong-but-volatile names the factor exists to hold. HI52W is a "keep holding the resilient" rule; a stop is the opposite instruction.

**Inverse-volatility sizing hurts.** ret/vol 0.39 → 0.28, and Period-2 excess −2.43%. This directly contradicts the plausible-sounding hypothesis (carried from Review.md item 7 and the `NO_RISK_MODIFIER` ablation) that ATR belongs in position sizing for this book. It may still belong there for a different signal; it does not help this one.

### The control that reframes everything

The earlier "excess" column compares regime-filtered strategies against an **unfiltered** universe, which unfairly penalises them in a period where standing aside was wrong. The fair control applies the *same* 200-day-SMA rule to the plain equal-weight universe, with no HI52W selection at all:

| variant | full CAGR | full maxDD | P1 CAGR | P1 maxDD | P2 CAGR | P2 maxDD |
|---|---|---|---|---|---|---|
| universe, no regime filter | 3.58% | 41.80% | 5.32% | 41.80% | 5.56% | 37.99% |
| universe + regime FLAT | 3.88% | **25.70%** | 5.13% | **20.25%** | 3.30% | **19.77%** |
| **HI52W + regime FLAT** | **6.20%** | 30.88% | **12.39%** | 19.15% | **5.16%** | 25.48% |

Two things fall out, and they are the most important results in this registry so far:

1. **The regime filter is nearly free drawdown reduction, and it is the single most robust finding across all 14 experiments.** Applied to the whole universe with no selection at all, it cuts maxDD from 41.80% to 25.70% full-sample (41.80% → 20.25% in Period 1, 37.99% → 19.77% in Period 2) while CAGR *rises slightly* (3.58% → 3.88%). It transfers across both halves, needs no parameter search, and is a plain 200-day SMA.

2. **HI52W selection does add on top of it, and it survives out of sample.** Stock-selection contribution above the regime-filtered universe: **+2.33% CAGR full sample, +1.86% in Period 2.** Small — but positive in the recent half, which nothing else in this project has managed. Note this corrects the pessimistic reading of EXP-013's Period-2 number: measured against the fair benchmark rather than an unfiltered one, the selection edge is positive, not zero.

### Where that leaves the system

Period 2 (2022-01..2026-07), the honest out-of-sample window: HI52W + regime FLAT returns **5.16% CAGR at 25.48% maxDD**, versus simply holding the universe at 5.56% CAGR and 37.99% maxDD. Slightly less return, **one third less drawdown** — better risk-adjusted (0.20 vs 0.15 return/maxDD), which is what makes a book actually holdable.

**Status**: this is a real, modest, honestly-measured system for the first time — but most of its value comes from a well-known market-timing rule rather than from anything this project discovered, and stock selection contributes about 2% CAGR. It is not yet fit for semi-autonomous use: a 25-31% drawdown is still severe, survivorship bias remains unquantified and inflates every number here, ARA/ARB is unmodelled (the names this factor wants to buy are disproportionately the ones gapping to auto-reject), and there is still **no sector or correlation cap** — `ft_ticker_sectors` holds 31 US tickers with zero overlap with the 245 IDX names, so 8 stocks near their 52-week high could be 5 commodity names and every number above would be blind to it.

**Decision this drives**: (1) get IDX sector data and re-run with a sector cap — it is the largest unmeasured risk in the book; (2) quantify the survivorship bias by rebuilding a point-in-time universe, or label the CAGR as an upper bound and stop quoting it; (3) model ARA/ARB at entry; (4) do NOT add more risk layers — stops and inverse-vol both made things worse, and the layer that worked needed no tuning at all.

---

## EXP-2026-08-02-015 — Correlation risk model: the concentration fear was wrong

**Script**: `scraper/backtest_correlation_risk.js`. Factor and ranking rule held fixed; 200d-SMA regime filter applied throughout; every variant scored as the mean across all 9 (rebalance × buffer) cells. Correlations from a 252-day window, precomputed on a weekly grid, looked up backward-only (a rebalance may use an estimate up to 4 days stale — never forward).

**Why**: EXP-014 closed with the largest risk in the book unmeasured — there is no IDX sector data, so 8 names near their 52-week high might be 5 correlated commodity stocks and nothing would show it. Sector labels are a crude proxy for correlation, and 10 years of returns give correlation directly.

### The diagnostic answers the question, and the answer is "no"

| | |
|---|---|
| mean pairwise correlation **within** the 8-name book | **0.149** |
| mean pairwise correlation across the eligible universe | **0.154** |
| mean of the most-correlated pair in the book | 0.450 |
| share of rebalances holding any pair correlated > 0.70 | **4.6%** |

The book is, if anything, **marginally less correlated internally than the universe average**. The concentration hypothesis carried since EXP-013 is falsified. HI52W selects names that have held up near their own highs — and on IDX those turn out to be spread across the market, not clustered in one theme.

This also predicts the next result, and it holds: a correlation cap at selection time makes things **worse**, because there was nothing to fix and the cap only removes good candidates. CORRCAP 0.7 takes CAGR 6.20% → 5.25% and ret/vol 0.34 → 0.30; CORRCAP 0.6 is worse still. Neither improves drawdown (30.88% → 30.56% / 30.70%).

### HRP reduces drawdown and costs return — and its headline number is an artifact

Hierarchical Risk Parity (Lopez de Prado 2016) sizing, split-half — the trustworthy read:

| variant | P1 CAGR | P1 maxDD | P2 CAGR | P2 maxDD |
|---|---|---|---|---|
| EQUAL + regime | 12.39% | 19.15% | 5.16% | 25.48% |
| HRP + regime | 11.70% | **16.69%** | 1.30% | **20.57%** |

HRP lowers drawdown in **both** halves and lowers return in **both** halves. In Period 1 that is a good trade (return/maxDD 0.65 → 0.70); in Period 2 it is a bad one (0.20 → 0.06). Mixed, not a win.

**The full-sample table appeared to show HRP at 10.18% CAGR versus EQUAL's 6.20% — that number must not be quoted.** Two checks show why:

1. **Per-cell dispersion**: HRP's 9 cells run `2.7 / 6.8 / 4.1 / 6.2 / 5.3 / 0.0 / 16.2 / 17.4 / 32.8%` — a 32.8pp spread with a median of 6.2%, versus EQUAL's 12.7pp spread and 5.7% median. The mean is carried by three outlier cells; the median difference is 0.5pp, not 4pp.
2. **Composition check**: for a single cell, full-period total return does not equal the product of its two half-period returns — gaps of −36% to −67%. This is not a simulation bug: the split runs start from cash at the midpoint, and for a *buffered* strategy the carried-over holdings change every subsequent keep/fill decision, so the continuous run and the fresh run are genuinely different portfolios after a few rebalances. But it means **a mean of CAGRs across 9 divergent paths does not compose**, and the full-sample row cannot be read as summarising the two halves.

**Methodological rule this establishes**: for path-dependent strategies, report the median across cells alongside the mean, and treat the two independent half-period evaluations as the primary evidence. A full-sample mean over divergent paths is the least reliable number on the page, and it is the one that looked best.

**Status**: The correlation cap is rejected — there was no concentration to cap. HRP is not adopted: it buys drawdown reduction at a return cost that is favourable in one half and unfavourable in the other, and its apparent full-sample advantage does not survive inspection. The book stays equal-weighted with the 200d-SMA regime filter, unchanged from EXP-014.

**What this closes**: the "no sector data" gap flagged in EXP-014 is now measured rather than feared, and the answer removes it from the risk list. What remains genuinely unquantified is survivorship bias and ARA/ARB execution — both larger than the concentration risk that turned out not to exist.

---

## 2026-08-02 — Infrastructure: broker/bandarmology history extended 6.5 months → 2.5 years

Not an experiment. Recorded because it unblocks the broker factors (F1/F2/F6/F7/F8), which every experiment from EXP-011 onward had to exclude — making all of them, in effect, price-only models.

**Two separate gaps, only one of which cost API calls:**

1. **`idx_broker_summary` already held raw data back to 2025-06-02** that had never been converted to concentration — `autoCalculateConcentration` only started running in Jan 2026. Recovered by re-running `POST /api/calc-concentration {force:true}` over 155 dates. **Zero API calls.** Check this table before ever assuming broker history is missing.
2. Index Alpha serves broker data back to **2024-01-02**. Pulled via the new `scraper/backfill_broker_history_dates.js`: 116 liquid tickers × 328 trading days = 38,048 calls, 0 failures, 0 rate limits, ~3 hours.

**Cost model, verified — do not re-derive:** the API's `from`/`to` parameters return a **SUM over the range, not a per-day series** (BBCA broker ZP: `buy_freq` 2,527 for one day vs 17,126 for the same week; no per-row date field). There is no range shortcut — one call per ticker per day, always.

### Result

| | before | after |
|---|---|---|
| `idx_concentration` dates | 123 | **605** |
| earliest | 2026-01-19 | **2024-01-02** |
| `idx_broker_summary` rows | 1.94M | **3.61M** |
| dates usable (concentration ∧ price) | 123 | **605** |

### Data quality — checked, not assumed

The three periods have different provenance (API backfill / free recompute / original FT.id-overwritten), so the obvious failure mode is a silent scale break that would corrupt any cross-period factor study. It was checked and **there is none**:

| period | n | sd(dn0) | p50 \|dn0\| | p90 | avg pos / neg |
|---|---|---|---|---|---|
| NEW 2024-01..2025-06 (self-computed) | 36,880 | 18.23 | 14.0 | 29.1 | +15.06 / −15.60 |
| RECOVERED 2025-06..2026-01 (self-computed) | 32,969 | 17.29 | 12.7 | 27.4 | +14.03 / −14.43 |
| ORIGINAL 2026-01-19 on (FT.id) | 26,903 | 17.96 | 9.8 | 26.1 | +12.06 / −13.49 |

Cross-sectional mean |dn0| runs smoothly across the 2026-01-19 boundary (13.9, 13.3, 12.8, 13.9 → 14.0, 15.5, 15.5) with no level shift. `dn1..dn4` are present on **100%** of rows in every period, so F2's five-day series works throughout.

**Two caveats that must travel with any result built on this:**

- **84 rows breach the documented ±100 bound**, all in the FT.id-sourced ORIGINAL period (0.31%), and they are **date-clustered rather than diffuse** — 69 of 84 fall on 2026-06-03 and 2026-06-04 alone. These are bad FT.id pull days, not a scale difference. Clip to ±100 or exclude those dates.
- **Coverage per date is uneven and lower in the new period**: ~113 tickers/date for 2024-01..2025-06 (a deliberate liquid-universe choice to fit the quota) versus ~213 for the recovered period, and highly variable in the original period (FT.id pulls cover all ~865 IDX names when they succeed, ~114 when they fail). A cross-sectional IC computed on 113 names is not strictly comparable to one on 219. In practice the Rp 5bn liquidity screen already reduces every backtest to ~100 names, so the binding constraint is unchanged — but it must be stated, not assumed away.
- One orphan date (2026-06-01) has concentration with no matching broker-summary rows.

**What this unblocks**: the broker factors can now be tested as a factor family in their own right, over 2.5 years, using EXP-011's method — the question being whether broker concentration predicts forward returns on IDX at all, and at what horizon. This is the one edge genuinely specific to this market, and EXP-012 established that the price-momentum family is internally correlated 0.49–0.67, so a genuinely orthogonal signal source is exactly what the factor set lacks. EXP-005's ablation already hinted F1/F2 help; it has never been testable until now.

---

## EXP-2026-08-02-016 — Broker/Bandarmology Factor IC Grid: the sign is inverted

**Script**: `scraper/backtest_broker_factor_ic.js`. First possible run of this test — `idx_concentration` only reached back far enough after the same-day backfill. 605 dates (2024-01-02..2026-07-31), 145 tickers with ≥200 days of concentration, median cross-section 91 after the Rp 5bn liquidity screen, 98 weekly / 487 daily ranking dates. Ranking-only: no timing, stop, target or fees.

**Design**: separates three things the project had always conflated — raw signal vs the production transform (DN0 vs F1_SCORE), magnitude vs consistency (DN0_MA20 vs POSFRAC_20), and short vs long persistence (MA5 / MA20 / MA60). The last split is the point: the actual bandarmology thesis is *persistence* — a large buyer accumulating quietly over weeks — and nothing in the system had ever tested it. F2 reads five days, F8 a short streak; both far shorter than the 2-8 week horizon now traded.

### Result: every broker signal is significantly NEGATIVE, and longer windows are more negative

Weekly sampling, `*` = bootstrap 95% CI excludes zero:

| signal | IC 20D | IC 40D | IC 60D | IR 60D | %pos 60D | D10−D1 60D |
|---|---|---|---|---|---|---|
| DN0 (today) | −0.0200 | −0.0195 | −0.0152 | −0.13 | 43.9% | +0.38% |
| DN0_MA5 | −0.0306 \* | −0.0478 \* | −0.0510 \* | −0.43 | 33.7% | −4.55% |
| DN0_MA20 | −0.0420 \* | −0.0783 \* | −0.0771 \* | −0.63 | 22.4% | −6.11% |
| DN0_MA60 | −0.0711 \* | −0.0944 \* | −0.0978 \* | −0.78 | 23.5% | −7.97% |
| POSFRAC_20 | −0.0477 \* | −0.0829 \* | −0.0814 \* | −0.62 | 18.4% | −7.11% |
| **POSFRAC_60** | **−0.0808 \*** | **−0.1024 \*** | **−0.1052 \*** | **−0.83** | **16.3%** | **−10.95%** |
| STREAK | −0.0269 \* | −0.0389 \* | −0.0363 \* | −0.28 | 39.8% | n/a |
| NETFLOW_20 | −0.0357 \* | −0.0702 \* | −0.0701 \* | −0.58 | 24.5% | −4.21% |
| F1_SCORE (production) | −0.0200 | −0.0195 | −0.0152 | −0.13 | 43.9% | +0.38% |
| F2_SCORE (production) | — | ≈−0.045 | — | — | — | — |

Per-year mean IC at 40D — **the sign does not flip once, in either sampling**:

```
signal          2024    2025    2026        (daily sampling in brackets)
DN0_MA60      -0.063  -0.122  -0.083   [-0.062 -0.116 -0.096]
POSFRAC_20    -0.027  -0.125  -0.085   [-0.030 -0.122 -0.089]
POSFRAC_60    -0.065  -0.136  -0.087   [-0.065 -0.128 -0.100]
```

### What this means

**Stocks whose top-3 brokers have been persistently net buyers over 1-3 months subsequently underperform — and the more persistent and consistent the "accumulation", the worse the forward return.** POSFRAC_60, which measures pure consistency and ignores magnitude entirely, is the strongest signal in the grid.

For scale: this is **the strongest relationship found anywhere in this registry.** POSFRAC_60 at 60D has |IC| 0.105 and |IR| 0.83, against HI52W's best of +0.044 / 0.25 — roughly 2.4× the IC and 3.3× the information ratio. It is simply pointing the other way.

Three candidate explanations, none tested here:
1. **"Accumulation" is frequently distribution.** A bandar exiting into retail demand appears as broker-side net buying while the beneficial owner sells; a broker warehousing inventory looks identical until it unloads.
2. **Crowding / late signal.** By the time concentration has been visibly persistent for 60 days, the move has already happened and what follows is mean reversion.
3. **`dn0` measures concentration of *activity*, not informed buying** — it may simply not be the quantity practitioners mean.

**The production factors are the weakest members of the family.** F1 (`IC −0.0195` @40D) reads one day; F2 reads five. The signal lives at 20-60 days, which neither looks at. F1_SCORE's IC is *identical* to DN0's at every horizon — expected, since `f1_concentration` is a monotone transform of `dn0` and Spearman is rank-based, and a useful confirmation that the implementation is correct.

**A tooling bug this run exposed**: the script's verdict block originally tested only for *positive* significant IC and duly printed "no broker signal sorts forward returns" above a table of strongly significant negative ones. Fixed to report both directions. A factor that reliably sorts returns the "wrong" way is information, not its absence — and an automated verdict that can only see one sign will hide the most valuable finding on the page.

### Status and caveats

**Do not trade this yet.** What is established is a *ranking* relationship, on 2.5 years spanning only 3 calendar years, ~91 names, survivorship-biased, with no costs, timing or stops. EXP-013 is the cautionary precedent: a positive IC of comparable size died completely once turnover and a walk-forward were applied.

Also note what a negative IC can and cannot become on IDX: retail cannot readily short, so the usable form is a **veto on the long book** — avoid names showing persistent broker accumulation — not a short leg.

**Decision this drives**: test POSFRAC_60 as a veto overlay on the existing HI52W + regime-filter book, using the EXP-013/014 harness unchanged (mean across all 9 cells, split-half walk-forward, net of costs). That is a small, well-defined change to a book that already exists, and it is the first time this project has had two signals with genuinely different sources to combine — EXP-012 having established that the price-momentum family is internally correlated 0.49-0.67 and adds nothing to itself.

---

## EXP-2026-08-02-017 — Broker veto on the HI52W book: the first result to pass every control

**Script**: `scraper/backtest_broker_veto.js`. HI52W ranking and the 200d-SMA regime filter held FIXED; 8 positions; mean *and median* across all 9 (rebalance × buffer) cells; split-half walk-forward; net of costs.

**Window caveat, read first**: concentration data begins 2024-01-02 and POSFRAC_60 needs 60 days of it, so this runs on **2.2 years** versus EXP-013/014's ~9. The BASE row is re-run on the same shortened window; its numbers deliberately do not match EXP-014's.

**Question**: EXP-016 found persistent broker accumulation predicts underperformance (POSFRAC_60, IC −0.105, IR −0.83). Retail cannot short on IDX, so the usable form is a veto — don't buy names showing it. Does that survive costs and a walk-forward?

### Three controls, all passed

| variant | CAGR | excess (median) | maxDD | ret/vol | +cells |
|---|---|---|---|---|---|
| BASE (no veto) | 7.48% | −0.54% (−1.50%) | 18.12% | 0.36 | 4/9 |
| RANDOM 20% *(control)* | 7.33% | −0.69% (−0.47%) | 16.60% | 0.36 | 4/9 |
| REVERSE bot 20% *(control)* | — | **−6.14%** | — | — | — |
| REVERSE bot 30% *(control)* | 2.80% | **−5.22%** (−6.99%) | 18.15% | 0.14 | 1/9 |
| VETO top 30% | 16.38% | +8.35% (+12.01%) | 15.20% | 0.80 | 6/9 |
| **VETO top 20% +exit** | **16.73%** | **+8.71% (+11.44%)** | **13.83%** | **0.83** | **7/9** |

**1. Dose response is smooth and monotone** — the earlier impression that 10% hurt while 20% helped was a gap in the grid, not a real reversal:

```
5%: −4.52   10%: −3.16   15%: +1.02   20%: +1.97   25%: +2.65   30%: +8.35   40%: +7.09
```

Rising monotonically 5% → 30%, then saturating at 40%. The small doses are near-noise for a mechanical reason: vetoing 5-10% of ~91 names rarely removes anything that would have reached the top-8 HI52W list anyway.

**2. The random control does nothing.** Vetoing a seeded-random 20% gives −0.69% versus BASE's −0.54% — indistinguishable. So the benefit is not the mechanical effect of removing candidates and changing turnover.

**3. The reverse control hurts, which is the decisive one.** Banning the *least*-accumulated names costs 5-6pp of excess, while banning the *most*-accumulated gains 8-9pp. The effect is directional, tied to the sign of the signal, and not an artifact of filtering per se.

Additionally the **median across cells exceeds the mean** (+11.44% vs +8.71%) — the opposite of EXP-015's failure mode, where a mean was carried by three outlier cells. And drawdown improves alongside return (18.12% → 13.83%), which is unusual and welcome.

### What is NOT established

**The strategy still loses to the universe in the first half.** Every single variant has negative P1 excess — the best is −2.50%. All positive excess comes from P2:

```
                    P1 excess   P2 excess
BASE                  −7.45%      +2.84%
VETO top 30%          −2.50%      +7.88%
VETO top 20% +exit    −3.86%     +12.43%
```

"Beats BASE in both halves" is true. "Beats the universe in both halves" is **false**. The veto reliably makes the book *less bad* in P1 and clearly better in P2, but a strategy that underperforms its own universe for a year is not yet something to trade.

Other limits: 2.2 years total (each half ~1.1 years), 12 variants tested with the best selected, ~91-name cross-section, survivorship-biased throughout, and VETO 40% swings from −9.38% in P1 to +16.80% in P2 — instability that argues against reading any single cell precisely.

### This is the data ceiling

Concentration cannot be extended further: Index Alpha serves back to 2024-01-02 and no earlier (verified 2026-08-02), and there is no other source of IDX broker-summary history. **More backtesting cannot resolve the remaining uncertainty** — the sample simply does not exist.

**Decision this drives**: stop backtesting this and start forward-testing it. The project already has exactly the right infrastructure for a question of this shape — `awo_paper_trades`, the frozen-challenger mechanism, and promotion gates requiring ≥30 resolved trades, ≥20 calendar days, positive avg net R and profit factor ≥1.10. That machinery was built in the 2026-07-31 review rounds and has never had a candidate worth putting through it. This is the first one.

Recommended configuration to freeze: **HI52W top-8 + 200d-SMA regime filter + POSFRAC_60 top-20% veto with forced exit**, biweekly rebalance, buffer ×2. Not because that cell is the maximum — it is, which is exactly why it should be treated as an upper bound — but because it sits in the middle of a smooth dose plateau (20-30% all work) rather than on a spike, and because the +exit variant is the one whose advantage holds in both halves and across the most cells (7/9).

---

## EXP-2026-08-02-018 — Harmonic conviction has no predictive power, and its heaviest input is inverted

**Script**: `scraper/backtest_harmonic_conviction_ic.js`. Replays `detectHarmonicPatterns` + `calcUltraConviction` at historical as-of dates using the production 180-bar window, every 10 trading days, over 245 tickers and 10 years. 2,112 fresh pattern instances (D-point formed within 5 bars). Forward returns net of the 0.50% round trip, direction-adjusted so a BEARISH setup is scored against a fall.

**Context**: this experiment was proposed on the reasoning that harmonic patterns are event-driven and rare (low turnover — the problem that killed HI52W), plausibly orthogonal to both momentum and broker flow, and carry natural structural invalidation levels. All three arguments were sound. The data does not support the conclusion.

### Finding 1 — read the level before the ranking

Mean forward return across all 2,112 patterns, after costs:

| horizon | 20D | 40D | 60D |
|---|---|---|---|
| mean return | **−0.44%** | **+0.06%** | **−0.00%** |

**Harmonic patterns produce essentially nothing after costs, at any horizon.** Not negative enough to fade, not positive enough to trade. Whatever the score says about *which* patterns are better, the population it ranks has no edge to distribute.

This directly contradicts what the application currently tells users. `modules/conviction.js` displays *"Smart money confirmed — 73%→87% win rate, replicated across 2 market regimes"* and *"ABCD pattern — largest validated sample (695 events), ~73-75% win rate"*. Those figures came from `backtest_harmonic_winrate.js`, whose own header flags them provisional, computed under the F4/F6/F7/dn0 formulas fixed on 2026-07-28 and never regenerated. A population with a genuine 73-87% win rate does not produce a 0.06% mean return.

### Finding 2 — the inversion hypothesis holds

IC of the conviction score against forward return at 40D:

| variant | IC 20D | IC 40D | IC 60D |
|---|---|---|---|
| **AS_IS** (production) | +0.0041 | **−0.0179** | −0.0185 |
| **INVERTED** (broker data sign flipped) | −0.0089 | −0.0020 | −0.0066 |
| **OFF** (broker_flow weight 0) | +0.0083 | **+0.0014** | −0.0037 |

Per-year IC at 40D, restricted to the years where broker data actually exists:

```
              2024     2025     2026
AS_IS        +0.032   -0.005   +0.040
INVERTED     +0.055   +0.071   +0.234
OFF          +0.074   +0.063   +0.050
```

2017-2023 are byte-identical across all three variants — `idx_concentration` begins 2024-01-02, so before that `broker_flow` contributes nothing and the variants collapse to the same score. That is a useful internal check that the harness is doing what it claims.

In every year where the component is live, **removing or inverting broker_flow beats leaving it as-is.** That is consistent with EXP-016: `calcUltraConviction`'s E1 block awards +10 when the last three dn0 readings are all positive for a bullish setup, and persistent positive dn0 is precisely what EXP-016 measured as predicting underperformance. The heaviest category in the score — 30 of 100 points, more than harmonic, smc, wyckoff or volume_profile — is awarding its points backwards.

**Caveat on the strength of that claim**: `idx_broker_flow_detail` only starts 2025-12, so `foreignNet`/`bigMoneyNet` are zero for almost the whole sample and this is effectively a test of the E1 concentration component alone. The 2026 INVERTED reading of +0.234 is a small-sample outlier and should not be quoted.

**Status**: the harmonic layer is **not a promising direction**, and the argument that it was — made before testing it — was wrong. It is a production signal source: the nightly cron auto-saves its top 20 patterns into `ft_recommendations` every night, and the UI presents win-rate claims for it that this experiment does not support.

**Decisions this drives**:
1. Remove or heavily qualify the 73-87% win-rate text in `modules/conviction.js`. It is displayed to a user as an established finding and it is not one.
2. Set `broker_flow` weight to 0 in the harmonic scan pending a redesign. Inverting it scores marginally better than leaving it, but building on a component whose only virtue is being backwards is not a design — removing it is the honest interim.
3. Do not integrate harmonic into the HI52W book. There is nothing to integrate.

---

## EXP-2026-08-03-019 — Same-day entry/exit on IDX: negative everywhere, and our own picks are worse than average

**Question asked by the project owner**: take the system's recommendations, enter an hour after the open, and auto-close at −2%, at +10%, or at that day's close — does that work?

**Script**: `scraper/backtest_intraday_signal_rule.js`. Daily OHLC, entry at the next bar's open (the T+1 convention used everywhere in this codebase, and a proxy for a 10:00 entry — it slightly *overstates* stop hits because it includes the 09:00–10:00 window, and does not flatter the target side at all). Same-bar ambiguity resolves to STOP, as everywhere else. Cost 0.50% round trip.

### Step 1 — the unconditional base rate, 118,463 stock-days, 2 years

| outcome | share |
|---|---|
| hit −2% stop | 39.3% |
| hit +10% target | 2.2% |
| neither → exit at the close | 58.5% |

**avg net −0.673% per trade, profit factor 0.482, win rate 25.1%.**

The asymmetry is not a tuning problem. A sweep of stop ∈ {2,3,4,5,6,8}% × target ∈ {3,5,7,10}% produced **24 negative cells out of 24**, from −0.705% to −0.840%. Backing the 0.50% cost out, the average IDX stock drifts about **−0.2% from open to close**: the market's positive drift lives overnight, not inside the session. No same-day exit rule survives that, at any parameter.

### Step 2 — the only way it could have worked, and it did not

The base rate is a property of the average stock. The rule could still work if the *selection* had positive intraday drift. It has the opposite.

| selection | n | stop rate | target rate | avg net | t | PF |
|---|---|---|---|---|---|---|
| every signalled day | 18,162 | 43.2% | 1.6% | −0.847% | −48.97 | 0.391 |
| BUY + STRONG BUY | 2,204 | 48.9% | 1.6% | **−0.951%** | −18.54 | 0.368 |
| STRONG BUY only | 14 | 85.7% | 0.0% | −1.982% | −3.84 | 0.146 |

BUY days are **worse than the unconditional base rate**, not better (−0.951% vs −0.673%). Raw open-to-close on BUY days is −0.351% gross against a market average near −0.2%. Widening to the least-bad sweep cell (8% stop / 7% target) does not rescue it: −1.022%.

This is coherent rather than surprising. The signals fire on strength, those names open at a premium, and the premium decays through the session. Buying the open and selling the close is a systematic way to capture exactly the worst hours of holding them.

### What this does NOT say

It does not say the signals are bad. It says they are **not intraday signals**. The system's horizon is 2–8 weeks (`modules/trade_policy.js`, POSITION); this experiment measures a one-day slice of that and finds the slice negative. A signal can be right over 40 bars and lose over 1.

**Caveats**: `idx_signal_history` only spans 2026-01-19 → 2026-07-31, ~6.5 months and one regime. STRONG BUY n=14 is not a sample and is reported only for completeness. The base-rate sweep carries the same survivorship-biased universe as every other experiment here (see review P0.2, open).

**Status**: **closed, negative.** No intraday harness was built. The question was answerable retrospectively with n=2,204 and t=−18.5, which is why it was answered before building anything.

**Decisions this drives**:
1. Do not add a same-day auto-close rule to the journal in any parameterisation.
2. Any future intraday work must first demonstrate positive intraday drift on the selection — that is the binding constraint, not the exit rule.

---

## EXP-2026-08-03-020 — Removing the universe look-ahead (review P0.2), and what EXP-017 looks like without it

Eight loaders screened their ticker universe with whole-sample counts before any date loop began — `placed >= 400 || nConc >= 200` in four, `nConc >= 200` in one, `placed >= WARMUP + 100` in three. Every one asks whether a ticker will *eventually* accumulate enough data by the end of the sample, which cannot be answered as of any decision date. `modules/strategy_book.js` was clean and says so in its header ("ALL INPUTS ARE AS-OF"), but the look-ahead lived in the **loader**, which was never centralised — so the Map arrived pre-filtered with future knowledge and the module's guarantee was vacuous.

Replaced with as-of terms evaluated per decision bar: real bars inside the trailing 252-day window (`minHiWindowBars = 200`), and POSFRAC_60 computable at that bar (`requirePosfrac`). The stale `i < hiBars` axis-position test went too — it tested a position on the shared IHSG date axis, not the ticker's own history, and was wrong for any name that listed after the axis began.

### The single diff is uninterpretable, so each term was measured alone

Removing the screen ADMITS names; both new terms EXCLUDE them. The net −3.50pp attributes nothing, so `measure_universe_lookahead.js` runs each configuration in isolation on one loader, same dates, same execution:

| config | CAGR | maxDD | trades | avg eligible |
|---|---|---|---|---|
| A — old: lifetime screen, no as-of terms | 23.76% | 11.39% | 266 | 97.4 |
| B — look-ahead removed, no as-of terms | 25.22% | 14.82% | 280 | 100.5 |
| C — B + minHiWindowBars=200 | 27.55% | 14.82% | 274 | 99.2 |
| D — C + requirePosfrac (**shipped**) | **20.26%** | 13.45% | 272 | 90.0 |
| E — D **plus** the lifetime screen (diagnostic) | 25.37% | 13.44% | 268 | 89.5 |

**E − D = +5.10pp.** That is the honest price of the look-ahead: with the as-of terms in place, letting the universe be chosen with knowledge of the future is worth 5.1 points of annual return that was never available in real time — roughly a fifth of what was previously reported.

Two results worth not smoothing over. A→B is **+1.46pp**: removing the screen *on its own* improved returns, so the bias was not a simple one-directional inflation — its sign flips depending on whether the as-of terms are present. And C→D is **−7.29pp**: requiring broker coverage is by far the most expensive term, which says the names we have no bandarmology for were performing well. Coverage is not random with respect to returns.

### EXP-017 re-run on the corrected universe

| | before | after |
|---|---|---|
| best variant excess | +8.71% | **+6.20%** |
| best variant CAGR | 16.73% | 14.02% |
| maxDD | — | 13.61% |
| beats BASE | YES | YES (+11.64%) |
| beats RANDOM control | YES | YES (+11.56%) |
| NO_FILL | 0.00% | 0.00% |

It still clears all three mechanical controls, and the reverse control still hurts as it should (−11.10% vs BASE −5.44%).

**But the split-half check was flattering itself, and that is the more important finding.** The test asked "beats BASE in both halves" and answered YES — while P1 excess was **−6.84%**. It beats a baseline that loses 13.04%, so both are losing to the benchmark; the entire positive excess comes from P2 (+18.58%). A stricter criterion, *positive* excess in both halves, was added and **it answers no**.

The dose-response also stopped being clean at the low end: vetoing the top 5% gives −7.31% excess, *worse* than not vetoing at all (−5.44%). It rises monotonically from there (−4.26 → −2.08 → +0.97 → +5.79 → +5.98), but a curve that dips below zero-dose before climbing is more consistent with a concentration/turnover effect than with the top-accumulated names specifically underperforming.

**Status**: EXP-017 remains the best candidate in the registry and remains **not proven**. The corrected numbers are lower, the strongest control now returns "no", and the survivorship component of P0.2 is untouched and untouchable — see below.

### What this does NOT fix

Survivorship, which is baked in at **ingest**, not at screen time. `backfill_price_history.js` fetches only for `SELECT DISTINCT stock_code FROM idx_broker_summary`, populated solely from the 245 hardcoded names in `modules/tickers.js` — from which 12 were deleted 2026-07-22 for being "almost certainly suspended/delisted" (BOSS, ERPT, FASW, FREN, LOTTE, MASA, SCPI, SMCB, SRIL, TELE, WIKA, WSKT). Those are exactly the names that blew up. No as-of predicate can restore a row that was never written; checked, and 12/12 have zero concentration rows. **Every `*** SURVIVORSHIP-BIASED RESEARCH RESULT ***` banner stays.**

---

## EXP-2026-08-04-021 — Against the universe it selects from, the strategy adds nothing

Review P0.5 warned that benchmarking the forward test against IHSG could let the strategy clear its gate on the strength of its SCREEN while the SELECTION added nothing, because the universe is already filtered for liquidity, price-history depth and broker coverage. Once the benchmark was implemented and the ledger accounting corrected, that stopped being a warning and became a measurement.

Replay over 41 decisions, 20.5 months, 90 fills, on the point-in-time universe with the corrected ledger:

| | |
|---|---|
| Portfolio return | **+3.28%** |
| Eligible universe (primary benchmark) | **+3.57%** |
| **Excess vs universe** | **−0.29%** |
| IHSG (secondary) | −13.57% |
| Excess vs IHSG | **+16.85%** |
| Information ratio vs universe | **−0.05** |
| Profit factor | 1.06 |
| Max drawdown | 19.92% |
| Turnover | 56.3% of the book per rebalance |

**The +16.85% against the index is real and almost none of it is stock picking.** IHSG fell 13.57% while the set of names that merely *passed the screen* rose 3.57%. Being in liquid, established, broker-covered names — plus standing aside when the index was below its 200-day average — accounts for essentially the whole gap. The portfolio built by ranking and vetoing inside that set returned 3.28%, which is 0.29 points *behind* holding the set itself.

This is consistent with EXP-020's decomposition, which found the 52-week-high ranking alone returns −0.88% and that the veto is what carries the backtest. It is not consistent with reading +16.85% as evidence of selection skill, and nothing in the earlier numbers separated the two, because the forward test benchmarked against the index while the backtest benchmarked against the universe. Those were never comparable figures.

### Caveats, and they are large

- **REPLAY, not live.** Decisions made from as-of data but recorded in one pass; it never faced a data outage or a real execution.
- **Different window from EXP-020** (2024-11-13 → 2026-07-30 versus 2024-04-03 →2026-07-30), so the numbers are not a restatement of it.
- **The universe leg is fully invested at all times** while the strategy stands aside 45% of the time, so this excess bundles the SELECTION with the TIMING. During a decline standing aside flatters the comparison; during a rise it penalises it. EXP-020 separates the components; this does not.
- Survivorship bias at ingest is untouched and untouchable — see EXP-020.

**Status**: this does not overturn EXP-017, whose mechanical controls still pass. It removes the number most likely to be misread. The honest one-line summary of the candidate is now: *it has kept pace with a well-chosen universe while avoiding a falling index, and there is no measured evidence that its stock selection adds value on top of the universe it draws from.*

**Decisions this drives**:
1. The promotion gate's excess criterion reads the universe benchmark, not the index. On this record it fails, correctly.
2. Any future claim about this strategy quotes excess vs universe first. Excess vs IHSG is reported second and never alone.

---

## EXP-2026-08-04-022 — Correction to EXP-021: weight-based accounting overstated the return by 2.67 points

EXP-021 was measured one day before the ledger became self-financing. It recorded a WEIGHT fixed at entry, which cannot express a portfolio — weights do not drift with price, so a book that doubles still reports the weights it opened with. The 2026-08-04 12:33 review gave the worked example: half stock and half cash, stock 100 → 200 → 300, actual NAV 1.00 → 1.50 → **2.00**, but compounding the per-period weighted returns (+50%, then +25%) gives **1.875**.

The ledger now records units and cash flows. NAV is cash plus units times price, period return is `NAV[t] / NAV[t-1] − 1`, and that single series feeds the gate, the information ratio and the drawdown. Costs need no separate term: a buy leaves cash as cost basis and returns fewer units, a sell returns proceeds already net of fees, so fees are inside the NAV path by construction — the old code added an explicit cost term on top of a weighted price move, which double-counted in some periods and missed entirely in others.

Same window, same decisions, same 90 fills:

| | EXP-021 (weight-based) | corrected (self-financing) |
|---|---|---|
| Portfolio return | +3.28% | **+0.61%** |
| Eligible universe | +3.57% | +3.57% |
| **Excess vs universe** | −0.29% | **−2.96%** |
| Excess vs IHSG | +16.85% | +14.17% |
| Information ratio vs universe | −0.05 | **−0.11** |
| Max drawdown | 19.92% | 20.54% |
| Profit factor | 1.06 | 1.06 |

**The weight-based figures were 2.67 points too generous.** EXP-021's conclusion is unchanged in direction and stronger in degree: over 20.5 months the strategy trailed the universe it selects from, now by 2.96 points rather than 0.29, with a negative information ratio.

The +14.17% against IHSG remains real and remains almost entirely the SCREEN plus the regime timing, not the stock picking — the set of names that merely passed the screen returned +3.57% while the index fell 13.57%.

A second defect the same rewrite fixed: buying capacity was `1 − committedWeight`, which is blind to realized P&L. After a 20% realized loss the system would still authorise a full notional 1.0 against a NAV of 0.80 — 125% leverage funded by nothing. Buying is now limited by cash that exists, and `mark` prints a loud warning if cash ever goes negative.

**Caveats are unchanged from EXP-021** and still large: REPLAY not live, a different window from EXP-020, the universe leg is fully invested while the strategy stands aside 45% of the time so this bundles selection with timing, and ingest-level survivorship is untouched.

**Status**: supersedes EXP-021's numbers. EXP-021 is left in place per the append-only convention; read this entry for the figures.

---

## Open follow-ups (not yet done)

- **Re-run EXP-001 through EXP-010 on 10-year data under both horizons** — this is now the highest-value open item. The headline finding ("AWO Full is worse than random entry") was established on a single ~2-year regime with a 15-bar exit; both of those constraints are gone. Report SWING and POSITION side by side rather than replacing one with the other, and label everything survivorship-biased.
- **Slow the factors to match the horizon** (F4 → ROC60/ROC120 with the 12-1 skip-a-month convention, F12 → EMA20/50, F2 → 20-60 day concentration window) and ablate against the unchanged versions. Until this lands, POSITION is holding swing-speed signals.
- **Broker factors cannot follow the price history back.** `idx_concentration` starts 2026-01-19 (~6.5 months), so F1/F2/F6/F7/F8 are hard-capped there regardless of the price backfill. Any 10-year test is necessarily a price-only model; the bandarmology overlay can only ever be tested on the recent window and must be reported as a separate, clearly-labeled experiment (this is Review.md's EXP-016 "Broker overlay: Base vs Base+F1 vs Base+F2").
- **Move F14 from score multiplier to position sizer.** `riskModifier` currently multiplies the composite score, pulling volatile names toward neutral; Review.md item 7 explicitly says ATR should size the position, not change the signal. This is also the standard remedy for the momentum-crash pattern EXP-010 found in decile 10, and `NO_RISK_MODIFIER` was the single largest ablation improvement (+0.085R at 5× signal volume) — three separate findings pointing at one fix.
- **Audit the 10-year data for IDX corporate actions** — rights issues, symbol changes, and suspensions are not handled by Yahoo's split-adjusted `quote` series.


- **Validate EXP-005/006's ranking on Period 1 vs Period 2 split** (same discipline as EXP-004) — do F6/F7 stay the worst and F4/F12 stay the best in both halves, or is this ranking itself period-specific?
- **Formal significance testing** on the largest deltas (F4, F12, F3 helpful; F9, F6, F11 harmful; Risk Modifier) — two-proportion z-test + Bonferroni, matching the rigor standard set by the 2026-07-19 overfitting incident, before treating any of these as confirmed rather than suggestive.
- **Investigate the Risk Modifier finding** — why is it suppressing 5x the volume without improving quality proportionally? Worth checking whether `computeRiskModifier`'s ATR-percentile mapping is well-calibrated for this data.
- Sanity-check the replay pipeline itself for a possible implementation bug before fully trusting the magnitude, even though it reuses tested production functions.
- None of this has been checked against Advance.md's own release gate (§8: OOS Profit Factor ≥ 1.20) — every result so far is well below that bar (best profit factor found: 0.29, EXP-003).
- Advance.md §14 checklist status after EXP-004/005: items #4, #5, #7, #8 now done; #9 (factor ablation) now done at the per-factor level (was only coarse broker-block before); #10 (walk-forward) upgraded to split-half done, true multi-year walk-forward still infeasible with current data span; #2/#3 (data contract, full F1-F14 unit tests) and #6 (Trend Pullback setup) still untouched.
- **Re-run EXP-008 with HIGH_VOLATILITY and counter-trend split into two independently-toggleable rules** instead of one combined gate — the pooled result was almost entirely driven by the volatility component; isolating them properly is needed before the counter-trend piece can be judged on its own evidence.
- **Re-run EXP-008 once live shadow-mode data has accumulated** (weeks, not the same single historical window) — `price_regime_at_signal`/`regime_gate_would_block`/`regime_gate_reason` now persist on every live `/api/signal-scanner` save, so a second, genuinely out-of-sample pass is possible without waiting for a data-source change.
- **Formal significance testing on EXP-008's counter-trend cells** (n=4-36 currently) before treating the TREND_DOWN/TREND_UP split as anything more than a hint.
- **Rolling walk-forward CV with a locked final holdout** for `awo_optimizer.js` — the 2026-07-31 fix added a purge gap to the single static train/validate split, but it's still one split, not multiple rolling folds, and there's no third locked-test partition the final weights+thresholds combination gets evaluated against exactly once.
- **Full `scoreAtTimestamp()` migration + golden-fixture parity test** — `regenerate_signal_history.js` and the `backtest_*.js` scripts still each have their own scoring-orchestration copy (only the inner `combineFactorScores()` math is provably shared); the review's suggested golden-fixture test (one frozen input → identical F1-F14/coverage/score/classification across every code path) is not yet built.
- **Rate limiter, structured audit log, RBAC** for the admin-gated endpoints — currently just a single shared static key.
- **Confirm the real production frontend origin(s) and set `CORS_ALLOWED_ORIGINS`** — CORS currently still defaults to `*` because the actual origin wasn't confirmed during the 2026-07-31 fix pass (deliberately not guessed, to avoid silently locking out the real frontend).
- **AWO dashboard admin-key wiring** (server-side Next.js proxy route) — still open, same gap flagged 2026-07-30.
- **Persist factor_availability/factor_coverage/missing_factors/model_version/config_version on `idx_signal_history`**, then actually READ that back in the optimizer and paper trading (both currently call `combineFactorScores(..., availability={})`, treating every factor as always-available even for historical signals where broker data was genuinely missing) — real schema + pipeline work, flagged 2026-07-31 round 2, not yet done. Note (2026-07-31 round 3): the live-scoring SIDE of this is now fixed (`calcTechnicalFactors` reports real per-factor `factorAvailable`, consumed correctly by all three live-scoring call sites) — what's left is specifically getting that signal into the historical DB row and having the optimizer/paper-trading backtest paths read it back, which also needs a backfill decision for pre-existing rows that never recorded real-vs-fallback at collection time.
- **Rolling multi-fold walk-forward + locked final holdout** for `awo_optimizer.js` — flagged again in round 3 (Review.md finding #6, same open item as the 2026-07-31 line above); current split is still one static train/purge/validate boundary, not the fold-1/fold-2/.../locked-holdout structure recommended.
- **Immutable candidate registry as a real DB table** (candidate_id, seed, code version, data snapshot ID, status DRAFT/VALIDATED/PAPER_TESTING/REJECTED/APPROVED/PROMOTED/ARCHIVED) — `awo-challenger.json` covers the single-active-candidate case adequately for now, but has no multi-candidate history.
- **DB-backed atomic compare-and-set for `/api/awo/optimize/promote`** — currently an in-memory single-process lock, correct for this app's actual single-fork PM2 deployment but not a general solution if it's ever run clustered.
- **First real LONG_ONLY-mode backtest re-run** — EXP-001 through EXP-008 all predate the `TRADE_DIRECTION_MODE` fix and were run against whatever long/short mix `evaluateCandidateOutcome`/`computeWinRate` happened to produce at the time; none of those registry entries have been re-validated under the now-standardized LONG_ONLY convention specifically (though the qualitative "AWO Full underperforms" finding is unlikely to flip on this alone).
- **Extend price-history backfill beyond ~2 years** — EXP-009 found every ticker in `idx_stock_prices` capped at the same ~2-year window (2024-07-17 to 2026-07-31, max 502 bars), almost certainly `backfill_price_history.js`'s `--range 2y` default. This is the binding constraint on testing ANY multi-condition, low-frequency strategy (Momentum Leadership Breakout produced only 2-8 signals per variant) — a real infrastructure decision (Yahoo API time/quota cost), not a code change, flagged for the project owner rather than done unilaterally.
- **Re-run EXP-009 (Momentum Leadership Breakout) once more history exists** — sample size was too small either way, but per EXP-010's finding, do this only AFTER the ranking-formula follow-up below, not before — re-testing entry timing on top of a composite that doesn't yet show reliable forward-return predictiveness would just repeat EXP-009's inconclusiveness for a different reason.
- **EXP-010 follow-up — isolate individual momentum sub-factors' IC** (RS-6m alone, RS-3m alone, 52w-high-proximity alone, EMA50-slope alone) rather than only the blended 6-factor composite, to find out whether ANY single sub-factor carries real forward-return signal that's getting diluted/cancelled out in the current 30/25/20/10/10/5 blend — the reviewer's own suggested first move if the composite itself shows weak IC, which EXP-010 confirmed it does (5D/10D/20D mean IC negative or ~0, only weak +0.01 at 60D).
- **EXP-010 follow-up — investigate the 60D decile-10 underperformance** (worst of all 10 deciles, −6.74%, vs universe average −2.59pp) for whether it's driven by a small number of extreme momentum-crash names (one verified case: TOBA, decile-10 leader 2025-08-26, −41.5% by 60 trading days later) — if so, a volatility/extension filter applied at the RANKING stage itself (not just entry-timing) may be a more targeted fix than abandoning momentum ranking altogether.
- **Setup B (Pullback)** — explicit future follow-up per the reviewer's own spec, but now gated behind the ranking-formula revisit above, not just EXP-009's data-depth issue — building a timing layer (breakout OR pullback) on top of an unproven ranking doesn't resolve the more fundamental open question EXP-010 raised.
- **Backfill other backtest scripts to import `evaluateCandidateOutcome`/`mulberry32` from `awo_optimizer.js`** instead of each maintaining its own copy, now that both are exported — `backtest_momentum_leadership.js` and `backtest_momentum_rank_diagnostic.js` are the first scripts to do this; `backtest_baseline_comparison.js`, `backtest_param_sweep.js`, `backtest_factor_ablation.js`, `backtest_walkforward_split.js` still each carry their own duplicate.

---

## EXP-2026-08-07-023 — Float Cost Basis Map: nothing raw, something after momentum is removed

**Question**: the proposed Float Cost Basis Map estimates where the tradable float was acquired — proportional-replacement chip distribution, decayed by daily turnover measured against free float. It is derived from the price path, so "% underwater" is close to a restatement of recent returns: a stock that fell has holders trapped above it *by construction*. So the question is not "does it have IC" but **"does it have IC that momentum does not already have"**.

**Design**: cross-sectional ranking only, shaped after EXP-011. Canonical date axis from `idx_ihsg_history`; 250-session lookback; 40 price buckets; turnover coefficient 0.75; weekly ranking dates; horizons 20/40/60D; tie-aware Spearman; date-block bootstrap 95% (2000 draws). Liquidity floor Rp 5bn median 20-day value. Universe = the 99 tickers with a free float on record. No timing, no stops, no costs.

**Free float had to be sourced first — it was not in the database at all.** IDX's own `TradebleShares` endpoint is behind Cloudflare and currently refuses even a real browser (the same blockage that has left `idx_broker_summary` stale since 2026-07-31). Yahoo's `floatShares`/`sharesOutstanding` answered for **100/100** of the top-100 by turnover, including the whole illiquid half. One value was rejected rather than stored: **BBNI came back at 2556% of shares outstanding**, which is not a small error but a different quantity wearing the right field name. Stored in `idx_free_float`, rejections in `idx_free_float_rejected`.

**Two data faults surfaced while building the model.** `idx_stock_prices.value` has been **0 since 2026-08-03** — an ingestion regression of the same vintage as the broker outage — and on the days it *is* populated, `value / volume` comes back exactly equal to the close. It is `volume × close` and never carried intraday information, so the model uses typical price `(H+L+C)/3` and the word VWAP was removed from the code. Volume was verified to be in **shares, not lots**, via median daily turnover of 0.58% of float; had it been lots, every rotation figure would have been understated 100×.

### Results — 414 cross-sections, median 70 names, 2017-08 .. 2026-05

| | raw IC 60D | residualised on ROC20+ROC60, IC 60D | IR | %pos |
|---|---|---|---|---|
| `avgCostGap` | 0.0075 | **0.0378 \*** | 0.23 | 61% |
| `distToPeak` | 0.0187 \* | 0.0215 \* | 0.13 | 59% |
| `profitSupply` | 0.0102 | 0.0224 \* | 0.14 | 54% |
| `rotation20` / `rotation60` | ~0.016 | ~0.01, n.s. | — | — |

Excluded and reported: **163 ticker-dates for a detected corporate action** (>35% single-session move; excluded rather than adjusted), **7,222 below the liquidity floor**.

### Findings

1. **Raw, the map predicts almost nothing.** Every metric sits between 0.005 and 0.019, and the metrics overlap heavily with momentum (`profitSupply` vs ROC60 = 0.60, `avgCostGap` vs ROC60 = 0.61). Read straight off a screen, this is a repackaging of the price path.

2. **Residualising against momentum RAISES the IC rather than lowering it**, which only makes sense if momentum is itself negatively predictive here and was cancelling part of the signal. Measured in this exact sample rather than assumed from EXP-010: ROC20 40D **−0.0183 \***, ROC60 40D **−0.0223 \***, ROC60 60D **−0.0216 \***. It is. So the cost map carries real information that the momentum it is built from was masking.

3. **The size is comparable to the best factor this project has ever found, and that factor was judged untradeable.** `avgCostGap` residualised at 60D is IC 0.0378 / IR 0.23; EXP-011's HI52W is IC 0.044 / IR 0.25, recorded there as "not a tradeable edge as it stands". This is the second factor to show consistent forward predictiveness, at the same modest scale.

4. **The result is robust to the free-float bias — and that is itself informative.** Free float is a today snapshot applied backwards nine years, which rights issues make wrong. Perturbing every ticker's float by exp(N(0,0.30)) across three seeds gave 0.0389 / 0.0381 / 0.0323; at exp(N(0,0.60)) it gave 0.0326. All still significant. **The signal does not care how wrong the float is**, which contradicts the design premise that free float is "the whole game": what carries the information is the shape of the cost distribution, and the float only modulates decay speed.

5. **It survives on recent data alone.** Restricted to 2023-01-01 onward (159 cross-sections, where today's float is most likely still correct), the residualised 60D IC is 0.0316 with **IR 0.25** — a slightly lower IC at the same risk-adjusted level, on 38% of the dates. Notably the RAW panel collapses over the same window (60D 0.0021, n.s.) while the residual holds, which is finding 1 and 2 restated more sharply.

**Multiple testing**: 15 pairs per panel, ~0.8 false positives expected at α=0.05; 8 cells were significant across both panels. But `profitSupply`, `avgCostGap` and `distToPeak` are highly correlated with one another — this is closer to one finding than to eight, and should be counted that way.

**Limitations**: survivorship-biased toward the currently-liquid 99; no costs, no timing, no stops; historical free float unavailable, only tested for insensitivity rather than corrected; corporate actions excluded, not adjusted; the broker-flow enrichment ("smart-money cost", measured from `idx_broker_summary.buy_avg` rather than modelled) is not part of this IC study and remains untested.

**Decision this drives**: if the Float Cost Map is used at all, it must be used as **a residual against momentum, not as the number printed on the chart** — the raw metric is approximately zero and the chart is extremely persuasive, which is the exact profile of EXP-016's inverted broker signal and of the contemporaneous scanner score. Phase 1 remains analytics-only; it does not touch `HI52W_REGIME_BROKERVETO_V1`, and the IDX burn-in stays sterile. Free-float sourcing is worth keeping for its own sake but is **not** the critical dependency it appeared to be.

**Scripts**: `/root/research/float_fetch.js` (free float → `idx_free_float`), `/root/research/float_cost_map.js` (per-ticker map + confidence score), `/root/research/exp022_float_map_ic.js` (this study; `--from`, `--float-noise`, `--seed` drive the sensitivity runs). Deliberately outside `/var/www/flowtracker-scraper` so the frozen tree and `predeploy_check.sh` are undisturbed.

### EXP-023 addendum (2026-08-08) — the seed, and a control the first pass missed

Building per-ticker confidence surfaced a problem with the study above. The
model seeds 100% of the float at the first session's typical price and lets
turnover erode it, and `seedRemaining = Π(1 − turnoverᵢ × k)` turns out to be
**34.4% at the median** across the 99-name universe — not a tail case. MIKA
sits at 80.1%, HEAL 79.8%, CPIN 78.7%. For most names a large part of the
"estimated cost basis" is a statement about where the price was 250 sessions
ago, not about holder cost.

That matters because the original residualisation removed ROC20 and ROC60 but
**not** the ~250-day lookback the seed encodes — so the headline 0.0378 might
have been long-horizon momentum wearing a new name.

Re-run with ROC250 added as a third control:

| residualised on | IC 20D | IC 40D | IC 60D | IR 60D |
|---|---|---|---|---|
| ROC20 + ROC60 | 0.0219 \* | 0.0323 \* | 0.0378 \* | 0.23 |
| ROC20 + ROC60 + **ROC250** | 0.0210 \* | 0.0334 \* | **0.0338 \*** | 0.23 |

**It survives.** The 60D IC drops from 0.0378 to 0.0338, still significant,
with an identical information ratio, and 40D is marginally higher. So the
signal is not merely the long lookback the unconverged seed carries — but the
concern was legitimate and had to be measured rather than argued.

`seedRemaining` is now computed per ticker, stored, split out as a MODEL
CONVERGENCE score beside DATA quality, and shown on the page as "day-one seed
still in the map". A name whose map is mostly its own initialisation can no
longer score the same as one whose float has rotated forty times: the median
confidence fell from a flat 80/100 to **48/100** once it was measured honestly.

---

## EXP-2026-08-11-026 — Market Regime Conditionality: the conditionality is real, but the premise it was meant to test is not

> **SUPERSEDED BY EXP-026 R1 at the end of this entry.** The review of 2026-08-11 found 3 P1 + 2 P2 methodology defects. All are fixed; two findings below did NOT survive the fix and are formally withdrawn there. Read R1 before quoting anything in this section.

- **Script**: `scraper/backtest_market_regime_conditionality.js`
- **Why**: the 2026-08-11 review round argued that the scanner answers "which stock is relatively strong?" while the question being asked of it is "is a long worth taking?", and proposed a Market State layer above the frozen stock engine. It explicitly asked that the FIRST step be measurement, not a rule — "jangan mulai dari rule mana yang bagus" — and named EXP-026 as *how does the existing system perform conditional on market state*, ahead of the EXP-025 OOS precursor test.
- **Data**: `idx_signal_history`, source `backfill_v3_f5v1` only (uniform `f5_benchmark_version = v1-idx245-2026-08-10`). The 4,131 `live` rows carry no benchmark stamp at all and are excluded: 14 sessions hold rows from both sources with no duplicate ticker-days, so including them would put two F5 benchmark definitions inside a single session's cross-section — and F5 is the factor under discussion. **117 sessions, 26,739 scored ticker-sessions, 2026-01-19 .. 2026-07-21, 200 resolved BUY/STRONG BUY.**
- **Method**: market features per session from the exchange's own index series (returns 1/5/20D, vs MA20/MA60, MA20/MA60 slope, drawdown from 20D/60D high, realized vol 20D) plus breadth computed independently from `idx_stock_prices` (% above own MA20, % closing up). Sessions bucketed into **terciles** of each feature — not a threshold, because choosing one would answer EXP-027's question with EXP-026's data. Per bucket: session-level Spearman rank IC of `composite_score` vs forward return, universe mean return, BUY absolute return, and **BUY excess = BUY mean minus the same session's universe mean**. All statistics computed per session and aggregated across sessions; every CI from `bootstrapMeanCI` resampling whole sessions.
- **Date-blocking**: N is **117 sessions, not 26,739 rows** — every stock in a session shares that session's regime. Same correction EXP-025 needed when its "1,236 winner observations" turned out to be 100 sessions.

### The measurement that was supposed to settle it

The review's hypothesis has a precise empirical form: if the stock engine picks relative winners and only market permission is missing, then **EXCESS** (market move divided out) stays positive across regimes while **ABSOLUTE** goes negative in the bad ones.

| Horizon | rank IC | 95% CI | IR | universe | BUY absolute | BUY **excess** | excess 95% CI |
|---|---|---|---|---|---|---|---|
| 1D | −0.0554 | [−0.0789, −0.0298] | −0.41 | −0.15% | −0.74% | −0.48% | [−1.39, +0.45] |
| 3D | −0.0470 | [−0.0690, −0.0222] | −0.36 | −0.44% | −1.86% | −0.94% | [−2.17, +0.24] |
| 5D | −0.0468 | [−0.0704, −0.0224] | −0.36 | −0.72% | −2.67% | −1.09% | [−2.49, +0.11] |
| 10D | −0.0676 | [−0.0904, −0.0445] | −0.53 | −1.33% | −4.72% | **−2.11%** | **[−3.87, −0.48]** |

**EXCESS is negative at every horizon and significantly so at 10D.** Removing the market's own move does not rescue the BUY bucket, so on this window the premise does not hold: the scanner is not picking relative winners that a bad market is dragging down.

The 1D row is the one with no overlap caveat at all — daily sampling with a 1-day forward return produces 117 genuinely non-overlapping windows, and the IC there is significantly negative on its own.

### The conditionality IS real, and it is strong

Tercile splits, 5D horizon (IC column uses every scored name; BUY cells are small — see caveats):

| Feature | bucket | sessions | BUYs | market | BUY excess | IC |
|---|---|---|---|---|---|---|
| MA60 slope | LOW | 39 | 50 | −0.02% | −2.66% | **−0.1286** |
| | HIGH | 39 | 95 | −2.19% | +0.36% | **+0.0117** |
| realized vol 20D | LOW | 39 | 98 | −3.71% | +0.03% | **+0.0142** |
| | HIGH | 39 | 40 | +0.74% | −1.53% | **−0.1111** |
| drawdown from 60D high | LOW (deep) | 39 | 37 | +0.82% | −2.09% | −0.1026 |
| | HIGH (near high) | 39 | 104 | −1.68% | −0.71% | −0.0243 |
| IHSG vs MA60 | LOW | 39 | 42 | +0.35% | −2.47% | −0.0642 |
| | HIGH | 39 | 103 | −1.47% | +0.29% | −0.0176 |
| IHSG vs MA20 | HIGH | 39 | 86 | −1.72% | **+0.84%** | −0.0363 |
| breadth % > own MA20 | HIGH | 39 | 91 | −1.25% | +0.19% | −0.0363 |

The pattern is consistent across six independent descriptions of the market: **in stressed states (falling MA60, high volatility, deep drawdown, below MA60) the score is actively anti-predictive, IC −0.10 to −0.13. In benign states it is approximately useless, IC ≈ 0 to +0.01, and BUY excess is ≈ 0 rather than negative.**

A breakout column worth naming separately: in the weakest 20D-return tercile, BUY names hit +5% within 5 sessions **19.6%** of the time against a universe base rate of **45.7%** in the same sessions. The signals are less likely to break out than an average name in the same market.

### The decile shape — where the damage actually is

Mean forward return minus the session's own universe mean, per `composite_score` decile, averaged over 117 sessions:

| | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1D | −0.06 | **+0.23** | **+0.17** | **+0.18** | **+0.16** | +0.02 | −0.10 | −0.14 | **−0.24** | −0.22 |
| 5D | −0.26 | **+0.49** | **+0.53** | +0.20 | +0.27 | +0.08 | −0.33 | −0.23 | −0.10 | **−0.81** |

(bold = 95% CI excludes zero. D10 − D1 = **−0.56pp** at 5D; a working ranking is positive here.)

**This is a hump, not a line.** The score is not uniformly inverted — D2/D3 significantly OUTPERFORM (+0.49/+0.53 at 5D) while D10 significantly UNDERPERFORMS (−0.81). D1, the very bottom, is also negative. So `composite_score` does carry usable cross-sectional information; it is being **read at the wrong end**. BUY fires on high scores, i.e. precisely on D10, the single worst decile in the distribution.

### Findings

1. **The conditionality the review asked about is real and large.** IC swings from −0.13 (falling MA60) to +0.01 (rising MA60), and from −0.11 (high vol) to +0.01 (low vol). A market-state layer is justified by this data.
2. **But not for the reason proposed.** The case for the layer is not "protect a good stock signal from a bad market" — BUY excess is negative in the pooled sample and significantly negative at 10D. It is "the signal is actively harmful in stressed states and merely neutral otherwise", which is a weaker and less flattering justification for the same architecture.
3. **`Stock Alpha × Market Permission` cannot work while Stock Alpha ≤ 0 at the top of the ranking.** Multiplying a market gate onto a negative-expectancy selection reduces exposure and therefore reduces losses, but that is risk reduction, not alpha, and it must not be reported as the architecture being validated.
4. **The most valuable follow-up is not EXP-027.** The decile hump says the ranking's information is real but its top end is inverted — consistent with EXP-024 ("winners are preceded by LOWER factor values"), EXP-016 (broker accumulation inverted), and the standing finding that the composite is contemporaneous (corr 0.35 with the SAME day's return, so D10 is largely "already ran", which then mean-reverts on IDX). Asking why BUY fires on D10 is likely worth more than gating a signal that is negative at its own top decile.

### Verification of the harness

8/8 checks, independent of the experiment's own code path: `spearmanIC` returns exactly +1/−1 on monotone toy cases and does not fabricate a value when every return is tied (ARA/ARB ties are routine on IDX); the module's Spearman matches a separately written rank-and-Pearson implementation to 1e−9 on a real 245-name cross-section (2026-01-19, IC 0.069388 both ways); universe and BUY means match `SQL AVG` to 1e−6; one stored `return_5d` reconciles against `idx_stock_prices` from raw closes (AMIN 2026-01-19, 292 → 282, stored −3.4200% vs recomputed −3.4247%, the difference being the stored value's 2-decimal rounding); the bootstrap CI collapses to zero width on a constant series.

### Caveats, and they bind hard

- **One window, ~6 months, predominantly falling.** IHSG was above its MA60 on only 12 of 121 sessions and within 1% of its 60-day high on 2. A binary RISK_ON/RISK_OFF split is NOT supportable on this sample — that is why terciles were used, and it is the reason EXP-027 cannot be run on this data alone.
- **Overlapping forward windows.** `modules/cross_sectional.js` documents that its bootstrap cannot fix serial correlation from daily sampling at multi-day horizons, so the 3/5/10D CIs are too narrow. Re-run on non-overlapping subsamples: 3D −0.0370 [−0.0749, −0.0000] (39 sessions), 5D −0.0420 [−0.0949, +0.0092] (24), 10D −0.0843 [−0.1705, −0.0012] (12). The 5D IC crosses zero once overlap is removed; **the 1D result needs no such correction and remains significant.** BUY absolute stays significantly negative at 1D-spacing and 5D-spacing.
- **200 BUY signals over 78 sessions.** Every ABSOLUTE/EXCESS tercile cell rests on 37–104 signals. Treat them as directional; the IC column, which uses all 26,739 scored names, is the stronger statistic.
- **In-sample.** These are the same sessions the engine and EXP-024/EXP-025 were developed against.

**Status**: MEASURED, no rule proposed and no gate enabled. Answers the review's question as asked, and reports that the hypothesis behind it does not hold on this window. EXP-027 (regime model) is **not** unblocked by this — the sample cannot support a regime classifier — and the decile finding in §4 is recommended ahead of it.

### EXP-026 R1 (2026-08-11) — three P1 corrections, and two of the findings above did not survive them

The review round of the same day held the result at 9.0/10 with 3 P1 + 2 P2 methodology blockers. All five are fixed. **Every number in the section above is superseded by this one.** The original is left in place because two of its claims were wrong in ways worth being able to see.

**P1-1 — forward outcomes were not guaranteed canonical.** The first pass read `return_1d/3d/5d/10d`, `max_profit` and `max_drawdown` from `idx_signal_history`, which `regenerate_signal_history.js` builds with `candles.slice(i + 1, i + 11)` — the next N *rows* of `idx_stock_prices`, not the next N exchange sessions. Correct objection. **Measured before changing anything, and the impact on this window is exactly zero**: inside 2026-01-19 .. 2026-08-06 the price table holds precisely the 129 canonical sessions (0 phantom dates, 0 absent sessions), and all 26,739 stored returns reproduce a canonical recomputation to within their own 2-decimal rounding — 0 rows differ. The recomputation is kept regardless: the stored columns are right here by a property of the data that no code enforces, and the purge that made them right (2026-08-04) landed four days before this window was read. EXP-026 now computes outcomes itself and refuses a window it cannot complete (`refused: 0` on this data).

**P1-2 — breadth was row-based, and it had a real instance.** `breadthByDate()` walked each ticker's rows in table order, taking "the last 20 rows" as MA20 and "the previous row" as yesterday. 245 of the 253 tickers in `idx_stock_prices` cover all 129 canonical sessions; the 8 that do not — BOSS, FASW, SCPI, SMCB, SRIL, TELE, WIKA, WSKT, holding 20 to 33 rows each — are suspended names whose "20 rows back" reached across months of halted trading, and they were in the breadth denominator on every session. Breadth is now computed on the canonical axis and a ticker is included on session D only if all 20 canonical sessions ending at D are present: **245 included, 8 excluded, per session.**

**P1-3 — the breakout metric was not EXP-025's, and this reverses the finding.** The text claimed "defined exactly as EXP-025" and tested `max_profit >= 5%`, an intraday high touching +5% at any point. EXP-025 freezes something much stricter: forward 5-session return >= +5% **AND the exit close clears the highest close of the 20 sessions ending at entry** (`HIGH_LOOKBACK = 20`). Close, not high; the exit bar, not any bar.

| breakout rate | BUY | universe | reading |
|---|---|---|---|
| ORIGINAL (`max_profit >= 5%`, wrong metric) | 19.6% | 45.7% | "BUYs break out LESS than average" |
| **EXP-025 parity (correct)** | **13.4%** | **4.0%** | **BUYs break out 3.4x MORE than average** |

**The original claim was not merely non-comparable, it pointed the wrong way.** An intraday +5% touch is common for everything in a volatile universe, so the loose metric mostly measured volatility. On the frozen definition BUY signals achieve a genuine breakout far more often than the base rate, in every tercile (BUY 11–24% vs universe 3–9%). Hand-verified: 26 of 208 BUY signals (12.5%) by direct recomputation from raw closes.

**P2-1 — non-overlap spacing** used `sessions.filter((_, i) => i % H === 0)`, an index into an array that has already had sessions dropped. Anchors are now chosen on the exchange session index; verified every anchor is >= H canonical sessions from the previous.

**P2-2 — "excess" was not index-adjusted, and this matters more than it sounds.** `BUY − universe` is an equal-weight, universe-relative return, not beta- or index-adjusted alpha. Both are now reported:

| Horizon | rank IC | 95% CI | BUY absolute | BUY − universe | BUY − **IHSG** | universe − IHSG |
|---|---|---|---|---|---|---|
| 1D | −0.0550 | [−0.0793, −0.0307] | −0.68% | −0.47% [−1.33, +0.39] | **−0.23% [−1.10, +0.63]** | +0.13% |
| 3D | −0.0494 | [−0.0716, −0.0253] | −1.73% | −0.90% [−2.10, +0.32] | **−0.31% [−1.56, +0.88]** | +0.44% |
| 5D | −0.0481 | [−0.0720, −0.0241] | −2.63% | −1.11% [−2.53, +0.22] | **−0.20% [−1.68, +1.19]** | +0.73% |
| 10D | −0.0676 | [−0.0904, −0.0445] | −4.72% | −2.11% [−3.87, −0.48] | **−0.33% [−2.24, +1.41]** | +1.36% |

**The headline claim of the original entry does not survive.** It reported BUY excess as "significantly negative at 10D (−2.11%)" and concluded the scanner picks relative losers. Against IHSG the same signals are **flat at every horizon** (−0.20% to −0.33%, every CI spanning zero). The equal-weight universe beat the cap-weighted index by +0.13 to +1.36pp over this window — large caps fell harder — so the entire "significant" 10D result was measured against a basket that itself outperformed the index. Benchmark choice, not signal quality, produced that number.

### What survives R1

1. **Rank IC is significantly negative at every horizon** (1D −0.0550, and 1D needs no overlap correction at all — 121 genuinely independent windows). Unchanged by the corrections.
2. **BUY absolute return is significantly negative** (−0.68% to −4.72%). Unchanged. In a falling market this is largely the market, which is exactly why the benchmark comparison matters.
3. **The decile hump survives intact** — the reviewer's stated condition for moving on. Excess over the session's own universe mean, 5D, canonical: D1 −0.25, **D2 +0.51 [+0.13, +0.88]**, **D3 +0.51 [+0.15, +0.85]**, D4 +0.19, D5 +0.27, D6 +0.07, D7 −0.32, D8 −0.27, D9 −0.07, **D10 −0.83 [−1.21, −0.45]**. D10 − D1 = **−0.58pp**.
4. **The conditional pattern survives**: IC −0.1286 in the falling-MA60 tercile vs +0.0065 in the rising one; −0.1179 in the high-volatility tercile vs +0.0075 in the low. Stressed states are where the damage is concentrated.

### Revised reading

The scanner is **not** established as picking relative losers — against the index its BUY signals are flat, and they achieve genuine EXP-025 breakouts 3.4x more often than the base rate. What is established is narrower and sharper: **the top decile of its own ranking is bad while D2/D3 are good**, consistently, on canonical data. The score contains real information and the classifier reads it at the wrong end.

That makes the review's proposed next step the right one, and for a better-supported reason than before. **EXP-027A — composite decile decomposition**: which factors put a name in D10 rather than D2/D3, how much of D10 is same-day-return exposure (the composite is contemporaneous, corr 0.35 with the same session's move), and whether "quality/setup" separates from "extension/timing". A regime classifier remains unsupportable on this sample regardless — IHSG was above its MA60 on 12 of 121 sessions.

**Verification of R1**: 5/5 independent checks — the calendar holds no weekend sessions; the EXP-025 breakout rate hand-recomputed from raw closes over 208 BUY signals gives 12.5%, matching the script (INDS 2026-01-19 entry 600 → exit 745, +24.17%, prior-20 high close 600 → breakout); exactly 245 tickers cover all 129 canonical sessions; every non-overlap anchor is >= H canonical sessions apart. Plus the original 8/8 harness checks, which are unaffected.

**Status**: MEASURED, corrected, no rule proposed and no gate enabled. Two findings from the first pass are formally withdrawn: the breakout comparison (reversed) and the "significantly negative excess" (an artifact of benchmark choice).

### EXP-026 R2 (2026-08-12) — the contract-cleanup commit finally gets to run

> **See the 2026-08-14 addendum at the end of this entry before quoting any number here.** The results below are unchanged and now reproduce exactly, but at the time they were published the session window was frozen only in prose — the query had no date bound, and a routine snapshot repair moved the population from 121 sessions to 123 two days later. Fixed in `5599bfb`; the addendum records what moved, what did not, and one tail-censoring caveat that is still open.

Commit `7147256` (2026-08-11) closed the three items an R2 review round held EXP-026 at 8.7/10 for — a frozen `MARKET_BREADTH_UNIVERSE_V1` (sha256-pinned, fails closed on drift instead of a size check that can't see a swap), a single imported breakout definition (`modules/breakout.js`, proven equal to EXP-025's frozen contract by `test_breakout_parity.js` on 7,200 generated cases), and a significance verdict *derived* from whichever CI is admissible per horizon rather than written in prose. That commit's own message says it plainly: **"Results NOT re-run yet — the database is down... so the corrected numbers come in a follow-up."** The DB outage was `erp_user`'s password rotation going undetected (see the 2026-08-12 DB credential lifecycle fix, same day) — this entry is that follow-up, now that it's fixed.

**A second gap found on the way**: `parityFlips`/`parityCompared` were referenced in the provenance block and promised by a code comment ("computed ONLY to count how many classifications the parity fix actually moved... measured, not assumed") but the comparison loop itself was never written — every run crashed with `ReferenceError: parityFlips is not defined` before reaching the significance verdict. Fixed by adding the loop (compares `breakoutExp025` vs the superseded `breakoutR1Bounds`, already computed per-row, counted only where both resolved) — a missing implementation of already-declared intent, not a new metric.

**Verified before trusting any number**: `test_breakout_parity.js` — 16/16 passing on the VPS against real production data paths (agrees with the frozen reference on all 7,200 generated cases, gets the strictly-before-entry window right, both breakout conditions load-bearing, incomplete windows excluded not silently false).

**Results, all four horizons, `--horizon 1|3|5|10`**:

| H | D2 (95% CI) | D3 (95% CI) | D10 (95% CI) | D10−D1 |
|---|---|---|---|---|
| 1D | +0.23 [0.07,0.41] | +0.15 [-0.01,0.31] | -0.20 [-0.44,0.02] | -0.16pp |
| 3D | +0.24 [-0.05,0.52] | **+0.44 [0.16,0.74]** | **-0.43 [-0.76,-0.12]** | -0.39pp |
| 5D | **+0.50 [0.12,0.85]** | **+0.50 [0.15,0.85]** | **-0.83 [-1.22,-0.46]** | -0.63pp |
| 10D | **+0.74 [0.30,1.18]** | **+0.93 [0.46,1.43]** | **-1.36 [-1.90,-0.84]** | -1.36pp |

(bold = 95% CI excludes zero.) **The decile hump from R1 survives intact** — direction correct at every horizon, statistically significant at 3D (D3/D10)/5D/10D; 1D and D2@3D are directionally right but don't clear significance, expected given how little separation a 1-3 day window gives a cross-sectional score room to produce.

**Breakout enrichment survives the i-20..i-1 fix at every horizon** (breakout mean vs everything-else mean): 1D 4.76% vs -1.15% (n=28/196) · 3D 8.20% vs -2.70% · 5D 10.03% vs -4.14% · 10D 8.63% vs -6.04% (n=26/174 — a few breakout windows can't resolve that far out).

**Parity flips: 0 of 27,474** compared classifications, at every horizon. Confirms the R1 reviewer's own prediction exactly ("unlikely to flip any classification... with forward return >= +5% the exit close exceeds entry, so an entry bar that was itself the window high is cleared anyway") — the bounds fix was correct to make for contract-integrity reasons, and changed zero actual historical outcomes in this dataset.

**Significance verdict, horizon-admissible CI (not defaulting to the overlapping daily one)**:

| H | admissible basis | n | CI | verdict |
|---|---|---|---|---|
| 1D | daily-sampled (H=1, no overlap by construction) | 121 | [-0.0793,-0.0307] | SIGNIFICANTLY NEGATIVE |
| 3D | non-overlapping subsample | 41 | [-0.0781,-0.0038] | SIGNIFICANTLY NEGATIVE |
| 5D | non-overlapping subsample | 25 | [-0.1032,0.0033] | DIRECTIONALLY NEGATIVE — not significant |
| 10D | non-overlapping subsample | **12** | [-0.1706,-0.0012] | SIGNIFICANTLY NEGATIVE, but thin |

5D matches R1's own already-corrected finding exactly. 10D's verdict is technically significant but rests on only 12 non-overlapping sessions with a CI upper bound of -0.0012 — a hair from zero; treat it as suggestive, not load-bearing, until more history accumulates.

**Status**: All four of the review's stated acceptance checks (decile hump direction, breakout enrichment, parity-flip count, per-horizon CI admissibility) come back clean, with the two honest caveats above (1D/D2@3D short of significance; 10D's n=12 thinness) — neither is a methodology defect, both are sample-size facts. **GREEN/FREEZE** per the review's own criteria. No rule proposed, no gate enabled — same discipline as R1. Next: **EXP-027A — composite decile decomposition**, not a regime classifier (the sample still can't support one — IHSG was above its MA60 on only 12 of 121 sessions).

#### EXP-026 R2 addendum (2026-08-14) — the freeze was real in prose, not in code

Re-running R2 to confirm reproducibility returned **1D over 123 sessions, not 121**, with a CI of [-0.0802,-0.0313] instead of the [-0.0793,-0.0307] published above. 3D/5D/10D came back byte-for-byte identical. Cause, confirmed rather than guessed: the population query was

```sql
FROM idx_signal_history WHERE data_source = ? ORDER BY data_date ASC
```

with **no date bound**. The window was whatever the table happened to hold; `2026-01-19 .. 2026-08-06` existed only as prose, in a caveat string and in this entry. Earlier the same day, two genuinely missing snapshots (2026-08-10 and 2026-08-12) were regenerated to close a data gap — a correct repair — under the default `--source backfill_v3_f5v1`, which is this experiment's source. The frozen population silently became 123 sessions ending 08-12.

The per-horizon arithmetic pins the mechanism exactly: 1D resolves both new sessions (+2), 3D resolves only 08-10 (+1), 5D and 10D resolve neither (unchanged). **3D/5D/10D reproducing identically was the dangerous part, not the reassuring one** — the new sessions were merely too close to the data edge to resolve those horizons yet. Left alone, all four would have drifted within days, with no source-code change to point at.

This is the second axis of the R1 review's own P1. The first — breadth membership — was fixed in `7147256` and demonstrably holds: the tracked universe went 245 → 600 on 2026-08-14 and every number here stayed put. The session population had the identical hole and took under 48 hours to trigger.

**Fixed in `5599bfb`**: `MARKET_REGIME_WINDOW_V1 = {from: 2026-01-19, to: 2026-08-06}`, 121 sessions, pinned by **sha256 `dbd375e68d80…`** — by digest and not by count, because the review's own objection to a size check applies here too: a count cannot see a session swapped inside the bounds. Bounding the query stops the window growing; `assertFrozenSessionWindow()` fails closed on anything moving within it. Provenance now records the window version and digest on every run, and the caveat line interpolates the dates from the constant instead of restating them — a string asserting the intended window while the query had none is precisely how this hid.

The two new snapshots were **not** deleted. They fill real gaps and are good data; the defect was an experiment that did not state its own window.

**Every number in the tables above is unchanged and now reproduces exactly** — 1D [-0.0793,-0.0307] n=121 · 3D [-0.0781,-0.0038] n=41 · 5D [-0.1032,0.0033] n=25 · 10D [-0.1706,-0.0012] n=12, parity flips 0 at all four horizons. The published results were right; what was missing was the guarantee that they stay reproducible. GREEN/FREEZE stands, and is now enforced rather than asserted.

**Still open, and a different axis this does NOT fix**: outcome right-censoring at the window's tail. 10D resolves only **117 of the 121** frozen sessions, because sessions after ~2026-07-30 need prices beyond the current data edge. Those figures will keep moving until roughly 2026-08-20, and `parityCompared` drifts for the same reason (27,474 at the original run, 27,719 now — flips 0 either way). The population is frozen; per-row outcome availability still grows. Anyone re-running before the tail fills should expect 10D to differ and should not read it as a methodology change.

## EXP-027A (2026-08-13) — Composite Decile Decomposition: is D10 bad QUALITY or bad TIMING?

Purely observational, per the review's explicit instruction — no F1-F14 weight changes, no new score. New file `scraper/backtest_composite_decile_decomposition.js`, same `SOURCE = 'backfill_v3_f5v1'`, same canonical outcomes and breakout definition (duplicated from `backtest_market_regime_conditionality.js`, not imported — that file was just frozen "jangan utak-atik lagi"). Every scored row gets, in addition to F1-F14: same-session return, distance from own MA20/MA60, distance from prior 20D/60D high (own inclusive-of-today convention, same as EXP-026's IHSG features), ATR percentile (`regime_engine.js`, 252-session lookback — needed a wider 500-calendar-day price pull than EXP-026's own 120 days), and EMA21 extension (same formula `backtest_momentum_leadership.js` already established). Decile assignment is computed **once per session** off `composite_score` (mirroring `cs.bucketByScore`'s own rank math via the already-exported `rankTransform`, so every dimension is measured against the identical set of names in each decile) — not re-bucketed per dimension, which would let differing null patterns quietly shift who counts as "D10" from one dimension to the next.

**Cross-check against EXP-026 R2 (the safety net for the duplicated logic)**: first pass reported raw forward returns and came out roughly 2x the published magnitude at longer horizons. Root cause: EXP-026's decile table is **excess return** (bucket mean minus that session's own universe mean — "so a falling market cannot make every decile look bad"), not raw. Fixed by applying the same excess-of-universe-mean adjustment to the four return horizons and the breakout-rate dimension only (the F1-F14/timing dimensions are same-day cross-sectional levels, not returns accumulated across a shifting-regime window — there's no market drift to net out of a level). After the fix, and after matching EXP-026's own 30-scored-per-session floor, **all four horizons reproduce EXP-026 R2's published D2/D3/D10 numbers exactly** (1D −0.20/0.15/0.23, 3D −0.43/0.44/0.24, 5D −0.83/0.50/0.50, 10D −1.36/0.93/0.74 — every value identical). 121 sessions, 2026-01-19..2026-08-06, matches R2's window exactly. Also hand-verified one stock's new MA20/MA60/prior-high features (BBCA, 2026-05-13) against raw `idx_stock_prices` SQL — exact match. F1-F14 coverage is 100% (no gaps); outcome coverage degrades only from expected right-censoring near the data cutoff (96.5% at 10D).

### Quality factors — mostly point the "intended" direction in D10

| Factor | D1 | D10 | direction |
|---|---|---|---|
| F1 Concentration | 42.73 | 66.16 | ✓ higher in D10 |
| F2 Trend | 19.85 | 70.99 | ✓ higher in D10 |
| F4 Momentum | 23.38 | 73.66 | ✓ higher in D10 |
| F5 Relative Strength | 24.58 | 76.28 | ✓ higher in D10 |
| F6 Buyer Breadth | 64.84 | 40.08 | ✗ **inverted** — lower in D10 |
| F7 Price-Broker Alignment | 41.11 | 57.59 | ✓ higher in D10 |
| F8 Accumulation Streak | 24.90 | 70.33 | ✓ higher in D10 |

Six of seven quality factors are monotonically higher D1→D10 — the composite is picking D10 for the reasons it was built to. The one exception, F6 (buyer breadth), is not new evidence of general quality breakage: it reproduces [[project-exp016-broker-inverted|EXP-016's already-documented finding]] that persistent top-3-broker buying predicts underperformance, now showing up independently in a decile decomposition rather than a direct IC.

### Timing/extension factors — D10 is the most-extended decile in the sample, cleanly

| Feature | D1 | D10 | |
|---|---|---|---|
| Same-session return | −2.47% | +3.52% | already moved most today |
| Distance from own MA20 | −8.56% | +7.09% | |
| Distance from own MA60 | −11.26% | +5.81% | |
| Distance from prior 20D high | −16.85% | −4.47% | |
| Distance from prior 60D high | −25.52% | −12.22% | |
| Extension from EMA21 | −8.11% | +5.91% | |
| ATR percentile | 60.18 | 63.35 | flat — D10 is not meaningfully more volatile |

Every extension measure moves monotonically D1→D10 except ATR percentile, which stays flat (~59-63) across all ten deciles — D10 is extended in *price*, not in volatility regime.

### The honest complication: F4/F5 are not independent of "extension"

Momentum and relative-strength factors are, by construction, largely a restatement of recent price movement — a stock cannot score high on F4/F5 without having risen, which mechanically also puts it above its moving averages and extended from EMA21. F4/F5 carry the largest D1-D10 spread of any quality factor (~50 points, vs ~15-45 for the broker factors), so they dominate the "quality" side of the review's split while overlapping heavily with the "timing" side. The genuinely independent quality signal is the broker-flow group (F1/F2/F6/F7/F8, which measure ownership flow, not price level) — and 4 of those 5 still point the intended direction in D10.

### Breakout enrichment vs forward return — the tension survives decomposition

D10 has both the **highest** excess breakout rate of any decile (+5.12pp vs universe, 95% CI [4.07, 6.20]) and the **worst** excess forward return at every horizon. D10 catches genuine EXP-025 breakouts more often than any other decile, and still loses on average — consistent with EXP-026 R1's framing ("a few large winners against many small losers"), not contradictory. Distribution/skew within D10 is a candidate follow-up, not attempted here (purely observational scope).

### Answer to the review's question

Leans toward **quality is mostly fine, extension is what stands out** — but not cleanly, because two of the seven quality factors are entangled with extension by construction. The broker-flow-only view (the part of "quality" that's genuinely independent of price level) is intact in D10 except for the separately-known F6 inversion; every timing/extension measure except volatility is at its sample extreme in D10. This gives real, if qualified, empirical grounding for `MARKET STATE → SETUP QUALITY → TIMING/EXTENSION → RISK → EXECUTION` — with the caveat that a future implementation cannot treat F4/F5 as clean "quality" inputs independent of the "extension" gate; they measure overlapping things and will need to be split or residualized, not just passed through both stages.

**Status**: MEASURED, purely observational as instructed — no F1-F14 weight change, no new composite score. Cross-checked against EXP-026 R2 (exact match, all 4 horizons) and hand-verified against raw SQL. Next step is for the review to decide, not implied here.

---

## EXP-029 (2026-08-18) — Re-tuning HI52W against the v3 concentration model: vetoFrac 0.40, sealed not promoted

- **Scripts**: `retune_v3.js` (walk-forward), `retune_edge.js` (grid extension + flat-fold diagnosis), `regime_probe.js`, `reentry_probe.js` — session scratchpad; each duplicates `load()`/`replay()` from `verify_strategy_book.js` because that file is an IIFE with no module guard
- **Engine**: `modules/strategy_book.js` + `modules/execution.js`, the production pair
- **Model version**: concentration `FT_TOP3BUY_TOP3SELL_V1` / `v3` (see the same-day concentration parity work)
- **Universe / period**: 650 tickers, 2024-04-03 .. 2026-08-13, 56 rebalance decisions at a 10-bar cadence
- **Costs**: 0.20% buy / 0.30% sell, unchanged
- **Harness validity**: reproduced the golden fixture hash `9b41c9d4c5b2512992c607777e0ede14` exactly before any tuning was run. A harness that cannot rederive the fixture is not the production engine and its numbers would mean nothing.

**Why the v3 CAGR drop was misread at first.** Switching concentration to the reference-site definition dropped backtest CAGR 20.10% → 15.84%, which looked like "correctness cost performance". It is not that. `posfrac()` — the measure the veto ranks on — reads **only the sign of `dn0`**:

```
for j in window: if (dn0[j] > 0) pos++; cnt++
return cnt >= posfracMinReal ? pos/cnt : null
```

so the magnitude half of v2→v3 (the halving) was irrelevant, and `dnBound: 100` clipping is irrelevant too since clipping preserves sign. What moved the strategy was the **13.4% of `dn0` values that changed sign**.

**Result — the optimum is interior, on two independent axes:**

| vetoFrac | 0.2 | 0.3 | **0.4** | 0.5 | 0.6 | 0.7 | 0.8 |
|---|---|---|---|---|---|---|---|
| CAGR pos=6 | 25.69% | 35.39% | **48.86%** | 43.28% | 28.41% | −4.42% | −5.22% |
| CAGR pos=8 | 15.84% | 28.16% | **36.45%** | 31.59% | 14.68% | 1.62% | 4.33% |

Peaks at 0.40 for both position sizes and falls away either side, so it is not a boundary artefact of a too-narrow grid. Max drawdown is also **lowest** near the optimum (11.92% at 0.4/pos6 against 17.16% at 0.2/pos6) — better on return and on risk, not a trade between them. Direction agrees with EXP-016: persistent top-3-broker buying predicts underperformance, so vetoing more of it should help.

**Walk-forward** (train 24 decisions, step 8, four folds): every fold independently chose `veto=0.40 pos=6`. Chained out-of-sample equity **2.0451 against the incumbent's 1.3341**, winning 3 of 4 folds.

**Caveats, and they are heavy:**

1. 56 decisions total, of which **26 hold no book at all** (regime flat) — effective sample about 30.
2. **Fold 4 is 0.00% for both arms.** All 8 of its decisions have `exposure 0`. One fold (2025-08 → 2025-11, +58.47% vs +33.96%) carries most of the out-of-sample gap.
3. **The holdout is burned.** The full-sample grid was printed and read, so per `PROMOTION_CONTRACT.md` S3 this window can never again be clean evidence for this parameter search. Only forward data is admissible from here.

**Separate finding — why the strategy is idle.** `exposure = belowSma ? 0 : 1`, and IHSG has closed below its 200-session SMA since **2026-03-02** (106 sessions, third-longest spell in ten years) after falling 30% from the December 2025 peak. Data checked and clean: zero non-positive closes, no recent gaps, IHSG and price tables agree at 2026-08-14. Across 38 such spells the median is 3 sessions, so this is the tail, not the norm; 47.1% of the strategy window sits below the SMA. On a **flat** price the SMA rolls down through the price in ~117 sessions (~Jan/Feb 2027) because the window still carries the 8,227–9,033 prints from Oct 2025 – Jan 2026; a 6.5% rally crosses inside three months.

**Status**: SEALED, NOT PROMOTED. Recorded as `CANDIDATE_SEAL_2026-08-18_vetofrac040.md`, strategy hash `3f98982baa68b452` (incumbent `0bd4f452f2ab01b3`), with the `forward_gate.js` GATE and the S4 control-track requirement pre-registered before any forward data exists. It cannot start yet: a standing-aside strategy produces **zero fills** against a gate that needs 50, so the shadow opens on the first rebalance decision with IHSG above its 200-session SMA. No production parameter was changed.

---

## EXP-030 (2026-08-20) — Does any macro indicator predict IHSG? Nothing survives correction

- **Script**: `scraper/research/macro/exp030_macro_ic.js`
- **Data**: `ft_macro_data`, 20 Yahoo-sourced indicators backfilled to maximum available history (165,966 rows; ~2,528 sessions each inside the IHSG window), target `idx_ihsg_history` 2016-08-01 .. 2026-08-19
- **Question**: not "add a 15th factor" — whether any macro series deserves a place in the **regime layer**, which is the one component with a demonstrated effect (it held exposure at 0 through a 30% fall) and which currently sees only IHSG against its own 200-day average.
- **Design**: strictly-prior features; **non-overlapping anchors** spaced H exchange sessions apart (`multiple_testing.nonOverlappingAnchors`, the EXP-026 helper); Spearman rank IC with a Fisher-z p-value; Benjamini-Hochberg across the whole family; chronological holdout at 2025-02-01.
- **Transforms, fixed before results**: `chg20` (20-session % change) and `z250` (z-score vs trailing 250). **Horizons**: 20 and 60 sessions. 20 x 2 x 2 = **80 hypotheses**.

**Result: 0 of 80 survive FDR at alpha 0.05.** Smallest q-value 0.81.

**The stronger evidence is not the p-values — it is what happened when the sample doubled.** The experiment was first run on 5 years (n=41 train at H=20, n=13 at H=60 — `INSUFFICIENT_DATA` by the project's own tier rule), then re-run on full history (n=101 and n=33). The top five reshuffled almost completely:

| rank | 5-year run | full-history run |
|---|---|---|
| 1 | CHINA_FXI chg20 H20 (IC −0.392) | WTI chg20 H20 (IC +0.209) |
| 2 | COAL_BTU chg20 H60 | EIDO z250 H60 |
| 3 | YIELD_CURVE chg20 H60 | NATURAL_GAS z250 H20 |
| 4 | PALM_PROXY z250 H60 | SILVER chg20 H60 |
| 5 | EIDO z250 H20 | CHINA_FXI z250 H60 |

The 5-year leader — IC −0.39, uncorrected p=0.011, and *the same sign out of sample* — vanished from the table entirely once more data arrived. A leaderboard that does not survive its own sample being doubled is noise, and that is a more useful demonstration than any single q-value.

**Rows that at least keep their sign across train and holdout** (none significant; holdout n is only 17–18): NATURAL_GAS z250 H20 (+0.201 / +0.245), CHINA_FXI z250 H20 (−0.156 / −0.152), SPY chg20 H20 (−0.146 / −0.387), VIX chg20 H20 (+0.144 / +0.316), USDIDR chg20 H20 (−0.131 / −0.243). The last is economically the most sensible — a weakening rupiah preceding weaker IHSG — and is the only one worth a pre-registered test if this is revisited.

**Caveats, and they are the point:**

1. **Non-overlapping anchors are brutal on n.** Ten years of daily data yields ~100 independent 20-session observations and ~33 at 60. That is `EXPLORATORY` tier at best. This is *absence of evidence*, not evidence of absence.
2. **The holdout is burned.** It was read in the 5-year run and again in the full-history run. This family of hypotheses can no longer be tested cleanly on this window; a genuine confirmation needs data that does not yet exist, or a different market.
3. **The second run is exploratory by construction** — it followed a null result and changed the sample. Recorded as such rather than presented as a confirmation.
4. FRED series (FED_RATE, CPI, MFG_EMPLOYMENT, UNEMPLOYMENT, GDP) were **excluded**: `FRED_API_KEY` has never been set, so they hold zero rows. Whether US rates and inflation predict IHSG is untested, not answered.

**Status**: NULL RESULT, EXPLORATORY. **No macro indicator is admissible for the regime layer on this evidence.** No production change made; the macro feed remains a display layer, and the regime switch is unchanged.

---

## EXP-031 (2026-08-20) — Pre-registered: currency weakness does NOT predict emerging-market equity returns

- **Pre-registration**: `PREREGISTRATION_2026-08-20_fx_equity.md`, committed as `ea05c4c` **before the test was run**. Git history timestamps the specification earlier than the result it judges.
- **Scripts**: `scraper/research/macro/exp031_fetch.py` (writes a fixed JSON sample) and `exp031_fx_equity.js` (reads that file and nothing else, so the same test is the same test on every run).
- **Hypothesis**: a rise in USD/local over 20 sessions predicts a **lower** local equity return over the following 20. One-sided, direction fixed in advance.
- **Out-of-sample set**: nine EM markets never previously queried by this project — India, Thailand, Philippines, Malaysia, Brazil, Mexico, Turkey, South Africa, Korea. Indonesia run separately and **excluded** from the statistic.
- **Method**: strictly-prior `chg20`; non-overlapping anchors 20 sessions apart on each market's own calendar; Spearman rank IC; Stouffer combined Z. **m = 1**, so no multiplicity correction applies.

**Result: NOT CONFIRMED.** Combined Z = **+0.303**, one-sided p = **0.619**.

| market | n | IC | market | n | IC |
|---|---|---|---|---|---|
| India | 121 | +0.015 | Mexico | 124 | +0.036 |
| Thailand | 118 | −0.030 | Turkey | 123 | +0.088 |
| Philippines | 119 | −0.081 | South Africa | 123 | +0.053 |
| Malaysia | 121 | +0.003 | Korea | 121 | −0.034 |
| Brazil | 122 | +0.029 | | | |

Three of nine negative, against 4.5 expected under the null. The combined Z is **positive** — not a near-miss in the predicted direction, but a drift the other way.

**This is not an underpowered null, and that distinction is the whole value of the experiment.** Unlike EXP-030 (n=13–41 at some horizons), each market carries ~121 non-overlapping anchors, ~1,090 pooled. The design detects a uniform IC of **−0.0505** at p<0.05. Had every market shown the Indonesian effect (IC −0.136), the combined Z would have been **−4.45, p = 4.4e-6**; had only half of them shown it, **Z = −2.22, p = 0.013**. The test had ample power to find an Indonesia-sized effect and did not.

**The in-sample comparison is the finding.** Indonesia's IC is **−0.136** — larger in absolute value than any of the nine out-of-sample markets, in either direction. An effect that exists only in the market it was discovered in, and vanishes in nine others, is the textbook shape of a result that was never there.

**Conclusion**: H1 is falsified. Currency weakness is not a usable regime input on this evidence, and the EXP-030 hint that suggested it was noise. No production change; the macro feed remains a display layer and the regime switch is untouched.

**Method note worth keeping.** The holdout problem was solved by moving *across markets* rather than forward in time. Waiting for fresh Indonesian data would have needed ~2.4 years to reach 30 non-overlapping anchors; nine untouched markets supplied 1,090 observations the same afternoon. Where a hypothesis is about a mechanism rather than about one instrument, other instruments are a legitimate — and immediate — out-of-sample set.

---

## EXP-032 (2026-08-20) — The 17 FRED series: nothing survives, and one coherent candidate

- **Script**: `scraper/research/macro/exp032_fred_ic.js`
- **Data**: 17 FRED series (52,845 rows) fetched via the keyless public CSV endpoint; target `idx_ihsg_history` 2016-08-01 .. 2026-08-20
- **Holdout**: from 2025-02-01, **clean for these series** — EXP-030 burned its holdout on the 20 Yahoo indicators, which did not include any of these.
- **Design**: as EXP-030 — step function of last-known values, non-overlapping anchors, Spearman rank IC, Benjamini-Hochberg over the whole family. 17 x 2 transforms x 2 horizons = **68 hypotheses**.

### The trap that would have invalidated the whole thing

**FRED dates an observation by the period it describes, not by its release.** July CPI carries the date `2026-07-01` and is published around 13 August. Aligning it to the session of 1 July hands the model six weeks of future knowledge, and the resulting "predictive power" is the release leaking backwards.

That defect is invisible in the output — it produces strong, stable, plausible ICs, and would have been the most convincing wrong answer this project has produced. Every series therefore carries a **publication lag** and becomes visible only at the first session on or after `period_end + lag`. Verified rather than assumed:

```
CPI period 2026-06-01 -> period ends 06-30 -> usable from 2026-07-18
CPI period 2026-07-01 -> period ends 07-31 -> usable from 2026-08-18
```

So a session in mid-July sees **May** CPI. Lags run 1 day (daily market series) to 32 days (PCE, M2), rounded up.

**Result: 0 of 68 survive FDR at alpha 0.05.**

### The one coherent candidate, and why it is not a finding

| series | transform | H | n train | IC train | p | IC holdout | n hold |
|---|---|---|---|---|---|---|---|
| `INFL_EXP_5Y` | chg20 | 20 | 102 | −0.240 | 0.0149 | **−0.335** | 18 |
| `INFL_EXP_10Y` | chg20 | 20 | 102 | −0.218 | 0.0277 | **−0.320** | 18 |

Rising US breakeven inflation expectations preceding *lower* IHSG returns is economically coherent (higher expected inflation → tighter Fed → EM outflows), the sign holds out of sample, and the holdout IC is **stronger** than the training one — the opposite of the decay that killed EXP-011's HI52W.

**But the two series are not independent evidence.** 5-year and 10-year breakevens are near-duplicates of the same underlying measure; their agreement is close to one observation, not two. Neither survives correction (q = 0.51, 0.63), and the holdout carries 18 points.

`GDP_GROWTH z250 H=60` has the lowest raw p (0.0010, q=0.0687 — the closest anything has come) but n=31 with a 5-point holdout that **flips sign**. That is the small-n artefact this design exists to expose, not a near-miss.

**Status**: NULL under correction. `INFL_EXP` is registered as a **candidate for a separate pre-registered test**, not a finding. The obvious form is the EXP-031 design — one hypothesis, one-sided, tested across EM markets whose data has never been read — since US inflation expectations should move all of them if the mechanism is real.

**The holdout for these 17 series is now burned.**

---

## EXP-033 (2026-08-20) — Pre-registered: US inflation expectations do NOT predict EM equities at a usable size

- **Pre-registration**: `PREREGISTRATION_2026-08-20_inflexp_em.md`, committed in `765e523` **before** the test ran
- **Scripts**: `scraper/research/macro/exp033_fetch.py` (sample) and `exp033_inflexp_em.js` (test), committed unchanged in the same commit
- **H1**: a rise in US 5-year breakeven inflation over the prior 20 sessions predicts a **lower** forward 20-session return on emerging-market equities. One-sided, direction fixed in advance.
- **Predictor**: `INFL_EXP_5Y` (FRED `T5YIE`) `chg20`, carrying EXP-032's 1-day publication lag
- **Out-of-sample set**: six USD-denominated country ETFs never queried by this project — `VNM`, `GXG`, `EPU`, `KSA`, `ECH`, `EPOL`
- **Decision rule, fixed in advance**: CONFIRMED only if one-sided p < 0.05 **and** IC negative

### The design problem this one had and EXP-031 did not

EXP-031 combined nine markets with Stouffer, and that was legitimate: each market had **its own currency**, so each was an independent test of a *local* mechanism.

This predictor is **global**. One US series against many co-moving EM markets is **not** N independent tests — the markets move together and the predictor is identical across them. Combining per-market z-scores here would have inflated significance for exactly the reason overlapping windows do, and it would have inflated it in the direction of the answer being hoped for.

So the unit of observation was fixed as the **anchor date**: the six markets are averaged into one equal-weighted basket and a **single** IC is computed. `n` is the count of non-overlapping anchors, never the market count times the date count. m = 1, so no multiplicity correction applies.

**Result: NOT CONFIRMED.**

| | |
|---|---|
| shared trading dates | 2,488 (2016-08-22 .. 2026-07-17) |
| non-overlapping anchors (n) | **123** |
| basket rank IC | **−0.0859** |
| z | −0.943 |
| one-sided p | **0.173** |

Secondary and descriptive only, as pre-registered — these do not rescue the primary and are not the result:

| market | IC | market | IC |
|---|---|---|---|
| VNM | +0.095 | KSA | +0.060 |
| GXG | −0.099 | ECH | −0.079 |
| EPU | −0.100 | EPOL | −0.132 |

4 of 6 negative, against 3 expected under the null.

### What the number does and does not say

**It is not a sign flip.** Unlike EXP-031 — where the combined Z came out *positive*, drifting against the hypothesis — the basket IC here is negative, the predicted direction. That is the honest reading, and it is also the whole extent of the support.

**But the magnitude is the point.** At n=123 the design detects **|IC| ≥ 0.149** at one-sided p<0.05. The Indonesian result that generated this candidate was −0.240 in training and −0.335 in the holdout; had either magnitude been present in the basket it would have landed at **z = −2.68** or **−3.82**. It landed at −0.94. The effect that made `INFL_EXP` interesting is not there at the size that made it interesting — the basket IC is roughly a third of it.

**And an effect this small is not reachable.** Confirming a true IC of −0.086 at this threshold needs **~368 non-overlapping anchors — about 29 years** of 20-session windows. A relationship that requires three decades to distinguish from noise is not a regime input regardless of whether it is real.

**Conclusion**: H1 is not confirmed. `INFL_EXP` is closed as a candidate. No production change: the macro layer remains a display and context surface, and the regime switch is untouched. EXP-032's Indonesian rows stay what they were — a coherent story that did not survive its own correction and now has not been reproduced anywhere else.

### Two caveats recorded rather than buried

**`GXG` stops on 2026-07-17.** The other five run to 2026-08-20. Under the pre-registered rule — dates where any ETF lacks a close are dropped, never carried forward — the shared calendar simply ends there, costing ~25 sessions at the recent end. This was discovered when the sample was fetched, i.e. after the design was committed and before any return was computed, so it changed nothing about the test.

**Three markets sat out on purpose, and the reasons predate the result**: Argentina (`^MERV`, nominal peso returns under triple-digit inflation measure currency collapse, not equities), Taiwan (`^TWII`, local currency in a USD basket), and the nine EXP-031 markets (already read once). Chile, Poland, Greece, Hungary, Czechia and Egypt were checked for availability and had too little history. Availability was verified before the pre-registration was written; availability is not a result.

**The holdout for this hypothesis is now burned.**

---

## EXP-034 (2026-08-21) — Pre-registered: a US core CPI surprise DOES predict the next IHSG session

- **Pre-registration**: `PREREGISTRATION_2026-08-21_cpi_surprise.md`, committed in `5cb5679` **before** the test ran
- **Script**: `scraper/research/macro/exp034_cpi_surprise.js`, committed in the same commit
- **H1**: a US core CPI month-on-month print **above** consensus predicts a **lower** IHSG return in the first Jakarta session after the release. One-sided.
- **Data**: `ft_econ_calendar` (Nasdaq's licensed investing.com feed), 2016-08-01 .. 2026-08-20

**Result: CONFIRMED.** rank IC **−0.1658**, one-sided p **0.0358**, n **119**.

| | |
|---|---|
| releases with actual and consensus | 124 |
| duplicates dropped | 5 |
| kept | 119 (41 came in exactly at consensus, kept) |
| rank IC | **−0.1658** |
| z | −1.802 |
| one-sided p | **0.0358** |

### Why this one is different from EXP-030/031/032/033

Those tested realised levels and changes — statements about the world. This tests
a **surprise**, a statement about what was *not already priced*. A 0.3% core print
is bullish or bearish depending only on whether 0.2% or 0.4% was expected, and no
level can carry that. `consensus` is the one field the FRED-based work never had.

### The timing is the design, not a detail

Core CPI releases 08:30 US Eastern = **20:30 Jakarta, after the IDX close**. The
release-day close therefore genuinely precedes the information and the first
tradeable reaction is the next session. Anchoring one day earlier would measure a
return that happened *before* the news — which is exactly what the feed's
one-day filing offset would have produced had it not been corrected first.

### Two corrections made before any return was joined

**`seq` is not a label.** A CPI release puts several rows at one timestamp under
one name. Measured against FRED's CPIAUCSL, using row order would mislabel
**50 of 247 rows (20.2%)**, averaging month-on-month and year-on-year into one
column. Each row was matched to the nearer of the expected MoM/YoY with the
assignment required to be a bijection; `CPI 2020-07-14`, where MoM 0.48 and YoY
0.72 both round to the printed 0.6, was left unlabelled rather than guessed.

**Five releases are listed twice**, on consecutive dates with identical values.
The later of each pair was kept, corroborated internally: on that date the
weekday-fixed companions line up (MBA on a Wednesday, jobless claims on a
Thursday).

### Secondary, pre-declared non-decisive — reported as such

| | IC | p | n |
|---|---|---|---|
| 5-session horizon | −0.083 | 0.186 | 119 |
| headline CPI, 1 session | −0.125 | 0.089 | 118 |

Both point the predicted way and neither is significant. The tails:

| | n | mean next session |
|---|---|---|
| biggest undershoots | 8 | **+0.228%** |
| all releases | 119 | +0.015% |
| biggest overshoots | 8 | **−0.388%** |

A ~0.62pp spread between the tails, ordered the way the mechanism says.

### How much this is worth, stated plainly

**It clears its rule, and it clears it narrowly.** p = 0.036 on a single
one-sided test. The pre-registration fixed the power in advance — this n detects
|IC| ≥ 0.152 — and the measured effect is barely above that floor. Nothing here
would survive a multiplicity correction if it had been one of a family; it is
significant *because* it was the only thing tested, which is the entire point of
registering one mechanism, and also the limit of what that buys.

Three weaknesses worth naming before anyone quotes the number:

1. **A third of the sample has no signal.** 41 of 119 prints came in exactly at
   consensus. They are kept deliberately — dropping them selects on the outcome —
   but they are ties, and the effective sample carrying information is 78.
2. **The effect leans on the tails.** The decile spread rests on 8 observations
   each side.
3. **One market, one window.** The window covers 2021–22, when inflation
   surprises were unusually large and markets unusually rate-focused. The effect
   may be regime-specific, and a split-half check was **not** pre-registered, so
   running one now would be post-hoc.

**What it licenses**, per the pre-registration and nothing more: one registered
experiment into whether a US-inflation-surprise condition improves the **regime
layer**. It does not license a production parameter change, a new composite
factor, or trading the event — IDX opens with the move already in the overnight
US market, so an IC on the next close is evidence about a mechanism, not about a
fill anyone could get.

**The obvious next test is the EXP-031 move**: the same surprise against EM
markets whose returns this project has never read. If the mechanism is real it
should appear there too; if it appears only in Indonesia, EXP-031's lesson
applies and it was never there.

**This sample is now spent.**

---

## EXP-035 (2026-08-21) — The CPI-surprise effect does NOT replicate across Asia at significance

- **Pre-registration**: `PREREGISTRATION_2026-08-21_cpi_asia.md`, committed in `f048e99` **before** the test ran
- **Scripts**: `scraper/research/macro/exp035_fetch.py` and `exp035_cpi_asia.js`, same commit
- **H1**: the same US core CPI MoM surprise predicts a **lower** return on a basket of five untouched Asian indices in the first session each trades after the release. One-sided.
- **Basket, chosen by rule** (every major Asian index with ≥2,400 sessions never read here): `^TWII`, `^STI`, `^HSI`, `000001.SS`, `^N225`

**Result: NOT REPLICATED.** basket rank IC **−0.0420**, one-sided p **0.3253**, n **119**.

| | EXP-034 (IHSG) | EXP-035 (Asia basket) |
|---|---|---|
| rank IC | −0.1658 | **−0.0420** |
| one-sided p | 0.0358 | **0.3253** |
| n | 119 | 119 |

### What this does and does not falsify

**It does not falsify EXP-034, and the pre-registration said so before the run.**
Only a *positive* basket IC would have been counter-evidence — the EXP-031
signature, where the effect drifts the wrong way outside the market it was found
in. The IC here is negative, the predicted direction, and at n=119 this test
would clear 0.05 only about half the time even if the true effect equalled
EXP-034's.

**But EXP-034 should be read down.** The mechanism did not reach significance in
five other markets that, on its own logic, should show it. Six markets have now
been asked and exactly one answers at p < 0.05 — the one where the effect was
discovered. That is not the outright falsification of EXP-031, but it is the same
family of warning.

### Secondary, pre-declared non-decisive

| market | n | IC |
|---|---|---|
| Taiwan `^TWII` | 116 | −0.138 |
| Hong Kong `^HSI` | 119 | −0.126 |
| Singapore `^STI` | 119 | −0.088 |
| Shanghai `000001.SS` | 115 | −0.081 |
| Japan `^N225` | 119 | +0.014 |

4 of 5 negative, against 2.5 expected under the null.

The tails are ordered the way the mechanism says, and **more strongly than in
Indonesia**:

| | n | mean basket next session |
|---|---|---|
| biggest undershoots | 8 | **+0.574%** |
| all releases | 119 | +0.104% |
| biggest overshoots | 8 | **−0.503%** |

A ~1.08pp spread, against EXP-034's 0.62pp on IHSG.

### A design fault in my own pre-registration, stated rather than buried

The pre-registration argued that averaging *should raise* the IC: "idiosyncratic
local noise cancels while a common reaction does not, so if the mechanism is real
the basket IC should be larger than any single market's."

**It came out smaller.** The five per-market ICs average about −0.086; the basket
reads −0.042 — worse than every member except Japan.

The reason is that the basket equal-weights **raw returns**, so the highest-
variance members (Shanghai, Nikkei) dominate it, and those are the two least
responsive. Equal-weighting *standardised* returns would have been the right
estimator of a common reaction. That choice was made in advance and is not being
changed now — re-running with a better estimator after seeing this number is
exactly the p-hacking this apparatus exists to prevent. It is recorded as a
constraint on the next pre-registration, not as a reason to discount this one.

### Status

The mechanism now has **weak, directionally consistent support across six
markets** — five of six ICs negative, tails ordered correctly in both tests — and
**significance in exactly one**. That is a hypothesis worth one more properly
powered look, not an input to anything.

**No production change.** The macro layer remains display and context; the regime
switch is untouched. EXP-034's licence to try a regime-layer experiment stands,
but on weaker grounds than it looked yesterday.

**This sample is now spent.**

---

## EXP-036 (2026-08-30) — Volume zones beat arbitrary bands. Three quarters of that is proximity.

- **Pre-registration**: `PREREGISTRATION_2026-08-30_volume_zones.md`, committed in `8ee56d3` **before** the test ran
- **Script**: `scraper/research/exp036_volume_zones.js`, same commit
- **H1**: swing pivots in the next 60 sessions land inside the top volume shelves of the prior 500 sessions **more often** than inside an equal number of equally wide bands drawn from the same visited range. One-sided.
- **Design**: zones from `[t-500, t]`, pivots counted in `(t, t+60]` — **no bar on both sides**. Unit of observation is the TICKER (as-of windows overlap heavily), n = 100.

**Result: CONFIRMED.** mean paired difference **+5.668 pp**, t **8.530**, one-sided p **< 0.000001**, 84 of 100 tickers positive.

### The trap the design avoided

A shelf is high-volume *because* price spent time there, and price spent time
there *because* it kept turning there. Counting the turns that **created** the
shelf as evidence the shelf works is circular and would produce a large, clean,
entirely fake result. Every zone is therefore built from data strictly before the
window it is judged on.

### And then a post-hoc check took most of it away

`scraper/research/exp036b_proximity_control.js`, **not pre-registered** and
labelled so — it cannot change the verdict, only what the verdict means.

The registered control drew buckets price had **visited**. That is a weak match:
a bucket visited for two days at the top of a spike counts as visited and is
nowhere near where price is now. Meanwhile the top shelves sit, almost by
construction, close to where price has been — and future pivots cluster there
too. So part of +5.668 pp is "these bands are near the current price", which is
true of *any* band near the current price and says nothing about volume.

Re-run with the control matched on **log-distance from the as-of close**:

| | registered | proximity-matched |
|---|---|---|
| mean difference | **+5.668 pp** | **+1.417 pp** |
| t | 8.530 | 2.291 |
| one-sided p | <0.000001 | 0.011 |
| tickers positive | 84/100 | 60/100 |

**Volume survives 25% of the headline effect.** The remaining +1.4 pp is real on
this evidence but modest, and 60/100 is a long way from 84/100.

1,333 of 2,821 windows were dropped because no proximity-matched control existed
— for nearly half the windows the top shelves sit at distances where no other
visited bucket lives, which is itself a statement about how concentrated they are.

### The `turns` column does NOT do what the report implies

The deployed report highlights a zone's turn count, on the reasoning that a shelf
price actually reversed at is worth more than one it passed through. Measured out
of sample, restricting to zones with prior turns gives **+5.315 pp against
+5.668 pp for all zones** — very slightly *worse*.

That was my own design claim and the data does not support it. Pre-declared
non-decisive, and reported as a negative rather than dropped.

### What does hold up

Hit rate declines monotonically with volume rank — rank 1 catches 4.83% of
forward pivots, falling to 2.72% at rank 8. Every one of those eight bands is
"near price", so a pure proximity story does not predict the ordering. Volume is
doing something; it is just doing much less than the headline number claimed.

### A data fault found while chasing a NaN

930 rows (0.09%) have `low_price` NULL or ≤ 0. `Math.log(0)` makes every bucket
edge NaN, so any 500-session window containing one produces meaningless zones.
**12 of 2,856 windows (0.4%)** were affected.

The direction matters and is favourable: a NaN grid makes the real bands *and*
the control bands NaN, both hit rates 0, and the pair contributes exactly 0 to
the mean. It dilutes toward zero and cannot manufacture an effect. The registered
figure is an understatement, so no re-run was performed against the frozen sample.

### Status

**Per the pre-registration, this licenses exactly one thing**: the zone table
moves out of the report's `NOT COVERED` block with its measured effect printed —
and the number printed is **+1.4 pp**, the proximity-controlled one, not the
headline.

It does **not** license a trading rule, a factor, or any production parameter.
"Pivots land here slightly more than chance" is not "acting on it makes money" —
EXP-016 remains the standing example of a real relationship whose obvious action
had the wrong sign.

**This sample is now spent.**

---

## EXP-037 (2026-08-30) — Buying a volume support zone LOSES to simply holding the stock

- **Pre-registration**: `PREREGISTRATION_2026-08-30_zone_profitability.md`, committed in `9c9dafb` **before** the test ran
- **Script**: `scraper/research/exp037_zone_profitability.js`, same commit
- **H1**: buying when the close enters a support zone and holding 20 sessions returns more, **net of costs**, than the same stock returned unconditionally over the same horizon. One-sided.
- **Rule**: zones from the prior 500 sessions refreshed every 20; entry at the **next open**; hold 20 sessions; **0.6% round trip** fixed in advance; no stop; long only; unit of observation the ticker, n = 99.

**Result: NOT PROFITABLE.** mean per-ticker excess **−1.643%**, t **−3.567**, one-sided p **0.9998**. 1,873 trades across 99 tickers.

| | |
|---|---|
| mean excess, net of costs | **−1.643%** |
| mean excess, **before** costs | **−1.043%** |
| mean raw trade return, net | −0.002% |
| the benchmark it lost to | **+1.641%** |
| win rate | 43.2% |
| tickers with positive excess | 36 of 99 |

### Costs are not the excuse

The gross excess is **−1.043%**, already negative before a single rupiah of
brokerage. The 0.6% hurdle was registered in advance precisely so it could not be
blamed afterwards, and it is not to blame: the rule loses on its own merits and
the costs then make it worse.

### What this actually says

Trades came out roughly **flat** (−0.002% net), while simply holding the same
stocks over the same 20-session windows returned **+1.641%**. Buying into a
support zone means buying weakness, and on this sample the weakness continued
long enough to give up the drift that doing nothing would have collected.

No pattern by zone rank — rank 7 is the only positive cell (+1.59% over 118
trades) among eight, which is what one positive cell out of eight looks like.

### And this is the survivorship-inflated version

`backfill_price_history.js` only ever fetched tickers present in
`idx_broker_summary`, and twelve suspended or delisted names were removed in July
2026 — exactly the ones that would have blown up. **The true figure is worse than
−1.643%.**

### EXP-036 and EXP-037 together are the point

EXP-036 found pivots land in these zones **+1.4pp** more often than in matched
bands. EXP-037 finds that trading them loses 1.6pp to doing nothing. **Both are
true.** A zone catches more turns in *either* direction, a pivot is only
identifiable three bars after it happened, and being a place where price often
turns is not the same as being a place where buying pays.

This is the third time this project has found the obvious action on a real
relationship to have the wrong sign — after EXP-016 (persistent top-3-broker
buying predicts UNDERperformance) and the scanner score turning out to describe
the same day rather than forecast the next.

### On the sign, and what is not being claimed

The point estimate is strongly negative and would clear significance in the
opposite direction. **Reversing a hypothesis after seeing its sign is exactly the
move this apparatus exists to prevent**, so no claim is made that this is a
tradeable short or a fade signal. What can be said without a new test is only the
registered statistic read with its actual sign: buying these zones underperformed
holding.

### Status

**Per the pre-registration, a negative result licenses saying so on the page.**
Done: the zone table stays as a description of where transactions happened, now
with the profitability question answered rather than left open.

No production change. No paper-trading run — that was reserved for a positive
result.

**This sample is now spent.**

---

## EXP-038 (2026-08-30) — Buying INTO resistance: no difference, and neither reading survives

- **Pre-registration**: `PREREGISTRATION_2026-08-30_resistance_zones.md`, committed in `2b15870` **before** the test ran
- **Script**: `scraper/research/exp038_resistance_zones.js`, same commit
- **H1 (TWO-SIDED)**: buying when the close rises **into** a resistance zone and holding 20 sessions returns something **different**, net of costs, from the stock's unconditional 20-session return.
- **Rule**: the exact mirror of EXP-037 — only the zone predicate and the direction of approach change. Verified by diffing the two scripts.

**Result: NO DIFFERENCE.** mean per-ticker excess **−0.641%**, t **−1.577**, two-sided p **0.115**. 2,005 trades across 99 tickers.

### Why this was two-sided, and why that mattered

EXP-037 found buying into support underperformed by 1.6%. The momentum reading of
that predicts the mirror should **out**perform; the textbook predicts resistance
rejects and it should be the worst entry available. Holding a real prior one way
and the convention the other, claiming a direction would have been either
posturing or fitting the hypothesis to a result already seen.

That choice earns its keep here. **−0.641% at p = 0.115 licenses no claim at all**
— and it happens to point the textbook way, which a one-sided registration in
that direction would have converted into a "finding" at p = 0.057. It is not one.

### Neither reading survives

| | |
|---|---|
| mean excess, net | −0.641% (p = 0.115) |
| mean excess, **gross** | **−0.041%** |
| mean raw trade return, net | +0.936% |
| the benchmark | +1.577% |
| win rate | 43.3% |
| tickers positive | 37 of 99 |

The momentum reading predicted positive and got −0.64%. The textbook reading
predicted strongly negative and got something indistinguishable from zero. **The
gross excess is −0.041%** — resistance entries are essentially neutral before
costs, and only the 0.6% hurdle pushes them negative. That is a materially
different picture from support, which was already −1.043% gross.

### The paired secondary, and a process failure

The pre-registration listed "the paired support-vs-resistance difference per
ticker" as secondary 1. **The committed script does not compute it.** That is a
gap between what was registered and what was shipped; it was computed afterwards
in a separate run and is reported as an after-the-fact computation, even though
the quantity itself was pre-declared and non-decisive.

| | |
|---|---|
| mean excess, support | −1.512% |
| mean excess, resistance | −0.657% |
| paired difference | **+0.855 pp** (resistance minus support) |
| t / two-sided p | 1.379 / **0.168** |
| tickers where resistance beat support | 56 of 98 |

**The two sides are not distinguishable from each other either.**

### What EXP-036, EXP-037 and EXP-038 say together

1. Pivots land in volume zones **+1.4pp** more often than in matched bands
   (EXP-036) — a real regularity.
2. Buying at support underperforms holding by **1.6%** (EXP-037) — significant.
3. Buying at resistance underperforms by **0.6%** (EXP-038) — not significant.
4. The two sides cannot be told apart (p = 0.168).

The comparison is like-for-like — a 20-session return inside a trade against the
average 20-session return of the same stock — so this is about **which windows
get selected**, not about time out of the market. Zone-touch entries select
20-session windows that do worse than an average one, and the support side does
so more.

**No directional claim is made about resistance.** A two-sided test that does not
clear licenses no statement about the sign, however suggestive −0.641% looks.

*** SURVIVORSHIP-BIASED RESEARCH RESULT — biased UPWARD ***

### Status

No production change. Nothing here licenses shorting — that was excluded in
advance, since IDX shorting is impractical for this account and a negative result
would be a reason not to buy rather than a trade. The avoidance follow-up the
pre-registration described is **not** triggered: it required the underperformance
to clear, and it did not.

**This sample is now spent.**

---

## EXP-039 (2026-09-01) — Horizon scan: the arithmetic holds, the thesis does not

A **scan on half the universe**, not a test. Odd-ranked tickers scanned,
even-ranked reserved and untouched. `scraper/research/exp039_horizon_scan.js`.

### The arithmetic that motivated it, computed before any signal

| horizon | median return sd | 0.6% cost as % of that |
|---|---|---|
| 5 | 7.5% | 8.0% |
| 20 | 16.3% | 3.7% |
| 60 | 28.3% | 2.1% |
| 120 | 36.7% | 1.6% |

A fixed cost shrinks against a widening return distribution. That part is
arithmetic and it is not in dispute.

### Two mistakes I made reading my own scan

**First**, the scan reported mean excess and the means looked wonderful at
H=120 — `near 52w high` +15.19%, `below all volume zones` +4.02%. Nearly
everything turned positive at the longest horizon, which is the shape of an
artefact rather than six independent edges appearing at once.

**Second**, I then checked consistency, found the median month negative and only
34–52% of months positive, and read that as evidence against the signals. **That
was also wrong.** 120-session returns are right-skewed, so mean > median, and
subtracting the ticker's own *mean* as the benchmark leaves a negative median
**by construction, with or without an edge**.

Neither reading survived the thing that was missing both times: a control.

### The null — random entries, same benchmark, same costs, month as the unit

| horizon | months positive | mean | median |
|---|---|---|---|
| 20 | 44% | −0.56% | −1.16% |
| 60 | 43% | +0.86% | −1.61% |
| 120 | 38% | +2.15% | −5.81% |

A coin-flip entry already produces a negative median and sub-50% positive months.
Everything must be read against this row, not against zero.

### What the signals look like once the null is subtracted

| signal | H=20 vs null | verdict |
|---|---|---|
| zone support touch | 34% / −1.36% / −2.26% | **worse than random on all three** |
| zone resistance touch | 37% / −1.36% / −1.48% | worse than random |
| below all volume zones | 46% / −0.50% / −0.72% | indistinguishable |
| drawdown >20% from high | 41% / −0.45% / −0.99% | indistinguishable |
| above all volume zones | 49% / +1.21% / −0.11% | **better on all three** |
| near 52w high (<3%) | 52% / +2.89% / +0.54% | **better on all three** |

(null at H=20: 44% / −0.56% / −1.16%)

The two zone-touch rules are worse than random at **every** horizon, which is
independent confirmation of EXP-037 and EXP-038 from a different statistic.

### And the thesis this scan was built to support is NOT supported

The idea was that a fixed cost hurdle makes longer holds better. The hurdle does
shrink — 8.0% of noise at H=5 down to 1.6% at H=120 — but **the separation
between signal and null does not improve with horizon.** The cleanest gap in the
whole scan is at **H=20**; by H=120 the null itself earns +2.15% and the
discrimination is buried in variance.

Costs stop being the binding constraint at long horizons. Something else takes
over, and it is not answered here.

### What it does point at

`near 52w high` beats the null on all three statistics at all three horizons —
and that is **HI52W, the signal the flagship strategy already uses**. The scan
looked at six candidates and pointed back at the one already in production.

`above all volume zones` also beats the null and is **untested**. But it is
probably not independent: a stock trading above every one of its volume shelves
is very likely also near its 52-week high. Whether it adds anything over HI52W is
a question about orthogonality, which is the next thing to measure and is not
answered by this scan.

**NO VERDICT.** These numbers are selected by inspection on half the universe and
cannot be quoted as findings. The reserved half is untouched.

*** SURVIVORSHIP-BIASED — biased UP ***
