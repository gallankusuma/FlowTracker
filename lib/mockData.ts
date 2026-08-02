// Mock data for FlowTracker — IDX Indonesia

export const TODAY = "2026-04-28";

// ─── Flow Analyzer ────────────────────────────────────────────────────────────
export const flowAnalyzerData = [
  { ticker: "BBCA", lastVal: "1.2T",  days: [-8.2, -5.1, 3.4, 7.8, 12.3],  dailyChange: +0.42, price: 9500 },
  { ticker: "BBRI", lastVal: "980B",  days: [-12.4, -9.8, -7.2, -4.1, -2.8], dailyChange: -1.24, price: 4800 },
  { ticker: "TLKM", lastVal: "408B",  days: [-17.1, -7.8, -6.9, -3.9, -2.8], dailyChange: -0.35, price: 2820 },
  { ticker: "ANTM", lastVal: "702B",  days: [2.3, 2.0, 11.3, -3.3, -8.2],   dailyChange: -1.94, price: 4040 },
  { ticker: "GOTO", lastVal: "330B",  days: [5.2, 8.4, 12.1, 15.6, 18.9],   dailyChange: +3.12, price: 96   },
  { ticker: "BMRI", lastVal: "850B",  days: [-3.4, -1.2, 2.8, 5.6, 9.1],    dailyChange: +1.05, price: 5900 },
  { ticker: "ASII", lastVal: "475B",  days: [-6.7, -4.3, -2.1, 0.8, 3.4],   dailyChange: +0.84, price: 4320 },
  { ticker: "UNVR", lastVal: "215B",  days: [-15.2, -12.8, -9.4, -6.1, -3.2], dailyChange: -2.11, price: 2900 },
  { ticker: "PGAS", lastVal: "165B",  days: [1.4, 3.2, 5.8, 8.4, 11.2],     dailyChange: +2.34, price: 1475 },
  { ticker: "INDF", lastVal: "280B",  days: [-2.1, 1.3, 4.5, 7.2, 9.8],     dailyChange: +1.62, price: 5300 },
  { ticker: "KLBF", lastVal: "195B",  days: [-8.9, -6.4, -3.2, -1.1, 2.4],  dailyChange: +0.53, price: 1560 },
  { ticker: "ICBP", lastVal: "320B",  days: [3.1, 5.7, 8.2, 10.9, 14.3],    dailyChange: +1.89, price: 8900 },
  { ticker: "EXCL",  lastVal: "88B",  days: [-4.2, -2.8, 1.4, 3.9, 6.7],    dailyChange: +0.91, price: 2140 },
  { ticker: "SMGR", lastVal: "142B",  days: [-11.3, -8.7, -5.4, -2.8, 1.2], dailyChange: -0.72, price: 5400 },
  { ticker: "INCO",  lastVal: "98B",  days: [7.8, 10.4, 13.2, 16.5, 20.1],  dailyChange: +4.21, price: 3950 },
];

// ─── Accumulation Streak ──────────────────────────────────────────────────────
export const accumulationData: Record<number, AccumulationRow[]> = {
  2: [
    {
      stockCode: "BBCA", lastPrice: 9500, lastValue: "1.2T",
      buyers: [
        { code: "MG", bVal: "245B", bLot: "2.1M", avg: 9498, gainPct: +0.02 },
        { code: "XL", bVal: "180B", bLot: "1.9M", avg: 9497, gainPct: +0.03 },
        { code: "BK", bVal: "95B",  bLot: "1.0M", avg: 9501, gainPct: -0.01 },
      ],
      sellers: [
        { code: "AK", sVal: "405B", sLot: "4.3M", avg: 9499 },
        { code: "KZ", sVal: "168B", sLot: "1.8M", avg: 9498 },
        { code: "YU", sVal: "42B",  sLot: "443K", avg: 9500 },
      ],
    },
    {
      stockCode: "GOTO", lastPrice: 96, lastValue: "330B",
      buyers: [
        { code: "AZ", bVal: "88B",  bLot: "920M", avg: 95.6, gainPct: +0.42 },
        { code: "SQ", bVal: "52B",  bLot: "540M", avg: 95.8, gainPct: +0.21 },
      ],
      sellers: [
        { code: "ZP", sVal: "34B",  sLot: "354M", avg: 96.1 },
        { code: "RG", sVal: "18B",  sLot: "188M", avg: 95.9 },
      ],
    },
    {
      stockCode: "INCO", lastPrice: 3950, lastValue: "98B",
      buyers: [
        { code: "YP", bVal: "31B",  bLot: "785K", avg: 3945, gainPct: +0.13 },
        { code: "AK", bVal: "18B",  bLot: "455K", avg: 3948, gainPct: +0.05 },
      ],
      sellers: [
        { code: "CC", sVal: "12B",  sLot: "304K", avg: 3951 },
        { code: "BK", sVal: "8B",   sLot: "202K", avg: 3949 },
      ],
    },
    {
      stockCode: "ANTM", lastPrice: 4040, lastValue: "702B",
      buyers: [
        { code: "AZ", bVal: "31B",  bLot: "75.6K", avg: 4117, gainPct: -1.87 },
        { code: "MG", bVal: "22B",  bLot: "54.1K", avg: 4115, gainPct: -1.82 },
      ],
      sellers: [
        { code: "AK", sVal: "20B",  sLot: "48.9K", avg: 4116 },
        { code: "XL", sVal: "14B",  sLot: "34.2K", avg: 4118 },
      ],
    },
    {
      stockCode: "PGAS", lastPrice: 1475, lastValue: "165B",
      buyers: [
        { code: "ZP", bVal: "42B",  bLot: "2.85M", avg: 1473, gainPct: +0.14 },
        { code: "SQ", bVal: "28B",  bLot: "1.9M",  avg: 1474, gainPct: +0.07 },
      ],
      sellers: [
        { code: "KZ", sVal: "18B",  sLot: "1.22M", avg: 1475 },
        { code: "CC", sVal: "12B",  sLot: "814K",  avg: 1476 },
      ],
    },
  ],
  3: [
    {
      stockCode: "BBCA", lastPrice: 9500, lastValue: "1.2T",
      buyers: [
        { code: "MG", bVal: "680B", bLot: "7.2M", avg: 9495, gainPct: +0.05 },
        { code: "XL", bVal: "420B", bLot: "4.4M", avg: 9493, gainPct: +0.07 },
      ],
      sellers: [
        { code: "AK", sVal: "890B", sLot: "9.4M", avg: 9497 },
        { code: "KZ", sVal: "340B", sLot: "3.6M", avg: 9496 },
      ],
    },
    {
      stockCode: "INCO", lastPrice: 3950, lastValue: "98B",
      buyers: [
        { code: "YP", bVal: "78B",  bLot: "1.97M", avg: 3940, gainPct: +0.25 },
        { code: "AK", bVal: "45B",  bLot: "1.14M", avg: 3942, gainPct: +0.20 },
      ],
      sellers: [
        { code: "CC", sVal: "32B",  sLot: "811K",  avg: 3945 },
        { code: "GR", sVal: "18B",  sLot: "456K",  avg: 3943 },
      ],
    },
  ],
  4: [
    {
      stockCode: "GOTO", lastPrice: 96, lastValue: "330B",
      buyers: [
        { code: "AZ", bVal: "220B", bLot: "2.3B",  avg: 94.8, gainPct: +1.26 },
        { code: "SQ", bVal: "145B", bLot: "1.52B", avg: 95.1, gainPct: +0.95 },
      ],
      sellers: [
        { code: "ZP", sVal: "88B",  sLot: "925M",  avg: 95.2 },
        { code: "RG", sVal: "52B",  sLot: "547M",  avg: 95.4 },
      ],
    },
  ],
  5: [
    {
      stockCode: "INCO", lastPrice: 3950, lastValue: "98B",
      buyers: [
        { code: "YP", bVal: "195B", bLot: "4.94M", avg: 3930, gainPct: +0.51 },
        { code: "AK", bVal: "112B", bLot: "2.84M", avg: 3932, gainPct: +0.46 },
      ],
      sellers: [
        { code: "CC", sVal: "80B",  sLot: "2.03M", avg: 3935 },
        { code: "GR", sVal: "44B",  sLot: "1.12M", avg: 3933 },
      ],
    },
  ],
};

export type AccumulationRow = {
  stockCode: string;
  lastPrice: number;
  lastValue: string;
  buyers: { code: string; bVal: string; bLot: string; avg: number; gainPct: number }[];
  sellers: { code: string; sVal: string; sLot: string; avg: number }[];
};

// ─── Insider Moves ────────────────────────────────────────────────────────────
export const insiderMovesData = [
  { no: 1, ticker: "BBCA", name: "Sofyan Basir", remarks: "Pembelian Saham", d2: "4.2%", d1: "4.5%", d2pct: 4.20, d1pct: 4.50, change: +0.30 },
  { no: 2, ticker: "TLKM", name: "Ririek Adriansyah", remarks: "Pembelian Saham", d2: "1.8%", d1: "2.1%", d2pct: 1.80, d1pct: 2.10, change: +0.30 },
  { no: 3, ticker: "GOTO", name: "Patrick Walujo", remarks: "Pembelian Saham", d2: "12.4%", d1: "13.1%", d2pct: 12.40, d1pct: 13.10, change: +0.70 },
  { no: 4, ticker: "ANTM", name: "Nicholas Krisna", remarks: "Penjualan Saham", d2: "5.6%", d1: "5.1%", d2pct: 5.60, d1pct: 5.10, change: -0.50 },
  { no: 5, ticker: "INCO", name: "Hendra Susanto", remarks: "Pembelian Saham", d2: "6.8%", d1: "7.4%", d2pct: 6.80, d1pct: 7.40, change: +0.60 },
  { no: 6, ticker: "BMRI", name: "Darmawan Junaidi", remarks: "Penjualan Saham", d2: "3.2%", d1: "2.9%", d2pct: 3.20, d1pct: 2.90, change: -0.30 },
  { no: 7, ticker: "BBRI", name: "Sunarso", remarks: "Pembelian Saham", d2: "2.1%", d1: "2.4%", d2pct: 2.10, d1pct: 2.40, change: +0.30 },
];

// ─── Broker Activity ──────────────────────────────────────────────────────────
export const brokerProfiles: Record<string, BrokerProfile> = {
  "MG": { name: "Mandiri Sekuritas", type: "domestic", specialty: "Blue Chip" },
  "XL": { name: "Sinarmas Sekuritas", type: "domestic", specialty: "Mid Cap" },
  "YP": { name: "Indo Premier Sekuritas", type: "domestic", specialty: "Retail" },
  "ZP": { name: "Kim Eng Sekuritas", type: "foreign", specialty: "Large Cap" },
  "AK": { name: "UBS Sekuritas", type: "foreign", specialty: "Institutional" },
  "CC": { name: "Mandiri Sekuritas Alt", type: "domestic", specialty: "Mixed" },
  "AZ": { name: "Danareksa Sekuritas", type: "domestic", specialty: "Growth" },
  "SQ": { name: "Trimegah Sekuritas", type: "domestic", specialty: "Small-Mid" },
  "BK": { name: "Bahana Sekuritas", type: "domestic", specialty: "Blue Chip" },
  "KZ": { name: "Credit Suisse", type: "foreign", specialty: "Institutional" },
  "GR": { name: "Ciptadana Sekuritas", type: "domestic", specialty: "Retail" },
  "YU": { name: "OCBC Sekuritas", type: "foreign", specialty: "Mixed" },
};

export type BrokerProfile = {
  name: string;
  type: "domestic" | "foreign";
  specialty: string;
};

export const brokerActivityData: Record<string, BrokerStock[]> = {
  "MG": [
    { ticker: "BBCA", action: "BUY",  val: "245B", lot: "2.1M", avg: 9498,  pct: +2.8, price: 9500 },
    { ticker: "BMRI", action: "BUY",  val: "130B", lot: "2.2M", avg: 5880,  pct: +1.6, price: 5900 },
    { ticker: "ANTM", action: "BUY",  val: "22B",  lot: "54K",  avg: 4115,  pct: -1.8, price: 4040 },
    { ticker: "TLKM", action: "SELL", val: "65B",  lot: "2.3M", avg: 2835,  pct: -0.5, price: 2820 },
    { ticker: "UNVR", action: "SELL", val: "38B",  lot: "1.3M", avg: 2920,  pct: -0.7, price: 2900 },
  ],
  "AK": [
    { ticker: "BBCA", action: "SELL", val: "405B", lot: "4.3M", avg: 9499,  pct: 0,    price: 9500 },
    { ticker: "GOTO", action: "SELL", val: "88B",  lot: "920M", avg: 96.2,  pct: +0.2, price: 96   },
    { ticker: "INCO", action: "BUY",  val: "18B",  lot: "455K", avg: 3948,  pct: +0.1, price: 3950 },
    { ticker: "ANTM", action: "SELL", val: "20B",  lot: "49K",  avg: 4116,  pct: +1.9, price: 4040 },
  ],
  "YP": [
    { ticker: "INCO", action: "BUY",  val: "31B",  lot: "785K", avg: 3945,  pct: +0.1, price: 3950 },
    { ticker: "PGAS", action: "BUY",  val: "18B",  lot: "1.2M", avg: 1472,  pct: +0.2, price: 1475 },
    { ticker: "KLBF", action: "BUY",  val: "12B",  lot: "769K", avg: 1558,  pct: +0.1, price: 1560 },
    { ticker: "SMGR", action: "SELL", val: "24B",  lot: "444K", avg: 5425,  pct: +0.5, price: 5400 },
  ],
  "ZP": [
    { ticker: "PGAS", action: "BUY",  val: "42B",  lot: "2.85M", avg: 1473, pct: +0.1, price: 1475 },
    { ticker: "ANTM", action: "SELL", val: "54B",  lot: "133K",  avg: 4118, pct: +1.9, price: 4040 },
    { ticker: "TLKM", action: "SELL", val: "191B", lot: "6.8M",  avg: 2826, pct: +0.2, price: 2820 },
  ],
  "AZ": [
    { ticker: "GOTO", action: "BUY",  val: "88B",  lot: "920M", avg: 95.6,  pct: +0.4, price: 96   },
    { ticker: "ANTM", action: "BUY",  val: "31B",  lot: "75.6K",avg: 4117,  pct: -1.9, price: 4040 },
    { ticker: "INDF", action: "BUY",  val: "55B",  lot: "1.04M",avg: 5290,  pct: +0.2, price: 5300 },
  ],
};

export type BrokerStock = {
  ticker: string;
  action: "BUY" | "SELL";
  val: string;
  lot: string;
  avg: number;
  pct: number;
  price: number;
};

// ─── Featured tickers for dashboard ──────────────────────────────────────────
export const featuredTickers = [
  { ticker: "BBCA", price: 9500,  change: +0.42, signal: "ACCUMULATION" },
  { ticker: "GOTO", price: 96,    change: +3.12, signal: "ACCUMULATION" },
  { ticker: "INCO", price: 3950,  change: +4.21, signal: "ACCUMULATION" },
  { ticker: "BBRI", price: 4800,  change: -1.24, signal: "DISTRIBUTION" },
  { ticker: "ANTM", price: 4040,  change: -1.94, signal: "NEUTRAL"      },
  { ticker: "TLKM", price: 2820,  change: -0.35, signal: "DISTRIBUTION" },
];
