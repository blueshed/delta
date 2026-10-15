/** Every row and sequence out (`exportTables`) and in (`importTables`): the `Snapshot` every backend gives and takes. */
import { isoTime, lastId, q, type Schema, type Snapshot } from "../../schema";
import { createSequences } from "./ddl";
import { decodeRow, encodeValue, now, sqliteTime } from "./rows";

/**
 * Every row of the schema's tables -- every version of a temporal row, with
 * its validity -- and each collection's last minted id: the `Snapshot` every
 * backend gives and takes, so the data moves along the path unchanged.
 */
export function exportTables(db: any, schema: Schema): Snapshot {
  createSequences(db);
  const tables: Snapshot["tables"] = {};
  const sequences: Record<string, number> = {};
  for (const [key, table] of Object.entries(schema.tables)) {
    const rows = db.query(`SELECT * FROM ${q(table.name)} ORDER BY id${table.temporal ? ", valid_from" : ""}`).all() as any[];
    tables[key] = rows.map((row) => {
      const validity = table.temporal ? { valid_from: isoTime(row.valid_from), valid_to: isoTime(row.valid_to) } : {};
      decodeRow(table, row);
      return { ...row, ...validity };
    });
    const seq = db.query("SELECT last FROM _delta_sequences WHERE collection = ?").get(key) as { last: number } | null;
    sequences[key] = Math.max(seq?.last ?? 0, lastId({ tables }, key));
  }
  return { tables, sequences };
}

/**
 * Put a snapshot's rows into the schema's tables as they are (ids kept) and
 * set each collection's sequence past them, so the next row named follows the
 * last one named where the rows came from. The tables should be empty.
 */
export function importTables(db: any, schema: Schema, snapshot: Snapshot): void {
  createSequences(db);
  db.transaction(() => {
    for (const [key, table] of Object.entries(schema.tables)) {
      const cols = ["id", ...(table.parent ? [table.parent.fkColumn] : []), ...Object.keys(table.columns), ...(table.temporal ? ["valid_from", "valid_to"] : [])];
      const insert = db.query(`INSERT INTO ${q(table.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
      for (const row of snapshot.tables[key] ?? []) {
        insert.run(...cols.map((c) =>
          // a version given no start begins now, by the clock writes keep, so a write in the same
          // millisecond starts the next version after it, never at it (one (id, valid_from) each)
          c === "valid_from" ? (row.valid_from == null ? now() : sqliteTime(row.valid_from))
          : c === "valid_to" ? (row.valid_to == null ? null : sqliteTime(row.valid_to))
          : encodeValue(table, c, row[c])));
      }
      db.run("INSERT INTO _delta_sequences (collection, last) VALUES (?, ?) ON CONFLICT (collection) DO UPDATE SET last = excluded.last", [key, lastId(snapshot, key)]);
    }
  })();
}
