'use strict';
/**
 * Which CPI row is month-on-month, and which is year-on-year?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * A US CPI release puts several rows on the calendar at the same timestamp under
 * the same name. `seq` -- their order within that group -- was the obvious way to
 * tell them apart, and the coverage census showed it does not work:
 *
 *     CPI seq0   n=125   range -0.8 .. 8.5
 *
 * No single series spans that. Month-on-month lives in -0.8..1.3 and
 * year-on-year in 1..9, so the slot holds different meanings on different dates.
 * Row order IS stable within one date -- verified by fetching the same date twice
 * -- but that is a different claim from stable ACROSS dates, and only the first
 * one was ever tested. A surprise series built on `seq` would average two
 * unrelated quantities and nothing downstream would notice.
 *
 * ── HOW IT IS RESOLVED ───────────────────────────────────────────────────────
 *
 * Not by a magnitude rule of thumb ("big means year-on-year"), which fails in
 * exactly the months that matter -- 2022 had MoM prints above 1.0 and 2020 had
 * YoY near 0.1, and the two ranges genuinely overlap there.
 *
 * Instead each row is matched against an INDEPENDENT anchor we already hold:
 * FRED's CPIAUCSL index in `ft_macro_data`. For the month a release reports, the
 * arithmetic gives an expected MoM and an expected YoY, and each row is assigned
 * to whichever it is nearer -- with the assignment required to be a bijection, so
 * a date where both rows want the same label is reported rather than guessed.
 *
 * The anchor is verifiable rather than assumed: the calendar's own "CPI Index,
 * s.a" row for the 2026-08 release reads 332.81 and FRED's CPIAUCSL for July
 * 2026 is 332.8130. Same number, so the two sources are describing the same
 * series and the release-to-month mapping is right.
 *
 * ONE HONEST CAVEAT. BLS reports MoM seasonally adjusted and YoY *not* seasonally
 * adjusted; we hold only the SA index, so the expected YoY is off by up to
 * ~0.2pp. That is irrelevant here -- it only ever has to beat the OTHER
 * candidate, which is several points away -- but it would matter if these
 * expected values were used as data rather than as labels. They are not.
 *
 * Usage:
 *   node scraper/research/macro/econ_resolve_cpi.js            report only
 *   node scraper/research/macro/econ_resolve_cpi.js --write    persist `measure`
 */
const env = require('../env');
env.loadEnv();

const { createPool } = require('../../modules/db_config');

const WRITE = process.argv.includes('--write');
const EVENTS = ['CPI', 'Core CPI'];

const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The month a release reports: the calendar month before the one it lands in. */
function reportedMonth(releaseDate) {
  const d = new Date(releaseDate + 'T00:00:00Z');
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

function addMonths(ym, n) {
  const d = new Date(ym + '-01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

(async () => {
  const pool = createPool();

  // ── the anchor ────────────────────────────────────────────────────────────
  const [idxRows] = await pool.query(
    "SELECT date, value FROM ft_macro_data WHERE indicator = 'CPI' AND source = 'FRED' ORDER BY date ASC");
  const index = new Map(idxRows.map(r => [iso(r.date).slice(0, 7), Number(r.value)]));
  console.log(`FRED CPIAUCSL anchor: ${index.size} monthly observations`);

  if (index.size < 200) {
    console.log('Too little anchor history to resolve ten years of releases. Stop.');
    await pool.end();
    return;
  }

  let resolved = 0, ambiguous = 0, noAnchor = 0, seq0IsMom = 0, seq0IsYoy = 0;
  const problems = [];
  const updates = [];

  for (const eventName of EVENTS) {
    const [rows] = await pool.query(`
      SELECT id, release_date, seq, actual, consensus, previous
        FROM ft_econ_calendar
       WHERE country = 'United States' AND event_name = ? AND unit = '%'
         AND actual IS NOT NULL
       ORDER BY release_date, seq`, [eventName]);

    const byDate = new Map();
    for (const r of rows) {
      const d = iso(r.release_date);
      if (!byDate.has(d)) byDate.set(d, []);
      byDate.get(d).push(r);
    }

    for (const [date, group] of byDate) {
      // Only the two percent rows are in play. A release that produced one or
      // three of them is not something to guess at.
      if (group.length !== 2) { problems.push(`${eventName} ${date}: ${group.length} percent rows`); continue; }

      const m = reportedMonth(date);
      const cur = index.get(m), prev = index.get(addMonths(m, -1)), yearAgo = index.get(addMonths(m, -12));
      if (!(cur > 0) || !(prev > 0) || !(yearAgo > 0)) { noAnchor++; continue; }

      const expMom = (cur / prev - 1) * 100;
      const expYoy = (cur / yearAgo - 1) * 100;

      // Assign by nearest, then REQUIRE a bijection. If both rows prefer the
      // same label the release is reported, never split by a tiebreak -- a
      // tiebreak here is the guess this whole file exists to avoid.
      const pick = group.map(r => {
        const dMom = Math.abs(Number(r.actual) - expMom);
        const dYoy = Math.abs(Number(r.actual) - expYoy);
        return { r, label: dMom <= dYoy ? 'MOM' : 'YOY', dMom, dYoy };
      });

      if (pick[0].label === pick[1].label) {
        ambiguous++;
        problems.push(`${eventName} ${date}: both rows read as ${pick[0].label} ` +
          `(actuals ${group.map(g => g.actual).join(', ')}; expected MoM ${expMom.toFixed(2)}, YoY ${expYoy.toFixed(2)})`);
        continue;
      }

      resolved++;
      const momRow = pick.find(p => p.label === 'MOM').r;
      if (Number(momRow.seq) === 0) seq0IsMom++; else seq0IsYoy++;
      for (const p of pick) updates.push([p.r.id, p.label]);
    }
  }

  console.log('');
  console.log('RESOLUTION');
  console.log(`  releases resolved cleanly : ${resolved}`);
  console.log(`  both rows wanted one label: ${ambiguous}`);
  console.log(`  no FRED anchor for the month: ${noAnchor}`);
  console.log('');
  console.log('IS seq A RELIABLE LABEL? (this is the question that started it)');
  console.log(`  month-on-month sat in seq0 : ${seq0IsMom}`);
  console.log(`  month-on-month sat in seq1 : ${seq0IsYoy}`);
  if (seq0IsMom && seq0IsYoy) {
    const minor = Math.min(seq0IsMom, seq0IsYoy);
    console.log(`  -> seq IS NOT a label. Using it would mislabel ${minor} of ${resolved} releases ` +
      `(${(minor / resolved * 100).toFixed(1)}%), silently.`);
  } else if (resolved) {
    console.log('  -> seq happened to be consistent here, but nothing enforces that;');
    console.log('     the resolved label is still what should be stored.');
  }

  if (problems.length) {
    console.log('');
    console.log(`UNRESOLVED (${problems.length}) — listed, not swept up:`);
    problems.slice(0, 15).forEach(p => console.log('  ' + p));
    if (problems.length > 15) console.log(`  ... and ${problems.length - 15} more`);
  }

  if (!WRITE) {
    console.log('');
    console.log(`Report only. Re-run with --write to persist ${updates.length} labels.`);
    await pool.end();
    return;
  }

  await pool.query("ALTER TABLE ft_econ_calendar ADD COLUMN measure VARCHAR(8) NULL").catch(() => {});
  // Written one statement per label rather than row by row; the ids are already
  // decided, so this is bookkeeping and not another chance to get it wrong.
  for (const label of ['MOM', 'YOY']) {
    const ids = updates.filter(u => u[1] === label).map(u => u[0]);
    if (!ids.length) continue;
    await pool.query('UPDATE ft_econ_calendar SET measure = ? WHERE id IN (?)', [label, ids]);
    console.log(`  wrote measure=${label} on ${ids.length} rows`);
  }

  const [[check]] = await pool.query(
    "SELECT SUM(measure='MOM') mom, SUM(measure='YOY') yoy, SUM(measure IS NULL) unlabelled FROM ft_econ_calendar WHERE country='United States' AND event_name IN ('CPI','Core CPI') AND unit='%'");
  console.log(`  now: MOM ${check.mom}, YOY ${check.yoy}, still unlabelled ${check.unlabelled}`);

  await pool.end();
})().catch(env.fail);
