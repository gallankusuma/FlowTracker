#!/usr/bin/env python3
"""Upgrade crypto harmonic scanner with Wyckoff, SMC, Volume Profile, Bollinger, OHLC candles."""
FILE = '/var/www/flowtracker-scraper/server.js'

with open(FILE, 'r') as f:
    content = f.read()

# Find and replace the entire crypto scanner endpoint
old_start = "// ── GET /api/harmonic-scan-crypto ─────────────────────────────\napp.get('/api/harmonic-scan-crypto', async (req, res) => {"
old_end = "// ── Auto-status updater (called in daily cron) ─────────────────"

start_idx = content.find(old_start)
end_idx = content.find(old_end)

if start_idx < 0 or end_idx < 0:
    print("SKIP: Could not find crypto scanner boundaries")
    exit(1)

new_crypto = '''// ── GET /api/harmonic-scan-crypto ─────────────────────────────
app.get('/api/harmonic-scan-crypto', async (req, res) => {
  const { tickers, min_score = 5, min_rr = 1.5 } = req.query;
  const scanList = tickers
    ? tickers.split(',').map(t => t.trim().toUpperCase())
    : TOP_CRYPTO;

  try {
    const usdIdr = await getUsdIdr();
    const results = [];
    const errors  = [];

    // Import analysis functions
    const {
      detectHarmonicPatterns, detectWyckoffPhase, detectOrderBlocks,
      detectFairValueGaps, detectLiquiditySweeps, buildVolumeProfile,
      calcUltraConviction: calcMasterScore
    } = require('./harmonicEngine');

    // Custom weights for crypto: broker_flow = 0
    const CRYPTO_WEIGHTS = { harmonic: 25, wyckoff: 20, smc: 25, volume_profile: 20, broker_flow: 0 };

    const BATCH = 3;
    for (let i = 0; i < scanList.length; i += BATCH) {
      const batch = scanList.slice(i, i + BATCH);
      await Promise.all(batch.map(async (ticker) => {
        try {
          const raw = await fetchYahooCandles(ticker, '6mo');
          const ohlc = (raw.candles || []).filter(c => c.close > 0);
          if (ohlc.length < 20) return;

          const patterns = detectHarmonicPatterns(ohlc, ticker);
          const last = ohlc[ohlc.length - 1];

          // Compute shared analysis once per ticker
          const wy = detectWyckoffPhase(ohlc) || {};
          const obs = detectOrderBlocks(ohlc) || [];
          const fvgs = detectFairValueGaps(ohlc) || [];
          const sw = detectLiquiditySweeps(ohlc) || {};
          const vp = typeof buildVolumeProfile === 'function' ? buildVolumeProfile(ohlc) : {};

          // Price momentum
          const closes = ohlc.map(c => c.close);
          const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
          const aboveMa20 = last.close > ma20;

          // Wyckoff phase
          const wyckoff_phase = wy.phase || 'UNKNOWN';

          // SMC checks (using last price)
          const in_order_block = Array.isArray(obs) && obs.some(o => last.close >= o.low && last.close <= o.high);
          const in_fvg = Array.isArray(fvgs) && fvgs.some(g => last.close >= g.low && last.close <= g.high);
          const liquidity_sweep = sw.recent_sweep || false;

          for (const p of patterns) {
            // Build scoring data
            const structureData = { trend: aboveMa20 ? p.direction : 'NEUTRAL', bos_bullish: false, bos_bearish: false, choch: false };
            const wyckoffData = { phase: wyckoff_phase, spring: wy.spring || false, upthrust: wy.upthrust || false, sign_of_strength: wy.sign_of_strength || false, buying_climax: wy.buying_climax || false };
            const smcData = { order_blocks: obs, fair_value_gaps: fvgs, liquidity_sweeps: sw };
            const volProfileData = vp || {};
            // Crypto has no broker data
            const brokerData = { foreignNet: 0, bigMoneyNet: 0, dn0: 0, dn1: 0, dn2: 0 };

            let ms;
            try {
              ms = calcMasterScore(p, structureData, wyckoffData, smcData, volProfileData, brokerData, CRYPTO_WEIGHTS);
            } catch {
              ms = { master_score: Math.min(100, (p.fib_score || 50) + (p.risk_reward > 2 ? 10 : 0)), signal: p.direction === 'BULLISH' ? 'BUY' : 'SELL', breakdown: {} };
            }

            const conviction = ms.master_score || ms.score || 50;
            if (conviction < Number(min_score)) continue;
            if (p.risk_reward < Number(min_rr)) continue;

            // Bollinger Bands 30D
            const bb_data = [];
            try {
              const startIndex = Math.max(19, closes.length - 30);
              for (let k = startIndex; k < closes.length; k++) {
                const slice = closes.slice(k - 19, k + 1);
                if (slice.length < 20) continue;
                const sma = slice.reduce((a, b) => a + b, 0) / 20;
                const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / 20;
                const stddev = Math.sqrt(variance);
                bb_data.push({
                  close: closes[k],
                  sma: Number(sma.toFixed(2)),
                  upper: Number((sma + 2 * stddev).toFixed(2)),
                  lower: Number((sma - 2 * stddev).toFixed(2))
                });
              }
            } catch {}

            // OHLC candles for candlestick chart
            const xIdx = p.pattern_data?.X?.index || 0;
            const candleStart = Math.max(0, xIdx - 5);
            const ohlc_candles = ohlc.slice(candleStart).map(c => ({
              d: (() => { try { const dt = new Date(c.date); return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch { return c.date?.slice(5,10) || ''; } })(),
              o: Number(c.open) || c.close,
              h: Number(c.high) || c.close,
              l: Number(c.low) || c.close,
              c: Number(c.close),
            }));

            // Price in USD
            const entryUsd = p.entry_price;
            const entryIdr = Math.round(entryUsd * usdIdr);

            results.push({
              ...p,
              ticker: ticker.replace('-USD',''),
              full_symbol: ticker,
              conviction_score: conviction,
              signal: ms.signal || p.direction,
              conviction_breakdown: {
                harmonic: ms.breakdown?.harmonic || 0,
                wyckoff: ms.breakdown?.wyckoff || 0,
                smc: ms.breakdown?.smc || 0,
                volume_profile: ms.breakdown?.volume_profile || 0,
                broker_flow: 0,  // Not applicable for crypto
              },
              smart_money_confirmed: false,
              foreign_3d_B: 0,
              wyckoff_phase,
              in_order_block,
              in_fvg,
              liquidity_sweep,
              current_price: last.close,
              smc_tags: [in_order_block?'OB':'', in_fvg?'FVG':'', liquidity_sweep?'Sweep':''].filter(Boolean).join(','),
              bb_data,
              ohlc_candles,
              // USD prices
              entry_usd: entryUsd,
              entry_idr: entryIdr,
              sl_usd: p.stop_loss,
              t1_usd: p.target_1,
              t2_usd: p.target_2,
              sl_idr: Math.round(p.stop_loss * usdIdr),
              t1_idr: Math.round(p.target_1 * usdIdr),
              t2_idr: Math.round(p.target_2 * usdIdr),
              volume_confirmed: false,
              above_ma20: aboveMa20,
              usdIdr,
              market: 'CRYPTO',
            });
          }
        } catch (err) {
          errors.push({ ticker, error: err.message });
        }
      }));
      if (i + BATCH < scanList.length) await new Promise(r => setTimeout(r, 500));
    }

    results.sort((a, b) => b.conviction_score - a.conviction_score);
    res.json({
      scanned: scanList.length, found: results.length,
      errors: errors.length, usdIdr,
      date: new Date().toISOString().slice(0,10),
      results,
    });
  } catch (err) {
    console.error('[harmonic-scan-crypto]', err.message);
    res.status(500).json({ error: err.message });
  }
});

'''

content = content[:start_idx] + new_crypto + content[end_idx:]
print("[1] Replaced crypto scanner with full-layer version")

with open(FILE, 'w') as f:
    f.write(content)
print("Done!")
