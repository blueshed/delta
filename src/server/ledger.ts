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
 */
import type { DeltaOp } from "../core";

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
  /** The newest entries for a document, newest first, each saying whether `cursor` wrote it — never who did. */
  history(doc: string, cursor: string | null, limit?: number): (LedgerEntry & { mine: boolean })[];
  /** The write this cursor would walk back next. */
  nextUndo(cursor: string): LedgerEntry | undefined;
  /** The undo this cursor would walk forward again, unless a fresh write has come since. */
  nextRedo(cursor: string): LedgerEntry | undefined;
};

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
  db.run("CREATE INDEX IF NOT EXISTS idx_delta_ledger_cursor ON delta_ledger (cursor)");

  const columns = "l.id, l.doc, l.version, l.ops, l.inverse, l.at, l.undoable";
  const tips = `
    WITH RECURSIVE chain(id, depth) AS (
      SELECT id, 0 FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1
      UNION ALL
      SELECT l.id, c.depth + 1 FROM delta_ledger l JOIN chain c ON l.undoes = c.id
    ),
    tips AS (
      SELECT c.id, c.depth FROM chain c WHERE c.id NOT IN (SELECT undoes FROM delta_ledger WHERE undoes IS NOT NULL)
    )`;
  const versionStmt = db.query("SELECT MAX(version) AS version FROM delta_ledger WHERE doc = ?");
  const insertStmt = db.query(
    "INSERT INTO delta_ledger (doc, version, ops, inverse, who, cursor, at, undoes, undoable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const historyStmt = db.query(`SELECT ${columns}, l.cursor FROM delta_ledger l WHERE l.doc = ? ORDER BY l.version DESC LIMIT ?`);
  const undoStmt = db.query(`${tips}
    SELECT ${columns} FROM delta_ledger l JOIN tips t ON t.id = l.id
    WHERE t.depth % 2 = 0 ORDER BY l.id DESC LIMIT 1`);
  const redoStmt = db.query(`${tips}
    SELECT ${columns} FROM delta_ledger l JOIN tips t ON t.id = l.id
    WHERE t.depth % 2 = 1
      AND l.id > COALESCE((SELECT MAX(id) FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1), 0)
    ORDER BY l.id DESC LIMIT 1`);

  const version = (doc: string): number => (versionStmt.get(doc) as { version: number | null } | null)?.version ?? 0;

  return {
    version,
    record({ doc, ops, inverse, who, cursor, undoes, undoable = true }) {
      if (ops.length === 0) return { version: version(doc) };
      const next = version(doc) + 1;
      const result = insertStmt.run(doc, next, JSON.stringify(ops), JSON.stringify(inverse), who, cursor, Date.now(), undoes ?? null, undoable ? 1 : 0);
      return { version: next, entry: Number(result.lastInsertRowid) };
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
