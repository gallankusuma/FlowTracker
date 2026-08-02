1. Prioritaskan AWO Lab, baru AWO Signal

Urutan produknya sebaiknya:

AWO LAB
Data → Formula → Backtest → Validation → Paper Trade
                         ↓
                    AWO SIGNAL
             Scanner → Entry Plan → Journal

Pada fase awal, alokasi pekerjaan kira-kira:

70%  Data, backtest, validation, testing
30%  Dashboard dan tampilan signal

UI bagus tidak ada artinya kalau backtest-nya masih mengandung look-ahead bias, data leakage, atau parameter overfitting.

2. Jangan langsung mengembangkan tiga setup

Mulai dengan satu setup sampai benar-benar selesai end-to-end.

Rekomendasi awal:

Market      : IDX
Timeframe   : Daily
Direction   : Long only
Setup       : Trend Pullback
Execution   : Open hari berikutnya
Holding     : Maksimum 10–20 trading days
Exit        : Stop struktur + target berbasis R

Setelah Trend Pullback terbukti stabil, baru lanjut:

Setup 2: Breakout Confirmation
Setup 3: Range Mean Reversion

Kalau tim mengembangkan tiga setup sekaligus, saat hasil backtest jelek akan sulit diketahui sumber masalahnya: data, factor, regime, entry, atau exit.

3. Setiap setup wajib punya Hypothesis Contract

Jangan hanya menulis:

RSI < 30 dan harga dekat support → BUY

Tim harus menulis kontrak strategi seperti ini:

Setup Code:
TREND_PULLBACK_V1

Hipotesis:
Saham yang masih berada dalam uptrend cenderung melanjutkan
kenaikan setelah koreksi sehat ke area support dinamis,
selama relative strength dan tekanan beli tetap positif.

Eligible Regime:
TREND_UP

Candidate Filter:
Price > EMA50
EMA50 > EMA200
EMA50 slope positif
Liquidity minimum terpenuhi

Trigger:
Harga pullback ke EMA21
RSI turun ke 40–55
Volume mengecil selama koreksi

Confirmation:
Close di atas high candle sebelumnya
Volume mulai meningkat
Relative strength tetap positif

Invalidation:
Close di bawah swing low
EMA50 slope berubah negatif
Broker distribution ekstrem

Execution:
Open T+1

Stop:
Di bawah swing low atau support valid

Target:
2R atau resistance terdekat

Maximum Holding:
15 trading days

Expected Failure Mode:
Market berubah menjadi TREND_DOWN
Gap-down setelah signal
False reversal

CFA Institute juga menempatkan penentuan hipotesis, tujuan, aturan strategi, pembentukan portofolio, dan evaluasi risiko sebagai tahapan awal dalam backtesting; walk-forward digunakan untuk meniru proses investasi nyata secara lebih realistis.

4. Bangun baseline comparison

AWO tidak cukup hanya menunjukkan profit.

AWO harus dibandingkan dengan:

Baseline A: Buy and Hold
Baseline B: Index benchmark
Baseline C: EMA crossover sederhana
Baseline D: Random entry dengan exit yang sama
Baseline E: AWO tanpa broker factor
Baseline F: AWO lengkap

Contoh hasil yang perlu dibandingkan:

Model	Expectancy	Profit Factor	Drawdown	Trades
Random Entry	-0.05R	0.91	24%	500
EMA Baseline	+0.08R	1.10	19%	310
AWO Technical	+0.18R	1.28	14%	250
AWO Full	+0.27R	1.43	12%	220

Kalau AWO tidak mampu mengalahkan baseline sederhana setelah biaya transaksi, berarti kompleksitas 14 faktor belum memberikan tambahan edge.

5. Lakukan factor ablation test

Ablation berarti membuang satu faktor secara bergantian.

AWO Full
AWO tanpa F1
AWO tanpa F2
AWO tanpa F3
...
AWO tanpa F14

Kemudian lihat perubahan:

Expectancy
Profit factor
Drawdown
Stability
Jumlah trade

Contoh interpretasi:

Tanpa F10:
Expectancy hampir tidak berubah
Drawdown juga tidak berubah

Kesimpulan:
F10 kemungkinan redundant.

Atau:

Tanpa F7:
Expectancy turun 25%
Drawdown naik

Kesimpulan:
F7 memberi kontribusi nyata.

Tambahkan juga group ablation:

Tanpa Broker Factors
Tanpa Momentum Factors
Tanpa Mean-Reversion Factors
Tanpa Risk Filters

Ini akan membuktikan apakah 14 faktor benar-benar berguna atau hanya menambahkan kompleksitas.

6. Buat Experiment Registry

Setiap backtest harus menjadi record permanen dan tidak boleh ditimpa.

Minimal simpan:

Experiment ID
Strategy version
Formula version
Configuration version
Dataset snapshot
Code commit hash
Market universe
Period
Transaction cost
Slippage
Execution assumption
Parameter set
Result
Researcher
Created timestamp
Status

Contoh:

{
  "experimentId": "EXP-2026-0084",
  "strategy": "TREND_PULLBACK_V1",
  "modelVersion": "AWO-2.0.1",
  "configVersion": "IDX-D1-TP-014",
  "dataSnapshot": "IDX-2018-2025-R03",
  "commitHash": "a13bc42",
  "execution": "NEXT_DAY_OPEN",
  "feeModel": "IDX_STANDARD_V1",
  "status": "OUT_OF_SAMPLE_TEST"
}

FINRA menekankan pengendalian pada pengembangan kode, testing sebelum production, system validation, serta review setelah strategi digunakan atau diubah. Walaupun panduan tersebut ditujukan kepada firma sekuritas, prinsip engineering dan governance-nya sangat relevan untuk aplikasi seperti AWO.

7. Terapkan Champion–Challenger Model

Jangan biarkan optimizer langsung mengganti formula production.

Gunakan:

CHAMPION
Model yang sedang digunakan pada paper/live scanner

CHALLENGER
Model baru yang sedang diuji

Contoh:

Champion:
AWO 2.0.1
Weights locked
Trend Pullback V1

Challenger:
AWO 2.1.0
RSI regime-aware
ATR risk modifier baru

Keduanya dijalankan paralel pada market yang sama.

Setelah periode evaluasi:

Champion expectancy  : +0.18R
Challenger expectancy: +0.25R

Champion drawdown    : 11%
Challenger drawdown  : 9%

Champion calibration : buruk
Challenger calibration: baik

Baru challenger boleh dipromosikan.

FINRA juga menyebut parallel operation antara model lama dan model baru sebagai praktik yang layak sampai model baru selesai divalidasi, disertai ongoing testing, monitoring, model inventory, benchmark, dan explainability.

8. Tetapkan release gate

Berikut baseline research gate yang bisa diberikan ke tim. Ini bukan jaminan profit dan harus disesuaikan setelah melihat karakter data IDX.

Gate Formula
Semua P0 logic bug selesai
Semua unit test lulus
Tidak ada NaN atau Infinity
Data timestamp tervalidasi
Formula menghasilkan output deterministic
Gate Backtest
OOS Expectancy             > 0
OOS Profit Factor          ≥ 1.20
Positive Walk-Forward Fold ≥ 70%
Minimum OOS Trade          ≥ 200
Maximum Drawdown           sesuai batas risiko
Gate Stability
Tidak bergantung pada satu saham
Tidak bergantung pada satu tahun
Parameter ±20% masih menghasilkan expectancy positif
Slippage lebih buruk masih menghasilkan expectancy positif
Tidak ada satu saham menyumbang >25% total profit
Tidak ada satu periode menyumbang mayoritas hasil
Gate Paper Trading
Paper expectancy positif
Actual slippage sesuai model
Signal tidak terlambat
Tidak ada data leakage
Tidak ada system failure material
Perbedaan backtest vs paper dapat dijelaskan

Model yang gagal satu gate tidak boleh masuk production.

9. Tambahkan sensitivity test

Jangan cuma mencari kombinasi parameter terbaik.

Misalnya hasil terbaik:

EMA period       = 21
Volume Z minimum = 1.25
Stop ATR         = 1.8
RSI minimum      = 42

Tim juga harus menguji area sekitarnya:

EMA 18–25
Volume Z 1.0–1.5
Stop ATR 1.5–2.1
RSI 38–46

Strategi sehat seharusnya memiliki plateau, bukan satu titik parameter ajaib.

Bagus:

Parameter 1.6 → profit
Parameter 1.7 → profit
Parameter 1.8 → profit terbaik
Parameter 1.9 → profit
Parameter 2.0 → profit

Red flag:

Parameter 1.7 → rugi
Parameter 1.8 → profit besar
Parameter 1.9 → rugi

Kondisi kedua sangat berpotensi hasil curve fitting.

CFA Institute menekankan bahwa backtest perlu dilengkapi scenario analysis dan sensitivity analysis, karena data pasar memiliki structural breaks, fat tails, serta pola historis yang belum tentu mewakili masa depan.

10. Tambahkan No-Trade Reason Engine

Jangan hanya mencatat signal yang diambil.

AWO harus menyimpan kenapa peluang ditolak:

NO_VALID_SETUP
UNKNOWN_REGIME
INSUFFICIENT_DATA
LOW_LIQUIDITY
RISK_REWARD_TOO_LOW
ATR_EXTREME
MARKET_TREND_DOWN
ENTRY_ALREADY_MISSED
PORTFOLIO_RISK_LIMIT
BROKER_DATA_STALE
CORPORATE_EVENT_RISK

Contoh output:

{
  "signal": "NO_TRADE",
  "reasonCode": "RISK_REWARD_TOO_LOW",
  "details": {
    "entry": 5100,
    "stop": 4950,
    "resistance": 5250,
    "plannedRR": 1.0,
    "minimumRR": 1.5
  }
}

Yang perlu dianalisis bukan hanya performa transaksi, tetapi juga:

Berapa banyak setup ditolak?
Apakah peluang yang ditolak ternyata profitable?
Apakah filter terlalu ketat?
Apakah filter berhasil menghindari loss?
11. Machine learning digunakan belakangan sebagai meta-model

Jangan meminta machine learning langsung menentukan:

BUY atau SELL

Tahap awal lebih aman:

Rule Engine:
Mendeteksi setup Trend Pullback

ML Meta-Model:
Memutuskan TAKE atau SKIP

Target ML:

Apakah TP tercapai sebelum SL?

Contoh output:

{
  "ruleSetup": "TREND_PULLBACK",
  "ruleStatus": "VALID",
  "metaDecision": "TAKE",
  "calibratedWinProbability": 0.61
}

Feature kandidat:

Regime confidence
Final directional score
Factor coverage
Planned RR
ATR percentile
Relative strength
Volume Z-score
Distance from EMA21
Market index condition
Broker-flow normalized
Gap risk
Liquidity

ML tidak boleh memakai informasi yang baru tersedia setelah signal.

Model tetap harus menjelaskan:

Faktor yang meningkatkan probability
Faktor yang menurunkan probability
Data coverage
Model version
Calibration quality

Untuk model yang lebih kompleks, model risk management perlu mencakup development, validation, deployment, ongoing testing, stressed scenarios, monitoring, explainability, dan human review.

12. Tetap gunakan human-in-the-loop

AWO versi awal sebaiknya menjadi:

Decision Support

bukan:

Autonomous Trading

AWO memberi:

Signal
Entry zone
Maximum entry
Stop
Target
Position size
Reason
Risk warning
Invalidation

Lo yang memutuskan eksekusi.

Kalau lo override rekomendasi AWO, wajib ada journal:

Override type
Alasan override
Hasil akhir
Apakah override benar

Ini bisa membandingkan:

AWO Only
Human Only
AWO + Human

FINRA mencatat bahwa banyak implementasi ML di industri digunakan untuk membantu pengambilan keputusan manusia, bukan langsung melakukan autonomous action, serta menyarankan lapisan human review bila sesuai.

13. Tambahkan kill switch

AWO harus otomatis berhenti mengeluarkan signal apabila:

Data source terlambat
Harga tidak sinkron antar-provider
Corporate action belum diproses
Factor coverage di bawah batas
Market calendar salah
Backtest configuration berubah tanpa approval
Model version tidak dikenal
Terjadi calculation error
Portfolio risk limit terlampaui

Contoh:

{
  "systemStatus": "SIGNAL_DISABLED",
  "reason": "STALE_MARKET_DATA",
  "lastValidTimestamp": "2026-07-28T16:15:00+07:00"
}

Jangan memakai fallback silently. Lebih baik AWO tidak memberi signal daripada menghasilkan rekomendasi dari data rusak.

14. Urutan pekerjaan tim berikutnya

Menurut gue, kirim urutan ini:

Sprint Berikutnya — Wajib
1. Fix F7, F6, F10, dan F4
2. Buat data contract dn0–dn4
3. Unit test semua F1–F14
4. Buat experiment registry
5. Buat baseline backtest engine
6. Implementasi satu setup: Trend Pullback
7. Implementasi execution Open T+1
8. Masukkan fee, spread, dan slippage
9. Tambahkan factor ablation
10. Buat walk-forward report
Setelah Lulus
11. Paper-trading pipeline
12. Champion–challenger model
13. Signal explainability
14. No-trade reason engine
15. Risk-based position sizing
16. Scanner dashboard
Ditunda
Optimizer otomatis
Machine learning
Auto execution
Intraday timeframe
Banyak setup sekaligus
Dynamic weight harian