# FLOAT_MAP_V1 — the model, exactly

Every number the Float Map publishes comes from the code in this directory. The
snapshot carries `modelVersion` and `modelCommit` so any stored value can be
traced back to the source that produced it. **Change a constant here and bump
`MODEL_VERSION` in `float_map_daily.js`** — a stored number whose model nobody
can name is not reproducible.

## What it estimates

Where the *tradable float* was acquired. Each session a fraction of the float
changes hands; the existing distribution is decayed proportionally and the
shares that moved are re-assigned across that day's traded range.

It is **not** a register of holders. Nobody outside KSEI knows who owns what at
what price. The single assumption carrying the whole model is that traded volume
replaces existing holders **at random, in proportion to what they hold**. That is
false in a known direction — long-term holders churn far less than traders — so
the model forgets old cost bases faster than reality does.

## Constants (V1)

| | value | why |
|---|---|---|
| `LOOKBACK` | 250 sessions | about one year of price history |
| `BUCKETS` | 40 | price levels between the window low and high |
| `TURNOVER_K` | 0.75 | not all volume is a genuine change of owner; the same shares are flipped intraday. **A free parameter, fitted to nothing**, printed with every output |
| corporate actions | detected, **excluded** | a >35% single-session move drops the ticker-window rather than adjusting it |

## Per session, per ticker

```
turnover      = volume / floatShares          ← float, NOT shares outstanding
decay         = dist[i] *= (1 - min(1, turnover × TURNOVER_K))
re-assign     = floatShares × t, spread across [low, high],
                triangular kernel centred on typical price (H+L+C)/3
```

**Why free float and not shares outstanding.** A name with 10% float and 2%
daily volume-to-shares rotates 20% of its float per day and its cost
distribution converges on recent prices within a week. Using shares outstanding
would understate rotation by the reciprocal of the float and make every thin,
heavily-traded name look like it still has holders down at the old price.

**Why typical price and not VWAP.** `idx_stock_prices.value` has been 0 since
2026-08-03, and on the days it *is* populated `value / volume` equals the close
exactly — it is `volume × close` and never carried intraday information. Calling
anything derived from it a VWAP would be a lie that survives into every number
downstream.

**Volume is in shares, not lots.** Verified via median daily turnover of 0.58%
of float. Wrong units here would understate every rotation figure 100×.

## Outputs, and what each is worth

Measured in **EXP-2026-08-07-023** (414 cross-sections, 2017–2026, weekly
ranking dates, tie-aware Spearman, date-block bootstrap).

| output | raw IC 60D | residualised on ROC20+ROC60 | status |
|---|---|---|---|
| `avgCostGap` | 0.0075 | **0.0378 \*** (IR 0.23) | the only one worth ranking on — and only as a residual |
| `profitSupply` | 0.0102 | 0.0224 \* | descriptive |
| `distToPeak` | 0.0187 \* | 0.0215 \* | descriptive |
| `rotation20/60` | ~0.016 | ~0.01, n.s. | descriptive |

**Residualising raises the IC** because momentum is itself negatively predictive
in this sample (ROC60 40D −0.0223 \*, 60D −0.0216 \*) and was cancelling part of
the signal. The raw metrics overlap momentum 0.39–0.61, so read straight off a
screen they are the price path with extra steps.

**Scale check.** 0.0378 / IR 0.23 is the same size as EXP-011's HI52W
(0.044 / 0.25), which this project's own registry called *"not a tradeable edge
as it stands"*. This is research output, not an entry signal.

**Robust to the float being wrong.** Perturbing every ticker's float by
exp(N(0,0.30)) over three seeds gave 0.0389 / 0.0381 / 0.0323, and exp(N(0,0.60))
gave 0.0326 — all still significant. So free float is **not** "the whole game":
the information is in the shape of the distribution, and float only sets decay
speed.

## Known holes

- **Corporate actions are excluded, not adjusted.** A >35% single-session move
  is a first pass, not a corporate-action engine; splits, rights issues and
  bonus shares do not all announce themselves that way. V2 wants a
  `corporate_action` table and a rebuilt, adjusted inventory.
- **Free float is a today snapshot applied backwards.** Rights issues make
  historical float wrong. Tested for insensitivity, not corrected.
- **Broker enrichment is untested.** The "smart-money cost" in
  `float_cost_map.js` is measured from `idx_broker_summary.buy_avg` rather than
  modelled, but it was not part of the IC study.
- **Survivorship bias** toward the 99 currently-liquid names, no costs, no
  timing, no stops.

## Isolation

Nothing here writes to anything the IDX engine owns, and nothing it runs reads
`idx_free_float` or `idx_float_map_daily`. The Float Map must **not** be fed into
`HI52W_REGIME_BROKERVETO_V1` scoring: the official burn-in continues on the
strategy as frozen, and the Float Map collects its own forward evidence. If the
residual gap holds up over 60+ sessions *and* proves incremental to
HI52W/regime/broker-veto, it is tested as a candidate V2 factor — explicitly,
not quietly planted in V1.
