# AWO Trading Decision Engine 2.0


Tujuan sistem adalah:

1. Menentukan kondisi pasar atau **market regime**.
2. Mendeteksi setup trading yang sesuai dengan regime tersebut.
3. Menghasilkan directional score, confidence score, dan risk score secara terpisah.
4. Memberikan rekomendasi:

   * Strong Buy
   * Buy
   * Watch
   * Neutral
   * Sell
   * Strong Sell
   * No Trade
5. Menyediakan entry plan, stop-loss, target, ukuran posisi, dan alasan rekomendasi.
6. Menguji strategi menggunakan data historis tanpa look-ahead bias.
7. Menyimpan seluruh hasil backtest, konfigurasi, versi formula, dan histori perubahan.
8. Menghindari transaksi apabila kualitas data atau setup tidak memenuhi syarat.

Prinsip utama:

> Sistem harus diperbolehkan mengatakan **NO TRADE**.

Tidak semua saham dan semua hari harus menghasilkan sinyal.

---

# 2. Definisi Keberhasilan

AWO tidak dinilai hanya berdasarkan win rate.

## 2.1 Primary Metrics

### Expectancy

```text
Expectancy =
(Win Rate × Average Win)
-
(Loss Rate × Average Loss)
```

Contoh:

```text
Win rate     = 45%
Average win  = 2.5R
Average loss = 1R

Expectancy =
(0.45 × 2.5R) - (0.55 × 1R)
= +0.575R per trade
```

Strategi tersebut masih layak meskipun win rate di bawah 50%.

### Profit Factor

```text
Profit Factor =
Total Gross Profit / Total Gross Loss
```

### Maximum Drawdown

```text
Max Drawdown =
Penurunan terbesar equity dari peak ke trough
```

## 2.2 Secondary Metrics

Sistem wajib melaporkan:

* Win rate.
* Average win.
* Average loss.
* Average risk–reward.
* Expectancy per trade.
* Profit factor.
* Maximum drawdown.
* CAGR atau annualized return.
* Sharpe ratio.
* Sortino ratio.
* Calmar ratio.
* Total trade.
* Average holding period.
* Exposure.
* Turnover.
* Longest losing streak.
* Recovery period.
* Performance per tahun.
* Performance per saham.
* Performance per market regime.
* Performance sebelum dan sesudah transaction cost.
* Sensitivitas terhadap slippage.

## 2.3 Stability Metrics

Strategi tidak boleh hanya bagus pada satu periode.

Tambahkan:

```text
Positive Fold Ratio =
Jumlah validation fold profitable /
Total validation fold
```

```text
OOS Degradation =
(In-Sample Metric - Out-of-Sample Metric) /
|In-Sample Metric|
```

AWO wajib menampilkan perbandingan:

```text
In-Sample
Validation
Out-of-Sample
Paper Trading
Live Trading
```

Rolling-window atau walk-forward testing meniru proses kalibrasi menggunakan data masa lalu lalu mengevaluasi periode berikutnya. Backtest juga wajib menghindari survivorship bias dan look-ahead bias.

---

# 3. Arsitektur Logika AWO 2.0

AWO tidak lagi menggunakan satu weighted score secara langsung.

Gunakan tiga layer:

```text
MARKET DATA
     │
     ▼
MARKET REGIME
     │
     ▼
SETUP DETECTION
     │
     ▼
DIRECTIONAL SCORE
     │
     ▼
CONFIDENCE MODIFIER
     │
     ▼
RISK MODIFIER
     │
     ▼
FINAL SCORE
     │
     ▼
ENTRY PLAN / NO TRADE
```

## 3.1 Directional Score

Directional score menjawab:

> Apakah bukti yang tersedia lebih mendukung kenaikan atau penurunan?

Skala:

```text
0   = sangat bearish
50  = netral
100 = sangat bullish
```

## 3.2 Confidence Score

Confidence menjawab:

> Seberapa kuat dan konsisten bukti tersebut?

Skala:

```text
0.00 = tidak dapat dipercaya
1.00 = confidence penuh
```

Confidence tidak menentukan arah.

## 3.3 Risk Modifier

Risk modifier menjawab:

> Apakah kondisi volatilitas, likuiditas, gap, dan jarak stop masih layak?

Skala:

```text
0.00 = dilarang entry
1.00 = risiko normal
```

## 3.4 Formula Final

```text
Final Score =
50 +
(Directional Score - 50)
× Confidence
× Risk Modifier
```

Contoh:

```text
Directional Score = 80
Confidence        = 0.80
Risk Modifier     = 0.75

Final Score =
50 + (80 - 50) × 0.80 × 0.75
= 68
```

Artinya bukti awal bullish kuat, tetapi final score diturunkan karena confidence dan kondisi risiko.

---

# 4. Perbaikan Wajib Formula 14-Factor

Dokumen formula saat ini menjadi baseline pengembangan AWO.

## P0-01 — Perbaiki F7 Price–Broker Alignment

Masalah saat ini:

```text
Harga turun + broker net sell
```

dikategorikan sebagai `sameDirection` dan mendapatkan skor di atas 50.

Padahal ini adalah bearish confirmation.

Formula baru:

```js
function scoreAlignment(priceChangePct, dn0) {
  if (dn0 == null) return 50;

  const priceIntensity =
    Math.min(Math.abs(priceChangePct), 5) / 5;

  const brokerIntensity =
    Math.min(Math.abs(dn0), 8) / 8;

  const strength =
    priceIntensity * brokerIntensity;

  // Bullish confirmation
  if (priceChangePct > 0 && dn0 > 0) {
    return clamp(50 + strength * 45, 50, 95);
  }

  // Bearish confirmation
  if (priceChangePct < 0 && dn0 < 0) {
    return clamp(50 - strength * 45, 5, 50);
  }

  // Hidden accumulation
  if (priceChangePct < 0 && dn0 > 0.5) {
    return clamp(55 + brokerIntensity * 15, 50, 72);
  }

  // Distribution while price rises
  if (priceChangePct > 0 && dn0 < -0.5) {
    return clamp(50 - strength * 35, 10, 50);
  }

  return 50;
}
```

### Unit test wajib

```text
price = +4%, dn0 = +8  → score > 80
price = -4%, dn0 = -8  → score < 20
price = -2%, dn0 = +5  → score > 50
price = +2%, dn0 = -5  → score < 50
dn0 = null             → score = 50
```

---

## P0-02 — Normalisasi F10 MACD

Histogram MACD tidak boleh langsung dikalikan dengan konstanta karena nilainya masih menggunakan unit harga.

Gunakan salah satu normalisasi:

```text
Normalized Histogram =
MACD Histogram / ATR
```

Pilihan alternatif:

```text
Histogram Percentage =
MACD Histogram / Closing Price × 100
```

Rekomendasi:

```js
function scoreMACD({
  histogram,
  previousHistogram,
  macd,
  atr
}) {
  if (!atr || atr <= 0) return 50;

  const normalizedHistogram = histogram / atr;

  let score =
    50 + 35 * Math.tanh(normalizedHistogram / 0.25);

  if (
    previousHistogram <= 0 &&
    histogram > 0
  ) {
    score += 10;
  }

  if (
    previousHistogram >= 0 &&
    histogram < 0
  ) {
    score -= 10;
  }

  if (macd > 0) score += 5;
  if (macd < 0) score -= 5;

  return clamp(score, 0, 100);
}
```

### Unit test wajib

Dua saham dengan rasio `histogram / ATR` yang sama harus menghasilkan skor MACD yang hampir sama walaupun harga nominalnya berbeda.

---

## P0-03 — Perbaiki F6 Buyer Breadth

Kasus 50 buyer : 50 seller harus menghasilkan skor netral.

```js
function scoreBreadth(numBuyers, numSellers) {
  const total = numBuyers + numSellers;

  if (total <= 0) return 50;

  const buyerPct = numBuyers / total * 100;

  const countBonus =
    total >= 25 ? 8 :
    total >= 15 ? 5 :
    0;

  const direction = Math.sign(buyerPct - 50);

  return clamp(
    buyerPct + countBonus * direction,
    0,
    100
  );
}
```

### Unit test wajib

```text
10 buyer, 10 seller → 50
20 buyer, 5 seller  → > 80
5 buyer, 20 seller  → < 20
0 buyer, 0 seller   → 50
```

---

## P0-04 — Perbaiki Modifier F4 Momentum

Formula berikut harus diubah:

```text
RSI > 70 dan momentum negatif → score +8
```

Kondisi tersebut lebih tepat dianggap sebagai indikasi momentum bearish setelah kondisi overbought.

Gunakan:

```js
if (rsi > 70 && combinedMomentum < 0) {
  score -= 8;
}
```

Untuk kondisi oversold:

```js
if (rsi < 30 && combinedMomentum > 0) {
  score += 8;
}
```

---

## P1-01 — F9 RSI Harus Regime-Aware

RSI tidak boleh selalu dianggap sebagai indikator mean reversion.

### Trend-Up Regime

```text
RSI 50–65 → positif
RSI 65–75 → positif, tetapi caution
RSI > 80  → mulai mendapat penalty
RSI < 40  → momentum trend melemah
```

### Range Regime

```text
RSI < 30 → peluang mean reversion bullish
RSI > 70 → peluang mean reversion bearish
```

Buat dua fungsi:

```js
scoreRSITrend(rsi)
scoreRSIRange(rsi)
```

Function yang digunakan ditentukan oleh market regime.

---

## P1-02 — F11 Bollinger Harus Regime-Aware

### Range Regime

```text
%B mendekati 0 → peluang beli di bawah range
%B mendekati 1 → peluang take profit atau sell
```

### Trend-Up Regime

Harga menembus upper Bollinger Band tidak otomatis bearish apabila:

```text
Volume Z-score > 1
Relative strength positif
EMA trend bullish
Close berada dekat high harian
```

Bollinger squeeze tidak boleh langsung menambah bullish score karena squeeze tidak menentukan arah.

Squeeze hanya menambah:

```text
Breakout Potential
```

bukan:

```text
Bullish Direction
```

---

## P1-03 — Perbaiki F13 Support/Resistance

Jangan otomatis memberikan skor 85 hanya karena harga dekat support.

Hitung risk–reward:

```text
Risk =
Entry Price - Support

Reward =
Resistance - Entry Price

Risk–Reward Ratio =
Reward / Risk
```

Mapping awal:

```js
function scoreRiskReward(rr) {
  if (!Number.isFinite(rr) || rr <= 0) {
    return 0;
  }

  return clamp(
    100 * rr / (1 + rr),
    0,
    100
  );
}
```

Contoh:

```text
RR 0.5 → 33
RR 1.0 → 50
RR 2.0 → 67
RR 3.0 → 75
RR 5.0 → 83
```

Tambahkan penalti apabila:

```text
Jarak resistance < 1%
Stop terlalu jauh
Support sudah ditembus
Support hanya terbentuk dari satu pivot
```

---

## P1-04 — Pindahkan F14 ATR ke Risk Modifier

ATR tidak menentukan bullish atau bearish.

F14 tidak lagi masuk ke directional weighted score.

Gunakan ATR sebagai bagian dari risk modifier.

Contoh baseline:

```text
ATR Percentile < 20   → risk modifier 0.85
ATR Percentile 20–70 → risk modifier 1.00
ATR Percentile 70–85 → risk modifier 0.85
ATR Percentile 85–95 → risk modifier 0.65
ATR Percentile > 95  → risk modifier 0.00–0.50
```

ATR percentile dihitung terhadap histori saham itu sendiri, misalnya 252 trading days.

Volatilitas terlalu rendah juga dapat mengurangi kualitas peluang karena potensi gerak harga kecil. Karena itu, model tidak otomatis menganggap ATR paling rendah sebagai kondisi terbaik.

---

## P1-05 — Normalisasi Data Broker

Tim harus menentukan unit resmi untuk:

```text
dn0
dn1
dn2
dn3
dn4
```

Jangan menggunakan nilai rupiah atau lot mentah secara langsung.

Pilihan normalisasi:

```text
Broker Net Flow Ratio =
Net Buy Value /
Average Daily Transaction Value 20D
```

Atau:

```text
Broker Flow Z-score =
(Current Net Flow - Historical Mean) /
Historical Standard Deviation
```

Rekomendasi internal:

```text
dnNormalized dibatasi pada -10 sampai +10
```

Simpan kedua data:

```text
dnRaw
dnNormalized
```

Semua formula scoring hanya menggunakan `dnNormalized`.

---

## P1-06 — Missing Factor Handling

Apabila faktor broker tidak tersedia, jangan mempertahankan bobotnya dengan skor 50.

Bobot faktor yang tersedia harus dinormalisasi ulang.

```js
availableWeight =
  sum(weights of available factors);

finalDirectionalScore =
  sum(score * weight) /
  availableWeight;
```

Simpan informasi:

```json
{
  "factorCoverage": 0.78,
  "missingFactors": ["F1", "F2", "F7", "F8"]
}
```

Jika coverage di bawah minimum:

```text
factorCoverage < 0.65
```

sistem harus memberikan:

```text
NO TRADE — INSUFFICIENT DATA
```

Threshold harus configurable.

---

# 5. Market Regime Engine

Buat modul terpisah:

```text
regime-engine
```

Output minimal:

```text
TREND_UP
TREND_DOWN
RANGE
HIGH_VOLATILITY
UNKNOWN
```

## 5.1 Input Regime

Gunakan:

* Price versus EMA50.
* Price versus EMA200.
* EMA50 versus EMA200.
* Slope EMA50.
* ADX14.
* ATR percentile.
* Bollinger Band width percentile.
* Market index trend.
* Market breadth jika tersedia.

## 5.2 Baseline Rule

```js
if (dataQualityInsufficient) {
  regime = "UNKNOWN";
}

else if (atrPercentile >= 90) {
  regime = "HIGH_VOLATILITY";
}

else if (
  price > ema200 &&
  ema50 > ema200 &&
  ema50SlopeNormalized > trendThreshold &&
  adx14 >= 20
) {
  regime = "TREND_UP";
}

else if (
  price < ema200 &&
  ema50 < ema200 &&
  ema50SlopeNormalized < -trendThreshold &&
  adx14 >= 20
) {
  regime = "TREND_DOWN";
}

else {
  regime = "RANGE";
}
```

Semua threshold harus berada di configuration table, bukan hard-coded di source code.

---

# 6. Setup Library

Jangan mencampur seluruh setup menjadi satu formula. Setiap setup harus mempunyai rule, backtest, dan performa sendiri.

Versi pertama minimal memiliki tiga setup.

---

## Setup A — Trend Pullback

### Tujuan

Membeli saham yang masih berada dalam uptrend setelah koreksi sehat.

### Filter

```text
Regime = TREND_UP
Price > EMA50
EMA50 > EMA200
Relative strength terhadap market > 0
Likuiditas memenuhi minimum
ATR tidak ekstrem
```

### Trigger

Minimal dua kondisi berikut:

```text
Harga pullback ke EMA9 atau EMA21
Harga mendekati support valid
RSI turun ke area 40–55 lalu berbalik naik
Volume mengecil selama pullback
Bullish reversal candle
```

Untuk IDX tambahkan:

```text
Broker flow tidak menunjukkan distribusi kuat
F1/F2/F7 mendukung akumulasi
```

### Confirmation

```text
Close di atas high candle sebelumnya
Volume kembali meningkat
MACD histogram membaik
Relative strength tetap positif
```

### Invalidasi

```text
Close di bawah swing low
EMA50 mulai turun
Broker distribution sangat kuat
Market index berubah menjadi TREND_DOWN
```

---

## Setup B — Breakout with Confirmation

### Filter

```text
Regime = TREND_UP atau RANGE
Harga dekat resistance 20–60 hari
Volume dan likuiditas memenuhi minimum
ATR tidak berada pada kondisi ekstrem
```

### Trigger

```text
Close menembus resistance
Volume Z-score > 1
Relative strength positif
Close berada pada 25% bagian atas daily range
```

### Confirmation

```text
Broker flow positif untuk IDX
EMA9 > EMA21
MACD histogram positif atau meningkat
Resistance tidak terlalu jauh dari support berikutnya
```

### False-Breakout Filter

Tolak setup apabila:

```text
Upper wick terlalu besar
Close kembali di bawah resistance
Market index bearish
Breakout terjadi dengan volume rendah
Harga sudah terlalu jauh dari EMA21
Risk–reward di bawah minimum
```

---

## Setup C — Range Mean Reversion

### Filter

```text
Regime = RANGE
Support dan resistance sudah terbentuk
ADX rendah
Tidak ada breakdown besar
ATR normal
```

### Trigger

```text
Harga mendekati support
RSI oversold
Bollinger %B mendekati 0
Muncul rejection atau bullish reversal
```

### Confirmation

```text
Volume seller melemah
Broker flow tidak menunjukkan distribusi ekstrem
Risk–reward ke middle band atau resistance memenuhi minimum
```

### Larangan

Setup ini tidak boleh digunakan ketika:

```text
Regime = TREND_DOWN
Support baru saja ditembus
Terjadi gap-down besar
Market sedang panic/high-volatility
```

---

# 7. Signal Decision Pipeline

Urutan evaluasi harus tetap:

```text
1. Validate data
2. Check liquidity
3. Detect market regime
4. Detect eligible setups
5. Calculate factor scores
6. Calculate directional score
7. Calculate confidence
8. Calculate risk modifier
9. Build trade plan
10. Apply portfolio risk limits
11. Output signal or NO TRADE
```

Contoh pseudocode:

```js
function evaluateSignal(input, portfolio) {
  const quality = validateData(input);

  if (!quality.isValid) {
    return noTrade("INVALID_DATA");
  }

  if (!passesLiquidityFilter(input)) {
    return noTrade("LOW_LIQUIDITY");
  }

  const regime = detectRegime(input);
  const setups = detectEligibleSetups(input, regime);

  if (setups.length === 0) {
    return noTrade("NO_VALID_SETUP");
  }

  const factors = calculateFactors(input, regime);
  const direction = calculateDirectionalScore(factors);
  const confidence = calculateConfidence(
    factors,
    regime,
    setups
  );

  const risk = calculateRiskModifier(
    input,
    portfolio,
    setups
  );

  const finalScore =
    50 +
    (direction - 50) *
    confidence *
    risk.value;

  const plan = buildTradePlan({
    input,
    setup: setups[0],
    finalScore,
    portfolio
  });

  if (!plan.isValid) {
    return noTrade(plan.rejectionReason);
  }

  return buildSignalResponse({
    regime,
    setups,
    factors,
    direction,
    confidence,
    risk,
    finalScore,
    plan
  });
}
```

---

# 8. Entry, Stop, Target, dan Position Sizing

## 8.1 Entry Plan

AWO harus memberikan dua level:

```text
Planned Entry
Maximum Acceptable Entry
```

Jika harga melampaui maximum acceptable entry, signal berubah menjadi:

```text
MISSED ENTRY — DO NOT CHASE
```

## 8.2 Stop-Loss

Stop menggunakan struktur pasar dan ATR.

```text
Structural Stop =
Di bawah swing low atau support

Volatility Stop =
Entry - ATR Multiple × ATR
```

Pilih stop yang secara logis membatalkan setup, bukan sekadar stop terdekat.

## 8.3 Position Sizing

```text
Risk Amount =
Account Equity × Risk Per Trade

Risk Per Share =
Entry Price - Stop Price

Position Size =
Risk Amount / Risk Per Share
```

Kemudian batasi dengan:

```text
Maximum capital allocation
Liquidity limit
Maximum portfolio exposure
Maximum sector exposure
Maximum correlated exposure
```

Semua parameter harus configurable.

Research defaults untuk pengujian, bukan rekomendasi final:

```text
Risk per trade       = 0.25%–1.00%
Maximum open risk    = 2%–4%
Maximum daily loss   = configurable
Minimum planned RR   = 1.5
Preferred planned RR = 2.0 atau lebih
```

## 8.4 Exit Methods

Sediakan beberapa exit policy agar bisa dibandingkan:

```text
Fixed R Target
ATR Trailing Stop
EMA9 Trailing Stop
Partial Take Profit
Time-Based Exit
Opposite Signal Exit
```

Jangan mencampur hasil semua exit policy. Setiap policy harus memiliki ID dan hasil backtest tersendiri.

---

# 9. Backtest Engine Specification

## 9.1 Signal Timing

Setiap data harus memiliki:

```text
market_timestamp
available_timestamp
signal_timestamp
execution_timestamp
```

Contoh daily timeframe:

```text
Indicator dihitung setelah close T
Signal tersedia setelah close T
Eksekusi paling cepat pada open T+1
```

Sistem tidak boleh menggunakan closing price T sebagai harga eksekusi apabila signal baru terbentuk setelah close T. Penggunaan informasi yang belum tersedia pada waktu keputusan adalah look-ahead bias.

## 9.2 Transaction Cost

Backtest harus memasukkan:

* Brokerage fee.
* Exchange fee.
* Taxes.
* Bid–ask spread.
* Slippage.
* Partial fill.
* Gap.
* Minimum tick.
* Limit up/limit down.
* Liquidity constraint.

Nilai tersebut harus berada pada configuration table karena berbeda menurut market, broker, instrumen, dan periode.

## 9.3 Liquidity Simulation

Gunakan:

```text
Average Daily Value 20D
Average Daily Volume 20D
Median spread
Trading frequency
```

Batasi ukuran transaksi sebagai persentase dari ADV.

```text
Maximum Position Value =
ADV20 × Participation Rate
```

Participation rate harus configurable.

## 9.4 Corporate Actions

Data harus memperhitungkan:

* Stock split.
* Reverse split.
* Dividend.
* Rights issue.
* Delisting.
* Symbol change.
* Merger.
* Trading suspension.

Jangan hanya backtest saham yang masih aktif saat ini. Dataset yang hanya berisi saham yang bertahan dapat menghasilkan survivorship bias.

## 9.5 Same-Bar TP/SL Ambiguity

Jika dalam satu OHLC candle harga menyentuh stop dan target sekaligus:

1. Gunakan data timeframe yang lebih rendah; atau
2. Gunakan asumsi konservatif bahwa stop terkena lebih dulu.

Simpan field:

```text
ambiguous_bar = true
resolution_method
```

---

# 10. Label dan Target Pengujian

Setiap signal harus diuji menggunakan tiga batas:

```text
Take-Profit Barrier
Stop-Loss Barrier
Maximum Holding Period
```

Contoh:

```text
Entry        = open T+1
Take profit  = +2R
Stop loss    = -1R
Time stop    = 10 trading days
```

Outcome:

```text
WIN       = target tercapai lebih dulu
LOSS      = stop tercapai lebih dulu
TIME_EXIT = belum menyentuh keduanya sampai batas waktu
```

Simpan juga maximum excursion:

```text
MFE = Maximum Favorable Excursion
MAE = Maximum Adverse Excursion
```

MFE dan MAE membantu menentukan apakah stop dan target terlalu sempit atau terlalu lebar.

---

# 11. Walk-Forward dan Out-of-Sample Test

Baseline split:

```text
Training   : 60%
Validation : 20%
Test       : 20%
```

Untuk time-series, jangan melakukan random shuffle.

Contoh:

```text
Train      2020–2022
Validation 2023
Test       2024
```

Kemudian rolling:

```text
Train 2020–2022 → Test 2023
Train 2021–2023 → Test 2024
Train 2022–2024 → Test 2025
```

Untuk strategi dengan holding period yang overlap, tambahkan purge atau embargo antara train dan test agar label periode yang berdekatan tidak bocor.

Semakin banyak variasi parameter yang dicoba, semakin besar risiko bahwa konfigurasi terbaik hanya cocok secara kebetulan pada data historis. Tim harus menyimpan jumlah eksperimen dan mengevaluasi risiko backtest overfitting.

---

# 12. Optimizer Specification

Optimizer tidak boleh langsung bebas mengubah seluruh parameter.

## 12.1 Tahap Optimasi

```text
Stage 1 — Validate individual factors
Stage 2 — Validate each setup
Stage 3 — Optimize weights
Stage 4 — Optimize thresholds
Stage 5 — Optimize exit policy
Stage 6 — Portfolio-level validation
```

## 12.2 Parameter Boundaries

Semua parameter memiliki:

```text
minimum
maximum
step
default
version
```

Contoh:

```json
{
  "parameter": "minimumVolumeZ",
  "minimum": 0.5,
  "maximum": 2.5,
  "step": 0.25,
  "default": 1.0
}
```

## 12.3 Rejection Gate

Konfigurasi otomatis ditolak apabila:

```text
Jumlah trade OOS terlalu sedikit
Expectancy OOS ≤ 0
Profit factor OOS ≤ minimum
Drawdown > batas
Hanya profitable pada satu periode
Biaya transaksi menghilangkan seluruh edge
Performa collapse ketika slippage dinaikkan
```

Threshold awal untuk research:

```text
Minimum OOS trades          = [DECISION]
Minimum positive folds      = 60%–70%
Minimum OOS profit factor   = 1.10–1.20
Maximum permitted drawdown  = [DECISION]
Maximum IS/OOS degradation  = [DECISION]
```

## 12.4 Ranking Objective

Jangan memilih model hanya berdasarkan hasil return tertinggi.

Baseline fitness:

```text
Fitness =
Median OOS Expectancy
× Stability Factor
× Sample Size Factor
-
Drawdown Penalty
-
Turnover Penalty
-
Complexity Penalty
```

Complexity penalty meningkat ketika:

```text
Jumlah parameter bertambah
Rule semakin spesifik
Jumlah eksperimen bertambah
Performa hanya bagus pada sedikit saham
```

## 12.5 Locked Holdout

Sediakan periode final test yang tidak boleh digunakan untuk:

```text
Pemilihan faktor
Pemilihan threshold
Pemilihan weight
Pemilihan exit
Debugging strategi
```

Setelah final holdout dibuka, konfigurasi dianggap selesai. Jika konfigurasi diubah, hasil tersebut tidak lagi dianggap sebagai final out-of-sample test.

---

# 13. Probability Model

Final score tidak boleh langsung disebut sebagai win probability.

Contoh:

```text
Score 70 ≠ otomatis peluang menang 70%
```

Buat calibration module.

Kelompokkan hasil:

```text
Score 50–55
Score 55–60
Score 60–65
Score 65–70
Score 70–75
Score 75+
```

Untuk setiap bucket, hitung:

```text
Actual win rate
Average return
Average R
Profit factor
Maximum drawdown
Jumlah sample
```

Jika ingin menampilkan probability:

```text
Calibrated Win Probability
```

Gunakan model kalibrasi berdasarkan hasil out-of-sample, bukan mengubah score secara langsung menjadi persentase.

Dashboard harus menampilkan:

```text
Predicted probability vs realized probability
```

Tambahkan:

* Brier score.
* Log loss.
* Calibration error.
* Sample size per probability bucket.

---

# 14. Database Minimum

## 14.1 `market_bars`

```text
symbol
market
timeframe
timestamp
open
high
low
close
adjusted_close
volume
transaction_value
data_source
ingested_at
```

## 14.2 `broker_flows`

```text
symbol
timestamp
broker_code
buy_value
sell_value
net_value
normalized_net_flow
data_source
available_timestamp
```

## 14.3 `factor_scores`

```text
symbol
timestamp
model_version
factor_code
raw_value
normalized_value
score
is_available
quality_flag
calculation_version
```

## 14.4 `regime_history`

```text
symbol
timestamp
regime
regime_confidence
input_snapshot_id
model_version
```

## 14.5 `signals`

```text
signal_id
symbol
timestamp
available_timestamp
regime
setup_code
directional_score
confidence_score
risk_modifier
final_score
classification
reason_codes
model_version
config_version
```

## 14.6 `trade_plans`

```text
signal_id
planned_entry
maximum_entry
stop_price
target_1
target_2
risk_per_share
position_size
planned_rr
expiry_timestamp
```

## 14.7 `backtest_runs`

```text
backtest_id
strategy_version
config_version
data_snapshot_id
code_commit_hash
start_date
end_date
execution_assumption
cost_assumption
random_seed
created_at
```

## 14.8 `backtest_trades`

```text
backtest_id
trade_id
symbol
setup
entry_timestamp
entry_price
exit_timestamp
exit_price
stop_price
target_price
gross_return
net_return
return_in_r
mfe
mae
exit_reason
regime
```

---

# 15. API Response Standard

Contoh response:

```json
{
  "symbol": "BBCA",
  "market": "IDX",
  "timeframe": "1D",
  "asOf": "2026-07-28T16:15:00+07:00",
  "dataQuality": {
    "status": "VALID",
    "factorCoverage": 0.93,
    "missingFactors": []
  },
  "regime": {
    "type": "TREND_UP",
    "confidence": 0.84
  },
  "setup": {
    "code": "TREND_PULLBACK",
    "status": "CONFIRMED"
  },
  "scores": {
    "directional": 74.2,
    "confidence": 0.82,
    "riskModifier": 0.78,
    "final": 65.5
  },
  "signal": "BUY",
  "tradePlan": {
    "plannedEntry": 9500,
    "maximumEntry": 9600,
    "stop": 9150,
    "target1": 10200,
    "target2": 10600,
    "plannedRiskReward": 2.0,
    "expiry": "2026-07-31"
  },
  "reasons": [
    "MARKET_REGIME_TREND_UP",
    "PULLBACK_TO_EMA21",
    "POSITIVE_RELATIVE_STRENGTH",
    "BROKER_ACCUMULATION",
    "VOLUME_CONFIRMATION"
  ],
  "warnings": [
    "EARNINGS_EVENT_NEARBY"
  ],
  "modelVersion": "awo-2.0.0",
  "configVersion": "idx-daily-v1"
}
```

---

# 16. Explainability Requirement

Setiap signal wajib menjelaskan:

```text
Mengapa signal muncul
Faktor paling positif
Faktor paling negatif
Setup yang terdeteksi
Risiko utama
Kondisi pembatalan setup
Data yang hilang
Versi model
```

Jangan hanya menampilkan:

```text
BUY — Score 68
```

Tampilkan:

```text
BUY — Trend Pullback

Positif:
+ EMA trend bullish
+ Relative strength kuat
+ Broker accumulation
+ Volume mulai kembali naik

Negatif:
- Jarak ke resistance hanya 4.2%
- ATR percentile cukup tinggi

Invalid jika:
- Close di bawah 9,150
- Market regime berubah menjadi TREND_DOWN
```

---

# 17. Unit Test dan Acceptance Criteria

## Formula Tests

### F7

```text
Bearish confirmation harus < 50
Bullish confirmation harus > 50
```

### F6

```text
Buyer = seller harus = 50
Total = 0 harus = 50
```

### F10

```text
Normalized MACD yang sama menghasilkan skor setara
```

### F13

```text
Dekat support tetapi resistance lebih dekat
tidak boleh menghasilkan skor tinggi
```

### F14

```text
ATR tidak boleh mengubah arah bullish menjadi bearish.
ATR hanya mengubah risk modifier.
```

### Missing Data

```text
Tidak ada division by zero
Tidak ada NaN
Tidak ada Infinity
Bobot tersedia dinormalisasi ulang
Coverage tersimpan
```

## Backtest Tests

1. Signal close T tidak boleh dieksekusi pada close T.
2. Perubahan fee harus mengubah hasil net return.
3. Perubahan slippage harus mengubah hasil.
4. Split saham tidak boleh menciptakan profit atau loss palsu.
5. Delisted stocks tetap berada di historical universe.
6. Same-bar TP/SL harus menggunakan aturan konservatif.
7. Hasil backtest harus deterministic dengan data dan config yang sama.
8. Semua run menyimpan:

   * Code version.
   * Data version.
   * Configuration.
   * Seed.
   * Timestamp.

## Acceptance Criteria MVP

MVP dianggap selesai apabila:

```text
Semua P0 formula tests pass
Market regime tersedia
Tiga setup tersedia
Risk-based position sizing tersedia
Backtest memasukkan cost dan slippage
Walk-forward report tersedia
Signal memiliki explanation
Model/config version tersimpan
NO TRADE condition tersedia
Tidak ada look-ahead pada execution
```

---

# 18. Dashboard Minimum

## Scanner Page

Tampilkan:

```text
Symbol
Final Score
Signal
Regime
Setup
Confidence
Risk Modifier
Planned RR
Factor Coverage
Last Updated
```

## Signal Detail Page

Tampilkan:

* Candlestick chart.
* Entry, stop, dan target.
* Support dan resistance.
* Factor contribution.
* Positive reasons.
* Negative reasons.
* Regime.
* Historical success rate setup.
* Performance setup pada regime serupa.
* Data-quality warning.

## Backtest Page

Tampilkan:

* Equity curve.
* Drawdown curve.
* Monthly return.
* Trade distribution.
* Win/loss distribution.
* MFE/MAE.
* Performance per regime.
* Performance per setup.
* In-sample versus out-of-sample.
* Cost and slippage sensitivity.
* Parameter sensitivity heatmap.

## Trading Journal

Simpan:

```text
Signal awal
Rencana entry
Eksekusi aktual
Alasan entry
Alasan exit
Screenshot
Emosi trader
Apakah mengikuti sistem
Hasil dalam R
Kesalahan eksekusi
```

Tujuannya memisahkan:

```text
Model error
Execution error
Discipline error
```

---

# 19. Notifikasi

AWO boleh memberikan notifikasi untuk:

```text
Setup baru terkonfirmasi
Harga memasuki entry zone
Harga melewati maximum entry
Stop hampir terkena
Target tercapai
Setup expired
Regime berubah
Data source bermasalah
```

Setiap notifikasi wajib menyertakan timestamp dan model version.

---

# 20. Security dan Audit

Minimal:

* Authentication.
* Role-based access.
* API key disimpan sebagai secret.
* Rate limiting.
* Input validation.
* Calculation audit log.
* Config change history.
* Model version history.
* Backup database.
* Error monitoring.
* Data source monitoring.

Perubahan weight atau threshold tidak boleh menimpa versi lama.

Gunakan:

```text
Draft
Backtest
Approved
Paper Trading
Production
Archived
```

sebagai model lifecycle.

Pengembangan algoritme sebaiknya mencakup testing, backtesting, dan monitoring setelah implementasi, bukan berhenti pada proses deployment.

---

# 21. Larangan pada Versi Awal

Jangan langsung membangun:

1. Auto-trading real money.
2. Optimizer yang mengubah bobot setiap hari.
3. Machine-learning black box tanpa explanation.
4. Puluhan setup sekaligus.
5. Ratusan parameter bebas.
6. Entry berdasarkan score tanpa regime.
7. Backtest tanpa transaction cost.
8. Probability tanpa calibration.
9. Signal tanpa stop dan invalidation.
10. Optimasi pada final holdout.

Mulai dari:

```text
3 setup
1 timeframe
1 market
Rules transparan
Backtest kuat
Paper trading
```

---

# 22. Development Roadmap

## Sprint 0 — Formula Stabilization

Deliverables:

```text
Fix F7
Fix F6
Normalize F10
Fix F4
Data-contract dn
Unit tests F1–F14
Model versioning
```

## Sprint 1 — Data and Feature Engine

Deliverables:

```text
OHLCV ingestion
Broker-flow ingestion
Corporate-action handling
Data validation
Factor calculation
Factor coverage
Historical snapshots
```

## Sprint 2 — Regime and Setup Engine

Deliverables:

```text
Market regime
Trend Pullback
Breakout
Range Mean Reversion
NO TRADE rules
Reason codes
```

## Sprint 3 — Risk and Backtest Engine

Deliverables:

```text
Entry plan
Stop/target
Position sizing
Fees
Slippage
Liquidity
Portfolio limits
MFE/MAE
Performance metrics
```

## Sprint 4 — Robust Validation

Deliverables:

```text
Train/validation/test
Walk-forward
Purging/embargo
Parameter sensitivity
OOS comparison
Experiment registry
Locked holdout
```

## Sprint 5 — Dashboard and Paper Trading

Deliverables:

```text
Scanner
Signal detail
Backtest report
Journal
Paper portfolio
Notifications
Model monitoring
```

## Sprint 6 — Optimizer

Optimizer baru dimulai setelah seluruh bagian sebelumnya stabil.

Deliverables:

```text
Bounded parameter search
Complexity penalty
OOS fitness
Stability ranking
Optimizer audit trail
Approved config workflow
```

---

# 23. File dan Informasi yang Harus Diberikan kepada Tim

Berikan paket berikut:

## A. Functional Documentation

```text
AWO 14-Factor Formula Reference
AWO Trading Decision Engine 2.0 Specification
Signal classification definition
Setup definition
Risk-management rules
```

## B. Sample Data

Minimal:

```text
2–5 tahun OHLCV
10–30 saham
Market index
Broker flow
Corporate actions
Trading calendar
```

Harus ada contoh:

```text
Data normal
Data kosong
Suspension
Stock split
Gap besar
Low liquidity
Broker data tidak tersedia
```

## C. Data Dictionary

Untuk setiap field:

```text
Field name
Meaning
Unit
Timezone
Source
Update frequency
Available timestamp
Missing-value rule
Normalization
```

Khusus `dn0–dn4`, unit dan normalisasi harus diputuskan sebelum coding formula dilanjutkan.

## D. Business Decisions

Isi keputusan berikut:

```text
[DECISION] Market pertama: IDX / US
[DECISION] Timeframe pertama: Daily / 4H / 1H
[DECISION] Long only atau long/short
[DECISION] Holding period target
[DECISION] Modal simulasi
[DECISION] Risk per trade
[DECISION] Maximum portfolio exposure
[DECISION] Minimum liquidity
[DECISION] Fee dan tax assumption
[DECISION] Slippage assumption
[DECISION] Minimum planned RR
[DECISION] Maksimum drawdown
[DECISION] Data provider
[DECISION] Broker-flow provider
```

## E. Expected Output Samples

Berikan contoh:

```text
Strong Buy
Buy
Watch
No Trade
Invalid Data
Expired Setup
Missed Entry
Risk Limit Reached
```

## F. Test Scenarios

Minimal 20–30 scenario yang mencakup:

```text
Bullish trend
Bearish trend
Range
High volatility
Breakout valid
False breakout
Pullback valid
Support breakdown
Hidden accumulation
Distribution
Low liquidity
Missing broker data
Corporate action
```

---

# 24. Recommended Starting Scope

Rekomendasi scope awal:

```text
Market       : IDX
Timeframe    : Daily
Direction    : Long only
Setup        : Trend Pullback
               Breakout
               Range Mean Reversion
Execution    : Next-day open
Risk model   : Fixed fractional risk
Validation   : Walk-forward
Deployment   : Scanner + paper trading
```

Jangan langsung mengejar sinyal terbanyak.

Target MVP:

```text
Lebih sedikit signal
Lebih jelas alasannya
Lebih disiplin risikonya
Lebih dapat dipercaya backtest-nya
```

---

# 25. Final Product Principle

AWO harus mampu membedakan empat hal:

```text
Saham bagus
Setup bagus
Harga entry bagus
Risiko yang masih dapat diterima
```

Saham bagus belum tentu memiliki entry bagus.

Score tinggi belum tentu mempunyai risk–reward bagus.

Win rate tinggi belum tentu mempunyai expectancy positif.

Karena itu, keputusan akhir harus berasal dari:

```text
Regime
+ Setup
+ Direction
+ Confirmation
+ Risk–Reward
+ Portfolio Risk
+ Data Quality
```

Bukan hanya dari penjumlahan indikator.
