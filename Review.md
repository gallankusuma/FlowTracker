1. Tutup blocker backend terakhir

Prioritas pertama:

checkpoint resolve → schedule → mark dipisahkan berdasarkan strategy dan account identity;
transaction rollback membuat stage FAILED, bukan tetap OK;
posisi DATA_BLOCKED memblokir schedule baru;
burn-in dashboard hanya membaca identity aktif;
official start memakai full account identity;
account eksperimen/test tidak ikut memengaruhi burn-in resmi.

Acceptance criteria:

Resolve gagal       → schedule ditolak
Satu account gagal  → stage FAILED
Data exit rusak     → tidak ada order baru
Engine berubah      → burn-in kembali 0
Test account muncul → official streak tidak berubah
2. Bikin “Trust Center” di dashboard

Tambahkan satu bagian baru:

System Status
Market Data          HEALTHY
Session Calendar     CURRENT
Latest Price Session 2026-08-06
Resolve              COMPLETED
Schedule             COMPLETED
Mark                 COMPLETED
Reconcile            CLEAN
Experiment Identity
Engine Version       v2
Strategy Hash        ab12cd34
Policy Hash          ef56gh78
Code Commit          9192424
Official Start       Pending / tanggal aktual
Burn-in
Operational Burn-in  3 / 10 sessions
Current Streak       3
Latest Session       CLEAN
Official Identity    84ab2f...

Visual progress:

● ● ● ○ ○ ○ ○ ○ ○ ○
3 dari 10 sesi bersih

Kalau gagal:

Burn-in restarted
Reason: PRICE_DATA_STALE
3. Upgrade tampilan account

Setiap account card menampilkan:

POSITION_100M_V2
NAV                  Rp101.250.000
Cash                 Rp42.300.000
Market Value         Rp58.950.000
Return               +1,25%
Open Positions       5 / 8
Gross Exposure       58,2% / 90%
Performance Eligible YES
Status               ACTIVE

Akun intraday tetap ditandai sebagai CONTROL, bukan strategi kandidat.

4. Buat order dan trade timeline

Contoh:

BBCA
06 Aug 20:30  ORDER SCHEDULED
07 Aug 09:00  FILLED @ 9.425
07 Aug        Stop 9.180 · Target 9.915
12 Aug        TARGET HIT
12 Aug        SOLD @ 9.905
Net P&L       +Rp462.500
Fees          Rp83.200

Kalau gagal:

ORDER REJECTED
Reason: MAX_GROSS_EXPOSURE

atau:

DATA BLOCKED
High/low untuk sesi 2026-08-07 tidak lengkap
Exit evaluation dihentikan
5. Setelah deploy

Urutan go-live:

1. npm run test:unit
2. npm run test:integration
3. Verifikasi live crontab
4. Verifikasi .deployed-commit
5. Bersihkan checkpoint/burn-in development
6. Freeze identity resmi
7. Jalankan satu dry operational cycle
8. Mulai official 10-session burn-in

Selama burn-in, jangan ubah execution rule, sizing, fee, slippage, atau exit logic. Perubahan material berarti engine version baru dan streak dimulai ulang.

Definition of done

Sprint selesai ketika:

seluruh test lulus;
semua cron stage mempunyai identity-scoped checkpoint;
dashboard menampilkan data health dan stage status;
burn-in dashboard sesuai identity aktif;
satu simulasi failure terbukti memblokir downstream;
official burn-in mulai dari 0/10;
tidak ada manual database correction.

Setelah sprint ini, baru kita masuk ke fase berikutnya:

Portfolio Intelligence — sector exposure, correlation control, dynamic ranking, regime attribution, dan decision-quality analytics.