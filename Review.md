P0 — wajib diperbaiki sebelum track record dianggap valid
1. Account masih mencampur strategy hash berbeda

virtual_accounts hanya mempunyai:

strategy_id
execution_policy_hash

Tidak mempunyai strategy_hash.

Sedangkan order memang menyimpan strategy_hash, tetapi seluruh order lama dan baru tetap memakai cash dan NAV account yang sama. cmdSchedule() juga mengambil latest plan berdasarkan strategy_id saja.

Skenario:

Strategy hash A menghasilkan profit Rp10 juta
Configuration berubah menjadi hash B
Order B masuk account yang sama
NAV B dimulai dari Rp110 juta

Track record B akhirnya membawa keuntungan A.

Perbaikan

Tambahkan ke account:

strategy_hash VARCHAR(32) NOT NULL

Unique identity:

strategy_id
strategy_hash
account_code
execution_policy_hash

cmdSchedule() harus mengambil plan untuk hash account tersebut. Plan tanpa hash tidak boleh dijadwalkan.

Saat source strategy hash berubah, buat account baru dengan modal Rp100 juta dan archive account lama.

2. Trading calendar memakai idx_stock_prices

loadBars() membangun date axis dari:

SELECT DISTINCT date
FROM idx_stock_prices

Padahal dokumentasi production sendiri mencatat bahwa idx_stock_prices pernah mempunyai puluhan tanggal phantom berupa weekend, public holiday, zero-volume flat bar, dan copied-forward bar.

Dampaknya bisa sangat material:

entry T+1 jatuh ke hari libur palsu;
ATR menghitung phantom bars;
holding_bars menghitung non-trading sessions;
TIME_EXIT terjadi terlalu cepat;
EOD account melakukan trade pada tanggal bursa tutup.
Perbaikan

Gunakan idx_ihsg_history sebagai authoritative session calendar:

SELECT date
FROM idx_ihsg_history
ORDER BY date

Kemudian hanya terima price bar yang tanggalnya berada dalam calendar tersebut.

Tambahkan regression test:

signal Jumat
ada phantom row Sabtu
entry wajib Senin, bukan Sabtu
3. Superseded account bisa ditutup dengan posisi masih OPEN

retireSupersededAccounts() langsung mengubah account lama menjadi:

status = CLOSED

walaupun account tersebut masih mempunyai position history—dan query hanya menghitung semua positions, bukan memastikan tidak ada posisi terbuka.

Setelah status menjadi CLOSED, loadAccounts() tidak mengambil account itu lagi. Akibatnya posisi OPEN milik account lama:

tidak dicek SL/PT;
tidak pernah TIME_EXIT;
tidak di-mark;
tidak pernah mengembalikan cash;
tidak ikut reconciliation.
Perbaikan

Gunakan lifecycle:

ACTIVE
RETIRING
CLOSED

RETIRING:

tidak menerima order baru;
tetap menjalankan exit dan mark;
tetap direconcile;
berubah menjadi CLOSED hanya ketika tidak ada scheduled order dan open position.

Alternatifnya, force-close seluruh posisi dengan alasan eksplisit:

POLICY_CHANGE_EXIT

Jangan menutup account secara administratif sambil meninggalkan posisi terbuka.

4. Position account bisa membeli ticker yang sama berulang kali

cmdSchedule() menjadwalkan seluruh ticker di target_json pada setiap plan. Ia tidak memeriksa apakah account sudah memiliki ticker tersebut.

Padahal target book memang mempertahankan current holdings yang masih berada dalam buffer. Jadi ticker yang sama secara normal dapat muncul lagi pada rebalance berikutnya.

Skenario:

Plan 1: BBCA
→ membeli 12,5% NAV

Plan 2: BBCA masih retained
→ membeli BBCA lagi

Plan 3: BBCA masih retained
→ membeli lagi

maxPositionNotional saat ini diterapkan per order, bukan aggregate per ticker. Satu ticker dapat melewati 12,5% account.

Perbaikan

Untuk POSITION_100M:

target ticker sudah OPEN → jangan buat order baru

atau implementasikan top-up berdasarkan aggregate position value, bukan posisi baru.

Sebelum fill, hitung:

SUM(current market value)
WHERE account_id=?
  AND ticker=?
  AND status='OPEN'

Lalu enforce maximum notional per ticker secara aggregate.

Tambahkan unique/invariant bahwa satu account tidak boleh memiliki beberapa independent OPEN positions pada ticker yang sama kecuali pyramiding memang menjadi policy eksplisit dan masuk policy hash.

5. Position sizing memakai NAV lama dan cost basis, bukan opening exposure

Pada saat fill, code memakai:

acc.total_nav
SUM(open position cost_basis)

untuk menghitung risk budget dan gross exposure.

total_nav tersebut adalah NAV mark sebelumnya. SUM(cost_basis) juga bukan current market exposure.

Contoh:

NAV kemarin       Rp100 juta
Existing holdings gap -20%
Actual opening NAV Rp84 juta

Sizing masih memakai Rp100 juta

Risk 0,5% menjadi Rp500 ribu, padahal seharusnya sekitar Rp420 ribu.

Sebaliknya, winner yang sudah naik besar dapat membuat exposure aktual melewati 90%, tetapi cost basis masih terlihat rendah.

Perbaikan

Di dalam account lock, sebelum setiap fill:

opening cash
+ current holdings × opening price
= opening NAV

Gross exposure:

Σ current holdings × opening price

Risk budget dan exposure cap harus menggunakan dua angka tersebut.

6. Gap stop masih dieksekusi terlalu bagus

resolveBar() hanya membaca high, low, dan close. Bila low melewati stop, exit selalu dianggap terjadi tepat pada stopPrice.

Contoh:

stop           950
open berikutnya 800

Code saat ini keluar dari 950 dikurangi slippage, padahal tidak ada kesempatan menjual di 950. Simulasi menjadi terlalu optimistis.

Perbaikan gap-aware

Untuk posisi long:

open <= stop
→ exit quote = open

open >= target
→ exit quote = open atau target,
  sesuai asumsi limit-order yang didokumentasikan

setelah itu baru cek intraday low/high

resolveBar() perlu menerima:

open
high
low
close

Data high atau low yang kosong juga jangan dianggap “tidak menyentuh level”. Itu harus menjadi DATA_INCOMPLETE, bukan otomatis EOD_CLOSE.

P1 — perlu dibereskan untuk kualitas engineering
ATR dan trade policy kembali mempunyai implementation kedua

trade_policy.js secara eksplisit dibuat sebagai single source of truth.

Namun virtual broker kembali meng-hardcode:

maxHoldBars = 40
riskAtrMult = 2.5
fallbackRiskPct = 5
targetR = 2

dan membuat atrFrom() sendiri.

Lebih spesifik lagi, fungsi tersebut diberi label “Wilder ATR”, tetapi sebenarnya hanya menghitung simple average dari 14 true ranges terakhir. awo_technical.js menggunakan Wilder smoothing yang sesungguhnya.

Akibatnya virtual portfolio dapat mempunyai SL, PT, dan quantity berbeda dari trade-plan engine existing.

Gunakan kembali:

tradePolicy.resolve()
calcATR()/calcTechnicalFactors()
computeTradePlan()

atau beri nama policy baru secara eksplisit dan jangan mengklaim bahwa ia sama dengan trade policy existing.

Urutan order menjadi alfabetis

Scheduled orders diproses dengan:

ORDER BY signal_date, ticker

Jika cash atau exposure habis, ticker alfabetis pertama mendapat prioritas. Hasil portfolio dapat bergantung pada nama kode saham.

Simpan:

target_rank

ketika scheduling, lalu execute berdasarkan rank target.

Missing ticker row langsung dianggap NO_FILL

Jika global trading date ada tetapi ticker row tidak ada, order langsung menjadi:

NO_FILL / NO_OPEN_PRICE

Missing row bisa berarti:

saham suspended;
scraper gagal;
ticker belum ter-ingest;
data masih incomplete.

Pisahkan:

NO_FILL_CONFIRMED
DATA_MISSING
DATA_PENDING

Data outage tidak boleh terlihat seperti execution outcome.

Unmarkable position dibawa kembali ke cost basis

markToMarket() menilai ticker tanpa harga memakai cost_basis.

Setelah saham naik atau turun jauh, satu missing close dapat membuat NAV meloncat kembali ke entry value.

Gunakan:

last valid close;
last successfully stored mark;
baru fallback ke cost, dengan account ditandai NAV_DEGRADED.
cmdMark() belum atomic

NAV upsert dan update virtual_accounts.total_nav dilakukan dalam dua autocommit statement.

Crash di antaranya dapat membuat:

virtual_nav = benar
account.total_nav = lama

Fill berikutnya memakai account.total_nav lama untuk sizing. Reconciliation saat ini juga tidak membandingkan kedua angka tersebut.

Bungkus mark + account update dalam transaction dan tambahkan invariant:

account.total_nav = latest virtual_nav.total_nav
Counter bertambah sebelum commit

filled++, noFill++, rejected++, dan closed++ bertambah sebelum transaction selesai. Jika commit gagal, console summary dapat mengatakan berhasil walaupun database rollback.

Pindahkan counter setelah commit() atau gunakan per-transaction local result.

Scheduled event tidak menyimpan order_id

Order dibuat dengan INSERT IGNORE, tetapi ORDER_SCHEDULED event tidak menerima r.insertId. Scheduling juga tidak transaction-wrapped.

Journal timeline akan lebih kuat jika setiap event langsung terhubung ke order yang membuatnya.

Test coverage

Test suite-nya sudah termasuk kategori kuat:

unit test virtual broker masuk npm test;
MySQL lifecycle masuk npm run test:integration;
integration test wajib database dan tidak silently skip;
watchdog menjalankan reconciliation production.

Regression test yang masih perlu ditambahkan:

strategy hash A → B starts fresh account
phantom weekend cannot become entry day
retired account with open position keeps resolving
retained ticker is not bought twice
aggregate per-ticker cap
overnight NAV gap changes sizing
gap-through-stop exits at opening price
missing high/low cannot become EOD_CLOSE
rank order survives limited cash
mark/account update rollback together
Penilaian
Area	Nilai
Core architecture	9,0
Cash accounting	8,8
Idempotency	8,8
Auditability/journal	8,7
Testing	8,7
Strategy-version isolation	5,5
Trading-calendar integrity	5,0
Execution realism	6,8
Production evidence readiness	6,8
Kesimpulan

Ini sudah pantas disebut:

Virtual broker dengan real cash ledger dan auditable portfolio lifecycle.

Bukan lagi paper trade sederhana.

Tetapi track record-nya belum boleh dipakai untuk menilai kualitas strategi sampai minimal empat hal diselesaikan:

account diisolasi berdasarkan strategy hash;
trading calendar pindah ke IHSG session calendar;
superseded account tidak meninggalkan open positions;
retained ticker tidak dibeli berulang dan per-name cap berlaku aggregate.

Setelah seluruh perubahan accounting/execution selesai, naikkan:

DEFAULT_CONFIG.version = 2

dan mulai account Rp100 juta yang baru. Jangan mencampur record versi sekarang dengan engine hasil revisi berikutnya.

Review ini berdasarkan static source terbaru di GitHub. Gue belum menjalankan npm test dan npm run test:integration langsung terhadap MySQL/VPS production.