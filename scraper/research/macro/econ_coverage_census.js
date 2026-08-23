'use strict';
/**
 * Is the economic calendar good enough to run an event study on?
 *
 * This runs BEFORE any hypothesis is written down, and it is allowed to say no.
 * The whole appeal of this feed is `consensus`, and an event study needs three
 * things the feed does not promise:
 *
 *   1. every release present, not most of them -- a missing CPI is not a missing
 *      row, it is a month where the model silently has no opinion, and the
 *      missingness is unlikely to be random
 *   2. a consensus attached to it, since a release without one contributes
 *      nothing to a surprise
 *   3. enough of them that the test can detect an effect worth acting on
 *
 * The last point is the one that usually kills a design here, and it is cheaper
 * to learn it now than after a pre-registration has been committed. So this
 * prints the detectable |IC| at the n it finds, and the answer is what it is.
 *
 * It also checks something that would quietly corrupt any CPI test: whether
 * `seq` reliably separates the month-on-month print from the year-on-year one.
 * They share a name and a timestamp, and mixing them would average two different
 * series into one.
 *
 * Usage: node scraper/research/macro/econ_coverage_census.js
 */
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');

/** Releases worth considering, with what the true schedule should look like. */
const CANDIDATES = [
  { name: 'CPI',                      country: 'United States', perYear: 12, why: 'the headline inflation print' },
  { name: 'Core CPI',                 country: 'United States', perYear: 12, why: 'the rates-relevant one' },
  { name: 'Nonfarm Payrolls',         country: 'United States', perYear: 12, why: 'the labour print' },
  { name: 'Initial Jobless Claims',   country: 'United States', perYear: 52, why: 'weekly, high n' },
  { name: 'Crude Oil Inventories',    country: 'United States', perYear: 52, why: 'weekly, but a commodity story' },
  { name: 'PPI',                      country: 'United States', perYear: 12, why: 'upstream inflation' },
  { name: 'Retail Sales',             country: 'United States', perYear: 12, why: 'demand' },
  { name: 'GDP',                      country: 'United States', perYear: 4,  why: 'quarterly, low n' },
  { name: 'ISM Manufacturing PMI',    country: 'United States', perYear: 12, why: 'the PMI we could never license' },
  { name: 'Fed Interest Rate Decision', country: 'United States', perYear: 8, why: 'the policy event itself' },
];

/** Two-sided detectable |IC| at alpha 0.05, from Fisher-z. */
function detectableIC(n) {
  if (n < 5) return null;
  const z = 1.95996 / Math.sqrt(n - 3);
  return (Math.exp(2 * z) - 1) / (Math.exp(2 * z) + 1);
}

(async () => {
  const pool = createPool();

  const [[span]] = await pool.query(
    'SELECT COUNT(*) total, MIN(release_date) a, MAX(release_date) b, COUNT(DISTINCT release_date) days FROM ft_econ_calendar');
  if (!span.total) { console.log('ft_econ_calendar is empty — run the fetcher first.'); await pool.end(); return; }

  const from = span.a.toISOString().slice(0, 10), to = span.b.toISOString().slice(0, 10);
  const years = (new Date(to) - new Date(from)) / (365.25 * 86400000);

  console.log('ECONOMIC CALENDAR — coverage census');
  console.log(`  ${span.total} rows over ${span.days} dates, ${from} .. ${to} (${years.toFixed(1)} years)`);
  console.log('  dates are the CORRECTED release dates, not the feed\'s filing dates');
  console.log('');

  const [countries] = await pool.query(
    'SELECT country, COUNT(*) n FROM ft_econ_calendar GROUP BY country ORDER BY n DESC');
  console.log(`  countries: ${countries.length} — ${countries.map(c => c.country).join(', ')}`);
  console.log(`  Indonesia present: ${countries.some(c => /indones/i.test(c.country)) ? 'YES' : 'NO'}`);
  console.log('');

  console.log('CANDIDATE RELEASES');
  console.log('  event                          releases  expected  with consensus   surprises!=0   detectable |IC|');
  const viable = [];

  for (const c of CANDIDATES) {
    const [[r]] = await pool.query(`
      SELECT COUNT(DISTINCT release_date) releases,
             SUM(consensus IS NOT NULL AND actual IS NOT NULL) withBoth,
             SUM(consensus IS NOT NULL AND actual IS NOT NULL AND actual <> consensus) nonZero
        FROM ft_econ_calendar WHERE country = ? AND event_name = ?`, [c.country, c.name]);

    const expected = Math.round(c.perYear * years);
    const releases = Number(r.releases || 0);
    const withBoth = Number(r.withBoth || 0);
    const nonZero = Number(r.nonZero || 0);
    const dIC = detectableIC(releases);

    console.log('  ' + c.name.padEnd(30) +
      String(releases).padStart(8) + String(expected).padStart(10) +
      String(withBoth).padStart(16) + String(nonZero).padStart(15) +
      (dIC === null ? '            n/a' : ('        ' + dIC.toFixed(3)).padStart(18)) +
      (releases < expected * 0.9 ? '   INCOMPLETE' : ''));

    if (releases >= expected * 0.9 && withBoth > 0) viable.push({ ...c, releases, withBoth, nonZero, dIC });
  }

  console.log('');
  console.log('  "expected" assumes the release ran on its normal schedule for the whole window.');
  console.log('  A shortfall is a HOLE, and holes in an event study are rarely random.');
  console.log('  "surprises != 0" matters because a print exactly in line carries no information;');
  console.log('  ranking a column of zeros against returns measures nothing.');

  // ── does seq actually separate MoM from YoY? ───────────────────────────────
  console.log('');
  console.log('DOES seq SEPARATE THE MONTH-ON-MONTH PRINT FROM THE YEAR-ON-YEAR ONE?');
  console.log('  They share a name and a timestamp. Averaging them together would be two');
  console.log('  different series in one column, and nothing downstream would notice.');
  for (const name of ['CPI', 'Core CPI']) {
    const [rows] = await pool.query(`
      SELECT seq, COUNT(*) n, ROUND(AVG(ABS(actual)), 2) meanAbs,
             ROUND(MIN(actual), 2) lo, ROUND(MAX(actual), 2) hi
        FROM ft_econ_calendar
       WHERE country = 'United States' AND event_name = ? AND unit = '%' AND actual IS NOT NULL
       GROUP BY seq ORDER BY seq`, [name]);
    for (const r of rows) {
      // MoM prints sit near zero; YoY sits at the inflation rate. If the two seq
      // groups do not separate cleanly, seq is not carrying the distinction and
      // any CPI test built on it is measuring a mixture.
      console.log(`  ${name.padEnd(10)} seq${r.seq}  n=${String(r.n).padStart(3)}  mean|x|=${String(r.meanAbs).padStart(5)}  range ${r.lo} .. ${r.hi}` +
        (r.meanAbs !== null && r.meanAbs < 1 ? '   <- month-on-month' : r.meanAbs >= 1 ? '   <- year-on-year' : ''));
    }
  }

  console.log('');
  console.log('VERDICT');
  if (!viable.length) {
    console.log('  NOTHING is complete enough to build an event study on. Say so and stop;');
    console.log('  a hypothesis registered against a holed sample is worse than no hypothesis.');
  } else {
    for (const v of viable) {
      const verdict = v.dIC > 0.25 ? 'UNDERPOWERED — only a very large effect could clear'
        : v.dIC > 0.15 ? 'weak — a real but ordinary effect would be missed'
          : 'usable';
      console.log(`  ${v.name.padEnd(28)} n=${String(v.releases).padStart(4)}  detects |IC| >= ${v.dIC.toFixed(3)}  ${verdict}`);
    }
    console.log('');
    console.log('  The number to argue with is the detectable IC, not the row count. Every');
    console.log('  macro result this project has produced so far has an |IC| under 0.25.');
  }

  await pool.end();
})().catch(env.fail);
