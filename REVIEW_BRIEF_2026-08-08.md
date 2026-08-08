# Review Brief — 2026-08-08

**Untuk tim review. Ini bukan balasan atas review; ini laporan masalah baru yang ditemukan saat mengerjakan prasyarat Pattern Replay.**

Ringkas: mesin sinyal IDX buta selama 8 hari, menyajikan angka basi sebagai angka hari ini, dan gerbang kesehatannya sendiri melaporkan "passed" selama itu berlangsung. Sudah diperbaiki sebagian. Akar penyebabnya belum, dan tidak bisa diperbaiki dengan kode.

---

## 1. Bagaimana ini ketemu

Review Pattern Replay menetapkan satu prasyarat sebelum fitur dibangun:

> "berapa hari history yang benar-benar lengkap? … Karena kalau hari yang hilang diperlakukan nol, pattern-nya palsu."

Audit `idx_signal_history` untuk menjawab itu yang membuka sisanya. Prasyarat itu benar dan menyelamatkan kita dari membangun di atas data busuk.

---

## 2. Yang sudah dikerjakan dan terverifikasi

### 2.1 Pembersihan 9 tanggal hantu — SELESAI

979 baris di 9 tanggal non-sesi dihapus dari `idx_signal_history`:
`2026-05-01, 05-14, 05-15, 05-23, 05-27, 05-28, 05-30, 06-01, 06-06`

Diverifikasi lewat dua jalur independen sebelum dihapus: **nol** price bar dan **nol** IHSG bar di kesembilan tanggal. Tiga di antaranya hari Sabtu, sisanya libur bursa. Semuanya bersumber `backfill_v2`, jadi ini cacat generator backfill, bukan feed live.

Backup pra-hapus: `/root/backups/idx_signal_history-before-cleanup-2026-08-08.sql` (VPS).
Sesudah: 17.183 baris, 119 hari, nol tanggal non-sesi tersisa.

Kelas cacat yang sama dengan purge phantom price session 2026-08-04.

### 2.2 Kekhawatiran "27 tanggal multi-source" — TIDAK TERBUKTI

Awalnya saya usulkan aturan prioritas sumber (`live` menang). **Tidak diperlukan.** Query menunjukkan **nol** pasangan `(data_date, stock_code)` duplikat. Tanggal-tanggal itu hanya berisi ticker berbeda dari sumber berbeda; tidak ada baris yang bertabrakan, tidak ada look-ahead dari situ. Usulan saya salah dan ditarik.

### 2.3 Penolakan basi di `/api/signal-scanner` — TER-DEPLOY

`server.js:6158`. Endpoint mengembalikan **503** alih-alih menyajikan skor basi sebagai hari ini.

Terverifikasi live:
```
HTTP 503
{"source":"stale-broker-feed","stale":true,"sessionsBehind":5,
 "latestBrokerDate":"2026-07-31","latestSessionDate":"2026-08-07"}
```

**Keputusan desain yang minta ditinjau:** jam scanner sengaja **tidak** dipindahkan ke tabel harga. `idx_stock_prices` current sampai 08-07, jadi memindahkannya akan membuat endpoint "hidup" lagi — tapi f1 konsentrasi dan seluruh keluarga faktor broker bersumber dari tabel broker yang sama matinya. Hasilnya bukan sinyal lebih segar, melainkan sinyal percaya diri di atas input yang tidak ada. Menolak lebih jujur daripada mengarang. **Kalau tim tidak setuju, ini titik yang paling layak diperdebatkan.**

Nol baris matematika skor berubah, jadi `strategy_hash` tidak bergeser.

### 2.4 Check `brokerDataCurrent` di gerbang burn-in — TER-DEPLOY

`watchdog.js:521`. Terverifikasi live:
```
session_date 2026-08-07 · passed 0 · brokerDataCurrent false
priceDataCurrent true · failures_json ["brokerDataCurrent"]
```

---

## 3. Temuan utama, dan bagian yang paling perlu dikritik

**Feed broker mati 2026-07-31. Ketiga tabel serentak:**

| tabel | terbaru |
|---|---|
| `idx_broker_summary` | 2026-07-31 |
| `idx_concentration` | 2026-07-31 |
| `idx_broker_flow_detail` | 2026-07-31 |
| `idx_stock_prices` | 2026-08-07 |
| `idx_ihsg_history` | 2026-08-07 |

`/api/signal-scanner` mengambil notion "hari ini" dari `idx_broker_summary`, bukan dari harga (`server.js:6152`). Jadi selama 8 hari endpoint menyajikan skor 31 Juli, **bertanggal 31 Juli**, tanpa satu pun tanda basi di UI. Snapshot yang ditulis di akhir handler menulis ulang 31 Juli dengan nilai identik, sehingga jumlah baris pun tidak pernah bergerak — tidak ada sinyal apa pun bahwa ada yang salah.

### 3.1 Gerbang burn-in punya titik buta persis di tempat kegagalannya

15 check, semua lulus, tiap malam:
```json
"priceDataCurrent": true,   ← jujur, harga memang current
"calendarCurrent":  true,   ← jujur, kalender memang benar
...
```
**Tidak ada satu pun check yang menanyakan apakah data broker masih hidup.**

### 3.2 Yang paling mengganggu: informasinya sudah ada, tapi tidak mengikat

Watchdog **sudah** mendeteksinya, dan sudah lama:

> `broker is stale (idx_broker_summary): 5 trading days behind (tolerance 2). Not auto-repaired: this feed is owned by another job…`

Tapi itu ditulis sebagai **WARNING**. Warning tidak mengikat apa pun, jadi di malam yang sama gerbang burn-in tetap menulis `passed: 1`. Sistem tahu, mengatakannya, dan tetap meluluskan dirinya sendiri.

**Ini pertanyaan untuk tim, dan menurut saya lebih penting daripada bug-nya:** berapa banyak warning lain di sistem ini yang berada dalam posisi sama — benar, terdeteksi, tercetak, dan tidak mengikat apa pun?

---

## 4. Dampak ke burn-in

Burn-in Virtual Broker V2 mulai **2026-08-05**. Feed broker mati **2026-07-31**.

**Ketiga sesi burn-in yang tercatat seluruhnya berjalan di atas data broker basi.** Bukan sebagian — tidak ada satu pun sesi yang pernah melihat data broker segar.

Tidak ada baris yang saya hapus. Burn-in mereset dirinya sendiri dengan benar: streak menuntut sesi berturut-turut, sesi 08-07 sekarang gagal, jadi hitungan kembali nol. Tiga sesi hijau lama tetap tercatat sebagai bukti bahwa sistem pernah salah menilai dirinya sendiri. Menurut saya itu harus tetap terbaca, bukan dibersihkan.

Catatan tambahan: `identity_hash` berganti tiga kali dalam satu hari 05 Agustus. Identitas yang berjalan sekarang baru punya satu sesi. Hitungan 10 sesi praktis belum pernah benar-benar berjalan. **Belum saya selidiki kenapa identitas bergeser sesering itu — ini kandidat kuat untuk ditinjau.**

---

## 5. Masih terbuka

1. **Feed broker tetap mati.** Sumbernya akun flowtracker.id yang kena ban permanen. Kedua perbaikan di atas membuat sistem jujur soal kebutaannya, **bukan menyembuhkannya**. Selama tidak ada pengganti, scanner menolak tiap hari dan burn-in tidak akan pernah mencapai satu sesi bersih. Itu perilaku yang benar, bukan bug baru.
2. **6 sesi bursa asli tanpa snapshot sama sekali:** `2026-06-15, 06-22, 06-29, 07-13, 07-15, 07-16` — price bar-nya lengkap. Ditambah 5 sesi Agustus yang hilang karena feed mati. Jendela H-5…H-1 yang melewatinya akan diam-diam jadi 4 hari sambil tetap dilabeli 5 hari. **Pattern Replay harus MENOLAK window tidak lengkap — bukan menggeser, bukan mengisi nol.**
3. **Snapshot ditulis sebagai efek samping HTTP request**, bukan job terjadwal. Tidak ada satu pun cron memanggil `/api/signal-scanner`. Riwayat hanya bertambah kalau ada manusia membuka halaman. Cron sengaja **belum** dipasang: memasangnya di atas jam yang mati hanya akan membuat sistem terlihat sehat.
4. **Ketidakkonsistenan yang saya buat sendiri:** toleransi check baru = 1 sesi, warning lama = 2. Di lag tepat 2, gerbang gagal tapi warning diam. Tidak berbahaya, tapi dua angka untuk pertanyaan yang sama akan membingungkan nanti. Layak disamakan jadi 2.
5. **Periode `live` hanya ~22 hari.** Riset winners-vs-controls (review item 8–10) harus dibatasi ke situ. Sampel ini kecil — saya sebut sekarang, sebelum ada hasil yang kelihatan meyakinkan.

---

## 6. Koreksi atas pernyataan saya sendiri

Dicatat karena tim ini bernilai justru saat menangkap yang meleset:

- Saya bilang "burn-in mulai sekitar 22 Juli". **Salah.** 22 Juli adalah tanggal snapshot sinyal jadi kontinu; burn-in mulai 5 Agustus. Dua hal berbeda yang saya samakan.
- Saya bilang riwayat hilang **karena** halaman tidak dibuka. **Tidak lengkap.** Itu menjelaskan hari-hari bolong Juni–Juli, tapi sama sekali bukan sebab berhentinya di 31 Juli.
- Saya menduga panggilan endpoint **menimpa** snapshot 07-31 dengan faktor hari ini. **Salah.** Diff terhadap backup: nol baris berubah. Tidak ada data yang rusak.
- Saya mengusulkan aturan prioritas sumber untuk 27 tanggal. **Tidak diperlukan** — nol duplikat.

---

## 7. Status deploy

| | |
|---|---|
| `flowtracker-scraper` | restart 44 → 45, `server.js` + `watchdog.js` ter-deploy, diverifikasi live |
| `flowtracker` (frontend) | tidak tersentuh |
| `strategy_hash` | tidak bergeser (nol perubahan matematika skor) |
| Backup | `/root/backups/idx_signal_history-before-cleanup-2026-08-08.sql` |

---

## 8. Yang saya minta ditinjau

1. **Keputusan menolak vs. memindahkan jam ke tabel harga** (§2.3) — titik paling layak diperdebatkan.
2. **Warning yang tidak mengikat** (§3.2) — audit menyeluruh, bukan hanya kasus ini.
3. **`identity_hash` bergeser 3× dalam sehari** (§4) — belum diselidiki.
4. **Kontrak refuse-on-incomplete untuk Pattern Replay** (§5.2) sebelum P1 dikerjakan.
5. **Opsi pengganti feed broker** — ini yang sekarang menghalangi semuanya.
