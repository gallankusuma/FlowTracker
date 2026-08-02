#!/usr/bin/env python3
"""
1. Add OHLC candle data to worker scan results
2. Replace XABCDMiniChart with a candlestick chart component
"""
import re

# ==================== PART 1: Patch Worker ====================
WORKER = '/var/www/flowtracker-scraper/harmonic-scan-worker.js'
with open(WORKER, 'r') as f:
    wc = f.read()

# Add ohlc_candles to the result push (just before the results.push line)
old_push = "p.bb_data = bb_data;"
new_push = """p.bb_data = bb_data;

        // Include last 60 OHLC candles for candlestick chart
        const xIdx = p.pattern_data?.X?.index || 0;
        const candleStart = Math.max(0, xIdx - 5);
        p.ohlc_candles = ohlc.slice(candleStart).map(c => ({
          d: c.date?.slice(5, 10) || '',
          o: Number(c.open) || c.close,
          h: Number(c.high) || c.close,
          l: Number(c.low) || c.close,
          c: Number(c.close),
        }));"""

if old_push in wc and 'ohlc_candles' not in wc:
    wc = wc.replace(old_push, new_push, 1)
    print("[W1] Added ohlc_candles to worker results")
else:
    print("[W1] SKIP: already exists or pattern not found")

with open(WORKER, 'w') as f:
    f.write(wc)

# ==================== PART 2: Patch Frontend ====================
PAGE = '/var/www/flowtracker/app/signal-scanner/page.tsx'
with open(PAGE, 'r') as f:
    pc = f.read()

# Find and replace the XABCDMiniChart function
# First, find it
start_marker = "function XABCDMiniChart("
end_marker = "\n}\n"
start_idx = pc.find(start_marker)
if start_idx < 0:
    print("[F1] SKIP: XABCDMiniChart not found")
else:
    # Find the closing } of the function
    # We need to find the matching closing brace
    search_from = start_idx
    end_idx = -1
    for i in range(5):  # Try a few times to find the right closing
        candidate = pc.find(end_marker, search_from + 1)
        if candidate < 0:
            break
        # Check if the next line starts a new function
        after = pc[candidate + len(end_marker):candidate + len(end_marker) + 50]
        if after.strip().startswith('function ') or after.strip().startswith('//') or after.strip() == '':
            end_idx = candidate + len(end_marker)
            break
        search_from = candidate + 1

    if end_idx < 0:
        # Fallback: find by looking for the BollingerSparkline function
        bb_idx = pc.find("function BollingerSparkline(")
        if bb_idx > start_idx:
            end_idx = bb_idx
            print(f"[F1] Using BollingerSparkline as boundary")
    
    if end_idx > start_idx:
        old_func = pc[start_idx:end_idx]
        new_func = '''function XABCDMiniChart({ data, direction, ratios, entryMin, entryMax, stopLoss, target1, target2, candles }: { 
  data: any; direction: string; ratios?: any; entryMin?: number; entryMax?: number; 
  stopLoss?: number; target1?: number; target2?: number; candles?: any[];
}) {
  if (!data?.X || !data?.D) return null;
  const lbls = ["X","A","B","C","D"];
  const prices = lbls.map(k => Number(data[k]?.price)).filter(Boolean);
  if (prices.length < 5) return null;

  const isBull = direction === "BULLISH";
  const mainColor = isBull ? "#34d399" : "#f87171";

  // If we have candle data, render candlestick chart
  const hasCandles = candles && candles.length > 5;
  const W = hasCandles ? 520 : 280;
  const H = hasCandles ? 200 : 140;
  const padX = hasCandles ? 45 : 30;
  const padY = 20;

  // Map XABCD point indices relative to candle array
  const xIdx = data.X?.index || 0;
  const candleStartIdx = hasCandles ? Math.max(0, xIdx - 5) : 0;

  if (hasCandles) {
    // ─── CANDLESTICK MODE ───
    const cArr = candles;
    const allH = cArr.map((c: any) => c.h);
    const allL = cArr.map((c: any) => c.l);
    // Include targets/SL in price range
    const extraPrices = [target1, target2, stopLoss, entryMin, entryMax].filter(Boolean) as number[];
    const minP = Math.min(...allL, ...extraPrices);
    const maxP = Math.max(...allH, ...extraPrices);
    const range = maxP - minP || 1;

    const candleW = Math.max(2, Math.min(8, (W - padX * 2) / cArr.length - 1));
    const gap = (W - padX * 2) / cArr.length;
    const getCX = (i: number) => padX + i * gap + gap / 2;
    const getY = (v: number) => padY + (1 - (v - minP) / range) * (H - padY * 2);

    // XABCD coords mapped to candle positions
    const patternCoords = lbls.map(k => {
      const ptIdx = (data[k]?.index || 0) - candleStartIdx;
      const price = Number(data[k]?.price);
      return { x: getCX(Math.max(0, Math.min(cArr.length - 1, ptIdx))), y: getY(price), price };
    });
    const patternPath = patternCoords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");

    const fmtP = (v: number) => v >= 1000 ? v.toLocaleString("id-ID") : v.toFixed(0);

    // Ratio labels
    const ratioSegs = [
      { key: "XB", from: 0, to: 2 },
      { key: "AC", from: 1, to: 3 },
      { key: "BD", from: 2, to: 4 },
    ];

    return (
      <svg width={W} height={H + 8} viewBox={`0 0 ${W} ${H + 8}`} style={{ overflow: "hidden", background: "rgba(0,0,0,0.3)", borderRadius: 8 }}>
        {/* Y-axis price labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const price = minP + f * range;
          const y = getY(price);
          return (
            <g key={f}>
              <line x1={padX} x2={W - padX} y1={y} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
              <text x={padX - 4} y={y + 3} textAnchor="end" fontSize={7} fill="rgba(255,255,255,0.25)" fontWeight="600">{fmtP(price)}</text>
            </g>
          );
        })}

        {/* Candlesticks */}
        {cArr.map((c: any, i: number) => {
          const cx = getCX(i);
          const isUp = c.c >= c.o;
          const bodyTop = getY(Math.max(c.o, c.c));
          const bodyBot = getY(Math.min(c.o, c.c));
          const bodyH = Math.max(1, bodyBot - bodyTop);
          const wickTop = getY(c.h);
          const wickBot = getY(c.l);
          const color = isUp ? "#26a69a" : "#ef5350";
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={wickTop} y2={wickBot} stroke={color} strokeWidth={0.8} />
              <rect x={cx - candleW / 2} y={bodyTop} width={candleW} height={bodyH} fill={color} rx={0.5} />
            </g>
          );
        })}

        {/* PRZ Zone */}
        {entryMin && entryMax && (
          <rect x={patternCoords[3]?.x || W * 0.6} y={Math.min(getY(entryMin), getY(entryMax))} 
            width={W - padX - (patternCoords[3]?.x || W * 0.6)} 
            height={Math.abs(getY(entryMax) - getY(entryMin)) || 4}
            fill={isBull ? "rgba(52,211,153,0.1)" : "rgba(248,113,113,0.1)"} 
            stroke={isBull ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)"} strokeWidth={0.5} />
        )}

        {/* Target & SL lines */}
        {target1 && <g><line x1={W * 0.5} x2={W - 5} y1={getY(target1)} y2={getY(target1)} stroke="#26a69a" strokeWidth={0.8} strokeDasharray="4 2" /><text x={W - 3} y={getY(target1) + 3} textAnchor="end" fontSize={7} fill="#26a69a" fontWeight="700">T1 {fmtP(target1)}</text></g>}
        {target2 && <g><line x1={W * 0.5} x2={W - 5} y1={getY(target2)} y2={getY(target2)} stroke="#10b981" strokeWidth={0.8} strokeDasharray="4 2" /><text x={W - 3} y={getY(target2) + 3} textAnchor="end" fontSize={7} fill="#10b981" fontWeight="700">T2 {fmtP(target2)}</text></g>}
        {stopLoss && <g><line x1={W * 0.5} x2={W - 5} y1={getY(stopLoss)} y2={getY(stopLoss)} stroke="#ef5350" strokeWidth={0.8} strokeDasharray="4 2" /><text x={W - 3} y={getY(stopLoss) + 3} textAnchor="end" fontSize={7} fill="#ef5350" fontWeight="700">SL {fmtP(stopLoss)}</text></g>}

        {/* XABCD pattern overlay */}
        <path d={patternPath} fill="none" stroke={mainColor} strokeWidth={2} strokeLinejoin="round" opacity={0.9} />
        <polygon points={patternCoords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")} 
          fill={isBull ? "rgba(52,211,153,0.06)" : "rgba(248,113,113,0.06)"} />

        {/* Ratio labels on legs */}
        {ratios && ratioSegs.map(({ key, from, to }) => {
          if (!ratios[key] || !patternCoords[from] || !patternCoords[to]) return null;
          const mx = (patternCoords[from].x + patternCoords[to].x) / 2;
          const my = (patternCoords[from].y + patternCoords[to].y) / 2;
          return (
            <g key={key}>
              <rect x={mx - 16} y={my - 7} width={32} height={14} rx={3} fill="rgba(0,0,0,0.8)" stroke="rgba(245,158,11,0.3)" strokeWidth={0.5} />
              <text x={mx} y={my + 3} textAnchor="middle" fontSize={8} fill="#f59e0b" fontWeight="800">{Number(ratios[key]).toFixed(3)}</text>
            </g>
          );
        })}

        {/* XABCD point labels */}
        {patternCoords.map((c, i) => {
          const isTop = c.y < H / 2;
          return (
            <g key={i}>
              <circle cx={c.x} cy={c.y} r={4} fill={mainColor} stroke="rgba(0,0,0,0.6)" strokeWidth={1.5} />
              <rect x={c.x - 10} y={isTop ? c.y - 22 : c.y + 8} width={20} height={16} rx={4} 
                fill="rgba(0,0,0,0.85)" stroke={mainColor} strokeWidth={0.8} />
              <text x={c.x} y={isTop ? c.y - 11 : c.y + 19} textAnchor="middle" fontSize={10} fill={mainColor} fontWeight="900">
                {lbls[i]}
              </text>
              <text x={c.x} y={isTop ? c.y - 26 : c.y + 30} textAnchor="middle" fontSize={7} fill="rgba(255,255,255,0.5)" fontWeight="600">
                {fmtP(c.price)}
              </text>
            </g>
          );
        })}

        {/* PRZ label */}
        {entryMin && entryMax && patternCoords[3] && (
          <text x={patternCoords[3].x + 4} y={Math.min(getY(entryMin), getY(entryMax)) - 4} fontSize={8} fill={mainColor} fontWeight="800" opacity={0.7}>
            PRZ
          </text>
        )}
      </svg>
    );
  }

  // ─── FALLBACK: Simple line chart (no candle data) ───
  const allPrices = [...prices];
  if (target1) allPrices.push(target1);
  if (target2) allPrices.push(target2);
  if (stopLoss) allPrices.push(stopLoss);
  const minP = Math.min(...allPrices), maxP = Math.max(...allPrices), range = maxP - minP || 1;
  const getX = (i: number) => padX + (i / 4) * (W - padX * 2);
  const getY = (p: number) => padY + (1 - (p - minP) / range) * (H - padY * 2);
  const coords = prices.map((p, i) => ({ x: getX(i), y: getY(p), price: p }));
  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const fmtP = (v: number) => v >= 1000 ? v.toLocaleString("id-ID") : v.toFixed(2);

  return (
    <svg width={W} height={H + 10} viewBox={`0 0 ${W} ${H + 10}`} style={{ overflow: "hidden", background: "rgba(0,0,0,0.3)", borderRadius: 8 }}>
      <path d={pathD} fill="none" stroke={mainColor} strokeWidth={2} strokeLinejoin="round" />
      <polygon points={coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")} 
        fill={isBull ? "rgba(52,211,153,0.06)" : "rgba(248,113,113,0.06)"} />
      {coords.map((c, i) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r={4} fill={mainColor} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
          <text x={c.x} y={c.y < H/2 ? c.y - 8 : c.y + 14} textAnchor="middle" fontSize={10} fill={mainColor} fontWeight="900">{lbls[i]}</text>
          <text x={c.x} y={c.y < H/2 ? c.y - 18 : c.y + 24} textAnchor="middle" fontSize={7} fill="var(--text-muted)">{fmtP(c.price)}</text>
        </g>
      ))}
    </svg>
  );
}

'''
        pc = pc[:start_idx] + new_func + pc[end_idx:]
        print(f"[F1] Replaced XABCDMiniChart ({len(old_func)} -> {len(new_func)} chars)")
    else:
        print(f"[F1] SKIP: could not find function boundaries (start={start_idx})")

# Update usage to pass candles prop
old_usage = 'XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} target1={p.target_1} target2={p.target_2}'
new_usage = 'XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} target1={p.target_1} target2={p.target_2} candles={p.ohlc_candles}'
if old_usage in pc:
    pc = pc.replace(old_usage, new_usage)
    print("[F2] Updated XABCDMiniChart usage to pass candles")
else:
    print("[F2] SKIP: usage not found")

with open(PAGE, 'w') as f:
    f.write(pc)

print("Done!")
