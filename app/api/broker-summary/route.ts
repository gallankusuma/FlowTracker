import { NextRequest, NextResponse } from "next/server";
import { fetchBrokerSummary, formatValue, formatLot } from "@/lib/idxService";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const date = req.nextUrl.searchParams.get("date") || undefined;

  if (!code || code.length < 2) {
    return NextResponse.json({ error: "Broker code required (2 letters)" }, { status: 400 });
  }

  const { data, source, error } = await fetchBrokerSummary(code.toUpperCase(), date);

  // Format for frontend consumption
  const formatted = data
    .sort((a, b) => Math.abs(b.netVal) - Math.abs(a.netVal)) // sort by activity
    .map(row => ({
      ticker: row.ticker,
      action: row.action,
      buyVal: formatValue(row.buyVal),
      buyLot: formatLot(row.buyLot),
      buyAvg: row.buyAvg,
      sellVal: formatValue(row.sellVal),
      sellLot: formatLot(row.sellLot),
      sellAvg: row.sellAvg,
      netVal: formatValue(row.netVal),
      rawBuyVal: row.buyVal,
      rawSellVal: row.sellVal,
      rawNetVal: row.netVal,
    }));

  return NextResponse.json({
    broker: code.toUpperCase(),
    date: date || new Date().toISOString().split("T")[0],
    source,
    count: formatted.length,
    buyCount: formatted.filter(f => f.action === "BUY").length,
    sellCount: formatted.filter(f => f.action === "SELL").length,
    data: formatted,
    error,
  });
}
