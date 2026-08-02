// Yahoo Finance Candle Proxy — flowtracker scraper module
const https = require('https');

const yfCache = new Map(); // key -> { data, ts }
const CACHE_TTL = 3600000; // 1 hour

function fetchYahooCandles(ticker, range, suffix = '.JK') {
  return new Promise((resolve, reject) => {
    // Index symbols (e.g. ^JKSE / IHSG, ^GSPC / S&P 500) are raw Yahoo
    // symbols — don't append a suffix. US tickers pass suffix='' since
    // they're already bare Yahoo symbols (AAPL, not AAPL.JK).
    const symbol = ticker.startsWith('^') ? ticker.toUpperCase() : ticker.toUpperCase() + suffix;
    const path = '/v8/finance/chart/' + symbol + '?interval=1d&range=' + range;
    const opts = {
      hostname: 'query2.finance.yahoo.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com',
      }
    };

    const req = https.get(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const result = json && json.chart && json.chart.result && json.chart.result[0];
          if (!result) return reject(new Error('No data from Yahoo Finance'));

          const timestamps = result.timestamp || [];
          const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

          const candles = timestamps.map((ts, i) => {
            const date = new Date(ts * 1000);
            const yyyy = date.getFullYear();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            return {
              date: yyyy + '-' + mm + '-' + dd,
              open:   Math.round(quote.open   && quote.open[i]   || 0),
              high:   Math.round(quote.high   && quote.high[i]   || 0),
              low:    Math.round(quote.low    && quote.low[i]    || 0),
              close:  Math.round(quote.close  && quote.close[i]  || 0),
              volume: (quote.volume && quote.volume[i]) || 0,
            };
          }).filter(c => c.close > 0);

          resolve({ candles, total: candles.length, symbol });
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('Yahoo Finance timeout'));
    });
  });
}

// ─── Live intraday quote (for journal "HARGA ACTUAL" real-time display) ────
const liveQuoteCache = new Map(); // ticker -> { price, ts, marketTime }
const LIVE_QUOTE_CACHE_TTL = 15000; // 15s — enough to dedupe rapid polling without going stale

function fetchYahooLiveQuote(ticker, suffix = '.JK') {
  const cacheKey = ticker + suffix;
  const cached = liveQuoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LIVE_QUOTE_CACHE_TTL) {
    return Promise.resolve(cached);
  }
  return new Promise((resolve) => {
    const symbol = ticker.toUpperCase() + suffix;
    const opts = {
      hostname: 'query2.finance.yahoo.com',
      path: '/v8/finance/chart/' + symbol + '?interval=1m&range=1d',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com',
      },
    };
    const req = https.get(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const meta = json?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice || null;
          const marketTime = meta?.regularMarketTime ? meta.regularMarketTime * 1000 : null;
          const entry = { price, ts: Date.now(), marketTime };
          if (price) liveQuoteCache.set(cacheKey, entry);
          resolve(entry);
        } catch (e) {
          resolve(cached || { price: null, ts: Date.now(), marketTime: null });
        }
      });
    });
    req.on('error', () => resolve(cached || { price: null, ts: Date.now(), marketTime: null }));
    req.setTimeout(8000, () => { req.destroy(); resolve(cached || { price: null, ts: Date.now(), marketTime: null }); });
  });
}

// ─── Intraday candles (for the "1D" range on IHSG/index charts) ────────────
// Separate from fetchYahooCandles rather than adding an `interval` param to
// it — that function's `date` field is a day-only string by design (every
// existing caller assumes one row per day), so reusing it for 5-minute bars
// would either break those callers or need a parallel code path anyway.
// Timestamps are converted to WIB (UTC+7) explicitly via a manual offset,
// not the server process's local timezone, so this is correct regardless of
// what timezone the VPS itself is set to.
const intradayCache = new Map(); // key -> { data, ts }
const INTRADAY_CACHE_TTL = 60000; // 60s — intraday bars only update every few minutes anyway

function fetchYahooIntraday(ticker, interval = '5m', range = '1d') {
  const symbol = ticker.startsWith('^') ? ticker.toUpperCase() : ticker.toUpperCase() + '.JK';
  const cacheKey = symbol + ':' + interval + ':' + range;
  const cached = intradayCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < INTRADAY_CACHE_TTL) {
    return Promise.resolve(cached.data);
  }
  return new Promise((resolve, reject) => {
    const path = '/v8/finance/chart/' + symbol + '?interval=' + interval + '&range=' + range;
    const opts = {
      hostname: 'query2.finance.yahoo.com',
      path: path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com',
      }
    };

    const req = https.get(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          const result = json && json.chart && json.chart.result && json.chart.result[0];
          if (!result) return reject(new Error('No data from Yahoo Finance'));

          const timestamps = result.timestamp || [];
          const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};

          const candles = timestamps.map((ts, i) => {
            const wib = new Date((ts + 7 * 3600) * 1000); // shift to WIB, then read as UTC fields
            const hh = String(wib.getUTCHours()).padStart(2, '0');
            const mm = String(wib.getUTCMinutes()).padStart(2, '0');
            return {
              time: hh + ':' + mm,
              timestamp: ts * 1000,
              open: quote.open && quote.open[i],
              high: quote.high && quote.high[i],
              low: quote.low && quote.low[i],
              close: quote.close && quote.close[i],
              volume: (quote.volume && quote.volume[i]) || 0,
            };
          }).filter(c => c.close != null && c.close > 0);

          const data = { candles, total: candles.length, symbol, meta: result.meta || {} };
          intradayCache.set(cacheKey, { data, ts: Date.now() });
          resolve(data);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error('Yahoo Finance timeout'));
    });
  });
}

module.exports = { fetchYahooCandles, yfCache, CACHE_TTL, fetchYahooLiveQuote, fetchYahooIntraday };
