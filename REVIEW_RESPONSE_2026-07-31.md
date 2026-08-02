# Tanggapan atas Review.md (putaran 2026-07-31, Ronde 1) — Perbaikan yang Sudah Diterapkan

> **Update**: tim review mengirim `Review.md` yang jauh lebih detail di hari yang sama, menemukan bahwa beberapa perbaikan di Ronde 1 di bawah ini ternyata belum benar-benar berfungsi. Lihat **Ronde 2** di akhir dokumen ini untuk tanggapan lengkap atasnya — termasuk temuan paling kritis: paper trading yang baru selesai dibangun ternyata tidak pernah bisa mencatat satu trade pun ke challenger yang benar, karena bug candidate-key mismatch.
>
> **Update kedua**: tim review mengirim `Review.md` versi ketiga, hari yang sama juga. Kali ini fokus ke satu bug yang membatalkan makna semua safeguard Ronde 2 (challenger diverifikasi dengan threshold yang BEDA dari yang dipakai paper trading), plus menemukan bug availability technical factor yang — begitu ditelusuri lebih dalam — ternyata bukan cuma soal `scoreAtTimestamp()`, tapi juga menduplikasi diri di DUA jalur live-scoring lain di `server.js`. Lihat **Ronde 3** di akhir dokumen.

Review ini jauh lebih tajam dari review sebelumnya — bukan cuma menemukan bug baru, tapi menemukan bahwa beberapa "perbaikan" dari putaran kemarin (2026-07-30) masih setengah jalan: optimizer sudah pakai outcome sungguhan (T+1/stop/target/fee), tapi masih memilih kandidat berdasarkan win rate, bukan profitabilitas; paper trading sudah dibangun, tapi tidak ada pemeriksaan untung/rugi sama sekali. Setiap klaim diverifikasi dulu terhadap kode asli sebelum diperbaiki — semua 12 temuan dikonfirmasi akurat, satu bahkan **lebih parah dari yang dilaporkan** (lihat poin 9).

Status: **Selesai** = diperbaiki, dites, di-deploy, diverifikasi hidup. **Sebagian** = akar masalah nyata diperbaiki tapi cakupan penuh belum selesai. **Ditunda** = sengaja belum dikerjakan, dengan alasan eksplisit.

---

## 1. 🚨 Optimizer masih mengoptimalkan win rate, bukan profitabilitas

**Status: Selesai.**

Dikonfirmasi persis seperti dilaporkan: `scored.sort()` dan `validated.sort()` di `awo_optimizer.js` mengurutkan berdasarkan `winRate`, `avgPnL` cuma tiebreaker kalau selisih win rate <0.5pp. Ambang adopsi (`MIN_MARGIN = 2`) juga dalam satuan persentase poin win rate.

Diperbaiki:
- `computeWinRate()` dan `optimizeThresholds()` sekarang juga menghitung `expectancy` (rata-rata netR) dan `profitFactor` (gross profit / gross loss).
- Ranking kandidat (baik di train maupun validate) sekarang murni berdasarkan **expectancy**, bukan win rate. Win rate tetap dilaporkan tapi hanya informasional.
- Ditambahkan floor `MIN_TRAIN_SAMPLE_FOR_RANKING = 20` di tahap ranking train, supaya kandidat dengan sampel kecil yang kebetulan beruntung tidak naik ke atas hanya karena win rate 100% dari 3 trade.
- Ditambahkan **hard rejection gate** di safeguard walk: kandidat ditolak kalau `validateResult.expectancy <= 0` atau `validateResult.profitFactor < 1.20` — dicek SEBELUM significance test dan monotonicity, jadi kandidat yang tidak profitable tidak mungkin lolos apa pun status statistiknya.
- Kriteria adopsi diganti dari "win rate membaik >= 2pp" menjadi "expectancy membaik >= 0.05R dibanding baseline."

**Bukti langsung dari produksi**: menjalankan `/api/awo/optimize/run` setelah fix ini menghasilkan kandidat dengan `improvement: +3.3%` (win rate) — yang di bawah kode LAMA akan lolos (3.3 >= MIN_MARGIN lama 2) — tapi `expectancy: -0.292R, profitFactor: 0.51`. Kandidat ini **ditolak** oleh gate baru. Kode lama benar-benar akan mengadopsi kandidat yang secara matematis merugi. Ini bukan skenario hipotetis dari review — ini kejadian nyata pada percobaan pertama setelah fix di-deploy.

## 2. 🚨 Paper-trading gate bisa meloloskan kandidat yang rugi

**Status: Selesai.**

Dikonfirmasi: `/api/awo/optimize/promote` hanya memeriksa `resolved >= 10` dan `calendarDaysElapsed >= 7`, tidak ada pemeriksaan profitabilitas sama sekali.

Diperbaiki — gate baru di `/promote` sekarang memeriksa keempatnya:
- `resolved >= 30` (dinaikkan dari 10, sesuai angka yang disarankan review)
- `calendarDaysElapsed >= 20` (dinaikkan dari 7)
- `avgNetR > 0`
- `profitFactor >= 1.10`

Jika salah satu gagal, `/promote` menolak dengan pesan yang menyebutkan persis alasan mana yang belum terpenuhi (bisa lebih dari satu sekaligus).

## 3. 🚨 Paper trade menggunakan stop/target dari harga sinyal, bukan entry aktual

**Status: Selesai.**

Dikonfirmasi persis: `computeTradePlan(price_at_signal, ...)` dipanggil saat generate, padahal entry sungguhan baru diisi belakangan (open T+1) oleh `resolvePaperTrades`. Kalau ada gap harga overnight, stop/target yang tersimpan tidak lagi mencerminkan risiko yang sebenarnya diambil.

Diperbaiki: `generatePaperTrades()` sekarang **tidak lagi menghitung** stop-loss/target sama sekali — hanya mencatat arah dan tanggal sinyal, status `PENDING_ENTRY`. `resolvePaperTrades()` yang menghitung trade plan, PERSIS pada saat open T+1 sungguhan diketahui: ATR/SR dihitung dari data sampai tanggal sinyal (tanpa lookahead), lalu `computeTradePlan(entryPrice_T+1, ...)` — sama seperti `evaluateCandidateOutcome()` di optimizer. Kalau trade plan gagal dihitung (misal data tidak cukup), paper trade ditandai `REJECTED`, bukan diam-diam salah.

Skema DB disesuaikan: `stop_loss`/`target` sekarang nullable (dulu `NOT NULL`, dipaksa lewat `ALTER TABLE ... MODIFY COLUMN`).

## 4. Split optimizer belum bebas leakage

**Status: Sebagian — purge + seed selesai, rolling walk-forward folds belum.**

Dikonfirmasi keempat masalah: split berdasarkan jumlah baris bukan tanggal unik, tidak ada purge/embargo, holding period 15 hari bisa membuat trade train memakai bar yang jatuh di periode validate, dan `Math.random()` tanpa seed.

Diperbaiki:
- Split sekarang berdasarkan **tanggal unik** (70% tanggal pertama = train, sisanya = validate) — bukan lagi index baris, jadi satu tanggal tidak mungkin lagi terpecah antara train dan validate.
- **Purge gap**: sinyal train dalam jarak `OUTCOME_MAX_HOLD` (15) hari bursa sebelum batas validate **dibuang**, karena outcome walk-forward-nya bisa menyentuh bar yang tanggalnya sudah masuk periode validate. Dampak nyata: dari 15.613 sinyal, 1.950 dibuang oleh purge pada percobaan verifikasi live.
- `generateWeightCandidates()` sekarang pakai PRNG seeded (mulberry32, algoritma yang sama dipakai `backtest_baseline_comparison.js`), seed direkam di hasil (`candidateSeed`) untuk reproduksibilitas.

**Belum**: rolling walk-forward CV (banyak fold train/validate bergeser maju), locked final holdout terpisah. Ini perubahan arsitektur lebih besar — masih tercatat sebagai follow-up terbuka di `BACKTEST_EXPERIMENTS.md`, konsisten dengan catatan jujur yang sudah ada di file ini sejak awal ("despite earlier docs claiming walk-forward validation...").

## 5. Threshold optimization mengalami validation leakage

**Status: Selesai.**

Dikonfirmasi: `optimizeThresholds(signals, best.weights)` dipanggil dengan `signals` — gabungan train+validate — PADAHAL validate set sudah dipakai untuk memilih `best.weights` di langkah sebelumnya.

Diperbaiki: `optimizeThresholds(trainSet, best.weights)` — hanya TRAIN set. Metrik internalnya juga diganti dari `winRate * sqrt(n)` menjadi `expectancy * sqrt(n)` dengan floor `expectancy > 0`, konsisten dengan fix poin 1.

**Catatan jujur**: masih belum ada locked-test split ketiga untuk mengevaluasi hasil akhir (weights + thresholds bersama) sepenuhnya out-of-sample. Validate set sekarang murni dipakai untuk PILIH bobot, TRAIN dipakai untuk pilih threshold — tapi threshold akhirnya belum divalidasi ulang di data yang benar-benar belum pernah "dilihat" oleh proses manapun.

## 6. Beberapa safeguard masih menggunakan return_5d

**Status: Selesai — dan ditemukan satu yang lebih parah.**

Dikonfirmasi `factorValidity()` dan `checkMonotonicity()` pakai `return_5d`. Diperbaiki, keduanya sekarang pakai `_bullishOutcome.netR` — outcome walk-forward sungguhan yang sama dipakai `computeWinRate`.

**Ditemukan tambahan** (di luar yang dilaporkan review): `factorValidity()` sebenarnya memanggil `awo_analyzer.js`'s `splitAnalysis()` untuk komponen "lift", dan `splitAnalysis` ternyata memakai `s.outcome` — field yang di-stempel untuk arah ORIGINAL sinyal saat pertama disimpan, bug staleness yang SAMA PERSIS dengan yang sudah diperbaiki di `computeWinRate` kemarin (2026-07-30), tapi belum ikut diperbaiki di sini. Ditulis ulang jadi perhitungan lokal di `awo_optimizer.js` sendiri yang pakai `_bullishOutcome.result`, tidak lagi bergantung pada `splitAnalysis`.

`MONOTONICITY_TOLERANCE` diskalakan ulang dari 3 (persentase poin, cocok untuk `return_5d`) ke `0.2` (satuan R, cocok untuk `netR`) — angka lama akan membuat pemeriksaan ini nyaris tidak pernah aktif kalau dipakai langsung pada skala R.

## 7. Dataset optimizer masih dipilih berdasarkan sinyal lama

**Status: Selesai.**

Dikonfirmasi: `WHERE outcome IS NOT NULL AND outcome != 'NEUTRAL'` membuang baris yang secara historis diklasifikasi NEUTRAL — padahal kandidat bobot baru mungkin akan mengklasifikasikan baris yang sama sebagai BUY/SELL.

Diperbaiki: klausa `outcome != 'NEUTRAL'` dihapus. `outcome IS NOT NULL` (baris cukup umur untuk punya outcome) tetap dipertahankan — itu syarat data, bukan syarat klasifikasi. `attachTradeOutcomes()` menghitung outcome sungguhan tiap kandidat langsung dari harga, jadi tidak bergantung pada label lama yang sekarang lebih inklusif ini.

## 8. scoreAtTimestamp() sudah ada, tetapi belum benar-benar menjadi single source of truth

**Status: Sebagian — klaim di response kemarin dikoreksi, migrasi penuh masih belum.**

Review ini benar, dan tanggapan kemarin (2026-07-30) **terlalu optimis**: P0-2 ditandai "Selesai" setelah `scoreAtTimestamp()`/`combineFactorScores()` dibuat, padahal `modules/score_engine.js`'s doc comment SENDIRI sudah jujur mengatakan "NOT yet migrated: regenerate_signal_history.js and backtest_*.js scripts" — komentar itu tidak diangkat ke level klaim status di dokumen respons. Dikoreksi di sini secara eksplisit: yang benar-benar terbukti sama (via parity test) hanyalah bahwa optimizer dan live scanner memanggil `combineFactorScores()` yang identik — bukan bahwa raw-candle-input dari live/backtest/optimizer semuanya melewati SATU jalur (`scoreAtTimestamp()`) dan menghasilkan output identik end-to-end.

**Belum dikerjakan** (ditandai jujur sebagai follow-up, bukan dipaksakan hari ini): golden-fixture test seperti yang diminta review (satu skenario tetap → jalankan lewat live/backtest/optimizer, bandingkan F1-F14/coverage/skor/klasifikasi persis sama), dan migrasi penuh `regenerate_signal_history.js` + semua `backtest_*.js` ke `scoreAtTimestamp()`. Ini pekerjaan nyata yang cukup besar (banyak script, masing-masing sudah divalidasi sendiri terhadap data riil sepanjang sesi ini) — dikerjakan terpisah, bukan buru-buru hari ini.

## 9. F14 masih masuk ruang pencarian bobot

**Status: Selesai — dan ternyata bug ini LEBIH PARAH dari yang dilaporkan.**

Review menduga F14 di ruang pencarian optimizer itu "dummy parameter" — tidak dipakai, cuma buang-buang ruang pencarian. **Diverifikasi lebih dalam, ternyata BUKAN dummy — F14 aktif mengotori skor produksi LIVE saat ini juga**, bukan cuma soal optimizer:

`weightedComposite()` di `modules/awo_factors.js` melakukan iterasi atas `Object.keys(weights)` — kalau `weights` punya entry `f14` (dan `DEFAULT_WEIGHTS` SELALU punya, begitu juga tiap kandidat optimizer), sementara objek skor F1-F13 yang dikirim tidak punya key `f14`, maka `scores['f14'] ?? 50` bernilai 50 — dan 50 itu ikut masuk ke numerator/denominator composite dengan bobot F14. Dibuktikan secara empiris: 13 faktor semuanya bernilai 80 menghasilkan composite **79.1**, bukan 80.0, semata karena F14 punya bobot 0.03 di objek weights. Ini terjadi di SETIAP skor live yang dihitung sistem — bukan cuma di optimizer.

Diperbaiki di dua lapis:
- `combineFactorScores()` sekarang membuang key `f14` dari `weights` SEBELUM memanggil `weightedComposite()` — jadi baik `weights` punya entry f14 atau tidak, hasilnya sekarang selalu identik dan benar.
- `generateWeightCandidates()` tidak lagi menghasilkan entry `f14` sama sekali — F14 sepenuhnya keluar dari ruang pencarian, sesuai instruksi review.
- `DEFAULT_WEIGHTS` (baik di `score_engine.js` maupun duplikat lama di `server.js` yang ikut ditemukan dan dihapus) juga tidak lagi menyertakan f14.

Diverifikasi dengan test yang membuktikan skor identik dengan/tanpa key f14 di objek weights, dan bahwa memvariasikan nilai bobot f14 tidak pernah mengubah composite.

## 10. Identitas kandidat paper trading belum lengkap

**Status: Selesai (untuk weights + thresholds + model version); fee/exit-policy version belum karena belum ada lebih dari satu versi di sistem ini.**

Dikonfirmasi: `candidateKeyFromWeights()` cuma hash bobot. Dua kandidat bobot sama tapi threshold beda akan bercampur track record-nya.

Diperbaiki: `candidateKeyFromWeights(weights, thresholds, modelVersion)` — hash sekarang mencakup ketiganya. Semua caller (`generatePaperTrades`, `getOrFreezeChallenger`) diperbarui untuk mengirim thresholds + `AWO_MODEL_VERSION`.

Immutable candidate registry penuh (candidate_id, seed, code version, data snapshot, status DRAFT/VALIDATED/PAPER_TESTING/dst) **belum** dibangun sebagai tabel terpisah — sebagian besar kebutuhannya sekarang tertampung di file `awo-challenger.json` (lihat poin 11) yang menyimpan candidateKey, weights, thresholds, modelVersion, backtestSummary, status, frozenAt/promotedAt/rejectedAt. Bukan tabel DB dengan histori multi-kandidat penuh, tapi mencakup field-field inti yang diminta untuk SATU kandidat aktif.

## 11. Nightly random optimizer akan memecah paper track record

**Status: Selesai — ini temuan paling kritis di seluruh review, karena tanpa fix ini paper trading (poin 2/18 dari follow-up sebelumnya) secara praktis tidak akan pernah bisa berfungsi.**

Dikonfirmasi mekanismenya persis: `/run` unseeded menimpa `AWO_RESULT_FILE` tiap malam, dan karena `candidateKeyFromWeights` (sebelum fix) hash bobot sampai 3 desimal, kandidat yang "sama secara konsep" nyaris tidak akan pernah ditemukan ulang bit-identik pada malam berikutnya — artinya track record paper trading akan reset ke nol nyaris tiap hari, dan tidak ada kandidat yang bisa realistis mengumpulkan cukup hari untuk lolos gate paper trading.

Diperbaiki — desain "frozen challenger" persis seperti disarankan review:
- File baru `awo-challenger.json`, terpisah dari `AWO_RESULT_FILE`.
- Ketika `/run` menemukan kandidat eligible: kalau TIDAK ada challenger aktif (`status: PAPER_TESTING`), kandidat ini dibekukan sebagai challenger baru. Kalau SUDAH ada challenger aktif, kandidat baru ini dilaporkan tapi TIDAK menggantikan challenger yang sedang berjalan.
- `generatePaperTrades()` setiap malam sekarang selalu memakai bobot CHALLENGER yang beku, bukan "apa pun yang ditemukan /run malam ini."
- `/api/awo/optimize/promote` sekarang beroperasi pada challenger (bukan `AWO_RESULT_FILE`), dan menandai `status: PROMOTED` setelah lolos — membebaskan slot untuk challenger berikutnya.
- Endpoint baru `POST /api/awo/challenger/reject` — retirement manual untuk challenger yang macet/buruk (sengaja tidak otomatis; keputusan real-money-adjacent tetap keputusan manusia, sama seperti seluruh keputusan sejenis di proyek ini).
- Endpoint baru `GET /api/awo/challenger` — visibilitas penuh: status, ringkasan paper trading, apa saja yang masih menghalangi promosi.

## 12. Edge trading masih belum terbukti

**Status: Diakui, bukan temuan kode baru — konteks penting, sudah konsisten dengan seluruh dokumentasi proyek ini.**

Setuju penuh dengan kerangka review: mesin pengujian membaik, tapi itu justru membuat kesimpulan "AWO Full belum punya edge" makin bisa dipercaya, bukan makin diragukan. Tidak ada tindakan kode dari poin ini — sudah tercermin di `BACKTEST_EXPERIMENTS.md` sejak EXP-001 dan di setiap update memory proyek ini.

---

## Masalah security dan UI

### Tombol optimizer dashboard kemungkinan 401

**Status: Ditunda — sudah diketahui, arsitektur perbaikan (proxy route sisi-server) memerlukan keputusan yang belum diambil sepihak.**

Sama seperti dicatat di respons kemarin: dashboard memanggil `/api/awo/optimize/run` dan reset tanpa `x-admin-key`. Solusi yang benar (browser → Next.js server route berautentikasi → backend) memerlukan environment variable baru di sisi frontend dan route baru — perubahan arsitektur frontend yang sengaja belum diputuskan sepihak dalam sesi backend-focused ini.

### CORS, body limit

**Status: Selesai (CORS allowlist mechanism; body limit); rate limit/audit log/RBAC ditunda.**

- **CORS**: dua mekanisme redundan yang sama-sama default `*` (middleware manual + `cors()` tanpa opsi) disatukan jadi satu, dengan `CORS_ALLOWED_ORIGINS` (env var, comma-separated) sebagai allowlist. **Masih default ke `*`** karena origin produksi sebenarnya belum dikonfirmasi dalam sesi ini — sengaja TIDAK ditebak, karena tebakan salah bisa mengunci frontend sendiri secara diam-diam. Set env var ini begitu origin dikonfirmasi.
- **Body limit**: diturunkan dari 50mb ke 2mb (sesuai saran review) — tidak ada endpoint yang butuh lebih dari itu dalam praktiknya.
- **Rate limiter, audit log terstruktur, RBAC**: belum dikerjakan, tercatat sebagai follow-up terbuka.
- **Admin key comparison**: diganti dari `!==` (string compare biasa, bocor lewat timing) ke `crypto.timingSafeEqual`.

### Versioning

**Status: Selesai (version bump); commit hash / data snapshot ID di registry masih belum, karena proyek ini masih belum pakai git.**

`AWO_MODEL_VERSION` dinaikkan dari `3.3-awo` ke `4.0.0-research` — akhiran `-research` sengaja dipilih untuk menegaskan status "belum layak real-money" secara eksplisit di angka versi itu sendiri, bukan cuma di dokumen. Optimizer sekarang punya seed (lihat poin 4) dan seed tersebut direkam di setiap hasil run.

---

## Verifikasi

80 unit test (naik dari 63), semua lolos — termasuk test baru untuk: F14-tidak-mengotori-composite (2 test), candidateKey sensitif terhadap thresholds/modelVersion (3 test), seeded RNG deterministik (4 test). `node -c` bersih di semua file yang diubah. Di-deploy ke VPS, di-restart, dan diverifikasi hidup: `/api/awo/status` tidak lagi menampilkan f14 di weights, `/api/awo/challenger` menunjukkan status kosong yang benar, `/api/awo/optimize/run` dijalankan sungguhan terhadap data production (15.613 sinyal) dan **terbukti langsung menolak kandidat yang di kode lama akan lolos** (win rate +3.3% tapi expectancy -0.292R) — bukti paling konkret bahwa fix poin 1 bekerja, bukan sekadar lolos test sintetis.

---
---

# Ronde 2 — Tanggapan atas Review.md versi lebih detail (hari yang sama)

Tim review mengirim `Review.md` yang jauh lebih tajam beberapa jam setelah Ronde 1 di atas — kali ini benar-benar MENJALANKAN kode (bukan cuma membaca), dan menemukan bahwa **paper trading yang baru selesai dibangun di Ronde 1 sebenarnya tidak pernah bisa berfungsi sama sekali**, plus 6 bug P0 lain, plus beberapa temuan P1. Semua diverifikasi dulu terhadap kode asli (termasuk mereplikasi generator dengan 1000 seed untuk membuktikan P0-7 secara empiris) sebelum diperbaiki — **semua temuan dikonfirmasi akurat**, dan satu (P0-6) ternyata lebih parah dari yang dilaporkan (lihat di bawah).

## P0-1. 🚨 Candidate key paper trading berbeda dengan challenger

**Status: Selesai.**

Dikonfirmasi PERSIS: `server.js` membuat challenger dengan `candidateKeyFromWeights(weights, thresholds, AWO_MODEL_VERSION)`, tapi `modules/paper_trading.js`'s `generatePaperTrades()` menghitung ulang key-nya sendiri lewat `candidateKeyFromWeights(weights, thresholds)` — TANPA parameter `modelVersion`, default ke `'unversioned'`. Dua hash yang berbeda. Setiap paper trade tercatat di bawah key yang salah, `getPaperTradeSummary()` selalu menemukan 0 trade untuk challenger manapun, dan promotion tidak akan pernah bisa lolos — **paper trading, secara struktural, tidak pernah benar-benar berjalan sejak dibangun**.

Diperbaiki persis sesuai saran review: `generatePaperTrades()` tidak lagi menghitung ulang candidate key sama sekali — sekarang menerima `candidateKey` sebagai parameter wajib dari pemanggil (`throw` kalau tidak diberikan), dan satu-satunya sumber key adalah challenger yang sudah dibekukan. Tidak ada lagi titik kedua yang bisa drift dari yang pertama.

Diverifikasi dengan test integrasi (mock pool) yang membuktikan candidate_key yang di-INSERT persis sama dengan key challenger yang dibekukan dengan modelVersion.

## P0-2. 🚨 Profit-factor gate sebenarnya belum aktif

**Status: Selesai.**

Dikonfirmasi PERSIS: `getPaperTradeSummary()` tidak pernah mengembalikan field `profitFactor` sama sekali, padahal gate di `/promote` membandingkan `paperSummary.profitFactor < MIN_PAPER_PROFIT_FACTOR`. Di JavaScript, `undefined < 1.10` bernilai `false` — gate ini secara diam-diam TIDAK PERNAH menolak apa pun.

Diperbaiki: `profitFactor` (plus komponen `grossProfit`/`grossLoss` di baliknya) sekarang benar-benar dihitung, dengan penanganan kasus khusus yang tepat: `Infinity` kalau semua menang (tidak ada rugi), `null` kalau belum ada trade resolved (bukan angka yang salah lolos gate).

Diverifikasi dengan 4 test: track record kalah total → PF=0 (menolak gate), semua menang → PF=Infinity (lolos), belum ada trade → PF=null (menolak gate), campuran realistis → PF dihitung benar.

## P0-3. 🚨 Optimizer memaksa time exit walaupun belum 15 bar

**Status: Selesai.**

Dikonfirmasi PERSIS: `evaluateCandidateOutcome()`'s `lastIdx` di-clamp ke `candles.length - 1` kalau future bar yang tersedia kurang dari `OUTCOME_MAX_HOLD` (15) — lalu kode LAMA tanpa syarat menganggap bar terakhir yang tersedia itu sebagai `TIME_EXIT`, seolah-olah holding period 15 hari sudah selesai, padahal sinyal itu mungkin baru berumur 3-5 hari. Bug ini memengaruhi SEMUA sinyal "muda" (2-15 hari, persis rentang yang memenuhi syarat `outcome IS NOT NULL` di query optimizer) — bukan kasus tepi langka.

Diperbaiki: `TIME_EXIT` sekarang hanya terjadi kalau bar yang tersedia sejak entry benar-benar mencapai `OUTCOME_MAX_HOLD` — kalau belum, hasil dikembalikan `null` (belum bisa dievaluasi), sama seperti aturan yang sudah benar di `walkForwardResolve` (paper_trading.js).

Diverifikasi dengan 2 test: sinyal dengan hanya 5 bar future dan tidak kena stop/target → tetap `null` (bukan dipaksa TIME_EXIT); sinyal muda yang MEMANG kena target dalam bar yang tersedia → tetap resolve normal (early exit karena kena target itu BUKAN bug, hanya TIME_EXIT prematur yang bug).

## P0-4. Sistem belum konsisten soal long-only atau long/short

**Status: Selesai untuk default LONG_ONLY; mode LONG_SHORT penuh (threshold short terpisah, dst) tidak diimplementasikan — di luar cakupan MVP yang direkomendasikan review sendiri.**

Dikonfirmasi: `computeWinRate()` menguji BUY sebagai long DAN SELL sebagai short, `optimizeThresholds()` cuma BUY, paper trading membuka BUY dan SELL — tiga definisi "arah" berbeda dalam satu pipeline, sementara `BACKTEST_EXPERIMENTS.md` mengklaim "Long only" di semua entry.

Diperbaiki: `TRADE_DIRECTION_MODE = process.env.TRADE_DIRECTION_MODE || 'LONG_ONLY'` ditambahkan di `awo_optimizer.js` dan `modules/paper_trading.js`. Dalam mode LONG_ONLY (default): `computeWinRate()` tidak lagi menghitung SELL/STRONG SELL sebagai trade sama sekali; `generatePaperTrades()` tidak lagi membuka paper trade untuk SELL/STRONG SELL; `optimizeThresholds()` yang SEBELUMNYA cuma BUY secara tidak sengaja, sekarang didokumentasikan sebagai perilaku yang MEMANG benar dan konsisten dengan mode ini.

Diverifikasi hidup: menjalankan `/api/awo/optimize/run` setelah fix menunjukkan `validateTotal` yang jauh lebih kecil (85/59, dulu ratusan) — karena sinyal SELL-classified sekarang benar-benar dikecualikan dari perhitungan, bukti langsung fix ini aktif di production, bukan cuma lolos test sintetis.

## P0-5. Statistical test masih menguji hal yang salah

**Status: Selesai, dengan keterbatasan yang diakui secara eksplisit.**

Dikonfirmasi: `stats.twoProportionZTest` menguji perbedaan WIN RATE, padahal objective optimizer sekarang expectancy (P0-1). Juga menguji tiap sinyal sebagai trial independen, padahal banyak saham di tanggal yang sama saling berkorelasi (satu guncangan pasar memengaruhi semuanya sekaligus) — overstate ukuran sampel efektif.

Diperbaiki: `dateBlockBootstrapExpectancyTest()` baru — resample BLOK TANGGAL (bukan sinyal individual) dengan pengembalian, bangun distribusi empiris untuk (expectancy kandidat − expectancy baseline) dari 2000 resample, kandidat lolos hanya kalau batas bawah confidence interval > 0.

**Keterbatasan yang diakui jujur**: `alpha` yang dipakai adalah `BONFERRONI_ALPHA` (0.0025) diterapkan langsung ke persentil bootstrap sebagai APROKSIMASI dari koreksi Bonferroni yang dipakai z-test lama — dengan 2000 resample, persentil ekstrem itu (~0.00125) hanya diresolusi oleh 2-3 nilai paling ekstrem dari hasil resample, lebih kasar dari koreksi analitik yang tepat. Proses "jalan-turuti-ranking, berhenti di kandidat pertama yang lolos SEMUA gate" tetap memberi perlindungan tambahan di luar test ini sendiri. Diukur performa: 20 kandidat × 2000 resample = 357ms — tidak jadi masalah kecepatan.

Diverifikasi dengan 4 test: bobot kandidat=baseline tidak pernah signifikan (delta harus persis 0), <10 tanggal unik menolak klaim signifikan, seed sama = hasil identik, resampling by block (bukan per-sinyal) didokumentasikan.

## P0-6. Daily optimization terus mengintip validation set yang sama

**Status: Selesai — dan ternyata bug ini LEBIH PARAH dari yang dilaporkan.**

Review menduga cooldown 24 jam ada tapi tidak cukup mencegah re-probing harian. **Diverifikasi lebih dalam, ternyata cooldown-nya nyaris TIDAK PERNAH benar-benar aktif**: kode mengecek `awo_optimization_log`'s baris terakhir — tapi tabel itu HANYA mendapat baris baru saat PROMOSI benar-benar terjadi (jarang, paper trading makan waktu berminggu-minggu), BUKAN setiap kali `/run` dipanggil. Karena promosi jarang terjadi, cron malam yang memanggil `/run` setiap hari praktis TIDAK TERKENDALI sama sekali — persis risiko multiple-testing yang menyebabkan insiden overfitting 2026-07-19, kali ini terjadi lagi di skala hari-ke-hari.

Diperbaiki: cooldown sekarang mengecek `AWO_RESULT_FILE`'s `savedAt` sungguhan (kapan `/run` TERAKHIR dipanggil, bukan kapan promosi terakhir terjadi) — dan ditambahkan gate BARU: `MIN_NEW_SIGNALS_FOR_REOPT = 200` — re-optimisasi ditolak kalau jumlah sinyal eligible baru sejak run terakhir kurang dari itu, bahkan kalau cooldown waktu sudah lewat.

Diverifikasi hidup: `/api/awo/optimize/run` (tanpa `force=1`) sekarang benar-benar menolak dengan `status: COOLDOWN` dan `lastRunAt` yang akurat (86 menit lalu, bukan info basi dari tabel promosi).

## P0-7. Maximum factor weight masih bisa terlampaui

**Status: Selesai — dan sempat menemukan bug KEDUA dalam proses memperbaikinya sendiri.**

Direplikasi persis seperti review: generator lama (clamp-lalu-renormalize-satu-kali) menghasilkan pelanggaran batas 0.18 pada ~4.9% dari 150.000 kandidat yang diuji, sampai 0.197 — mengonfirmasi klaim review (mereka menemukan 130-156 dari 3.000 per seed, rentang yang sama).

Diperbaiki dengan capped-simplex projection iteratif (`projectToCappedSimplex()`) — clamp dan "kunci" bobot yang melanggar batas, distribusikan sisa anggaran HANYA ke bobot yang belum terkunci, ulangi sampai stabil. **Versi pertama fix ini sendiri masih punya bug** (ditemukan sendiri lewat test, bukan dari review): mendistribusikan proporsional terhadap NILAI SAAT INI, yang gagal total kalau sebuah bobot mulai dari persis 0 (tidak bisa menerima bagian apa pun dari pembagian proporsional-terhadap-nilai). Diperbaiki ulang jadi mendistribusikan proporsional terhadap RUANG YANG TERSEDIA (max−nilai saat menambah, nilai−min saat mengurangi) — pendekatan water-filling standar yang benar untuk kasus apa pun.

Diverifikasi ulang dengan skala PENUH review sendiri: 1000 seed × 3000 kandidat = 3.000.000 kandidat diperiksa, **nol pelanggaran batas, nol pelanggaran total≠1.0**.

## P1 — Hal lain yang diperbaiki

- **Default baseline fallback basi** (`optimizeWeights`'s fallback 8-faktor literal, tidak ikut update F9-F14) — diganti pakai `DEFAULT_WEIGHTS` sungguhan dari `score_engine.js`.
- **`CORS_ALLOWED_ORIGINS` belum ada di `.env.example`** — ditambahkan, dengan catatan jujur bahwa nilai contoh (`flowtracker.id`) BUKAN domain production yang terkonfirmasi (nama itu di tempat lain di codebase ini merujuk situs pihak ketiga yang di-scrape, bukan domain aplikasi ini sendiri).
- **Promotion audit log: old_win_rate == new_win_rate** — dikonfirmasi: keduanya membaca `challenger.backtestSummary` yang sama (angka kandidat), baseline sungguhan tidak pernah disimpan. Diperbaiki: `getOrFreezeChallenger()` sekarang juga menyimpan `baselineSummary` (dari `optResult.baseline`) saat challenger dibekukan, dan `/promote`'s INSERT membaca `baselineSummary` untuk `old_win_rate`, `backtestSummary` untuk `new_win_rate` — plus `improvement` sekarang benar-benar dihitung (delta expectancy), bukan `null`.
- **Promotion race condition** (dua `/promote` bersamaan bisa sama-sama lolos cek `status=PAPER_TESTING` sebelum salah satu menyimpan `PROMOTED`) — diperbaiki dengan flag in-memory (`_promotionInFlight`). Bukan atomic compare-and-set berbasis DB seperti disarankan review, tapi CUKUP untuk deployment sesungguhnya (satu proses PM2 fork-mode, bukan cluster) — dicatat sebagai keputusan scope, bukan solusi setengah jalan yang tidak disadari.
- **F9-F13 "available" walau data candle kurang** — `scoreAtTimestamp()` sekarang menandai F9-F13 tidak tersedia (bukan diam-diam fallback 50 dianggap nilai sungguhan) kalau `candles.length < 15`.

**Belum dikerjakan** (scope besar, ditandai jujur sebagai follow-up, bukan diklaim selesai):
- **Factor availability/coverage penuh disimpan di `idx_signal_history`** (kolom `factor_availability`, `factor_coverage`, `missing_factors`, `model_version`, `config_version`) lalu dipakai ulang oleh optimizer/paper trading — saat ini optimizer dan paper trading masih memanggil `combineFactorScores(..., availability={})`, menganggap semua faktor selalu tersedia walau data broker aslinya kosong untuk sinyal historis tertentu. Ini perubahan skema + pipeline yang nyata, bukan quick fix.
- **Immutable candidate registry** sebagai tabel DB terpisah (candidate_id, seed, code version, data snapshot, status DRAFT/VALIDATED/dst) — sebagian kebutuhannya sudah tertampung di `awo-challenger.json`, tapi bukan tabel dengan histori multi-kandidat penuh.

## Verifikasi Ronde 2

98 unit test (naik dari 80), semua lolos, termasuk semua test baru untuk ketujuh P0 di atas. `node -c` bersih di semua file. Di-deploy ke VPS, di-restart, dan diverifikasi hidup dengan urutan yang sengaja meniru kondisi nyata: (1) `/run` tanpa `force` → benar-benar kena `COOLDOWN` dengan timestamp akurat (bukti P0-6); (2) `/run?force=1` → kandidat top-ranking ditolak dengan `"out-of-sample expectancy -0.494R is not positive"` (bukti P0-1 hard gate aktif), `optimized.weights` tidak ada key `f14` (bukti fix F14 masih berlaku), `validateTotal` mengecil signifikan dibanding sebelum fix LONG_ONLY (bukti P0-4 aktif); (3) `/api/awo/challenger` tetap `null` yang benar (belum ada kandidat yang lolos semua gate baru — expected, bukan bug).

---
---

# Ronde 3 — Tanggapan atas Review.md versi ketiga (hari yang sama)

Tim review mengirim `Review.md` versi ketiga beberapa jam setelah Ronde 2, kali ini menemukan bug yang **membatalkan makna semua safeguard yang baru saja diperbaiki di Ronde 2**: challenger dibekukan dengan satu pasangan weights+threshold, tapi diverifikasi (expectancy, profit factor, bootstrap, monotonicity) dengan pasangan yang berbeda. Review juga mendalami temuan availability P1 dari Ronde 2 (poin 260 di atas) dan menemukan itu baru setengah jalan — begitu ditelusuri lebih dalam, bug yang sama ternyata terduplikasi mandiri di **dua jalur live-scoring lain** di `server.js` yang sebelumnya tidak disentuh. 11 temuan, semua diverifikasi dulu terhadap kode asli sebelum diperbaiki — semua akurat, dan satu (poin 2) jauh lebih luas cakupannya dari yang dilaporkan.

## 1. 🚨 Kandidat yang divalidasi berbeda dari kandidat yang dibekukan

**Status: Selesai.**

Dikonfirmasi PERSIS: urutan lama di `optimizeWeights()` adalah kandidat weights diuji lolos semua safeguard (expectancy, profit factor, bootstrap significance, monotonicity) memakai `DEFAULT_THRESHOLDS` — BARU SETELAH itu `optimizeThresholds(trainSet, weights)` dipanggil sekali di luar loop untuk kandidat yang menang, dan hasil threshold BARU itu yang ikut dibekukan ke `awo-challenger.json`. Artinya `backtestSummary` yang disimpan menggambarkan `weights + DEFAULT_THRESHOLDS`, sementara `generatePaperTrades()` setiap malam benar-benar mengklasifikasikan sinyal memakai `weights + threshold-hasil-optimasi` — dua kombinasi yang berbeda. Setiap angka yang membuat kandidat itu "lolos" tidak menggambarkan strategi yang benar-benar dites di paper trading.

Diperbaiki persis sesuai opsi B yang disarankan review (evaluasi ulang pasangan final, bukan cuma freeze `DEFAULT_THRESHOLDS`): `optimizeThresholds(trainSet, c.weights)` sekarang dipanggil **di dalam** safeguard walk loop, per-kandidat — dan SETIAP gate sesudahnya (`computeWinRate` untuk validate, bootstrap significance test, monotonicity check) memakai `candidateThresholds` itu, bukan `DEFAULT_THRESHOLDS`. `optimalThresholds` yang akhirnya dibekukan sekarang adalah threshold yang PERSIS sama yang membuat kandidat itu lolos semua gate.

## 2. 🚨 Availability technical factor masih salah — dan ternyata bug ini jauh LEBIH LUAS dari yang dilaporkan

**Status: Selesai.**

Review menduga bug ini ada di satu tempat: `scoreAtTimestamp()`'s `technicalAvailable = candles.length >= 15` memberi status "tersedia" ke F9-F13 sekaligus, padahal kebutuhan data sungguhannya berbeda (RSI 15 bar, Bollinger 20, EMA-trend 21, Support/Resistance 20, MACD 35) — dan `calcTechnicalFactors()` sendiri punya guard blanket `candles.length < 26` yang membuat SEMUA faktor (termasuk RSI yang harusnya sudah bisa dihitung di bar ke-15) dipaksa fallback 50 di bawah 26 candle.

**Ditelusuri lebih dalam, bug yang identik ternyata terduplikasi mandiri di DUA tempat lain di `server.js`** yang tidak disebut review — kemungkinan besar karena keduanya menyalin pola yang sama dari `score_engine.js` sebelum fix P1 Ronde 2:
- `computeStockFactorsLive()` (dipakai endpoint detail per-saham) — pola identik: `if (liveCandles.length >= 15) { ...f9..f13 dari calcTechnicalFactors... }`, lalu objek `availability` yang dikirim ke `combineFactorScores()` sama sekali tidak menyertakan key `f9`-`f13` — artinya fake-50 SELALU dianggap tersedia penuh, tidak pernah dikecualikan.
- **`/api/signal-scanner`** (endpoint utama, yang benar-benar dipakai user tiap hari) — bug yang SAMA PERSIS, di loop utama per-ticker.

Diperbaiki di akar masalahnya, satu tempat, dipakai oleh ketiganya:
- `calcTechnicalFactors()` di `awo_technical.js`: guard blanket `candles.length < 26` dihapus. Setiap `calcX()`/`scoreX()` (RSI, MACD, Bollinger, EMA-trend, Support/Resistance, ATR) sudah punya null-guard sendiri yang jatuh ke 50 dengan aman — jadi cukup biarkan masing-masing mencapai minimum datanya sendiri. Fungsi sekarang juga mengembalikan `factorAvailable: {f9..f14: bool}` yang mencerminkan PERSIS kondisi null-guard yang sama yang dipakai tiap `scoreX()`, bukan tebakan candle-count terpisah.
- `calcTechnicalBatch()`'s guard duplikat terpisah (`candles.length < 10`) dihapus juga — dua guard blanket independen adalah persis bagaimana masalah per-indicator-minimum ini bisa lolos sebelumnya; sekarang cuma ada satu jalur kode.
- Ketiga call site (`modules/score_engine.js`'s `scoreAtTimestamp`, `server.js`'s `computeStockFactorsLive`, `server.js`'s `/api/signal-scanner`) sekarang memanggil `calcTechnicalFactors()` tanpa syarat dan mengirim `tech.factorAvailable.f9`...`f13` ke `combineFactorScores()`, bukan satu flag `technicalAvailable` yang dibagi rata ke semuanya.

Diverifikasi dengan 11 test baru (`test_technical_availability.js`) yang mem-pin batas persis tiap indikator (14 vs 15 bar untuk RSI, 19 vs 20 untuk Bollinger/S-R, 20 vs 21 untuk EMA-trend, 34 vs 35 untuk MACD), plus test integrasi lewat `scoreAtTimestamp` yang membuktikan `missingFactors` sekarang benar-benar parsial (F9 tersedia di 16 candle, F10-F13 tidak) bukan all-or-nothing.

**Bukti langsung dari produksi**: `curl /api/signal-scanner` menunjukkan 101 dari 245 ticker punya `missingFactors: ["f9","f10","f11","f12","f13"]` dengan `factorCoverage: 0.74` (bukan `1.0` yang lama, dan bukan `0` — angka 0.74 itu sendiri buktinya faktor broker/breadth yang masih ada tetap dihitung penuh, cuma faktor teknikal yang benar-benar dikecualikan). Ticker dengan riwayat harga lengkap (mis. SGRO) menunjukkan `missingFactors: []`, `factorCoverage: 1`.

## 3. 🚨 Gate "200 sinyal baru" bukan 20 hari data baru

**Status: Selesai.**

Dikonfirmasi PERSIS: gate `MIN_NEW_SIGNALS_FOR_REOPT = 200` membandingkan `COUNT(*)` baris sinyal, bukan tanggal unik — komentar kode sendiri di atasnya sudah menyebut niatnya "20 trading days ≈ a month," tapi implementasinya memakai asumsi ~10 sinyal/hari yang bisa meleset kalau jumlah saham yang menghasilkan sinyal berubah.

Diperbaiki: `optimizeWeights()` sekarang mengembalikan `uniqueDatesCount` (dihitung dari `uniqueDates.length`, sumber yang sama dipakai untuk train/validate split). Gate di `/api/awo/optimize/run` diganti jadi `SELECT COUNT(DISTINCT data_date)` dibandingkan terhadap `previousRun.uniqueDatesCount`, ambang `MIN_NEW_TRADING_DAYS_FOR_REOPT = 20`. Pendekatannya sedikit lebih sederhana dari saran review (delta jumlah tanggal-unik total, bukan menyimpan `lastEligibleDataDate` lalu filter `data_date > ?`) — secara matematis setara karena tanggal-tanggal lama yang sudah resolved outcome-nya tidak berubah lagi setelah dihitung.

**Bukti langsung dari produksi**: hasil `/run` sekarang menyertakan `uniqueDatesCount: 118` — field ini sebelumnya tidak ada sama sekali di response.

## 5. Model challenger belum benar-benar dibekukan secara formula

**Status: Selesai untuk deteksi + auto-archive; `candidate_id`/`formula_version`/`config_version`/`factor_snapshot` per-trade individual belum (bagian dari item besar yang sama dengan poin 2/4 di bawah).**

Dikonfirmasi: `getOrFreezeChallenger()` hanya mengecek `existing.status === 'PAPER_TESTING'` untuk memutuskan apakah slot terisi — tidak pernah membandingkan `existing.modelVersion` dengan `AWO_MODEL_VERSION` server saat ini. Kalau formula F1-F14 berubah (persis seperti yang terjadi di ronde ini — fix F14-contamination, DEFAULT_WEIGHTS renormalization, candidateKey behavioral-fields) sementara sebuah challenger masih `PAPER_TESTING`, track record lama dan barunya tercampur di bawah satu `candidateKey` yang sama padahal diukur oleh formula yang berbeda.

Diperbaiki: `getOrFreezeChallenger()` sekarang membandingkan `existing.modelVersion !== AWO_MODEL_VERSION` sebelum menganggap slot terisi — kalau beda, challenger lama otomatis diarsipkan (`status: 'REJECTED'`, `rejectedReason: 'STALE_MODEL_VERSION: ...'`) dan slot terbuka untuk challenger baru yang dibekukan di bawah formula saat ini.

## 7. Factor validity masih memakai win-rate logic

**Status: Selesai.**

Dikonfirmasi PERSIS: `factorValidity()`'s `lift` dihitung dari selisih win-rate (0-100) antar grup skor tinggi/rendah, dan `isPredictive` memakai `Math.abs(ic) > 0.05` — faktor yang bekerja TERBALIK dari arah yang dimaksud (skor tinggi → hasil lebih buruk) tetap lolos selama korelasinya kuat, karena magnitude-nya besar meski tandanya negatif.

Diperbaiki persis sesuai kode yang disarankan review: `lift` sekarang selisih EXPECTANCY (netR rata-rata, skala R bukan skala win-rate 0-100) antar grup, dan `isPredictive = lift > MIN_FACTOR_LIFT_R && ic > MIN_FACTOR_IC` — signed, bukan `Math.abs()`.

**Bukti langsung dari produksi**: `/run?force=1` menunjukkan `f10: {lift: -0.199, ic: -0.095, isPredictive: false}` dan `f14: {lift: -0.154, ic: -0.099, isPredictive: false}` — dengan logic LAMA (`Math.abs(ic) > 0.05`), kedua faktor ini (ic-nya sama-sama di atas 0.05 secara magnitude) akan lolos sebagai "predictive" padahal sebenarnya bekerja terbalik. Logic baru menolak keduanya dengan benar. Sebaliknya f9/f11/f13 menunjukkan ic positif dan `isPredictive: true` — bukti positif dan negatif sama-sama terverifikasi hidup, bukan cuma di test sintetis.

## 8. Candidate key memasukkan metric nonbehavioral

**Status: Selesai.**

Dikonfirmasi: `optimizeThresholds()` mengembalikan `strongBuy/buy/watch/neutral/sell` bercampur dengan `winRate/sampleSize/expectancy/profitFactor` dalam satu objek, dan `candidateKeyFromWeights()` meng-hash seluruh objek `thresholds` itu — jadi dua strategi dengan lima threshold behavioral yang identik tapi kebetulan diukur dari sampel riset yang beda akan mendapat candidate key yang berbeda, memecah track record paper trading tanpa alasan yang seharusnya penting.

Diperbaiki persis sesuai saran review: `BEHAVIORAL_THRESHOLD_KEYS = ['strongBuy','buy','watch','neutral','sell']` — `candidateKeyFromWeights()` sekarang cuma meng-hash field-field itu dari objek thresholds, mengabaikan metric riset apa pun yang ikut menumpang di objek yang sama.

Diverifikasi dengan test baru: dua objek thresholds dengan lima field behavioral identik tapi metric riset berbeda (`winRate`, `expectancy`, dst berbeda) menghasilkan candidate key yang SAMA.

## 10. Manual optimizer run tidak membekukan challenger

**Status: Selesai.**

Dikonfirmasi PERSIS: `getOrFreezeChallenger()` hanya dipanggil dari step 5 pipeline cron malam, tidak pernah dari `POST /api/awo/optimize/run` manual. Kalau user menekan tombol manual dan menemukan kandidat eligible, response-nya bilang `eligibleForPromotion: true` dan pesan "POST /promote to adopt it" — padahal `/promote` akan langsung menolak dengan 400 karena tidak ada challenger yang dibekukan sama sekali.

Diperbaiki persis sesuai kedua saran review digabung: field diganti nama `eligibleForPromotion` → `eligibleForChallenger`, DAN `/run` sekarang memanggil `getOrFreezeChallenger()` sendiri saat menemukan kandidat eligible — jalur manual dan jalur cron sekarang berperilaku identik (cron memanggil `/run` lewat HTTP juga, jadi cukup satu tempat yang membekukan; langkah freeze duplikat di step 5 cron dihapus, diganti baca `optResult.challenger` yang sudah dilaporkan `/run`). Pesan response sekarang jujur menyebutkan status sebenarnya: sudah dibekukan sebagai challenger baru, atau ada challenger lain yang sedang paper-testing sehingga TIDAK dibekukan.

**Bukti langsung dari produksi**: `/run?force=1` mengembalikan `eligibleForChallenger: false` (nama field baru, kandidat kali ini memang tidak lolos safeguard) dan `challenger: null` — konsisten, tidak ada challenger yang dibekukan untuk kandidat yang gagal, sesuai desain.

## 11. Default weights masih berjumlah 0.97

**Status: Selesai.**

Dikonfirmasi: `Σ RAW_F1_13_SHARES = 0.97` setelah F14 dihapus dari pembagian eksplisit — secara matematis tidak mengubah composite (`weightedComposite()` membagi dengan total bobot yang tersedia), tapi membingungkan untuk audit/konfigurasi, dan bisa jadi masalah nyata kalau suatu saat ada kode lain yang mengasumsikan `Σweights = 1` tanpa normalisasi ulang.

Diperbaiki: `normalizeToOne()` — men-skalakan proporsional supaya total persis 1.0, plus koreksi drift pembulatan (sisa pembulatan diserap ke elemen pertama) supaya tetap presisi 3 desimal dan tetap PERSIS 1.0, bukan 0.999999 dst.

**Bukti langsung dari produksi**: `node -e` di VPS menghitung ulang `Object.values(DEFAULT_WEIGHTS).reduce((a,b)=>a+b,0)` → `1` persis.

## Temuan lain — sudah tercakup atau di luar cakupan hari ini

- **6. Walk-forward dan locked holdout** — diakui jujur oleh review sendiri sebagai belum selesai (purged rolling walk-forward multi-fold + locked final holdout). Tidak dikerjakan hari ini — perubahan pipeline besar yang sama kelasnya dengan item registry/schema di bawah, bukan tambahan kecil di atas struktur train/purge/validate yang sudah ada.
- **9. Dashboard optimizer 401** — sama persis dengan temuan yang sudah ditandai **Ditunda** di Ronde 1 (lihat "Masalah security dan UI" di atas). Masih terbuka, masih perlu keputusan arsitektur (proxy route server-side vs. admin console terpisah) yang belum diambil sepihak.

**Belum dikerjakan** (poin 2/4/5 review menunjuk ke satu item besar yang sama, ditandai jujur sebagai follow-up):
- **Factor availability/coverage/model-version penuh disimpan per-sinyal di `idx_signal_history`** (`factor_availability`, `factor_coverage`, `missing_factors`, `model_version`, `config_version`, `formula_version`) lalu dipakai ulang oleh `awo_optimizer.js`'s `rescoreSignal()` dan `modules/paper_trading.js`'s `generatePaperTrades()` — keduanya masih memanggil `combineFactorScores(..., availability={})` karena keduanya bekerja dari kolom F1-F13 yang SUDAH TERSIMPAN di `idx_signal_history`, dan kolom itu tidak (belum) menyimpan apakah nilai yang tersimpan itu real atau fallback-50 saat sinyal itu pertama kali dikumpulkan. Perbaikan akar (poin 2 di atas) membuat live-scoring sekarang menghitung `factorAvailable` dengan benar — tapi menyalurkan info itu ke riwayat/backtest butuh migrasi skema + keputusan backfill untuk baris historis yang sudah ada (yang, dengan guard <26 lama, tidak pernah mencatat perbedaan real-vs-fallback sama sekali — tidak ada cara mundur untuk tahu yang mana). Bukan quick fix, sengaja tidak dipaksakan hari ini.

## Verifikasi Ronde 3

113 unit test total (naik dari 98) — 11 di antaranya baru (`test_technical_availability.js`), sisanya diperluas 3 test baru untuk `factorValidity` di `test_optimizer_fixes.js`. Semua lolos, lokal maupun di VPS. `node -c` bersih di semua file yang diubah (`server.js`, `awo_optimizer.js`, `awo_technical.js`, `modules/score_engine.js`, `test_optimizer_fixes.js`, `test_technical_availability.js`). Backup file lama disimpan di `/root/backups/2026-07-31-round3/` sebelum overwrite. Di-deploy, di-restart (PM2 online, tanpa crash-loop, log startup bersih), dan diverifikasi hidup:

1. `/api/signal-scanner` — 101/245 ticker menunjukkan `missingFactors` teknikal yang benar (bukti poin 2), ticker dengan riwayat lengkap `factorCoverage: 1`.
2. `DEFAULT_WEIGHTS` di VPS menjumlah persis `1` (bukti poin 11).
3. `/api/awo/optimize/run` tanpa `force` → `COOLDOWN` (kondisi cooldown 24 jam belum lewat — sekitar 3 jam lagi saat verifikasi ini dijalankan).
4. `/api/awo/optimize/run?force=1` (sekali, untuk menguji ujung-ke-ujung poin 1/3/7/10 yang tidak bisa diuji lewat unit test) → `uniqueDatesCount: 118` muncul di response (bukti poin 3), `eligibleForChallenger: false` dengan field baru dipakai benar (bukti poin 10), `factorValidity` menunjukkan ic bertanda dengan benar menolak f10/f14 yang berkorelasi terbalik (bukti poin 7), dan `challenger` tetap `null` setelahnya — konsisten, tidak ada kandidat yang lolos jadi tidak ada yang dibekukan.
5. `/api/awo/challenger` — `null` bersih, tidak ada sisa state dari verifikasi run di atas.

**Temuan sampingan yang jujur perlu disebut** (bukan bug kode, tapi hasil nyata dari `/run?force=1` di atas): bobot LIVE saat ini (`baseline`, yang identik dengan `DEFAULT_WEIGHTS`, karena belum pernah ada kandidat yang dipromosikan) menunjukkan `validateExpectancy: -0.334R`, `validateProfitFactor: 0.45` pada split validasi hari ini (`validateTotal: 91` sinyal). Sampel ini kecil dan satu potongan waktu tertentu, jadi bukan kesimpulan definitif — tapi konsisten dengan catatan "AWO belum terbukti punya edge" yang sudah ada di `BACKTEST_EXPERIMENTS.md` sejak EXP-001, dan sekarang diukur dengan safeguard yang jauh lebih ketat dari sebelumnya.
