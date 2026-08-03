Hasil pemeriksaan
Item review sebelumnya	Status
Hapus penggunaan open[T+1] dari eligibility EXP-017	✅ Selesai
Gunakan strategy_book.targetBook() pada EXP-017	✅ Selesai
Bersihkan look-ahead di EXP-013/014	✅ Source sudah diperbaiki
Perlakukan saham tanpa open sebagai NO_FILL	🟡 Hanya buy-side
Exact parity backtest vs forward	❌ Belum
Pisahkan LIVE dan REPLAY	❌ Belum
Pisahkan tahap PLAN dan FILL	❌ Belum
Promotion gate dihitung nyata	❌ Belum
Strategy version dan code hash	❌ Belum
Nonaktifkan sizing model yang gagal	🟡 Sebagian
Rerun dan dokumentasikan hasil terkoreksi	❌ Belum terlihat
Yang sudah benar-benar diperbaiki
1. Tradeability look-ahead EXP-017 sudah dihapus

Sekarang backtest_broker_veto.js tidak lagi menyaring kandidat berdasarkan keberadaan harga open esok hari. Keputusan dibuat lewat:

sb.targetBook({
  series,
  i,
  ihsgClose: ihsg,
  ihsgSma: ihsgSMA,
  currentHoldings: [...held.keys()],
  opts: { ... }
})

Harga T+1 baru dibaca pada tahap execution. Jika tidak tersedia, buy dicatat sebagai NO_FILL. Ini perbaikan yang tepat dan material.

2. EXP-017 sekarang memakai decision engine yang sama

strategy_book.js ditambah vetoSelector, sehingga random control, reverse control, dan dosis veto dapat diuji tanpa menyalin ulang eligibility, ranking, POSFRAC, dan buffering. Ini menutup sumber drift terbesar antara research dan production.

3. Backtest HI52W dan risk layers juga dibersihkan

backtest_hi52w_portfolio.js dan backtest_risk_layers.js sudah tidak memakai open[i+1] untuk menentukan eligibility. Ranking sekarang hanya memakai data yang tersedia sampai bar keputusan i.

4. Harmonic signal sudah diturunkan

Harmonic yang sebelumnya memperoleh tier S dan sizing 1,0× sekarang diturunkan menjadi tier C dengan multiplier 0,25 karena EXP-018 tidak menemukan predictive power. Ini sudah lebih konsisten antara bukti riset dan tindakan sistem.

Blocker yang masih tersisa
P0.1 — Sell NO_FILL masih salah

Pada EXP-017, ketika sistem ingin menjual tetapi harga open T+1 tidak tersedia, kode tetap menghapus posisi:

const px = series.get(t).open[execI];
if (px > 0) cash += u * px * (1 - SELL_COST);
held.delete(t);

Jadi jika px tidak valid:

tidak ada uang hasil penjualan;
posisi tetap dihapus;
nilainya efektif dianggap nol;
kejadian tidak dicatat sebagai sell NO_FILL.

Ini bukan simulasi eksekusi yang benar. Posisi seharusnya tetap terbuka sampai bisa dijual, bukan dihapus tanpa proceeds. Masalah yang sama masih terlihat pada backtest HI52W dan risk-layer.

Bentuk yang benar:

if (!(px > 0)) {
  sellNoFill++;
  continue; // keep holding
}

cash += units * px * (1 - SELL_COST);
held.delete(t);

Saat mark-to-market, posisi tanpa open sebaiknya dinilai memakai last known close, bukan bernilai nol.

P0.2 — Universe masih memakai informasi masa depan

Sebelum backtest dimulai, ticker disaring menggunakan total observasi pada seluruh dataset:

if (s.placed < 400 || s.nConc < 200) series.delete(t);

Ini berarti ticker pada tahun 2024 hanya masuk universe jika sistem sudah tahu ticker tersebut kelak memiliki minimal 400 price bars dan 200 broker observations.

Itu masih merupakan full-sample universe look-ahead dan survivorship/coverage bias. Filter tersebut juga masih dipakai oleh forward recorder.

Yang seharusnya diperiksa pada setiap tanggal keputusan:

Historical bars available as-of T
Broker observations available as-of T
Liquidity available as-of T
Listing and suspension status as-of T

Jangan memakai jumlah data yang baru diketahui pada akhir sample.

P0.3 — Forward test masih delayed replay

strategy_forward.js masih menjalankan keputusan dan execution sekaligus. Script menentukan:

const lastI = tradingDates.length - 2;
execI = i + 1;

Lalu langsung membaca open[execI] dan menyimpan transaksi. Artinya keputusan baru direkam setelah harga execution tersedia di database. Ini belum merupakan forward test yang membekukan keputusan sebelum market buka.

Cron juga masih hanya menjalankan satu perintah pukul 08.00 WIB:

node strategy_forward.js

Belum ada lifecycle terpisah untuk plan setelah close dan fill setelah open.

Format yang diperlukan:

strategy_forward.js plan
strategy_forward.js fill
strategy_forward.js mark
strategy_forward.js status

plan menyimpan target tanpa harga esok hari. fill baru membaca actual open setelah market buka.

P0.4 — Replay dan live masih tercampur

Argument masih berupa:

--replay 60

Tetapi tabel tidak mempunyai run_mode, source, atau is_replay. Replay menulis ke tabel yang sama dengan live forward data.

Kolom minimum:

run_mode: LIVE | REPLAY
decision_timestamp
execution_timestamp
strategy_version
code_commit
data_snapshot

Promotion gate hanya boleh membaca run_mode = LIVE.

P0.5 — Promotion gate masih belum dihitung

Status hanya mengambil:

jumlah transaksi;
average net;
win rate.

Tetapi console tetap menyebut syarat profit factor >= 1.10, walaupun tidak ada perhitungan profit factor dalam query atau logic tersebut.

Belum ada perhitungan:

profit factor;
portfolio equity;
benchmark return;
excess return;
maximum drawdown;
independent rebalance count;
information ratio;
actual implementation shortfall.

Jadi gate saat ini masih berupa teks, belum enforcement.

P0.6 — Verifier belum diperbaiki

verify_strategy_book.js masih menggunakan toleransi longgar:

minExcessOverBase: 0.02
maxMDD: 0.25

Ia hanya memeriksa arah umum, bukan exact parity transaksi dan equity curve. Selain itu, verifier masih mengirim reverseForTest: true, tetapi strategy_book.js tidak membaca parameter tersebut. Variabel reverse juga tidak pernah diuji.

Verifier yang benar harus membandingkan:

Target book per date
Buy/sell/no-fill events
Trade count
Cost paid
Equity curve hash
Final value
Maximum drawdown

Dan verify_strategy_book.js belum masuk ke perintah npm test, sehingga tidak otomatis dijalankan bersama suite utama.

P0.7 — Hasil rerun belum masuk experiment registry

Kode backtest sudah diubah, tetapi BACKTEST_EXPERIMENTS.md masih berakhir pada EXP-018 dan masih menyimpan angka EXP-017 lama. Tidak ada entry baru yang memperlihatkan hasil setelah:

menghapus open[T+1] eligibility;
menggunakan shared strategy module;
menambahkan no-fill execution.

Registry bahkan masih menandai sejumlah follow-up predictive-validation sebagai belum selesai.

Jadi angka lama seperti CAGR 16,73% dan excess +8,71% tidak boleh otomatis dianggap tetap berlaku. Perubahan eligibility dapat mengubah universe, turnover, return, dan drawdown.

P1 — Random control belum exact-size

Random control sekarang memakai Bernoulli selection:

for (const r of rows) {
  if (rng() < variant.veto) banned.add(r.ticker);
}

Artinya “random 20%” tidak selalu menghapus jumlah nama yang sama dengan real veto 20%. Untuk kontrol mekanis yang benar-benar comparable, random control harus memilih tepat:

k = Math.floor(eligibleWithData.length * 0.20)

nama secara seeded random.

P1 — Model gagal masih memengaruhi sizing

Harmonic sudah diturunkan menjadi 0,25×, tetapi belum benar-benar shadow-only. AWO BUY/SELL juga masih menerima multiplier 0,4× atau 0,8× walaupun flagship AWO composite belum menunjukkan edge.

Untuk fase validasi, output yang tidak terbukti sebaiknya:

sizeMultiplier = 0
mode = SHADOW_ONLY

Supaya performance kandidat HI52W + broker veto tidak tercampur dengan model yang sudah gagal.

Kesimpulan audit

Perbaikan core backtest sudah bagus dan substantif. Dua isu terpenting sudah ditangani:

keputusan tidak lagi melihat open[T+1];
EXP-017 sekarang memakai strategy_book.targetBook().

Tetapi bukti predictive edge belum dapat dinaikkan statusnya karena:

sell no-fill masih salah;
universe masih memakai full-sample coverage;
forward test belum benar-benar forward;
replay masih tercampur;
verifier masih lemah;
corrected backtest results belum direrun dan dicatat.
Penilaian sekarang
Area	Sebelumnya	Sekarang
Research discipline	8.5	8.5
Backtest decision integrity	5.0	7.0
Backtest/live code parity	4.0	6.5
Execution realism	3.5	4.5
Forward-test validity	3.0	3.0
Evidence of tradeable edge	4.0	4.5

Verdict: kandidatnya tetap menarik, dan engineering research-nya membaik. Namun sebelum corrected EXP-017 direrun dan forward pipeline benar-benar dibekukan sebelum execution, sistem masih berstatus:

Promising predictive research candidate — belum proven trading edge.

Gue belum bisa memvalidasi angka hasil akhirnya karena database MySQL historis dan output rerun tidak tersedia di repository.