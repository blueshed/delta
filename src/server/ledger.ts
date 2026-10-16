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
 * - The entry changed a row's fields (`replace`): set back those fields, one
 *   replace of each (`/<coll>/<id>/<field>`), if each still holds what the entry wrote.
 * - The entry made a row (`remove` walks it): take the row away, if it is as
 *   the entry left it, and nobody has put a row under it since: `under` names
 *   the rows its removal would take with it, each of which the entry must have
 *   made too.
 * - The entry removed a row (`add` walks it): put it back, if nobody has.
 *
 * Each row is walked once, from what it was before the entry to what the entry
 * left: every inverse op of a path carries the same "before" (an `add` or
 * `replace` its value; a `remove` none, there was no row), so a row the entry
 * touched twice (made and changed, changed and removed) is walked by its net
 * change. Any guard that fails is a conflict, by path, and then nothing is walked.
 * A row a removal planned before it takes with it (`under`) is left to that removal.
 *
 * A single document's root is one row at two paths: `/<root>` (a replace of it)
 * and `/<root>/<id>` (its add, its remove). Both are keyed by the second, the
 * id read from the row, so the root is walked once, by its net change, however
 * the entry spelled it -- removed, added back and written is one row, not a
 * conflict with itself. A replace of the root is planned at `/<root>/<field>`, as every
 * backend takes it; an add or a remove at `/<root>/<id>`. Postgres's
 * `_delta_walk_plan` (001g) keys it the same.
 */
export function planWalk(entry: { ops: DeltaOp[]; inverse: DeltaOp[] }, current: any, under: (key: string) => string[] = () => []): { ops: DeltaOp[]; conflict: string[] } {
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
      const others = () => under(key).some((row) => before.get(row) != null || left.get(row) == null);
      if (here == null || data(wrote).some((f) => !same(here[f], wrote[f])) || others()) conflict.push(at);
      else ops.push({ op: "remove", path: key });
    } else if (wrote == null) {                       // it removed the row
      if (here != null) conflict.push(at);
      else ops.push({ op: "add", path: key, value: was });
    } else {                                          // it changed the row's fields
      const fields = [...new Set([...data(was), ...data(wrote)])].filter((f) => !same(was[f], wrote[f])).toSorted();
      if (fields.length === 0) continue;
      // the document's root is replaced at /<root>, however the entry spelled it
      const path = here != null && here === current?.[coll!] ? joinPath(coll!) : key;
      if (here == null || fields.some((f) => !same(here[f], wrote[f]))) conflict.push(at);
      else ops.push(...fields.map((f): DeltaOp => ({ op: "replace", path: path + joinPath(f), value: was[f] ?? null })));   // each field: a replace of the row is the row whole (todo #3)
    }
  }
  if (conflict.length) return { ops: [], conflict };
  // a row the removal of one before it takes with it is taken by that removal: removed again
  // after it, it would not be there -- a favour, a wedding's and a household's
  const taken = new Set<string>();
  return {
    ops: ops.filter((op) => {
      if (op.op !== "remove") return true;
      if (taken.has(op.path)) return false;
      for (const row of under(op.path)) taken.add(row);
      return true;
    }),
    conflict,
  };
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
  const versionStmt = db.query(
    "SELECT MAX(COALESCE((SELECT version FROM delta_versions WHERE doc = ?1), 0), COALESCE((SELECT MAX(version) FROM delta_ledger WHERE doc = ?1), 0)) AS version",
  );
  const setVersionStmt = db.query("INSERT INTO delta_versions (doc, version) VALUES (?, ?) ON CONFLICT (doc) DO UPDATE SET version = excluded.version");
  const insertStmt = db.query(
    "INSERT INTO delta_ledger (doc, version, ops, inverse, who, cursor, at, undoes, undoable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // newest first, by version then id: an undo that walked nothing shares the version of the write before it
  const historyStmt = db.query(`SELECT ${columns}, l.cursor FROM delta_ledger l WHERE l.doc = ? ORDER BY l.version DESC, l.id DESC LIMIT ?`);
  // The cursor's entries newest first, a step at a time: the cursor's index is (cursor, id),
  // id being the rowid, so each step reads one entry.
  const olderStmt = db.query(`SELECT ${columns}, l.cursor, l.undoes FROM delta_ledger l WHERE l.cursor = ?1 AND l.id < ?2 ORDER BY l.id DESC LIMIT 1`);
  const walkedStmt = db.query("SELECT 1 FROM delta_ledger WHERE undoes = ? LIMIT 1");
  const upStmt = db.query("SELECT cursor, undoes, undoable FROM delta_ledger WHERE id = ?");
  type Step = Row & { undoes: number | null };
  /**
   * The entry an undo (`back`) or a redo of a cursor takes: the newest tip of the cursor's chains
   * that goes the way asked -- back, a tip at an even depth (a write, or a redo); forward, one at an
   * odd depth (an undo that changed something) newer than the cursor's last write. Found newest
   * first among the cursor's own entries, so it costs what was written since the answer, not the
   * cursor's whole history: every entry of a chain carries its write's cursor, as a walk records it.
   */
  const tip = (cursor: string, back: boolean): LedgerEntry | undefined => {
    for (let entry = olderStmt.get(cursor, Number.MAX_SAFE_INTEGER) as Step | null; entry; entry = olderStmt.get(cursor, entry.id) as Step | null) {
      // the cursor's last write, met newest first: a redo is of nothing older (a fresh write ends what could be redone)
      if (!back && entry.undoes === null && entry.undoable === 1) return undefined;
      if (walkedStmt.get(entry.id)) continue;   // not a tip: something has walked it
      // its depth along its chain, up to the write that began it
      let depth = 0;
      let up: Pick<Step, "cursor" | "undoes" | "undoable"> = entry;
      while (up.undoes !== null) {
        up = upStmt.get(up.undoes);
        depth++;
      }
      if (up.cursor !== cursor || up.undoable !== 1) continue;   // a chain this cursor's undoable write began
      if (back ? depth % 2 === 0 : depth % 2 === 1 && entry.undoable === 1) return toEntry(entry);   // a walk recorded as changing nothing is never redone
    }
    return undefined;
  };
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
    nextUndo: (cursor) => tip(cursor, true),
    nextRedo: (cursor) => tip(cursor, false),
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
 * on this connection, whoever else learns the id. A socket that chose an id a live socket holds
 * (`connectWs(url, { clientId })`) has a fresh one until the holder closes (`createWs` then
 * gives it the id); signed in, it has the chosen id's cursor at once, since the person is in
 * it: the same person's, never another's.
 */
export function socketCursor(who: string | null, client: any): string | null {
  const clientId: string | undefined = (who === null ? undefined : client?.data?.chosenId) ?? client?.data?.clientId;
  if (!clientId) return null;
  return who === null ? clientId : JSON.stringify([who, clientId]);
}

/** How an identity is written in the ledger: by `who`, else a string or number as it is and anything else as JSON; none, null. */
export function ledgerWho<I>(identity: I | undefined, who?: (identity: I) => string): string | null {
  if (identity === undefined || identity === null) return null;
  if (who) return who(identity);
  return typeof identity === "string" || typeof identity === "number" ? String(identity) : JSON.stringify(identity);
}

/** An entry's id, as a walk names a change by it: a whole number from 1. */
export const isEntryId = (id: unknown): id is number => Number.isSafeInteger(id) && (id as number) > 0;
