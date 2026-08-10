/**
 * The BENCHMARK UNIVERSE — the cross-section F5 (relative strength) is measured
 * against, frozen and versioned.
 *
 * WHY THIS IS NOT IDX_TICKERS (2026-08-10, review)
 * ------------------------------------------------
 * F5 asks "how did this stock move relative to the market", and the answer only
 * means anything if "the market" means the same thing every time it is asked. It
 * did not: the live scanner averaged over the tracked universe while the
 * historical regeneration averaged over every ticker with >= 250 price bars —
 * two different denominators producing two incomparable F5 series. That is fatal
 * for the winners-vs-controls research, whose hypothesis IS the F5 trajectory.
 *
 * Aliasing this to IDX_TICKERS would have looked like a fix and quietly
 * reintroduced the same problem. That list is ALREADY 600 tickers in the working
 * tree, held back from deploy during the burn-in; the moment the reselection
 * ships, an aliased benchmark would silently change F5's denominator from 245
 * names to 600 — every new value measured against a market that did not exist
 * when the older signals were generated, with nothing in the data to show it.
 *
 * So the list is FROZEN here, captured from the DEPLOYED universe on 2026-08-10.
 * Changing the benchmark is a deliberate act with a new version, never a side
 * effect of changing what we happen to scan. A new version means the old F5
 * series is not comparable with the new one and must be regenerated or labelled
 * — never silently mixed.
 */
'use strict';

const BENCHMARK_UNIVERSE_VERSION = 'v1-idx245-2026-08-10';

const BENCHMARK_TICKERS = [
  "AALI", "ACES", "ADHI", "ADMF", "ADMR", "ADRO", "AGRO", "AKPI", "AKRA", "ALII",
  "AMAN", "AMFG", "AMIN", "AMMN", "AMOR", "AMRT", "ANJT", "ANTM", "ARII", "ARTO",
  "ASBI", "ASII", "ASJT", "ATAP", "AUTO", "BALI", "BAYU", "BBCA", "BBNI", "BBRI",
  "BBSI", "BBTN", "BBYB", "BDMN", "BELI", "BFIN", "BHIT", "BINO", "BIPI", "BIRD",
  "BJBR", "BJTM", "BMAS", "BMRI", "BNGA", "BNLI", "BPFI", "BREN", "BRIS", "BRMS",
  "BRPT", "BSDE", "BSSR", "BTPN", "BTPS", "BUDI", "BUKA", "BULL", "BUMI", "BVIC",
  "BYAN", "CASA", "CASH", "CASS", "CBPE", "CEKA", "CHIP", "CMNT", "CMRY", "CPIN",
  "CSRA", "CTRA", "CUAN", "DAAZ", "DCII", "DEWA", "DIGI", "DKFT", "DMAS", "DNET",
  "DOID", "DRMA", "DSNG", "DSSA", "DVLA", "DYAN", "ELSA", "EMTK", "EPMT", "ERAA",
  "ESIP", "ESSA", "ESTA", "EXCL", "FAPA", "FILM", "GDST", "GEMS", "GGRM", "GGRP",
  "GJTL", "GOTO", "GPSO", "GRIA", "HAIS", "HEAL", "HMSP", "HOKI", "HRTA", "HRUM",
  "IBOS", "ICBP", "IMAS", "INCO", "INDF", "INDS", "INKP", "INOV", "INTA", "INTP",
  "IPOL", "ISAP", "ISAT", "ISSP", "ITMG", "JATI", "JKON", "JPFA", "JSMR", "KAEF",
  "KARW", "KEJU", "KINO", "KLBF", "KLIN", "KOIN", "LINK", "LIVE", "LMAX", "LOPI",
  "LPGI", "LPKR", "LPPF", "LSIP", "LUCY", "MAIN", "MAPI", "MASB", "MAYA", "MBMA",
  "MBSS", "MCAS", "MCOL", "MCOR", "MDKA", "MEDC", "MEGA", "MEJA", "MERK", "MIDI",
  "MIKA", "MLBI", "MLIA", "MNCN", "MPPA", "MSIN", "MTDL", "MTEL", "MUTU", "MYOR",
  "NATO", "NCKL", "NEST", "NICK", "NIKL", "NISP", "OBAT", "OLIV", "OMRE", "PALM",
  "PCAR", "PEHA", "PGAS", "PGEO", "PNBN", "PNGO", "PNSE", "PPGL", "PTBA", "PTMP",
  "PTPP", "PTSN", "PUDP", "PWON", "PYFA", "RAAM", "RALS", "RANC", "RATU", "RBMS",
  "RGAS", "SAPX", "SCMA", "SDPC", "SGER", "SGRO", "SIDO", "SILO", "SIMP", "SKBM",
  "SMDM", "SMGR", "SMMA", "SMRA", "SMSM", "SONA", "SPMA", "SRTG", "SSMS", "TALF",
  "TAPG", "TBIG", "TBLA", "TCID", "TINS", "TKIM", "TLKM", "TOBA", "TOWR", "TPIA",
  "TRST", "TSPC", "TUGU", "ULTJ", "UNIQ", "UNTR", "UNVR", "URBN", "VICO", "VINS",
  "WIFI", "WIIM", "WSBP", "WTON", "YULE",
];

module.exports = { BENCHMARK_UNIVERSE_VERSION, BENCHMARK_TICKERS };
