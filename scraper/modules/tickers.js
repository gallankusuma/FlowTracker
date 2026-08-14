/**
 * modules/tickers.js
 * Single source of truth for the tracked IDX ticker universe. Consumed by
 * server.js's daily Index Alpha pull and harmonic-scan-worker.js.
 *
 * ============================================================================
 * 2026-08-03 — UNIVERSE RESELECTED BY MEASURED LIQUIDITY (245 -> 600)
 * ============================================================================
 *
 * THE BAR
 *   strategy_book.js will not select a ticker whose trailing 20-day median
 *   traded value is below minAdv (Rp 5bn). A ticker that has never once
 *   cleared that bar cannot be selected on any date, so every Index Alpha
 *   call spent on it is waste. That is the whole basis for this edit.
 *
 * THE TEST IS "EVER CLEARED", NOT "CLEARS TODAY"
 *   Both removals and additions are decided on the PEAK trailing 20-day
 *   median over the whole measured history, never on current activity.
 *   Screening on current liquidity would rebuild exactly the survivorship
 *   bias review item P0.2 exists to remove: a name that was liquid in 2024
 *   and died in 2025 is precisely what a backtest universe must contain,
 *   because dropping it means the sample only ever sees survivors.
 *
 *   This matters more than it sounds. Under a "cleared it since the research
 *   sample began (2024-01-02)" test, 83 of the 245 incumbents would go.
 *   Under the EVER test only 48 go. The 35-name difference is entirely made
 *   up of names that WERE liquid and then died — the exact population the
 *   bias-removal work is about. They are kept. They are listed below.
 *
 * HOW IT WAS MEASURED (reproducible: scraper/universe_reselect.js)
 *   strategy_book.js's own exported rollingMedian(), on the shared IHSG
 *   trading-date axis the backtests build (2016-08-01..2026-07-31, 2412
 *   days) — not a re-implementation, so this screen cannot disagree with
 *   the screen that actually gates selection. Candidate prices came from
 *   Yahoo via scraper/universe_fetch_candidates.js into the staging table
 *   idx_price_candidates (1.10M daily bars, 628 codes, 0 API quota).
 *   idx_stock_prices.value is exactly close_price * volume, which is what
 *   the Yahoo bars carry, so both sides are directly comparable.
 *
 *   One deliberate deviation: a window is only judged if at least 15 of its
 *   20 slots hold a real bar. rollingMedian() itself will median a single
 *   value, which in strategy_book is harmless because minHiWindowBars (200
 *   real bars out of the trailing 252) independently blocks anything that
 *   thin. This screen has no companion check, and without the floor a peak
 *   can be pure listing-day artifact — WSBP scores Rp 782bn off a 1-bar
 *   window at its 2016 IPO, against Rp 147.50bn on any genuinely full one.
 *
 * CALL BUDGET (1 broker-summary + 4 flow-detail = 5 calls/ticker/day)
 *   before : 245 x 5 = 1,225/day  — of which 240/day went to the 48 names
 *                                   that could never be selected at all
 *   after  : 600 x 5 = 3,000/day
 *   The daily pull runs weekdays only (scheduleDailyCron, 12:30 UTC), so that
 *   is ~63,000/month.
 *
 *   THE QUOTA IS 250,000/MONTH, NOT THE ~100,000 THIS FILE ORIGINALLY ASSUMED.
 *   Checked against /api/indexalpha/usage on 2026-08-14 before deploying, and
 *   the assumption the 600 cap was sized against turned out to be wrong by
 *   2.5x: plan "Advanced", monthly_limit 250,000, current_usage 11,069,
 *   remaining 238,931, period ending 2026-09-08. So 600 tickers consume about
 *   a quarter of the allowance rather than the two thirds the old arithmetic
 *   implied.
 *
 *   That means the 600 cap is NOT a quota limit any more — it is just where
 *   this reselection stopped. 44 measured-eligible names sit below it (listed
 *   further down); admitting all of them would be 644 x 5 = 3,220/day, ~68,000
 *   a month, still comfortably inside. Raising it is a decision about how much
 *   research surface to carry, not about affording the calls.
 *
 *   Runtime, not quota, is now the real cost: the pull loop is ~2.6s/ticker
 *   plus a ~0.6s/ticker Yahoo price pass, so ~13min becomes ~32min.
 *
 *   The other consumer, harmonic-scan-worker.js, reads Yahoo only, so it adds
 *   no quota cost at all — just proportionally more wall-clock.
 *
 * WHAT A NEW TICKER CANNOT BRING WITH IT
 *   Only prices backfill. Broker/concentration history accrues FORWARD only —
 *   idx_broker_summary comes from the daily Index Alpha pull and Yahoo serves
 *   prices, not bandarmology. A newly added name therefore needs ~200 trading
 *   days before it can satisfy the POSFRAC_60 / minHiWindowBars screens in
 *   strategy_book.js, i.e. it becomes research-usable around mid-2027. That
 *   is an argument for starting the clock sooner, not for deferring.
 *
 * LIMIT OF THE CANDIDATE SOURCE (stated because it is NOT fixed here)
 *   The candidate roster is the 865 distinct IDX codes left in idx_concentration
 *   by the dead FT.id scrape. Its rows are far too thin to use as data (~15
 *   days for most codes) but the CODE LIST is a valid roster. It is however
 *   itself a 2026-05-22..2026-06-17 snapshot, so it contains no name that had
 *   already delisted by then — a survivorship-biased source. Reselection can
 *   remove the bias inside the roster; it cannot remove the bias OF the roster.
 *   A genuinely unbiased universe needs a historical IDX listing/delisting
 *   record, which we do not have.
 *
 * ----------------------------------------------------------------------------
 * REMOVED (48) — measured peak trailing 20d median value, and when it peaked.
 * Every one of these is recorded rather than deleted, so a later reader can
 * check the judgement instead of taking it on faith. None ever cleared Rp 5bn.
 * ----------------------------------------------------------------------------
 *   CBPE  peak Rp  4.94bn @ 2023-01-27   (843 bars 2023-01-06..2026-07-31)
 *   OLIV  peak Rp  4.77bn @ 2025-11-18   (1008 bars 2022-05-17..2026-07-31)
 *   AMFG  peak Rp  3.97bn @ 2022-07-11   (2412 bars 2016-08-01..2026-07-31)
 *   BINO  peak Rp  3.95bn @ 2022-02-24   (1119 bars 2021-11-25..2026-07-31)
 *   PPGL  peak Rp  3.81bn @ 2020-08-11   (1448 bars 2020-07-20..2026-07-31)
 *   ARII  peak Rp  3.73bn @ 2022-09-23   (2411 bars 2016-08-01..2026-07-31)
 *   ADMF  peak Rp  3.65bn @ 2023-07-27   (2412 bars 2016-08-01..2026-07-31)
 *   LUCY  peak Rp  3.45bn @ 2021-06-08   (1256 bars 2021-05-05..2026-07-31)
 *   PEHA  peak Rp  3.20bn @ 2021-01-22   (1829 bars 2018-12-26..2026-07-31)
 *   MASB  peak Rp  3.09bn @ 2021-07-21   (1221 bars 2021-06-30..2026-07-31)
 *   LOPI  peak Rp  2.98bn @ 2025-12-10   (664 bars 2023-10-11..2026-07-31)
 *   DCII  peak Rp  2.74bn @ 2025-09-01   (1338 bars 2021-01-06..2026-07-31)
 *   VICO  peak Rp  2.71bn @ 2022-10-25   (2412 bars 2016-08-01..2026-07-31)
 *   KLIN  peak Rp  2.06bn @ 2025-01-08   (950 bars 2022-08-09..2026-07-31)
 *   SPMA  peak Rp  2.02bn @ 2022-01-28   (2412 bars 2016-08-01..2026-07-31)
 *   CASS  peak Rp  1.98bn @ 2020-06-30   (2412 bars 2016-08-01..2026-07-31)
 *   PNGO  peak Rp  1.95bn @ 2025-12-19   (1422 bars 2020-08-31..2026-07-31)
 *   KEJU  peak Rp  1.88bn @ 2025-08-28   (1606 bars 2019-11-25..2026-07-31)
 *   SKBM  peak Rp  1.80bn @ 2026-03-16   (2411 bars 2016-08-01..2026-07-31)
 *   ASJT  peak Rp  1.74bn @ 2017-03-22   (2412 bars 2016-08-01..2026-07-31)
 *   SMMA  peak Rp  1.71bn @ 2025-08-14   (2412 bars 2016-08-01..2026-07-31)
 *   MLBI  peak Rp  1.68bn @ 2026-06-29   (2412 bars 2016-08-01..2026-07-31)
 *   BMAS  peak Rp  1.68bn @ 2022-01-07   (2411 bars 2016-08-01..2026-07-31)
 *   GGRP  peak Rp  1.52bn @ 2025-12-18   (1653 bars 2019-09-19..2026-07-31)
 *   SONA  peak Rp  1.52bn @ 2018-10-25   (2412 bars 2016-08-01..2026-07-31)
 *   AMIN  peak Rp  1.49bn @ 2023-02-02   (2410 bars 2016-08-01..2026-07-31)
 *   DNET  peak Rp  1.43bn @ 2024-10-01   (2412 bars 2016-08-01..2026-07-31)
 *   PUDP  peak Rp  1.24bn @ 2026-01-26   (2412 bars 2016-08-01..2026-07-31)
 *   FAPA  peak Rp  1.23bn @ 2021-01-25   (1340 bars 2021-01-04..2026-07-31)
 *   EPMT  peak Rp  1.17bn @ 2021-06-03   (2411 bars 2016-08-01..2026-07-31)
 *   MEGA  peak Rp  1.15bn @ 2022-03-28   (2412 bars 2016-08-01..2026-07-31)
 *   VINS  peak Rp  1.06bn @ 2021-03-31   (2410 bars 2016-08-01..2026-07-31)
 *   BAYU  peak Rp  0.96bn @ 2023-10-26   (2411 bars 2016-08-01..2026-07-31)
 *   NICK  peak Rp  0.88bn @ 2021-11-02   (1983 bars 2018-05-02..2026-07-31)
 *   CEKA  peak Rp  0.78bn @ 2025-07-04   (2411 bars 2016-08-01..2026-07-31)
 *   BBSI  peak Rp  0.75bn @ 2020-09-25   (1417 bars 2020-09-07..2026-07-31)
 *   TCID  peak Rp  0.62bn @ 2025-10-07   (2412 bars 2016-08-01..2026-07-31)
 *   BPFI  peak Rp  0.57bn @ 2022-02-11   (2412 bars 2016-08-01..2026-07-31)
 *   YULE  peak Rp  0.39bn @ 2021-12-15   (2411 bars 2016-08-01..2026-07-31)
 *   DVLA  peak Rp  0.34bn @ 2024-11-05   (2411 bars 2016-08-01..2026-07-31)
 *   PNSE  peak Rp  0.34bn @ 2025-07-01   (2412 bars 2016-08-01..2026-07-31)
 *   AKPI  peak Rp  0.31bn @ 2022-06-16   (2412 bars 2016-08-01..2026-07-31)
 *   LPGI  peak Rp  0.29bn @ 2022-03-16   (2412 bars 2016-08-01..2026-07-31)
 *   TALF  peak Rp  0.19bn @ 2025-09-25   (2410 bars 2016-08-01..2026-07-31)
 *   TRST  peak Rp  0.17bn @ 2022-04-05   (2412 bars 2016-08-01..2026-07-31)
 *   ASBI  peak Rp  0.07bn @ 2021-06-28   (2412 bars 2016-08-01..2026-07-31)
 *   KOIN  peak Rp  0.07bn @ 2021-05-31   (2411 bars 2016-08-01..2026-07-31)
 *   OMRE  peak Rp  0.04bn @ 2023-02-15   (2412 bars 2016-08-01..2026-07-31)
 *
 * ----------------------------------------------------------------------------
 * DELIBERATELY KEPT (35) — cleared Rp 5bn once, but not since 2024-01-02.
 * These are the survivorship trap. A "still liquid?" screen deletes all of
 * them; the EVER test keeps them, because their decline is data.
 * ----------------------------------------------------------------------------
 *   WSBP(147.50bn@2021-01) BHIT(98.00bn@2021-06) LINK(57.04bn@2017-05)
 *   MCOR(46.48bn@2017-03) MCAS(42.76bn@2017-11) BYAN(31.73bn@2023-01)
 *   MUTU(31.54bn@2023-09) SMDM(31.15bn@2022-10) ISSP(25.11bn@2021-11)
 *   PALM(24.63bn@2022-01) MLIA(23.97bn@2022-06) PCAR(23.13bn@2019-07)
 *   MCOL(18.46bn@2022-05) TBLA(18.42bn@2021-01) ESTA(14.36bn@2022-07)
 *   AMOR(12.12bn@2021-06) KINO(11.99bn@2022-05) AMAN(11.95bn@2023-05)
 *   DIGI(11.10bn@2021-11) HAIS(10.52bn@2022-06) CASH(10.25bn@2021-11)
 *   GDST(10.24bn@2022-11) RANC(10.23bn@2021-10) MERK(9.90bn@2019-01)
 *   DYAN(8.83bn@2021-09) URBN(8.79bn@2019-01) PTSN(8.64bn@2019-01)
 *   BUDI(7.92bn@2021-08) INTA(7.00bn@2017-11) BTPN(6.45bn@2018-06)
 *   CHIP(6.23bn@2023-05) BALI(6.20bn@2021-11) IPOL(6.08bn@2022-11)
 *   SDPC(5.80bn@2022-12) INOV(5.73bn@2022-01)
 *
 * ----------------------------------------------------------------------------
 * ADDED (403) — candidates whose peak trailing 20d median EVER reached Rp 5bn,
 * ranked by that peak and taken until the 600 cap. Includes large, currently
 * active names we simply were not tracking (CDIA, PTRO, RAJA, PANI, AADI,
 * ENRG, INDY, KRAS, BMTR, SSIA, IMPC), and also names that were liquid and
 * then faded — 124 of the 403 have not cleared the bar since 2024-01-02.
 * Both kinds belong in the universe for the same reason.
 * ----------------------------------------------------------------------------
 *
 * ----------------------------------------------------------------------------
 * ELIGIBLE BUT NOT ADDED (44) — the 600 cap bound before the Rp 5bn bar did.
 * These all cleared Rp 5bn at some point (peaks Rp 5.01bn..Rp 7.51bn, versus
 * Rp 7.55bn for the lowest name that made it in). They are a ranked waiting
 * list, not a rejection: raising the cap to 644 would admit all of them at
 * 3,220 calls/day (~68,000/month), still inside quota. Logged so that the
 * exclusion is a visible choice rather than an invisible truncation.
 * ----------------------------------------------------------------------------
 *   ENZO(7.51bn) BOLT(7.31bn) MAXI(7.29bn) SWID(7.27bn) BATR(7.25bn)
 *   MTWI(7.01bn) CNKO(6.97bn) CTTH(6.90bn) CCSI(6.86bn) ESTI(6.83bn)
 *   INCF(6.72bn) NAYZ(6.53bn) LABS(6.52bn) WAPO(6.45bn) RUNS(6.43bn)
 *   GOOD(6.34bn) MBAP(6.25bn) SATU(6.21bn) BIPP(6.14bn) TIRT(6.12bn)
 *   MTFN(5.99bn) BSIM(5.97bn) NPGF(5.97bn) ICON(5.92bn) KOCI(5.92bn)
 *   ACRO(5.89bn) FUJI(5.89bn) ASGR(5.82bn) PSSI(5.79bn) RICY(5.67bn)
 *   LPPS(5.66bn) IGAR(5.52bn) PSGO(5.48bn) CITY(5.48bn) MDRN(5.36bn)
 *   TOTL(5.28bn) CITA(5.23bn) DSFI(5.22bn) KOBX(5.16bn) TLDN(5.16bn)
 *   FORU(5.13bn) GTBO(5.12bn) MBTO(5.10bn) IDPR(5.01bn)
 *
 * ----------------------------------------------------------------------------
 * THE 12 REMOVED ON 2026-07-22, RE-EXAMINED
 * ----------------------------------------------------------------------------
 * They were dropped for "never returned data from Index Alpha ... almost
 * certainly suspended/delisted". That is a diagnosis from absence of data, and
 * for most of them it was wrong. Re-measured against Yahoo:
 *
 *   BOSS  peak Rp 27.32bn @ 2018-03-08, last cleared 2023-02-14 -> RE-ADDED
 *   ERPT  no Yahoo history under this code -> cannot be measured
 *   FASW  peak Rp 8.09bn @ 2018-10-09, last cleared 2018-11-09 -> RE-ADDED
 *   FREN  no Yahoo history under this code -> cannot be measured
 *   LOTTE no Yahoo history under this code -> cannot be measured
 *   MASA  no Yahoo history under this code -> cannot be measured
 *   SCPI  Yahoo serves a 1-bar stub -> cannot be measured, NOT judged illiquid
 *   SMCB  peak Rp 34.94bn @ 2018-11-02, last cleared 2024-02-16 -> RE-ADDED
 *   SRIL  Yahoo serves a 1-bar stub -> cannot be measured, NOT judged illiquid
 *   TELE  peak Rp 19.34bn @ 2016-12-30, last cleared 2020-05-18 -> RE-ADDED
 *   WIKA  peak Rp 187.52bn @ 2021-02-02, last cleared 2024-12-06 -> RE-ADDED
 *   WSKT  Yahoo serves a 1-bar stub -> cannot be measured, NOT judged illiquid
 *
 * BOSS, FASW, SMCB, TELE and WIKA all still have unbroken daily
 * history through 2026-07-31 — they were never suspended. WIKA peaked at
 * Rp 187.52bn and cleared the bar as recently as 2024-12-06, inside the
 * research sample: a name the strategy could have selected, deleted for
 * looking dead. That is the survivorship deletion this file now exists to
 * avoid repeating.
 *
 * SCPI, SRIL and WSKT are excluded for a different and weaker reason: Yahoo
 * returns a single bar for each, so their liquidity cannot be measured either
 * way. They are absent for lack of evidence, not because evidence says thin.
 * ERPT, FREN, LOTTE and MASA return nothing at all under those codes.
 */
'use strict';

// 600 tickers. Membership is measured, not curated — see the header for the
// test and scraper/universe_reselect.js to reproduce it.
const IDX_TICKERS = [
  "AADI","AALI","ABBA","ABMM","ACES","ACST","ADCP","ADHI","ADMR","ADRO","AGII","AGRO",
  "AGRS","AHAP","AISA","AKRA","ALDO","ALII","AMAN","AMAR","AMMN","AMMS","AMOR","AMRT",
  "ANDI","ANJT","ANTM","APEX","APIC","APLN","ARCI","ARKA","ARKO","ARTO","ASHA","ASII",
  "ASLC","ASLI","ASPI","ASPR","ASRI","ASSA","ATAP","ATLA","AUTO","AVIA","AWAN","AXIO",
  "AYAM","AYLS","BABP","BABY","BACA","BAIK","BAJA","BALI","BANK","BAPI","BAUT","BBCA",
  "BBHI","BBKP","BBNI","BBRI","BBRM","BBTN","BBYB","BCAP","BCIC","BCIP","BDKR","BDMN",
  "BEEF","BEER","BEKS","BELI","BELL","BEST","BFIN","BGTG","BHAT","BHIT","BINA","BIPI",
  "BIRD","BJBR","BJTM","BKSL","BKSW","BLOG","BLUE","BMHS","BMRI","BMTR","BNBA","BNBR",
  "BNGA","BNII","BNLI","BOAT","BOGA","BOLA","BOSS","BPII","BPTR","BREN","BRIS","BRMS",
  "BRPT","BRRC","BSBK","BSDE","BSML","BSSR","BTEK","BTPN","BTPS","BUAH","BUDI","BUKA",
  "BULL","BUMI","BUVA","BVIC","BWPT","BYAN","CAKK","CAMP","CARE","CARS","CASA","CASH",
  "CBDK","CBRE","CBUT","CDIA","CENT","CFIN","CGAS","CHEK","CHEM","CHIP","CLAY","CLEO",
  "CMNT","CMPP","CMRY","CNMA","COAL","COCO","COIN","CPIN","CPRO","CRAB","CSIS","CSMI",
  "CSRA","CTRA","CUAN","CYBR","DAAZ","DADA","DATA","DEFI","DEPO","DEWA","DEWI","DFAM",
  "DGIK","DGNS","DGWG","DIGI","DILD","DIVA","DKFT","DKHH","DMAS","DMMX","DNAR","DOID",
  "DOOH","DOSS","DPUM","DRMA","DSNG","DSSA","DWGL","DYAN","ELIT","ELPI","ELSA","ELTY",
  "EMAS","EMTK","ENAK","ENRG","EPAC","ERAA","ERAL","ESIP","ESSA","ESTA","EURO","EXCL",
  "FAST","FASW","FILM","FIRE","FITT","FOLK","FORE","FPNI","FUTR","GDST","GEMS","GGRM",
  "GIAA","GJTL","GMFI","GOLF","GOTO","GPRA","GPSO","GRIA","GTRA","GTSI","GULA","GUNA",
  "GZCO","HAIS","HAJJ","HALO","HATM","HDIT","HEAL","HELI","HEXA","HGII","HILL","HMSP",
  "HOKI","HOMI","HOPE","HRME","HRTA","HRUM","HUMI","HYGN","IATA","IBOS","ICBP","IKAI",
  "IKAN","IMAS","IMJS","IMPC","INCO","INDF","INDO","INDR","INDS","INDX","INDY","INET",
  "INKP","INOV","INPC","INTA","INTP","IOTF","IPCC","IPCM","IPOL","IPTV","IRRA","IRSX",
  "ISAP","ISAT","ISEA","ISSP","ITIC","ITMA","ITMG","JARR","JAST","JATI","JAWA","JAYA",
  "JGLE","JIHD","JKON","JMAS","JPFA","JRPT","JSMR","JTPE","KAEF","KAQI","KARW","KBAG",
  "KBLI","KBLV","KDTN","KEEN","KETR","KIJA","KING","KINO","KIOS","KJEN","KKES","KKGI",
  "KLAS","KLBF","KOKA","KOTA","KPIG","KRAS","KREN","KRYA","KUAS","LABA","LAJU","LAND",
  "LAPD","LCKM","LEAD","LINK","LIVE","LMAX","LPCK","LPIN","LPKR","LPPF","LSIP","LUCK",
  "MAHA","MAIN","MANG","MAPA","MAPI","MARI","MARK","MAYA","MBMA","MBSS","MCAS","MCOL",
  "MCOR","MDIA","MDIY","MDKA","MDLN","MEDC","MEDS","MEJA","MERI","MERK","MGRO","MHKI",
  "MIDI","MIKA","MINA","MINE","MITI","MKAP","MKPI","MKTR","MLIA","MLPL","MLPT","MMIX",
  "MMLP","MNCN","MOLI","MORA","MPIX","MPMX","MPOW","MPPA","MPXL","MSIE","MSIN","MSJA",
  "MSKY","MSTI","MTDL","MTEL","MTMH","MUTU","MYOR","NAIK","NANO","NASI","NATO","NCKL",
  "NEST","NETV","NFCX","NICE","NICL","NIKL","NINE","NISP","NOBU","NRCA","NSSS","NTBK",
  "NZIA","OASA","OBAT","OBMD","OILS","OKAS","OMED","OPMS","PACK","PADA","PADI","PALM",
  "PAMG","PANI","PANR","PART","PBRX","PBSA","PCAR","PDPP","PEGE","PGAS","PGEO","PICO",
  "PIPA","PJHB","PKPK","PNBN","PNBS","PNIN","PNLF","POWR","PPRE","PPRI","PPRO","PRDA",
  "PRIM","PSAB","PSAT","PSDN","PSKT","PTBA","PTMP","PTPP","PTPS","PTPW","PTRO","PTSN",
  "PURA","PURI","PWON","PYFA","PZZA","RAAM","RAJA","RALS","RANC","RATU","RBMS","REAL",
  "RELF","RGAS","RISE","RLCO","RMKE","RMKO","RODA","ROTI","RSCH","RUIS","SAGE","SAME",
  "SAMF","SAPX","SBMA","SCMA","SCNP","SDMU","SDPC","SEMA","SGER","SGRO","SHID","SHIP",
  "SICO","SIDO","SILO","SIMP","SINI","SKRN","SLIS","SMBR","SMCB","SMDM","SMDR","SMGA",
  "SMGR","SMIL","SMKL","SMKM","SMLE","SMMT","SMRA","SMSM","SNLK","SOCI","SOFA","SOLA",
  "SPRE","SPTO","SQMI","SRAJ","SRSN","SRTG","SSIA","SSMS","STAA","STRK","SULI","SUPA",
  "SURI","TAMA","TAMU","TAPG","TARA","TAXI","TAYS","TBIG","TBLA","TCPI","TEBE","TELE",
  "TFAS","TINS","TKIM","TLKM","TMAS","TNCA","TOBA","TOOL","TOSK","TOTO","TOWR","TPIA",
  "TPMA","TRGU","TRIM","TRIN","TRJA","TRON","TRUE","TRUK","TSPC","TUGU","UANG","UCID",
  "UDNG","UFOE","ULTJ","UNIQ","UNSP","UNTD","UNTR","UNVR","URBN","UVCR","VAST","VICI",
  "VISI","VIVA","VKTR","VTNY","WBSA","WEGE","WEHA","WIDI","WIFI","WIIM","WIKA","WINE",
  "WINR","WINS","WIRG","WMPP","WMUU","WOOD","WOWS","WSBP","WTON","YELO","ZATA","ZYRX",
];

// TOP 100 tickers used by the /idx/[code] deep-dive pages, ranked by 30-day
// average daily turnover (buy_val+sell_val) from idx_broker_summary — data-
// driven, not a hand-picked list (expanded from an earlier hand-picked
// TOP 20 to TOP 100 on 2026-07-23; re-rank periodically since turnover
// leadership shifts over time).
//
// LEFT UNCHANGED by the 2026-08-03 reselection, deliberately. It ranks on
// idx_broker_summary turnover, and the 393 tickers added that day have no
// rows in that table yet — re-ranking now would just re-confirm the incumbents
// and bake in the old universe. Re-rank once the new names have accumulated
// broker history (~200 trading days, so from roughly mid-2027). None of the
// 38 removed tickers was in this list, so nothing here dangles.
const BIG_CAP_100 = [
  "BBCA","TPIA","BBRI","BMRI","DSSA","BRPT","BUMI","TLKM","ANTM","AMMN","BRMS","DEWA",
  "ASII","BBNI","CUAN","BREN","TINS","UNTR","BIPI","MAPI","MDKA","BULL","ADRO","KLBF",
  "AMRT","INCO","MEDC","PGAS","MBMA","ESSA","RATU","INDF","WIFI","CPIN","NCKL","ISAT",
  "INKP","ADMR","JPFA","ITMG","BBTN","PTBA","UNVR","SMGR","BRIS","BUKA","MTEL","JSMR",
  "EMTK","HRTA","ICBP","AKRA","PGEO","TAPG","GGRM","CMNT","ELSA","TOWR","ERAA","TKIM",
  "ARTO","BFIN","MSIN","RBMS","RGAS","EXCL","PWON","MIKA","GPSO","DMAS","CTRA","MYOR",
  "SCMA","SSMS","LSIP","NATO","BSDE","HMSP","SGER","CMRY","ESIP","FILM","AALI","INTP",
  "BBYB","SRTG","HEAL","LPKR","SIDO","ACES","MNCN","BSSR","GOTO","BDMN","SIMP","SMRA",
  "TOBA","DSNG","HRUM","PNBN",
];

module.exports = { IDX_TICKERS, BIG_CAP_100 };
