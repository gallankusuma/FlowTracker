Virtual Broker & Portfolio Journal Engine

Mulai dengan modal virtual Rp100 juta, order dari rekomendasi sistem, entry dan exit otomatis, seluruh transaksi dicatat seperti akun trading sungguhan.

Jangan menempel langsung ke modul lama

FlowTracker sebenarnya sudah memiliki sebagian komponen yang dibutuhkan:

rekomendasi hanya membuka posisi long untuk BUY dan STRONG BUY;
entry disimulasikan pada open T+1;
SL dan target dihitung setelah harga entry diketahui;
jika SL dan target tersentuh pada candle yang sama, sistem memilih SL sebagai asumsi konservatif;
fee round-trip sudah dimodelkan.

Tetapi paper_trading.js sekarang adalah validator kandidat model, bukan portfolio sungguhan. Setiap rekomendasi berdiri sendiri dalam satuan R; belum ada shared cash account, jumlah lot, buying power, portfolio NAV, atau batas modal Rp100 juta.

Jadi buat modul baru:

modules/virtual_broker.js
virtual_portfolio.js
test_virtual_broker.js
Catatan sangat penting soal closing market

Current active policy FlowTracker adalah POSITION, dengan batas holding 40 trading bars, risiko 2,5 ATR, dan target sampai 4R. Itu dirancang untuk horizon sekitar 2–8 minggu. Memaksa semua saham ditutup pada hari entry adalah strategi yang benar-benar berbeda.

Artinya, jangan mengganti strategy existing. Jalankan dua akun paralel:

Akun virtual	Exit policy
POSITION_100M	SL, PT, atau maksimum 40 bars
INTRADAY_EOD_100M	SL, PT, atau close hari entry

Dengan begini kita bisa menjawab pertanyaan penting:

Edge sistem ini muncul secara intraday, atau memang membutuhkan holding beberapa minggu?

Track record dua akun tidak boleh dicampur.

Alur akun INTRADAY_EOD_100M
Setelah market close hari T

Sistem membekukan rekomendasi:

BBCA BUY
ASII BUY
BMRI STRONG BUY

Journal mencatat:

status = SCHEDULED
signal_date = T
scheduled_entry_date = next trading day
source_strategy_hash
source_plan_id
data_snapshot_hash
code_commit

Belum ada harga entry pada tahap ini.

Hari T+1

Karena data sekarang berbentuk daily OHLC, seluruh kejadian T+1 baru dapat diselesaikan setelah OHLC hari tersebut tersedia.

Urutannya:

Entry      = open T+1
SL/PT      = dihitung dari actual entry
SL hit     = low <= stop
PT hit     = high >= target
Tidak hit  = exit pada close T+1

Prioritas resolusi:

1. Entry tidak valid → NO_FILL
2. SL dan PT sama-sama tersentuh → STOP
3. SL tersentuh → STOP
4. PT tersentuh → TARGET
5. Tidak ada yang tersentuh → EOD_CLOSE

Prioritas STOP ketika dua level tersentuh pada candle yang sama adalah asumsi konservatif yang sudah digunakan oleh paper-trading engine sekarang.

Keterbatasan data

Ini merupakan EOD paper simulation, bukan monitoring intraday real-time.

Dengan daily OHLC, sistem mengetahui bahwa high atau low menyentuh level, tetapi tidak mengetahui urutan tick sebenarnya. Karena itu:

SL dan PT bersamaan → STOP;
exit close menggunakan official closing value setelah market selesai;
sistem tidak berpura-pura pernah mengirim order sebelum market close.

Untuk virtual order yang benar-benar berubah status selama jam perdagangan, kita membutuhkan intraday feed.

Portfolio Rp100 juta

Buat satu account:

starting_cash = 100,000,000
cash          = 100,000,000
market_value  = 0
total_nav     = 100,000,000
currency      = IDR
allow_margin  = false
allow_short   = false
Position sizing

Untuk versi awal, gue sarankan memakai risk-based sizing dengan hard notional cap.

Contoh konfigurasi paper-test:

risk_per_trade       = 0.50% NAV
max_position_notional = 12.50% NAV
max_positions         = 8
max_gross_exposure    = 90% NAV
cash_buffer           = 10% NAV

Pada NAV Rp100 juta:

risk budget per trade = Rp500.000
max nominal per saham = Rp12.500.000

Formula:

risk_per_share = entry_price - stop_price

raw_quantity =
    risk_budget / risk_per_share

quantity =
    floor_to_board_lot(raw_quantity)

notional =
    quantity × entry_price

Kemudian:

quantity = min(
    risk-based quantity,
    max-position quantity,
    available-cash quantity
)

Jangan izinkan:

cash < 0
gross exposure > configured limit
quantity bukan kelipatan lot

Seluruh angka di atas harus berupa configuration version, bukan hardcoded di banyak file.

Struktur database
virtual_accounts
id
account_code
strategy_id
strategy_hash
execution_policy_hash
starting_cash
cash_balance
total_nav
status
created_at

Contoh:

INTRADAY_EOD_100M
POSITION_100M
virtual_orders
id
account_id
source_plan_id
source_signal_id
ticker
side
signal_date
scheduled_entry_date
intended_notional
quantity
status
reject_reason
strategy_hash
execution_policy_hash
created_at

Status:

SCHEDULED
FILLED
NO_FILL
REJECTED
CANCELLED
virtual_positions
id
account_id
order_id
ticker
quantity
entry_date
entry_price
stop_price
target_price
cost_basis
entry_fee
status
exit_date
exit_price
exit_reason
exit_fee
gross_pnl
net_pnl
return_pct
holding_bars

Exit reason:

STOP
TARGET
EOD_CLOSE
TIME_EXIT
REGIME_EXIT
MANUAL
virtual_trade_events

Gunakan append-only event journal:

RECOMMENDED
ORDER_SCHEDULED
ORDER_FILLED
STOP_SET
TARGET_SET
STOP_TRIGGERED
TARGET_TRIGGERED
EOD_CLOSE
NO_FILL
REJECTED

Ini lebih aman daripada hanya menyimpan current status karena seluruh lifecycle dapat diaudit.

virtual_nav
account_id
mark_date
cash_value
market_value
total_nav
realized_pnl
unrealized_pnl
gross_exposure
open_positions
Jangan jadikan journal sumber accounting

Sumber kebenaran harus:

orders
+ fills
+ positions
+ cash ledger

Journal merupakan tampilan dari event-event tersebut.

Kalau journal bisa diedit langsung dan sekaligus menjadi sumber cash/NAV, cepat atau lambat akan terjadi kondisi:

journal bilang CLOSED
position masih OPEN
cash belum menerima proceeds
NAV salah

Gunakan transaction per order resolution:

BEGIN

update order
insert/update position
update cash ledger
insert trade event
insert NAV mark

COMMIT

Kalau salah satu gagal, rollback semuanya.

Cron yang disarankan

Dengan data EOD sekarang:

19:30  Import OHLC dan broker data selesai
20:00  Resolve scheduled virtual orders hari ini
20:05  Apply STOP / TARGET / EOD_CLOSE
20:10  Update cash dan portfolio NAV
20:15  Generate/freeze rekomendasi untuk hari berikutnya
20:20  Create SCHEDULED virtual orders
20:25  Run reconciliation dan integrity checks

Urutannya penting: selesaikan order hari ini sebelum membuat order baru.

Biaya yang harus dimasukkan

Minimal:

buy fee
sell fee
slippage
lot rounding
cash limitation
missing-open no-fill
suspension/no-price handling

Untuk EOD_CLOSE, jangan selalu menganggap fill tepat di close tanpa friction. Gunakan:

virtual sell fill =
close × (1 - configured slippage)

Biaya dan execution policy harus masuk ke:

execution_policy_hash

Supaya perubahan fee, slippage, SL/PT, atau EOD-close rule memulai track record baru dan tidak mencampur hasil lama.

Test wajib

Sebelum dijalankan setiap hari, test minimal harus mencakup:

Modal awal tepat Rp100 juta.
Tidak bisa membelanjakan uang lebih dari cash.
Duplicate recommendation tidak membuat dua order.
Entry memakai T+1 open, bukan signal-day close.
SL dan PT satu candle menghasilkan STOP.
Hanya SL menghasilkan STOP.
Hanya PT menghasilkan TARGET.
Keduanya tidak tercapai menghasilkan EOD_CLOSE.
Missing open menghasilkan NO_FILL.
Fee dan slippage mengurangi cash/P&L.
Quantity dibulatkan sesuai lot.
NAV selalu sama dengan cash + market value.
Closed trade mengembalikan proceeds ke cash.
Strategy hash berbeda tidak boleh berbagi portfolio.
Restart job tidak menggandakan fill atau exit.
Rekomendasi implementasi

Gue akan membangunnya dalam dua tahap:

Tahap 1 — EOD Virtual Broker

Menggunakan OHLC daily yang sudah tersedia:

plan T
→ entry T+1 open
→ check T+1 high/low
→ SL/PT/EOD close
→ journal
→ NAV Rp100 juta

Ini bisa dibuat sekarang dan hasilnya tetap auditable.

Tahap 2 — Intraday Virtual Broker

Setelah tersedia intraday feed:

scheduled order
→ live simulated fill
→ real-time SL/PT monitoring
→ close-auction/EOD liquidation

Jangan membuat simulasi daily-OHLC terlihat seperti eksekusi real-time.

Kesimpulan

Gue setuju sistem virtual Rp100 juta dibuat sekarang. Namun jalankan sebagai dua eksperimen terpisah:

POSITION_100M
INTRADAY_EOD_100M

Current recommendation engine dibangun untuk horizon position, sehingga akun EOD harus diperlakukan sebagai challenger baru, bukan menggantikan track record existing. Sumber rekomendasinya boleh sama, tetapi execution policy, strategy identity, journal, cash, dan performance record harus benar-benar terisolasi.