import { NextResponse } from "next/server";
import { fetchStockPrices } from "@/lib/idxService";

// Top movers — fetch from Yahoo Finance, aggregate, identify signals
const TRACKED = [
  "BBCA", "BBRI", "BMRI", "TLKM", "ASII", "GOTO",
  "ANTM", "INCO", "PGAS", "INDF", "KLBF", "ICBP",
  "UNVR", "EXCL", "SMGR", "BBNI", "MDKA", "BRIS",
];

export async function GET() {
  const prices = await fetchStockPrices(TRACKED);

  // Determine signal based on price change
  const signals = prices.map(p => ({
    ticker: p.ticker,
    price: p.price,
    change: p.changePct,
    volume: p.volume,
    signal: p.changePct > 2 ? "ACCUMULATION"
          : p.changePct < -2 ? "DISTRIBUTION"
          : Math.abs(p.changePct) < 0.5 ? "NEUTRAL"
          : p.changePct > 0 ? "ACCUMULATION"
          : "DISTRIBUTION",
  }));

  return NextResponse.json({
    updated: new Date().toISOString(),
    count: signals.length,
    data: signals.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)),
  });
}
