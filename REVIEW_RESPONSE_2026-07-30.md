# Tanggapan atas Review.md — Perbaikan yang Sudah Diterapkan (2026-07-30)

Dokumen ini merangkum tindak lanjut atas review yang diberikan (`Review.md`). Setiap klaim di review tersebut diverifikasi dulu terhadap kode asli sebelum diperbaiki (bukan langsung dipercaya) — beberapa ternyata lebih parah dari yang dituliskan, satu ditemukan di luar cakupan review dan sengaja belum disentuh (lihat bagian akhir).

Status per item mengikuti struktur P0 di `Review.md`. **Selesai** = diperbaiki, di-deploy ke production, dan diverifikasi hidup. **Sebagian** = akar masalah teknis diperbaiki, tapi cakupan penuh yang diminta review belum selesai semua. **Ditunda** = sengaja belum dikerjakan, dengan alasan eksplisit.

---

## P0-1. Bekukan optimizer dan sinyal production

**Status: Sebagian — diperkuat lebih jauh di iterasi lanjutan (lihat item #12 di bawah).**

- Selesai: endpoint optimizer tidak lagi otomatis mengadopsi bobot baru. Awalnya cuma dikunci dengan parameter `?confirm=1`; sejak iterasi lanjutan, "menghitung kandidat" dan "mengadopsi ke live scoring" adalah dua **endpoint terpisah** (`POST /api/awo/optimize/run` vs `POST /api/awo/optimize/promote`) — lihat item #12.
- Belum: labeling formal "AWO signal = RESEARCH ONLY" di level UI/response, dan flag eksplisit "Real money recommendation = DISABLED" belum diterapkan. Saat ini penguncian baru di level teknis (siapa/endpoint mana yang bisa memicu perubahan bobot), bukan di level kebijakan/tampilan.

## P0-2. Satu fungsi scoring sebagai single source of truth

**Status: Selesai.**

- `scoreAtTimestamp()` dan `combineFactorScores()` sekarang ada sebagai satu modul tunggal (`modules/score_engine.js`) — lihat item #7 di bagian lanjutan untuk detail dan bukti paritas (`test_score_parity.js`).
- Live scanner (`server.js`) dan optimizer (`awo_optimizer.js`) sekarang memanggil fungsi kombinasi yang sama persis ini, bukan implementasi terpisah masing-masing.

## P0-3. Perbaiki bug MACD

**Status: Selesai.**

`calcMACD()` sebelumnya menginisialisasi fast EMA dari bar ke-`fast-1`, lalu loop-nya langsung lompat ke bar `slow` tanpa memproses bar-bar di antaranya secara rekursif — persis seperti yang dilaporkan review, dan ternyata dampaknya lebih besar dari dugaan: diverifikasi numerik menghasilkan **pembalikan tanda (sign flip)** pada histogram di data sintetis, bukan sekadar pergeseran kecil.

Diperbaiki dengan membangun EMA series penuh untuk fast dan slow secara independen, baru diambil selisihnya di titik yang selaras — sesuai saran review. Diverifikasi terhadap implementasi referensi independen yang ditulis terpisah dari kode aslinya (5/5 test lolos, `test_macd_fix.js`).

**Dampak pada hasil backtest**: karena semua backtest sebelumnya (termasuk factor ablation) memakai kalkulasi MACD yang buggy, hasil ablation untuk F10 sempat ditandai tidak dapat dipercaya. Sudah dijalankan ulang setelah fix di-deploy — hasilnya **konfirmasi**, bukan berubah (peringkat F10 identik sebelum dan sesudah perbaikan).

## P0-4. Tulis ulang optimizer agar konsisten dengan live engine

**Status: Selesai untuk 3 masalah yang ditemukan, lalu diperdalam lebih jauh (lihat item #9/#10).**

- F14 sebelumnya dijumlahkan langsung sebagai faktor directional ke-14 di `rescoreSignal()` — tidak konsisten dengan live engine yang sudah memperlakukannya sebagai risk modifier. Sekarang memakai fungsi yang sama persis (lihat P0-2).
- Pola `Number(signal.f1_concentration || 50)` yang mengubah skor sah bernilai 0 menjadi 50 — diganti `??` di semua titik pemakaian.
- Outcome WIN/LOSS: awalnya diperbaiki dari "baca label lama yang dihitung untuk arah sinyal ASLI" menjadi "hitung ulang dari `return_5d` sesuai arah yang diklasifikasikan kandidat bobot yang sedang diuji". Iterasi lanjutan (item #9/#10) mengganti pendekatan `return_5d` ini sepenuhnya dengan simulasi trade nyata (T+1 open entry, stop/target ATR/SR, fee+slippage) — lihat detail di bagian lanjutan.

Ketiganya (plus rewrite outcome di item #9/#10) diverifikasi dengan test terpisah (`test_optimizer_fixes.js`), termasuk kasus spesifik yang disebut di review (sinyal SELL lama yang turun harga, dicap WIN, lalu direklasifikasi jadi BUY oleh bobot baru — sekarang benar tercatat LOSS untuk kandidat tersebut, bukan ikut label lama).

## P0-5. Regime harus menjadi gate, bukan badge

**Status: Ditunda — keputusan sadar, bukan terlewat.**

`detectPriceRegime` sengaja dibangun sebagai badge informasional (2026-07-29), persis karena replikasi dari pengalaman sebelumnya: sebuah hard-gate (Counter-trend) pernah diadopsi dari satu kali hasil backtest, dipakai live, lalu harus dicabut setelah re-backtest dengan formula yang sudah diperbaiki menunjukkan gate tersebut tidak lagi valid. Menjadikan regime sebagai gate sekarang — sebelum ada backtest yang membuktikan gate tersebut benar-benar menambah value — berisiko mengulang kesalahan yang sama persis. Rekomendasi ini akan dipertimbangkan ulang setelah ada validasi empiris, bukan diterapkan langsung dari rekomendasi review.

## P0-6. Hapus credential dari source

**Status: Sebagian — pembersihan source selesai, rotasi password ditunda.**

- Selesai: ditemukan (lebih luas dari laporan review) — 4 secret hardcoded (DB password, `INDEX_ALPHA_KEY`, `FT_KEY`, `JWT_SECRET`) tersebar di **43 file** (JS, Python, shell). Semua sudah dipindah ke environment variable (`.env`, dengan `.env.example` sebagai template, tanpa nilai literal apa pun tersisa di source). Diverifikasi dengan pencarian ulang di seluruh project: nol kecocokan tersisa.
- Ditunda: rotasi nilai password/key yang sebenarnya. Password database yang dipakai **dipakai bersama oleh beberapa aplikasi produksi lain** di server yang sama (bukan eksklusif milik proyek ini) — mengganti nilainya tanpa mengoordinasikan seluruh aplikasi tersebut secara bersamaan berisiko mematikan layanan lain. Ini keputusan yang perlu koordinasi lebih luas, bukan hal teknis semata.
- Secret manager untuk deployment dan audit repository history belum diterapkan — proyek ini tidak memakai version control, jadi "audit repository history" tidak berlaku secara langsung dalam bentuknya di review, tapi risiko yang sama (secret pernah ada di backup/arsip) tetap berlaku dan dianggap sudah ter-expose.

## P0-7. Proteksi backend API

**Status: Sebagian — mitigasi minimal, bukan solusi penuh.**

- Selesai: endpoint sensitif (`/api/awo/optimize`, `/api/awo/reset`, `/api/scrape`, `/api/cron/run`, seluruh `/api/admin/*`) sekarang mewajibkan header `x-admin-key` yang dicocokkan ke API key baru yang di-generate khusus untuk ini. Diverifikasi hidup: permintaan tanpa key atau dengan key salah keduanya ditolak (401), permintaan lain yang tidak sensitif tidak terganggu.
- Belum: role-based access control (VIEWER/TRADER/RESEARCHER/ADMIN), rate limiting, CORS allowlist, audit log terstruktur, dan CSRF protection — semuanya belum diterapkan. Yang sudah ada baru menutup risiko akut (akses anonim dari internet ke endpoint yang mengubah state), bukan implementasi keamanan penuh sesuai permintaan review.

---

## P1, P2, P3 (setup-first, halaman Trade Decision, validasi bertahap, dll.)

Belum disentuh pada iterasi ini — di luar cakupan permintaan perbaikan kali ini, dan beberapa (setup Trend Pullback, validasi bertahap technical-only → broker-filter) sudah lebih dulu ditunda secara sadar berdasarkan diskusi terpisah sebelumnya, dengan alasan yang sama: butuh validasi empiris sebelum diimplementasikan.

## Temuan tambahan di luar cakupan review — awalnya ditunda, sekarang selesai

Saat membersihkan credential, ditemukan satu password akun flowtracker.id (`FT_PASS`) yang juga hardcoded di source — bukan salah satu dari 4 secret yang menjadi fokus review ini. Awalnya sengaja dibiarkan dan dicatat sebagai temuan terpisah (bukan langsung "diperbaiki" tanpa persetujuan, karena keputusan mengganti credential akun adalah keputusan pemilik proyek). **Update: pemilik proyek secara eksplisit menginstruksikan agar ini juga dikeluarkan dari source.** Selesai — `FT_PASS` di `server.js` dan `test-ft-login.js` sekarang dibaca dari `process.env.FT_PASS` (nilai asli, bukan rotasi), ditambahkan ke `.env` VPS dan `.env.example`, di-deploy, dan diverifikasi: login FT.id masih berhasil mendapat JWT dengan nilai dari env var (`{"success":true,...,"ftError":"No data. JWT: yes...` — kegagalan pull data konten adalah masalah lain yang sudah ada sebelumnya, tidak terkait perubahan ini).

---

## Tindak lanjut dari tim review (2026-07-30, lanjutan) — poin 7-12

### 7. Implementasikan `scoreAtTimestamp()`

**Status: Selesai.** Modul baru `modules/score_engine.js` berisi `scoreAtTimestamp({ symbol, timestamp, marketData, brokerData, weights, thresholds, modelVersion, configVersion })` — fungsi murni (tanpa akses DB) yang menghitung F1-F14 dari candle/broker data mentah lalu memanggil `combineFactorScores()`, sama persis dengan urutan yang dipakai live scanner. Bentuk output mengikuti spesifikasi Review.md persis: `regime`, `eligibleSetup` (sengaja `null` — Setup Library belum dibangun, ditunda terpisah), `factorScores`, `factorAvailability`, `factorCoverage`, `missingFactors`, `directionalScore`, `confidence`, `riskModifier`, `finalScore`, `decision`, `reasonCodes`, `modelVersion`, `configVersion`.

Migrasi pemakai: `awo_optimizer.js` (`rescoreSignal`) dan `server.js` (loop utama `/api/signal-scanner` serta `computeStockFactorsLive`) sudah memakai `combineFactorScores()` dari modul ini. **Belum dimigrasi** (keputusan sadar, bukan terlewat): `computeIHSGFactors`/`computeSP500Factors`/`computeUSStockFactors` — model IHSG/US pakai 6-8 faktor tanpa broker data, arsitekturnya beda, dan `regenerate_signal_history.js`/script backtest lain punya wrapper simulasi trade sendiri yang sudah divalidasi terpisah sepanjang sesi ini; memigrasikannya sekarang berisiko mengganggu hasil backtest yang sudah tervalidasi tanpa kebutuhan mendesak.

### 8. Tambahkan live/backtest/optimizer parity tests

**Status: Selesai.** `test_score_parity.js` (5 test): `rescoreSignal` (optimizer) menghasilkan skor identik dengan `combineFactorScores` langsung — satu kasus tetap + 20 percobaan acak; `scoreAtTimestamp` tetap netral untuk input netral dan bentuk output-nya cocok persis spesifikasi; batas threshold `classifySignal` benar. Semua lolos — secara struktural sekarang **tidak mungkin** optimizer dan live scanner drift lagi seperti kasus F14 kemarin, karena keduanya memanggil fungsi kombinasi yang sama, bukan salinan masing-masing.

### 9 & 10. Ganti outcome optimizer dari `return_5d` ke future-path evaluation; masukkan Open T+1, stop, target, fee, slippage

**Status: Selesai.** Fungsi baru `evaluateCandidateOutcome({ signalType, candles, signalIdx })` di `awo_optimizer.js` mensimulasikan trade nyata: entry di **open T+1** (bukan harga saat sinyal, menghindari lookahead), stop/target dihitung dari ATR/SR memakai `computeTradePlan()` yang sama persis dipakai live — bukan cutoff `return_5d` yang sederhana. Ambiguitas same-bar (stop dan target sama-sama kena di hari yang sama) diselesaikan ke arah STOP (konservatif). Biaya transaksi (fee beli 0.15% + fee jual 0.25% + slippage 0.10% = 0.50% round-trip, dilabeli sebagai **asumsi**, bukan jadwal komisi broker riil yang dikonfirmasi) dikurangkan dari hasil bersih. Holding period dibatasi 15 hari bursa; jika tidak kena stop/target dalam window itu, keluar di harga close hari terakhir (`TIME_EXIT`).

Untuk performa: `attachTradeOutcomes(pool, signals)` menghitung **kedua** kemungkinan hasil (seandainya BUY, seandainya SELL) untuk setiap sinyal **satu kali saja**, sebelum loop pencarian 3000 kandidat bobot berjalan — bukan dihitung ulang per kandidat (yang akan menjadi ~3000× lebih lambat untuk hasil yang sama, karena simulasi walk-forward tidak bergantung pada kandidat bobot mana yang menghasilkan arah tersebut, hanya pada arah itu sendiri). `computeWinRate()` dan `optimizeThresholds()` sekarang membaca hasil precomputed ini (`_bullishOutcome`/`_bearishOutcome`), bukan `return_5d`.

Diverifikasi dengan 4 test baru di `test_optimizer_fixes.js` yang membangun candle sintetis dengan harga stop/target yang diketahui persis, lalu memverifikasi angka `netR` secara eksak (termasuk pengurangan fee+slippage) — bukan cuma cek tanda WIN/LOSS. Dijalankan juga langsung di data production (11.695 sinyal, 3000 kandidat, ~17 detik) tanpa error.

### 11. Invalidasi dan rerun semua eksperimen terdampak MACD

**Status: Selesai.** Lihat P0-3 di atas — EXP-002, EXP-003, EXP-004, dan factor ablation (EXP-005/006) semua dijalankan ulang dengan `calcMACD` yang sudah diperbaiki, dicatat sebagai EXP-007 di `BACKTEST_EXPERIMENTS.md`. Kesimpulan tidak berubah (F10/MACD tetap di peringkat yang sama, faktor broker F6/F7 tetap yang paling merugikan).

### 12. Pisahkan optimizer run dan model promotion endpoint

**Status: Selesai.** `POST /api/awo/optimize` (yang tadinya satu endpoint dengan flag `?confirm=1`) dipecah jadi dua:

- **`POST /api/awo/optimize/run`** — riset saja. Menjalankan optimizer, menyimpan hasil ke file, **tidak pernah** menyentuh bobot live. Melaporkan `eligibleForPromotion: true/false`.
- **`POST /api/awo/optimize/promote`** — HANYA mengadopsi kandidat yang sudah tersimpan dari `/run` terakhir. Menolak (400) jika belum ada run, jika kandidat terakhir tidak lolos semua safety check, atau jika run sudah pernah dipromosikan sebelumnya (409, mencegah dobel-log ke DB). Menolak juga (409) jika run terakhir lebih dari 24 jam — mencegah promosi kandidat basi yang divalidasi terhadap kondisi pasar yang mungkin sudah berubah. **Tidak pernah menerima bobot dari request body** — satu-satunya sumber kebenaran adalah file hasil `/run` yang sudah lolos safeguard statistik.

Efek samping yang ditemukan dan diperbaiki di jalur yang sama: cron malam (pipeline pembelajaran otonom) memanggil endpoint ini secara internal via HTTP loopback **tanpa** header `x-admin-key` — begitu proteksi admin-key P0-7 di atas aktif, panggilan internal ini akan mulai gagal senyap (401) setiap malam tanpa terlihat di UI manapun. Diperbaiki dengan menambahkan header `x-admin-key` (dari `process.env.ADMIN_API_KEY` milik proses yang sama) ke panggilan internal tersebut, dan mengarahkannya ke `/run` (bukan endpoint gabungan lama) — pipeline otonom tetap murni riset, tidak pernah memanggil `/promote` sendiri.

**Belum**: dashboard frontend (`app/awo-dashboard/page.tsx`) memanggil `/api/awo/optimize/run` langsung dari browser tanpa header admin-key sama sekali — tombol "Run Optimizer" akan mengalami 401 begitu proteksi P0-7 aktif di production. Ini bukan regresi dari perubahan hari ini (gap yang sama sudah ada sejak P0-7 diterapkan), tapi butuh keputusan arsitektur (proxy route sisi-server yang menyimpan key, vs mekanisme lain) yang sengaja belum diputuskan sepihak di sini — dicatat sebagai temuan terbuka.

---

## P1 — Validasi empiris (poin 13-18)

### 13. Jalankan regime gate dalam shadow mode

**Status: Selesai.** `detectPriceRegime()` (dibangun 2026-07-29) sengaja hanya badge informasional, bukan gate — dokumentasi modulnya sendiri meminta langkah ini persis: "surface it, watch it against real outcomes, only promote it to something that filters/sizes signals once it's been validated." Fungsi baru `regimeGateVerdict(signalType, regime)` di `modules/regime_engine.js` menghitung apa yang AKAN diputuskan sebuah gate counter-trend (blok BUY saat TREND_DOWN, blok SELL saat TREND_UP, blok apa pun saat HIGH_VOLATILITY) — tanpa pernah benar-benar memblokir sinyal apa pun.

Dijalankan di dua jalur:
- **Live, berkelanjutan**: setiap panggilan `/api/signal-scanner` sekarang menghitung dan mengekspos `regimeGateShadow: {wouldBlock, reason}` di response, dan menyimpannya ke `idx_signal_history` (kolom baru `price_regime_at_signal`, `regime_gate_would_block`, `regime_gate_reason`) — murni untuk analisis nanti, tidak pernah memengaruhi sinyal yang sebenarnya.
- **Retroaktif, sekali jalan**: `scraper/backtest_regime_gate_shadow.js` menghitung ulang regime historis (tanpa lookahead) untuk 233 sinyal directional AWO Full di window yang sama dengan EXP-001-007, dicocokkan dengan outcome trade nyata via `evaluateCandidateOutcome`. Dicatat sebagai EXP-2026-07-30-008 di `BACKTEST_EXPERIMENTS.md`.

**Temuan jujur, bukan yang menyenangkan**: angka pooled awal terlihat mendukung gate (BLOCK jauh lebih buruk dari ALLOW), tapi setelah dipecah per regime, ternyata 84% dari trade "BLOCK" adalah HIGH_VOLATILITY (hipotesis BERBEDA dari counter-trend) — begitu diisolasi, bukti counter-trend murni jadi bercampur dan sampel kecil (n=4 dan n=6), bahkan salah satu arah (TREND_UP) menunjukkan hasil BERLAWANAN dari hipotesis. Ditulis dengan sengaja secara jujur, bukan headline yang menyesatkan — persis pelajaran dari Counter-trend gate yang pernah dicabut karena kesimpulan awal terlalu disederhanakan. **Tidak ada gate yang diaktifkan oleh eksperimen ini.**

### 14. Buat experiment registry

**Status: Sudah selesai sebelumnya, bukan pekerjaan baru.** `BACKTEST_EXPERIMENTS.md` (root proyek) sudah ada dan berjalan sejak sesi sebelumnya — permanent, append-only, sekarang berisi EXP-001 sampai EXP-008.

### 15. Jalankan baseline comparison

**Status: Sudah selesai sebelumnya.** EXP-2026-07-29-001/002 (AWO Full vs EMA crossover vs Random Entry vs Buy&Hold vs IHSG, dua desain exit-rule berbeda), dikonfirmasi ulang post-MACD-fix sebagai EXP-007.

### 16. Jalankan factor ablation ulang

**Status: Sudah selesai sebelumnya.** EXP-2026-07-30-005 (per-faktor F1-F13 + Risk Modifier), dijalankan ulang post-MACD-fix sebagai EXP-006 — kesimpulan tidak berubah.

### 17. Lakukan walk-forward dan parameter sensitivity

**Status: Sudah selesai sebelumnya.** Walk-forward = EXP-2026-07-30-004 (split Period 1 vs Period 2, AWO Full tetap terburuk di keduanya). Parameter sensitivity = EXP-2026-07-29-003 (sweep Stop-Loss × Holding-Time, 63 kombinasi, semua negatif).

### 18. Jalankan paper trading sebelum model promotion

**Status: Infrastruktur selesai dan sudah live; track record sungguhan baru mulai terkumpul mulai hari ini — tidak bisa dipalsukan mempercepat waktu kalender.**

Modul baru `modules/paper_trading.js` + tabel `awo_paper_trades`:
- **`generatePaperTrades`**: setiap kali sebuah kandidat dari `/run` lolos semua safeguard (`eligibleForPromotion`), sinyal hari itu di-score ULANG dengan bobot KANDIDAT (bukan bobot live) dan dicatat sebagai paper trade — entry price sengaja belum diisi (menunggu open T+1 sungguhan, sama seperti seluruh sistem ini).
- **`resolvePaperTrades`**: dijalankan setiap cron malam, memajukan setiap paper trade yang masih terbuka memakai harga real yang SUDAH benar-benar tersedia — tidak pernah melompati waktu.
- **`candidateKeyFromWeights`**: kandidat diidentifikasi lewat hash dari bobotnya sendiri (bukan timestamp run), supaya kandidat yang sama yang terus ditemukan tiap hari mengumpulkan SATU track record berkelanjutan, bukan direset tiap kali `/run` menulis ulang file hasil.
- **Gate baru di `/api/awo/optimize/promote`**: menolak promosi (409) kecuali sudah ada minimal 10 paper trade yang resolved DAN minimal 7 hari kalender sejak kandidat ini pertama kali eligible. Angka ini kira-kira meniru orde besar `MIN_DIRECTIONAL_VALIDATE` yang sudah ada, bukan hasil derivasi formal.
- **`GET /api/awo/paper-trades`** baru — visibilitas penuh ke track record kandidat saat ini, termasuk `eligibleForPromotionNow`.

Diverifikasi: 9 unit test untuk logika resolusi trade murni (`walkForwardResolve`) dan identitas kandidat (`candidateKeyFromWeights`), tabel `awo_paper_trades` berhasil dibuat di production, `GET /api/awo/paper-trades` dan `POST /api/awo/optimize/promote` diverifikasi hidup — keduanya benar menolak karena belum ada kandidat yang eligible hari ini (sesuai kondisi nyata, bukan bug).

**Jujur soal batasannya**: gate ini akan menolak SETIAP kandidat hari ini, dengan sengaja — itulah inti dari permintaan ini. Track record sungguhan baru mulai terkumpul dari kandidat eligible PERTAMA yang ditemukan, dan makan waktu kalender sungguhan (bukan sesuatu yang bisa "diselesaikan" dalam satu sesi kerja).

---

## Temuan tambahan saat verifikasi deploy — bug produksi lama, tidak terkait review ini

Sambil memantau cron 19:30 WIB malam ini untuk memverifikasi deploy di atas, ditemukan bug produksi nyata yang sudah ada sebelumnya (bukan disebabkan perubahan hari ini): `updateRecommendationStatuses()` di `server.js` dideklarasikan DI DALAM `async function main()`, sementara dipanggil dari `scheduleDailyCron()` — fungsi lain yang terpisah, di LUAR scope `main()`. Karena hoisting deklarasi fungsi JS hanya berlaku sampai scope terdekatnya sendiri, pemanggilan ini melempar `ReferenceError` sungguhan dan meng-crash seluruh proses PM2 tepat saat cron malam ini terpicu — sebelum sempat menjalankan scraping atau pipeline AWO sama sekali malam ini.

Akar masalah dikonfirmasi dengan reproduksi minimal yang meniru struktur asli persis (bukan tebakan), diperbaiki dengan memindahkan deklarasi fungsi tersebut ke scope top-level yang sesungguhnya, di-deploy ulang, dan diverifikasi: proses tidak crash lagi pada siklus berikutnya, dan endpoint lain yang memanggil fungsi yang sama (`POST /api/recommendations/update-statuses`) tetap berhasil terhadap database production nyata. Detail lengkap ada di memory sesi ini (`project-scheduledailycron-scope-bug-2026-07-30`), dicatat terpisah karena bukan bagian dari permintaan review ini — ditemukan murni karena kebetulan sedang memantau server tepat saat cron terpicu.

## Verifikasi

Setiap perbaikan di atas diuji dengan unit test otomatis sebelum di-deploy (`npm test` di scraper: 63 test, semua lolos), disyntax-check di server (`node -c` / `py_compile`, semua lolos), dan diverifikasi langsung di endpoint live setelah restart: `/api/health` OK, `/api/awo/optimize/run` menolak tanpa key (401) dan berjalan penuh dengan key yang benar (3000 kandidat, ~17 detik, tidak mengubah bobot live), `/api/awo/optimize/promote` menolak dengan benar saat tidak ada kandidat yang lolos safeguard, endpoint gabungan lama (`/api/awo/optimize`) sudah tidak ada (404) menandakan split benar-benar berlaku, `/api/signal-scanner` tetap menghasilkan skor via `combineFactorScores()` yang baru tanpa regresi (termasuk field baru `regimeGateShadow`), tabel `awo_paper_trades` berhasil dibuat, dan `GET /api/awo/paper-trades` mengembalikan struktur yang benar.
