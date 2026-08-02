#!/usr/bin/env python3
"""Add date labels on X-axis, improve price labels on Y-axis of candlestick chart."""
FILE = '/var/www/flowtracker/app/signal-scanner/page.tsx'

with open(FILE, 'r') as f:
    content = f.read()

# 1. Increase chart height to accommodate X-axis labels
old_dims = '''  const W = hasCandles ? 520 : 280;
  const H = hasCandles ? 200 : 140;
  const padX = hasCandles ? 45 : 30;
  const padY = 20;'''
new_dims = '''  const W = hasCandles ? 560 : 280;
  const H = hasCandles ? 220 : 140;
  const padX = hasCandles ? 50 : 30;
  const padY = 22;
  const padBottom = hasCandles ? 28 : 0;'''
if old_dims in content:
    content = content.replace(old_dims, new_dims, 1)
    print("[1] Updated chart dimensions")
else:
    print("[1] SKIP: dims not found")

# 2. Update SVG viewBox to include bottom padding for X-axis
old_svg = '''<svg width={W} height={H + 8} viewBox={`0 0 ${W} ${H + 8}`} style={{ overflow: "hidden", background: "rgba(0,0,0,0.3)", borderRadius: 8 }}>'''
new_svg = '''<svg width={W} height={H + padBottom + 8} viewBox={`0 0 ${W} ${H + padBottom + 8}`} style={{ overflow: "hidden", background: "rgba(0,0,0,0.3)", borderRadius: 8 }}>'''
if old_svg in content:
    content = content.replace(old_svg, new_svg, 1)
    print("[2] Updated SVG viewBox")
else:
    print("[2] SKIP: SVG not found")

# 3. Improve Y-axis labels (brighter, better formatting)
old_yaxis = '''        {/* Y-axis price labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => {
          const price = minP + f * range;
          const y = getY(price);
          return (
            <g key={f}>
              <line x1={padX} x2={W - padX} y1={y} y2={y} stroke="rgba(255,255,255,0.04)" strokeWidth={0.5} />
              <text x={padX - 4} y={y + 3} textAnchor="end" fontSize={7} fill="rgba(255,255,255,0.25)" fontWeight="600">{fmtP(price)}</text>
            </g>
          );
        })}'''

new_yaxis = '''        {/* Y-axis price labels + grid */}
        {[0, 0.2, 0.4, 0.6, 0.8, 1].map(f => {
          const price = minP + f * range;
          const y = getY(price);
          return (
            <g key={f}>
              <line x1={padX} x2={W - padX} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
              <text x={padX - 5} y={y + 3} textAnchor="end" fontSize={8} fill="rgba(255,255,255,0.45)" fontWeight="700">{fmtP(price)}</text>
            </g>
          );
        })}

        {/* X-axis date labels */}
        {(() => {
          const step = Math.max(1, Math.floor(cArr.length / 8));
          const labels: any[] = [];
          for (let i = 0; i < cArr.length; i += step) {
            labels.push({ i, d: cArr[i].d });
          }
          // Always include last candle
          if (labels[labels.length - 1]?.i !== cArr.length - 1) {
            labels.push({ i: cArr.length - 1, d: cArr[cArr.length - 1].d });
          }
          return labels.map(({ i, d }) => (
            <g key={`d${i}`}>
              <line x1={getCX(i)} x2={getCX(i)} y1={H - padY + 5} y2={H - padY + 10} stroke="rgba(255,255,255,0.15)" strokeWidth={0.5} />
              <text x={getCX(i)} y={H - padY + 22} textAnchor="middle" fontSize={8} fill="rgba(255,255,255,0.4)" fontWeight="600">{d}</text>
            </g>
          ));
        })()}
        
        {/* X-axis line */}
        <line x1={padX} x2={W - padX} y1={H - padY + 5} y2={H - padY + 5} stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />
        {/* Y-axis line */}
        <line x1={padX} x2={padX} y1={padY} y2={H - padY + 5} stroke="rgba(255,255,255,0.1)" strokeWidth={0.5} />'''

if old_yaxis in content:
    content = content.replace(old_yaxis, new_yaxis, 1)
    print("[3] Improved Y-axis + added X-axis date labels")
else:
    print("[3] SKIP: Y-axis section not found")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
