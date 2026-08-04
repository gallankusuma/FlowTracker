P0.1 — Terminal performance masih memakai harga open, bukan actual NAV mark

terminalDate berasal dari latest ft_strategy_nav, yang dibuat oleh cmdMark() menggunakan close/mark price.

Namun terminal leg menghitung:

const nav1 = navAt(
  positionRows,
  series,
  iTerm,
  terminalDate
);

Karena priceFn tidak diberikan, navAt() memakai barPrice(), yang memprioritaskan open price. Eligible-universe terminal return juga memakai barPrice() pada terminal date.

Jadi secara efektif:

Observed NAV latest mark  = harga close/mark
Gate terminal return      = harga open hari yang sama

Contoh:

Open hari ini  : 100
Close hari ini : 90

cmdMark() melihat penurunan ke 90, tetapi promotion performance dapat tetap berakhir di 100. Kerugian intraday pada latest mark belum masuk ke gate.

Perbaikan

Terminal portfolio NAV harus menggunakan:

const nav1 = navAt(
  positionRows,
  series,
  iTerm,
  terminalDate,
  exec.markPrice
);

Untuk eligible universe:

const q0 = barPrice(s2, execLast);       // execution open
const q1 = exec.markPrice(s2, iTerm);    // terminal close/mark

Pilihan paling kuat: gunakan navRow.total_nav langsung sebagai terminal strategy NAV karena itulah observed authoritative mark.

P0.2 — Pending legacy plan dengan contract NULL masih dapat dieksekusi

Migration menambahkan kolom execution contract sebagai nullable:

buy_cost NULL
sell_cost NULL
execution_ledger_version NULL

Tetapi contractDiffers() hanya menganggap berbeda jika nilainya tidak null dan tidak sama:

p.buy_cost !== null &&
Number(p.buy_cost) !== BUY_COST

Skenario:

Plan dibuat sebelum execution-contract columns tersedia.
Migration menambahkan ketiga kolom dengan nilai NULL.
Plan masih PLANNED dan mempunyai current strategy hash.
contractDiffers() menghasilkan false.
Plan lama dieksekusi oleh implementation baru.

Padahal contract plan tersebut tidak diketahui.

Perbaikan

Contract yang tidak lengkap harus dianggap stale:

const missingContract = p =>
  p.buy_cost === null ||
  p.sell_cost === null ||
  p.execution_ledger_version === null;

const stale = plans.filter(p =>
  !p.strategy_hash ||
  missingContract(p) ||
  p.strategy_hash !== strategyHash ||
  contractDiffers(p)
);

Gunakan reason:

MISSING_EXECUTION_CONTRACT

Jangan mengisi contract lama dengan current values melalui migration karena itu akan menciptakan provenance yang tidak pernah ada.

P1 yang disarankan
1. Gate belum memeriksa freshness NAV

Report menggunakan latest NAV row yang tersedia, tetapi gate tidak memeriksa apakah mark tersebut benar-benar terbaru. Gate criteria saat ini hanya mencakup decisions, months, regimes, fills, profit factor, excess return, dan ledger validity.

Jika cron mark berhenti selama beberapa hari, promotion gate tetap dapat mengevaluasi track record sampai mark lama dan tidak menyadari data performance-nya stale.

Tambahkan:

latestNavMarkDate
latestCompleteTradingDate
navFresh

Gate harus NOT_ELIGIBLE ketika latest mark tertinggal lebih dari satu complete trading bar.

2. Execution policy masih mengandalkan manual version bump

Contract menangkap costs dan execution_ledger_version, tetapi perubahan murni pada:

buyFill();
sellFill();
sizing algorithm;
price fallback;
transaction sequencing;

tidak otomatis terdeteksi bila developer lupa menaikkan ledger version.

Lebih kuat bila plan menyimpan:

execution_policy_hash

yang berasal dari execution configuration/version yang eksplisit. Alternatif konservatif: expire pending plan bila plan.code_commit !== CODE_COMMIT.

3. Terminal leg belum punya regression test langsung

test_strategy_forward.js sudah menguji deployment cost dan NAV path, tetapi belum terlihat test yang memastikan harga setelah rebalance terakhir masuk melalui terminalDate.

Tambahkan fixture:

last execution NAV = 1.00
latest mark NAV    = 0.90

dan assert total return menyertakan terminal loss −10%.

4. Label profit factor masih menyebut “net %”

Output saat ini masih menulis:

gross profit / gross loss, net %

padahal input-nya sekarang nominal P&L.

Ganti menjadi:

gross nominal profit / gross nominal loss
Penilaian terbaru
Area	Sebelumnya	Sekarang
Nominal profit factor	6.0	9.5
Latest-period coverage	6.0	8.5
Provenance handling	9.0	9.5
Stale-plan protection	9.5	9.0
NAV reconciliation	8.2	9.3
Schema/migration testing	8.8	9.2
Forward infrastructure	9.0	9.2
Predictive-edge evidence	4.5	4.5
Kesimpulan akhir

Secara keseluruhan, revisi ini substantif dan benar. Dua masalah promotion yang paling besar—nominal profit factor dan latest open period—sudah ditangani.

Posisi sistem sekarang:

Production-capable forward recorder, dengan promotion gate yang masih membutuhkan terminal close valuation dan missing-contract rejection.

Setelah dua P0 di atas ditutup, gue akan anggap forward validation infrastructure lulus secara engineering.

Status signal tetap berbeda: infrastrukturnya hampir siap penuh untuk mengumpulkan bukti, tetapi edge HI52W + broker veto masih harus dibuktikan oleh LIVE time selama minimal periode yang ditentukan gate.

Review ini berdasarkan static source terbaru. Gue belum menjalankan npm test dan npm run test:integration langsung terhadap MySQL/VPS production.