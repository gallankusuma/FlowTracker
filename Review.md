Setelah empat poin ini ditutup, menurut gue virtual broker bisa dinyatakan engineering-ready untuk official shadow track record.

Yang sudah berhasil ditutup
Arahan sebelumnya	Status
Cron IHSG sebelum resolve	✅
SESSION_CALENDAR_STALE guard	✅ Sebagian
Missing bar menghentikan exit walk	✅
performance_eligible=0 saat data blocked	✅
Pending order dibatalkan saat contract berubah	✅
Retiring account tidak memakai natural resolver baru	✅
Migration tidak swallow error	✅
Migration dibuktikan melalui information_schema	✅
Mark memakai consistent transaction snapshot	✅
Reconcile memakai frozen account config	✅
Official V2 accounts mulai Rp100 juta baru	✅
Evaluation gate dibekukan sebelum hasil muncul	✅
10-session burn-in tracking	✅
Dashboard membawa charter dan burn-in status	✅

Cron sekarang sudah memiliki urutan yang benar:

19:30  price data
20:05  refresh IHSG
20:10  virtual resolve
20:15  forward fill
20:20  forward plan
20:25  forward mark
20:30  virtual schedule
20:35  virtual mark
20:40  virtual reconcile
20:50  watchdog

Missing atau incomplete exit bar sekarang benar-benar menghentikan perjalanan posisi. Account juga diberi performance_eligible=0 sampai datanya pulih. Ini solusi yang benar.

Official account juga sudah dipisahkan secara struktural:

POSITION_100M_V2
INTRADAY_EOD_100M_V2

dan evaluation gate telah dibekukan melalui charter.

P0.1 — Fresh database setup sekarang gagal

Urutan schema setup salah.

Code menjalankan:

ALTER TABLE virtual_positions
MODIFY COLUMN exit_reason VARCHAR(24) NULL

sebelum menjalankan:

CREATE TABLE IF NOT EXISTS virtual_positions (...)

Pada production database existing, ini kemungkinan tidak terlihat karena tabel sudah ada. Tetapi pada:

fresh installation;
temporary integration database;
disaster recovery;
deployment environment baru;

setup akan gagal dengan tabel virtual_positions belum ada.

Perbaikan

Urutannya harus:

1. CREATE TABLE IF NOT EXISTS virtual_positions
2. Periksa kolom exit_reason
3. ALTER hanya jika panjangnya kurang dari 24

Contoh:

await pool.query(`CREATE TABLE IF NOT EXISTS virtual_positions (...)`);

const [[col]] = await pool.query(`
  SELECT CHARACTER_MAXIMUM_LENGTH len
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA=DATABASE()
    AND TABLE_NAME='virtual_positions'
    AND COLUMN_NAME='exit_reason'
`);

if (Number(col?.len) < 24) {
  await pool.query(
    'ALTER TABLE virtual_positions MODIFY COLUMN exit_reason VARCHAR(24) NULL'
  );
}

Tambahkan fresh-schema integration test yang menjalankan setup() setelah seluruh virtual_* tables dihapus atau menggunakan temporary database.

P0.2 — Calendar guard belum benar-benar fail-closed

Guard sekarang hanya menyatakan stale ketika:

calendar < prices

Ini menutup kasus IHSG tertinggal dari price data. Tetapi arah sebaliknya belum ditangani.

Skenario:

IHSG calendar  : 2026-08-05
Price data     : 2026-08-04

Ini dapat terjadi bila:

price pull 19:30 gagal;
refresh IHSG 20:05 berhasil;
resolve 20:10 dijalankan.

Karena calendar < prices false, resolve tetap berjalan. Mark kemudian dapat membuat NAV bertanggal 5 Agustus menggunakan last-known prices tanggal 4 Agustus.

Guard yang dibutuhkan
if (!calendar || !prices) {
  return { blocked: 'MARKET_DATA_UNAVAILABLE' };
}

if (calendar < prices) {
  return { blocked: 'SESSION_CALENDAR_STALE' };
}

if (prices < calendar) {
  return { blocked: 'PRICE_DATA_STALE' };
}

Lebih kuat lagi, jangan hanya memeriksa MAX(date). Pastikan latest session mempunyai coverage saham minimum yang wajar.

CLI masih keluar dengan status sukses

Saat calendar stale, cmdResolve() mengembalikan object blocked. Tetapi main() melakukan:

if (cmd === 'resolve') {
  await cmdResolve(pool, false);
  return;
}

Tidak ada process.exitCode = 1. Default pipeline juga tetap melanjutkan ke schedule dan mark setelah resolve blocked.

Akibatnya cron dapat melihat command berhasil walaupun resolve secara eksplisit menolak bekerja.

Perbaikan
if (cmd === 'resolve') {
  const result = await cmdResolve(pool, false);
  if (result?.blocked) process.exitCode = 1;
  return;
}

const resolved = await cmdResolve(pool, false);
if (resolved?.blocked) {
  process.exitCode = 1;
  return;
}

Integration test saat ini hanya membuktikan cmdResolve() mengembalikan SESSION_CALENDAR_STALE; belum membuktikan CLI keluar non-zero atau default chain berhenti.

P0.3 — Code commit disebut bagian identity, tetapi belum benar-benar mengisolasi account

Dokumentasi charter mengatakan:

Code commit merupakan bagian dari identity.

Alasannya benar: execution policy hash hanya menangkap configuration, bukan perubahan algorithm.

Namun unique key charter saat ini hanya:

account_code
strategy_id
strategy_hash
execution_policy_hash

code_commit tidak termasuk unique identity. virtual_accounts juga tidak memiliki implementation commit/hash.

Skenario:

Commit A:
account berjalan dan charter dibekukan

Commit B:
algorithm execution berubah
strategy hash tetap
execution policy hash tetap
account code tetap

→ setup menemukan charter lama
→ trade baru Commit B masuk account Commit A

Charter tetap menampilkan commit A, padahal sebagian record dibuat oleh commit B.

Solusi yang lebih baik

Jangan memakai raw Git commit untuk memulai ulang account pada setiap perubahan dokumentasi. Buat identity eksplisit:

execution_engine_version
atau
execution_engine_hash

Hash tersebut mencakup perubahan material pada:

fill rules;
gap handling;
missing-bar behavior;
NAV sizing;
order sequencing;
retirement behavior;
transaction lifecycle.

Tambahkan ke:

virtual_accounts
virtual_charter
unique account identity

Ketika engine hash berubah:

old account → RETIRING
new account → fresh Rp100 juta

Raw code_commit tetap disimpan untuk reproducibility, tetapi implementation identity sebaiknya berupa version/hash yang disengaja.

P0.4 — Forced retirement exit memakai open yang sudah lewat

Saat account menjadi RETIRING, code force-close posisi menggunakan:

const today = dates[dates.length - 1];
const px = bars.get(p.ticker)?.get(today)?.open;

Masalahnya, detection dan deployment biasanya terjadi saat nightly process, sekitar pukul 20:10 WIB. Open hari tersebut terjadi sekitar pukul 09:00 WIB—lebih dari 11 jam sebelumnya.

Skenario:

Rabu 20:00  code V3 dideploy
Rabu 20:10  account V2 menjadi RETIRING
Rabu 20:10  posisi dicatat exit pada open Rabu

Sistem secara retroaktif menjual sebelum keputusan retirement ada.

Ini bukan hanya asumsi konservatif; ini execution timestamp yang tidak mungkin.

Perbaikan

Simpan:

retired_at
retirement_session
retirement_reason

Kemudian forced exit hanya pada:

first authoritative session strictly after retirement was detected

Contoh:

const retirementDate = toDateStr(acct.retired_at);

const exitDate = dates.find(d => d > retirementDate);
if (!exitDate) {
  // next session belum tersedia
  continue;
}

const px = bars.get(p.ticker)?.get(exitDate)?.open;

Alternatifnya gunakan same-day close hanya jika retirement decision memang direkam sebelum close. Dengan current nightly architecture, next-session open adalah asumsi paling bersih.

Integration test sekarang justru mengharuskan account langsung kosong setelah satu cmdResolve() menggunakan bar terbaru, sehingga test tersebut mengunci perilaku retroaktif.

P1 yang disarankan
Official start date belum benar-benar “next trading session”

Setup mencari:

SELECT MIN(date)
FROM idx_ihsg_history
WHERE date > CURDATE()

Lalu bila tidak ada, menggunakan latest session.

Tabel historical biasanya tidak menyimpan future sessions, sehingga fallback hampir selalu dipakai. Official start dapat menjadi hari ini atau sesi sebelumnya, bukan sesi pertama account benar-benar dapat melakukan trade.

Lebih akurat:

official start = tanggal first official NAV mark

atau session pertama setelah charter frozen.

DATA_BLOCKED event bisa tercatat berulang

Setiap nightly retry pada bar yang sama memasukkan event DATA_BLOCKED baru. Ini tidak merusak accounting, tetapi journal dapat penuh dengan event identik.

Tambahkan unique logical key atau hanya insert ketika block state berubah:

position_id + blocked_date + reason
CRONTAB.md masih menyebut nama account lama

Bagian jadwal masih mengatakan POSITION_100M dan INTRADAY_EOD_100M, sementara code sudah menggunakan suffix _V2.

Tidak memengaruhi engine, tetapi dokumentasi official record harus presisi.

Burn-in implementation

Burn-in tracking sudah dibuat dengan pendekatan yang benar:

satu row per session;
streak dihitung dari historical rows;
bukan mutable counter;
reconciliation failures masuk ke failure list;
dashboard menerima streak, target, dan failure history.

Namun jangan mulai menghitung streak resmi sebelum empat P0 di atas ditutup. Account V2 memang belum tentu perlu diganti lagi bila benar-benar belum ada order/position, tetapi charter/identity harus diperbaiki sebelum first official trade.

Penilaian terbaru
Area	Nilai
Core accounting	9,3
Data blocking	9,5
Session-calendar design	9,0
Cron orchestration	8,8
Retirement lifecycle	7,5
Schema migration safety	7,8
Track-record identity	7,0
Burn-in instrumentation	9,0
Testing	9,2
Official evidence readiness	8,4
Kesimpulan

Revisi ini sudah membawa sistem ke tahap:

Operationally instrumented virtual broker with pre-registered evaluation and burn-in monitoring.

Tim sudah menutup hampir semua masalah arithmetic, data blocking, dan accounting sebelumnya.

Yang tersisa sekarang sangat spesifik:

pindahkan ALTER virtual_positions setelah CREATE TABLE;
freshness guard harus dua arah dan CLI harus exit non-zero;
implementation version/hash harus benar-benar masuk account identity;
forced retirement exit harus memakai next available session, bukan open yang sudah lewat.

Setelah empat poin tersebut selesai, menurut gue:

Mulai official 10-session burn-in. Tidak perlu menambah fitur lain dulu.

Review ini berdasarkan static source terbaru di GitHub. Gue belum menjalankan npm test, npm run test:integration, atau membaca live crontab/MySQL di VPS.