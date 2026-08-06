Yang sudah benar
Perbaikan	Status
Schedule rollback → stage FAILED	✅
Mark satu account gagal → stage FAILED	✅
Resolve gagal → exit code non-zero	✅
Default chain berhenti saat resolve gagal	✅
Circular NO_INDEX_BAR classification	✅
Watchdog scoped ke official strategy	✅
Burn-in NAV checks scoped ke official accounts	✅
API default hanya menampilkan official accounts	✅
Cycle identity stabil ketika retirement selesai	✅
Regression tests untuk rollback dan phantom gap	✅

Schedule sekarang menyimpan rollback, menulis stage FAILED, dan mengembalikan failed: true. Mark juga mensyaratkan seluruh account berhasil ditandai. Resolve sekarang mempunyai properti failed yang dibaca oleh CLI dan default chain.

Circular phantom classification juga sudah ditangani dengan benar: hard signatures diperiksa lebih dahulu, IHSG gap diberi kesempatan diperbaiki, kemudian NO_INDEX_BAR baru diklasifikasikan. Regression test-nya benar-benar membuktikan real IHSG gap tidak ikut dikecualikan.

P0.1 — Burn-in tidak lagi berubah ketika strategy hash berubah

Ini blocker paling penting yang tersisa.

cycleIdentity() sekarang sengaja tidak memasukkan strategy_hash. Hash yang dibuat hanya berdasarkan:

{
  strategyId,
  engine: EXECUTION_ENGINE_VERSION,
  roster
}

Namun identity yang sama dipakai oleh:

stage checkpoint;
burn-in;
Trust Center;
dashboard burn-in history.

Skenarionya:

Strategy hash A → 8 hari clean
Strategy berubah menjadi hash B
Engine, policy, dan account code tetap sama
Strategy B → 2 hari clean

Dashboard dapat membaca 10 hari clean

Padahal strategy B baru berjalan dua hari.

Komentar di watchdog masih mengatakan strategy hash merupakan bagian identity, tetapi implementasinya sudah tidak memasukkannya.

Solusi

Pisahkan dua jenis identity:

cycleIdentity
Digunakan untuk resolve → schedule → mark
Harus stabil sepanjang satu nightly cycle

experimentIdentity
Digunakan untuk burn-in dan dashboard
Harus berubah ketika strategy hash, policy, atau engine berubah

Contoh experiment identity:

experimentIdentity = hash({
  strategyId,
  accounts: officialAccounts.map(a => ({
    accountCode: a.account_code,
    strategyHash: a.strategy_hash,
    policyHash: a.execution_policy_hash,
    engineVersion: a.execution_engine_version,
  })),
});

Burn-in dan dashboard harus menggunakan experimentIdentity, bukan cycleIdentity.

P0.2 — Burn-in belum mensyaratkan semua stage OK

recordBurnIn() sekarang memeriksa:

data harga;
kalender;
phantom sessions;
cash;
performance eligibility;
NAV;
duplicate fills;
blocked bars;
reconcile;
watchdog health.

Namun belum ada pemeriksaan terhadap:

resolve stage  = OK
schedule stage = OK
mark stage     = OK

Artinya schedule dapat tercatat FAILED, tetapi burn-in masih mungkin menghitung hari tersebut sebagai bersih apabila NAV dan reconcile tetap benar.

Ini sangat mungkin karena schedule membuat order untuk sesi berikutnya; kegagalan schedule tidak selalu merusak NAV hari ini.

Solusi

Tambahkan:

const cycleHash = await vp.cycleIdentity(pool, vp.SOURCE_STRATEGY);

const [stages] = await pool.query(
  `SELECT stage, status
     FROM virtual_cycle_stage
    WHERE session_date=? AND identity_hash=?`,
  [sessionDate, cycleHash]
);

const stageMap = Object.fromEntries(
  stages.map(s => [s.stage, s.status])
);

checks.resolveStageOk = stageMap.resolve === 'OK';
checks.scheduleStageOk = stageMap.schedule === 'OK';
checks.markStageOk = stageMap.mark === 'OK';

Dengan begitu:

FAILED
BLOCKED
NOT_RUN

semuanya otomatis memutus streak.

P0.3 — Beberapa penolakan schedule masih exit sukses

Tiga kondisi belum menghasilkan blocked atau failed.

Tidak ada LIVE plan

Sekarang hanya:

return {
  scheduled: 0,
  skipped: 0,
  held: 0,
  mismatched: 0
};

Cron akan keluar dengan status 0.

Plan tidak mempunyai strategy hash

Sekarang mengembalikan:

{
  reason: 'PLAN_WITHOUT_HASH',
  scheduled: 0
}

Tetapi tidak mempunyai failed: true atau blocked. Cron juga keluar 0.

Account dan plan berbeda strategy hash

Account dilewati dan mismatched bertambah, tetapi bila tidak ada transaction rollback, stage tetap dicatat OK.

Padahal active account yang tidak cocok dengan plan adalah kondisi tidak normal.

Solusi
NO_LIVE_PLAN       → BLOCKED
PLAN_WITHOUT_HASH  → FAILED
ACCOUNT_HASH_DRIFT → FAILED

Semua kondisi tersebut harus:

mencatat stage;
mengembalikan blocked atau failed;
membuat CLI keluar dengan status 1;
menggagalkan burn-in.

Empty target book tetap boleh OK, karena itu keputusan strategi yang valid.

P1 — Watchdog masih bisa melewatkan partial mark

Watchdog sekarang sudah scoped ke official account IDs, tetapi freshness mark masih menggunakan:

SELECT MAX(mark_date)
FROM virtual_nav
WHERE account_id IN (?)

Kalau:

POSITION marked hari ini
INTRADAY terakhir marked kemarin

MAX(mark_date) tetap menunjukkan hari ini.

Burn-in memang memiliki count per account dan akan menangkapnya, tetapi output watchdog dapat mengatakan “sudah current” sementara burn-in mengatakan gagal.

Gunakan count:

SELECT COUNT(DISTINCT account_id)
FROM virtual_nav
WHERE account_id IN (?)
  AND mark_date = ?

Jumlahnya harus sama dengan seluruh account ACTIVE dan RETIRING.

P1 — Regression test menghapus data IHSG production

Test circular-classification melakukan:

DELETE FROM idx_ihsg_history WHERE date=?

kemudian memasukkan row kembali di finally.

Secara logika test-nya bagus, tetapi secara operasional berbahaya. Kalau proses:

dihentikan;
server mati;
koneksi hilang;
test runner di-kill;

sebelum finally, production IHSG series kehilangan satu sesi nyata.

Lebih aman:

gunakan temporary tables; atau
jalankan deletion dalam satu transaction menggunakan dedicated connection, kemudian selalu ROLLBACK.

Jangan mengandalkan delete lalu insert kembali pada tabel market-data production.

P1 — Failure test schedule bergantung pada MySQL strict mode

Test memicu rollback menggunakan ticker yang lebih panjang daripada VARCHAR(10).

Pada MySQL strict mode ini melempar error. Pada konfigurasi non-strict, nilainya bisa dipotong menjadi warning sehingga failure path tidak benar-benar diuji.

Minimal test harus memastikan:

SELECT @@SESSION.sql_mode

mengandung:

STRICT_TRANS_TABLES

atau gunakan deterministic test failpoint pada test database.

Penilaian terbaru
Area	Nilai
Core ledger	9,5
Resolve failure semantics	9,4
Schedule failure semantics	9,0
Mark failure semantics	9,2
Phantom handling	9,3
Checkpoint isolation	9,1
Burn-in identity	6,8
Burn-in stage evidence	6,5
Watchdog consistency	8,5
Test safety	7,5
Official burn-in readiness	8,5
Kesimpulan

Empat revisi yang terakhir diminta sudah benar-benar selesai. Tidak ada masalah besar lagi pada transaksi virtual broker-nya.

Yang tersisa sekarang adalah validitas bukti operasional:

Apakah streak benar-benar milik strategi yang sama, dan apakah satu hari boleh disebut clean ketika salah satu stage gagal?

Sebelum mulai hitungan resmi 0/10, tutup tiga P0:

pisahkan cycleIdentity dan experimentIdentity;
burn-in wajib memeriksa resolve, schedule, dan mark berstatus OK;
no plan, no strategy hash, dan account hash mismatch harus gagal secara eksplisit.

Setelah tiga itu selesai, menurut gue backend sudah layak memulai official 10-session burn-in. Review ini berdasarkan static source terbaru di GitHub; integration test MySQL dan kondisi live VPS belum gue jalankan langsung.