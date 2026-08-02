/**
 * modules/tickers.js
 * Single source of truth for the tracked IDX ticker universe — previously
 * server.js's TOP_STOCKS and harmonic-scan-worker.js's TOP_STOCKS were two
 * separately-maintained copies of the same list (drift risk: editing one
 * didn't update the other). Consolidated 2026-07-22 while also:
 *   - Removing 12 tickers that never once returned data from Index Alpha in
 *     over a year of daily pulls (BOSS, ERPT, FASW, FREN, LOTTE, MASA, SCPI,
 *     SMCB, SRIL, TELE, WIKA, WSKT — almost certainly suspended/delisted or a
 *     ticker-code change; safe to drop, they were dead weight on the daily
 *     API-call budget).
 *   - Adding 100 more tickers, sourced from idx_concentration (the broader,
 *     free FT.id-scraped universe of ~865 IDX tickers — see
 *     project_known_data_gaps memory), ranked by how many days of data each
 *     had (a liquidity/coverage proxy), to grow past the original 157.
 *
 * Net: 145 kept + 100 new = 245 tickers. At 1 broker-summary + 4 flow-detail
 * calls/ticker/day (~5 calls), that's ~1,225 calls/day — comfortably inside
 * the ~3,300/day pace a 100k/month Index Alpha quota supports, leaving room
 * for occasional backfills.
 */
'use strict';

const IDX_TICKERS = [
  "AALI","ACES","ADHI","ADMF","ADMR","ADRO","AGRO","AKPI","AKRA","ALII","AMAN","AMFG","AMIN","AMMN","AMOR","AMRT","ANJT","ANTM","ARII","ARTO","ASBI","ASII","ASJT","ATAP","AUTO","BALI","BAYU","BBCA","BBNI","BBRI","BBSI","BBTN","BBYB","BDMN","BELI","BFIN","BHIT","BINO","BIPI","BIRD","BJBR","BJTM","BMAS","BMRI","BNGA","BNLI","BPFI","BREN","BRIS","BRMS","BRPT","BSDE","BSSR","BTPN","BTPS","BUDI","BUKA","BULL","BUMI","BVIC","BYAN","CASA","CASH","CASS","CBPE","CEKA","CHIP","CMNT","CMRY","CPIN","CSRA","CTRA","CUAN","DAAZ","DCII","DEWA","DIGI","DKFT","DMAS","DNET","DOID","DRMA","DSNG","DSSA","DVLA","DYAN","ELSA","EMTK","EPMT","ERAA","ESIP","ESSA","ESTA","EXCL","FAPA","FILM","GDST","GEMS","GGRM","GGRP","GJTL","GOTO","GPSO","GRIA","HAIS","HEAL","HMSP","HOKI","HRTA","HRUM","IBOS","ICBP","IMAS","INCO","INDF","INDS","INKP","INOV","INTA","INTP","IPOL","ISAP","ISAT","ISSP","ITMG","JATI","JKON","JPFA","JSMR","KAEF","KARW","KEJU","KINO","KLBF","KLIN","KOIN","LINK","LIVE","LMAX","LOPI","LPGI","LPKR","LPPF","LSIP","LUCY","MAIN","MAPI","MASB","MAYA","MBMA","MBSS","MCAS","MCOL","MCOR","MDKA","MEDC","MEGA","MEJA","MERK","MIDI","MIKA","MLBI","MLIA","MNCN","MPPA","MSIN","MTDL","MTEL","MUTU","MYOR","NATO","NCKL","NEST","NICK","NIKL","NISP","OBAT","OLIV","OMRE","PALM","PCAR","PEHA","PGAS","PGEO","PNBN","PNGO","PNSE","PPGL","PTBA","PTMP","PTPP","PTSN","PUDP","PWON","PYFA","RAAM","RALS","RANC","RATU","RBMS","RGAS","SAPX","SCMA","SDPC","SGER","SGRO","SIDO","SILO","SIMP","SKBM","SMDM","SMGR","SMMA","SMRA","SMSM","SONA","SPMA","SRTG","SSMS","TALF","TAPG","TBIG","TBLA","TCID","TINS","TKIM","TLKM","TOBA","TOWR","TPIA","TRST","TSPC","TUGU","ULTJ","UNIQ","UNTR","UNVR","URBN","VICO","VINS","WIFI","WIIM","WSBP","WTON","YULE"
];

// TOP 100 tickers used by the /idx/[code] deep-dive pages, ranked by 30-day
// average daily turnover (buy_val+sell_val) from idx_broker_summary — data-
// driven, not a hand-picked list (expanded from an earlier hand-picked
// TOP 20 to TOP 100 on 2026-07-23; re-rank periodically since turnover
// leadership shifts over time).
const BIG_CAP_100 = [
  "BBCA","TPIA","BBRI","BMRI","DSSA","BRPT","BUMI","TLKM","ANTM","AMMN","BRMS","DEWA","ASII","BBNI","CUAN","BREN","TINS","UNTR","BIPI","MAPI","MDKA","BULL","ADRO","KLBF","AMRT","INCO","MEDC","PGAS","MBMA","ESSA","RATU","INDF","WIFI","CPIN","NCKL","ISAT","INKP","ADMR","JPFA","ITMG","BBTN","PTBA","UNVR","SMGR","BRIS","BUKA","MTEL","JSMR","EMTK","HRTA","ICBP","AKRA","PGEO","TAPG","GGRM","CMNT","ELSA","TOWR","ERAA","TKIM","ARTO","BFIN","MSIN","RBMS","RGAS","EXCL","PWON","MIKA","GPSO","DMAS","CTRA","MYOR","SCMA","SSMS","LSIP","NATO","BSDE","HMSP","SGER","CMRY","ESIP","FILM","AALI","INTP","BBYB","SRTG","HEAL","LPKR","SIDO","ACES","MNCN","BSSR","GOTO","BDMN","SIMP","SMRA","TOBA","DSNG","HRUM","PNBN",
];

module.exports = { IDX_TICKERS, BIG_CAP_100 };
