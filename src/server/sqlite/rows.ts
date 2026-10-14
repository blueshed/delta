/** A row as SQLite keeps it: written, closed, read back, and each value as its column stores it. */
import { defaultForType, isoTime, q, utcTime, type ColumnDef, type DocDef, type ResolvedTable, type Schema } from "../../schema";
import { rowId } from "../scope";

/** The view a collection's current rows are read from. */
export const current = (table: ResolvedTable) => q(table.temporal ? `current_${table.name}` : table.name);

/**
 * What a row is read by: its id, its parent key, the columns the schema
 * declares and a temporal row's validity -- never a column it does not declare
 * (a later version's, added under this one), which would ride into the
 * document, the answer and the ledger, and an undo would put back a field this
 * version refuses.
 */
export const columnsOf = (table: ResolvedTable): string =>
  ["id", ...(table.parent ? [table.parent.fkColumn] : []), ...Object.keys(table.columns), ...(table.temporal ? ["valid_from", "valid_to"] : [])].map(q).join(", ");

/** A time in SQLite's own sortable form, "YYYY-MM-DD HH:MM:SS.mmm" in UTC, from ISO-8601 or that form. */
export function sqliteTime(value: unknown): string {
  const iso = isoTime(value);
  return iso && /^\d{4}-\d{2}-\d{2}T/.test(iso) ? iso.replace("T", " ").replace("Z", "") : String(value);
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

// Strictly-monotonic, millisecond-resolution timestamp. The temporal PK is
// (id, valid_from); whole-second timestamps made any two writes to the same
// row within one wall-clock second — including the common create-then-edit —
// collide on the PK and roll the delta back. Millisecond precision plus a
// per-process monotonic bump guarantees every call yields a distinct,
// lexicographically-sortable valid_from. Format "YYYY-MM-DD HH:MM:SS.mmm"
// stays comparable with the `datetime('now')` column default.
let _lastNowMs = 0;
export function now(): string {
  let ms = Date.now();
  if (ms <= _lastNowMs) ms = _lastNowMs + 1;
  _lastNowMs = ms;
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

// Close the live version of a row. When a reinsert follows, the caller MUST
// pass the reinsert's `ts` so the old row's valid_to EXACTLY equals the new
// row's valid_from — otherwise (with monotonic sub-second now()) the close
// lands a tick later than the reinsert, leaving a temporal overlap that makes
// half-open time-travel reads (valid_to > at) match two versions at once.
export function closeRow(db: any, table: ResolvedTable, id: string | number, ts: string): void {
  db.run(`UPDATE ${q(table.name)} SET valid_to = ? WHERE id = ? AND valid_to IS NULL`, [ts, id]);
}

/**
 * Insert one version of a row -- a new row, a root row, or the next version of
 * a temporal one: its id, its parent key, its columns, and on a temporal
 * table `valid_from = ts`. The one row writer: the three it replaces had
 * drifted, and the root's had lost the parent key (v0.5.0 review #5).
 */
export function insertRow(db: any, table: ResolvedTable, row: any, ts: string) {
  const cols = ["id"];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (table.temporal) cols.push("valid_from");
  // a row put back as it was stored (an undo of its removal) has the columns this version does not declare too
  const declared = declaredColumns(table);
  if (Object.keys(row).some((k) => !declared.has(k))) {
    const stored = new Set(undeclaredColumns(db, table));
    cols.push(...Object.keys(row).filter((k) => stored.has(k)));
  }
  const vals = cols.map((c) => (c === "valid_from" ? ts : encodeValue(table, c, row[c])));
  db.run(`INSERT INTO ${q(table.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
}

/** The columns a row of `table` is read and written by (`columnsOf`), by name. */
export const declaredColumns = (table: ResolvedTable): Set<string> =>
  new Set(["id", ...(table.parent ? [table.parent.fkColumn] : []), ...Object.keys(table.columns), "valid_from", "valid_to"]);

/** The table's columns the schema does not declare: a later version's, there under this one. */
export function undeclaredColumns(db: any, table: ResolvedTable): string[] {
  const declared = declaredColumns(table);
  return (db.query(`PRAGMA table_info(${q(table.name)})`).all() as { name: string }[]).map((c) => c.name).filter((c) => !declared.has(c));
}

/**
 * What a row holds in the columns the schema does not declare, as stored: a
 * removal's inverse keeps it, so an undo puts the row back whole (the ledger
 * keeps rows as stored; only what delta sends is the declared columns).
 */
export function undeclaredOf(db: any, table: ResolvedTable, id: string | number): Record<string, unknown> | undefined {
  const others = undeclaredColumns(db, table);
  if (others.length === 0) return undefined;
  return db.query(`SELECT ${others.map(q).join(", ")} FROM ${current(table)} WHERE id = ?`).get(id) ?? undefined;
}

/**
 * The next version of a temporal row keeps what the version it closes held in
 * a column the schema does not declare (a later version's): this one writes
 * only what it declares, and another column keeps what it held, as an UPDATE of
 * a plain row leaves it -- so a version running blind to a column does not
 * blank it (expand/contract: reference/migrations.md).
 */
export function carryUndeclared(db: any, table: ResolvedTable, id: string | number, ts: string): void {
  const others = undeclaredColumns(db, table);
  if (others.length === 0) return;
  const cols = others.map(q).join(", ");
  db.run(`UPDATE ${q(table.name)} SET (${cols}) = (SELECT ${cols} FROM ${q(table.name)} WHERE id = ?1 AND valid_to = ?2) WHERE id = ?1 AND valid_from = ?2`, [id, ts]);
}

/** An error the writer is answered with: `code` is its wire code. */
export function refuse(code: number, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** SQLite's own error, with the fix when the fix is a call the app left out. */
export function named(err: any): any {
  if (typeof err?.message === "string" && /no such table/.test(err.message) && !/createTables/.test(err.message)) {
    err.message += " -- call createTables(db, schema) before the first open";
  }
  return err;
}

/** What a column a row's value leaves out holds: its default, or null, as an add or a replace of the row gives it. */
export function leftOut(colDef: ColumnDef): unknown {
  return colDef.default ?? (colDef.nullable ? null : defaultForType(colDef.type));
}

export function insertCollectionRow(
  db: any,
  schema: Schema,
  table: ResolvedTable,
  id: string | number,
  rootId: string | number | undefined,
  def: DocDef,
  row: Record<string, unknown>,
  ts: string,
  list = false,
): any {
  const fullRow: any = { id, ...row };
  fullRow.id = id;   // the path names the row, whatever the value says

  // A single-mode document's direct child hangs from its root; any other row
  // names its parent (a grandchild, a list-mode document's rows), as on Postgres.
  if (table.parent) {
    if (!list && table.parent.collection === def.root) {
      fullRow[table.parent.fkColumn] = rootId;
    } else if (fullRow[table.parent.fkColumn] != null) {
      fullRow[table.parent.fkColumn] = rowId(fullRow[table.parent.fkColumn] as string | number);
    }
  }

  for (const [col, colDef] of Object.entries(table.columns)) if (fullRow[col] === undefined) fullRow[col] = leftOut(colDef);

  // A version this write made and took back (added, then removed) never was
  // outside it: an add of the same id again takes its place.
  if (table.temporal) db.run(`DELETE FROM ${q(table.name)} WHERE id = ? AND valid_from = ? AND valid_to = ?`, [id, ts, ts]);
  insertRow(db, table, fullRow, ts);

  // The row read back, as Postgres's RETURNING gives it: as it is kept (a
  // scope's "10" in a text column is "10"), its columns in the table's order --
  // so a row told of an add, the ledger's entry, and the same row read again
  // (by an undo's guard and inverse, a redo, a reopen) are the same row, keys,
  // values and all.
  const read = db.query(`SELECT ${columnsOf(table)} FROM ${current(table)} WHERE id = ?`).get(id);
  decodeRow(table, read);
  return read;
}

/**
 * Overwrite a row in place: a non-temporal row, or the live version of a
 * temporal one that the write going on made (one version per write).
 *
 * A temporal row is otherwise updated by closing the old version and inserting a new one
 * — the composite `(id, valid_from)` key keeps both. A non-temporal table has
 * `id` as its whole primary key, so that same insert collides: replaces against
 * one used to fail with `UNIQUE constraint failed`, making non-temporal rows
 * unupdatable. UPDATE rather than DELETE+INSERT (which is what the Postgres
 * backend does) so the row is never briefly absent.
 */
export function updateRow(db: any, table: ResolvedTable, id: string | number, row: any) {
  const cols: string[] = [];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (cols.length === 0) return;

  const sets = cols.map((c) => `${q(c)} = ?`).join(", ");
  const vals = cols.map((c) => encodeValue(table, c, row[c]));
  // a temporal table's live version alone: the one a write made, rewritten as the write goes on
  db.run(`UPDATE ${q(table.name)} SET ${sets} WHERE id = ?${table.temporal ? " AND valid_to IS NULL" : ""}`, [...vals, id]);
}

// ---------------------------------------------------------------------------
// Field codecs
// ---------------------------------------------------------------------------

export function encodeValue(table: ResolvedTable, col: string, value: unknown): any {
  const def = table.columns[col];
  if (!def) return value ?? null;

  // Every json value is stored as JSON, strings included: a string stored raw
  // came back from a cold read parsed ("123" as 123, "true" as true).
  if (def.type === "json" && value != null) {
    return JSON.stringify(value);
  }
  if (def.type === "boolean") {
    return value == null ? null : (value ? 1 : 0);
  }
  // a time kept as Postgres gives it back, in UTC, so the same document reads alike on both
  if (def.type === "timestamptz") return utcTime(value) ?? null;
  return value ?? null;
}

export function decodeRow(table: ResolvedTable, row: any) {
  // A temporal row's validity is storage, not data: a document holds the row as it is, as Postgres gives it.
  if (table.temporal) { delete row.valid_from; delete row.valid_to; }
  for (const [col, def] of Object.entries(table.columns)) {
    if (def.type === "json" && typeof row[col] === "string") {
      try { row[col] = JSON.parse(row[col]); } catch { /* a string an earlier release stored raw: keep it */ }
    }
    if (def.type === "boolean" && row[col] != null) {
      row[col] = !!row[col];
    }
    if (def.type === "timestamptz" && row[col] != null) row[col] = utcTime(row[col]);   // one kept before in another form
  }
}
