Verdict

Belum selesai sepenuhnya di repository yang sekarang terbaca.

Perbaikan pada backtest EXP-017 memang sudah masuk. Namun perubahan untuk forward-test live, pemisahan replay, promotion gate, verifier, scheduler, dan pencatatan hasil rerun belum terlihat.

Jadi kemungkinan:

tim baru menyelesaikan sebagian perubahan;
perubahan sisanya belum di-push;
atau masih berada di working copy/VPS dan belum masuk GitHub.
Status per komentar terakhir
Item	Status
Decision tidak memakai open[T+1]	✅ Selesai pada EXP-017
EXP-017 memakai strategy_book.targetBook()	✅ Selesai
NO_FILL untuk pembelian	✅ Selesai
Random/reverse veto melalui shared strategy module	✅ Selesai
Harmonic signal diturunkan sizing-nya	✅ Selesai
Sell NO_FILL mempertahankan posisi	❌ Belum
Point-in-time universe	❌ Belum
LIVE terpisah dari REPLAY	❌ Belum
PLAN dan FILL dua tahap	❌ Belum
Strategy/code/data version	❌ Belum
Profit factor dihitung nyata	❌ Belum
Exact backtest-live parity test	❌ Belum
Verifier masuk npm test	❌ Belum
Rerun EXP-017 dicatat sebagai eksperimen baru	❌ Belum
Cron plan/fill terpisah	❌ Belum
Temuan yang masih blocking
1. Forward test masih versi lama

strategy_forward.js yang sekarang ada masih menerima:

--date
--replay
--status

Belum ada command seperti:

plan
fill
mark
status

Script masih menghitung keputusan dan langsung membaca open[i+1] pada proses yang sama. Dengan begitu, keputusan belum dibekukan sebelum harga execution diketahui.

Ini berarti statusnya masih:

Delayed historical walk-forward recorder, belum live forward test yang murni.

2. Replay masih bercampur dengan live

Schema tabel masih tidak mempunyai:

run_mode
decision_timestamp
execution_timestamp
strategy_version
code_commit
data_snapshot

--replay masih menulis ke tabel ft_strategy_positions dan ft_strategy_log yang sama dengan proses normal.

Akibatnya, historical replay masih berpotensi masuk ke:

jumlah closed trades;
win rate;
average return;
promotion evaluation.

Ini harus dipisahkan sebelum angka apa pun disebut forward performance.

3. Promotion gate masih berupa tulisan

Status masih hanya mengambil:

COUNT(*)
AVG(net_pct)
SUM(net_pct > 0)

Namun output tetap menyebut:

profit factor >= 1.10

Tidak ada kalkulasi gross profit dibagi gross loss. Tidak ada benchmark-relative return, maximum drawdown, information ratio, ataupun jumlah rebalance independen.

Jadi gate belum benar-benar dijalankan oleh sistem.

4. Point-in-time universe belum diperbaiki

Forward dan backtest masih melakukan filter global:

if (s.placed < 400 || s.nConc < 200) {
  series.delete(ticker);
}

Jumlah placed dan nConc tersebut dihitung memakai seluruh dataset.

Pada keputusan historis 2024, sistem sudah mengetahui bahwa sebuah saham nantinya akan memiliki 400 price bars dan 200 concentration observations. Ini masih full-sample coverage look-ahead.

Eligibility seharusnya diperiksa per tanggal keputusan:

price history available through T
concentration history available through T
liquidity through T
listing status through T
5. Exact parity verifier belum masuk

verify_strategy_book.js belum terlihat diperbarui dari versi yang:

hanya memeriksa CAGR berada pada rentang yang masuk akal;
tidak membandingkan trade-by-trade;
tidak membandingkan equity curve hash;
memakai reverseForTest, sementara parameter tersebut tidak digunakan oleh strategy_book;
tidak memverifikasi reverse control secara nyata.

Lebih penting lagi, verifier tidak terdapat dalam perintah npm test. Test suite sekarang masih hanya menjalankan sepuluh test lama.

Parity test harus memverifikasi tepat:

target tickers per decision date
buy events
sell events
NO_FILL events
costs
cash
holdings
equity value per period
final portfolio value
maximum drawdown
6. Cron masih satu tahap

Dokumentasi cron masih berisi:

0 1 * * 1-5 node strategy_forward.js

Belum ada pemisahan:

plan after close
fill after next market open
mark after close

Satu command pukul 08.00 WIB masih menjalankan model lama.

7. Experiment registry belum diperbarui

BACKTEST_EXPERIMENTS.md masih berakhir pada EXP-018 dan masih memiliki bagian Open follow-ups lama. Belum ada eksperimen baru, misalnya:

EXP-019 — EXP-017 re-run after look-ahead and shared-code fixes

Registry belum menampilkan angka terkoreksi setelah:

menghapus tradeability look-ahead;
memakai shared target-book implementation;
mencatat NO_FILL;
memperbaiki benchmark eligibility.

Karena itu, angka lama seperti CAGR 16,73% dan excess +8,71% belum bisa digunakan sebagai hasil dari implementasi terbaru.

Perbaikan yang memang sudah bagus

Pada sisi positif, tim sudah menyelesaikan bagian yang cukup penting:

strategy_book.js sekarang menyediakan vetoSelector;
backtest EXP-017 menggunakan targetBook() yang sama dengan production decision module;
buy-side NO_FILL sudah dicatat;
eligibility tidak lagi menghapus saham hanya karena tidak mempunyai open pada hari berikutnya;
random dan reverse control tidak perlu membuat ulang ranking dan buffering;
harmonic sizing sudah diturunkan setelah tidak menunjukkan edge.

Perubahan ini menaikkan integritas research backtest secara nyata.

Kesimpulan

Research backtest-nya sudah lebih baik, tetapi forward validation infrastructure belum selesai.

Status sistem saat ini:

Backtest candidate improved — live predictive edge still not independently validated.

Prioritas tim berikutnya seharusnya bukan menambah indikator, tetapi menyelesaikan lima hal ini:

Buat plan dan fill sebagai dua proses terpisah.
Pisahkan LIVE dan REPLAY secara permanen.
Hilangkan full-sample universe filter.
Buat promotion report yang menghitung metrik secara nyata.
Jalankan ulang EXP-017 dan append hasilnya sebagai eksperimen baru.

File strategy_forward.js yang ada di GitHub memiliki SHA yang sama dengan versi audit sebelumnya. Jadi bila tim merasa sudah memperbaikinya, perubahan itu belum masuk ke branch master yang terhubung ke sini.