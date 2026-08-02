import { NextRequest, NextResponse } from "next/server";
import { fetchStockPrices } from "@/lib/idxService";

// Default top IDX tickers to track
const DEFAULT_TICKERS = [
  "BBCA", "BBRI", "BMRI", "TLKM", "ASII", "UNVR", "BBNI", "HMSP",
  "GOTO", "ANTM", "INCO", "PGAS", "INDF", "ICBP", "KLBF", "SMGR",
  "EXCL", "MDKA", "BRIS", "ARTO", "EMTK", "ESSA", "MEDC", "PTBA",
];

export async function GET(req: NextRequest) {
  const tickerParam = req.nextUrl.searchParams.get("tickers");
  const tickers = tickerParam
    ? tickerParam.split(",").map(t => t.trim().toUpperCase())
    : DEFAULT_TICKERS;

  const prices = await fetchStockPrices(tickers);

  return NextResponse.json({
    count: prices.length,
    updated: new Date().toISOString(),
    data: prices.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)),
  });
}
