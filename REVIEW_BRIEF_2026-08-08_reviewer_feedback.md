Tidak ada P0 di dokumennya. P0 ada di sistem: broker feed masih mati sehingga scanner dan burn-in memang harus tetap fail-closed.

Yang gue ubah sebelum freeze
Severity	Bagian	Masalah	Perbaikan
P1	Short version	“stale numbers dated as today” bertentangan dengan §3 yang bilang tetap dated 31 July	Ganti menjadi “serving 31 July data as the latest available state without a staleness refusal or explicit warning.”
P1	Short version	“root cause … cannot be fixed with code” terlalu absolut	Ganti: “the root cause is external to this codebase; local code can only fail closed until the upstream source is replaced.”
P1	§3	“all three tables at once” memberi kesan tiga independent feeds	idx_concentration itu broker-derived. Lebih akurat: “the broker-data pipeline stopped advancing; the source and broker-derived tables all froze at 31 July.”
P1	§4	“ran entirely on stale broker data” salah scope	Harga/calendar current. Tulis “all three burn-in sessions used stale broker-dependent inputs, while price and calendar inputs remained current.”
P1	§3.1	“15 checks, all passing, every night” terlalu luas	Kaitkan eksplisit ke three recorded burn-in sessions, kecuali lo punya evidence gate memang tercatat setiap malam sejak 31 July.
P1	§5.4	“Worth aligning to 2” belum tentu benar	Jangan pilih 2 karena existing warning pakai 2. Buat satu canonical tolerance dan tentukan nilainya dari operating contract.
P1	§7	Commit ambiguity	User-facing brief commit = 72f3fc0, implementation/deploy commit = 302597a. Tulis keduanya.
P2	§5.2	“window … becomes a 4-day window” padahal Pattern Replay belum dibangun	Gunakan “would silently become” sebagai failure mode yang harus dicegah.
P2	§4	identity_hash 3× shift kurang evidence	Tambahkan tiga timestamp/hash kalau tersedia supaya reviewer bisa benar-benar menyelidiki.
P2	§5.5	~22 live days	Tambahkan bahwa winner/control result sementara harus dianggap exploratory, bukan estimasi final.
Keputusan §2.3: gue setuju dengan REFUSE

Ini bagian yang menurut brief “most arguable”. Buat gue justru cukup jelas.

Jangan pindahkan “clock” scanner ke idx_stock_prices hanya supaya endpoint kelihatan current.

Kalau:

PRICE DATE        = 2026-08-07
BROKER DATE       = 2026-07-31

dan F1/broker-factor family membutuhkan broker state, maka:

latest price != latest valid signal state

Memakai tanggal price kemudian menjalankan scanner dengan broker inputs yang tidak tersedia menghasilkan sesuatu yang lebih buruk daripada stale response:

fresh timestamp
+
incomplete factor state
=
false freshness

Jadi 503 itu correct fail-closed behavior.

Malah gue akan bikin contract-nya eksplisit:

SIGNAL_DATE
= latest exchange session for which
  ALL REQUIRED INPUT FAMILIES are current

Bukan:

max(price_date)

dan bukan:

max(broker_date)

Idealnya nanti:

required inputs:
PRICE       current ✓
IHSG        current ✓
BROKER      current ✗
CONC        current ✗

SIGNAL ENGINE
READY = false

reason:
BROKER_DATA_STALE

Dengan begitu scanner tidak lagi punya satu “clock”; dia punya readiness contract.

Temuan §3.2 justru menurut gue paling penting

Kalimat ini bagus:

The system knew, said so, and passed itself anyway.

Itu inti incident-nya.

Problem sebenarnya bukan hanya:

broker feed stale

tapi:

DETECTION
without
ENFORCEMENT

Gue sarankan review team melakukan sweep seluruh health system dan setiap condition diklasifikasi jadi:

INFO
ADVISORY
DEGRADED
BLOCKING

Lalu rule keras:

condition affects correctness
        ↓
cannot be WARNING-only
        ↓
must bind readiness / burn-in

Contoh:

disk usage 70%
→ WARNING

optional analytics stale
→ DEGRADED

required broker input stale
→ BLOCKING

exchange calendar unknown
→ BLOCKING

reconciliation mismatch
→ BLOCKING

Jangan biarkan semantics ditentukan hanya oleh console.warn() versus console.error().

Tolerance 1 vs 2: jangan langsung samakan ke 2

Gue kurang setuju dengan:

Worth aligning to 2.

Yang benar adalah align semantics, bukan align ke angka existing.

Pertanyaannya:

Berapa exchange session broker data boleh tertinggal sebelum signal dianggap invalid?

Untuk EOD scanner setelah pipeline seharusnya selesai, jawaban bahkan bisa:

0 sessions

Kalau pipeline memang secara desain update T+1:

1 session

Kalau dua sesi dianggap acceptable, reviewer harus bisa menjelaskan kenapa signal berbasis broker dua hari lalu masih valid.

Jadi buat:

BROKER_DATA_MAX_LAG_SESSIONS

satu canonical constant.

Dipakai oleh:

scanner readiness
watchdog warning
burn-in gate
Trust Center
Pattern Replay completeness

Tidak boleh ada angka literal 1 di satu tempat dan 2 di tempat lain.

§4 identity_hash 3× dalam satu hari — gue naikkan importance-nya

Ini bukan note kecil.

Kalau:

strategy_hash unmoved

tapi:

identity_hash
A → B → C

tiga kali pada hari yang sama, kita perlu tahu apa yang identity_hash sebenarnya mengidentifikasi.

Kemungkinan legitimate:

engine/deploy identity changed

Tapi kalau burn-in continuity bergantung ke hash itu, operational-only patch bisa terus:

reset evidence window

meskipun strategy behaviour tidak berubah.

Review team perlu jawab:

What exactly invalidates burn-in comparability?

strategy change?
execution semantics?
risk semantics?
protocol?
infra implementation?
UI?
watchdog-only patch?

Kalau semuanya masuk satu hash, hash itu mungkin terlalu broad.

Tambahkan kalau bisa:

2026-08-05 09:xx  HASH_A  reason/deploy ?
2026-08-05 13:xx  HASH_B  reason/deploy ?
2026-08-05 19:xx  HASH_C  reason/deploy ?

Biar reviewer punya sesuatu yang bisa ditelusuri, bukan sekadar observasi.

Pattern Replay contract: gue approve keras

Untuk H-5 → H-1:

Expected:
H-5 H-4 H-3 H-2 H-1
 ✓   ✓   ✗   ✓   ✓

hasilnya bukan:

use four observations

dan bukan:

shift H-6 into H-5

apalagi:

missing = 0

Harus:

WINDOW_INCOMPLETE
eligible = false
missingSession = 2026-07-15

Karena:

5 observations
≠
5 consecutive exchange sessions

Ini distinction penting.

Pattern research harus menggunakan canonical exchange-session sequence.

Tapi snapshot-via-HTTP ini gue anggap architecture debt

Kalimat:

History only grows when a human opens the page.

itu cukup serius.

Gue setuju jangan pasang cron sekarang saat feed mati.

Tapi setelah broker source pulih, solusi final bukan cron yang GET /api/signal-scanner.

Yang benar:

Daily data pipeline
      ↓
validate required inputs
      ↓
compute signal snapshot
      ↓
persist snapshot
      ↓
API only READS

Bukan:

human opens browser
      ↓
HTTP GET
      ↓
calculation
      ↓
database write

GET endpoint idealnya tidak menjadi scheduler/database-history mechanism.

Pattern Replay butuh deterministic historical evidence. Jadi snapshot persistence harus menjadi first-class scheduled stage.

Research 22 days: tambahkan satu warning metodologi

Bagian:

live period is only ~22 days

sudah bagus.

Tapi ada jebakan statistik tambahan.

Misalnya:

22 dates × 100 stocks
= 2,200 rows

itu bukan 2,200 independent observations.

BBCA, BBRI, BMRI, TLKM pada tanggal yang sama kena:

same IHSG regime
same macro event
same liquidity environment

Jadi jangan nanti angka:

N = 2,000
p < 0.01

memberi confidence palsu.

Untuk first research:

date-blocked split / bootstrap

lebih aman daripada row-random split.

Dan dengan ~22 live sessions, gue akan label semua result:

EXPLORATORY
NOT PROMOTABLE

sampai sample time-series bertambah.

English-nya sendiri?

Bagus. Natural, profesional, dan tidak terasa seperti English hasil translate literal.

Bagian paling kuat menurut gue justru:

“The system knew, said so, and passed itself anyway.”

dan:

“Both fixes above make the system honest about its blindness, not cured of it.”

Itu concise dan menjelaskan engineering failure dengan sangat jelas.

Yang gue hindari cuma sedikit phrase yang terlalu absolut seperti:

cannot be fixed with code
all three tables died at once
entirely on stale broker data

karena reviewer teknis gampang menyerang absolutism walaupun inti argumennya benar.

Status akhir gue
REVIEW_BRIEF_2026-08-08

Incident diagnosis        🟢
Fail-closed decision       🟢
Evidence transparency      🟢
Self-corrections           🟢
Pattern Replay contract    🟢

Opening factual wording    🟡 P1
Burn-in scope wording      🟡 P1
Tolerance decision         🟡 P1
Identity evidence          🟡 P2
Commit provenance          🟡 P1

VERDICT:
APPROVE AFTER MINOR REVISION
9.3 / 10

Dan yang paling penting bro: jangan lanjut Pattern Replay P1 dulu sebelum broker source punya replacement dan snapshot writer dipisah dari HTTP request. Kalau nggak, kita bisa bikin analitik yang cantik di atas history yang lubangnya struktural.