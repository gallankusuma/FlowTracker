'use strict';
/**
 * Broker identity — two axes, and the tests that keep them apart.
 *
 * The whole reason this module exists is that `ft_broker_config`'s single label
 * answers two different questions with one word, and measurement showed the two
 * answers routinely disagree:
 *
 *   Mirae Asset (YP)  foreign-OWNED,  1.1% foreign flow
 *   UBS (AK)          foreign-OWNED, 96.6% foreign flow
 *   Verdhana (BB)     labelled BIG_MONEY, 54.6% foreign flow
 *
 * Anyone reading "foreign brokers are buying" off a list containing Mirae would
 * conclude foreign money is arriving when it is Indonesian retail using a
 * Korean-owned platform. These tests pin the distinction so a later refactor
 * cannot quietly collapse it back into one field.
 *
 * Run: node test_broker_registry.js
 */

const assert = require('assert');
const { describe, labelDisagreements } = require('./modules/broker_registry');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }
t.section = title => queue.push([title, null]);

/** A registry shaped like the real one, using the real measured figures. */
function fixture() {
  const rows = [
    { code: 'AK', name: 'UBS Sekuritas Indonesia', configCategory: 'FOREIGN', ownership: 'FOREIGN_OWNED', clientBase: null, foreignPct: 96.6, turnover: 487e12, perTickerDay: 18677e6 },
    { code: 'YP', name: 'Mirae Asset Sekuritas Indonesia', configCategory: 'FOREIGN', ownership: 'FOREIGN_OWNED', clientBase: null, foreignPct: 1.1, turnover: 222e12, perTickerDay: 6118e6 },
    { code: 'BB', name: 'Verdhana Sekuritas Indonesia', configCategory: 'BIG_MONEY', ownership: 'DOMESTIC', clientBase: null, foreignPct: 54.6, turnover: 30e12, perTickerDay: 3000e6 },
    { code: 'XL', name: 'Stockbit Sekuritas Digital', configCategory: 'RITEL', ownership: 'DOMESTIC', clientBase: 'RETAIL_PLATFORM', foreignPct: 0.1, turnover: 374e12, perTickerDay: 9943e6 },
    { code: 'CC', name: 'Mandiri Sekuritas', configCategory: 'BIG_MONEY', ownership: 'DOMESTIC', clientBase: null, foreignPct: 6.0, turnover: 426e12, perTickerDay: 11572e6 },
    { code: 'GW', name: null, configCategory: null, ownership: null, clientBase: null, foreignPct: 100, turnover: 1e11, perTickerDay: 1524e6 },
  ];
  return { byCode: new Map(rows.map(r => [r.code, r])), footprintDays: 250 };
}

t.section('describe');

t('a foreign-owned house with foreign flow reads as both', () => {
  const d = describe(fixture(), 'AK');
  assert.strictEqual(d.ownership, 'FOREIGN_OWNED');
  assert.ok(/foreign-owned/.test(d.label), d.label);
  assert.ok(/96\.6% foreign flow/.test(d.label), d.label);
});

t('a foreign-OWNED house with domestic flow says BOTH things, and does not hide either', () => {
  // The case that matters. Mirae must not read simply as "foreign": the label
  // and the measurement have to appear side by side so the contradiction is
  // visible in the report rather than resolved silently in favour of the label.
  const d = describe(fixture(), 'YP');
  assert.ok(/foreign-owned/.test(d.label), d.label);
  assert.ok(/1\.1% foreign flow/.test(d.label), d.label);
});

t('a retail platform is tagged as one, and retail is not a claim about size', () => {
  const d = describe(fixture(), 'XL');
  assert.strictEqual(d.clientBase, 'RETAIL_PLATFORM');
  assert.ok(/retail platform/.test(d.label));
  // Stockbit out-trades most foreign houses. "Retail" says who the clients are.
  assert.ok(d.turnover > describe(fixture(), 'BB').turnover);
});

t('an unknown code says unknown instead of being folded into a category', () => {
  const d = describe(fixture(), 'ZZ');
  assert.strictEqual(d.known, false);
  assert.ok(/unknown broker/.test(d.label));
  assert.strictEqual(d.ownership, undefined);
});

t('a code with flow but no config still reports what IS measured', () => {
  // GW carries no name and no category but 100% foreign flow. Reporting nothing
  // would throw away the only fact available about it.
  const d = describe(fixture(), 'GW');
  assert.strictEqual(d.known, true);
  assert.strictEqual(d.ownership, null);
  assert.ok(/100% foreign flow/.test(d.label), d.label);
});

t('a missing measurement is absent from the label, never printed as 0%', () => {
  const reg = fixture();
  reg.byCode.set('NM', { code: 'NM', name: 'No Measurement', configCategory: 'BIG_MONEY', ownership: 'DOMESTIC', clientBase: null, foreignPct: null });
  const d = describe(reg, 'NM');
  assert.ok(!/foreign flow/.test(d.label), `an unmeasured broker printed a share: ${d.label}`);
  assert.strictEqual(d.foreignPct, null);
});

t.section('labelDisagreements');

t('a domestic label with mostly foreign flow is surfaced', () => {
  const d = labelDisagreements(fixture());
  const bb = d.find(x => x.code === 'BB');
  assert.ok(bb, 'Verdhana at 54.6% foreign should be flagged');
  assert.ok(/most of its flow is/.test(bb.issue));
});

t('a foreign label with almost no foreign flow is surfaced, with the reason', () => {
  const d = labelDisagreements(fixture());
  const yp = d.find(x => x.code === 'YP');
  assert.ok(yp, 'Mirae at 1.1% foreign should be flagged');
  assert.ok(/ownership is not client base/.test(yp.issue));
});

t('a label that agrees with its measurement is NOT flagged', () => {
  const d = labelDisagreements(fixture());
  assert.ok(!d.some(x => x.code === 'AK'), 'UBS agrees on both axes and must stay quiet');
  assert.ok(!d.some(x => x.code === 'CC'), 'Mandiri at 6% domestic flow is consistent');
});

t('a broker with no measurement is never flagged on a number it does not have', () => {
  const reg = fixture();
  reg.byCode.set('NM', { code: 'NM', name: 'No Measurement', configCategory: 'FOREIGN', ownership: 'FOREIGN_OWNED', clientBase: null, foreignPct: null });
  assert.ok(!labelDisagreements(reg).some(x => x.code === 'NM'));
});

t('the thresholds are a knob, not a truth', () => {
  // 50/15 is a reporting choice. Widening the band must catch more, not fewer --
  // if it does not, the comparison is the wrong way round somewhere.
  const wide = labelDisagreements(fixture(), { foreignFloor: 40, foreignCeiling: 30 });
  const narrow = labelDisagreements(fixture(), { foreignFloor: 90, foreignCeiling: 1 });
  assert.ok(wide.length >= narrow.length, `wide ${wide.length} < narrow ${narrow.length}`);
});

(async () => {
  for (const [name, fn] of queue) {
    if (!fn) { console.log(''); console.log(name); continue; }
    try { await fn(); pass++; console.log('  PASS  ' + name); }
    catch (e) { fail++; console.log('  FAIL  ' + name); console.log('        ' + e.message); }
  }
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
