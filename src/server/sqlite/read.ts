/** A document read from the tables: as they stand (open) or as they stood (open_at), and the times a snapshot names. */
import { q, type DocDef, type ResolvedTable, type Schema } from "../../schema";
import { toMap } from "../custom";
import { resolveScope, whereOf, type Scope } from "../scope";
import { keeping } from "./keep";
import { columnsOf, current, decodeRow, now, sqliteTime } from "./rows";

/** Load a doc as it existed at a specific point in time (`at`: ISO-8601, or SQLite's own form). */
export function loadDocAt(db: any, schema: Schema, def: DocDef, docId: string, at: string): any | null {
  return readDoc(db, schema, def, resolveScope(def, docId), sqliteTime(at));
}

/**
 * A document as its scope reads it from the tables -- as they stand, or as they
 * stood at `at` (SQLite's own time form; by default, the time in its name, `at:`): single mode, one root row and its
 * children; list mode, every root row the scope admits and each included
 * collection in full -- as Postgres's `delta_open` and `delta_open_at` read it.
 */
export function readDoc(db: any, schema: Schema, def: DocDef, scope: Scope, at = scope.at === undefined ? undefined : sqliteTime(scope.at)): any | null {
  const rootTable = schema.tables[def.root];
  if (!rootTable) return null;
  const where = whereOf(scope, keeping(db, rootTable));
  const rows = readRows(db, rootTable, where.sql, where.params as any[], at);
  const list = scope.mode === "list";
  if (!list && rows.length === 0) return null;
  if (!list && rows.length > 1) {
    // A single-mode doc exposes exactly one root row. A scope that matches
    // several (e.g. a non-unique column) silently drops all but the first
    // here AND only loads the first row's children — surface it.
    console.warn(
      `[delta-sqlite] scope for doc root "${def.root}" matched ${rows.length} rows; using the first only. A single-mode doc's scope must match at most one row.`,
    );
  }
  const doc: any = { [def.root]: list ? toMap(rows) : rows[0] };
  for (const collKey of def.include) {
    const table = schema.tables[collKey];
    if (table) doc[collKey] = toMap(list ? readRows(db, table, "1 = 1", [], at) : readCollection(db, schema, table, def, rows[0].id, at));
  }
  return doc;
}

/** A table's rows `where` says, as a document holds them: as they stand, or the versions live at `at`. */
function readRows(db: any, table: ResolvedTable, where: string, params: any[], at?: string): any[] {
  const rows = table.temporal && at !== undefined
    ? db.query(`SELECT ${columnsOf(table)} FROM ${q(table.name)} WHERE ${where} AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`).all(...params, at, at)
    : db.query(`SELECT ${columnsOf(table)} FROM ${current(table)} WHERE ${where}`).all(...params);
  for (const row of rows) decodeRow(table, row);
  return rows;
}

/** A single document's rows of `table`, under its root row `rootId`, walking up the parent keys to it. */
function readCollection(db: any, schema: Schema, table: ResolvedTable, def: DocDef, rootId: unknown, at?: string): any[] {
  // No parent: no key ties a row of it to one document. Included, it is
  // loaded in full, as the Postgres backend loads it: every document of the
  // prefix holds every row, and the fan-out (holds) says the same.
  if (!table.parent) return readRows(db, table, "1 = 1", [], at);
  const fk = q(table.parent.fkColumn);
  if (table.parent.collection === def.root) return readRows(db, table, `${fk} = ?`, [rootId], at);
  // Grandchild: its parent rows first, then the rows under them. A parent the
  // document need not include: its rows are walked all the same. One with no
  // parent of its own ends the chain short of the root, so nothing under it is
  // in the document, as the fan-out's chainRoot (and Postgres's
  // _delta_load_collection) judge it (todo #32).
  const parentTable = schema.tables[table.parent.collection];
  if (!parentTable?.parent) return [];
  const ids = readCollection(db, schema, parentTable, def, rootId, at).map((r: any) => r.id);
  return ids.length ? readRows(db, table, `${fk} IN (${ids.map(() => "?").join(", ")})`, ids, at) : [];
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Create a named snapshot at the current time. */
export function createSnapshot(db: any, name: string, at?: string) {
  db.run("CREATE TABLE IF NOT EXISTS _snapshots (name TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
  const ts = at ?? now();
  db.run("INSERT OR REPLACE INTO _snapshots (name, created_at) VALUES (?, ?)", [name, ts]);
  return ts;
}

/** Resolve a snapshot name to its timestamp. */
export function resolveSnapshot(db: any, name: string): string | null {
  db.run("CREATE TABLE IF NOT EXISTS _snapshots (name TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
  const row = db.query("SELECT created_at FROM _snapshots WHERE name = ?").get(name) as any;
  return row?.created_at ?? null;
}
