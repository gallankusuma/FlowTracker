'use strict';
/**
 * Deep analysis for one ticker — the top-down read, computed instead of drawn.
 *
 * Modelled on a worked example: weekly structure, then daily support/resistance,
 * then an intraday setup, then volume, then EMA/BB. The example ends its level
 * table with "angka perlu dirapikan langsung menggunakan wick dan body pada
 * TradingView karena screenshot tidak menunjukkan seluruh label dengan
 * sempurna" -- that caveat is the whole reason this exists. We read the OHLC,
 * not a picture of it, so the numbers need no tidying.
 *
 * ── THE LINE THIS FILE WILL NOT CROSS ────────────────────────────────────────
 *
 * Every number here is MEASURED. Every sentence that interprets one is marked
 * as CONVENTION and is not evidence. That separation is not pedantry in this
 * project: EXP-016 found the broker "accumulation" signal is INVERTED, and the
 * scanner score turned out to be contemporaneous rather than predictive. Both
 * looked obviously right until measured. A report that mixes the two teaches
 * whoever reads it to trust the wrong half.
 *
 * So a zone is reported with the evidence that makes it a zone -- how much
 * volume changed hands there and how many times price actually turned -- and
 * never with a claim about what it will do next.
 *
 * ── WHAT IS OURS AND NOT ON ANY CHART ────────────────────────────────────────
 *
 * idx_broker_summary carries buy_avg / sell_avg per broker per day, so the price
 * the accumulating side actually paid is knowable. Nobody can draw that.
 *
 * Usage: node deep_analysis.js ADMR [--json]
 */

require('dotenv').config();
const { createPool } = require('./modules/db_config');
const { ema, emaSeedWeight } = require('./awo_technical');
const { loadRegistry, describe } = require('./modules/broker_registry');

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const round = (v, n = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ─── structure ──────────────────────────────────────────────────────────────

/**
 * Swing pivots: a bar whose high tops its `k` neighbours each side (or low bottoms them).
 * `k` sets what counts as a swing at all -- larger k, fewer and more major pivots.
 */
function pivots(bars, k = 3) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) isHigh = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) isLow = false;
    }
    if (isHigh) out.push({ i, d: bars[i].d, p: bars[i].h, kind: 'high' });
    if (isLow) out.push({ i, d: bars[i].d, p: bars[i].l, kind: 'low' });
  }
  return out.sort((a, b) => a.i - b.i);
}

/**
 * Higher-high/higher-low or lower-high/lower-low, from the last two of each.
 *
 * This is the one part of a chart read that is genuinely mechanical: the labels
 * follow from the pivot sequence and nothing else. What it will NOT do is call
 * a reversal -- it reports the sequence and what would have to happen to change
 * it, which is the honest form of the same statement.
 */
function structure(bars, k = 3) {
  const p = pivots(bars, k);
  const highs = p.filter(x => x.kind === 'high').slice(-3);
  const lows = p.filter(x => x.kind === 'low').slice(-3);
  if (highs.length < 2 || lows.length < 2) {
    return { state: 'UNDETERMINED', reason: 'not enough swings', pivots: p.length, highs, lows };
  }
  const hh = highs[highs.length - 1].p > highs[highs.length - 2].p;
  const hl = lows[lows.length - 1].p > lows[lows.length - 2].p;

  let state;
  if (hh && hl) state = 'UPTREND (higher high, higher low)';
  else if (!hh && !hl) state = 'DOWNTREND (lower high, lower low)';
  else if (hl && !hh) state = 'REVERSAL ATTEMPT (higher low, no higher high yet)';
  else state = 'DISTRIBUTION ATTEMPT (lower high, higher low held)';

  const last = bars[bars.length - 1].c;
  const nearestHigh = highs[highs.length - 1];
  const nearestLow = lows[lows.length - 1];

  // A pivot cannot exist until `k` bars have closed on BOTH sides of it, so the
  // most recent swing is always at least k bars old and the last k bars can
  // never be one yet. That is not a defect -- it is what makes a swing a swing --
  // but it means price can already be trading ABOVE the last confirmed swing
  // high. Saying "needs a close above 1695" when price is 1710 reads as though
  // something is pending that has in fact already happened, so the two cases are
  // reported differently.
  const alreadyAbove = last > nearestHigh.p;
  const barsSincePivot = bars.length - 1 - nearestHigh.i;

  return {
    state,
    pivots: p.length,
    pivotConfirmationLag: k,
    lastSwingHigh: { price: nearestHigh.p, date: nearestHigh.d, barsAgo: barsSincePivot },
    lastSwingLow: { price: nearestLow.p, date: nearestLow.d },
    // What the example calls "supaya weekly berubah lebih meyakinkan": stated as
    // a price and a condition rather than a prediction.
    toConfirmUp: alreadyAbove ? {
      status: 'price is ALREADY above the last confirmed swing high',
      lastConfirmedHigh: nearestHigh.p,
      abovePct: round((last / nearestHigh.p - 1) * 100),
      then: `a new swing high cannot be confirmed until ${k} more bars close beyond it; ` +
            'until then this is an unconfirmed break, not a higher high',
    } : {
      needsCloseAbove: nearestHigh.p,
      distancePct: round((nearestHigh.p / last - 1) * 100),
      then: 'a pullback that holds as a higher low, then a higher high',
    },
    invalidation: {
      below: lows[lows.length - 1].p,
      distancePct: round((lows[lows.length - 1].p / last - 1) * 100),
      meaning: 'the most recent swing low; below it the higher-low sequence is broken',
    },
  };
}

// ─── zones ──────────────────────────────────────────────────────────────────

/**
 * Volume-at-price, with the evidence that makes a shelf worth naming.
 *
 * Each session's volume is spread evenly across the range it traded in. That is
 * crude against a tick-by-tick profile, but it uses only what was recorded --
 * and unlike a hand-drawn level it is the same number every time it is computed.
 *
 * The pivot count describes what happened INSIDE the window: a shelf with volume
 * but no turns is a band price passed through, one with both is where it kept
 * stopping. It is a fact about the past and it is reported as one.
 *
 * IT IS NOT A QUALITY FILTER, AND I DESIGNED IT BELIEVING IT WAS. EXP-036
 * measured it out of sample: restricting to zones that had turns in the prior
 * window gives +5.315 pp against +5.668 pp for all zones -- very slightly WORSE.
 * The column stays because "price turned here before" is worth seeing; the claim
 * that it picks better zones is withdrawn.
 */
function zones(bars, nBuckets = 60, topN = 8, maxWidthPct = 5) {
  const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return { zones: [], lo, hi };

  // LOG-SPACED buckets, not linear. ADMR ran 970 to 2320 in this window, so a
  // linear bucket 22 rupiah wide is 2.3% of price at the bottom and 1.0% at the
  // top -- the same "zone" means two different things depending on where it
  // sits, and the low end gets over-resolved. Equal percentage width keeps a
  // zone the same size in the only unit that matters to a position.
  const lnLo = Math.log(lo), lnHi = Math.log(hi);
  const w = (lnHi - lnLo) / nBuckets;
  const edge = i => Math.exp(lnLo + i * w);
  const bucketOf = p => Math.max(0, Math.min(nBuckets - 1, Math.floor((Math.log(p) - lnLo) / w)));

  const vol = new Array(nBuckets).fill(0);
  for (const b of bars) {
    const a = bucketOf(b.l), z = bucketOf(b.h);
    const share = b.v / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i] += share;
  }
  const total = vol.reduce((a, b) => a + b, 0);
  const piv = pivots(bars, 3);

  const all = vol.map((v, i) => {
    const zlo = edge(i), zhi = edge(i + 1);
    return { i, lo: zlo, hi: zhi, vol: v, volPct: total ? v / total * 100 : 0,
      turns: piv.filter(x => x.p >= zlo && x.p <= zhi).length };
  });

  // Point of control and the value area: the band holding 70% of the volume.
  const ranked = all.slice().sort((a, b) => b.vol - a.vol);
  const poc = ranked[0];
  let acc = poc.vol, loI = poc.i, hiI = poc.i;
  while (acc < total * 0.7 && (loI > 0 || hiI < nBuckets - 1)) {
    const dn = loI > 0 ? vol[loI - 1] : -1, up = hiI < nBuckets - 1 ? vol[hiI + 1] : -1;
    if (up >= dn) { hiI++; acc += up; } else { loI--; acc += dn; }
  }

  // Merge adjacent shelves so one thick band is not reported three times -- but
  // CAP the merge. The first version merged every adjacent top-N bucket and
  // produced "1267 - 1483, 30.8%" on ADMR: a 216-rupiah band, 16% wide, which is
  // true and useless. A 16%-wide "level" is not a level.
  //
  // So a merged zone stops at maxWidthPct, and each one also reports the single
  // densest bucket inside it. That keeps the honest answer -- this is a broad
  // range, not a line -- while still naming the price the volume actually
  // centres on.
  const picked = ranked.slice(0, topN * 2).sort((a, b) => a.i - b.i);
  const merged = [];
  for (const z of picked) {
    const prev = merged[merged.length - 1];
    const wouldSpan = prev ? (z.hi / prev.lo - 1) * 100 : 0;
    if (prev && z.i === prev.iEnd + 1 && wouldSpan <= maxWidthPct) {
      prev.iEnd = z.i; prev.hi = z.hi; prev.vol += z.vol; prev.volPct += z.volPct; prev.turns += z.turns;
      if (z.vol > prev.peakVol) { prev.peakVol = z.vol; prev.peak = { lo: z.lo, hi: z.hi }; }
    } else {
      merged.push({ iStart: z.i, iEnd: z.i, lo: z.lo, hi: z.hi, vol: z.vol, volPct: z.volPct,
        turns: z.turns, peakVol: z.vol, peak: { lo: z.lo, hi: z.hi } });
    }
  }
  for (const m of merged) {
    m.widthPct = round((m.hi / m.lo - 1) * 100, 1);
    m.broad = m.iEnd > m.iStart;
    delete m.peakVol;
  }
  return {
    zones: merged.sort((a, b) => b.vol - a.vol).slice(0, topN).sort((a, b) => b.lo - a.lo),
    poc: { lo: poc.lo, hi: poc.hi },
    valueArea: { lo: edge(loI), hi: edge(hiI + 1) },
    lo, hi, spacing: 'log',
  };
}

// ─── volume ─────────────────────────────────────────────────────────────────

/**
 * The volume state of the last completed bar.
 *
 * The example is right that volume is transaction data rather than a derived
 * indicator, and right that an unfinished candle must not be compared -- so this
 * reports on the last CLOSED session and says which one that is. Everything here
 * is a measurement; the reading of it is left to the CONVENTIONS block.
 */
function volumeState(bars) {
  const last = bars[bars.length - 1];
  const prior = bars.slice(-21, -1);
  const avg = mean(prior.map(b => b.v));
  const range = last.h - last.l;
  return {
    date: last.d,
    volume: last.v,
    vs20dAverage: avg ? round(last.v / avg, 2) : null,
    closePositionInRange: range > 0 ? round((last.c - last.l) / range, 2) : null,
    upperWickPct: range > 0 ? round((last.h - Math.max(last.o, last.c)) / range * 100, 1) : null,
    lowerWickPct: range > 0 ? round((Math.min(last.o, last.c) - last.l) / range * 100, 1) : null,
    direction: last.c > last.o ? 'up' : last.c < last.o ? 'down' : 'flat',
  };
}


/**
 * The 1H picture — the "cari setup" step of the worked example.
 *
 * Daily says where the important prices are; the hourly says whether buyers are
 * currently taking them. Yahoo serves 60m for roughly 730 days on `.JK` symbols,
 * which is enough for structure but is a DIFFERENT SOURCE from the daily table --
 * so it is reported as its own section and never silently blended with it.
 *
 * THE RUNNING BAR IS DROPPED. The example is emphatic about this and it is the
 * easiest way to be wrong here: "jika candle 1H terakhir masih berjalan,
 * volume-nya juga belum selesai." A partial bar has a partial volume and a close
 * that is really just the last print, so comparing it to finished bars makes
 * every session look weak at 09:30 and strong at 15:55. The last bar is dropped
 * unless it is old enough to have closed.
 */
async function intraday(ticker, interval = '60m', range = '730d') {
  let raw;
  try {
    const { fetchYahooIntraday } = require('./yahoo-candles');
    raw = await fetchYahooIntraday(ticker, interval, range);
  } catch (e) {
    return { unavailable: `Yahoo ${interval} fetch failed: ${String(e.message).slice(0, 80)}` };
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.candles) || [];
  const bars = list
    .filter(c => Number.isFinite(c.close) && c.close > 0 && Number.isFinite(c.high) && Number.isFinite(c.low))
    .map(c => ({ d: new Date(c.timestamp).toISOString().slice(0, 16).replace('T', ' '),
      ts: c.timestamp, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume || 0 }));

  if (bars.length < 60) return { unavailable: `only ${bars.length} usable ${interval} bars` };

  // A 60m bar that started less than an interval ago has not closed.
  const intervalMs = interval === '60m' || interval === '1h' ? 3600e3
    : interval === '30m' ? 1800e3 : interval === '15m' ? 900e3 : 300e3;
  const nowish = bars[bars.length - 1].ts;
  const droppedRunning = (Date.now() - nowish) < intervalMs;
  const closed = droppedRunning ? bars.slice(0, -1) : bars;

  return {
    interval,
    bars: closed.length,
    from: closed[0].d, to: closed[closed.length - 1].d,
    runningBarDropped: droppedRunning,
    lastClose: closed[closed.length - 1].c,
    structure: structure(closed.slice(-200), 3),
    // A tighter map than the daily one: the recent hourly range is what a setup
    // is read against, so only the last ~40 sessions of hourly are used.
    zones: zones(closed.slice(-280), 40, 6, 3),
  };
}

// ─── main ───────────────────────────────────────────────────────────────────

function weeklyFromDaily(bars) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const d = new Date(b.d + 'T00:00:00Z');
    // ISO week key, so a week is a week and not "every five rows".
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const key = t.getUTCFullYear() + '-W' + Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
    if (!cur || cur.key !== key) {
      cur = { key, d: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v;
    }
  }
  return out;
}

async function analyse(pool, ticker, opts = {}) {
  const [px] = await pool.query(
    `SELECT date, open_price o, high_price h, low_price l, close_price c, volume v
       FROM idx_stock_prices WHERE stock_code = ? AND close_price > 0 ORDER BY date ASC`, [ticker]);
  if (px.length < 60) return { ticker, error: `only ${px.length} sessions of price history` };

  const daily = px.map(r => ({ d: iso(r.date), o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.v }));
  const last = daily[daily.length - 1];
  const weekly = weeklyFromDaily(daily);

  // EMA/BB, with the seed check the regime engine now enforces everywhere.
  const closes = daily.map(b => b.c);
  const sma20 = mean(closes.slice(-20));
  const sd20 = Math.sqrt(mean(closes.slice(-20).map(c => (c - sma20) ** 2)));

  const zoneWindow = daily.slice(-500);

  const report = {
    ticker,
    asOf: last.d,
    lastClose: last.c,
    sessions: daily.length,
    coverage: { from: daily[0].d, to: last.d },

    measured: {
      weeklyStructure: structure(weekly.slice(-120), 2),
      dailyStructure: structure(daily.slice(-250), 3),
      zones: zones(zoneWindow),
      zoneWindow: { sessions: zoneWindow.length, from: zoneWindow[0].d, to: last.d },
      volume: volumeState(daily),
      trend: {
        ema8: round(ema(closes, 8)),
        ema21: round(ema(closes, 21)),
        ema50: closes.length >= 148 ? round(ema(closes, 50)) : null,
        ema200: emaSeedWeight(200, closes.length) <= 0.05 ? round(ema(closes, 200)) : null,
        ema200Note: emaSeedWeight(200, closes.length) > 0.05
          ? `withheld: ${closes.length} sessions leaves the EMA200 ${round(emaSeedWeight(200, closes.length) * 100, 1)}% seed`
          : null,
        bbUpper: round(sma20 + 2 * sd20), bbMiddle: round(sma20), bbLower: round(sma20 - 2 * sd20),
      },
    },
  };

  // ── the hourly picture, from a DIFFERENT source, kept separate ─────────────
  report.measured.intraday = opts.skipIntraday ? { skipped: true } : await intraday(ticker);

  // ── broker cost basis: the part no chart can show ──────────────────────────
  const since = opts.brokerSince || (() => {
    const d = new Date(last.d + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 3);
    return d.toISOString().slice(0, 10);
  })();
  const [bk] = await pool.query(
    `SELECT broker_code, SUM(net_val) net, SUM(buy_val) bv, SUM(buy_lot) bl, SUM(sell_val) sv, SUM(sell_lot) sl
       FROM idx_broker_summary WHERE stock_code = ? AND date >= ? GROUP BY broker_code`, [ticker, since]);

  if (bk.length) {
    // buy_lot is NAMED lot but holds SHARES: value/lot reproduces the feed's own
    // buy_avg to the rupiah. Dividing by a further 100 gave "bought at 16"
    // against a 1710 market -- wrong by exactly the factor that names the column.
    const rows = bk.map(r => ({ code: r.broker_code, net: +r.net, bv: +r.bv, bl: +r.bl, sv: +r.sv, sl: +r.sl }));
    const buyers = rows.filter(r => r.net > 0), sellers = rows.filter(r => r.net < 0);
    const vw = (arr, valKey, lotKey) => {
      const lots = arr.reduce((a, r) => a + r[lotKey], 0);
      return lots ? arr.reduce((a, r) => a + r[valKey], 0) / lots : null;
    };
    const buyAvg = vw(buyers, 'bv', 'bl'), sellAvg = vw(sellers, 'sv', 'sl');

    // A broker CODE is not information. `XL` and `AK` sit next to a number and
    // tell the reader nothing about whether that is foreign money, a retail app,
    // or a domestic house -- which is the first thing anyone wants to know.
    const reg = await loadRegistry(pool);
    const tag = code => describe(reg, code);
    report.measured.brokerCostBasis = {
      since,
      netBuyers: buyers.length, netSellers: sellers.length,
      buyersPaidAvg: round(buyAvg), sellersGotAvg: round(sellAvg),
      lastCloseVsBuyers: buyAvg ? round((last.c / buyAvg - 1) * 100) : null,
      topBuyers: buyers.sort((a, b) => b.net - a.net).slice(0, 5)
        .map(r => ({ broker: r.code, ...tag(r.code), netB: round(r.net / 1e9, 1), avgBuy: r.bl ? Math.round(r.bv / r.bl) : null })),
      topSellers: sellers.sort((a, b) => a.net - b.net).slice(0, 5)
        .map(r => ({ broker: r.code, ...tag(r.code), netB: round(r.net / 1e9, 1), avgSell: r.sl ? Math.round(r.sv / r.sl) : null })),
      // Split by the MEASURED axis, not the stored label: ownership is not
      // client base, and "is this foreign money" is a question about flow.
      foreignBuyingB: round(buyers.filter(r => (tag(r.code).foreignPct ?? 0) >= 50)
        .reduce((a, r) => a + r.net, 0) / 1e9, 1),
      foreignSellingB: round(sellers.filter(r => (tag(r.code).foreignPct ?? 0) >= 50)
        .reduce((a, r) => a + r.net, 0) / 1e9, 1),
      retailBuyingB: round(buyers.filter(r => tag(r.code).clientBase === 'RETAIL_PLATFORM')
        .reduce((a, r) => a + r.net, 0) / 1e9, 1),
      retailSellingB: round(sellers.filter(r => tag(r.code).clientBase === 'RETAIL_PLATFORM')
        .reduce((a, r) => a + r.net, 0) / 1e9, 1),
    };
  } else {
    report.measured.brokerCostBasis = { since, unavailable: 'no broker rows in the window' };
  }

  // ── what is NOT measured, kept separate on purpose ─────────────────────────
  report.conventions = [
    'High volume with price continuing = demand absorbed the supply.',
    'High volume with price stalling = supply absorbed the demand.',
    'High volume with a long upper wick = rejection at that level.',
    'A retest on low volume is read as a healthy pullback.',
    'Price above a rising EMA8, with EMA8 above the BB middle, is read as momentum.',
  ];
  report.conventionsCaveat =
    'These are conventional readings, NOT results measured on IDX. This project has ' +
    'twice found the obvious reading to be wrong: EXP-016 showed persistent top-3-broker ' +
    'buying predicts UNDERperformance, and the scanner score turned out to describe the ' +
    'same day rather than forecast the next. Treat every line above as a hypothesis ' +
    'awaiting a registered test, not as a finding.';

  report.notMeasured = [
    'The hourly section comes from Yahoo, not from idx_stock_prices. The two are not ' +
    'reconciled, so a small disagreement between the daily close here and the last hourly ' +
    'close is expected and is not evidence of a data fault.',
    'How far a zone is expected to be respected. EXP-036 measured that pivots land in ' +
    'these zones more than in arbitrary bands, but most of that advantage was simply ' +
    'being NEAR the current price: with proximity held constant only +1.4 percentage ' +
    'points survive (60 of 100 tickers). Which zone will hold, and whether acting on ' +
    'one pays, are both untested.',
  ];

  return report;
}

function render(r) {
  if (r.error) { console.log(`${r.ticker}: ${r.error}`); return; }
  const L = [];
  const pct = v => (v === null ? '   n/a' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%');
  L.push('='.repeat(78));
  L.push(`  ${r.ticker} — deep analysis as of ${r.asOf}   last close ${r.lastClose}`);
  L.push(`  ${r.sessions} sessions, ${r.coverage.from} .. ${r.coverage.to}`);
  L.push('='.repeat(78));

  for (const [name, s] of [['WEEKLY', r.measured.weeklyStructure], ['DAILY', r.measured.dailyStructure]]) {
    L.push('');
    L.push(`${name} STRUCTURE`);
    L.push(`  ${s.state}`);
    if (s.lastSwingHigh) {
      L.push(`  last swing high : ${s.lastSwingHigh.price}  (${s.lastSwingHigh.date}, ${s.lastSwingHigh.barsAgo} bars ago)`);
      L.push(`  last swing low  : ${s.lastSwingLow.price}  (${s.lastSwingLow.date})`);
      if (s.toConfirmUp.status) {
        L.push(`  break status    : price is ${pct(s.toConfirmUp.abovePct)} ABOVE the last confirmed swing high (${s.toConfirmUp.lastConfirmedHigh})`);
        L.push(`                    ${s.toConfirmUp.then}`);
      } else {
        L.push(`  to confirm up   : close above ${s.toConfirmUp.needsCloseAbove}  (${pct(s.toConfirmUp.distancePct)} away), then a higher low, then a higher high`);
      }
      L.push(`  invalidation    : below ${s.invalidation.below}  (${pct(s.invalidation.distancePct)} away) — ${s.invalidation.meaning}`);
    } else {
      L.push(`  ${s.reason}`);
    }
  }

  const z = r.measured.zones;
  L.push('');
  L.push(`ZONES — where the shares actually changed hands (${r.measured.zoneWindow.sessions} sessions from ${r.measured.zoneWindow.from})`);
  // Tested, so it says what the test found rather than implying more. EXP-036:
  // +5.7pp against arbitrary bands, but only +1.4pp once proximity to the
  // current price is held constant.
  L.push('  TESTED (EXP-036): future pivots land here +1.4pp more often than in bands');
  L.push('  matched for width and distance from price. Real, modest, and not a trading rule.');
  L.push('  range              width   vol%   turns   position');
  for (const zz of z.zones) {
    const where = r.lastClose > zz.hi ? 'below price' : r.lastClose < zz.lo ? 'above price' : '** PRICE IS HERE **';
    L.push(`  ${String(Math.round(zz.lo)).padStart(6)} – ${String(Math.round(zz.hi)).padEnd(7)} ${(zz.widthPct + '%').padStart(6)}  ${zz.volPct.toFixed(1).padStart(4)}%  ${String(zz.turns).padStart(5)}   ${where}` +
      (zz.turns === 0 ? '   <- volume but no turns: passed THROUGH' : ''));
    if (zz.broad) L.push(`         densest at ${Math.round(zz.peak.lo)} – ${Math.round(zz.peak.hi)}`);
  }
  L.push(`  point of control : ${Math.round(z.poc.lo)} – ${Math.round(z.poc.hi)}`);
  L.push(`  value area (70%) : ${Math.round(z.valueArea.lo)} – ${Math.round(z.valueArea.hi)}`);

  const h = r.measured.intraday;
  if (h && !h.skipped) {
    L.push('');
    L.push('HOURLY (60m, Yahoo — a different source from the daily table above)');
    if (h.unavailable) L.push(`  unavailable: ${h.unavailable}`);
    else {
      L.push(`  ${h.bars} closed bars, ${h.from} .. ${h.to}` + (h.runningBarDropped ? '   (the running bar was dropped)' : ''));
      L.push(`  ${h.structure.state}`);
      if (h.structure.lastSwingHigh) {
        if (h.structure.toConfirmUp.status) {
          L.push(`  price is ${(h.structure.toConfirmUp.abovePct >= 0 ? '+' : '') + h.structure.toConfirmUp.abovePct}% above the last confirmed hourly swing high (${round(h.structure.toConfirmUp.lastConfirmedHigh)})`);
        } else {
          L.push(`  needs an hourly close above ${round(h.structure.toConfirmUp.needsCloseAbove)}`);
        }
        L.push(`  hourly invalidation: below ${round(h.structure.invalidation.below)}`);
      }
      L.push('  hourly zones:');
      for (const zz of h.zones.zones.slice(0, 6)) {
        const where = r.lastClose > zz.hi ? 'below' : r.lastClose < zz.lo ? 'above' : '** HERE **';
        L.push(`    ${String(Math.round(zz.lo)).padStart(6)} – ${String(Math.round(zz.hi)).padEnd(7)} ${zz.volPct.toFixed(1).padStart(4)}%  ${String(zz.turns).padStart(3)} turns   ${where}`);
      }
    }
  }

  const t = r.measured.trend;
  L.push('');
  L.push('TREND / VOLATILITY');
  L.push(`  EMA8 ${t.ema8}   EMA21 ${t.ema21}   EMA50 ${t.ema50 ?? 'n/a'}   EMA200 ${t.ema200 ?? 'withheld'}`);
  if (t.ema200Note) L.push(`  ${t.ema200Note}`);
  L.push(`  BB20  upper ${t.bbUpper}   middle ${t.bbMiddle}   lower ${t.bbLower}`);

  const v = r.measured.volume;
  L.push('');
  L.push(`VOLUME — last CLOSED session ${v.date}`);
  L.push(`  volume ${v.volume.toLocaleString('en-US')}  =  ${v.vs20dAverage}x its 20-session average`);
  L.push(`  close sat ${(v.closePositionInRange * 100).toFixed(0)}% up the bar's range;  upper wick ${v.upperWickPct}%  lower wick ${v.lowerWickPct}%`);

  const b = r.measured.brokerCostBasis;
  L.push('');
  L.push(`BROKER COST BASIS since ${b.since} — not visible on any chart`);
  if (b.unavailable) L.push(`  ${b.unavailable}`);
  else {
    L.push(`  ${b.netBuyers} net buyers paid an average of ${b.buyersPaidAvg}   (last close is ${pct(b.lastCloseVsBuyers)} vs that)`);
    L.push(`  ${b.netSellers} net sellers received an average of ${b.sellersGotAvg}`);
    const who = x => (x.name ? x.name.replace(/ Sekuritas.*| Indonesia$/,'').slice(0, 18) : '?').padEnd(19) +
      (x.foreignPct === null || x.foreignPct === undefined ? '   ?  fgn' : String(x.foreignPct).padStart(5) + '% fgn') +
      (x.clientBase === 'RETAIL_PLATFORM' ? '  retail app' : x.ownership === 'FOREIGN_OWNED' ? '  fgn-owned' : '');
    b.topBuyers.forEach(x => L.push(`    + ${x.broker.padEnd(4)} ${String(x.netB).padStart(6)} B  at ${String(x.avgBuy).padEnd(6)} ${who(x)}`));
    b.topSellers.forEach(x => L.push(`    - ${x.broker.padEnd(4)} ${String(x.netB).padStart(6)} B  at ${String(x.avgSell).padEnd(6)} ${who(x)}`));
    L.push('');
    L.push(`  by MEASURED flow origin (>=50% foreign), not by the stored label:`);
    const signed = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' B';
    L.push(`    foreign-flow brokers  net ${signed(b.foreignBuyingB + b.foreignSellingB)}   (bought ${signed(b.foreignBuyingB)}, sold ${signed(b.foreignSellingB)})`);
    L.push(`    retail platforms      net ${signed(b.retailBuyingB + b.retailSellingB)}   (bought ${signed(b.retailBuyingB)}, sold ${signed(b.retailSellingB)})`);
  }

  L.push('');
  L.push('-'.repeat(78));
  L.push('CONVENTIONAL READINGS — not measured, not evidence');
  r.conventions.forEach(c => L.push(`  · ${c}`));
  L.push('');
  L.push('  ' + r.conventionsCaveat.replace(/(.{74} )/g, '$1\n  '));
  L.push('');
  L.push('NOT COVERED');
  r.notMeasured.forEach(c => L.push('  · ' + c.replace(/(.{74} )/g, '$1\n    ')));
  console.log(L.join('\n'));
}

if (require.main === module) {
  const ticker = (process.argv[2] || '').toUpperCase();
  if (!ticker) { console.error('usage: node deep_analysis.js <TICKER> [--json]'); process.exit(1); }
  (async () => {
    const pool = createPool();
    const r = await analyse(pool, ticker);
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else render(r);
    await pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { analyse, pivots, structure, zones, volumeState, weeklyFromDaily, intraday };
