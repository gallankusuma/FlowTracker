Update untuk EXP-026 R2 sudah ada di commit `7147256`.

R2 ter-push 2026-08-11 16:26:48 +0700, sekitar 5 menit setelah review R1 ditulis — jadi wajar belum masuk cakupan review kemarin.

Tiga finding dari review sebelumnya sudah ditutup di commit tersebut:

* **P1 — Breadth universe reproducibility:** sekarang menggunakan `MARKET_BREADTH_UNIVERSE_V1`, membership dipin dengan SHA-256 dan fail-closed. Jadi perubahan membership tidak bisa lolos hanya karena jumlah ticker tetap sama.
* **P2 — Exact EXP-025 breakout parity:** contract sekarang exact `i-20 .. i-1`, strictly before entry; entry bar tidak ikut prior-high window. `test_breakout_parity.js` ditambahkan sebagai deterministic parity test dan lolos 16/16 — sekarang CI-verified, bukan lagi self-reported; lihat poin 2 di housekeeping.
* **P2 — Significance wording:** verdict sekarang dihitung dari CI yang admissible. Untuk horizon overlapping, significance hanya boleh berasal dari canonical non-overlapping sample; daily CI tetap descriptive.

Catatan penting: **angka EXP-026 belum di-re-run setelah contract cleanup ini.** Database tetap melayani produksi lewat koneksi pool yang sudah hangat, tetapi setiap koneksi baru dari `.env` ditolak sejak password `erp_user` dirotasi 2026-08-11 05:47 UTC. Semua script CLI — termasuk EXP-026 — karena itu tidak bisa dijalankan. Jadi `parityFlips`, breakout enrichment `13.4% vs 4.0%`, decile hump, dan angka R2 lainnya belum boleh dianggap hasil final/frozen.

Jadi status yang tepat untuk `7147256` adalah:

**Contract/methodology findings: resolved.
Empirical R2 result: pending rerun.
EXP-026: belum final freeze.**

Dua housekeeping item terpisah yang masih tersisa:

1. Default branch repo masih `main` dengan history terpisah, sehingga membuka root repo bisa memberi kesan repo kosong. Ini bukan blocker EXP-026 saat ini, tapi sebaiknya dibereskan terpisah.
2. GitHub CI/status checks — **sudah beres.** Penyebabnya ketemu: GitHub Actions ternyata disabled di level repo, jadi workflow yang sudah ter-commit sejak 2026-08-04 tidak pernah dieksekusi. Itu sebabnya `d26957b` memang benar-benar nol status check, persis seperti yang dilaporkan. Actions kini diaktifkan dan `bb4b00e` menjadi commit pertama yang menghasilkan check. Suite `test:unit` lolos **398 assertion di 17 file, 0 gagal**, tanpa dependency database.

   Konsekuensinya untuk cara membaca commit kami: mulai `bb4b00e`, jumlah test bukan lagi commit-reported evidence — siapa pun bisa memverifikasinya sendiri dari tab Actions. Yang tetap TIDAK dijalankan CI adalah `verify_strategy_book.js` dan `test:integration`, karena keduanya butuh database terisi; keduanya jalan di VPS lewat `scraper/predeploy_check.sh`. Jadi tick hijau di GitHub bukan berarti seluruh suite sudah jalan.
