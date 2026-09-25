/**
 * Carrying an app's rows into, and out of, a Postgres database -- a server, or
 * PGlite in this process. The same `Snapshot` every backend gives and takes
 * (`../../schema`), so the data moves along the path with its ids and
 * sequences unchanged.
 */
import type { Pool } from "pg";
import { isoTime, lastId, type Schema, type Snapshot } from "../../schema";
import { q } from "./sql";

/** Every row of the schema's tables (every version of a temporal row), and each sequence's last id. */
export async function exportTables(pool: Pool, schema: Schema): Promise<Snapshot> {
  const tables: Snapshot["tables"] = {};
  const sequences: Record<string, number> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
    const order = table.temporal ? "id, valid_from" : "id";
    const { rows } = await pool.query(`SELECT to_jsonb(t) AS row FROM ${q(table.name)} t ORDER BY ${order}`);
    tables[key] = rows.map(({ row }: { row: Record<string, unknown> }) =>
      table.temporal ? { ...row, valid_from: isoTime(row.valid_from), valid_to: isoTime(row.valid_to) } : row,
    );
    const seq = (await pool.query(`SELECT last_value, is_called FROM ${q(`seq_${table.name}`)}`)).rows[0];
    sequences[key] = seq ? Number(seq.last_value) - (seq.is_called ? 0 : 1) : 0;
  }
  return { tables, sequences };
}

/**
 * Put a snapshot's rows into the schema's tables, as they are (ids kept), and
 * set each sequence past them, so the next row the database names follows the
 * last one named where the rows came from. The tables should be empty.
 */
export async function importTables(pool: Pool, schema: Schema, snapshot: Snapshot): Promise<void> {
  for (const [key, table] of Object.entries(schema.tables)) {
    for (const row of snapshot.tables[key] ?? []) {
      const value = table.temporal ? { valid_from: new Date().toISOString(), valid_to: null, ...row } : row;
      await pool.query(`INSERT INTO ${q(table.name)} SELECT * FROM jsonb_populate_record(null::${q(table.name)}, $1)`, [JSON.stringify(value)]);
    }
    const last = lastId(snapshot, key);
    await pool.query(`SELECT setval($1, $2, $3)`, [`seq_${table.name}`, Math.max(last, 1), last > 0]);
  }
}
