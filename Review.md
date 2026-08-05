V2 sudah layak untuk shadow operation, tetapi belum gue anggap authoritative track record karena masih ada tiga blocker operasional/data-integrity.

Yang sudah beres
Temuan sebelumnya	Status
Strategy A dan B berbagi modal	✅
Phantom weekend menjadi entry date	✅
Retained ticker dibeli berulang	✅
Per-ticker cap tidak aggregate	✅
Sizing memakai NAV kemarin	✅
Gap-through-stop fill terlalu bagus	✅
ATR berbeda dari sistem utama	✅
Order dieksekusi berdasarkan alfabet	✅
Missing ticker dianggap no-fill	✅
Retiring account langsung hilang	✅
Mark dan account NAV tidak atomic	✅
Counter bertambah sebelum commit	✅
Scheduled event tidak punya order ID	✅
Strategy isolation sudah benar

Account sekarang memiliki strategy_hash, dan unique identity sudah mencakup strategy, strategy hash, account code, serta execution policy. Strategy hash baru menghasilkan account Rp100 juta baru, bukan melanjutkan NAV lama.

Kalender perdagangan sudah benar di code

loadBars() sekarang menggunakan idx_ihsg_history sebagai session calendar dan membuang price rows di luar kalender tersebut. Weekend atau public-holiday phantom tidak lagi bisa menjadi T+1 entry atau holding bar.

Retained ticker dan prioritas target

Ticker yang masih open tidak dibuatkan order baru. target_rank juga disimpan, dan fill diproses berdasarkan rank rekomendasi—bukan urutan alfabet.

Sizing sekarang memakai kondisi opening

Sebelum setiap fill, engine menghitung ulang:

opening NAV = cash + market value seluruh holding pada opening price

Gross exposure dan ticker exposure juga memakai opening market value, bukan cost basis.

Gap execution sudah realistis

Gap turun melewati stop sekarang exit pada open, bukan harga stop yang sudah tidak dapat diperdagangkan. Missing high atau low juga tidak lagi dianggap sebagai quiet bar.

Risk layer sudah satu sumber

Virtual broker sekarang mengambil horizon dan risk geometry dari trade_policy.js, serta ATR dari awo_technical.calcATR(). Versi execution contract juga dinaikkan ke 2.

Testing bertambah signifikan

Integration test sekarang mengunci session calendar, retained ticker, target rank, strategy-hash mismatch, retiring account, NAV/account consistency, serta corruption detection. Test virtual broker dan database lifecycle juga masuk ke command test resmi.

P0.1 — Urutan cron sekarang bertentangan dengan kalender baru

Ini blocker paling konkret.

Code sekarang membutuhkan idx_ihsg_history sudah memiliki sesi hari ini sebelum resolve. Namun dokumentasi cron masih menunjukkan:

20:00  virtual_portfolio.js resolve
20:10  refresh_ihsg.js

Karena loadBars() memakai IHSG sebagai date axis, pada pukul 20:00 sesi hari ini kemungkinan belum terlihat.

Skenarionya:

Senin 20:30  order dijadwalkan
Selasa 19:30 price Selasa masuk
Selasa 20:00 resolve berjalan
Selasa belum ada di kalender IHSG
→ order tidak di-fill

Selasa 20:10 IHSG baru diperbarui
Selasa 20:35 NAV ditandai tanpa posisi tersebut

Rabu 20:00 order baru diproses secara retrospektif
dengan entry_date Selasa

Hasilnya:

trade diproses terlambat satu malam;
NAV Selasa tidak mencerminkan trade yang seharusnya aktif Selasa;
realized P&L intraday Selasa baru muncul di account pada Rabu;
historical NAV tidak direstate.
Perbaikan

Urutan minimal:

19:30  price pull selesai
20:05  refresh IHSG
20:10  virtual resolve
20:15  strategy forward fill
20:20  strategy plan
20:25  strategy mark
20:30  virtual schedule
20:35  virtual mark
20:40  reconcile

Lebih aman lagi, cmdResolve() harus menolak berjalan bila:

latest IHSG session < latest valid price session

Jangan hanya mengandalkan cron timing. Return non-zero dengan alasan:

SESSION_CALENDAR_STALE

Catatan: gue hanya dapat memeriksa CRONTAB.md, bukan live crontab VPS. Kalau VPS sudah diubah tetapi dokumentasinya belum, dokumentasinya perlu disinkronkan.

P0.2 — Missing exit bar masih dilewati, lalu engine membaca hari berikutnya

resolveBar() sudah benar mengembalikan:

open = true
unpriced = true

atau:

open = true
dataIncomplete = true

untuk bar yang hilang atau tidak lengkap.

Namun orchestration melakukan:

if (r.open) continue;

Artinya engine lanjut ke sesi berikutnya.

Ini tidak aman.

Contoh:

Hari 1  position open
Hari 2  high/low hilang
        sebenarnya mungkin menyentuh stop
Hari 3  harga naik dan menyentuh target

Engine saat ini bisa mencatat TARGET pada hari 3, padahal posisi mungkin sudah stop pada hari 2.

Untuk INTRADAY_EOD, dampaknya lebih jelas:

Entry-day bar incomplete
→ posisi tidak EOD_CLOSE
→ engine lanjut ke hari berikutnya
→ trade intraday berubah menjadi multi-day trade
Perbaikan

Saat menemukan missing/incomplete session setelah entry:

if (r.unpriced || r.dataIncomplete) {
  log DATA_BLOCKED;
  break;
}

Bukan continue.

Position harus menunggu session tersebut diperbaiki sebelum membaca sesi setelahnya.

Tambahkan state atau event:

PRICE_HISTORY_BLOCKED
DATA_INCOMPLETE_EXIT_BAR

Account tersebut juga harus diberi:

NAV_DEGRADED
performance_eligible = false

sampai gap data selesai.

Unit test saat ini membuktikan pure resolver mengembalikan dataIncomplete, tetapi belum menguji bahwa lifecycle berhenti dan tidak melompat ke candle berikutnya.

P0.3 — Retiring execution contract masih dapat mencampur v1 dan v2

RETIRING sekarang diproses oleh cmdResolve(), yang memang diperlukan agar open positions tidak hilang. Namun ini menimbulkan masalah versioning lain.

Retirement menganggap account masih sibuk jika ada posisi open atau order berstatus SCHEDULED.

Lalu cmdResolve() memproses account RETIRING dan order:

SCHEDULED
DATA_PENDING

menggunakan implementation code yang sedang berjalan.

Skenario deployment v1 → v2:

Order dibuat saat v1
Belum fill
Code v2 dideploy
Account v1 menjadi RETIRING
Order v1 tetap di-fill menggunakan resolver v2

config_json memang menyimpan angka lama, tetapi tidak menyimpan implementation lama:

gap handling berubah;
opening NAV logic berubah;
missing-bar handling berubah;
aggregate exposure logic berubah.

Jadi hasilnya dicatat sebagai account v1, tetapi dieksekusi oleh algorithm v2.

Selain itu, retirement menghitung pending hanya dari status='SCHEDULED', bukan DATA_PENDING. Account dengan satu DATA_PENDING dan tanpa posisi open dapat berubah menjadi CLOSED, membuat order tersebut tidak pernah diperiksa lagi.

Solusi aman

Saat contract atau strategy berubah:

SCHEDULED / DATA_PENDING
→ CANCELLED
→ reason POLICY_CHANGE atau STRATEGY_CHANGE

Untuk posisi yang sudah open, pilih satu:

dispatch resolver berdasarkan config.version; atau
force-close pada first available tradable price dengan:
POLICY_CHANGE_EXIT
STRATEGY_CHANGE_EXIT

Opsi kedua lebih sederhana dan audit-friendly.

Jangan meneruskan v1 positions melalui v2 resolver sambil menyebut record-nya v1.

P0.4 — Migration error masih disembunyikan

Migration enum menggunakan:

await pool.query(...).catch(() => {});

untuk menambahkan:

RETIRING
DATA_PENDING
DATA_MISSING

Kalau migration gagal karena permission, incompatible schema, atau data issue, setup tetap terlihat sukses. Runtime baru gagal saat mencoba menulis status tersebut.

Ini mengulang pola yang sebelumnya sudah beberapa kali terjadi: initialization melanjutkan proses walaupun schema sebenarnya belum siap.

Perbaikan

Jangan swallow error pada migration wajib:

await pool.query(`ALTER TABLE ...`);

Setelah migration, verifikasi melalui information_schema bahwa enum benar-benar memiliki seluruh status.

Integration test perlu membuat legacy scratch table dengan enum lama, menjalankan migration, lalu membuktikan row dapat diubah menjadi:

RETIRING
DATA_PENDING
DATA_MISSING
P1 yang masih tersisa
Reconciliation memakai config terbaru, bukan frozen account config

cmdReconcile() memeriksa seluruh account menggunakan:

vb.DEFAULT_CONFIG.maxPositions
vb.DEFAULT_CONFIG.maxGrossExposure
vb.DEFAULT_CONFIG.allowPyramiding
vb.DEFAULT_CONFIG.maxPositionNotional

Untuk account v1 atau custom config, invariant-nya bisa salah. Parse acct.config_json dan gunakan frozen config account itu sendiri.

cmdMark() belum mengambil consistent ledger snapshot

Write NAV dan account total sekarang atomic, tetapi cash, positions, dan realized P&L dibaca sebelum transaction dimulai. Transaction baru dimulai pada tahap write.

Jika resolve berjalan bersamaan, mark bisa menggabungkan cash lama dengan positions baru atau sebaliknya.

Mulai transaction sebelum membaca:

account FOR UPDATE
open positions
closed P&L
prices
NAV write
account total update
commit

Reconcile juga perlu memeriksa:

latest nav.cash_value = current account.cash_balance
latest nav.open_positions = actual open positions
Unpriced opening holding masih dibawa pada cost

Saat sizing, existing holding tanpa opening print dinilai menggunakan cost_basis.

Jika saham sudah naik 100%, exposure dapat terhitung setengah dari nilai terakhir. Gunakan last valid close sebelum entry date, atau blok seluruh new fills saat opening NAV tidak dapat ditentukan dengan cukup baik.

Per-name reconcile melewati session calendar

Per-ticker cap check membaca:

SELECT close_price
FROM idx_stock_prices
ORDER BY date DESC
LIMIT 1

tanpa memfilter tanggal melalui idx_ihsg_history.

Jadi phantom weekend row yang sudah dibuang oleh loadBars() masih dapat memengaruhi reconciliation. Gunakan harga pada latest authoritative NAV mark/session.

Penilaian terbaru
Area	Sebelumnya	Sekarang
Strategy-hash isolation	5,5	9,2
Trading-calendar logic	5,0	9,0
Position sizing	7,5	9,2
Gap execution realism	6,8	9,0
Retained-name handling	5,5	9,3
Auditability	8,7	9,2
Testing	8,7	9,1
Migration safety	7,0	7,0
Operational scheduling	7,0	6,0
Authoritative evidence readiness	6,8	8,0
Kesimpulan

Secara logic utama, revisi ini bagus dan substantif. V2 sekarang sudah mempunyai:

fresh Rp100 juta per strategy hash;
authoritative session calendar;
opening-NAV risk sizing;
realistic gap fills;
aggregate ticker protection;
ranked order allocation;
retiring-account lifecycle;
atomic NAV write;
stronger integration tests.

Posisinya sekarang:

Layak dijalankan sebagai shadow virtual broker v2, tetapi official performance record baru dianggap valid setelah cron calendar order dan missing-bar blocking dibereskan.

Yang paling mendesak bukan lagi formula tradingnya, bro. Sekarang masalah utamanya adalah kapan data dianggap tersedia dan apakah engine boleh melompati data yang tidak diketahui. Dua hal itu bisa mengubah hasil trade walaupun semua arithmetic lainnya sudah benar.

Review ini static source review. Gue belum menjalankan npm test atau npm run test:integration langsung terhadap MySQL/VPS production.