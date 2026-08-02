/**
 * IDX Data Service — Fetches real data from Indonesia Stock Exchange
 * 
 * Data sources:
 * 1. IDX website (idx.co.id) — Broker Summary, Trading Activity
 * 2. Yahoo Finance — Stock prices (TICKER.JK format)
 * 
 * Note: IDX internal endpoints require browser-like headers.
 * For production, consider:
 * - IDX Data Services license (official)
 * - GoAPI.id stock API (Indonesian provider)
 * - Sectors.app API
 */

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
  "Referer": "https://www.idx.co.id/en/market-data/trading-summary/broker-summary/",
  "Origin": "https://www.idx.co.id",
};

// ─── Types ────────────────────────────────────────────────────────────────────
export type BrokerSummaryRow = {
  ticker: string;
  buyVal: number;
  buyLot: number;
  buyAvg: number;
  sellVal: number;
  sellLot: number;
  sellAvg: number;
  netVal: number;
  action: "BUY" | "SELL" | "NEUTRAL";
};

export type StockPrice = {
  ticker: string;
  price: number;
  change: number;
  changePct: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
};

// ─── IDX Broker Summary ───────────────────────────────────────────────────────
export async function fetchBrokerSummary(
  brokerCode: string,
  date?: string
): Promise<{ data: BrokerSummaryRow[]; source: string; error?: string }> {
  const dateStr = date || new Date().toISOString().split("T")[0].replace(/-/g, "");
  const formattedDate = dateStr.replace(/-/g, "");

  // Try IDX internal API
  try {
    const url = `https://www.idx.co.id/primary/TradingSummary/GetBrokerSummary?code=${brokerCode.toUpperCase()}&date=${formattedDate}&length=100&start=0`;

    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      next: { revalidate: 300 }, // cache 5 min
    });

    if (res.ok) {
      const json = await res.json();
      const rows: BrokerSummaryRow[] = (json.data || json.Results || []).map((item: any) => {
        const buyVal = Number(item.BVal || item.buyVal || 0);
        const sellVal = Number(item.SVal || item.sellVal || 0);
        const buyLot = Number(item.BLot || item.buyLot || 0);
        const sellLot = Number(item.SLot || item.sellLot || 0);
        const buyAvg = buyLot > 0 ? buyVal / buyLot : 0;
        const sellAvg = sellLot > 0 ? sellVal / sellLot : 0;
        const netVal = buyVal - sellVal;

        return {
          ticker: item.StockCode || item.stockCode || item.code || "",
          buyVal,
          buyLot,
          buyAvg: Math.round(buyAvg),
          sellVal,
          sellLot,
          sellAvg: Math.round(sellAvg),
          netVal,
          action: netVal > 0 ? "BUY" : netVal < 0 ? "SELL" : "NEUTRAL",
        };
      });

      return { data: rows.filter(r => r.ticker), source: "IDX" };
    }
  } catch (e) {
    console.error("[IDX Broker] Direct API failed:", e);
  }

  // Fallback: Try alternative IDX endpoint
  try {
    const url2 = `https://idx.co.id/umbraco/Surface/TradingSummary/GetBrokerSummaryDaily?indexCode=COMPOSITE&date=${formattedDate}&brokerCode=${brokerCode.toUpperCase()}&length=100`;

    const res2 = await fetch(url2, {
      headers: BROWSER_HEADERS,
      next: { revalidate: 300 },
    });

    if (res2.ok) {
      const json2 = await res2.json();
      const rows: BrokerSummaryRow[] = (json2.Results || []).map((item: any) => {
        const buyVal = Number(item.BVal || 0);
        const sellVal = Number(item.SVal || 0);
        const netVal = buyVal - sellVal;
        return {
          ticker: item.StockCode || "",
          buyVal,
          buyLot: Number(item.BLot || 0),
          buyAvg: Number(item.BAvg || 0),
          sellVal,
          sellLot: Number(item.SLot || 0),
          sellAvg: Number(item.SAvg || 0),
          netVal,
          action: netVal > 0 ? "BUY" as const : netVal < 0 ? "SELL" as const : "NEUTRAL" as const,
        };
      });

      return { data: rows.filter(r => r.ticker), source: "IDX-v2" };
    }
  } catch (e) {
    console.error("[IDX Broker] Fallback API failed:", e);
  }

  return { data: [], source: "none", error: "Could not fetch from IDX. The API may require VPN or has rate limits." };
}

// ─── Yahoo Finance Stock Prices ──────────────────────────────────────────────
export async function fetchStockPrices(tickers: string[]): Promise<StockPrice[]> {
  const results: StockPrice[] = [];

  // Yahoo Finance: Indonesian stocks use .JK suffix
  const symbols = tickers.map(t => `${t}.JK`).join(",");

  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose`;

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      next: { revalidate: 60 }, // cache 1 min
    });

    if (res.ok) {
      const json = await res.json();
      const quotes = json.quoteResponse?.result || [];

      for (const q of quotes) {
        const ticker = (q.symbol || "").replace(".JK", "");
        results.push({
          ticker,
          price: q.regularMarketPrice || 0,
          change: q.regularMarketChange || 0,
          changePct: q.regularMarketChangePercent || 0,
          volume: q.regularMarketVolume || 0,
          high: q.regularMarketDayHigh || 0,
          low: q.regularMarketDayLow || 0,
          open: q.regularMarketOpen || 0,
          previousClose: q.regularMarketPreviousClose || 0,
        });
      }
    }
  } catch (e) {
    console.error("[Yahoo Finance] Error:", e);
  }

  // Fallback: try individual fetches for missing tickers
  const found = new Set(results.map(r => r.ticker));
  const missing = tickers.filter(t => !found.has(t));

  for (const ticker of missing.slice(0, 5)) {
    try {
      const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}.JK?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        next: { revalidate: 60 },
      });

      if (res.ok) {
        const json = await res.json();
        const meta = json.chart?.result?.[0]?.meta;
        if (meta) {
          results.push({
            ticker,
            price: meta.regularMarketPrice || 0,
            change: (meta.regularMarketPrice || 0) - (meta.chartPreviousClose || 0),
            changePct: meta.chartPreviousClose
              ? (((meta.regularMarketPrice - meta.chartPreviousClose) / meta.chartPreviousClose) * 100)
              : 0,
            volume: meta.regularMarketVolume || 0,
            high: meta.regularMarketDayHigh || meta.regularMarketPrice || 0,
            low: meta.regularMarketDayLow || meta.regularMarketPrice || 0,
            open: meta.regularMarketPrice || 0,
            previousClose: meta.chartPreviousClose || 0,
          });
        }
      }
    } catch { /* skip */ }
  }

  return results;
}

// ─── Fetch multiple days of broker data (for Flow Analyzer) ──────────────────
export async function fetchBrokerFlowMultiDay(
  tickers: string[],
  days: number = 5
): Promise<Record<string, number[]>> {
  const result: Record<string, number[]> = {};

  // Generate last N trading dates (skip weekends)
  const dates: string[] = [];
  const today = new Date();
  let d = new Date(today);
  while (dates.length < days) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) {
      dates.unshift(d.toISOString().split("T")[0].replace(/-/g, ""));
    }
    d.setDate(d.getDate() - 1);
  }

  // For each date, fetch top 3 broker concentration for each ticker
  // This is simplified — in production you'd use a batch endpoint
  for (const ticker of tickers) {
    result[ticker] = [];
    for (const date of dates) {
      try {
        const url = `https://www.idx.co.id/primary/TradingSummary/GetStockSummary?code=${ticker}&date=${date}`;
        const res = await fetch(url, { headers: BROWSER_HEADERS, next: { revalidate: 3600 } });
        if (res.ok) {
          const json = await res.json();
          // Calculate broker concentration as net percentage
          const topBrokerNet = Number(json.data?.[0]?.NetForeign || 0);
          result[ticker].push(topBrokerNet);
        } else {
          result[ticker].push(0);
        }
      } catch {
        result[ticker].push(0);
      }
    }
  }

  return result;
}

// ─── Format helpers ──────────────────────────────────────────────────────────
export function formatValue(val: number): string {
  if (val >= 1_000_000_000_000) return (val / 1_000_000_000_000).toFixed(1) + "T";
  if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "B";
  if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
  if (val >= 1_000) return (val / 1_000).toFixed(1) + "K";
  return val.toString();
}

export function formatLot(lot: number): string {
  if (lot >= 1_000_000_000) return (lot / 1_000_000_000).toFixed(1) + "B";
  if (lot >= 1_000_000) return (lot / 1_000_000).toFixed(1) + "M";
  if (lot >= 1_000) return (lot / 1_000).toFixed(1) + "K";
  return lot.toString();
}
