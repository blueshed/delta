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
 */
import { splitPath, type DeltaOp } from "../core";

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
 */
export function planWalk(entry: { ops: DeltaOp[]; inverse: DeltaOp[] }, current: any): { ops: DeltaOp[]; conflict: string[] } {
  const left = new Map<string, any>();   // what the entry left at a path (undefined: it removed it)
  for (const op of entry.ops) left.set(op.path, op.op === "remove" ? undefined : op.value);
  const before = new Map<string, any>(); // what a path held before the entry (undefined: nothing), in the inverse's order
  for (const inv of entry.inverse) {
    const was = inv.op === "remove" ? undefined : inv.value;
    if (!before.has(inv.path) || was != null) before.set(inv.path, was);
  }
  const now = (path: string) => {
    const [coll, id] = splitPath(path);
    return id === undefined ? current?.[coll!] : current?.[coll!]?.[id];
  };
  const data = (row: any) => Object.keys(row ?? {}).filter((f) => !STORAGE.has(f));
  const ops: DeltaOp[] = [];
  const conflict: string[] = [];
  for (const [path, was] of before) {
    const here = now(path);
    const wrote = left.get(path);
    if (was == null && wrote == null) continue;       // made and removed by the entry: nothing to walk
    if (was == null) {                                // it made the row
      if (here == null || data(wrote).some((f) => !same(here[f], wrote[f]))) conflict.push(path);
      else ops.push({ op: "remove", path });
    } else if (wrote == null) {                       // it removed the row
      if (here != null) conflict.push(path);
      else ops.push({ op: "add", path, value: was });
    } else {                                          // it changed the row's fields
      const fields = [...new Set([...data(was), ...data(wrote)])].filter((f) => !same(was[f], wrote[f]));
      if (fields.length === 0) continue;
      if (here == null || fields.some((f) => !same(here[f], wrote[f]))) conflict.push(path);
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
