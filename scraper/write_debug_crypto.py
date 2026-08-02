#!/usr/bin/env python3
"""Debug: run crypto detect directly to see what patterns are found."""
# This runs on the server directly

code = '''
const { detectHarmonicPatterns } = require('./harmonicEngine');
const https = require('https');

function fetchYahoo(ticker) {
  return new Promise((resolve, reject) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=6mo&interval=1d`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const r = j.chart?.result?.[0];
          if (!r) return resolve([]);
          const ts = r.timestamp || [];
          const q = r.indicators?.quote?.[0] || {};
          const candles = ts.map((t, i) => ({
            date: new Date(t * 1000).toISOString().slice(0, 10),
            open: q.open?.[i], high: q.high?.[i], low: q.low?.[i],
            close: q.close?.[i], volume: q.volume?.[i]
          })).filter(c => c.close > 0);
          resolve(candles);
        } catch(e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

(async () => {
  const tickers = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD', 'XRP-USD'];
  
  for (const ticker of tickers) {
    const ohlc = await fetchYahoo(ticker);
    console.log(`\\n${ticker}: ${ohlc.length} candles`);
    
    // VERY LOOSE - find everything
    const loose = detectHarmonicPatterns(ohlc, ticker, {
      maxPatternSpan: 999, maxDAge: 999, maxPrzGap: 1.0
    });
    console.log(`  LOOSE: ${loose.length} patterns`);
    for (const p of loose) {
      const pd = p.pattern_data;
      const dAge = ohlc.length - 1 - pd.D.index;
      console.log(`    ${p.pattern_type.padEnd(12)} ${p.direction.padEnd(8)} dAge:${dAge} span:${pd.D.index - pd.X.index} fib:${p.fib_score}`);
    }
    
    // PRODUCTION
    const tight = detectHarmonicPatterns(ohlc, ticker, {
      maxPatternSpan: 80, maxDAge: 10, maxPrzGap: 0.12
    });
    console.log(`  TIGHT: ${tight.length} patterns`);
  }
})();
'''

with open('/var/www/flowtracker-scraper/debug_crypto_direct.js', 'w') as f:
    f.write(code)
print("Script written")
