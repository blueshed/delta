/**
 * The ledger — every write to a document, with its inverse, kept in the same
 * transaction as the write (SQLite backend).
 *
 * An entry records what was applied and what would take it back, the
 * document's version it made, and two things about the writer that are not
 * the same:
 *
 * - `who`: the identity that made the change (the auth module's identity,
 *   stringified) — for the audit.
 * - `cursor`: the key undo walks, opaque to delta. An in-process caller names
 *   it (eta passes its session: undo takes back what this session did); over
 *   the socket it is the connection itself, so nobody can walk another's.
 *
 * Undo and redo are one cursor over a cursor's entries. An entry's `undoes`
 * links it to the entry it walked back, so entries form chains: a write, its
 * undo, the redo of that, and so on. Depth along a chain says which way an
 * entry went (even: forward, a write or a redo; odd: back, an undo), and the
 * entry at the end of a chain — the tip, nothing has walked it yet — is the one
 * that counts. A fresh write ends what could be redone. A write recorded as not
 * undoable (a fact: a price tick) starts no chain and ends no redo.
 *
 * A walk sets back only what its entry changed, and only where the document
 * still holds what the entry left (`planWalk`): a field someone else has
 * written since is a conflict, and a walk with a conflict changes nothing. It
 * is still recorded (`skip`: no ops, not walkable), so the cursor moves on to
 * the entry before it instead of meeting the same conflict for ever.
 *
 * A change is one chain: a write and every walk of it. A walk may name one
 * (`changeTip`, by any entry of its chain) in place of the cursor's next: two
 * writers on one cursor -- a person and an assistant in one browser -- each
 * undo their own. It is the cursor's own change or none, walked by the same
 * guard; but a conflict records nothing, since no cursor has to move past it.
 */
import { joinPath, splitPath, type DeltaOp } from "../core";

export type LedgerEntry = {
  id: number;
  doc: string;
  version: number;
  ops: DeltaOp[];
  inverse: DeltaOp[];
  at: number;
  undoable: boolean;
};

export type Ledger = {
  /** Records a write; returns its version and entry id. An empty write records nothing and keeps the version. */
  record(entry: { doc: string; ops: DeltaOp[]; inverse: DeltaOp[]; who: string | null; cursor: string | null; undoes?: number; undoable?: boolean }): { version: number; entry?: number };
  version(doc: string): number;
  /**
   * A document told of a change written through another document: its next
   * version, with no entry of its own (nothing to undo through it), so its
   * readers see its changes in order and notice one they missed.
   */
  bump(doc: string): number;
  /** The newest entries for a document, newest first, each saying whether `cursor` wrote it — never who did. */
  history(doc: string, cursor: string | null, limit?: number): (LedgerEntry & { mine: boolean })[];
  /** The write this cursor would walk back next. */
  nextUndo(cursor: string): LedgerEntry | undefined;
  /** The undo this cursor would walk forward again, unless a fresh write has come since. */
  nextRedo(cursor: string): LedgerEntry | undefined;
  /**
   * The entry a walk of one change would take (`back`: an undo, else a redo): the tip of the chain
   * that holds entry `change`, named by any entry of it -- its write, an undo, a redo. Back if the
   * change stands, forward if it was undone (by a walk that changed something), else undefined.
   * Null when the chain is no change of this cursor's: another's, a fact, none.
   */
  changeTip(cursor: string, change: number, back: boolean): LedgerEntry | undefined | null;
  /** Records that `undoes` was walked and changed nothing (a conflict): the cursor moves past it, and it is never redone. */
  skip(entry: { doc: string; who: string | null; cursor: string | null; undoes: number }): { version: number; entry: number };
};

/** Storage columns of a temporal row: not data, never a conflict. */
const STORAGE = new Set(["valid_from", "valid_to"]);

/** Deep equality of JSON values, with null and a missing value the same. */
function same(a: unknown, b: unknown): boolean {
  if (a === b || (a == null && b == null)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  return ka.length === Object.keys(b as object).length && ka.every((k) => same((a as any)[k], (b as any)[k]));
}

/**
 * The row a document holds at a row's path: `/<coll>/<id>` in a map, `/<coll>`
 * its root -- and, in a single document, `/<root>/<id>`, the root named by its
 * id, as a write that adds or removes the root tells it. Postgres's
 * `_delta_row_at` (001g).
 */
export function rowAt(doc: any, path: string): any {
  const [coll, id] = splitPath(path);
  const held = doc?.[coll!];
  if (id === undefined) return held;
  if (held?.[id] != null) return held[id];
  const own = held?.id;
  return (typeof own === "number" || typeof own === "string") && String(own) === id ? held : undefined;
}

/**
 * What walking `entry` does to the document as it is now (`current`): only the
 * fields the entry changed, each guarded by what the entry left there.
 *
 * - The entry changed a row's fields (`replace`): set back those fields, if
 *   each still holds what the entry wrote.
 * - The entry made a row (`remove` walks it): take the row away, if it is as
 *   the entry left it.
 * - The entry removed a row (`add` walks it): put it back, if nobody has.
 *
 * Each row is walked once, from what it was before the entry to what the entry
 * left: every inverse op of a path carries the same "before" (an `add` or
 * `replace` its value; a `remove` none, there was no row), so a row the entry
 * touched twice (made and changed, changed and removed) is walked by its net
 * change. Any guard that fails is a conflict, by path, and then nothing is walked.
 *
 * A single document's root is one row at two paths: `/<root>` (a replace of it)
 * and `/<root>/<id>` (its add, its remove). Both are keyed by the second, the
 * id read from the row, so the root is walked once, by its net change, however
 * the entry spelled it -- removed, added back and written is one row, not a
 * conflict with itself. A replace of the root is planned at `/<root>`, as every
 * backend takes it; an add or a remove at `/<root>/<id>`. Postgres's
 * `_delta_walk_plan` (001g) keys it the same.
 */
export function planWalk(entry: { ops: DeltaOp[]; inverse: DeltaOp[] }, current: any): { ops: DeltaOp[]; conflict: string[] } {
  // a row's key: its path, and a root at /<root> by /<root>/<id> -- its id from the row, or from the document
  const keyOf = (path: string, value?: any): string => {
    const [coll, id] = splitPath(path);
    if (id !== undefined) return path;
    const own = value?.id ?? current?.[coll!]?.id;
    return typeof own === "number" || typeof own === "string" ? joinPath(coll!, String(own)) : path;
  };
  const left = new Map<string, any>();   // what the entry left at a row (undefined: it removed it)
  for (const op of entry.ops) left.set(keyOf(op.path, (op as any).value), op.op === "remove" ? undefined : (op as any).value);
  const before = new Map<string, any>(); // what a row held before the entry (undefined: nothing), in the inverse's order
  const shown = new Map<string, string>(); // a row's path as the inverse first says it: where a conflict is reported
  for (const inv of entry.inverse) {
    const was = inv.op === "remove" ? undefined : inv.value;
    const key = keyOf(inv.path, was);
    if (!shown.has(key)) shown.set(key, inv.path);
    if (!before.has(key) || was != null) before.set(key, was);
  }
  const data = (row: any) => Object.keys(row ?? {}).filter((f) => !STORAGE.has(f));
  const ops: DeltaOp[] = [];
  const conflict: string[] = [];
  for (const [key, was] of before) {
    const here = rowAt(current, key);
    const wrote = left.get(key);
    const [coll] = splitPath(key);
    const at = shown.get(key)!;
    if (was == null && wrote == null) continue;       // made and removed by the entry: nothing to walk
    if (was == null) {                                // it made the row
      if (here == null || data(wrote).some((f) => !same(here[f], wrote[f]))) conflict.push(at);
      else ops.push({ op: "remove", path: key });
    } else if (wrote == null) {                       // it removed the row
      if (here != null) conflict.push(at);
      else ops.push({ op: "add", path: key, value: was });
    } else {                                          // it changed the row's fields
      const fields = [...new Set([...data(was), ...data(wrote)])].filter((f) => !same(was[f], wrote[f]));
      if (fields.length === 0) continue;
      // the document's root is replaced at /<root>, however the entry spelled it
      const path = here != null && here === current?.[coll!] ? joinPath(coll!) : key;
      if (here == null || fields.some((f) => !same(here[f], wrote[f]))) conflict.push(at);
      else ops.push({ op: "replace", path, value: Object.fromEntries(fields.map((f) => [f, was[f] ?? null])) });
    }
  }
  return conflict.length ? { ops: [], conflict } : { ops, conflict };
}

type Row = { id: number; doc: string; version: number; ops: string; inverse: string; at: number; undoable: number; cursor?: string | null };

const toEntry = (r: Row): LedgerEntry => ({
  id: r.id,
  doc: r.doc,
  version: r.version,
  ops: JSON.parse(r.ops),
  inverse: JSON.parse(r.inverse),
  at: r.at,
  undoable: r.undoable === 1,
});

/** Creates the ledger's table (if it is not there) and returns its operations. */
export function createLedger(db: any): Ledger {
  db.run(`CREATE TABLE IF NOT EXISTS delta_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc TEXT NOT NULL,
    version INTEGER NOT NULL,
    ops TEXT NOT NULL,
    inverse TEXT NOT NULL,
    who TEXT,
    cursor TEXT,
    at INTEGER NOT NULL,
    undoes INTEGER,
    undoable INTEGER NOT NULL DEFAULT 1
  )`);
  db.run("CREATE INDEX IF NOT EXISTS idx_delta_ledger_doc ON delta_ledger (doc, version)");
  // Each document's version: advanced by a write through it (with an entry) and by a change told to it (without one).
  db.run("CREATE TABLE IF NOT EXISTS delta_versions (doc TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  db.run("CREATE INDEX IF NOT EXISTS idx_delta_ledger_cursor ON delta_ledger (cursor)");
  // The walk up a cursor's chains follows `undoes`: without this, each step scanned the table.
  db.run("CREATE INDEX IF NOT EXISTS idx_delta_ledger_undoes ON delta_ledger (undoes)");

  const columns = "l.id, l.doc, l.version, l.ops, l.inverse, l.at, l.undoable";
  const tips = `
    WITH RECURSIVE chain(id, depth) AS (
      SELECT id, 0 FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1
      UNION ALL
      SELECT l.id, c.depth + 1 FROM delta_ledger l JOIN chain c ON l.undoes = c.id
    ),
    tips AS (
      SELECT c.id, c.depth FROM chain c WHERE NOT EXISTS (SELECT 1 FROM delta_ledger w WHERE w.undoes = c.id)
    )`;
  const versionStmt = db.query(
    "SELECT MAX(COALESCE((SELECT version FROM delta_versions WHERE doc = ?1), 0), COALESCE((SELECT MAX(version) FROM delta_ledger WHERE doc = ?1), 0)) AS version",
  );
  const setVersionStmt = db.query("INSERT INTO delta_versions (doc, version) VALUES (?, ?) ON CONFLICT (doc) DO UPDATE SET version = excluded.version");
  const insertStmt = db.query(
    "INSERT INTO delta_ledger (doc, version, ops, inverse, who, cursor, at, undoes, undoable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const historyStmt = db.query(`SELECT ${columns}, l.cursor FROM delta_ledger l WHERE l.doc = ? ORDER BY l.version DESC LIMIT ?`);
  // CROSS JOIN keeps SQLite's join order: the cursor's tips first, then each row
  // by its key. Joined the other way it scanned every row of the ledger.
  const undoStmt = db.query(`${tips}
    SELECT ${columns} FROM tips t CROSS JOIN delta_ledger l ON l.id = t.id
    WHERE t.depth % 2 = 0 ORDER BY l.id DESC LIMIT 1`);
  const redoStmt = db.query(`${tips}
    SELECT ${columns} FROM tips t CROSS JOIN delta_ledger l ON l.id = t.id
    WHERE t.depth % 2 = 1 AND l.undoable = 1
      AND l.id > COALESCE((SELECT MAX(id) FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1), 0)
    ORDER BY l.id DESC LIMIT 1`);
  // Up the chain from the entry named to its write, which must be the cursor's own and undoable;
  // then down it to its tip, the one entry nothing has walked.
  const changeTipStmt = db.query(`
    WITH RECURSIVE up(id, undoes) AS (
      SELECT id, undoes FROM delta_ledger WHERE id = ?2
      UNION ALL
      SELECT l.id, l.undoes FROM delta_ledger l JOIN up u ON l.id = u.undoes
    ),
    chain(id, depth) AS (
      SELECT l.id, 0 FROM up u CROSS JOIN delta_ledger l ON l.id = u.id
      WHERE u.undoes IS NULL AND l.cursor = ?1 AND l.undoable = 1
      UNION ALL
      SELECT l.id, c.depth + 1 FROM delta_ledger l JOIN chain c ON l.undoes = c.id
    )
    SELECT ${columns}, c.depth FROM chain c CROSS JOIN delta_ledger l ON l.id = c.id ORDER BY c.depth DESC LIMIT 1`);

  const version = (doc: string): number => (versionStmt.get(doc) as { version: number | null } | null)?.version ?? 0;

  return {
    version,
    record({ doc, ops, inverse, who, cursor, undoes, undoable = true }) {
      if (ops.length === 0) return { version: version(doc) };
      const next = version(doc) + 1;
      const result = insertStmt.run(doc, next, JSON.stringify(ops), JSON.stringify(inverse), who, cursor, Date.now(), undoes ?? null, undoable ? 1 : 0);
      setVersionStmt.run(doc, next);
      return { version: next, entry: Number(result.lastInsertRowid) };
    },
    bump(doc) {
      const next = version(doc) + 1;
      setVersionStmt.run(doc, next);
      return next;
    },
    history(doc, cursor, limit = 50) {
      return (historyStmt.all(doc, limit) as Row[]).map((r) => ({ ...toEntry(r), mine: cursor !== null && r.cursor === cursor }));
    },
    nextUndo(cursor) {
      const row = undoStmt.get(cursor) as Row | null;
      return row ? toEntry(row) : undefined;
    },
    nextRedo(cursor) {
      const row = redoStmt.get(cursor) as Row | null;
      return row ? toEntry(row) : undefined;
    },
    changeTip(cursor, change, back) {
      const tip = changeTipStmt.get(cursor, change) as (Row & { depth: number }) | null;
      if (!tip) return null;
      // the same rule as the cursor's own walk: back from a write or a redo; forward from an undo that changed something
      return (back ? tip.depth % 2 === 0 : tip.depth % 2 === 1 && tip.undoable === 1) ? toEntry(tip) : undefined;
    },
    skip({ doc, who, cursor, undoes }) {
      const v = version(doc);
      const result = insertStmt.run(doc, v, "[]", "[]", who, cursor, Date.now(), undoes, 0);
      return { version: v, entry: Number(result.lastInsertRowid) };
    },
  };
}

/**
 * The cursor of a socket connection: the connection id alone for someone not signed in, and the
 * person with it for someone who is -- so undo over a socket walks only what this person wrote
 * on this connection, whoever else learns the id.
 */
export function socketCursor(who: string | null, clientId: string | undefined): string | null {
  if (!clientId) return null;
  return who === null ? clientId : JSON.stringify([who, clientId]);
}

/** An entry's id, as a walk names a change by it: a whole number from 1. */
export const isEntryId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;
