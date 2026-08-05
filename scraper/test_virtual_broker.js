/**
 * The mandatory tests for the virtual broker, from the 2026-08-04 22:22 design.
 *
 * All fifteen are here, plus the ones writing them turned up. The pure half runs
 * with no database; the ledger half (cash conservation across a round trip,
 * restart safety, hash isolation) lives in test_virtual_portfolio.js because it
 * needs real tables.
 */
'use strict';

const assert = require('assert');
const vb = require('./modules/virtual_broker');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  PASS  ${name}`); }
  catch (e) { fail++; console.log(`  FAIL  ${name}\n          ${e.message}`); }
}

const C = vb.DEFAULT_CONFIG;
const NAV = 100_000_000;

console.log('\nvirtual broker — the account starts where it says it does');

t('starting capital is exactly Rp100,000,000', () => {
  assert.strictEqual(C.startingCash, 100_000_000);
});

t('margin and shorting are not configurable away by accident', () => {
  // Sizing can never return a negative quantity, so a short is unreachable.
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 1200 });
  assert.strictEqual(r.quantity, 0);
  assert.strictEqual(r.rejectReason, 'INVALID_STOP', 'a stop above entry is not a short, it is a mistake');
});

console.log('\nvirtual broker — position sizing');

t('risk-based quantity spends the risk budget, not the account', () => {
  // 0.50% of 100jt = Rp500,000 at risk. Entry 1000, stop 950 -> Rp50 per share
  // -> 10,000 shares -> 100 lots.
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 950 });
  assert.strictEqual(r.riskBudget, 500_000);
  assert.strictEqual(r.quantity, 10_000);
  assert.strictEqual(r.cappedBy, 'RISK');
});

t('a tight stop is capped by the position limit, not allowed to dominate the book', () => {
  // Entry 1000, stop 999 -> Rp1 of risk -> 500,000 shares on risk alone, which
  // is Rp500m of a Rp100m account. The 12.5% cap has to bind.
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 999 });
  assert.strictEqual(r.cappedBy, 'POSITION_NOTIONAL');
  assert.ok(r.notional <= NAV * C.maxPositionNotional + 1, `notional ${r.notional}`);
});

t('quantity is always a whole board lot', () => {
  for (const entry of [1000, 1225, 3060, 6500, 9475]) {
    const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: entry, stopPrice: entry * 0.95 });
    assert.strictEqual(r.quantity % vb.LOT, 0, `${entry} -> ${r.quantity}`);
  }
});

t('the account cannot spend more cash than it has', () => {
  const cash = 3_000_000;
  const r = vb.sizeOrder({ nav: NAV, cash, entryPrice: 1000, stopPrice: 950 });
  assert.ok(r.notional <= cash, `notional ${r.notional} exceeds cash ${cash}`);
  assert.strictEqual(r.cappedBy, 'CASH');
});

t('gross exposure cannot pass its ceiling', () => {
  const r = vb.sizeOrder({
    nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 950,
    grossExposure: NAV * C.maxGrossExposure,      // already fully deployed
  });
  assert.strictEqual(r.quantity, 0);
  assert.ok(/GROSS_EXPOSURE/.test(r.rejectReason), r.rejectReason);
});

t('a full book takes no more names', () => {
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 950, openPositions: C.maxPositions });
  assert.strictEqual(r.rejectReason, 'MAX_POSITIONS');
});

t('a rejection names the binding constraint, not just "no"', () => {
  const r = vb.sizeOrder({ nav: NAV, cash: 50_000, entryPrice: 9_000_000, stopPrice: 8_000_000 });
  assert.strictEqual(r.quantity, 0);
  assert.ok(/^BELOW_ONE_LOT_/.test(r.rejectReason), r.rejectReason);
});

t('no entry price is a NO_ENTRY_PRICE, never a zero-cost fill', () => {
  assert.strictEqual(vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 0, stopPrice: 950 }).rejectReason, 'NO_ENTRY_PRICE');
});

console.log('\nvirtual broker — the risk layer, which every position size rests on');

t('the stop is 2.5 ATR below entry and the target is 2R above it', () => {
  const lv = vb.tradeLevels(1000, 20);
  assert.strictEqual(lv.riskPerShare, 50);
  assert.strictEqual(lv.stopPrice, 950);
  assert.strictEqual(lv.targetPrice, 1100);
  assert.strictEqual(lv.usedFallback, false);
});

t('no computable ATR falls back to a percentage and SAYS SO', () => {
  const lv = vb.tradeLevels(1000, null);
  assert.strictEqual(lv.stopPrice, 950, '5% fallback');
  assert.strictEqual(lv.usedFallback, true, 'a fallback stop must be visible in the record, not silently identical to a real one');
});

t('the stop is never at or above entry, whatever the ATR', () => {
  for (const atr of [0, -5, null, NaN]) {
    const lv = vb.tradeLevels(1000, atr);
    assert.ok(lv.stopPrice < 1000 && lv.stopPrice > 0, `atr ${atr} -> stop ${lv.stopPrice}`);
  }
});

t('ATR is true range, so a gap counts — not just high minus low', () => {
  // Yesterday closed at 100, today trades 80-85. The true range is 20, the
  // distance from that close to today's low, not the 5 the bar shows by itself.
  const flat = Array.from({ length: 15 }, () => ({ high: 100, low: 100, close: 100 }));
  const atr = vb.atrFrom(flat.concat([{ high: 85, low: 80, close: 82 }]), 14);
  assert.ok(atr > 1, `a gap must register: got ${atr}`);
});

t('too few bars returns null rather than a confidently wrong number', () => {
  assert.strictEqual(vb.atrFrom(Array.from({ length: 10 }, () => ({ high: 10, low: 9, close: 9.5 }))), null);
  assert.strictEqual(vb.atrFrom([]), null);
  assert.strictEqual(vb.atrFrom(null), null);
});

t('an ATR ending at the signal bar cannot see the entry bar', () => {
  // The look-ahead that would actually matter: the entry day is a huge range.
  // If it leaked in, the stop would be far wider and the size far smaller —
  // sized with tomorrow's information.
  const calm = Array.from({ length: 20 }, () => ({ high: 101, low: 99, close: 100 }));
  const asOfSignal = vb.atrFrom(calm);
  const peeking = vb.atrFrom(calm.concat([{ high: 200, low: 50, close: 120 }]));
  assert.ok(Math.abs(asOfSignal - 2) < 0.01, `as-of ATR should be the calm 2.0, got ${asOfSignal}`);
  assert.ok(peeking > asOfSignal * 2, 'sanity: the entry bar really would have changed the answer');
});

t('a wider stop buys fewer shares — the risk budget is what is held fixed', () => {
  const tight = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: vb.tradeLevels(1000, 10).stopPrice });
  const wide = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: vb.tradeLevels(1000, 40).stopPrice });
  assert.ok(wide.quantity < tight.quantity, `${wide.quantity} should be under ${tight.quantity}`);
});

t('sizing on the fill price reconciles with the stop distance the ledger records', () => {
  // What the orchestrator does: levels off the price actually paid, so that
  // entry_price - stop_price in virtual_positions IS the policy's 2.5 x ATR.
  const quoted = 1000, fillPrice = quoted * (1 + C.slippage);
  const lv = vb.tradeLevels(fillPrice, 20);
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: quoted, fillPrice, stopPrice: lv.stopPrice });
  const dist = fillPrice - lv.stopPrice;
  assert.ok(Math.abs(dist - 50) < 1e-9, 'the recorded stop distance is the policy distance');
  assert.ok(Math.abs(r.quantity * dist - r.riskBudget) < dist * vb.LOT, 'shares times stop distance is the risk budget');
  assert.ok(Math.abs(r.notional - r.quantity * fillPrice * (1 + C.feeBuy)) < 1e-6, 'slippage must not be charged twice');
});

console.log('\nvirtual broker — bar resolution, and the order of the rules');

const bar = (high, low, close) => ({ high, low, close });

t('stop AND target on one candle resolves to STOP', () => {
  // The whole reason this rule exists: daily OHLC cannot say which came first.
  const r = vb.resolveBar({ bar: bar(1200, 900, 1100), stopPrice: 950, targetPrice: 1150, exitPolicy: 'INTRADAY_EOD' });
  assert.strictEqual(r.exitReason, 'STOP');
  assert.strictEqual(r.exitPrice, 950);
  assert.strictEqual(r.ambiguous, true, 'the ambiguity must be recorded, not hidden');
});

t('stop alone resolves to STOP', () => {
  const r = vb.resolveBar({ bar: bar(1050, 900, 1000), stopPrice: 950, targetPrice: 1150, exitPolicy: 'INTRADAY_EOD' });
  assert.strictEqual(r.exitReason, 'STOP');
  assert.strictEqual(r.ambiguous, false);
});

t('target alone resolves to TARGET', () => {
  const r = vb.resolveBar({ bar: bar(1200, 990, 1180), stopPrice: 950, targetPrice: 1150, exitPolicy: 'INTRADAY_EOD' });
  assert.strictEqual(r.exitReason, 'TARGET');
  assert.strictEqual(r.exitPrice, 1150);
});

t('neither, on the intraday account, closes at that day\'s close', () => {
  const r = vb.resolveBar({ bar: bar(1100, 1000, 1040), stopPrice: 950, targetPrice: 1150, exitPolicy: 'INTRADAY_EOD' });
  assert.strictEqual(r.exitReason, 'EOD_CLOSE');
  assert.strictEqual(r.exitPrice, 1040);
});

t('neither, on the position account, stays open', () => {
  const r = vb.resolveBar({ bar: bar(1100, 1000, 1040), stopPrice: 950, targetPrice: 1150, exitPolicy: 'POSITION', barsHeld: 3 });
  assert.strictEqual(r.exitReason, null);
  assert.strictEqual(r.open, true);
});

t('the position account times out at its holding limit', () => {
  const r = vb.resolveBar({ bar: bar(1100, 1000, 1040), stopPrice: 950, targetPrice: 1150, exitPolicy: 'POSITION', barsHeld: C.maxHoldBars });
  assert.strictEqual(r.exitReason, 'TIME_EXIT');
});

t('a bar with no price leaves the position open and says it could not be priced', () => {
  const r = vb.resolveBar({ bar: bar(0, 0, 0), stopPrice: 950, targetPrice: 1150, exitPolicy: 'INTRADAY_EOD' });
  assert.strictEqual(r.open, true);
  assert.strictEqual(r.unpriced, true, 'a suspension must not be read as an exit at zero');
});

console.log('\nvirtual broker — the 2026-08-05 review');

t('the risk layer comes FROM trade_policy, not from literals that happen to match', () => {
  // The old config re-declared 40 / 2.5 / 5 / 2. They matched the POSITION
  // profile by coincidence, so changing the profile would have moved the
  // trade-plan engine and left the portfolio sizing against the old one.
  const policy = require('./modules/trade_policy');
  const p = policy.active();
  assert.strictEqual(C.maxHoldBars, p.maxHoldBars);
  assert.strictEqual(C.riskAtrMult, p.riskAtrMult);
  assert.strictEqual(C.fallbackRiskPct, p.fallbackRiskPct);
  assert.strictEqual(C.targetR, p.target1R);
  assert.strictEqual(C.profile, p.name, 'the profile name must be IN the config, so the hash moves with it');
});

t('a different horizon profile is a different execution contract', () => {
  const before = process.env.AWO_HORIZON;
  try {
    process.env.AWO_HORIZON = 'SWING';
    const swing = vb.riskLayer();
    assert.notStrictEqual(swing.maxHoldBars, C.maxHoldBars, 'sanity: SWING really differs');
    assert.notStrictEqual(
      vb.executionPolicyHash(swing, 'POSITION'),
      vb.executionPolicyHash({}, 'POSITION'),
      'two horizons must never share a track record');
  } finally {
    if (before === undefined) delete process.env.AWO_HORIZON; else process.env.AWO_HORIZON = before;
  }
});

t('ATR is the SAME function the rest of the system uses', () => {
  // It was labelled "Wilder ATR" and computed a plain mean of 14 true ranges.
  // Wilder smoothing is recursive; the label was simply false.
  const { calcATR } = require('./awo_technical');
  const bars = Array.from({ length: 40 }, (_, i) => ({
    high: 100 + (i % 7) * 3, low: 95 + (i % 5), close: 97 + (i % 6) * 2,
  }));
  const mine = vb.atrFrom(bars);
  const theirs = calcATR(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), 14);
  assert.strictEqual(mine, theirs);

  // And it is NOT the plain mean the old code returned, on data with any trend.
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  const plainMean = tr.slice(-14).reduce((a, b) => a + b, 0) / 14;
  assert.notStrictEqual(Math.round(mine * 1e6), Math.round(plainMean * 1e6),
    'if these are equal the delegation silently reverted to a simple average');
});

t('GAP THROUGH THE STOP exits at the OPEN, not at the stop', () => {
  // Closed 1000, opens 800, stop at 950. Nobody could have sold at 950.
  const r = vb.resolveBar({
    bar: { open: 800, high: 830, low: 780, close: 810 },
    stopPrice: 950, targetPrice: 1100, exitPolicy: 'POSITION',
  });
  assert.strictEqual(r.exitReason, 'STOP');
  assert.strictEqual(r.exitPrice, 800, 'the first available price is the open');
  assert.strictEqual(r.gapped, true);
});

t('gapping UP through the target fills at the open, which is better than the target', () => {
  const r = vb.resolveBar({
    bar: { open: 1200, high: 1250, low: 1190, close: 1230 },
    stopPrice: 950, targetPrice: 1100, exitPolicy: 'POSITION',
  });
  assert.strictEqual(r.exitReason, 'TARGET');
  assert.strictEqual(r.exitPrice, 1200);
  assert.strictEqual(r.gapped, true);
});

t('an ordinary touch still fills AT the level, not at the open', () => {
  const r = vb.resolveBar({
    bar: { open: 1010, high: 1020, low: 940, close: 990 },
    stopPrice: 950, targetPrice: 1100, exitPolicy: 'POSITION',
  });
  assert.strictEqual(r.exitPrice, 950);
  assert.strictEqual(r.gapped, false);
});

t('MISSING HIGH OR LOW CANNOT BECOME AN EOD_CLOSE', () => {
  // Absence of an observation is not an observation of absence. This used to
  // fall through every touch test and close the trade as if the day had been
  // quiet.
  for (const bar of [{ open: 1000, high: 0, low: 990, close: 1000 },
                     { open: 1000, high: 1010, low: 0, close: 1000 }]) {
    const r = vb.resolveBar({ bar, stopPrice: 950, targetPrice: 1100, exitPolicy: 'INTRADAY_EOD' });
    assert.strictEqual(r.exitReason, null, JSON.stringify(bar));
    assert.strictEqual(r.open, true);
    assert.strictEqual(r.dataIncomplete, true);
  }
});

t('a name already held is NOT bought again', () => {
  // The target book legitimately retains a holding across rebalances, so
  // without this the same ticker was re-ordered every plan.
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 950, tickerExposure: 8_000_000 });
  assert.strictEqual(r.quantity, 0);
  assert.strictEqual(r.rejectReason, 'ALREADY_HELD');
});

t('THE PER-NAME CAP IS AGGREGATE, counting what is already held', () => {
  // With pyramiding switched on, a name holding 10% of a 12.5% cap may only
  // add the remaining 2.5% — not another full 12.5%.
  const cfg = { ...C, allowPyramiding: true };
  const held = NAV * 0.10;
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 999, tickerExposure: held, config: cfg });
  assert.strictEqual(r.cappedBy, 'POSITION_NOTIONAL');
  assert.ok(held + r.notional <= NAV * C.maxPositionNotional + 1,
    `${held} + ${r.notional} exceeds the aggregate cap`);
});

t('a name at its cap cannot add even one lot', () => {
  const cfg = { ...C, allowPyramiding: true };
  const r = vb.sizeOrder({ nav: NAV, cash: NAV, entryPrice: 1000, stopPrice: 950,
                           tickerExposure: NAV * C.maxPositionNotional, config: cfg });
  assert.strictEqual(r.quantity, 0);
  assert.ok(/POSITION_NOTIONAL/.test(r.rejectReason), r.rejectReason);
});

t('an unpriced holding falls back to its LAST CLOSE before falling back to cost', () => {
  // Carrying at cost snaps a doubled position back to its entry value, so one
  // missing print erases months of P&L from the NAV.
  const m = vb.markToMarket({
    cash: 10_000_000,
    positions: [{ ticker: 'AAA', quantity: 10_000, cost_basis: 20_000_000 }],
    priceOf: () => 0,
    lastCloseOf: () => 4000,
  });
  assert.strictEqual(m.marketValue, 40_000_000, 'the last known close, not the 20jt cost');
  assert.deepStrictEqual(m.stale, ['AAA']);
  assert.strictEqual(m.degraded, false, 'a stale mark is not a degraded one');
});

t('with no last close either, it falls back to cost and the NAV is DEGRADED', () => {
  const m = vb.markToMarket({
    cash: 10_000_000,
    positions: [{ ticker: 'GHOST', quantity: 1_000, cost_basis: 20_000_000 }],
    priceOf: () => 0,
    lastCloseOf: () => null,
  });
  assert.strictEqual(m.marketValue, 20_000_000);
  assert.deepStrictEqual(m.unmarkable, ['GHOST']);
  assert.strictEqual(m.degraded, true, 'a NAV built on cost must announce itself as an estimate');
});

console.log('\nvirtual broker — fees and slippage are real money');

t('a buy costs more than the quoted price', () => {
  const b = vb.buyCost(1000, 5000);
  assert.ok(b.fillPrice > 5000, 'slippage moves the fill against you');
  assert.ok(b.total > b.gross, 'the fee is on top');
  assert.ok(Math.abs(b.total - 1000 * 5000 * (1 + C.slippage) * (1 + C.feeBuy)) < 1e-6);
});

t('a sale returns less than the quoted price', () => {
  const s = vb.sellProceeds(1000, 5000);
  assert.ok(s.fillPrice < 5000);
  assert.ok(s.net < s.gross);
});

t('a round trip at an unchanged price LOSES money', () => {
  // The single most important property. If this ever passes at break-even, the
  // cost model has been switched off.
  const b = vb.buyCost(1000, 5000);
  const s = vb.sellProceeds(1000, 5000);
  assert.ok(s.net < b.total, `bought for ${b.total}, sold for ${s.net}`);
  const drag = (b.total - s.net) / b.total;
  assert.ok(drag > 0.004 && drag < 0.007, `round-trip drag ${(drag * 100).toFixed(3)}% is outside the documented cost model`);
});

t('an EOD close is not a frictionless fill at the printed close', () => {
  const s = vb.sellProceeds(100, 1040);
  assert.ok(s.fillPrice < 1040, 'selling into the close still pays slippage');
});

console.log('\nvirtual broker — NAV identity');

t('NAV is exactly cash plus market value', () => {
  const m = vb.markToMarket({
    cash: 40_000_000,
    positions: [{ ticker: 'AAA', quantity: 10_000, cost_basis: 30_000_000 },
                { ticker: 'BBB', quantity: 5_000, cost_basis: 25_000_000 }],
    priceOf: tk => ({ AAA: 3500, BBB: 6000 })[tk],
  });
  assert.strictEqual(m.marketValue, 10_000 * 3500 + 5_000 * 6000);
  assert.strictEqual(m.totalNav, m.cash + m.marketValue);
});

t('an unpriceable holding is carried at cost and NAMED, not valued at zero', () => {
  const m = vb.markToMarket({
    cash: 50_000_000,
    positions: [{ ticker: 'HALT', quantity: 1_000, cost_basis: 20_000_000 }],
    priceOf: () => 0,
  });
  assert.deepStrictEqual(m.unmarkable, ['HALT']);
  assert.strictEqual(m.marketValue, 20_000_000);
});

console.log('\nvirtual broker — the two accounts are different experiments');

t('the same config under different exit policies hashes differently', () => {
  const a = vb.executionPolicyHash({}, 'POSITION');
  const b = vb.executionPolicyHash({}, 'INTRADAY_EOD');
  assert.notStrictEqual(a, b, 'two exit rules must never share a track record');
});

t('changing a fee changes the hash', () => {
  assert.notStrictEqual(
    vb.executionPolicyHash({}, 'POSITION'),
    vb.executionPolicyHash({ feeBuy: 0.002 }, 'POSITION'));
});

t('changing the slippage or the holding limit changes the hash', () => {
  assert.notStrictEqual(vb.executionPolicyHash({}, 'POSITION'), vb.executionPolicyHash({ slippage: 0.002 }, 'POSITION'));
  assert.notStrictEqual(vb.executionPolicyHash({}, 'POSITION'), vb.executionPolicyHash({ maxHoldBars: 20 }, 'POSITION'));
});

t('an identical config hashes identically, so a restart does not fork the record', () => {
  assert.strictEqual(vb.executionPolicyHash({}, 'POSITION'), vb.executionPolicyHash({}, 'POSITION'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
