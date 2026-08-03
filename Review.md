Temuan kritis terkait kemampuan prediksi
P0.1 — Backtest masih memakai informasi dari masa depan

Di backtest EXP-017, saham hanya dimasukkan ke cross-section apabila:

s.open[i + 1] !== null && s.open[i + 1] > 0

Artinya, ketika mengambil keputusan pada hari T, sistem sudah melihat apakah saham tersebut memiliki harga open valid pada T+1.

Itu merupakan bentuk tradeability look-ahead.

Sistem real pada hari T belum tahu:

apakah saham akan suspend besok;
apakah ada opening price;
apakah saham terkunci ARA/ARB;
apakah order dapat terisi;
apakah terjadi corporate action atau trading halt.

Dengan filter tersebut, backtest dapat menghindari secara otomatis saham yang ternyata tidak bisa diperdagangkan keesokan harinya.

Masalah yang sama juga terdapat pada backtest HI52W sebelumnya.

Perbaikan

Eligibility hanya boleh menggunakan data sampai hari T.

Pada execution simulator T+1:

jika tidak ada open → tandai NO_FILL;
jika suspend → tetap menjadi missed execution;
jika terkunci ARA/ARB → gunakan aturan fill konservatif;
jangan menghapus kandidat secara retroaktif.

Setelah diperbaiki, EXP-013, EXP-014, EXP-015, dan EXP-017 perlu dijalankan ulang.

P0.2 — Backtest dan forward strategy belum benar-benar memakai satu code path

Komentar di strategy_book.js mengatakan modul tersebut adalah single source of truth untuk backtest dan forward test. Namun backtest_broker_veto.js masih mengimplementasikan sendiri:

cross-section;
POSFRAC calculation;
veto construction;
buffering;
portfolio simulation.

Script EXP-017 tidak memanggil strategy_book.targetBook() secara langsung.

Akibatnya terdapat perbedaan konkret:

Backtest memeriksa open[i+1].
Live module tidak memeriksanya.
Beberapa syarat eligibility dapat drift.
Perubahan pada live module belum tentu mengubah backtest.

Jadi klaim “forward test menjalankan strategi yang sama persis” belum sepenuhnya benar.

Perbaikan

Backtest harus menggunakan:

strategyBook.targetBook(...)

langsung untuk setiap historical decision date.

Tidak boleh ada implementasi kedua atas strategi yang sama.

P0.3 — Verification test terlalu longgar dan reverse control-nya tidak bekerja

verify_strategy_book.js hanya mengharuskan live module berada di “plausible neighbourhood”, misalnya:

minExcessOverBase: 0.02
maxMDD: 0.25

Ia tidak membandingkan secara presisi:

target book setiap rebalance;
transaksi per tanggal;
equity curve;
ending portfolio value;
turnover;
biaya;
hasil split-half.

Lebih serius lagi, verifier mengirim:

reverseForTest: true

tetapi strategy_book.js tidak pernah membaca parameter reverseForTest.

Variabel hasil reverse juga dibuat tetapi tidak diuji atau dicetak. Dengan demikian, verifier belum memverifikasi kontrol reverse yang disebut sebagai kontrol paling menentukan.

Perbaikan

Verifier harus gagal jika salah satu dari ini berbeda:

Target book per date
Opened and closed tickers
Number of trades
Costs
Final portfolio value
Maximum drawdown
Full equity curve hash

Toleransi numerik boleh kecil, tetapi bukan sekadar “CAGR masih positif”.

P0.4 — “Forward test” saat ini belum merupakan forward test live

Cron menjalankan strategy_forward.js sekitar pukul 08.00 WIB.

Namun script memilih:

const lastI = tradingDates.length - 2;

Kemudian menggunakan:

execI = i + 1;
entryPrice = open[execI];

Pada pukul 08.00 sebelum market buka, bar lengkap terbaru biasanya adalah kemarin. Dengan length - 2, sistem:

mengambil keputusan dari dua hari lalu;
menggunakan open kemarin;
mencatat transaksi setelah open tersebut sudah diketahui.

Jadi prosesnya adalah delayed walk-forward replay, bukan prediksi yang benar-benar dibekukan sebelum execution terjadi.

Ini masih lebih baik daripada backtest biasa, tetapi belum menguji:

data tersedia tepat waktu;
keputusan dibuat sebelum open;
order benar-benar executable;
slippage aktual;
missed fill;
market impact;
kegagalan data pada hari keputusan.
Bentuk forward test yang benar

Tahap PLAN — setelah market close T

as_of_date
generated_at
strategy_version
data_snapshot_hash
target_book
reason
expected_execution_date
status = PLANNED

Tahap EXECUTION — market open T+1

actual_fill_price
fill_timestamp
fill_status
slippage
unfilled_reason
status = FILLED / MISSED / REJECTED

Plan tidak boleh dihitung ulang setelah harga T+1 diketahui.

P0.5 — Replay historis bercampur dengan forward data

strategy_forward.js mempunyai:

node strategy_forward.js --replay 60

Replay ini menulis ke tabel yang sama:

ft_strategy_positions
ft_strategy_log

Tidak ada kolom untuk membedakan:

LIVE
REPLAY
BACKFILL

Kemudian status menghitung semua posisi tertutup dari tabel yang sama.

Artinya, historical replay dapat ikut dihitung untuk:

jumlah 30 closed trades;
win rate;
average return;
promotion gate.

Track record seperti ini tidak boleh disebut forward performance.

Perbaikan

Tambahkan minimal:

run_mode ENUM('LIVE','REPLAY')
decision_created_at
data_available_at
execution_observed_at
strategy_hash
code_commit

Promotion gate harus menggunakan LIVE only.

P0.6 — Promotion gate belum benar-benar dihitung

strategy_forward.js --status hanya menghitung:

jumlah trade;
average net return;
win rate.

Namun output mencetak syarat:

Profit factor >= 1.10

Script tersebut tidak menghitung profit factor sama sekali.

Jadi sumber angka PF 0,72 yang disebut di README tidak terlihat berasal dari forward recorder kandidat ini.

Ini berbahaya karena repo mempunyai tiga subsistem berbeda yang disebut paper trading. Dokumentasinya sendiri memperingatkan agar metrik dari satu subsistem tidak dianggap sebagai metrik subsistem lain.

Perbaikan

Buat satu endpoint/report khusus:

strategy_id
run_mode
strategy_version
live_start_date
closed_positions
independent_rebalance_periods
portfolio_return
benchmark_return
excess_return
information_ratio
maximum_drawdown
turnover
implementation_shortfall
profit_factor
promotion_status
P0.7 — Jumlah trade bukan ukuran sample independen

Gate sekarang memakai minimum 30 closed trades.

Namun strategi memegang delapan saham sekaligus. Delapan posisi yang dibuka pada tanggal yang sama bukan delapan observasi independen karena semuanya dipengaruhi oleh:

IHSG regime yang sama;
market shock yang sama;
liquidity condition yang sama;
sector rotation yang sama.

Jadi 30 trades mungkin hanya berasal dari empat atau lima keputusan portfolio.

Gate harus memakai:

minimum jumlah rebalance independen;
minimum calendar duration;
block-bootstrap berdasarkan decision date;
bukan hanya jumlah posisi.

Saran minimum:

≥ 24 live rebalance decisions
≥ 12 bulan forward period
≥ 3 market conditions berbeda
≥ 50 actual fills
P1.1 — Survivorship bias masih besar

Backtest menggunakan ticker yang masih tersedia sekarang, lalu menerapkannya ke masa lalu. Script sendiri mengakui:

Tidak ada ticker yang delist di dalam universe.

Untuk strategi long-only dekat 52-week high, survivorship bias sangat mungkin mempercantik hasil karena saham yang gagal, delist, atau kehilangan likuiditas hilang dari universe historis.

EXP-017 juga tetap menggunakan universe yang survivorship-biased.

Perbaikan

Bangun point-in-time universe:

ticker
listing_date
delisting_date
suspension periods
historical liquidity eligibility
sector as-of date
corporate actions

Saham yang delist harus tetap ada sampai tanggal delisting dan menerima terminal treatment yang konservatif.

P1.2 — Corporate action belum terlihat ditangani

HI52W dihitung langsung dari raw close dan high:

close / max(high, 252 days)

Pada jalur strategi dan backtest yang gue periksa, belum terlihat penyesuaian eksplisit untuk:

stock split;
reverse split;
rights issue;
bonus shares;
special dividend.

Corporate action dapat menciptakan 52-week high palsu atau return palsu.

Minimal lakukan salah satu:

gunakan adjusted OHLC history;
bangun adjustment factor sendiri;
atau keluarkan window yang terkena corporate action dari riset.
P1.3 — Missing broker data berpotensi menjadi hidden factor

POSFRAC_60 hanya membutuhkan 35 data valid dari 60 hari.

Artinya dua saham dapat mempunyai:

Stock A: 35/60 observations
Stock B: 60/60 observations

tetapi dianggap setara.

Selain itu, saham tanpa POSFRAC tidak pernah terkena veto.

Missingness bisa berkorelasi dengan:

likuiditas;
kualitas coverage;
broker activity;
perubahan API;
saham kecil atau saham bermasalah.

Mungkin sebagian edge bukan berasal dari broker accumulation, melainkan dari pola data yang hilang.

Eksperimen wajib

Uji POSFRAC dengan minimum coverage:

35/60
45/60
50/60
55/60
60/60

Lalu laporkan edge per coverage bucket.

P1.4 — Kandidat masih tidak menang pada semua periode

EXP-017 memang mengalahkan base strategy di kedua half.

Tetapi kandidat masih kalah dari eligible universe pada seluruh periode pertama:

P1 excess: −3,86%
P2 excess: +12,43%

Semua keuntungan relatif berasal dari periode kedua.

Jadi kesimpulan yang valid adalah:

Broker veto memperbaiki HI52W baseline secara konsisten.

Bukan:

Strategi sudah konsisten mengalahkan market/universe.

Itu dua klaim yang berbeda.

P1.5 — Terlalu banyak konfigurasi dilihat pada data yang sama

EXP-017 menguji:

12 varian veto;
9 kombinasi rebalance dan buffer;
full period;
split-half;
beberapa veto dose.

Walaupun tim memilih plateau dan tidak hanya memilih titik maksimum, konfigurasi akhir tetap dipilih setelah melihat data.

Data broker hanya tersedia sekitar 2,2 tahun, sehingga tidak ada untouched historical test set yang tersisa.

Solusi terbaik sekarang bukan optimasi tambahan, tetapi:

Bekukan strategi dan biarkan waktu menghasilkan out-of-sample data baru.

Jangan ubah threshold, window, buffer, dan rebalance berdasarkan hasil forward bulanan.

P1.6 — Signal yang sudah gagal masih memengaruhi sizing

conviction.js sudah jujur menulis bahwa harmonic score tidak mempunyai predictive power.

Namun:

smart-money harmonic masih mendapat tier S;
size multiplier masih 1.0;
ABCD masih mendapat multiplier 0.8.

Jadi labelnya sudah direvisi, tetapi tindakan sistemnya belum.

Ini menghasilkan kondisi:

“Signal ini tidak tervalidasi, tetapi tetap diberi ukuran terbesar.”

Hal yang sama perlu ditinjau untuk AWO Full, karena registry sudah menunjukkan AWO Full lebih buruk daripada random entry.

Rekomendasi

Pisahkan model menjadi:

PRODUCTION_CANDIDATE
HI52W + regime + broker veto

SHADOW_ONLY
AWO Full
Harmonic
Optimizer challenger
Other experimental scanners

Model shadow boleh ditampilkan, tetapi tidak boleh memengaruhi:

position sizing;
portfolio exposure;
promotion metrics;
combined conviction.
Kekuatan prediksi yang benar-benar dimiliki sekarang

Saat ini bukti yang tersedia adalah:

Cukup kuat

Broker persistence dapat mengurutkan future underperformance.

Ini adalah sinyal veto/avoid dengan horizon sekitar 20–60 hari.

Lemah tetapi menarik

HI52W mempunyai positive cross-sectional IC, tetapi kecil dan hampir habis oleh turnover.

Belum terbukti
AWO composite BUY/SELL
Harmonic pattern
Conviction score
Automatic weighting
Entry/stop optimizer
Prediksi harga absolut

Jadi output yang paling jujur sekarang bukan:

BBCA akan naik 8%

Melainkan:

BBCA berada pada ranking relatif tinggi,
tidak terkena broker-persistence veto,
dan market regime mengizinkan exposure.

Expected function:
outperform eligible universe over 2–8 weeks.

Confidence:
research candidate, not yet live-validated.
Urutan pekerjaan berikutnya
Sprint P0 — Wajib sebelum menilai ulang edge
Hapus penggunaan open[i+1] dari eligibility.
Jadikan strategy_book.targetBook() satu-satunya implementation.
Re-run EXP-013, 014, 015, dan 017.
Buat exact parity test backtest vs strategy module.
Pisahkan LIVE dan REPLAY.
Implementasikan two-stage plan dan execution.
Hitung portfolio equity dan benchmark secara live.
Hitung promotion gate secara nyata.
Masukkan strategy version dan code hash.
Nonaktifkan sizing dari model yang sudah gagal validasi.
Sprint P1 — Setelah hasil P0 tetap positif
Point-in-time universe.
Corporate-action adjusted prices.
ARA/ARB dan no-fill simulation.
POSFRAC coverage sensitivity.
Cost sensitivity: 0,5%, 0,75%, 1,0%.
Block-bootstrap confidence interval.
Breakdown per year, regime, liquidity tier, dan sector.
Forward benchmark-relative monitoring.
Gate baru yang gue sarankan

Strategi tidak boleh disebut terbukti sebelum:

BACKTEST
No lookahead/tradeability leakage
Point-in-time universe atau survivorship haircut
Positive excess after realistic costs
Stable sign across subperiods
No single period dominates the result
Code parity exact

FORWARD
LIVE records only
At least 12 calendar months
At least 24 independent rebalance decisions
Positive benchmark-relative return
Positive information ratio
Drawdown no worse than baseline
Slippage within modeled assumption
No parameter changes during evaluation
Kesimpulan akhir

Revisi tim sudah meningkatkan kualitas riset secara signifikan. Terutama experiment registry, kontrol random/reverse, pembekuan kandidat, dan keberanian menolak AWO serta harmonic ketika data tidak mendukung.

Namun terdapat tiga blocker utama:

Tradeability look-ahead pada backtest.
Backtest dan forward candidate belum memakai implementation yang sama persis.
Forward recorder sekarang masih delayed historical replay dan bercampur dengan replay data.

Sebelum ketiganya diperbaiki dan EXP-017 dijalankan ulang, angka CAGR 16,73% dan excess +8,71% harus dianggap promising research result, bukan bukti bahwa sistem sudah mampu memprediksi harga secara konsisten.