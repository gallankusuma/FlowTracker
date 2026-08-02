#!/usr/bin/env node
const https = require('https');
const url = `https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?range=2y&interval=1wk`;
https.get(url, { headers: {'User-Agent':'Mozilla/5.0'}, timeout: 10000 }, (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    const j = JSON.parse(data);
    const ts = j?.chart?.result?.[0]?.timestamp || [];
    console.log(`Weekly candles: ${ts.length}`);
    if (ts.length > 0) {
      console.log(`First: ${new Date(ts[0]*1000).toISOString().slice(0,10)}`);
      console.log(`Last: ${new Date(ts[ts.length-1]*1000).toISOString().slice(0,10)}`);
    }
  });
});
