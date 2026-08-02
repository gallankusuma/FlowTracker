1. Buat EXP-010 — Momentum Rank Alpha Diagnostic

Ini bisa dilakukan sekarang, bahkan sebelum backfill histori panjang.

Jangan menggunakan breakout, stop, atau target dulu. Uji apakah ranking momentum sendiri benar-benar mampu mengurutkan saham bagus dan buruk.

Setiap tanggal:

Ranking seluruh saham
→ bagi menjadi 10 bucket/decile
→ hitung forward return 5D, 10D, 20D, 60D

Output:

Decile 1  = momentum terlemah
...
Decile 10 = momentum terkuat

Yang dicari:

Return Decile 10 > Decile 9 > ... > Decile 1

Minimal hitung:

Spearman Information Coefficient;
average IC;
IC Information Ratio;
persentase tanggal dengan IC positif;
return top decile;
top-minus-bottom decile spread;
top decile versus IHSG;
top decile versus universe average;
turnover;
hasil setelah biaya;
date-block bootstrap confidence interval.

Ini akan menghasilkan jauh lebih banyak observasi daripada delapan trade breakout.

Keputusan
Ranking tidak monotonic dan IC <= 0
→ formula ranking perlu diubah

Ranking punya alpha
→ lanjut menguji breakout/pullback sebagai timing layer

Ini menurut gue eksperimen berikutnya yang paling penting.

2. Tambahkan decomposition baseline

Pada EXP-009, strategi final menggabungkan banyak lapisan sekaligus:

Momentum rank
+ trend filter
+ breakout
+ volume
+ candle quality
+ volatility
+ market regime
+ risk–reward

Kita perlu tahu lapisan mana yang menambah value.

Bandingkan:

Variant	Tujuan
Random Universe	Baseline murni
Top Momentum Rank Only	Menguji ranking
Breakout Only	Menguji breakout
Top Rank + Breakout	Menguji kombinasi
Top Rank + Breakout + Volume	Menguji volume
Full Setup A	Menguji seluruh filter

Semua variant harus memakai universe, tanggal, execution, fee, dan exit yang sama.

Ini jauh lebih informatif daripada hanya membandingkan Full Setup dengan random.

3. Buat filter waterfall dan leave-one-filter-out

Catat jumlah kandidat setelah setiap tahap:

Total ticker-date eligible
→ Top momentum rank
→ Trend structure
→ 52-week-high condition
→ Breakout
→ Volume
→ Candle quality
→ Market regime
→ Volatility
→ Risk–reward
→ Final signal

Kemudian lakukan ablation:

Full Setup
Full tanpa volume filter
Full tanpa wick filter
Full tanpa EMA-extension filter
Full tanpa RR filter
Full tanpa IHSG filter
Full tanpa volatility filter

Tujuannya bukan langsung menghapus filter, tetapi mengetahui:

Filter mana mengurangi transaksi?
Filter mana benar-benar meningkatkan expectancy?
4. Perpanjang histori harga

Ini tetap wajib.

Rekomendasi:

Minimum : 5 tahun
Ideal   : 8–10 tahun

Data harus mencakup beberapa regime:

bull market;
bear market;
sideways;
high volatility;
recovery;
liquidity contraction.

Gunakan adjusted OHLCV dan pastikan:

stock split terproses;
reverse split terproses;
rights issue ditangani;
symbol change ditangani;
suspend/delisting tidak diam-diam hilang.
Risiko survivorship bias

BIG_CAP_100 saat ini kemungkinan berdasarkan daftar saham yang dikenal sekarang. Backtest delapan tahun menggunakan saham yang “selamat sampai hari ini” dapat memberikan bias.

Idealnya gunakan:

Point-in-time universe

Artinya komposisi universe mengikuti saham yang benar-benar eligible pada tanggal historis tersebut.

Kalau data tersebut belum ada, hasil harus diberi label:

SURVIVORSHIP-BIASED RESEARCH RESULT
Setup berikutnya: Momentum Pullback

Setelah histori diperpanjang, jangan hanya mengulang Setup A. Bangun Setup B — Momentum Leadership Pullback.

Menurut gue ini bahkan berpotensi lebih praktis untuk IDX karena breakout bersih dengan volume tinggi dan semua filter sekaligus ternyata sangat jarang.

Candidate
Top 10%–20% momentum rank
Price > EMA50 > EMA200
EMA50 slope positif
Relative strength tetap kuat
Tidak dalam HIGH_VOLATILITY
Pullback condition
Harga terkoreksi ke EMA20/EMA21
atau
harga mendekati support/swing low sehat

Pullback tidak merusak EMA50
Volume selama koreksi mengecil
Tidak ada gap-down ekstrem
Trigger
Close di atas high candle sebelumnya
Momentum pendek kembali positif
Volume kembali meningkat
Close berada dekat high harian
Invalidation
Close di bawah swing low
Close di bawah EMA50
Relative strength jatuh keluar top bucket
Market masuk high-volatility/downtrend ekstrem

Breakout dan pullback harus memiliki strategy ID berbeda:

MOMENTUM_BREAKOUT_V1
MOMENTUM_PULLBACK_V1

Jangan gabungkan statistiknya.

Versi advanced: ranking mingguan, eksekusi harian

Agar ranking tidak terlalu noisy:

Setiap akhir minggu:
hitung ranking momentum

Sepanjang minggu berikutnya:
cari breakout atau pullback trigger

Keuntungannya:

turnover ranking lebih rendah;
lebih stabil;
lebih sedikit noise harian;
mengurangi computational load;
lebih mudah dipakai trader secara nyata.

Jangan memakai data Jumat untuk entry sebelum data Jumat benar-benar tersedia. Ranking Jumat paling cepat dipakai pada sesi berikutnya.

Setelah setup positif: bangun portfolio engine

Metode yang bagus di level trade belum tentu menghasilkan portfolio yang sehat.

Output advanced harus menjawab:

Saham mana yang dipilih?
Berapa banyak posisi?
Berapa ukuran masing-masing?
Apakah saham-sahamnya sangat berkorelasi?
Apakah sektor terlalu dominan?

Baseline:

Maximum positions       : 5–10
Risk per trade          : configurable
Maximum total open risk : configurable
Maximum sector exposure : 20%–30%
Maximum one-stock weight: configurable
Liquidity cap           : berdasarkan ADV20

Bandingkan:

Equal weight
Equal risk
Inverse volatility
Volatility-targeted portfolio

ATR dipakai untuk sizing dan stop, bukan untuk mengubah arah sinyal.

Urutan eksperimen yang gue rekomendasikan
EXP-010
Momentum Rank Alpha Diagnostic

EXP-011
Layer Decomposition:
Rank-only vs Breakout-only vs Rank+Breakout

EXP-012
Volatility Filter Isolation:
No filter vs soft sizing vs hard gate

EXP-013
Extended-history Momentum Breakout rerun

EXP-014
Momentum Pullback

EXP-015
Breakout vs Pullback comparison

EXP-016
Broker overlay:
Base vs Base+F1 vs Base+F2 vs Base+F1/F2

EXP-017
Portfolio-level backtest
Metode yang paling kuat untuk dikembangkan

Arah terbaik AWO sekarang:

Cross-Sectional Momentum Ranking
        ↓
Setup Router
 ┌──────┴──────┐
Breakout     Pullback
 └──────┬──────┘
        ↓
Volatility & Market Filter
        ↓
Portfolio Risk Engine
        ↓
Trade Plan

Jangan masuk machine learning dulu.

ML baru layak ketika:

base setup sudah mempunyai expectancy positif;
jumlah transaksi sudah cukup;
locked holdout tetap positif;
paper trading konsisten;
feature snapshot lengkap.
Kesimpulan

Implementasi tim sudah benar secara konsep dan cukup disiplin secara engineering. Kegagalan saat ini bukan pada kode strategi, melainkan keterbatasan data untuk menguji strategi low-frequency.

Keputusan berikutnya:

Jangan promosikan Setup A, jangan menolaknya, dan jangan mengubah parameternya dulu. Uji alpha ranking secara terpisah menggunakan seluruh observasi yang tersedia, lalu perpanjang histori dan bandingkan Momentum Breakout dengan Momentum Pullback.

Itu jalur paling efisien untuk mengetahui apakah AWO benar-benar mempunyai edge atau hanya menghasilkan setup yang terlihat bagus secara visual.