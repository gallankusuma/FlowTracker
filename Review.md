Satu temuan P1: migration backfill salah urutan

Ada satu bug migration yang tidak menghalangi burn-in production saat schema sekarang sudah lengkap, tetapi sebaiknya diperbaiki.

Backfill saat ini dijalankan di dalam blok penambahan ever_failed:

if (!await hasColumn(..., 'ever_failed')) {
  await pool.query('ALTER TABLE ... ADD ever_failed ...');

  await pool.query(`
    UPDATE virtual_cycle_stage
    SET first_failure_reason = ...,
        first_failed_at = ...
  `);
}

Masalahnya, pada database versi lama:

ever_failed baru saja ditambahkan;
first_failure_reason dan first_failed_at belum ditambahkan karena loop belum sampai ke sana;
query backfill langsung menggunakan dua kolom tersebut;
migration dapat gagal dengan Unknown column.

Sebaliknya, pada database yang kolomnya sudah ditambahkan oleh release sebelumnya, blok tersebut tidak masuk sehingga backfill lama tidak pernah dijalankan.

Bentuk fix yang benar

Tambahkan semua kolom dahulu:

for (const [column, definition] of columns) {
  if (!await hasColumn(pool, 'virtual_cycle_stage', column)) {
    await pool.query(
      `ALTER TABLE virtual_cycle_stage ADD COLUMN ${column} ${definition}`
    );
  }
}

Setelah loop selesai, jalankan backfill secara idempotent:

UPDATE virtual_cycle_stage
SET ever_failed = 1,
    first_failure_reason =
      COALESCE(first_failure_reason, reason, status),
    first_failed_at =
      COALESCE(first_failed_at, completed_at)
WHERE status <> 'OK'
  AND (
    ever_failed = 0
    OR first_failure_reason IS NULL
    OR first_failed_at IS NULL
  );

Tambahkan test upgrade dari tabel stage lama yang belum mempunyai keempat kolom.

Ini P1 migration compatibility, bukan blocker untuk protocol v2, selama production schema sekarang sudah mempunyai:

ever_failed
attempt_count
first_failure_reason
first_failed_at
Keputusan

GREEN LIGHT untuk memulai official 10-session operational burn-in.

Syarat sebelum hitungan pertama:

npm run test:unit
npm run test:integration

Verifikasi schema:

SELECT COLUMN_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'virtual_cycle_stage'
  AND COLUMN_NAME IN (
    'ever_failed',
    'attempt_count',
    'first_failure_reason',
    'first_failed_at'
  );

Pastikan hasilnya empat row.

Lalu dashboard harus menunjukkan:

Protocol Version  2
Burn-in Identity  identity baru
Streak            0 / 10
Stopped By        NO_EVIDENCE_FOR_<latest-session>

Mulai hitungan dari sesi bursa pertama setelah seluruh commit terbaru sudah ter-deploy sebelum resolve dijalankan. Jangan hitung sesi yang sebagian stage-nya masih memakai source lama.

Nilai akhir
Area	Nilai
Trading ledger	9,5
Execution realism	9,4
Stage failure evidence	9,5
Protocol isolation	9,6
Crash consistency	9,5
Consecutive-session proof	9,6
Dashboard/watchdog parity	9,5
Fresh database readiness	9,3
Upgrade migration	8,0
Official burn-in readiness	9,6

Review ini masih static source review. Gue belum menjalankan integration test MySQL atau memeriksa deployment dan cron live di VPS.