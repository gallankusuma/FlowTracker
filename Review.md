P0.1 — Cron production masih tidak membentuk fail-fast chain

Ini temuan terpenting.

Perbaikan pada main() memang menghentikan proses ketika menjalankan:

node virtual_portfolio.js

tanpa subcommand.

Namun production cron masih menjalankan empat proses independen:

20:10 resolve
20:30 schedule
20:35 mark
20:40 reconcile

Jadi bila resolve pukul 20:10 keluar dengan status 1:

20:30 schedule tetap berjalan
20:35 mark tetap berjalan
20:40 reconcile tetap berjalan

Exit code proses sebelumnya tidak otomatis membatalkan entry cron berikutnya. Dengan demikian, komentar di mode default bahwa “nothing was scheduled or marked” belum berlaku pada jalur production sebenarnya.

Perbaikan yang disarankan

Buat checkpoint:

virtual_cycle_stage
-------------------
session_date
engine_version
stage
status
reason
completed_at

UNIQUE(session_date, engine_version, stage)

Lifecycle:

resolve OK
    ↓
schedule boleh berjalan
    ↓
mark boleh berjalan
    ↓
reconcile boleh berjalan

cmdSchedule() harus menolak ketika current-session resolve bukan OK. cmdMark() juga harus menolak ketika resolve belum sukses.

Ini lebih aman daripada hanya mengandalkan waktu cron.

P0.2 — Watchdog masih mengabaikan blocked resolve

Pada repair virtual portfolio, watchdog menjalankan:

await vp.cmdResolve(pool, true);
return vp.cmdMark(pool, true);

Ia tidak memeriksa apakah cmdResolve() mengembalikan:

PRICE_DATA_STALE
SESSION_CALENDAR_STALE
PRICE_COVERAGE_THIN

Jadi watchdog dapat menjalankan mark tepat setelah resolver menolak data tersebut.

Perbaikannya:

const resolved = await vp.cmdResolve(pool, true);

if (resolved?.blocked) {
  throw new Error(`virtual resolve blocked: ${resolved.blocked}`);
}

return vp.cmdMark(pool, true);

Verify juga sebaiknya mensyaratkan:

NAV date = IHSG session date = price date

bukan hanya NAV date >= price date.

P0.3 — Burn-in belum diisolasi berdasarkan engine/account identity

Tabel burn-in masih hanya mempunyai:

session_date
passed
checks_json
failures_json

dengan unique key pada session_date. Streak kemudian dihitung dari seluruh tabel tanpa filter strategy hash, policy hash, atau engine version.

Skenario:

Engine v2 mempunyai 8 hari clean
Engine berubah ke v3
Account baru Rp100 juta dibuat
Dua hari berikutnya clean
→ sistem melaporkan 10 hari

Padahal engine v3 baru menjalani dua hari.

Perbaikan

Tambahkan:

burnin_identity_hash
strategy_hash
execution_engine_version
active_account_set_hash

Unique key:

UNIQUE(burnin_identity_hash, session_date)

Streak wajib dihitung hanya untuk identity aktif saat ini.

P0.4 — Historical phantom rows bisa membuat burn-in gagal selamanya

phantomSessions() memindai seluruh histori idx_stock_prices, bukan hanya current session.

Current documentation menyebut masih ada 72 tanggal phantom dan sengaja tidak dihapus otomatis.

Burn-in kemudian melakukan:

noPhantomSessions = phantomDates.length === 0
watchdogHealthy = tidak ada FAIL

Karena checkPhantomSessions() melaporkan phantom sebagai FAIL, streak kemungkinan akan gagal setiap hari selama historical rows tersebut masih ada.

Ada dua opsi yang konsisten:

backup, purge/reingest 72 historical dates tersebut; atau
daily burn-in hanya memeriksa phantom pada current session dan relevant strategy lookback, sementara historical data debt dilaporkan sebagai item terpisah.

Kalau raw historical bars masih dipakai oleh strategy modules tanpa session-calendar filtering, opsi pertama lebih aman.

P1 — Retirement edge case masih tersisa
Deployment intraday masih dapat menghasilkan exit retroaktif

retirement_session diisi dengan:

SELECT MAX(date) FROM idx_ihsg_history

Misalnya deployment dilakukan Kamis pukul 11:05 WIB, sementara IHSG table baru sampai Rabu:

retirement_session = Rabu
Kamis malam data masuk
first session after Rabu = Kamis
exit memakai Kamis open pukul 09:00

Padahal retirement diputuskan pukul 11:05.

Gunakan local decision date, bukan latest index session:

retirement_not_before_date =
tanggal retired_at dalam Asia/Jakarta

Kemudian exit pada session yang tanggalnya lebih besar dari tanggal keputusan tersebut.

Suspensi pada first retirement session dapat membuat posisi macet

Code menentukan satu exitDate global, yaitu first session setelah keputusan. Bila suatu ticker tidak memiliki opening price pada sesi itu, code melakukan continue. Pada run berikutnya ia kembali mencoba sesi yang sama, sehingga tidak pernah maju ke sesi kedua.

Cari first available session per ticker:

const exitDate = dates.find(
  d => d > decidedOn && bars.get(p.ticker)?.get(d)?.open > 0
);
P1 — Official start date masih belum benar

Code mengambil:

latestSession = MAX(date)

nextSession =
  MIN(date)
  WHERE date > latestSession

Query kedua secara definisi tidak akan menemukan row di historical table. Code kemudian fallback ke latestSession.

Komentarnya mengatakan PENDING_FIRST_SESSION, tetapi state tersebut belum benar-benar diimplementasikan.

Lebih akurat:

official_start_date =
first virtual NAV mark after charter.frozen_at

Atau buat nullable dan hanya izinkan transisi satu arah:

NULL → first official session

Karena charter immutable, ini perlu diselesaikan sebelum official record pertama.

Penilaian sekarang
Area	Nilai
Core accounting	9,4
Fresh-schema safety	9,3
Market-data validation	9,4
Engine identity	9,2
Retirement lifecycle	8,3
Testing	9,2
Cron failure propagation	6,5
Burn-in identity	6,5
Official evidence readiness	8,2
Kesimpulan

Revisi ini memang substantif dan benar. Empat komentar utama sudah masuk.

Status sistem sekarang:

Virtual broker core: engineering-ready.
Official burn-in orchestration: belum fully fail-closed.

Sebelum mulai hitungan 10 hari resmi, tutup:

stage checkpoint antara resolve → schedule → mark;
watchdog harus berhenti ketika resolve blocked;
burn-in harus di-scope ke engine/account identity;
tentukan perlakuan terhadap 72 historical phantom sessions.

Setelah itu, menurut gue tidak perlu menambah fitur lagi—langsung mulai official burn-in.

Review ini berdasarkan source terbaru di GitHub. Gue belum menjalankan unit/integration test langsung karena runtime lokal tidak dapat me-resolve github.com, dan gue tidak memiliki akses ke MySQL atau live crontab VPS.