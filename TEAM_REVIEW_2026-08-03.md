# Team Review — Professional Trading System (2026-08-03)

Text extraction of `FlowTracker_Professional_Trading_System_Review.docx`, committed
alongside the binary so the review is greppable, diffable against future reviews, and
readable without Word. The .docx remains the authoritative formatting; this is the content.

Extracted 2026-08-03. There is no pandoc on the dev machine, so this came from a direct
`word/document.xml` parse — note for anyone repeating it that `<w:t[^>]*>` also matches
`<w:tcPr>`, which silently pollutes every table cell with raw XML. Require `<w:t(?:\s[^>]*)?>`.

---

| FLOWTRACKERProfessional Trading System Review |

Perbandingan roadmap “Trading Operating System” dengan implementasi aktual repository
Repository: github.com/gallankusuma/FlowTracker
| Prepared for | FlowTracker Reviewer Team |
| Review date | 3 August 2026 |
| Scope | Static repository review: branches master and main |
| Classification | Internal review draft |

|  | Review boundaryAnalisis ini berbasis source code, dokumentasi, experiment registry, dan konfigurasi repository. Runtime production, database aktual, kualitas data harian, dan order execution tidak diverifikasi langsung. |


# 1. Executive Summary
|  | Overall verdictFlowTracker saat ini lebih dekat ke institutional-quality research lab dan decision-support platform daripada sebuah end-to-end professional trader operating system. Research discipline-nya sangat kuat; operational integration, live risk control, execution workflow, dan governance masih tertinggal. |

| 4.5/5Research & validationArea terkuat | 3.5/5Data & intelligenceKaya, tetapi terfragmentasi | 2.8/5Portfolio & riskBacktest ada; live engine belum utuh | 1.8/5Execution & operationsManual dan belum terpadu |

Target produk yang disepakati adalah workflow profesional: Observe → Filter → Form Thesis → Size Risk → Execute → Monitor → Review → Improve. Implementasi saat ini sudah sangat maju pada bagian Observe, Filter, Research, dan Improve. Namun rantai Size Risk, Execute, Monitor, serta Review perilaku trader belum memiliki satu sumber kebenaran yang terpadu.
Kesimpulan strategis: jangan menambah banyak strategi baru. Bekukan candidate strategy yang sudah paling kuat evidencenya, jalankan forward test, dan fokus membangun portfolio risk engine, unified execution journal, operational controls, serta release governance.

## Key conclusions
Branch master berisi platform quant yang matang: Next.js, MySQL, factor engine, backtest, regime, paper trading, dan experiment registry.
Branch main adalah implementasi platform broker-flow lain yang terpisah dan tidak memiliki common ancestor dengan master. Ini merupakan risiko governance dan deployment.
AWO composite lama telah difalsifikasi oleh data: performanya lebih buruk daripada random entry dan baseline sederhana. Tim mendokumentasikan kegagalan ini secara terbuka—praktik yang sangat baik.
Candidate yang paling menjanjikan saat ini adalah HI52W + 200-day market regime filter + persistent broker-accumulation veto, tetapi statusnya masih forward test dan belum melewati promotion gate.
Terdapat tiga scheduler dan tiga subsistem yang disebut paper trading. Tanpa konsolidasi, metrik mudah tertukar dan failure mode sulit dideteksi.
Execution tetap manual by design. Ini tepat untuk kondisi bukti saat ini, tetapi execution desk dan audit trail belum cukup untuk meniru workflow trader profesional.

# 2. Scope and Repository Baseline
Review membandingkan roadmap professional trading system dengan repository pada dua branch yang tersedia.
| Branch | Isi utama | Assessment | Implikasi |
| master | Next.js + MySQL + AWO engine + backtests + paper/forward testing | Canonical candidate | Menjadi baseline review sistem trading profesional. |
| main | React/Vite + Express + SQLite + broker-flow warehouse | Separate legacy/backup line | Bukan evolusi langsung master; berpotensi membingungkan deployment dan reviewer. |

|  | Governance warningGitHub comparison menunjukkan main dan master tidak memiliki common ancestor. Default branch saat ini adalah main, sementara dokumentasi dan quant system yang paling matang berada di master. Repository harus menetapkan satu canonical branch dan satu release process. |


## Evidence snapshot
master/README.md menyatakan status research dan secara eksplisit menyebut belum ada strategi yang membuktikan tradeable edge secara production-ready.
scraper/package.json menjalankan 9 test files; README mendokumentasikan 165 tests.
BACKTEST_EXPERIMENTS.md berisi registry append-only setidaknya sampai EXP-018.
scraper/CRONTAB.md mendokumentasikan PM2, internal scheduler, system crontab, serta tiga paper-trading concepts yang berbeda.
strategy_forward.js menggunakan code path yang sama dengan backtest strategy book dan hanya mencatat intention—tidak mengirim order.

# 3. Roadmap vs Current Implementation
| Roadmap layer | What exists now | Status | Primary gap |
| Market Intelligence | Regime, breadth/flow data, IDX/US/HK intelligence, broker and ownership layers | Strong | Belum ada unified daily market posture dan single action policy. |
| Opportunity Scanner | AWO scanner, broker-flow, harmonic, daily picks, candidate portfolio strategy | Partial | Banyak scanner lama belum semuanya evidence-backed; production alignment perlu dibekukan. |
| Trade Planner | T+1 execution convention, ATR/SR trade plan, swing/position profiles | Partial | Belum konsisten terhubung ke candidate strategy, account capital, max entry, dan slippage. |
| Portfolio Risk Engine | Portfolio backtest, 8-position book, regime filter, correlation experiments | Developing | Live total risk, cash, sector cap, loss limits, and exposure governance belum terpadu. |
| Execution Desk | Manual execution, paper lifecycle, forward intention recorder | Early | Tidak ada order state, fill/slippage audit, partial fill, chase warning, atau broker reconciliation. |
| Monitoring & Alerts | Cron jobs, logs, status endpoints, scheduler documentation | Partial | Tiga scheduler dan banyak pipelines belum memiliki unified health dashboard dan kill switch. |
| Trading Journal | Recommendations, virtual trades, AWO paper trades, strategy logs | Partial | Tiga journal/paper sources belum disatukan; human override and behavioral review belum utuh. |
| Research & Backtest | Baseline, ablation, walk-forward, IC, controls, costs, portfolio backtest | Strong | Perlu dataset versioning, point-in-time universe, corporate-action and ARA/ARB modeling. |
| Governance & Security | Auth and some audit controls exist | Critical | Branch divergence, public legacy credentials, no visible CI/release gate enforcement. |

|  | Maturity interpretationStatus “Strong” means the repository already demonstrates disciplined implementation and evidence. “Partial/Developing” means important components exist but are not yet one operational workflow. “Critical” means the gap can invalidate trust even when strategy research is good. |


# 4. Detailed Comparison

## 4.1 Market Intelligence
Roadmap expectation: sistem menentukan market regime, sector rotation, breadth, volatility, liquidity, foreign flow, dan event risk sebelum menilai individual stock.
Current implementation: repository memiliki per-instrument price regime, market-wide regime, broker concentration, ownership data, IDX warehouse, serta cron-based US dan Hong Kong intelligence. Regime engine dibangun dalam shadow mode terlebih dahulu lalu divalidasi sebelum dipakai sebagai filter—ini proses yang benar.
|  | Assessment: Strong foundationMarket regime sudah dibuktikan lebih berguna daripada banyak risk layer kompleks. Namun output masih tersebar di beberapa service dan belum menjadi satu “morning posture” yang menetapkan exposure, preferred style, dan no-trade state untuk seluruh sistem. |

Tambahkan satu Market State object: regime, confidence, data freshness, allowed strategies, maximum exposure, dan reason codes.
Bedakan dengan tegas per-stock regime, market-wide breadth regime, dan portfolio exposure regime.
Semua scanner harus membaca market state yang sama, bukan menghitung versinya sendiri.

## 4.2 Opportunity Scanner and Strategy Selection
Roadmap expectation: universe filter → setup detection → confirmation → risk filter → ranking → explainable thesis.
Current implementation: sistem mempunyai AWO multi-factor scanner, broker-flow analytics, harmonic scanner, daily picks, dan candidate cross-sectional strategy. Riset terbaru menunjukkan AWO Full consistently underperformed random/EMA baselines, harmonic conviction tidak memiliki predictive power, dan raw persistent broker accumulation memiliki sign terbalik. Tim kemudian menemukan candidate yang lebih kuat: proximity to 52-week high, 200-day market filter, dan broker persistence sebagai veto.
|  | Key strengthTim tidak mempertahankan narasi lama ketika evidence menolaknya. Ini salah satu ciri terpenting research organization yang sehat. |

|  | Primary gapUI/scanner yang ada berisiko tetap menampilkan strategi yang secara research sudah ditolak atau belum lulus gate. Production catalog harus dibedakan menjadi RESEARCH, SHADOW, PAPER, APPROVED, dan RETIRED. |


## 4.3 Trade Planner
Roadmap expectation: entry zone, maximum entry, stop/invalidation, target, holding horizon, slippage allowance, position size, dan thesis expiry.
Current implementation: trade_policy.js sudah menjadi single source of truth untuk SWING dan POSITION horizon; risk unit, ATR multiplier, target R, holding bars, dan expiry diselaraskan. Backtests menggunakan T+1 open dan conservative same-bar ambiguity. Ini jauh lebih matang daripada scanner biasa.
|  | Assessment: Technically sound, operationally incompleteTrade geometry sudah ada, tetapi belum seluruhnya terhubung ke candidate portfolio strategy dan account-level risk. Dalam candidate strategy saat ini posisi masih equal-weight, bukan risk-budgeted. |

Pisahkan alpha selection dari trade geometry. Jangan memaksakan stop jika evidence menunjukkan stop memperburuk hasil.
Planner harus menyimpan planned entry versus actual fill, bukan hanya theoretical entry.
Tambahkan maximum chase distance dan reason code ENTRY_MISSED.

## 4.4 Portfolio Risk Engine
Roadmap expectation: total open risk, gross exposure, cash, sector/correlation concentration, daily loss limit, drawdown response, and regime-based exposure.
Current implementation: EXP-013 adalah portfolio backtest nyata dengan cash, positions, costs, equity curve, dan drawdown. EXP-014 menguji inverse-vol sizing, stops, dan market filter; hanya simple 200-day market filter yang transfer out of sample. EXP-015 menguji correlation risk. Candidate forward strategy menggunakan 8 equal-weight positions dan dapat flat berdasarkan market regime.
|  | Important research resultRisk sophistication tidak otomatis memperbaiki sistem. Inverse-vol sizing dan per-position stops justru memburuk; plain market filter membantu. Implementasi live harus mengikuti evidence ini, bukan teori generik. |

|  | Primary gapBelum ada central live portfolio ledger yang menghitung total exposure, realized/unrealized P&L, drawdown, account risk, cash, and kill conditions across all signal and paper subsystems. |


## 4.5 Execution Desk
Roadmap expectation: planned vs actual execution, order state, partial fills, slippage, scale-in/out, stop adjustment, and chase prevention.
Current implementation: strategy_forward.js sengaja hanya mencatat intention dan tidak menyentuh broker. Paper trader memiliki plan → open → check → settle lifecycle untuk IDX dan US. Keputusan manual ini tepat karena candidate belum memperoleh approval untuk automation.
|  | Assessment: EarlyExecution safety stance sudah benar, tetapi workflow trader profesional belum ada. Sistem belum dapat merekonsiliasi plan dengan actual manual order dan belum menghitung execution quality. |

Bangun manual execution ticket: planned order, actual order, fill time, fill price, slippage, fees, rejection reason.
Jangan mulai auto execution sebelum paper promotion gate dan operational controls lulus.

## 4.6 Monitoring, Scheduling, and Kill Switch
Roadmap expectation: event-driven alerts, data freshness, model health, position alerts, and automatic signal disablement when inputs are unreliable.
Current implementation: PM2, internal Node scheduler, and system crontab semuanya aktif. Logs dan status endpoints ada. Namun konfigurasi saat ini memiliki tiga scheduler dan beberapa pipeline yang saling tidak mengetahui.
|  | Operational riskSatu service dapat sehat sementara subsistem lain gagal diam-diam. Metrik dari paper trader, AWO challenger, dan auto-journal juga dapat disalahartikan sebagai satu track record. |

Buat central job registry dan health dashboard dengan last success, data date, duration, records, error, and owner.
Implementasikan kill switch: stale data, unknown model version, missing corporate-action adjustment, calculation error, or portfolio limit breach.
Semua fallback harus explicit. Signal lebih baik disabled daripada memakai data rusak secara silent.

## 4.7 Journal and Learning Loop
Roadmap expectation: thesis, planned risk, actual execution, exit reason, MFE/MAE, outcome in R, rule adherence, and human override analysis.
Current implementation: repository memiliki ft_recommendations, ft_virtual_trades, awo_paper_trades, ft_strategy_positions, dan ft_strategy_log. Ini menunjukkan banyak data evaluasi sudah dikumpulkan, tetapi konsepnya tidak seragam.
|  | Primary gapBelum ada canonical Trade object dan canonical Decision object. Tanpa schema bersama, expectancy dan win rate dari sistem berbeda dapat dibandingkan secara salah. |

Pisahkan Decision, Order, Fill, Position, and Review sebagai entity berbeda.
Tambahkan override type, reason, and whether the override improved outcome.
Gunakan R-multiple dan net-of-cost return sebagai metrik lintas strategi.

## 4.8 Research and Backtesting
Roadmap expectation: hypothesis contract, baseline comparison, factor ablation, walk-forward, sensitivity, cost model, experiment registry, champion–challenger, and promotion gates.
Current implementation: area ini sudah melampaui roadmap awal. Registry mendokumentasikan negative results, bug invalidation and reruns, ranking IC, factor independence, portfolio turnover, risk layers, controls, reverse signal tests, and forward testing. Candidate strategy menggunakan same code path between tested strategy book and forward recorder.
|  | Assessment: Strongest areaFlowTracker sudah memiliki budaya falsification, bukan hanya optimization. Ini aset utama project dan harus dilindungi dari tekanan untuk “membuat hasil terlihat bagus”. |

Sekarang repository sudah memakai Git, setiap experiment baru wajib menyimpan commit SHA.
Tambahkan dataset snapshot/version, data coverage report, and reproducibility command.
Bangun point-in-time universe untuk mengukur survivorship bias.
Modelkan corporate actions, suspension, ARA/ARB, and unfillable T+1 open.

# 5. What the Team Has Done Exceptionally Well
| Strength | Why it matters |
| Falsification discipline | AWO Full, harmonic conviction, stop loss, and inverse-vol sizing tidak dipertahankan ketika evidence menolaknya. |
| Append-only experiments | Negative result tetap dicatat sehingga history research tidak menjadi selection-biased. |
| Conservative execution assumptions | T+1 open, transaction cost, slippage, and stop-first same-bar ambiguity mengurangi optimistic bias. |
| Controls and baselines | Random entry, EMA baseline, reverse-signal control, same-size random filters, and split-half walk-forward digunakan. |
| Same-path forward testing | Candidate forward test memakai strategy_book yang sama dengan replay/backtest, mengurangi divergence. |
| Human-in-the-loop | Sistem belum mengirim order otomatis sebelum strategy memperoleh evidence dan approval. |


# 6. Critical Gaps and Risks
| Priority | Risk | Observation | Required action |
| P0 | Branch governance | main dan master tidak berhubungan; default branch tidak merepresentasikan quant system terbaru. | Tetapkan canonical branch, protect it, archive legacy line. |
| P0 | Public seeded credentials | main contains hard-coded seeded admin/demo credentials in database initialization. | Remove immediately, rotate credentials, scan Git history. |
| P0 | Multiple sources of truth | Tiga paper trading systems dan tiga schedulers dapat menghasilkan conflicting metrics. | Choose one canonical strategy ledger and one job registry. |
| P0 | No unified kill switch | Pipeline dapat terus mengeluarkan output ketika data stale atau subsystem gagal. | Central signal-enabled state with reason codes. |
| P1 | Candidate/UI mismatch | Legacy scanners dapat tetap terlihat authoritative setelah research menolaknya. | Add strategy lifecycle status and hide retired models from action UI. |
| P1 | Portfolio risk not centralized | Live open risk, cash, drawdown and exposure tidak dihitung lintas sistem. | Build account/portfolio risk service. |
| P1 | Execution audit gap | Tidak ada planned-vs-actual fill and slippage workflow untuk manual trades. | Add execution tickets and reconciliation. |
| P1 | Reproducibility metadata | Registry lama belum menyimpan Git SHA/dataset snapshot. | Enforce experiment manifest. |
| P2 | Data realism gaps | Survivorship, sector history, corporate actions, ARA/ARB, and fillability belum lengkap. | Build point-in-time datasets and execution constraints. |

|  | Security noteExact credential values are intentionally omitted from this report. Because the repository is publicly visible, all seeded or historical credentials should be treated as compromised even if they were intended only for demo use. |


# 7. Recommended Target Operating Model
Recommended design is not a rewrite. It is a consolidation around the research components that already work.
| Layer | Responsibility |
| 1. Data & Quality | Market data, broker data, corporate actions, calendars, freshness, point-in-time universe |
| 2. Research Registry | Hypothesis, experiment manifest, dataset version, commit SHA, results, promotion decision |
| 3. Strategy Catalog | RESEARCH → SHADOW → PAPER → APPROVED → RETIRED; one versioned strategy contract |
| 4. Portfolio Engine | Target book, exposure, cash, account risk, drawdown, concentration, kill conditions |
| 5. Execution Ledger | Plan, order, fill, slippage, fee, manual override, reconciliation |
| 6. Monitoring & Journal | Job health, position alerts, decision journal, post-trade analytics, reviewer dashboard |

|  | Canonical candidate pathHI52W ranking → market 200-day regime filter → POSFRAC_60 broker veto → target 8-position book → T+1 manual execution → canonical ledger → forward performance gate. |


# 8. Prioritized Action Plan

## P0 — Immediate trust and safety
Make the advanced quant branch canonical; rename or archive the unrelated legacy branch and document deployment mapping.
Remove and rotate all hard-coded/default credentials; enable GitHub secret scanning and branch protection.
Freeze one candidate strategy ID and ensure scanner, forward test, and portfolio target all use the same module and parameters.
Declare one canonical paper/forward ledger. Mark the other systems as legacy or separate experiments.
Create system-wide SIGNAL_ENABLED state with kill-switch reason codes and data freshness requirements.

## P1 — Complete the professional workflow
Build central portfolio risk service: capital, cash, exposure, drawdown, position count, and account-level limits.
Build manual execution ticket and planned-vs-actual fill reconciliation.
Create unified Decision/Order/Fill/Position/Review schemas and migrate journal analytics to them.
Create strategy lifecycle dashboard with evidence, gate status, owner, version, and approved usage.
Consolidate schedulers into a central job registry with health metrics and alerting.
Add CI for tests, lint, build, migration checks, and research manifest validation.

## P2 — Increase realism and scale
Point-in-time universe, historical sector data, corporate actions, delisting and suspension treatment.
ARA/ARB and unfillable open modeling; actual broker fee and slippage calibration.
User override analytics and AWO-only vs Human-only vs AWO+Human comparison.
Role-based access, immutable strategy approvals, audit trail, and release sign-off.
Only after successful forward gate: consider broker integration or controlled execution assistance.

# 9. Reviewer Checklist and Decision Gates
| Control | Reviewer question | Gate |
| Canonical branch | Which branch is production source of truth? Is it protected and reviewed? | Required |
| Strategy identity | Does live output map to one immutable strategy/version/config? | Required |
| Data contract | Are freshness, coverage, corporate actions and calendar validated before signal? | Required |
| Backtest parity | Does paper/forward use the exact code path and execution assumptions? | Required |
| Portfolio accounting | Are cash, exposure, costs, turnover and drawdown calculated from a canonical ledger? | Required |
| Promotion gate | Are minimum days/trades, expectancy, PF, drawdown and failure conditions defined? | Required |
| Kill switch | Can stale data/model mismatch disable all actionable output? | Required |
| Execution audit | Can reviewers reconcile plan → order → fill → position → exit? | Before live |
| Human override | Are overrides reason-coded and evaluated? | Before scale |
| Security | Are credentials rotated, secrets excluded, and admin routes protected? | Immediate |


## Recommended review decision
|  | Proceed with controlled developmentThe project is suitable to continue as a research and decision-support system. Do not classify it as production trading infrastructure yet. Approval should be conditional on P0 controls, a canonical candidate strategy, and forward-test promotion evidence. |


# 10. Final Assessment
Roadmap awal mengarahkan FlowTracker menjadi sistem yang bekerja seperti trader profesional. Repository master menunjukkan tim telah membangun sesuatu yang lebih kuat daripada sekadar signal scanner: sebuah research platform yang mampu membantah hipotesisnya sendiri. Itu adalah keunggulan utama project ini.
Namun seorang trader profesional tidak hanya memilih saham. Ia mengelola modal, exposure, execution, failure state, dan learning loop sebagai satu proses. FlowTracker belum menyatukan area-area tersebut. Karena itu prioritas berikutnya bukan memperbanyak indikator atau strategi, melainkan mengubah research outputs yang sudah valid menjadi satu controlled operating workflow.
|  | One-sentence recommendationFreeze the evidence-backed candidate, unify the operational source of truth, build the live portfolio and execution ledger, and let forward evidence—not additional complexity—decide promotion. |


# Appendix A — Evidence References
| Source | Used for |
| master/README.md | Project status, architecture, test count, research findings, current candidate and promotion status. |
| master/BACKTEST_EXPERIMENTS.md | Append-only experiments EXP-001 through at least EXP-018, including baseline, IC, risk, broker veto and harmonic results. |
| master/Advance.md | Original professional research roadmap, hypothesis contracts, gates, no-trade engine, human-in-loop and kill switch. |
| master/scraper/modules/trade_policy.js | Single-source swing/position horizon and risk geometry. |
| master/scraper/modules/regime_engine.js | Per-instrument regime engine and shadow-mode gate discipline. |
| master/scraper/strategy_forward.js | Frozen candidate parameters, T+1 execution convention and intention-only forward recorder. |
| master/scraper/CRONTAB.md | Three schedulers and three distinct paper-trading systems. |
| master/scraper/package.json | Nine-file test command and backend dependencies. |
| main/backend/database/init.js | Legacy branch database initialization, including hard-coded seeded credentials. |
| GitHub branch comparison, 2026-08-03 | main and master have no common ancestor. |


# Appendix B — Assessment Scale
|  | Scale used in this reviewStrong/Mature = implemented with evidence and operating discipline. Partial/Developing = core components exist but integration or live control is incomplete. Early/Limited = prototype-level capability. Critical/Missing = trust, security, governance, or control gap that blocks production classification. |

End of review