/**
 * modules/us_tickers.js
 * Ticker universe for the US market layer — S&P 500 constituents, snapshot
 * from training-data knowledge (not a live index-membership feed). Index
 * composition drifts a handful of names per year via reconstitution; a stale
 * ticker just returns no data from Yahoo and is skipped the same way the 12
 * dead IDX codes were handled in tickers.js, so drift here is self-healing,
 * not a correctness risk.
 *
 * Unlike IDX_TICKERS, there is NO broker-summary equivalent for US equities
 * (no public per-broker order-flow transparency like IDX's Index Alpha feed)
 * — so the F1-F8 bandarmology factors and Conviction Tier's broker-backed
 * win-rate reasoning don't apply here. Only the technical (F9-F14) and
 * harmonic/Wyckoff/SMC layers, which are pure OHLC, port over. See
 * computeUSStockSignal / computeSP500Patterns in server.js.
 *
 * Yahoo symbol quirk: share classes use a hyphen, not a dot (BRK.B -> BRK-B,
 * BF.B -> BF-B) — already written in Yahoo form below.
 */
'use strict';

const US_TICKERS = [
  "AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","CSCO","ACN","AMD","INTC","IBM","TXN","QCOM","INTU","NOW",
  "AMAT","MU","ADI","LRCX","KLAC","SNPS","CDNS","PANW","FTNT","MCHP","ANSS","MSI","ROP","PLTR","APH","TEL",
  "GLW","HPQ","HPE","DELL","NXPI","ON","SWKS","GEN","JNPR","FFIV","AKAM","TER","ENPH","SEDG","KEYS","TDY",
  "TYL","ZBRA","PTC","CTSH","GDDY","EPAM","WDC","STX","NTAP",
  "GOOGL","GOOG","META","NFLX","DIS","CMCSA","T","VZ","TMUS","CHTR","EA","TTWO","WBD","OMC","IPG","NWSA",
  "NWS","FOXA","FOX","LYV","MTCH",
  "AMZN","TSLA","HD","MCD","NKE","LOW","SBUX","TJX","BKNG","ABNB","CMG","ORLY","MAR","GM","F","HLT",
  "YUM","ROST","AZO","DHI","LEN","NVR","PHM","EBAY","ETSY","GRMN","DPZ","POOL","ULTA","BBY","LULU","RL",
  "TPR","DECK","CCL","RCL","NCLH","WYNN","LVS","MGM","EXPE","APTV","KMX","GPC","LKQ","WHR","HAS","MHK",
  "PG","KO","PEP","COST","WMT","PM","MO","MDLZ","CL","KMB","GIS","STZ","SYY","KDP","KHC","HSY",
  "MKC","ADM","TSN","TAP","CAG","CPB","HRL","SJM","CLX","CHD","EL","KR","WBA","TGT","DG","DLTR","KVUE",
  "XOM","CVX","COP","SLB","EOG","MPC","PSX","VLO","OXY","WMB","KMI","OKE","HES","BKR","HAL","DVN","FANG",
  "TRGP","CTRA","EQT","APA",
  "BRK-B","JPM","V","MA","BAC","WFC","GS","MS","AXP","SPGI","BLK","C","SCHW","CB","MMC","PGR",
  "ICE","CME","AON","USB","PNC","TFC","COF","AIG","MET","PRU","AFL","ALL","TRV","MCO","AJG","BK",
  "STT","FITB","HBAN","RF","CFG","KEY","NTRS","MTB","SYF","DFS","FI","FIS","GPN","PYPL","WU","TROW",
  "IVZ","BEN","AMP","RJF","ACGL","WRB","CINF","L","GL","HIG","PFG","BRO",
  "UNH","JNJ","LLY","ABBV","MRK","PFE","TMO","ABT","DHR","BMY","AMGN","MDT","GILD","ISRG","VRTX","ELV",
  "CI","CVS","HUM","REGN","ZTS","BSX","SYK","BDX","HCA","MCK","COR","IDXX","IQV","A","RMD","ALGN",
  "DXCM","MRNA","BIIB","ILMN","WAT","MTD","WST","ZBH","BAX","CAH","VTRS","CNC","MOH","GEHC","HOLX","TECH","DGX","LH",
  "GE","CAT","RTX","HON","UNP","BA","DE","LMT","UPS","GD","NOC","ETN","EMR","ITW","PH","CSX",
  "NSC","WM","TDG","CMI","FDX","CARR","OTIS","PCAR","ROK","AME","XYL","DOV","IR","SNA","SWK","JCI",
  "LHX","TXT","HWM","GWW","FAST","PWR","EFX","VRSK","CTAS","RSG","URI","EXPD","JBHT","CHRW","ODFL","LDOS",
  "HII","PAYC","PAYX","ADP","BR",
  "LIN","APD","SHW","ECL","FCX","NEM","DOW","DD","PPG","NUE","CTVA","ALB","VMC","MLM","IFF","LYB",
  "STLD","AVY","PKG","IP","CE","EMN","MOS","FMC",
  "PLD","AMT","EQIX","PSA","WELL","DLR","SPG","O","CCI","VICI","SBAC","AVB","EQR","EXR","INVH","MAA",
  "ESS","UDR","CPT","ARE","KIM","REG","HST","BXP","VTR",
  "NEE","DUK","SO","D","AEP","SRE","EXC","XEL","ED","WEC","PEG","ES","AWK","DTE","PPL","FE",
  "EIX","ETR","AEE","CMS","CNP","ATO","NI","LNT","EVRG","PNW"
];

module.exports = { US_TICKERS };
