# Sealed candidate — HI52W vetoFrac 0.40 / positions 6

**Sealed 2026-08-18T05:27:56Z at commit `cc76055`.** Nothing below may be edited.
A correction gets a new file that says what it supersedes; changing this one
destroys the only thing it is for.

---

## The identity being sealed

| | |
|---|---|
| strategy id | `HI52W_REGIME_BROKERVETO_V1` |
| **candidate strategy_hash** | **`3f98982baa68b452`** |
| incumbent strategy_hash | `0bd4f452f2ab01b3` (live in `virtual_accounts`) |
| execution policy hash | `c1e3cc7a25dd6e3c` |
| changed from incumbent | `vetoFrac 0.20 → 0.40`, `positions 8 → 6` |

The hash is the one `strategy_forward.js` computes and
`virtual_accounts.strategy_hash` stores. The sealing script was required to
reproduce the **live incumbent hash** before its candidate output was accepted —
a hash function that cannot rederive a hash already in the database is not the
production one, and its output would prove nothing.

Full effective configuration, exactly as it enters the hash:

```json
{
  "advWindow": 20, "bufferMult": 2, "buyCost": 0.002, "dnBound": 100,
  "executionLedgerVersion": 2, "executionPolicyHash": "c1e3cc7a25dd6e3c",
  "exitOnVeto": true, "hiBars": 252, "minAdv": 5000000000, "minEligible": 20,
  "minHiWindowBars": 200, "modelVersion": "1.0.0-forward", "posfracMinReal": 35,
  "posfracWindow": 60, "positions": 6, "rebalanceBars": 10, "regimeSma": 200,
  "requirePosfrac": true, "sellCost": 0.003, "vetoFrac": 0.4
}
```

## Why this candidate exists

The v3 concentration model (`FT_TOP3BUY_TOP3SELL_V1`) changed the sign of 13.4%
of stored `dn0` values. `posfrac()` — the measure the veto ranks on — reads
**only the sign**, so the magnitude half of the v2→v3 change was irrelevant and
the sign half was everything.

Evidence, produced before sealing:

- **Interior optimum, not a grid edge.** CAGR peaks at `vetoFrac` 0.40 on BOTH
  position sizes and falls away either side (pos=6: 25.7 / 35.4 / **48.9** /
  43.3 / 28.4 / −4.4; pos=8: 15.8 / 28.2 / **36.5** / 31.6 / 14.7 / 1.6 across
  0.2→0.7). Max drawdown is also lowest near the optimum (11.9% vs 17.2%), so it
  is not a risk-for-return trade.
- **Walk-forward stable.** Train 24 decisions, step 8: all four folds
  independently chose `veto=0.40 pos=6`. Chained out-of-sample equity **2.0451
  against the incumbent's 1.3341**, winning 3 of 4 folds.
- **Direction agrees with EXP-016**, which found persistent top-3-broker buying
  predicts UNDERperformance — so vetoing more of it should help.
- The harness reproduced the golden-fixture hash
  `9b41c9d4c5b2512992c607777e0ede14` before any of the above was computed, so it
  is the production engine and not a lookalike.

## What is weak about it, recorded now rather than discovered later

- Only **56 rebalance decisions** in the window, and **26 of them hold no book at
  all** (regime flat). The effective sample is about 30.
- **Fold 4 is 0.00% for both arms** — `exposure 0` on all 8 decisions. One fold
  (2025-08 → 2025-11, +58% vs +34%) carries most of the out-of-sample gap.
- **The holdout is already burned.** The full-sample grid was printed and read.
  Per `PROMOTION_CONTRACT.md` S3, a holdout opened to compare candidates cannot
  be un-burned. **This window can never again serve as clean evidence for this
  parameter search.** Only forward data is admissible from here.
- `positions 8 → 6` reduces diversification — a real cost the backtest rewards
  and a live book feels.

## Pre-registered acceptance criteria — fixed now, before any forward data exists

Promotion requires **all** of `modules/forward_gate.js` `GATE`, evaluated on the
candidate's own rows only (`strategy_hash = 3f98982baa68b452`):

| criterion | threshold |
|---|---|
| rebalance decisions | ≥ 24 |
| calendar time | ≥ 12 months |
| distinct regimes | ≥ 3 |
| fills | ≥ 50 |
| profit factor, net | ≥ 1.10 |
| excess vs eligible universe, net | ≥ 0 |

Plus, from `PROMOTION_CONTRACT.md` S4:

- a **control track** on the unchanged incumbent over the identical decisions;
  the candidate must **beat the control**, not merely be positive
- **no replay decision counts as live** — a decision counts only if it was
  recorded before its outcome existed

**What falsifies it:** failing any single gate criterion, or failing to beat the
control. There is no partial credit and no "directionally promising" — if the
window cannot resolve an effect of this size, the honest verdict is
*unresolvable*, in the contract's own wording.

## Why it is not running yet, and what starts it

IHSG has been below its 200-session SMA since **2026-03-02** — 106 sessions, the
third-longest such spell in ten years — after a 30% fall from the December 2025
peak. `exposure = belowSma ? 0 : 1`, so the strategy is **100% cash and produces
zero fills**. A shadow started today would accumulate nothing against a gate that
needs 50 of them.

**Trigger:** the shadow account for `3f98982baa68b452` is opened on the first
rebalance decision where IHSG closes above its 200-session SMA. On a flat price
that is roughly **117 sessions out (~Jan/Feb 2027)**; a 6.5% rally brings it
inside three months.

Until then this file is the whole of the commitment. That is the point — the
parameters are fixed while no result yet exists to tempt anyone into moving them.
