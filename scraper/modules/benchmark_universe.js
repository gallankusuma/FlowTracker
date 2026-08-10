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

/**
 * FAIL-CLOSED FLOOR for benchmark coverage.
 *
 * Without one, an empty benchmark yields marketAvgChange = 0 and every stock's
 * F5 is then computed against a market that was never observed — full weight,
 * no warning. "0 of 245 observed" must not read as "the market was flat".
 *
 * CHOSEN FROM THE DISTRIBUTION, NOT INVENTED. Measured across all 2,408
 * sessions the benchmark names have prices for:
 *
 *     whole history      median 84.1%   p05 69.0%   min 41.6%
 *     since 2026-06-01   median  100%   min  100%
 *
 * The low end of the old history is NOT breakage — many of today's 245 names
 * had not listed in 2016, so 168/245 is an honest average over the names that
 * existed. A 90-95% floor would refuse ~two thirds of the deep history for
 * being old rather than for being wrong.
 *
 * 60% sits below every legitimately thin session (the historical floor is
 * 68.6%) and above the one true anomaly (2019-06-19 at 41.6%, a partial
 * scrape), while any modern breakage falls far below it since current coverage
 * is a flat 100%.
 *
 * The absolute floor is the guard for the early series, where a percentage of
 * 245 can look acceptable while resting on a handful of names.
 *
 * This is a REFUSAL threshold, not a quality bar. `f5_benchmark_observed` is
 * recorded on every snapshot regardless, so research can demand 95% later
 * without needing anything regenerated.
 */
const F5_MIN_BENCHMARK_COVERAGE = 0.60;
const F5_MIN_BENCHMARK_NAMES = 30;

/**
 * Is the cross-section observed well enough to measure relative strength at all?
 * @returns {{ok:boolean, observed:number, size:number, coverage:number, reason:string|null}}
 */
function benchmarkCoverage(observed) {
  const size = BENCHMARK_TICKERS.length;
  const coverage = size ? observed / size : 0;
  if (observed < F5_MIN_BENCHMARK_NAMES) {
    return { ok: false, observed, size, coverage, reason: `only ${observed} benchmark names observed (floor ${F5_MIN_BENCHMARK_NAMES})` };
  }
  if (coverage < F5_MIN_BENCHMARK_COVERAGE) {
    return { ok: false, observed, size, coverage, reason: `benchmark coverage ${(coverage * 100).toFixed(1)}% is below ${(F5_MIN_BENCHMARK_COVERAGE * 100).toFixed(0)}%` };
  }
  return { ok: true, observed, size, coverage, reason: null };
}

module.exports = {
  BENCHMARK_UNIVERSE_VERSION, BENCHMARK_TICKERS,
  F5_MIN_BENCHMARK_COVERAGE, F5_MIN_BENCHMARK_NAMES, benchmarkCoverage,
};
