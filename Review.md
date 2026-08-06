Trading engine dan nightly failure chain sudah engineering-ready. Namun mekanisme pembuktian “10 sesi berturut-turut” masih mempunyai dua celah audit yang perlu ditutup sebelum streak disebut resmi.

Ini bukan masalah baru pada kalkulasi transaksi. Dua poin berikut baru terlihat setelah burn-in, identity, dan stage evidence-nya sudah lengkap.

P0.1 — Kegagalan masih bisa ditimpa menjadi sukses

Stage checkpoint menggunakan satu row per sesi dan stage:

ON DUPLICATE KEY UPDATE
    status = VALUES(status),
    reason = VALUES(reason),
    completed_at = CURRENT_TIMESTAMP

Skenarionya:

20:30 schedule FAILED
20:32 diperbaiki atau dijalankan ulang
20:33 schedule OK

Database akhirnya hanya menyimpan OK

Bukti bahwa stage pernah gagal hilang.

Hal yang sama terjadi pada virtual_burnin:

ON DUPLICATE KEY UPDATE
    passed = VALUES(passed),
    checks_json = VALUES(checks_json),
    failures_json = VALUES(failures_json)

Jadi bisa terjadi:

Watchdog pertama  → session FAILED
Masalah diperbaiki
Watchdog kedua    → session diubah menjadi CLEAN

Padahal definisi burn-in kita:

Satu kegagalan pada sesi tersebut memutus streak.

Perbaikan yang disarankan

Stage perlu menyimpan current status dan riwayat kegagalannya:

status
attempt_count
ever_failed
first_failure_reason
first_failed_at
last_completed_at

Rerun yang berhasil boleh membuat status=OK agar pipeline dapat lanjut, tetapi:

ever_failed = 1

harus tetap permanen.

Burn-in menggunakan:

status = OK
AND ever_failed = 0

Untuk virtual_burnin, row yang pernah passed=0 tidak boleh ditingkatkan menjadi 1. Pilihan terbaik adalah tabel append-only virtual_burnin_attempt, kemudian daily verdict menggunakan nilai terburuk dari seluruh attempt pada sesi tersebut.

P0.2 — Streak menghitung row, bukan sesi bursa yang benar-benar berurutan

Watchdog saat ini menghitung:

for (const row of rows) {
  if (!row.passed) break;
  streak++;
}

dengan rows yang tersedia di virtual_burnin.

Dashboard melakukan perhitungan yang sama.

Masalahnya, tidak ada pemeriksaan bahwa seluruh sesi IHSG di antara row tersebut mempunyai bukti burn-in.

Contoh:

Senin   CLEAN
Selasa  watchdog tidak berjalan → tidak ada row
Rabu    CLEAN
Kamis   CLEAN

Query akan membaca:

Kamis, Rabu, Senin

lalu menghitung streak 3.

Padahal secara jujur streak-nya hanya:

Kamis + Rabu = 2

Senin terputus karena tidak ada bukti untuk Selasa.

Ini bertentangan dengan prinsip yang sudah ditulis di kode:

Silence is not evidence.

Perbaikan yang disarankan

Hitung streak menggunakan kalender idx_ihsg_history:

1. Ambil sesi IHSG terbaru.
2. Mundur satu per satu berdasarkan calendar.
3. Cari burn-in row untuk identity dan tanggal tersebut.
4. Row tidak ada → streak berhenti.
5. Row gagal → streak berhenti.
6. Hanya row CLEAN yang berurutan yang dihitung.

Buat satu shared helper, misalnya:

computeBurnInStreak(pool, identityHash, latestSession)

Gunakan helper yang sama di:

watchdog.js;
server.js;
CLI/status bila nanti ditambahkan.

Jangan menduplikasi perhitungan di watchdog dan dashboard karena keduanya bisa kembali berbeda.

P1 — Watchdog repair belum memeriksa resolved.failed

Saat watchdog mencoba memperbaiki NAV tertinggal, ia memeriksa:

if (resolved?.blocked) {
  throw new Error(...);
}

tetapi belum memeriksa resolved.failed.

Saat resolve gagal karena transaction rollback, cmdMark() tetap akan menolak karena resolve checkpoint bukan OK, jadi saat ini tidak menghasilkan NAV palsu. Namun flow dan error reporting-nya tidak konsisten.

Ubah menjadi:

if (resolved?.blocked || resolved?.failed) {
  throw new Error(
    `virtual resolve did not settle: ${
      resolved.blocked || resolved.failures?.join('; ') || 'FAILED'
    }`
  );
}

Ini P1 karena current mark gate sudah melindungi ledger.

Test yang perlu ditambahkan

Test baru yang sudah ada sudah bagus:

cycle identity dan experiment identity bergerak berbeda;
no plan terblokir;
schedule rollback menjadi failed;
mark rollback menjadi failed;
real IHSG gap tidak disembunyikan;
delete production test dibungkus transaction dan rollback;
strict SQL mode diverifikasi.

Empat regression test terakhir yang masih diperlukan:

stage FAILED lalu retry OK
→ current status boleh OK
→ ever_failed tetap 1
→ burn-in tetap gagal

burn-in FAILED lalu watchdog dijalankan ulang dengan kondisi sehat
→ session tidak boleh berubah menjadi CLEAN

burn-in rows CLEAN pada Senin dan Rabu, Selasa tidak mempunyai row
→ streak berhenti di Rabu

dashboard streak dan watchdog streak
→ selalu menghasilkan angka identik
Penilaian
Area	Nilai
Core ledger	9,5
Execution realism	9,4
Fail-closed schedule	9,4
Resolve/mark failure semantics	9,4
Cycle identity	9,4
Experiment identity	9,3
Burn-in stage checks	9,2
Burn-in failure permanence	6,5
Consecutive-session proof	6,0
Test safety	9,0
Official burn-in readiness	8,8
Kesimpulan

Tiga blocker dari review sebelumnya sudah selesai dengan benar. Mesin trading, checkpoint, refusal path, identity separation, dan dashboard API sudah jauh lebih solid.

Sebelum menekan tombol resmi 0/10, tutup dua hal:

kegagalan harus sticky dan tidak dapat tertimpa oleh retry sukses;
streak harus mengikuti sesi IHSG berurutan, bukan sekadar menghitung row yang tersedia.

Setelah dua itu selesai, menurut gue kita sudah bisa berhenti menambah revisi fondasi dan benar-benar memulai official 10-session operational burn-in. Review ini static source review; gue belum menjalankan integration test MySQL maupun mengamati cron live di VPS.