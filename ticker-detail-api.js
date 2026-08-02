// ─── TICKER DETAIL — Fund summary, broker action, heatmap, net tracker ───────
// GET /api/ticker-detail?ticker=TLKM&days=20

module.exports = function(app, pool, formatVal, formatLot) {

app.get('/api/ticker-detail', async (req, res) => {
  const ticker = (req.query.ticker || '').toUpperCase();
  const days = Number(req.query.days) || 20;
  if (!ticker) return res.json({ error: 'ticker required', data: {} });

  try {
    // 1) Get available dates for this ticker
    const [dateRows] = await pool.query(
      'SELECT DISTINCT date FROM idx_broker_summary WHERE stock_code = ? ORDER BY date DESC LIMIT ?',
      [ticker, days]
    );
    const dates = dateRows.map(r => {
      const d = new Date(r.date);
      return d.toISOString().split('T')[0];
    }).reverse();

    if (dates.length === 0) {
      return res.json({ error: 'No data for ticker', ticker, data: {} });
    }

    // 2) Fund Summary — daily aggregated buy vs sell
    const [fundRows] = await pool.query(
      `SELECT date, SUM(buy_val) as total_buy, SUM(sell_val) as total_sell, 
              SUM(buy_val) - SUM(sell_val) as net_flow
       FROM idx_broker_summary WHERE stock_code = ? AND date IN (?)
       GROUP BY date ORDER BY date ASC`,
      [ticker, dates]
    );
    const fundSummary = fundRows.map(r => ({
      date: new Date(r.date).toISOString().split('T')[0],
      buy: Number(r.total_buy),
      sell: Number(r.total_sell),
      net: Number(r.net_flow),
    }));

    // 3) Broker Action — top 5 brokers' daily net over time
    const [topBrokers] = await pool.query(
      `SELECT broker_code, SUM(ABS(net_val)) as activity
       FROM idx_broker_summary WHERE stock_code = ? AND date IN (?)
       GROUP BY broker_code ORDER BY activity DESC LIMIT 5`,
      [ticker, dates]
    );
    const brokerCodes = topBrokers.map(b => b.broker_code);
    
    let brokerAction = [];
    if (brokerCodes.length > 0) {
      const [baRows] = await pool.query(
        `SELECT date, broker_code, (buy_val - sell_val) as net
         FROM idx_broker_summary WHERE stock_code = ? AND broker_code IN (?) AND date IN (?)
         ORDER BY date ASC`,
        [ticker, brokerCodes, dates]
      );
      const dateMap = {};
      for (const d of dates) dateMap[d] = { date: d };
      for (const r of baRows) {
        const d = new Date(r.date).toISOString().split('T')[0];
        if (dateMap[d]) dateMap[d][r.broker_code] = Number(r.net);
      }
      brokerAction = Object.values(dateMap);
    }

    // 4) Stock Prices (candlestick data)
    const [priceRows] = await pool.query(
      `SELECT date, open_price, high_price, low_price, close_price, volume
       FROM idx_stock_prices WHERE stock_code = ? ORDER BY date DESC LIMIT ?`,
      [ticker, days]
    );
    const candlestick = priceRows.reverse().map(r => ({
      date: new Date(r.date).toISOString().split('T')[0],
      open: Number(r.open_price),
      high: Number(r.high_price),
      low: Number(r.low_price),
      close: Number(r.close_price),
      volume: Number(r.volume),
    }));

    // 5) Broker Heatmap — top 15 brokers' net per day
    const [hmRows] = await pool.query(
      `SELECT date, broker_code, (buy_val - sell_val) as net
       FROM idx_broker_summary WHERE stock_code = ? AND date IN (?)
       ORDER BY broker_code, date`,
      [ticker, dates]
    );
    const brokerActivity = {};
    for (const r of hmRows) {
      if (!brokerActivity[r.broker_code]) brokerActivity[r.broker_code] = 0;
      brokerActivity[r.broker_code] += Math.abs(Number(r.net));
    }
    const topHmBrokers = Object.entries(brokerActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(e => e[0]);

    const heatmap = { brokers: topHmBrokers, dates, data: {} };
    for (const r of hmRows) {
      if (!topHmBrokers.includes(r.broker_code)) continue;
      const d = new Date(r.date).toISOString().split('T')[0];
      if (!heatmap.data[r.broker_code]) heatmap.data[r.broker_code] = {};
      heatmap.data[r.broker_code][d] = Number(r.net);
    }

    // 6) Broker Net Tracker — detailed per-broker stats + daily series
    const [trackerRows] = await pool.query(
      `SELECT broker_code, 
              SUM(buy_val) as total_buy, SUM(sell_val) as total_sell,
              SUM(buy_val - sell_val) as total_net,
              SUM(buy_lot) as total_buy_lot, SUM(sell_lot) as total_sell_lot,
              COUNT(DISTINCT date) as days_active
       FROM idx_broker_summary WHERE stock_code = ? AND date IN (?)
       GROUP BY broker_code
       ORDER BY ABS(SUM(buy_val - sell_val)) DESC
       LIMIT 20`,
      [ticker, dates]
    );
    
    const trackerBrokers = trackerRows.map(r => r.broker_code);
    let trackerSeries = {};
    if (trackerBrokers.length > 0) {
      const [tsRows] = await pool.query(
        `SELECT date, broker_code, (buy_val - sell_val) as net
         FROM idx_broker_summary WHERE stock_code = ? AND broker_code IN (?) AND date IN (?)
         ORDER BY date ASC`,
        [ticker, trackerBrokers, dates]
      );
      for (const r of tsRows) {
        const d = new Date(r.date).toISOString().split('T')[0];
        if (!trackerSeries[r.broker_code]) trackerSeries[r.broker_code] = [];
        trackerSeries[r.broker_code].push({ date: d, net: Number(r.net) });
      }
    }
    
    const brokerTracker = trackerRows.map(r => ({
      broker: r.broker_code,
      totalBuy: Number(r.total_buy),
      totalSell: Number(r.total_sell),
      totalNet: Number(r.total_net),
      totalBuyFmt: formatVal(Number(r.total_buy)),
      totalSellFmt: formatVal(Number(r.total_sell)),
      totalNetFmt: formatVal(Math.abs(Number(r.total_net))),
      daysActive: r.days_active,
      series: trackerSeries[r.broker_code] || [],
    }));

    res.json({
      ticker,
      dates,
      brokerCodes,
      fundSummary,
      brokerAction,
      candlestick,
      heatmap,
      brokerTracker,
    });
  } catch (err) {
    console.error('Ticker detail error:', err.message);
    res.json({ error: err.message, ticker, data: {} });
  }
});

};
