/**
 * Schema migrations that prove themselves.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * R2's new columns were defined in the DDL and never reached the production
 * table created by R1 — the fetcher would have gone straight to
 * "Unknown column 'fetch_status'". And the old unique index was dropped with
 * `.catch(() => {})`, which is the swallow-the-failure pattern this project
 * already banned in the IDX engine: if the drop failed, the legacy key stayed
 * and kept forbidding exactly the multi-model history the new key exists to
 * allow, while the log said nothing.
 *
 * So every function here ALTERs and then reads information_schema back, and
 * throws when reality disagrees with the intent.
 */
'use strict';

async function columnExists(pool, db, table, column) {
  const [[r]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND COLUMN_NAME=?`, [db, table, column]);
  return Number(r.n) > 0;
}

async function indexColumns(pool, db, table, index) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND INDEX_NAME=? ORDER BY SEQ_IN_INDEX`,
    [db, table, index]);
  if (!rows.length) return null;
  return { columns: rows.map(r => r.COLUMN_NAME), unique: Number(rows[0].NON_UNIQUE) === 0 };
}

/** Add a column if missing, then prove it is there. */
async function ensureColumn(pool, db, table, column, ddl, applied = []) {
  if (await columnExists(pool, db, table, column)) return false;
  await pool.query(`ALTER TABLE \`${table}\` ${ddl}`);
  if (!await columnExists(pool, db, table, column)) {
    throw new Error(`migration reported success but ${table}.${column} is still absent`);
  }
  applied.push(`+column ${table}.${column}`);
  return true;
}

/**
 * Remove an obsolete index and PROVE it is gone.
 *
 * A legacy UNIQUE(session_date, stock_code) does not stop forbidding a second
 * model's rows just because a wider key was added beside it.
 */
async function dropIndex(pool, db, table, index, applied = []) {
  if (!await indexColumns(pool, db, table, index)) return false;
  await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
  const still = await indexColumns(pool, db, table, index);
  if (still) throw new Error(`failed to drop obsolete index ${table}.${index} — it is still present`);
  applied.push(`-index ${table}.${index}`);
  return true;
}

/** Create or rebuild a unique index so its column list is exactly `columns`. */
async function ensureUniqueIndex(pool, db, table, index, columns, applied = []) {
  const have = await indexColumns(pool, db, table, index);
  const want = columns.join(',');
  if (have && have.unique && have.columns.join(',') === want) return false;
  if (have) await dropIndex(pool, db, table, index, applied);
  await pool.query(
    `ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${columns.map(c => `\`${c}\``).join(', ')})`);
  const now = await indexColumns(pool, db, table, index);
  if (!now || !now.unique || now.columns.join(',') !== want) {
    throw new Error(`${table}.${index} is ${now ? now.columns.join(',') : 'absent'} but must be ${want}`);
  }
  applied.push(`+index ${table}.${index} (${want})`);
  return true;
}

/** Refuse to run against a table whose shape is not what the code assumes. */
async function assertColumns(pool, db, table, columns) {
  const missing = [];
  for (const c of columns) if (!await columnExists(pool, db, table, c)) missing.push(c);
  if (missing.length) {
    throw new Error(`${table} is missing ${missing.join(', ')} — migration did not run or did not take`);
  }
}

module.exports = { columnExists, indexColumns, ensureColumn, dropIndex, ensureUniqueIndex, assertColumns };
