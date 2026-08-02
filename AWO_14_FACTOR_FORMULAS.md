# AWO 14-Factor Formula Reference

Rumus persis seperti yang ada di kode (`scraper/modules/awo_factors.js` untuk F1-F8, `scraper/awo_technical.js` untuk F9-F14, `scraper/modules/statistics.js` untuk helper `stats.*`). Semua skor di-clamp ke rentang 0-100, 50 = netral.

**Update 2026-07-28**: setelah review eksternal, F1/F2/F4/F6/F7/F9/F10/F11/F13 diperbaiki (bug beneran: F7 sign bug, F6 50:50 boundary, F4 sign bug, dn0 scale mis-calibrated; plus perbaikan desain: F9 regime-awareness, F10 MACD normalization, F11 squeeze direction-neutral, F13 R:R-based). F1-F8 sekarang satu sumber di `modules/awo_factors.js`, dipakai bareng oleh server.js, regenerate_signal_history.js, dan backtest_signal_scanner_badges.js. **F14 juga diubah jadi confidence multiplier** (lihat bawah), dan **Counter-trend hard gate di Conviction Tier DICABUT** setelah re-backtest nunjukin gak ada bedanya lagi (bahkan kebalik di horizon +10 hari) — lihat `modules/conviction.js`.

**Update 2026-07-29** (Sprint 0 cleanup per `AWO Engine.md` P1-06): fix missing-factor weight dilution. Sebelumnya kalau ticker gak punya data broker hari itu (`idx_concentration` kosong), F1/F2/F7/F8 tetap dihitung dengan `dn0=0` (placeholder) TAPI bobotnya tetap dipertahankan penuh di rata-rata — jadi komposit ketarik ke netral 50 diam-diam tanpa bilang kenapa. Sekarang `weightedComposite()` (`modules/awo_factors.js`) exclude faktor yang datanya beneran gak ada dari numerator DAN dari total bobot (renormalisasi ke sisa faktor yang tersedia), dan hasil `factorCoverage` (0-1) + `missingFactors` (array kode faktor) dikembalikan di response `/api/signal-scanner` dan `/api/idx-live/:code`. Dipasang di **semua** tempat yang hitung composite F1-F13 (server.js dua endpoint di atas, plus `regenerate_signal_history.js` dan `backtest_signal_scanner_badges.js` — awalnya dikira gak perlu di dua file terakhir karena tanggal historisnya "pasti ada baris broker," ternyata `idx_concentration` bisa kosong independen dari `idx_broker_summary`, jadi tetap dipasang biar konsisten dan gak drift lagi kayak insiden 2026-07-19).

**Update 2026-07-29 (lanjutan, sore)** — Confidence vs Risk Modifier di-pisah beneran sesuai `AWO Engine.md` §3.1-3.4 (sebelumnya satu multiplier `applyVolatilityConfidence` yang nyampur dua konsep). Lihat bawah.

**Update 2026-07-29 (lanjutan lagi, malam) — Market Regime Engine (§5), sebagai BADGE informasional doang.** File baru `modules/regime_engine.js`, fungsi `detectPriceRegime(candles)` — klasifikasi TREND_UP/TREND_DOWN/RANGE/HIGH_VOLATILITY/UNKNOWN per instrumen (per saham atau IHSG, bukan market-wide) dari EMA50/200 + ADX14 (baru, belum ada sebelumnya) + persentil ATR/lebar-Bollinger. Dipasang sebagai field `priceRegime` di `/api/signal-scanner`, `/api/idx-live/:code`, `/api/ihsg-factors-live` — **TIDAK** ikut ke composite/confidence/riskModifier sama sekali, murni informational (sama seperti `weeklyTrend`). Ini keputusan eksplisit dari user: "step by step," Regime Engine dibangun dulu sebagai badge, baru kalau sudah divalidasi lewat backtest nyata baru dipertimbangkan jadi gate/setup-filter — pelajaran langsung dari Counter-trend hard gate yang harus dicabut kemarin. **Tidak** bump `AWO_MODEL_VERSION` untuk perubahan ini karena murni informational, tidak mengubah scoring — versioning di sini secara sengaja hanya menandai perubahan yang mempengaruhi angka skor.

Penting: **BUKAN** hal yang sama dengan `awo_regime.js`'s `detectRegime(pool)` yang SUDAH ADA sebelumnya (ternyata baru ketauan pas mau nulis kode ini) — itu regime MARKET-WIDE (TRENDING/RANGING/VOLATILE/DEFAULT) dari breadth+volume-Z+trend-consistency lintas semua saham, dipakai buat regime-specific weight optimizer (`isOptimized:false`, disabled) dan tersimpan sebagai `regime_at_signal` di `idx_signal_history`. Dua konsep "regime" yang beda total, makanya nama function-nya sengaja dibedain (`detectPriceRegime` vs `detectRegime`) biar gak ketuker di masa depan.

Dua bug ditemukan & diperbaiki saat testing (synthetic candle series, bukan cuma dari kode yang "terlihat benar"):
- **ATR percentile awalnya scale-dependent** — saham yang lagi uptrend panjang otomatis punya absolute point-range yang lebih gede telat-telat (karena harga makin tinggi), walau % volatility hariannya konstan. Fixed: normalisasi true range dengan harga penutupan (`rawTR/close`) sebelum di-ranking, sama prinsipnya kayak fix F10/MACD sebelumnya.
- **Percentile-rank pakai `<=` bikin inflasi ke 100 kalau historinya nyaris konstan** (semua nilai "tie" dihitung sebagai "di bawah atau sama"). Saham dengan volatilitas stabil bertahun-tahun bisa salah kebaca "100th percentile = HIGH_VOLATILITY" cuma dari noise floating-point hari terakhir. Fixed: tie-corrected percentile rank standar (`(below + 0.5*equal) / total`).

Verified live: distribusi 245 saham hari ini — RANGE 123, UNKNOWN 100 (saham dengan histori < 210 hari, correctly declining to guess rather than force a wrong label), TREND_UP 13, TREND_DOWN 9. BBCA/IHSG/idx-live semua sepakat RANGE hari ini. Unit test: `scraper/test_regime_engine.js`, 12/12 pass.

## Komposit & Sinyal

```
// F1-F13 gabung via weightedComposite() — exclude faktor yang datanya
// beneran gak ada dari numerator DAN total bobot (lihat update di atas):
rawComposite = Σ (f_i × weight_i, i tersedia) / Σ(weight_i, i tersedia)

// Lalu Final Score = Directional × Confidence × Risk Modifier (§3.4):
confidence    = factorCoverage                    // 0 (banyak faktor ilang) .. 1 (lengkap)
                                                    // market tanpa konsep coverage (US/IHSG/S&P500) → selalu 1
riskModifier  = 0.5 + (f14/100) × 0.5              // 0.5 (volatil ekstrem) .. 1.0 (tenang)
composite     = 50 + (rawComposite - 50) × confidence × riskModifier
```
Dua alasan terpisah kenapa F14 dan factorCoverage BUKAN vote langsung ke rawComposite:
- **F14 (ATR)** ngukur risiko/volatilitas, bukan arah — "volatilitas rendah = bullish" itu category error. Volatilitas rendah = makin dipercaya arah yang udah ditunjukin 13 faktor lain (skor ekstrem dipertahankan), volatilitas tinggi = kurang dipercaya (skor ditarik ke netral 50).
- **factorCoverage** ngukur seberapa banyak faktor yang beneran ada datanya (bukan placeholder) — komposit yang dihitung dari lebih sedikit faktor secara inheren kurang bisa dipercaya dibanding yang lengkap, independen dari seberapa volatil sahamnya.

Kedua efek itu independen dan dikaliin, bukan dijumlah — saham dengan broker data kosong (`confidence` rendah) DAN lagi volatil tinggi (`riskModifier` rendah) ketarik ke netral lebih jauh daripada salah satu doang. Diimplementasikan di `modules/awo_factors.js` (`computeConfidence`, `computeRiskModifier`, `combineFinalScore` — menggantikan `applyVolatilityConfidence` yang lama), dipakai di semua tempat compute composite (IDX live + scanner, US, IHSG, S&P 500, regenerate, backtest).

**Bobot default** (`DEFAULT_WEIGHTS` di server.js — bisa berubah kalau AWO optimizer sudah pernah jalan; F14 di tabel ini historis, gak dipakai langsung di sum lagi):

| Faktor | Bobot | Faktor | Bobot |
|---|---|---|---|
| F1 | 0.14 | F8  | 0.05 |
| F2 | 0.10 | F9  | 0.06 |
| F3 | 0.08 | F10 | 0.06 |
| F4 | 0.10 | F11 | 0.05 |
| F5 | 0.07 | F12 | 0.05 |
| F6 | 0.10 | F13 | 0.03 |
| F7 | 0.08 | F14 | *(risk modifier, bukan direct weight)* |

**Threshold sinyal** (`classifySignal`, default — bisa berubah kalau di-optimize):
```
score ≥ 78  → STRONG BUY
score ≥ 63  → BUY
score ≥ 53  → WATCH
score ≥ 40  → NEUTRAL
score ≥ 25  → SELL
score < 25  → STRONG SELL
```

**Catatan penting**: F1, F2, F6, F7, F8 butuh data broker (Index Alpha) — **cuma ada buat saham IDX**, gak ada buat US stock (lihat model 9-faktor US). F3, F4, F5, F9-F14 murni harga/volume — portable ke market manapun.

**Data contract — `dn0`-`dn4`** (per `AWO Engine.md` P1-05): kolom `idx_concentration.dn0..dn4` = net-buy top-3-broker sebagai **persentase dari total broker net flow hari itu**, dibatasi matematis ke ±100. Ini SATU-SATUNYA representasi yang dipakai — tidak ada `dnRaw`/`dnNormalized` terpisah, karena root-cause bug sumbernya (`totalNet || 1` di `autoCalculateConcentration`) sudah diperbaiki di server.js dan semua formula F1/F2/F7/F8 sudah dikalibrasi ulang langsung ke rentang ±100 ini (lihat update 2026-07-28 di atas). Jangan asumsikan rentang "-10 sampai +10" di dokumen lain (termasuk `AWO Engine.md` sendiri) — itu asumsi lama yang sudah terbukti salah ~10x dari data real.

---

## F1 — Smart Money / Concentration

*Broker-dependent · butuh `dn0` (net-buy broker top-3 hari ini)*

```js
// dn0 (top-3-broker net concentration %) mathematically bounded to ±100 —
// avg |dn0| ~12, legitimately reaching 40-90+ on strong days. Recalibrated
// 2026-07-28 (was tuned for a stale "-10 to +10" comment, saturating by
// dn0≈15-20 and losing discriminative power across most of the real range).
f1_concentration(dn0):
  if dn0 == null → return 50
  if dn0 > 0:  return clamp(sigmoid(dn0, steepness=0.06), 50, 100)   // akumulasi: kurva sigmoid
  else:        return clamp(50 + dn0 × 0.5, 0, 50)                   // distribusi: linear
```

## F2 — Trend Consistency

*Broker-dependent · butuh `dnValues` (dn0..dn4, net-buy 5 hari terakhir)*

```js
f2_trend(dnValues):
  positives     = jumlah nilai > 0
  directionScore = (positives / total) × 100
  weighted      = weightedAvg(dnValues)     // bobot linear, hari terbaru paling berat
  recentBias    = weighted>0 ? min(weighted×0.5, 15) : max(weighted×0.5, -15)   // rescaled 2026-07-28 buat dn0 range asli
  // accelBonus sekarang sign-aware (2026-07-28) — "masih net-sell tapi mengecil"
  // dulu dapet bonus sama persis kayak "beneran accelerating buy", sekarang beda:
  accelBonus = allPositive & allIncreasing → +8   // genuine bullish acceleration
             = allNegative & allDecreasing → -8   // genuine bearish acceleration
             = allNegative & allIncreasing → +3   // masih net-sell, tapi mengecil (partial credit)
             = allPositive & allDecreasing → -3   // masih net-buy, tapi melemah
             = else → 0
  return clamp(directionScore + recentBias + accelBonus, 0, 100)
```

## F3 — Volume Z-Score

*Pure price/volume · portable ke market manapun*

```js
f3_volumeZ(volumes, priceDirection):
  z = zScoreFromArray(volumes)              // z-score volume hari ini vs rata-rata historis
  score = 50 + z × 12.5
  if z>1 & priceDirection>0: score += 10    // volume tinggi + harga naik = konfirmasi
  if z>1 & priceDirection<0: score -= 10
  // tren volume 5 hari terakhir vs 5 hari sebelumnya:
  if volTrend > 30%:  score += 5
  if volTrend < -30%: score -= 3
  return clamp(score, 0, 100)
```

## F4 — Price Momentum

*Pure price · portable*

```js
f4_momentum(prices):
  roc5 = ROC(prices, 5)                     // rate of change 5 hari
  roc3 = ROC(prices, 3)
  combined = roc5×0.6 + roc3×0.4
  score = 50 + combined × 5
  // modifier RSI (reversal power):
  if RSI<30 & combined>0: score += 8        // oversold bounce
  if RSI>70 & combined<0: score -= 8        // overbought drop — FIXED 2026-07-28, was += (sign bug)
  if RSI<30 & combined<0: score -= 5
  if RSI>70 & combined>0: score -= 5
  return clamp(score, 0, 100)
```

## F5 — Relative Strength

*Pure price + rata-rata cross-sectional market · portable*

```js
f5_relStrength(stockChangePct, marketAvgChangePct):
  excess = stockChangePct - marketAvgChangePct
  return clamp(sigmoid(excess, steepness=0.8), 0, 100)
```

## F6 — Buyer Breadth

*Broker-dependent · butuh jumlah broker net-buy vs net-sell hari itu*

```js
f6_breadth(numBuyers, numSellers):
  pct = numBuyers / (numBuyers+numSellers) × 100
  countBonus = total≥25 ? 8 : total≥15 ? 5 : 0     // makin banyak partisipan = makin reliable
  direction  = Math.sign(pct - 50)                  // FIXED 2026-07-28 — was pct>50?1:-1, 50:50 split gave -1 (F6=45, bukan 50)
  return clamp(pct + countBonus×direction, 0, 100)
```

## F7 — Price-Broker Alignment

*Broker-dependent · butuh `dn0`*

```js
// FIXED 2026-07-28 — dulu "sameDirection" (price+dn0 sama-sama positif ATAU
// sama-sama negatif) itu SATU branch yang selalu ngasih skor TINGGI. Artinya
// harga turun + broker jual (bearish confirmation beneran) skornya tinggi
// (bullish!) — sama kayak harga naik + broker beli. Sekarang dipisah 4 kasus
// eksplisit. brokerIntensity cap juga direcalibrate (8→40) buat dn0 range asli.
f7_alignment(priceChangePct, dn0):
  if dn0 == null → return 50
  priceIntensity  = min(|priceChangePct|, 5) / 5      // 0-1
  brokerIntensity = min(|dn0|, 40) / 40               // 0-1 (was /8)
  alignmentStrength = priceIntensity × brokerIntensity

  if priceChangePct>0 & dn0>0:   return clamp(50 + alignmentStrength×45, 50, 95)  // bullish confirmation
  if priceChangePct<0 & dn0<0:   return clamp(50 - alignmentStrength×45, 5, 50)   // bearish confirmation
  if priceChangePct<0 & dn0>0.5: return clamp(55 + brokerIntensity×15, 50, 72)    // akumulasi diam-diam
  if priceChangePct>0 & dn0<-0.5: return clamp(45 - brokerIntensity×15, 28, 50)   // distribusi ke kekuatan harga
  return 50
```

## F8 — Accumulation Streak

*Broker-dependent · butuh `dnValues`*

```js
f8_streak(dnValues):
  posStreak = jumlah hari net-buy berturut-turut (dari hari terakhir mundur)
  negStreak = jumlah hari net-sell berturut-turut

  accelBonus = +5 kalau streak positif makin membesar (each ≥ prev×0.9)
  accelBonus = -5 kalau streak negatif makin dalam

  if posStreak>0: return clamp(50 + posStreak×10 + accelBonus, 50, 95)
  if negStreak>0: return clamp(50 - negStreak×10 + accelBonus, 5, 50)
  return 50
```

---

## F9 — RSI Zone

*Pure technical · dari `calcRSI(closes, 14)` — Wilder's smoothing standar*

```js
RSI = 100 - 100/(1+RS),  RS = avgGain/avgLoss (Wilder, period 14)

scoreRSI(rsi, trendDirection):        // trendDirection param baru 2026-07-28
  base:
    rsi ≤ 20        → 100
    rsi ≤ 30        → 85 + (30-rsi)×1.5
    rsi ≤ 45        → 65 + (45-rsi)×1.3
    rsi ≤ 55        → 50 + (55-rsi)×1.5
    rsi ≤ 70        → 30 + (70-rsi)×1.3
    rsi ≤ 80        → 15 + (80-rsi)×1.5
    rsi > 80        → max(0, 15-(rsi-80)×1.5)

  // Regime-aware softening (2026-07-28) — RSI mean-reversion murni menghukum
  // saham yang lagi strong-trend padahal overbought bisa bertahan lama kalau
  // trend-nya kuat. trendDirection dari separasi EMA9/EMA21 (>1% = trending).
  if trendDirection=='BULLISH' & rsi>55: return base + (62-base)×0.4   // blend ke arah kurang-strict
  if trendDirection=='BEARISH' & rsi<45: return base + (38-base)×0.4
  else: return base
```
Skor tinggi = oversold (ruang naik), skor rendah = overbought — kecuali sedang trending, di mana penalti/reward dilunakkan.

## F10 — MACD Signal

*Pure technical · dari `calcMACD(closes, 12, 26, 9)`*

```js
MACD line = EMA(12) - EMA(26)
Signal    = EMA(MACD line, 9)
Histogram = MACD - Signal

// FIXED 2026-07-28 — histogram×500 itu price-scale-dependent (0.10 beda arti
// buat saham Rp50 vs Rp5.000). Sekarang dinormalisasi ATR (atau 2% harga
// kalau ATR belum ada) + tanh buat saturasi yang mulus.
scoreMACD(histogram, macd, prevHistogram, atr, price):
  norm = atr>0 ? atr : price×0.02
  score = 50 + 35×tanh((histogram/norm) / 0.25)
  // crossover bonus:
  if prevHistogram≤0 & histogram>0: score += 15  (golden cross)
  if prevHistogram≥0 & histogram<0: score -= 15  (death cross)
  // posisi MACD vs garis nol:
  if macd>0: score += 5   else: score -= 5
  return clamp(score, 0, 100)
```

## F11 — Bollinger Position

*Pure technical · dari `calcBollinger(closes, period=20, mult=2)`*

```js
middle = SMA(20), stdDev = std(20 hari terakhir)
upper = middle + 2×stdDev,  lower = middle - 2×stdDev
%B = (harga - lower) / (upper - lower)

scoreBollinger(%B, width, middle):
  %B ≤ 0    → 95                        (di bawah lower band, sangat oversold)
  %B ≤ 0.2  → 80 + (0.2-%B)×75
  %B ≤ 0.5  → 50 + (0.5-%B)×100
  %B ≤ 0.8  → 30 + (0.8-%B)×67
  %B ≤ 1.0  → 10 + (1.0-%B)×100
  %B > 1.0  → 5                         (di atas upper band, sangat overbought)

  // FIXED 2026-07-28 — squeeze cuma bilang "expansion lebih mungkin", gak
  // bilang arahnya. Dulu +10/+5 nempel langsung ke skor (nge-bullish-in
  // meskipun %B lagi netral). Sekarang squeeze AMPLIFY arah yang %B udah
  // tunjukin, bukan nyuntik bias baru:
  widthPct = width/middle × 100
  squeezeFactor = widthPct<5% ? 0.20 : widthPct<8% ? 0.10 : 0
  squeezeBonus = (posScore - 50) × squeezeFactor   // 0 kalau posScore udah netral (50)
  return clamp(posScore + squeezeBonus, 0, 100)
```

## F12 — EMA Trend

*Pure technical · dari EMA9 & EMA21*

```js
scoreEMATrend(price, ema9, ema21, prevEma9, prevEma21):
  if price>ema9>ema21 (strong uptrend):
    strength = (price-ema21)/ema21 × 100
    score = 75 + min(strength×3, 25)
  elif price>ema21 & ema9>ema21:  score = 65
  elif price>ema21:                score = 55
  elif price<ema9<ema21 (strong downtrend):
    weakness = (ema21-price)/ema21 × 100
    score = 25 - min(weakness×3, 20)
  elif price<ema21:                score = 35
  else:                            score = 50

  // golden/death cross bonus:
  if EMA9 baru saja cross ke atas EMA21: score += 15
  if EMA9 baru saja cross ke bawah EMA21: score -= 15
  return clamp(score, 0, 100)
```

## F13 — Support/Resistance Proximity

*Pure technical · pivot high/low 20 hari terakhir*

```js
support/resistance = local minima/maxima (2 bar kiri-kanan) dari 20 hari terakhir

// FIXED 2026-07-28 — dulu "distToSupport<2%" langsung return 85 flat, TANPA
// liat jarak ke resistance. Saham 1% di atas support tapi cuma 0.2% di bawah
// resistance (R:R jelek banget) tetep dapet 85 kayak yang ruang naiknya luas.
// Sekarang berbasis risk/reward:
scoreSR(price, nearestSupport, nearestResistance):
  risk   = price - nearestSupport
  reward = nearestResistance - price
  if risk ≤ 0:   return 20   // harga udah di/bawah support — level break, bearish
  if reward ≤ 0: return 80   // harga udah di/atas resistance — breakout, bullish
  rr = reward / risk
  return clamp(100 × rr / (1+rr), 0, 100)   // RR 1:1 → 50, RR 3:1 → 75, RR 0.5:1 → 33
```

## F14 — ATR Volatility Regime

*Pure technical · dari `calcATR(highs, lows, closes, 14)` — Wilder smoothing*

```js
TR = max(high-low, |high-prevClose|, |low-prevClose|)
ATR = Wilder-smoothed average TR, 14 hari
atrPct = ATR / harga × 100

scoreATR(atrPct):
  atrPct ≤ 1%  → 80   (sangat terkendali)
  atrPct ≤ 2%  → 70   (normal, sehat)
  atrPct ≤ 3%  → 55   (moderat)
  atrPct ≤ 5%  → 40   (mulai volatil)
  atrPct ≤ 8%  → 25   (volatilitas tinggi, sinyal kurang reliable)
  atrPct > 8%  → 10   (ekstrem)
```

---

## Helper functions (`modules/statistics.js`)

```js
sigmoid(x, steepness) = 100 / (1 + e^(-steepness × x))
clamp(v, min, max)    = max(min, min(max, v))
zScoreFromArray(arr)  = (nilai_terakhir - mean(arr[:-1])) / stdDev(arr[:-1])
roc(prices, period)   = (current - prices[current-period]) / prices[current-period] × 100
streak(arr, positive) = jumlah nilai berturut-turut (dari belakang) yang sama tanda (positif/negatif)
weightedAvg(arr)      = Σ(nilai_i × bobot_i) / Σ(bobot_i), bobot linear — nilai terbaru paling berat
```
