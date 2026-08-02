#!/usr/bin/env python3
"""Upgrade XABCDMiniChart to TradingView-style with labels, ratios, PRZ zone, targets."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# Replace old XABCDMiniChart with new pro version
old_component = '''function XABCDMiniChart({ data, direction }: { data: any; direction: string }) {
  if (!data?.X || !data?.D) return null;
  const pts = ["X","A","B","C","D"].map((k: string) => data[k]?.price).filter(Boolean);
  if (pts.length < 5) return null;
  const W = 120, H = 50, pad = 6;
  const min = Math.min(...pts), max = Math.max(...pts), range = max - min || 1;
  const coords = pts.map((p: number, i: number) => ({
    x: pad + (i / 4) * (W - pad * 2),
    y: pad + (1 - (p - min) / range) * (H - pad * 2),
  }));
  const color = direction === "BULLISH" ? "#34d399" : "#f87171";
  const pathD = coords.map((c: any, i: number) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const labels = ["X","A","B","C","D"];
  return (
    <svg width={W} height={H + 16} viewBox={`0 0 ${W} ${H + 16}`} style={{ overflow: "visible" }}>
      <path d={pathD} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {coords.map((c: any, i: number) => (
        <g key={i}>
          <circle cx={c.x} cy={c.y} r={3} fill={color} />
          <text x={c.x} y={c.y - 5} textAnchor="middle" fontSize={8} fill={color} fontWeight="bold">{labels[i]}</text>
        </g>
      ))}
    </svg>
  );
}'''

new_component = '''function XABCDMiniChart({ data, direction, ratios, entryMin, entryMax, stopLoss, target1, target2 }: { 
  data: any; direction: string; ratios?: any; entryMin?: number; entryMax?: number; 
  stopLoss?: number; target1?: number; target2?: number; 
}) {
  if (!data?.X || !data?.D) return null;
  const labels = ["X","A","B","C","D"];
  const prices = labels.map(k => Number(data[k]?.price)).filter(Boolean);
  if (prices.length < 5) return null;

  const W = 280, H = 140, padX = 30, padY = 20;
  const isBull = direction === "BULLISH";
  const mainColor = isBull ? "#34d399" : "#f87171";
  const dimColor = isBull ? "rgba(52,211,153,0.15)" : "rgba(248,113,113,0.15)";

  // Collect all relevant prices for Y-axis scaling
  const allPrices = [...prices];
  if (target1) allPrices.push(target1);
  if (target2) allPrices.push(target2);
  if (stopLoss) allPrices.push(stopLoss);

  const minP = Math.min(...allPrices);
  const maxP = Math.max(...allPrices);
  const range = maxP - minP || 1;

  const getX = (i: number) => padX + (i / 4) * (W - padX * 2);
  const getY = (p: number) => padY + (1 - (p - minP) / range) * (H - padY * 2);

  const coords = prices.map((p, i) => ({ x: getX(i), y: getY(p), price: p }));
  const pathD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");

  // Fibonacci ratios between legs
  const ratioLabels: { x: number; y: number; text: string }[] = [];
  const ratioKeys = [
    { key: "XB", from: 0, to: 2 },
    { key: "AC", from: 1, to: 3 },
    { key: "BD", from: 2, to: 4 },
    { key: "XD", from: 0, to: 4 },
  ];
  if (ratios) {
    ratioKeys.forEach(({ key, from, to }) => {
      if (ratios[key] !== undefined && coords[from] && coords[to]) {
        const mx = (coords[from].x + coords[to].x) / 2;
        const my = (coords[from].y + coords[to].y) / 2;
        ratioLabels.push({ x: mx, y: my, text: Number(ratios[key]).toFixed(3) });
      }
    });
  }

  // PRZ zone (entry zone)
  const przY1 = entryMin ? getY(entryMin) : null;
  const przY2 = entryMax ? getY(entryMax) : null;

  // Target & SL lines
  const slY = stopLoss ? getY(stopLoss) : null;
  const t1Y = target1 ? getY(target1) : null;
  const t2Y = target2 ? getY(target2) : null;

  const fmtPrice = (v: number) => v >= 1000 ? v.toLocaleString("id-ID") : v.toFixed(2);

  return (
    <svg width={W} height={H + 10} viewBox={`0 0 ${W} ${H + 10}`} style={{ overflow: "hidden" }}>
      {/* Grid lines */}
      {[0.25, 0.5, 0.75].map(f => (
        <line key={f} x1={padX} x2={W - padX} y1={padY + f * (H - padY * 2)} y2={padY + f * (H - padY * 2)} 
          stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
      ))}

      {/* PRZ Zone */}
      {przY1 !== null && przY2 !== null && (
        <rect x={coords[3]?.x || W * 0.6} y={Math.min(przY1, przY2)} 
          width={W - padX - (coords[3]?.x || W * 0.6)} height={Math.abs(przY2 - przY1) || 4}
          fill={isBull ? "rgba(52,211,153,0.08)" : "rgba(248,113,113,0.08)"} 
          stroke={isBull ? "rgba(52,211,153,0.2)" : "rgba(248,113,113,0.2)"} strokeWidth={0.5} />
      )}

      {/* Target lines */}
      {t1Y !== null && (
        <g>
          <line x1={W * 0.55} x2={W - padX} y1={t1Y} y2={t1Y} stroke="#34d399" strokeWidth={0.8} strokeDasharray="4 2" />
          <text x={W - padX + 2} y={t1Y + 3} fontSize={7} fill="#34d399" fontWeight="700">T1 {fmtPrice(target1!)}</text>
        </g>
      )}
      {t2Y !== null && (
        <g>
          <line x1={W * 0.55} x2={W - padX} y1={t2Y} y2={t2Y} stroke="#10b981" strokeWidth={0.8} strokeDasharray="4 2" />
          <text x={W - padX + 2} y={t2Y + 3} fontSize={7} fill="#10b981" fontWeight="700">T2 {fmtPrice(target2!)}</text>
        </g>
      )}
      {slY !== null && (
        <g>
          <line x1={W * 0.55} x2={W - padX} y1={slY} y2={slY} stroke="#f87171" strokeWidth={0.8} strokeDasharray="4 2" />
          <text x={W - padX + 2} y={slY + 3} fontSize={7} fill="#f87171" fontWeight="700">SL {fmtPrice(stopLoss!)}</text>
        </g>
      )}

      {/* Shaded area under pattern */}
      <polygon points={coords.map(c => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ") + ` ${coords[4].x.toFixed(1)},${H - padY} ${coords[0].x.toFixed(1)},${H - padY}`} 
        fill={dimColor} />

      {/* Pattern lines */}
      <path d={pathD} fill="none" stroke={mainColor} strokeWidth={2} strokeLinejoin="round" />

      {/* Ratio labels on legs */}
      {ratioLabels.map((r, i) => (
        <g key={i}>
          <rect x={r.x - 14} y={r.y - 6} width={28} height={12} rx={3} fill="rgba(0,0,0,0.7)" />
          <text x={r.x} y={r.y + 3} textAnchor="middle" fontSize={7} fill="#f59e0b" fontWeight="800">{r.text}</text>
        </g>
      ))}

      {/* Point dots + labels */}
      {coords.map((c, i) => {
        const isTop = c.y < H / 2;
        return (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={4} fill={mainColor} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
            <rect x={c.x - 8} y={isTop ? c.y - 20 : c.y + 8} width={16} height={14} rx={3} 
              fill="rgba(0,0,0,0.8)" stroke={mainColor} strokeWidth={0.5} />
            <text x={c.x} y={isTop ? c.y - 10 : c.y + 18} textAnchor="middle" fontSize={9} fill={mainColor} fontWeight="900">
              {labels[i]}
            </text>
            <text x={c.x} y={isTop ? c.y - 24 : c.y + 28} textAnchor="middle" fontSize={6} fill="var(--text-muted)" fontWeight="600">
              {fmtPrice(c.price)}
            </text>
          </g>
        );
      })}

      {/* PRZ label */}
      {przY1 !== null && przY2 !== null && (
        <text x={(coords[3]?.x || W * 0.6) + 4} y={Math.min(przY1, przY2) - 3} fontSize={7} fill={mainColor} fontWeight="800" opacity={0.8}>
          PRZ
        </text>
      )}
    </svg>
  );
}'''

if old_component in content:
    content = content.replace(old_component, new_component, 1)
    print("[1] Replaced XABCDMiniChart with pro version")
else:
    print("[1] SKIP: old component not found")

# 2. Update the usage in detail panel to pass extra props
old_usage = '<XABCDMiniChart data={p.pattern_data} direction={p.direction} />'
new_usage = '<XABCDMiniChart data={p.pattern_data} direction={p.direction} ratios={p.ratios} entryMin={p.entry_min} entryMax={p.entry_max} stopLoss={p.stop_loss} target1={p.target_1} target2={p.target_2} />'
count = content.count(old_usage)
if count > 0:
    content = content.replace(old_usage, new_usage)
    print(f"[2] Updated XABCDMiniChart usage ({count} occurrences)")
else:
    print("[2] SKIP: usage not found")

# 3. Remove the scale transform wrapper since chart is now bigger
old_wrapper = '''<div style={{ transform: "scale(1.8)", transformOrigin: "center center", margin: "20px 40px" }}>
                            <XABCDMiniChart'''
new_wrapper = '''<div style={{ margin: "8px 0px" }}>
                            <XABCDMiniChart'''
if old_wrapper in content:
    content = content.replace(old_wrapper, new_wrapper, 1)
    print("[3] Removed scale transform (chart is natively large now)")
else:
    print("[3] SKIP: scale wrapper not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
