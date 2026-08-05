Bro, menurut gue jangan tambah fitur trading baru dulu. Next step terbaik adalah mengubah V2 dari “kode yang bagus” menjadi operasional yang terbukti stabil.

Urutan yang gue sarankan
1. Tutup empat blocker terakhir

Prioritas paling atas:

Jalankan refresh_ihsg.js sebelum virtual_portfolio resolve.
Tambahkan hard guard SESSION_CALENDAR_STALE; resolve harus gagal kalau kalender IHSG tertinggal dari price data.
Missing atau incomplete bar harus memblokir perjalanan posisi, bukan dilewati ke candle berikutnya.
Saat strategy hash atau execution policy berubah:
SCHEDULED dan DATA_PENDING dibatalkan;
open position lama di-force-close dengan alasan POLICY_CHANGE_EXIT atau tetap memakai resolver versi lama.
Migration enum wajib fail loudly, jangan menggunakan .catch(() => {}).

Ini penting karena arithmetic dan sizing sekarang sudah cukup kuat; risiko terbesarnya justru engine bekerja dengan kalender atau data lifecycle yang salah.

2. Bekukan versi resmi

Setelah blocker ditutup, buat identitas final:

Virtual Broker Version : 2
Starting Capital       : Rp100.000.000
Official Start Date    : tanggal trading berikutnya
Strategy Hash          : ...
Execution Policy Hash  : ...
Code Commit            : ...

Account hasil development sebelumnya jangan digabung dengan record resmi.

Buat account baru:

POSITION_100M_V2
INTRADAY_EOD_100M_V2

Keduanya mulai dari nol dengan Rp100 juta masing-masing.

3. Jalankan seluruh test di environment database

Wajib hijau:

npm test
npm run test:integration

Lalu tambahkan test terakhir yang belum terkunci:

stale IHSG calendar → resolve gagal
incomplete exit bar → posisi tidak boleh membaca hari berikutnya
policy change → pending order dibatalkan
retiring account → open position benar-benar ditutup
migration enum lama → berhasil naik ke schema baru

Current test suite sebenarnya sudah cukup kuat dan telah mencakup strategy isolation, retained ticker, gap execution, NAV reconciliation, dan idempotency.

4. Jalankan burn-in selama 10 hari bursa

Selama periode ini, jangan ubah parameter trading.

Setiap malam periksa:

price data current
IHSG calendar current
resolve success
schedule success
NAV mark success
reconcile = 0 problems
watchdog = healthy
cash >= 0
NAV = cash + market value
no duplicate fill
no skipped unknown bar

Target burn-in:

10 hari bursa berturut-turut tanpa manual database repair dan tanpa invariant failure.

Kalau ada bug, perbaiki dan restart hitungan 10 hari. Burn-in ini menguji operasional, belum menguji apakah strateginya profitable.

5. Buat dashboard portfolio yang benar-benar operasional

Frontend minimal menampilkan:

Account summary
Starting capital
Current NAV
Cash
Market value
Gross exposure
Realized P&L
Unrealized P&L
Return %
Maximum drawdown
Open positions
Ticker
Quantity / lot
Entry
Current price
Stop loss
Profit target
Market value
Unrealized P&L
Holding days
Order queue
Scheduled
Data pending
Data missing
Rejected
No fill
Filled
Cancelled
Journal
Recommendation
Order scheduled
Filled
SL/PT created
Exit
Fee
Slippage
Net P&L
Exit reason
Strategy hash
Policy hash

Pastikan DATA_PENDING dan NAV_DEGRADED terlihat mencolok, bukan tersembunyi sebagai catatan kecil.

6. Tentukan evaluation gate sebelum melihat hasil

Sebelum track record bertambah, bekukan kriterianya. Contoh untuk POSITION_100M_V2:

Minimum period          : 60 trading days
Minimum closed trades   : 30
Maximum drawdown        : <= 12%
Profit factor           : >= 1.20
Net return              : > 0 setelah fee/slippage
No ledger violations    : wajib
No policy changes       : wajib

Untuk INTRADAY_EOD_100M_V2, jangan memakai target profit sebagai ekspektasi. Account itu adalah control/challenger untuk membuktikan apakah closing pada hari yang sama memang merusak edge.

Jangan mengubah SL, PT, target R, fee, atau sizing setelah melihat beberapa trade jelek. Perubahan parameter harus menghasilkan policy hash dan account baru.

Setelah itu baru pertimbangkan broker integration

Urutannya sebaiknya:

Virtual broker
→ stable shadow record
→ broker sandbox/read-only
→ broker order mirroring dengan approval manual
→ small-capital controlled execution
→ full automation

Tahap pertama broker integration sebaiknya hanya:

membaca buying power;
membaca portfolio;
menghasilkan proposed orders;
manusia menekan approve;
reconcile broker fills terhadap proposed fills.

Belum perlu mengizinkan sistem langsung mengirim order tanpa approval.

Fokus sprint berikutnya

Menurut gue satu sprint berikutnya cukup fokus pada:

Data lifecycle hardening → fresh V2 account → 10-day burn-in → operational dashboard.

Setelah itu kita berhenti menilai kualitas code dan mulai menilai kualitas sistem dari data yang benar-benar dihasilkan setiap hari.