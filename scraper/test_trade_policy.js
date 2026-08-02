/**
 * Verifies modules/trade_policy.js and its wiring into computeTradePlan.
 * Pure-function only â€” no DB, runs anywhere.
 */
'use strict';
const path = require('path');
const ROOT = __dirname;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ' â€” ' + detail : ''}`); }
}

// â”€â”€ trade_policy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n[trade_policy]');
delete process.env.AWO_HORIZON;
const policy = require(path.join(ROOT, 'modules/trade_policy'));

const def = policy.active();
check('defaults to POSITION', def.name === 'POSITION', def.name);
check('POSITION maxHoldBars = 40', def.maxHoldBars === 40, String(def.maxHoldBars));
check('POSITION riskAtrMult = 2.5', def.riskAtrMult === 2.5, String(def.riskAtrMult));
check('POSITION targets 2R/4R', def.target1R === 2 && def.target2R === 4);
check('POSITION expiry outlasts 40 bars (~56d)', def.journalExpiryDays > 56, String(def.journalExpiryDays));

process.env.AWO_HORIZON = 'SWING';
const sw = policy.active();
check('env switches to SWING', sw.name === 'SWING' && sw.maxHoldBars === 15);
check('SWING preserves historical geometry', sw.riskAtrMult === 1.5 && sw.target1R === 1.5 && sw.target2R === 2.5);
check('SWING snap ceiling preserved at 4R', sw.targetSnapCeilingR === 4);

process.env.AWO_HORIZON = 'NONSENSE';
check('unknown profile falls back to POSITION', policy.active().name === 'POSITION');
delete process.env.AWO_HORIZON;

check('resolve() applies overrides', policy.resolve({ maxHoldBars: 60 }).maxHoldBars === 60);
check('resolve() leaves other fields intact', policy.resolve({ maxHoldBars: 60 }).riskAtrMult === 2.5);
check('resolve() does not mutate active()', policy.active().maxHoldBars === 40);

// â”€â”€ computeTradePlan geometry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n[computeTradePlan]');
const { computeTradePlan } = require(path.join(ROOT, 'awo_technical'));

// No S/R levels -> pure ATR geometry, easy to verify by hand.
const price = 1000, atr = 20; // 2% ATR, typical IDX big cap
const noSR = { support: [], resistance: [] };

const p = computeTradePlan(price, 'BUY', atr, noSR);
// POSITION: risk = 2.5 * 20 = 50 -> stop 950, t1 = +2R = 1100, t2 = +4R = 1200
check('POSITION stop = 2.5x ATR below entry', p.stopLoss === 950, String(p.stopLoss));
check('POSITION target1 = 2R', p.target1 === 1100, String(p.target1));
check('POSITION target2 = 4R', p.target2 === 1200, String(p.target2));
check('POSITION riskReward = 4', p.riskReward === 4, String(p.riskReward));

const s = computeTradePlan(price, 'BUY', atr, noSR, policy.PROFILES.SWING);
// SWING: risk = 1.5 * 20 = 30 -> stop 970, t1 = 1045, t2 = 1075
check('SWING override reproduces old geometry', s.stopLoss === 970 && s.target1 === 1045 && s.target2 === 1075,
  `${s.stopLoss}/${s.target1}/${s.target2}`);

// Cost-in-R arithmetic: the reason the risk unit was widened.
const costR = pct => 0.50 / (pct);
check('POSITION cost < 0.11R at 2% ATR', costR(2.5 * 2) < 0.11, costR(2.5 * 2).toFixed(3) + 'R');
check('SWING cost > 0.16R at 2% ATR', costR(1.5 * 2) > 0.16, costR(1.5 * 2).toFixed(3) + 'R');

// Bearish direction mirrors correctly.
const b = computeTradePlan(price, 'SELL', atr, noSR);
check('SELL stop above entry by 2.5x ATR', b.stopLoss === 1050, String(b.stopLoss));
check('SELL target2 = 4R below entry', b.target2 === 800, String(b.target2));

// ATR unavailable -> fallback % risk unit, profile-driven.
const f = computeTradePlan(price, 'BUY', null, noSR);
check('fallback risk unit = 5% under POSITION', f.stopLoss === 950, String(f.stopLoss));

// Support snap still works and is measured against the NEW risk unit.
// risk=50, band [25,150] below price -> 960 qualifies, stop = 960 - 10 = 950
const snapped = computeTradePlan(price, 'BUY', atr, { support: [960], resistance: [] });
check('stop snaps to support inside 0.5-3x band', snapped.stopLoss === 950, String(snapped.stopLoss));
// 995 is only 5 away (< 0.5x risk = 25) -> must NOT snap
const noSnap = computeTradePlan(price, 'BUY', atr, { support: [995], resistance: [] });
check('stop ignores support closer than 0.5x risk', noSnap.stopLoss === 950, String(noSnap.stopLoss));

// Target snap band now runs [target1R, targetSnapCeilingR] = [2R, 6.4R] = [100, 320]
const tsnap = computeTradePlan(price, 'BUY', atr, { support: [], resistance: [1250] });
check('target2 snaps to resistance inside [2R, 6.4R]', tsnap.target2 === 1250, String(tsnap.target2));
const tfar = computeTradePlan(price, 'BUY', atr, { support: [], resistance: [1400] });
check('target2 ignores resistance beyond 6.4R', tfar.target2 === 1200, String(tfar.target2));

// â”€â”€ downstream constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n[downstream wiring]');
const pt = require(path.join(ROOT, 'modules/paper_trading'));
check('paper_trading MAX_HOLD_DAYS = 40', pt.MAX_HOLD_DAYS === 40, String(pt.MAX_HOLD_DAYS));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

