#!/usr/bin/env node
/**
 * Deep diagnostic: why crypto finds 0 patterns with current settings.
 * Tests all 3 timeframes with various filter looseness levels.
 */
const { detectHarmonicPatterns } = require('./harmonicEngine');
const https = require('https');

function fetchYahoo(ticker, range, interval) {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=${range}&interval=${interval}`;
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
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

const TICKERS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD', 'DOT-USD', 'AVAX-USD', 'LINK-USD'];

const TF_TESTS = [
  { label: 'DAILY',   interval: '1d',  range: '1y' },
  { label: 'WEEKLY',  interval: '1wk', range: '2y' },
  { label: 'MONTHLY', interval: '1mo', range: '5y' },
];

// Different filter levels to find the sweet spot
const FILTER_LEVELS = [
  { label: 'STRICT (current)',  maxDAge: 5,  swingLeft: 5, swingRight: 3, maxPatternSpan: 80,  maxPrzGap: 0.12 },
  { label: 'MEDIUM',           maxDAge: 10, swingLeft: 3, swingRight: 2, maxPatternSpan: 100, maxPrzGap: 0.15 },
  { label: 'LOOSE',            maxDAge: 15, swingLeft: 3, swingRight: 2, maxPatternSpan: 120, maxPrzGap: 0.20 },
  { label: 'CRYPTO-TUNED',     maxDAge: 8,  swingLeft: 3, swingRight: 2, maxPatternSpan: 100, maxPrzGap: 0.15 },
];

(async () => {
  for (const tf of TF_TESTS) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TIMEFRAME: ${tf.label} (${tf.interval})`);
    console.log('='.repeat(60));
    
    for (const ticker of TICKERS) {
      const ohlc = await fetchYahoo(ticker, tf.range, tf.interval);
      if (ohlc.length < 20) { console.log(`  ${ticker}: insufficient data (${ohlc.length})`); continue; }
      
      const lastDate = ohlc[ohlc.length - 1].date;
      const lastClose = ohlc[ohlc.length - 1].close;
      
      let line = `  ${ticker.padEnd(10)} ${ohlc.length}c last:${lastDate} $${lastClose.toFixed(0).padStart(6)} |`;
      
      for (const fl of FILTER_LEVELS) {
        // Adjust for weekly/monthly
        let dAge = fl.maxDAge;
        let span = fl.maxPatternSpan;
        if (tf.interval === '1wk') { span = Math.round(span * 0.7); }
        if (tf.interval === '1mo') { span = Math.round(span * 0.5); dAge = Math.max(2, Math.round(dAge * 0.5)); }
        
        const patterns = detectHarmonicPatterns(ohlc, ticker, {
          maxPatternSpan: span,
          maxDAge: dAge,
          maxPrzGap: fl.maxPrzGap,
          swingLeft: fl.swingLeft,
          swingRight: fl.swingRight,
        });
        
        if (patterns.length > 0) {
          const p = patterns[0];
          const dIdx = p.pattern_data?.D?.index || 0;
          const dAgeActual = ohlc.length - 1 - dIdx;
          line += ` ${fl.label.split(' ')[0]}:${patterns.length}(dAge${dAgeActual})`;
        } else {
          line += ` ${fl.label.split(' ')[0]}:0`;
        }
      }
      console.log(line);
    }
  }
  
  // Now test with the CRYPTO-TUNED settings specifically
  console.log(`\n${'='.repeat(60)}`);
  console.log('RECOMMENDED CRYPTO SETTINGS (swingLeft:3, swingRight:2)');
  console.log('='.repeat(60));
  
  const cryptoOpts = {
    '1d':  { maxPatternSpan: 100, maxDAge: 8,  maxPrzGap: 0.15, swingLeft: 3, swingRight: 2 },
    '1wk': { maxPatternSpan: 60,  maxDAge: 4,  maxPrzGap: 0.15, swingLeft: 3, swingRight: 2 },
    '1mo': { maxPatternSpan: 40,  maxDAge: 2,  maxPrzGap: 0.20, swingLeft: 2, swingRight: 1 },
  };
  
  for (const tf of TF_TESTS) {
    const opts = cryptoOpts[tf.interval];
    console.log(`\n${tf.label}: span=${opts.maxPatternSpan}, dAge=${opts.maxDAge}, gap=${opts.maxPrzGap}, swing=${opts.swingLeft}/${opts.swingRight}`);
    
    let total = 0;
    for (const ticker of TICKERS) {
      const range = tf.interval === '1mo' ? '5y' : tf.interval === '1wk' ? '2y' : '1y';
      const ohlc = await fetchYahoo(ticker, range, tf.interval);
      if (ohlc.length < 20) continue;
      
      const patterns = detectHarmonicPatterns(ohlc, ticker, opts);
      total += patterns.length;
      
      for (const p of patterns) {
        const pd = p.pattern_data;
        const dAgeActual = ohlc.length - 1 - pd.D.index;
        const dDate = pd.D.date;
        console.log(`  ✅ ${ticker.padEnd(10)} ${p.pattern_type.padEnd(12)} ${p.direction.padEnd(8)} D:${dDate} dAge:${dAgeActual} fib:${p.fib_score} RR:${p.risk_reward?.toFixed(1)}`);
      }
    }
    console.log(`  TOTAL: ${total} patterns found`);
  }
})();
