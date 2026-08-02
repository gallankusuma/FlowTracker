Bro, gue baca full formula AWO 14-factor lo. Secara konsep, fondasinya sudah kuat: semua faktor dipaksa ke skala 0–100, bobot total = 1.00, ada neutral point 50, dan lo sudah mencampur smart money + momentum + mean reversion + volatility + structure.

Tapi kalau gue review sebagai scoring model trading, versi sekarang masih punya beberapa masalah yang menurut gue wajib dibenerin sebelum optimizer dibiarkan jalan bebas.

Verdict gue

Arsitektur: 8/10
Formula sekarang: sekitar 6.5/10
Setelah beberapa logic fix, ini bisa jauh lebih solid.

1. 🚨 F7 Price–Broker Alignment ada logic bug besar

Formula sekarang:

sameDirection =
  (harga naik & dn0>0) ||
  (harga turun & dn0<0)

if sameDirection:
    score = 50 + alignmentStrength×45

Masalahnya:

Harga turun + broker jual = bearish confirmation, tetapi formula justru menaikkan skor.

Contoh:

Price Change = -4%
dn0 = -8

priceIntensity  = 0.8
brokerIntensity = 1.0
strength = 0.8

F7 = 50 + 0.8 × 45
   = 86

Artinya kondisi:

Harga jatuh + broker distribusi kuat

malah menghasilkan F7 = 86 → bullish banget.

Ini menurut gue bug paling kritis di model sekarang.

Harus dipisah:

if (price > 0 && dn0 > 0)
    score = 50 + strength * 45;   // bullish confirmation

else if (price < 0 && dn0 < 0)
    score = 50 - strength * 45;   // bearish confirmation

else if (price < 0 && dn0 > 0.5)
    score = 55 + brokerIntensity * 15; // hidden accumulation

else if (price > 0 && dn0 < 0)
    score = 50 - strength * 35;   // distribution divergence

Ini prioritas #1.

2. 🚨 F10 MACD histogram × 500 tidak scale-independent

Sekarang:

if histogram>0:
    score = 60 + min(histogram×500,35)

Problemnya MACD adalah selisih harga dalam point, bukan percentage. Fidelity juga menjelaskan MACD sebagai selisih EMA 12 dan EMA 26 yang dinyatakan dalam price points.

Jadi histogram:

0.10

punya arti sangat berbeda untuk saham:

Harga 5
Harga 50
Harga 5,000

Tetapi AWO memperlakukan semuanya sama.

Lebih aman normalize:

histPct = histogram / price * 100

atau yang menurut gue lebih bagus:

histNorm = histogram / ATR

Lalu:

score = 50 + 35 * Math.tanh(histNorm / 0.25)

Dengan begitu F10 bisa dipakai lintas saham tanpa bias terhadap nominal harga.

3. 🚨 F6 Buyer Breadth punya bug di 50:50

Formula:

direction = pct>50 ? +1 : -1

Misalnya:

10 buyer
10 seller

pct = 50%
total = 20
countBonus = 5

Karena:

50 > 50 = false

maka:

direction = -1
score = 50 - 5
      = 45

Padahal kondisi 10 buyer vs 10 seller harus neutral.

Minimal:

direction = Math.sign(pct - 50)

Dan perlu guard:

if (numBuyers + numSellers === 0)
    return 50;
4. ⚠️ F4 ada arah scoring yang menurut gue terbalik

Lo punya:

if RSI>70 & combined<0:
    score += 8

Kondisinya berarti:

overbought + momentum sudah negatif.

Buat composite di mana score tinggi = BUY, kondisi ini justru harusnya memberikan konfirmasi bearish/reversal.

Gue lebih condong:

if (RSI > 70 && combined < 0)
    score -= 8;

Atau bahkan lebih bagus: lihat regime dulu.

5. F9 RSI terlalu pure contrarian

Sekarang:

RSI 20 → 100
RSI 30 → 85
RSI 50 → ~57
RSI 70 → 30
RSI 80 → 15

Secara mean-reversion masuk akal.

Tapi pada saham yang sedang strong trend:

RSI = 75
EMA bullish
volume naik
price breakout

AWO F9 malah menghukum saham tersebut.

Padahal RSI bisa bertahan overbought cukup lama ketika trend kuat; overbought tidak otomatis berarti harga akan jatuh. Schwab juga menyarankan RSI dibaca bersama kondisi trend, bukan sebagai reversal signal standalone.

Menurut gue perlu Market Regime

Misalnya:

if (trendStrong) {
    RSI 55-70 = bullish
    RSI 70-80 = still bullish, but caution
}

if (rangeMarket) {
    RSI < 30 = bullish mean-reversion
    RSI > 70 = bearish mean-reversion
}

Ini bakal bikin AWO jauh lebih pintar.

6. F11 Bollinger punya masalah serupa

Sekarang:

%B <= 0   → 95
%B > 1    → 5

Itu pure mean reversion.

Tetapi:

price > upper Bollinger
+ volume breakout
+ EMA9 > EMA21

bisa berarti breakout kuat, bukan otomatis sell.

Dan satu lagi:

if widthPct <5%:
    score += 10
Ini agak salah secara konsep.

Bollinger squeeze cuma bilang:

kemungkinan expansion/breakout meningkat.

Dia tidak memberi tahu arahnya.

Jadi squeeze sebaiknya meningkatkan:

confidence

bukan:

bullish score
7. F14 ATR juga bukan directional alpha

Sekarang:

ATR rendah → score 80
ATR tinggi → score 10

Implikasinya:

volatility rendah = bullish
volatility tinggi = bearish.

Padahal ATR cuma mengukur volatility/risk, bukan arah.

Menurut gue F14 jangan masuk langsung sebagai:

BUY / SELL score

Tapi menjadi:

Confidence multiplier

Contoh:

ATR normal       confidence = 1.00
ATR agak tinggi  confidence = 0.90
ATR tinggi       confidence = 0.75
ATR extreme      confidence = 0.60

Kemudian:

finalScore =
    50 + (rawScore - 50) * confidence;

Ini lebih clean.

8. F13 Support/Resistance punya edge case berbahaya

Sekarang:

if distToSupport < 2%
    return 85

Contoh:

support     = 99
price       = 100
resistance  = 100.20

Support cuma 1% di bawah → AWO langsung:

F13 = 85

Padahal upside ke resistance cuma:

0.2%

Risk/reward-nya jelek.

Lebih bagus pakai:

risk   = price - support
reward = resistance - price

RR = reward / risk

Kemudian scoring berdasarkan RR.

Contoh mapping sederhana:

score = 100 * RR / (1 + RR)

Jadi:

RR 0.5 → 33
RR 1   → 50
RR 2   → 67
RR 3   → 75
RR 5   → 83

Ini menurut gue jauh lebih meaningful.

9. Ada potensi double counting besar

Ini justru penting banget.

Faktor broker:

F1  14%
F2  10%
F6  10%
F7   8%
F8   5%
---------
    47%

Dan F1, F2, F7, F8 sebagian besar berasal dari keluarga data yang sama:

dn0 / dnValues

Totalnya:

37% composite berasal dari variasi informasi broker net-flow yang sangat berkorelasi.

Kemudian sisi technical:

F4  momentum
F10 MACD
F12 EMA trend

juga banyak menangkap informasi trend/momentum yang sama.

Schwab juga menekankan manfaat memakai indikator yang dihitung dengan cara berbeda agar konfirmasi tidak sekadar mengulang informasi yang sama.

Jadi daripada 14 faktor dianggap 14 independent votes, realitanya mungkin cuma sekitar:

Broker Flow
Trend/Momentum
Mean Reversion
Volume
Price Structure
Risk
10. F1/F2/F5/F7 harus sangat jelas soal UNIT

Ini concern besar lain.

Misalnya:

sigmoid(dn0, 0.4)

dan:

brokerIntensity = min(|dn0|,8)/8

Pertanyaannya:

dn0 itu unit apa?

Kalau sudah standardized index seperti:

-10 ... +10

fine.

Tapi kalau:

Rp miliar
lot
% volume
net value

maka formula ini bisa rusak lintas saham.

Sama dengan F5:

sigmoid(excess, 0.8)

Kalau:

excess = 3

artinya +3 percentage points, hasilnya sekitar 92.

Tapi kalau code mengirim:

0.03

untuk +3%, hasilnya nyaris 50.

Jadi harus ada kontrak eksplisit:

percentage = 3.00

atau:

decimal = 0.03

Jangan mixed.

11. F2 acceleration perlu sign-aware

Misalnya 3 hari:

-8
-5
-2

Secara matematis:

naik terus

tetapi sebenarnya broker masih net sell, hanya tekanan jual berkurang.

Jangan kasih:

+8 bullish acceleration

yang sama dengan:

+2
+5
+8

Gue akan bikin:

allPositive && increasing → +8
allNegative && decreasing → -8

negativeButImproving → +3
positiveButWeakening → -3

Lebih nuanced.

12. Threshold 78 / 63 / 53 jangan dianggap fixed truth

Threshold:

78 Strong Buy
63 Buy
53 Watch
40 Neutral
25 Sell

secara desain tidak salah.

Tapi setelah lo ubah formula, distribution composite juga berubah.

Misalnya ternyata dalam histori:

95th percentile = 71

maka score 78 mungkin hampir tidak pernah muncul.

Lebih baik threshold ditentukan dari:

score → actual forward return

Misalnya:

score 40-50 → return T+5 berapa?
50-60 → ?
60-70 → ?
70-80 → ?
80+   → ?

Baru kita lihat apakah score benar-benar monotonic terhadap future return.

Ini yang paling penting buat AWO Optimizer

Karena lo bilang weights dan threshold bisa di-optimize, jangan optimize langsung seluruh histori lalu menilai hasil pada histori yang sama.

Itu sangat gampang menghasilkan overfitting.

Lebih tepat:

TRAIN
2021–2023

VALIDATION
2024

TEST
2025

WALK FORWARD
2022 → predict 2023
2023 → predict 2024
2024 → predict 2025
...

Dan masukkan:

transaction cost
slippage
survivorship bias
look-ahead bias

CFA Institute secara eksplisit merekomendasikan rolling/walk-forward testing dan menyoroti survivorship serta look-ahead bias sebagai masalah penting dalam backtesting.

Khusus data broker ini penting banget:

kalau dn0 baru diketahui setelah market close, jangan backtest seolah-olah lo bisa entry pada closing price hari yang sama.

Signal:

Close T

maka realistic execution:

Open T+1

kecuali data tersebut memang sudah tersedia intraday.

Kalau gue redesign AWO

Gue malah akan pisahkan 14 faktor menjadi tiga layer:

           AWO ENGINE
               │
        ┌──────┴───────┐
        │ Directional  │
        │    Alpha     │
        └──────┬───────┘
               │
 F1 F2 F4 F5 F7 F8 F10 F12 F13
               │
               ▼
          RAW SCORE
               │
       ┌───────┴────────┐
       │ Confirmation   │
       │    F3 / F6     │
       └───────┬────────┘
               │
               ▼
       CONFIDENCE SCORE
               │
       ┌───────┴────────┐
       │ Risk / Regime  │
       │ F9 F11 F14     │
       └───────┬────────┘
               │
               ▼
          FINAL SCORE

Jadi F14 tidak voting "buy", tapi menentukan seberapa percaya kita terhadap BUY signal.

F9/F11 juga berubah fungsi tergantung:

TREND regime
vs
RANGE regime

Menurut gue ini upgrade paling besar yang bisa bikin AWO dari “weighted technical indicator” menjadi proper decision engine.

Prioritas perbaikannya
Priority	Factor	Problem
🔴 P0	F7	bearish alignment malah bullish
🔴 P0	F10	MACD tidak normalized
🔴 P0	F6	50:50 menjadi bearish
🟠 P1	F4	overbought + negative momentum mendapat bonus
🟠 P1	F13	near-support override mengabaikan resistance
🟠 P1	F9/F11	terlalu mean-reversion tanpa regime
🟡 P2	F14	risk dicampur dengan direction
🟡 P2	F1/F2/F7	normalization dn
🟡 P2	Composite	correlated-factor double counting
🟡 P2	Optimizer	wajib walk-forward/OOS

Jadi kesimpulan gue bro: ide AWO 14-factor-nya bagus dan cukup sophisticated. Gue nggak akan buang desain ini. Justru gue akan pertahankan 14 input-nya, tapi ubah cara mereka berinteraksi—terutama F7, normalization F10, regime F9/F11, dan pemisahan directional score vs confidence/risk. Setelah empat itu beres, baru optimizer lo bakal punya fondasi yang jauh lebih sehat.