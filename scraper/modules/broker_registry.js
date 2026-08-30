'use strict';
/**
 * Who is behind a broker code — on TWO axes, because one is not enough.
 *
 * `AK`, `XL`, `BB` mean nothing in a report. `ft_broker_config` already carries a
 * single label (FOREIGN / BIG_MONEY / RITEL), and checking it against the data
 * showed the label is doing two different jobs at once.
 *
 * ── OWNERSHIP IS NOT CLIENT BASE ─────────────────────────────────────────────
 *
 * Mirae Asset (`YP`) is Korean-owned and its order flow is overwhelmingly
 * Indonesian retail. UBS (`AK`) is foreign-owned AND its flow is 96.6% foreign.
 * Both are labelled FOREIGN, and for reading a tape they are opposites. Measured
 * across idx_broker_flow_detail:
 *
 *     mean foreign share, labelled FOREIGN : 44.5%   (n=19)
 *     mean foreign share, everyone else    :  9.2%   (n=69)
 *
 * The label separates the groups, so it is not wrong -- it is just one number
 * where two are needed. So this module reports:
 *
 *   ownership  — who owns the securities house. Public record, stable, from
 *                ft_broker_config.
 *   foreignPct — what share of that broker's value is tagged foreign in
 *                idx_broker_flow_detail. MEASURED, updates itself, and is the
 *                one that answers "is this foreign money?"
 *
 * ── "BIG_MONEY" IS A DEFAULT BUCKET, NOT A FINDING ───────────────────────────
 *
 * 63 of 89 brokers carry it, and their median 250-session turnover is 2,067 B
 * against 44,041 B for FOREIGN and 122,670 B for RITEL. The median "Big Money"
 * broker is the SMALLEST of the three groups by an order of magnitude. The name
 * says institutional; the data says unclassified.
 *
 * It is not renamed here because lib/brokerColors.ts and the UI read it. What
 * this module adds instead is the measured footprint, so a caller can tell a
 * Mandiri from a dormant shell without trusting the word.
 *
 * ── RETAIL IS NOT SMALL ──────────────────────────────────────────────────────
 *
 * RITEL has the HIGHEST median turnover of the three. Stockbit, Ajaib and Indo
 * Premier are among the largest brokers on the exchange by value. "Retail" is a
 * statement about who the clients are, not about size.
 */

const CACHE_MS = 10 * 60 * 1000;
let cache = null;

/**
 * Everything known about every broker, measured where it can be measured.
 * @param {import('mysql2/promise').Pool} pool
 * @param {{force?: boolean, footprintDays?: number}} [opts]
 */
async function loadRegistry(pool, opts = {}) {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache.data;

  const [cfg] = await pool.query('SELECT code, name, category, active FROM ft_broker_config');
  const byCode = new Map();
  for (const r of cfg) {
    byCode.set(r.code, {
      code: r.code,
      name: r.name || null,
      // The stored label. Kept under a name that says what it is rather than
      // what it claims: BIG_MONEY is where everything domestic lands.
      configCategory: r.category || null,
      ownership: r.category === 'FOREIGN' ? 'FOREIGN_OWNED' : r.category ? 'DOMESTIC' : null,
      clientBase: r.category === 'RITEL' ? 'RETAIL_PLATFORM' : null,
      active: r.active === undefined ? null : !!r.active,
      foreignPct: null, turnover: null, perTickerDay: null,
    });
  }

  // MEASURED: the share of each broker's traded value tagged foreign.
  const [flow] = await pool.query(`
    SELECT broker_code code,
           SUM(CASE WHEN investor_type = 'foreign' THEN buy_val + sell_val ELSE 0 END) fv,
           SUM(buy_val + sell_val) tv
      FROM idx_broker_flow_detail GROUP BY broker_code`);
  for (const r of flow) {
    const tv = Number(r.tv);
    if (!(tv > 0)) continue;
    const e = byCode.get(r.code) || { code: r.code, name: null, configCategory: null, ownership: null, clientBase: null, active: null };
    e.foreignPct = Math.round(Number(r.fv) / tv * 1000) / 10;
    byCode.set(r.code, e);
  }

  // MEASURED: footprint. A broker's size and how concentrated its flow is.
  const days = opts.footprintDays || 250;
  const [fp] = await pool.query(`
    SELECT broker_code code, COUNT(*) rows_, COUNT(DISTINCT date) days,
           SUM(buy_val + sell_val) turnover
      FROM idx_broker_summary
     WHERE date >= DATE_SUB((SELECT MAX(date) FROM idx_broker_summary), INTERVAL ? DAY)
     GROUP BY broker_code`, [days]);
  for (const r of fp) {
    const e = byCode.get(r.code) || { code: r.code, name: null, configCategory: null, ownership: null, clientBase: null, active: null, foreignPct: null };
    e.turnover = Number(r.turnover);
    e.perTickerDay = Number(r.turnover) / Math.max(1, Number(r.rows_));
    byCode.set(r.code, e);
  }

  const data = { byCode, footprintDays: days, loadedAt: new Date().toISOString() };
  cache = { at: Date.now(), data };
  return data;
}

/**
 * A short human tag for a broker code, for putting next to a number in a report.
 *
 * Says only what is known. An unclassified code returns the code and says so,
 * rather than being quietly folded into a category it was never assigned.
 */
function describe(registry, code) {
  const e = registry.byCode.get(code);
  if (!e) return { code, name: null, label: `${code} (unknown broker)`, known: false };

  const bits = [];
  if (e.ownership === 'FOREIGN_OWNED') bits.push('foreign-owned');
  else if (e.ownership === 'DOMESTIC') bits.push('domestic');
  if (e.clientBase === 'RETAIL_PLATFORM') bits.push('retail platform');
  // The measured axis goes last because it is the one that can contradict the
  // label, and it should read as the correction rather than the headline.
  if (e.foreignPct !== null) bits.push(`${e.foreignPct}% foreign flow`);

  return {
    code, name: e.name,
    ownership: e.ownership, clientBase: e.clientBase, configCategory: e.configCategory,
    foreignPct: e.foreignPct, turnover: e.turnover, perTickerDay: e.perTickerDay,
    known: true,
    label: `${code}${e.name ? ' ' + e.name : ''}${bits.length ? ' [' + bits.join(' · ') + ']' : ''}`,
  };
}

/**
 * Codes whose stored label disagrees with the measured foreign share.
 *
 * Not applied automatically. A label is a claim about ownership and a
 * measurement is a claim about flow; they are allowed to differ, and a broker
 * can be domestic-owned while executing mostly foreign orders. This surfaces the
 * disagreements so a person decides, which is the only safe way to edit a
 * reference table from a statistic.
 */
function labelDisagreements(registry, { foreignFloor = 50, foreignCeiling = 15 } = {}) {
  const out = [];
  for (const e of registry.byCode.values()) {
    if (e.foreignPct === null) continue;
    if (e.ownership !== 'FOREIGN_OWNED' && e.foreignPct >= foreignFloor) {
      out.push({ code: e.code, name: e.name, stored: e.configCategory || 'UNCLASSIFIED',
        foreignPct: e.foreignPct, issue: 'not labelled foreign, but most of its flow is' });
    }
    if (e.ownership === 'FOREIGN_OWNED' && e.foreignPct <= foreignCeiling) {
      out.push({ code: e.code, name: e.name, stored: e.configCategory,
        foreignPct: e.foreignPct, issue: 'foreign-OWNED, but its flow is almost entirely domestic — ownership is not client base' });
    }
  }
  return out.sort((a, b) => b.foreignPct - a.foreignPct);
}

module.exports = { loadRegistry, describe, labelDisagreements };
