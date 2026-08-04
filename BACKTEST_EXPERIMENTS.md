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
