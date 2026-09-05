'use strict';
/** Pins HOLDOUT_US_2026-09-05.md. A guard nobody tests is a comment. */
const assert = require('assert');
const r = require('./modules/us_reserve');

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`); }
};
const throws = fn => { try { fn(); return false; } catch { return true; } };

t('boundaries are the documented absolute dates', () => {
  assert.strictEqual(r.RESERVE.B.from, '2001-04-09');
  assert.strictEqual(r.RESERVE.B.to, '2006-09-04');
  assert.strictEqual(r.RESERVE.F.from, '2026-09-05');
  assert.strictEqual(r.RESERVE.F.to, null);
});

t('classify partitions every boundary session correctly', () => {
  const cases = {
    '2000-12-29': 'BELOW_FLOOR',   // pre-decimal
    '2001-04-08': 'BELOW_FLOOR',   // day before the floor
    '2001-04-09': 'RESERVE_B',     // the floor itself is IN
    '2006-09-04': 'RESERVE_B',     // last reserved session
    '2006-09-05': 'SPENT_UNREAD',
    '2007-02-28': 'DISCOVERY',
    '2018-12-31': 'DISCOVERY',
    '2019-01-01': 'VALIDATION',
    '2023-12-29': 'VALIDATION',
    '2024-01-01': 'BURNED',
    '2026-09-01': 'BURNED',
    '2026-09-04': 'SPENT_UNREAD',
    '2026-09-05': 'RESERVE_F',
    '2030-01-01': 'RESERVE_F',
  };
  for (const [d, want] of Object.entries(cases)) assert.strictEqual(r.classify(d), want, `${d}`);
});

t('classify accepts Date objects, not only strings', () => {
  assert.strictEqual(r.classify(new Date('2005-06-01T00:00:00Z')), 'RESERVE_B');
});

t('reading RESERVE-B without the flag throws', () => {
  assert.ok(throws(() => r.assertAdmissible(['2007-03-01', '2005-01-04'])));
});

t('reading RESERVE-F without the flag throws', () => {
  assert.ok(throws(() => r.assertAdmissible(['2026-09-05'])));
});

t('the right flag opens only the reserve it names', () => {
  // B opened -> B passes
  assert.ok(r.assertAdmissible(['2005-01-04'], { openHoldout: true, reserve: 'B' }));
  // B opened must NOT also open F — the commonest way a guard leaks
  assert.ok(throws(() => r.assertAdmissible(['2026-09-05'], { openHoldout: true, reserve: 'B' })));
  assert.ok(throws(() => r.assertAdmissible(['2005-01-04'], { openHoldout: true, reserve: 'F' })));
});

t('--open-holdout alone, with no reserve named, opens nothing', () => {
  assert.ok(throws(() => r.assertAdmissible(['2005-01-04'], { openHoldout: true })));
});

t('pre-decimal data is refused even WITH the flag', () => {
  // The floor is about instrument geometry, not about spending a budget, so no
  // amount of holdout authorisation should buy sixteenths-quoted bars.
  assert.ok(throws(() => r.assertAdmissible(['2000-06-01'], { openHoldout: true, reserve: 'B' })));
});

t('ordinary spent data needs no flag', () => {
  assert.ok(r.assertAdmissible(['2007-03-01', '2020-05-01', '2025-02-03']));
});

t('sqlExcludeReserves brackets both reserves', () => {
  const s = r.sqlExcludeReserves('d');
  assert.ok(s.includes("d > '2006-09-04'") && s.includes("d < '2026-09-05'"), s);
});

t('the definition document is present and hashable', () => {
  const h = r.definitionHash();
  assert.ok(h && h.length === 16, 'HOLDOUT_US_2026-09-05.md missing — the guard has no source of truth');
});

t('the anchor bar matches the promotion contract', () => {
  assert.strictEqual(r.MIN_ANCHORS, 30);
});

console.log(`\nus_reserve: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
