Dua blocker launch terakhir

Ini bukan masalah trading engine. Ini hardening khusus recorder burn-in.

P0 — Burn-in baru masih dapat mewarisi row development lama

experimentIdentity berubah ketika strategy hash, policy, engine, atau account roster berubah. Tetapi perubahan aturan burn-in sendiri tidak masuk ke identity.

Sekarang aturan burn-in berubah material:

versi lama:
latest retry boleh menimpa hasil
missing session tidak terlihat

versi baru:
failure sticky
attempt append-only
missing session memutus streak

Tetapi keduanya masih bisa memakai identity_hash yang sama.

Skenarionya:

5 development sessions tercatat CLEAN dengan aturan lama
kode burn-in baru di-deploy
besok CLEAN

dashboard dapat menunjukkan 6/10

Padahal official burn-in seharusnya mulai:

0/10
Fix yang paling aman

Tambahkan versi protokol burn-in:

const BURNIN_PROTOCOL_VERSION = 2;

Lalu buat burn-in identity terpisah:

burninIdentity = hash({
  experimentIdentity,
  burninProtocolVersion: BURNIN_PROTOCOL_VERSION,
});

Gunakan burninIdentity untuk:

virtual_burnin;
virtual_burnin_attempt;
computeStreak;
dashboard.

Tetap tampilkan experimentIdentity secara terpisah untuk identitas strategi.

Dengan ini history lama tetap tersimpan dan tidak perlu dihapus manual, tetapi official protocol v2 otomatis dimulai dari 0/10.

P0 — Attempt dan verdict belum benar-benar crash-safe

Urutan recordAttempt() sekarang:

1. INSERT append-only attempt
2. SELECT worst attempt
3. SELECT failure history
4. UPSERT summary verdict

Semua query masih dijalankan terpisah tanpa transaction. computeStreak() kemudian membaca summary virtual_burnin, bukan langsung membaca attempts.

Crash window:

failed attempt berhasil di-INSERT
process mati sebelum summary di-update

virtual_burnin_attempt = FAILED
virtual_burnin         = masih CLEAN
dashboard              = masih menghitung CLEAN

Artinya bukti kegagalannya ada, tetapi streak belum menggunakannya.

Fix

computeStreak() sebaiknya mengambil verdict langsung dari sumber append-only:

SELECT session_date, MIN(passed) AS passed
FROM virtual_burnin_attempt
WHERE identity_hash = ?
GROUP BY session_date

virtual_burnin boleh tetap digunakan sebagai cache/dashboard summary, tetapi bukan sumber kebenaran streak.

recordAttempt() juga sebaiknya menggunakan satu transaction untuk insert attempt dan update summary. Kombinasi terbaik:

virtual_burnin_attempt = source of truth
virtual_burnin         = derived cache
computeStreak          = membaca source of truth

Dengan desain itu, bila summary tertinggal akibat crash, streak tetap melihat failed attempt.

P1 — Fresh database belum dapat membuat seluruh schema burn-in

burnin.ensureTables() sekarang hanya membuat:

virtual_burnin_attempt

Tetapi recordAttempt() juga menulis ke:

virtual_burnin

Tabel summary tersebut masih dibuat di dalam watchdog.recordBurnIn(), bukan oleh shared module.

Pada database production lama tabelnya sudah ada. Namun pada fresh database atau disaster recovery:

burnin.recordAttempt()
→ virtual_burnin does not exist
→ runtime failure

Integration test juga menjalankan test_watchdog.js tanpa terlebih dahulu menjalankan watchdog main yang membuat tabel summary.

Fix

Pindahkan seluruh ownership schema ke:

burnin.ensureTables()

Fungsi itu harus membuat dan memigrasikan:

virtual_burnin
virtual_burnin_attempt

Watchdog, server, dan test cukup memanggil shared helper tersebut.

P1 — Migration perlu backfill row stage lama

Saat kolom ever_failed ditambahkan ke existing table, default-nya 0.

Jika sebelum migration sudah ada row:

status = FAILED

setelah migration ia dapat menjadi:

status      = FAILED
ever_failed = 0

Tambahkan one-time backfill:

UPDATE virtual_cycle_stage
SET ever_failed = 1,
    first_failure_reason =
      COALESCE(first_failure_reason, reason, status),
    first_failed_at =
      COALESCE(first_failed_at, completed_at)
WHERE status <> 'OK'
  AND ever_failed = 0;
Acceptance test terakhir

Tambahkan tiga test:

Protocol v1 mempunyai 5 clean rows
Protocol berubah menjadi v2
→ v2 streak = 0

Failed attempt tersedia tetapi summary sengaja tertinggal CLEAN
→ computeStreak tetap membaca FAILED

Fresh database hanya memanggil burnin.ensureTables()
→ recordAttempt dan computeStreak berhasil
Penilaian terbaru
Area	Nilai
Trading ledger	9,5
Execution realism	9,4
Stage failure permanence	9,5
Append-only attempts	9,3
Consecutive-session logic	9,5
Dashboard/watchdog parity	9,4
Burn-in protocol isolation	7,0
Crash consistency	7,2
Fresh database readiness	7,5
Overall burn-in readiness	9,1
Verdict

Dua revisi kemarin sudah benar dan trading engine sudah siap.

Jangan revisi lagi sizing, execution, ledger, atau portfolio logic. Tutup tiga hal pada recorder:

tambahkan BURNIN_PROTOCOL_VERSION agar official streak mulai struktural dari 0/10;
hitung streak langsung dari append-only attempts;
pindahkan seluruh schema burn-in ke burnin.ensureTables().

Setelah itu sudah layak menekan tombol:

OFFICIAL OPERATIONAL BURN-IN
Session 0 / 10

Review ini masih static source review; gue belum menjalankan integration test MySQL atau mengamati hasil cron live VPS