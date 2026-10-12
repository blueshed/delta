/**
 * Delta SQLite — relational backend for delta-doc.
 *
 * Backs delta-doc documents with SQLite temporal tables. The schema describes
 * tables and relationships once; doc definitions are lenses (views) into that
 * schema with optional scope filters.
 *
 * Usage:
 *   import { defineSchema, defineDoc, createTables, registerDocs } from "@blueshed/delta/sqlite";
 *
 *   const schema = defineSchema({ ... });
 *   const itineraryDoc = defineDoc("itinerary:", { root: "itineraries", include: [...] });
 *   createTables(db, schema);
 *   registerDocs(ws, db, schema, [itineraryDoc]);
 *
 * Client API is unchanged — openDoc("itinerary:abc") works identically whether
 * the backend is a JSON file or SQLite.
 */
import type { WsServer } from "./server";
import { trackSubscribe, trackUnsubscribe, onClientDrop, failure } from "./server";
import { authless, isAuthError, ownerless, type DeltaAuth } from "./auth";
import { assertOnePrefix, assertOwned, createCustomDocs, isPromise, NOT_FOUND, type CustomDoc } from "./custom";
import { type DeltaOp, splitPath, joinPath, changedFields } from "../core";
import { createLogger } from "./logger";
import { createLedger, isEntryId, ledgerWho, planWalk, rowAt, socketCursor } from "./ledger";
import { assertScopeKeys, meets, resolveScope, rowId, sameId, whereOf, type Scope } from "./scope";
import { defaultForType, holdsField, showDoc, showOps, showRow, utcTime, type DocDef, type ResolvedTable, type Schema } from "../schema";
import { waitForLocks } from "./sqlite/ddl";
import { keeping, scopeValue } from "./sqlite/keep";
import { loadDocAt, readDoc } from "./sqlite/read";
import { closeRow, current, decodeRow, insertCollectionRow, insertRow, leftOut, named, now, refuse, sqliteTime, updateRow } from "./sqlite/rows";
import { namesRootRow, validateOps } from "./sqlite/validate";

export type {
  ColumnType,
  ColumnDef,
  ColumnShorthand,
  TableDef,
  Schema,
  ResolvedTable,
  DocDef,
  ValidationError,
  Snapshot,
} from "../schema";
export { defineSchema, defineDoc } from "../schema";
export { createTables, migrateSchema } from "./sqlite/ddl";
export { validateOps } from "./sqlite/validate";
export { loadDocAt, createSnapshot, resolveSnapshot } from "./sqlite/read";
export { exportTables, importTables } from "./sqlite/carry";

// ---------------------------------------------------------------------------
// Custom doc definition — predicate-based membership over watched collections.
// ---------------------------------------------------------------------------

/**
 * A custom doc on SQLite (`./custom`): its reads take the `bun:sqlite` handle
 * and answer at once, no await. A membership `query` runs once per doc name
 * and identity (the gate's, with `auth`; undefined without), and its result is
 * kept for the subscribers of that name who are that identity -- never
 * another's, as on Postgres. SQLite has no RLS: check the rows against the
 * identity here. A `recompute` reads the WHOLE doc, on open and on any write
 * to a watched collection, and sends it to each subscriber as a root-replace
 * op -- for nested, joined or aggregated reads a per-row `matches` can't
 * express: read per subscriber, as that client's identity, never cached.
 */
export interface CustomDocDef<C = unknown, I = any> extends CustomDoc<C, I> {
  query?: (db: any, criteria: C, identity?: I) => Record<string, any[]>;
  recompute?: (db: any, criteria: C, identity?: I) => any;
}

export function defineCustomDoc<C, I = any>(prefix: string, opts: Omit<CustomDocDef<C, I>, "prefix">): CustomDocDef<C, I> {
  return { prefix, ...opts };
}

// ---------------------------------------------------------------------------
// registerDocs
// ---------------------------------------------------------------------------

const log = createLogger("[delta-sqlite]");

/**
 * The prefixes each `registerDocs` on a server answers, by registration. A
 * name is answered by the registration whose prefix matching it is longest --
 * as within one registration, and as on Postgres -- whichever registered
 * first: `fo-board` (a public registration) never answers `fo-board:1` beside
 * a registration of `fo-board:`. A prefix two registrations both claim would
 * leave the name to the order they registered in, so the second is refused.
 */
const registrations = new WeakMap<object, Map<symbol, string[]>>();

/**
 * One registration's open documents, as a write through any registration on
 * its database handle tells them (todo #64): every document open on the
 * database hears a write, whichever registration it was opened through -- as
 * every Postgres listener does.
 */
type Fanout = {
  /** The documents open here (and `writer`, the one written through) that hold `row` of `coll`. */
  holders(coll: string, row: any, writer?: string): string[];
  /** Of those, the implied single documents: they showed a root before its row was made. */
  showing(coll: string, row: any, writer?: string): string[];
  /** Tell the documents open here what a write through another registration changed. */
  announce(touched: Touched[], applied: DeltaOp[]): void;
};

/** The registrations over each database handle: a JSON file's registrations on a server share one. */
const fanoutsOn = new WeakMap<object, Set<Fanout>>();

/**
 * A row of a write, for the telling: who held it before -- on each registration
 * over the database -- and what it is now (null: gone); a replace's, what it was
 * (`was`), so a document that holds it either way is told only the fields that
 * changed. A `carried` row is one the write did not change but moved, under a
 * parent it moved: it is told only where it arrives or leaves (todo #62).
 */
type Touched = { coll: string; id: string | number; before: Map<Fanout, string[]>; after: any | null; was?: any; carried?: boolean };

/**
 * Claim `prefixes` on `ws` for one registration (refused if one comes twice, or
 * another registration holds one of them), and answer whether a document of
 * prefix length `mine` answers a name: whether no prefix on the server matching
 * it is longer -- another registration's, or this one's other kind (a custom
 * document's or a table document's).
 */
function claim(ws: object, prefixes: string[]): (docName: string, mine: number) => boolean {
  assertOnePrefix(prefixes);
  const registration = Symbol("registerDocs");
  const onServer = registrations.get(ws) ?? new Map<symbol, string[]>();
  for (const theirs of onServer.values()) {
    const both = prefixes.find((p) => theirs.includes(p));
    if (both !== undefined) throw new Error(`registerDocs: "${both}" is registered already on this server -- a name is answered by one registration: give each its own prefix`);
  }
  onServer.set(registration, prefixes);
  registrations.set(ws, onServer);
  return (docName, mine) => {
    for (const theirs of onServer.values()) if (theirs.some((p) => p.length > mine && docName.startsWith(p))) return false;
    return true;
  };
}

export interface RegisterOptions<I = unknown> {
  /**
   * Keep a ledger (`./ledger`): every write recorded with its inverse, its
   * version, who made it and the cursor undo walks; and `undo`, `redo` and
   * `history` actions over it.
   */
  ledger?: boolean;
  /** How an identity is written in the ledger. Default: a string or number as it is, anything else as JSON. */
  who?: (identity: I) => string;
  /** Called after every change that committed -- a write, an undo or redo, a walk recorded as skipped: the JSON file saves itself from it. */
  committed?: () => void;
  /**
   * An auth module (`DeltaAuth`), as the Postgres listener takes it: every
   * open, delta, open_at, history, undo, redo and close of these documents
   * passes `auth.gate(client)` first (401 without an identity), and the
   * identity it gives is who writes (the ledger's `who`, the cursor) and who a
   * custom document is read as. SQLite has no RLS: `owns` is the check.
   */
  auth?: DeltaAuth<I>;
  /**
   * With `auth`: may `identity` open `docName`, write through it and hear what
   * is written to it? False answers 404 -- asked before open, delta, open_at,
   * history, and an undo or redo of an entry written through the document, as
   * `docTypeFromDef`'s `owns`. With auth, this or `shared` is required.
   */
  owns?: (identity: I, docName: string) => boolean | Promise<boolean>;
  /** With `auth`: every identity that passes the gate may open every document registered here, and hear every write to it. */
  shared?: boolean;
}

/** Register all doc definitions with the WebSocket server. */
export function registerDocs<I = unknown>(
  ws: WsServer,
  db: any,
  schema: Schema,
  docs: DocDef[],
  customDocs: CustomDocDef<any, I>[] = [],
  options: RegisterOptions<I> = {},
) {
  for (const doc of docs) assertScopeKeys(doc, schema);
  // Default-deny, as docTypeFromDef and createDocListener are: with auth, every
  // document says who owns it, or that it is shared. A name is the channel its
  // writes are told on, so whoever has it open hears them.
  const auth = options.auth;
  if (auth) {
    if (docs.length && !options.owns && !options.shared) throw ownerless(docs.map((d) => d.prefix).join(", "), "registerDocs");
  } else if (options.owns || options.shared) {
    // and owns or shared with no auth module would guard nothing: every socket opens every document
    throw authless(docs.map((d) => d.prefix).join(", "), "registerDocs");
  }
  assertOwned(customDocs, auth);
  // One name, one registration on this server: the longest prefix answers it.
  const answers = claim(ws, [...docs.map((d) => d.prefix), ...customDocs.map((d) => d.prefix)]);
  /** The gate's identity (with `auth`), or its refusal. */
  const gated = (client: any): { identity: I } | { error: { code: number; message: string } } => {
    const g = auth!.gate(client);
    return isAuthError(g) ? { error: { code: 401, message: g.error } } : { identity: g };
  };
  /** Who is writing: with `auth` the gate's identity, else the one the client carries -- as the Postgres listener's writerOf. */
  const writerOf = (client: any): I | undefined => {
    if (!auth) return client?.data?.identity as I | undefined;
    const g = gated(client);
    return "identity" in g ? g.identity : undefined;
  };
  waitForLocks(db);
  const ledger = options.ledger ? createLedger(db) : undefined;
  const whoOf = (client: any): string | null => ledgerWho(writerOf(client), options.who);
  // The cursor undo walks: named by a caller in this process (`createLocal`),
  // and over the socket the connection itself -- signed in, the person and the
  // connection together, so another person holding the same connection id
  // (a client may choose it, to keep its cursor across a reconnect) cannot walk it.
  const cursorOf = (msg: any, client: any): string | null =>
    client?.data?.local ? (typeof msg.cursor === "string" ? msg.cursor : null) : socketCursor(whoOf(client), client);
  // Build lookup: prefix → DocDef
  const docByPrefix = new Map<string, DocDef>();
  // A scope reads the document's name by the same rule as on Postgres (./scope).
  for (const doc of docs) docByPrefix.set(doc.prefix, doc);

  // The custom documents (./custom): who holds each, who may hear it, what a write tells it.
  const custom = createCustomDocs<I, any>({ defs: customDocs, handle: db, auth, publish: (channel, data) => ws.publish(channel, data), log, answers });

  // In-memory doc cache: docName → loaded doc object
  const cache = new Map<string, any>();

  // Several processes on one file (todo #1): a copy read before another
  // connection committed is stale, and a write merged over one would put back
  // what the other wrote. `PRAGMA data_version` moves when another connection
  // commits (never for this one's own writes), so before a copy is served or
  // written from, every copy is dropped when it has moved, and read again from
  // the tables. A document open here is not told of another process's write:
  // it reads it when it is next opened, or written through. (Another
  // registration on this handle tells this one: `fanoutsOn`.)
  const dataVersion = db.query("PRAGMA data_version");
  let seenVersion = (dataVersion.get() as { data_version: number }).data_version;
  function heardElsewhere(): boolean {
    const now = (dataVersion.get() as { data_version: number }).data_version;
    if (now === seenVersion) return false;
    seenVersion = now;
    cache.clear();
    implied.clear();
    custom.forget();
    return true;
  }

  /**
   * A handler run under the write lock (BEGIN IMMEDIATE), so what it reads is
   * what it writes over: no other process commits between (an undo's plan and
   * its walk). Inside a caller's own transaction, it runs in that.
   */
  const underLock = (handler: (msg: any, client: any, respond: (r: any) => void) => void) =>
    (msg: any, client: any, respond: (r: any) => void) => db.transaction(() => handler(msg, client, respond)).immediate();

  /** Who a client is, to a custom document: the gate's identity with `auth`, else undefined -- as on Postgres. */
  const identityOf = (client: any): I | undefined => (auth ? writerOf(client) : undefined);

  /** An answer that may come later: `go` once `ok` says yes (awaited when it is a promise), else 404 -- not there for this identity. */
  const whenOwned = (ok: boolean | Promise<boolean>, respond: (r: any) => void, go: () => void): void | Promise<void> => {
    const no = () => respond({ error: NOT_FOUND });
    if (!isPromise(ok)) return ok ? go() : no();
    return ok.then((yes) => (yes ? go() : no()), (err: any) => respond({ error: failure(err) }));
  };

  /**
   * With `auth`, a handler for one of these documents asks the gate first
   * (401 without an identity) and then the document's `owns` (404 when it says
   * no; a shared one has none) -- the Postgres listener's withDoc. `owned:
   * false` for close: letting go never needs the owner's say. `gatesCustom: false`
   * where a custom document answers without the gate (a write: 403; a close).
   */
  const guarded = (handler: (msg: any, client: any, respond: (r: any) => void) => any, { owned = true, gatesCustom = true } = {}) =>
    (msg: any, client: any, respond: (r: any) => void) => {
      if (!auth) return handler(msg, client, respond);
      const docName = msg.doc as string;
      const mine = custom.find(docName);
      if (mine ? !gatesCustom : !findDoc(docName)) return handler(msg, client, respond);   // not gated here, or another backend's
      const g = gated(client);
      if ("error" in g) return respond(g);
      const owns = mine ? mine.def.owns : options.owns;
      if (!owned || !owns) return handler(msg, client, respond);
      return whenOwned(owns(g.identity, docName), respond, () => handler(msg, client, respond));
    };

  // Open implied docs whose root row has not been written yet.
  const implied = new Set<string>();

  function emptyDoc(def: DocDef, docId: string): any {
    const rootTable = schema.tables[def.root]!;
    const root: any = { id: rowId(docId) };
    for (const [col, colDef] of Object.entries(rootTable.columns)) {
      root[col] = colDef.default ?? (colDef.nullable ? null : defaultForType(colDef.type));
    }
    const doc: any = { [def.root]: root };
    for (const coll of def.include) doc[coll] = {};
    return doc;
  }

  /** A single document whose root row is not there: the root absent, each included collection empty. */
  const rootless = (def: DocDef, docId: string): any => ({ ...emptyDoc(def, docId), [def.root]: null });

  /**
   * An implied document's root row, made by its first write -- told as a row
   * carried in (`Touched`): an add to a list of those roots (a cafe's kitchen),
   * nothing to the implied documents, which showed it already. Undefined when
   * the row was there.
   */
  function ensureImpliedRoot(def: DocDef, doc: any, writer: string): Touched | undefined {
    const rootTable = schema.tables[def.root]!;
    const root = doc[def.root];
    if (db.query(`SELECT 1 FROM ${current(rootTable)} WHERE id = ?`).get(root.id)) return;
    if (handedOut(rootTable, root.id)) taken(def.root, root.id);   // made under the add rule (#71), as on Postgres
    const ts = now();
    if (rootTable.temporal) { root.valid_from = ts; root.valid_to = null; }
    insertRow(db, rootTable, root, ts);
    passId(rootTable, root.id);
    const row = readRow(rootTable, root.id);
    const before = new Map([...fanouts].map((f) => [f, f.showing(def.root, row, f === me ? writer : undefined)]));
    return { coll: def.root, id: row.id, before, after: row, carried: true };
  }

  /** The implied single documents open here (and `writer`) that hold `row`: they showed it before it was made. */
  function showing(coll: string, row: any, writer?: string): string[] {
    return holders(coll, row, writer).filter((name) => {
      const m = findDoc(name);
      return !!m?.def.implied && resolveScope(m.def, m.docId).mode === "single";
    });
  }

  // Who has each of these documents open, by name (for scoped fan-out)
  const subscriptions = new Map<string, Set<any>>();

  // This registration among those over the database: a write through any is told to the documents open on each.
  const me: Fanout = { holders, showing, announce };
  const fanouts = fanoutsOn.get(db) ?? new Set<Fanout>();
  fanoutsOn.set(db, fanouts);
  fanouts.add(me);
  /** Who holds `row` of `coll` on each registration over the database: the documents open there, and here `writer`. */
  const heldBy = (coll: string, row: any, writer: string): Touched["before"] =>
    new Map([...fanouts].map((f) => [f, f.holders(coll, row, f === me ? writer : undefined)]));

  /** The definition a name belongs to: the longest prefix it starts with, as Postgres's `_delta_find_doc`. */
  function findDoc(docName: string): { def: DocDef; docId: string } | null {
    let found: DocDef | undefined;
    for (const [prefix, def] of docByPrefix) {
      if (docName.startsWith(prefix) && (!found || prefix.length > found.prefix.length)) found = def;
    }
    // another registration on this server with a longer prefix answers it
    return found && answers(docName, found.prefix.length) ? { def: found, docId: docName.slice(found.prefix.length) } : null;
  }

  // Transport-level teardown (socket drop / logout via dropClientSubscriptions):
  // a dropped socket never sends the polite `close` action, so without this
  // every abandoned doc stayed cached forever and its dead socket sat in
  // `subscriptions`, growing the fan-out set monotonically (v0.5.0 review #7).
  // Mirrors the `close`-action eviction below.
  function releaseClient(client: any): void {
    custom.leave(client);
    for (const [docName, subs] of subscriptions) if (subs.delete(client)) unheld(docName);
  }

  /** A document nobody has open now: its copy is dropped. */
  function unheld(docName: string): void {
    if (subscriptions.get(docName)?.size) return;
    subscriptions.delete(docName);
    cache.delete(docName);
    implied.delete(docName);
  }

  /**
   * Tellings run in the order their writes committed: one that waits on an
   * `owns`'s promise holds back those after it. With no promise to wait on,
   * a write is told before it answers, as it always was.
   */
  let telling: Promise<void> | undefined;
  function inOrder(run: () => void | Promise<void>): void {
    const failed = (err: any) => log.error(`delta fan-out failed (write committed): ${err?.message ?? err}`);
    const settle = (p: Promise<void>) => {
      const mine: Promise<void> = p.then(undefined, failed).then(() => { if (telling === mine) telling = undefined; });
      telling = mine;
    };
    if (telling) return settle(telling.then(run));
    let r: void | Promise<void>;
    try { r = run(); } catch (err) { return failed(err); }
    if (isPromise(r)) settle(r);
  }

  // ---------------------------------------------------------------------------
  // Delta ops → SQL
  // ---------------------------------------------------------------------------

  /** A row outside a document -- of a collection it does not include -- that a write through it reaches (a cascade). */
  type Beyond = { coll: string; row: any };

  /** The document with rows outside it beside it, for the ledger: what an inverse puts back, and what a walk is guarded by. */
  function besides(doc: any, rows: Beyond[]): any {
    if (!rows.length) return doc;
    const out = { ...doc };
    for (const { coll, row } of rows) out[coll] = { ...out[coll], [row.id]: row };
    return out;
  }

  /**
   * The id of the `root` row that `row` (of `coll`) hangs from, following parent
   * keys up through the tables as they stand; null when the chain does not
   * reach `root`. The twin of Postgres's `_delta_chain_root`.
   */
  function chainRoot(coll: string, row: any, root: string): unknown {
    if (coll === root) return row.id;
    let table = schema.tables[coll];
    if (!table?.parent) return null;
    let id: unknown = row[table.parent.fkColumn];
    let cur = table.parent.collection;
    for (let depth = 0; depth < 32 && id != null; depth++) {
      if (cur === root) return id;
      table = schema.tables[cur];
      if (!table?.parent) return null;
      id = (db.query(`SELECT ${table.parent.fkColumn} AS fk FROM ${current(table)} WHERE id = ?`).get(id as any) as { fk: unknown } | null)?.fk ?? null;
      cur = table.parent.collection;
    }
    return null;
  }

  /**
   * Does the document (`def`, read by `scope`) hold `row` of `coll`? Judged on
   * the row's values, so a row as it was before a write is judged as well as
   * one as it is after -- Postgres's `_delta_doc_holds`.
   */
  function holds(def: DocDef, scope: Scope, coll: string, row: any): boolean {
    if (!row) return false;
    if (coll !== def.root && !def.include.includes(coll)) return false;
    // named with a time past, it holds a temporal row as it stood then, which no write now changes (a table that keeps no history it reads as it is)
    if (scope.at !== undefined && schema.tables[coll]?.temporal && sqliteTime(scope.at) <= sqliteTime(new Date().toISOString())) return false;
    if (coll === def.root) {
      if (scope.mode !== "list" && !sameId(row.id, scope.id)) return false;
      // a name its columns cannot take holds nothing: it is refused (400) when opened or written through
      try { return meets(scope, row, keeping(db, schema.tables[coll]!)); }
      catch (err: any) { if (typeof err.code === "number") return false; throw err; }
    }
    if (scope.mode === "list" || !schema.tables[coll]?.parent) return true;   // in full
    return sameId(chainRoot(coll, row, def.root), scope.id);
  }

  /** The open documents -- and the writer's own -- that hold `row` of `coll`. */
  function holders(coll: string, row: any, writer?: string): string[] {
    if (!row) return [];
    const names = new Set(subscriptions.keys());
    if (writer !== undefined) names.add(writer);
    const out: string[] = [];
    for (const name of names) {
      const m = findDoc(name);
      if (m && holds(m.def, resolveScope(m.def, m.docId), coll, row)) out.push(name);
    }
    return out;
  }

  /** A row as the tables hold it now, as a document reads it; null when not there. */
  function readRow(table: ResolvedTable, id: string | number): any | null {
    const row = db.query(`SELECT * FROM ${current(table)} WHERE id = ?`).get(id as any);
    if (!row) return null;
    decodeRow(table, row);
    return row;
  }

  /** The rows that hang from a row of `table` -- its children, theirs, and on down -- parent first, as `_delta_hanging_rows` orders them. */
  function hanging(table: ResolvedTable, id: string | number, out: { table: ResolvedTable; row: any }[] = []): { table: ResolvedTable; row: any }[] {
    for (const childKey of table.children.toSorted()) {
      const child = schema.tables[childKey]!;
      for (const row of db.query(`SELECT * FROM ${current(child)} WHERE ${child.parent!.fkColumn} = ? ORDER BY id`).all(id as any) as any[]) {
        decodeRow(child, row);
        out.push({ table: child, row });
        hanging(child, row.id, out);
      }
    }
    return out;
  }

  /**
   * A row and the rows its removal takes with it (its children, and the rows
   * `cascadeOn` it), parent first -- each once, where the walk first reaches it,
   * as the removal then takes it: a row reached twice (a child of the removed
   * row that also cascades on another row it takes) is not taken again. As the
   * schema says, whichever document the removal is written through: one that
   * does not include the drinks still takes a course's drinks. In one order on
   * every backend: each child collection by key, each row by id, then each
   * collection that cascades on it (`_delta_cascade_remove`).
   */
  function cascadeRows(table: ResolvedTable, id: string | number, out: { table: ResolvedTable; row: any }[] = [], seen = new Set<string>()): { table: ResolvedTable; row: any }[] {
    const key = `${table.docKey}/${id}`;
    const row = seen.has(key) ? null : readRow(table, id);
    if (!row) return out;
    seen.add(key);
    out.push({ table, row });
    for (const childKey of table.children.toSorted()) {
      const child = schema.tables[childKey]!;
      for (const r of db.query(`SELECT id FROM ${current(child)} WHERE ${child.parent!.fkColumn} = ? ORDER BY id`).all(id as any) as any[]) {
        cascadeRows(child, r.id, out, seen);
      }
    }
    const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    for (const ref of table.referencedBy.toSorted((a, b) => byKey(a.collection, b.collection) || byKey(a.fkColumn, b.fkColumn))) {
      const refTable = schema.tables[ref.collection]!;
      for (const r of db.query(`SELECT id FROM ${current(refTable)} WHERE ${ref.fkColumn} = ? ORDER BY id`).all(id as any) as any[]) {
        cascadeRows(refTable, r.id, out, seen);
      }
    }
    return out;
  }

  /**
   * The next serial for a collection: its sequence advanced. A collection with
   * no sequence yet starts from the largest id it holds -- rows put in by
   * hand -- and from then on counts on, as a Postgres sequence does, past
   * any id a write named (`passId`).
   */
  function nextId(table: ResolvedTable): number {
    const next = serial(table) + 1;
    const take = () => db.run("INSERT INTO _delta_sequences (collection, last) VALUES (?, ?) ON CONFLICT (collection) DO UPDATE SET last = MAX(last, excluded.last)", [table.docKey, next]);
    take();
    spent.push(take);
    return next;
  }

  /** The last id a collection's serial handed out: its sequence, or before it has one, the largest id the table holds. */
  function serial(table: ResolvedTable): number {
    const seq = db.query("SELECT last FROM _delta_sequences WHERE collection = ?").get(table.docKey) as { last: number } | null;
    return seq?.last ?? ((db.query(`SELECT MAX(id) AS m FROM ${table.name} WHERE typeof(id) = 'integer'`).get() as { m: number | null } | null)?.m ?? 0);
  }

  /** Whether a collection's serial has handed `id` out: an add may not name it (#71). A text id is the client's own key, which no serial hands out. */
  function handedOut(table: ResolvedTable, id: string | number): boolean {
    return typeof id === "number" && id <= serial(table);
  }

  /** The one answer to an add of an id taken, whether a row holds it or the serial handed it out (#71). */
  function taken(coll: string, id: string | number): never {
    refuse(409, `Id already taken: ${joinPath(coll, String(id))} -- add to ${joinPath(coll, "-")} for a new id`);
  }

  /**
   * An id a write named moves its collection's sequence past it, never back, so a later `add /<coll>/-` does not
   * meet it (#72) -- Postgres's `_delta_serial_past`. As there, once the write is done (`passNamed`), so a
   * write refused part way names none, and a `-` in the write after a named add takes the serial as it stood
   * (#71). A collection with no sequence yet starts one, from the largest id it holds, as `nextId` would, so
   * the id stays passed once its row is gone, as setval's does.
   */
  function passId(table: ResolvedTable, id: string | number): void {
    if (typeof id === "number" && !(id <= (passing.get(table) ?? -Infinity))) passing.set(table, id);
  }

  /** Each collection's highest id the write under way named, its serial passed once the write is done. */
  const passing = new Map<ResolvedTable, number>();

  function passNamed(): void {
    for (const [table, id] of passing) {
      db.run(
        `INSERT INTO _delta_sequences (collection, last) VALUES (?1, MAX(?2, COALESCE((SELECT MAX(id) FROM ${table.name} WHERE typeof(id) = 'integer'), 0)))
         ON CONFLICT (collection) DO UPDATE SET last = MAX(last, ?2)`, [table.docKey, id]);
    }
    passing.clear();
  }

  /**
   * The serials the write under way minted (`-`): taken again when it is rolled
   * back, so a refused write spends them, as a Postgres sequence's nextval is
   * not rolled back -- the next row is named the same on both.
   */
  const spent: (() => void)[] = [];

  // You may write what you may read. Reads were always scoped; writes addressed
  // rows by bare id, so a client holding `customer:alice` could name a row of
  // `customer:bob` and reach it. Every row-addressed write asks `held` (in
  // applyOps): the row as the tables stand at that point in the write, judged by
  // the rule a document is read by (`holds`), as Postgres asks
  // `_delta_row_in_scope` -- so a row that left the document earlier in the same
  // write is not its to write. A row added, or moved by a parent key written, goes
  // only under a parent the document holds (`parentHeld`; one of a collection it
  // does not include, through the tables: `reaches`). The error message
  // deliberately matches the "not there" case: a distinct "forbidden" would
  // confirm the row exists to someone probing ids.
  function applyOps(docName: string, def: DocDef, doc: any, ops: DeltaOp[], walk: boolean): { applied: DeltaOp[]; touched: Touched[]; beyond: Beyond[] } {
    const scope = resolveScope(def, docName.slice(def.prefix.length));
    const list = scope.mode === "list";
    const rootId = list ? undefined : rowId(scope.id ?? doc[def.root]?.id);
    const rootTable = schema.tables[def.root]!;
    let opened: boolean | undefined;   // a single document's root was there as the write began (or it is implied)
    let rootWas: any;   // that root as this write took it out: added back, it goes under the same parent
    const broadcastOps: DeltaOp[] = [];
    const touched: Touched[] = [];
    const beyond: Beyond[] = [];   // rows the cascade took that the document does not hold, as they were
    // A write is one moment, as a Postgres transaction's NOW() is: every version
    // it makes or closes is stamped with it, and a temporal row it writes twice
    // is one new version -- rewritten in place (`made`), not closed a tick later.
    const ts = now();
    const made = new Set<string>();

    /**
     * The row of `table` the document holds, as the tables stand at this point
     * in the write -- Postgres's `_delta_row_in_scope`: you may write what you
     * may read. A row that has left the document earlier in the write (moved
     * to another parent, out of a list's condition, its parent gone) is not its
     * to write for the rest of it; null when it is not there or not the document's.
     * The document's copy is not asked: it is the document as it was opened.
     */
    const held = (table: ResolvedTable, id: string | number): any | null => {
      const row = readRow(table, id);
      return row && holds(def, scope, table.docKey, row) ? row : null;
    };

    /**
     * A run of replaces of one row, one op straight after another: merged as
     * they come and written when the run ends -- one write of the row, one
     * answer, one entry and one telling of the run's net change. Every other op
     * ends the run first, so the ops still land in the order sent; nothing
     * between them could see the row part-way. Postgres's `delta_apply` answers
     * such a run once too.
     */
    let run: { table: ResolvedTable; id: string | number; root: boolean; key: string; before: Touched["before"]; was: any; row: any } | undefined;

    /**
     * Write the run's row: on a temporal table, the version before the write
     * closed and the write's inserted (or, once the write has made it, that
     * version rewritten); else one in-place UPDATE (`id` is the whole PK there,
     * so a reinsert would collide). The row is read back as it is kept (a parent
     * key's "5" is 5), as Postgres's RETURNING gives it, and told as it lands.
     */
    const endRun = () => {
      if (!run) return;
      const { table, id, root, key, before, was, row } = run;
      run = undefined;
      // a row moved to another parent takes the rows under it along: who holds each, asked before it moves
      const fk = table.parent?.fkColumn;
      const moved = fk != null && !sameId(row[fk], readRow(table, id)[fk]);
      const carried: Touched[] = moved ? hanging(table, id).map(({ table: t, row: r }) => ({ coll: t.docKey, id: r.id, before: heldBy(t.docKey, r, docName), after: r, carried: true })) : [];
      if (table.temporal && !made.has(key)) {
        closeRow(db, table, id, ts);
        insertRow(db, table, row, ts);
        made.add(key);
      } else updateRow(db, table, id, row);
      const collKey = table.docKey;
      const stored = readRow(table, id);
      if (root) doc[collKey] = stored;
      else doc[collKey][id] = stored;
      broadcastOps.push({ op: "replace", path: root ? joinPath(collKey) : joinPath(collKey, String(id)), value: stored });
      touched.push({ coll: collKey, id, before, after: stored, was });
      touched.push(...carried);   // after the row they hang from, unchanged
    };

    /**
     * A parent a row may not go under: not there, or not the document's (404) -- or, named by text that is
     * no number, a mistake (400), as Postgres refuses to cast it. (A text id SQLite keeps is there.)
     */
    const noParent = (coll: string, id: unknown): never =>
      typeof id === "string" && !/^\s*[+-]?\d+\s*$/.test(id)
        ? refuse(400, `${coll} "${id}" names no row: an id is a whole number`)
        : refuse(404, `Row not found: ${coll}/${id ?? ""}`);

    /** Is row `id` of `coll` there now? A parent a row is added or moved under must be -- Postgres's `_delta_row_there`. */
    const there = (coll: string, id: unknown): boolean => readRow(schema.tables[coll]!, rowId(id as string | number)) != null;

    // Does a parent the document does not include hang from its root? Asked of the tables (todo #32).
    const reaches = (coll: string, id: unknown): boolean => {
      const parent = readRow(schema.tables[coll]!, rowId(id as string | number));
      return !!parent && sameId(chainRoot(coll, parent, def.root), rootId);
    };

    /**
     * Does the document hold `id` of `coll`, the parent a row is added or moved
     * under, as the tables stand now? One of a collection it does not include
     * is asked of `reaches` (single mode; a list holds none such).
     */
    const parentHeld = (coll: string, id: unknown): boolean =>
      id != null && (coll === def.root || def.include.includes(coll) ? held(schema.tables[coll]!, rowId(id as string | number)) != null : !list && reaches(coll, id));

    /**
     * Replace fields of a row the document holds -- the root (`root`), or a row
     * of a map -- as the op says, into the run of that row. The path names the
     * row, so `id` and the temporal columns in a value are not taken from it.
     * A replace of the row itself (`whole`) is the row, as RFC 6902 says: a
     * column its value leaves out holds what an add would give it (todo #3);
     * its parent key, where it hangs, stays unless the value names another.
     */
    const replaceRow = (table: ResolvedTable, id: string | number, fields: Record<string, unknown>, root: boolean, whole = false) => {
      const collKey = table.docKey;
      const key = `${collKey}/${id}`;
      if (run && run.key !== key) endRun();
      if (!run) {
        const present = held(table, id);
        if (!present) refuse(404, `Row not found: ${collKey}/${id}`);   // not this document's, or gone from it earlier in this write
        run = { table, id, root, key, before: heldBy(collKey, present, docName), was: present, row: { ...present } };
      }
      // A parent key written moves the row, and only under a parent this
      // document holds, as an add names one: through it, a row is never moved
      // into another document (you may write what you may read). A single
      // document's own root too: it holds no parent of it, so the root moves
      // through a list that holds both (0.10.0 review). A list's included
      // collection is whole; a key written as it is, is no move.
      const parent = table.parent;
      const to = parent ? fields[parent.fkColumn] : undefined;
      const from = parent ? run.row[parent.fkColumn] : undefined;   // as this write has it so far
      if (parent && to != null && !(from != null && sameId(rowId(to as string | number), rowId(from as string | number)))
          && ((!(list && parent.collection !== def.root) && !parentHeld(parent.collection, to)) || !there(parent.collection, to))) {
        noParent(parent.collection, to);
      }
      // (of the columns this document holds: it leaves the rest as they are)
      if (whole) for (const [col, colDef] of Object.entries(table.columns)) if (holdsField(def, schema, collKey, col)) run.row[col] = leftOut(colDef);
      for (const [field, value] of Object.entries(fields)) {
        if (field === "id" || field === "valid_from" || field === "valid_to") continue;
        run.row[field] = value;
      }
      // A list's root row written through the list stays in its scope, as an
      // add through it is given its bindings: a field, a row or a merge that
      // takes it out -- into another owner's list by its key, or out of a
      // condition -- is refused, and the write undone (todo #6's review). So
      // does a single document's root, out of the rest of its name's scope
      // (a seat of fo-seat-of:1:3 to table 7; 0.10.0 review).
      if (((list && collKey === def.root) || root) && !holds(def, scope, collKey, run.row)) {
        refuse(404, `Row not found: ${collKey}/${id} -- the write would take it out of ${docName}`);
      }
    };

    // Each op lands in the order sent, as on Postgres: a field written and then
    // its row removed is written first, and a row removed is not there for an
    // op after it.
    for (const op of ops) {
      if (op.op !== "replace") endRun();
      // A single document whose root is not there takes no writes (404), as it
      // opens: asked before each op, so one that takes its root out writes
      // nothing more through it -- an add under it would be an orphan -- but
      // that root back, and then on through it (delta_apply asks the same). A
      // walk is not asked: it may start from the root absent (an undo of its
      // removal), guarded by its plan.
      if (!list && !walk) {
        const there = readRow(rootTable, rootId!) != null;
        opened ??= there || !!def.implied;   // an implied document always opens
        const named = (() => { try { return splitPath(op.path); } catch { return []; } })();
        const back = opened && op.op === "add" && named.length === 2 && named[0] === def.root && named[1] !== "-" && sameId(rowId(named[1]!), rootId);
        if (!there && !back) refuse(404, `Document not found: ${docName} (its root, ${joinPath(def.root, String(rootId))}, is not there)`);
      }

      // What the op may say (`validateOps`), asked as it comes, as delta_apply asks it: one refused
      // leaves the ops before it to roll back, and the serials they took spent -- the same on every backend
      const invalid = validateOps(schema, def, [op], { list, values: scope.values, walk });
      if (invalid.length) refuse(400, invalid.map((e) => `${e.path}: ${e.message}`).join("; "));

      const parts = splitPath(op.path);
      const collKey = parts[0]!;
      const table = schema.tables[collKey];
      // A single-mode document's root is one row, held at /<root>.
      const isRoot = !list && collKey === def.root;

      // /<root>/<id> and /<root>/<id>/<field> name it by its id, as on Postgres
      // and as a list document would say it: a replace of it, or of one field.
      // It holds no other root row, so another id is not found.
      if (isRoot && op.op === "replace" && (parts.length === 3 || (parts.length === 2 && namesRootRow(table!, parts[1]!, rootId)))) {
        if (!sameId(rowId(parts[1]!), rootId)) refuse(404, `Row not found: ${collKey}/${rowId(parts[1]!)}`);
        replaceRow(table!, rootId!, parts.length === 3 ? { [parts[2]!]: (op as any).value } : (op as any).value, true, parts.length === 2);
        continue;
      }

      // /<root>/fieldName is a field of it (an add or a remove of /<root>/<id> is the row itself, below)...
      if (isRoot && parts.length === 2 && op.op !== "add" && op.op !== "remove") {
        if (op.op !== "replace") throw new Error(`Root fields support replace only`);
        replaceRow(table!, rootId!, { [parts[1]!]: (op as any).value }, true);
        continue;
      }

      // ...and /<root> the root row whole.
      if (!list && collKey === def.root && parts.length === 1) {
        if (op.op !== "replace") throw new Error(`Root supports replace only`);
        replaceRow(table!, rootId!, (op as any).value as Record<string, unknown>, true, true);
        continue;
      }

      // Everything else is a row of a map (an included collection, or a list-mode document's root), or the root row itself --
      // or, in a walk, a row outside the document (`beyond`) that the entry's cascade took: put back, or taken again.
      const outside = collKey !== def.root && !def.include.includes(collKey);
      if (!table || (outside && !(walk && parts.length === 2 && op.op !== "replace"))) {
        throw new Error(`Unknown collection: ${collKey}`);
      }

      if (parts.length === 2) {
        // A single document removes the root it is named for, as on Postgres,
        // with the rows it holds under it, and an undo adds it back, then them.
        // It holds no other root row, so another is not its to remove (404) or
        // add (400; Postgres adds it, and the document does not hold it).
        if (isRoot && (parts[1] === "-" || !sameId(rowId(parts[1]!), rootId))) {
          if (op.op === "remove") refuse(404, `Row not found: ${collKey}/${parts[1]}`);
          refuse(400, `${docName} holds ${collKey} ${rootId} alone: add another ${collKey} row through a document that lists them`);
        }
        // `add /<coll>/-` is a new row the store names: the next serial, as
        // Postgres takes nextval -- carried by the broadcast path and the row.
        const mint = op.op === "add" && parts[1] === "-";
        const id = mint ? nextId(table) : rowId(parts[1]!);
        if (op.op === "add") {
          // An add makes a new row, under an id the serial has not handed out
          // (#71): one it has (minted, or passed for an add that named it) is
          // refused, whether a row holds it now or none does, so the answer
          // says nothing of rows the writer may not read. But for ids the
          // writer has read: a walk puts back the rows its entry took, and a
          // write may add back a row it has itself written (a single
          // document's root taken out and put back). A live id is refused all
          // the same (on a temporal table it would be a second live version,
          // #16): a text id, the client's own key, which no serial hands out,
          // or a row put in by hand past the serial. delta_apply keeps the
          // same rule.
          const named = !mint && !walk && !touched.some((t) => t.coll === collKey && sameId(t.id, id));
          if ((named && handedOut(table, id)) || db.query(`SELECT 1 FROM ${current(table)} WHERE id = ?`).get(id)) taken(collKey, id);
          const row = { ...((op as any).value as Record<string, unknown>) };
          // A list-mode document's root row is given its scope's equality bindings, as on Postgres:
          // each as its column takes the name's text (a boolean's "0" is false), and the row is read back.
          if (list && collKey === def.root) for (const [col, text] of Object.entries(scope.values)) row[col] = scopeValue(table, col, text);
          // A DIRECT child's FK is forced to `rootId` by insertCollectionRow, but a
          // grandchild's comes verbatim from the client. Unchecked, that grafts the
          // new row onto another doc's parent — a cross-doc write. Require the named
          // parent to be in THIS doc's scope, as it stands now. (The root's own
          // parent is not in the document: its value names it, as a list's root
          // row's does; a list's included collection is whole.)
          const parent = table.parent;
          if (!isRoot && !outside && parent && (list ? parent.collection === def.root : parent.collection !== def.root)) {
            const fk = row[parent.fkColumn];
            if (!parentHeld(parent.collection, fk)) noParent(parent.collection, fk);
          }
          // ... and whatever the document, the parent it names must be there (a list names it only by key;
          // a single document's child goes under its root, gone if a walk puts the child back after it)
          const fk = parent && !list && !isRoot && parent.collection === def.root ? rootId : parent ? row[parent.fkColumn] : undefined;
          if (parent && fk != null && !there(parent.collection, fk)) noParent(parent.collection, fk);
          const fullRow = insertCollectionRow(db, schema, table, id, rootId, def, row, ts, list);
          passId(table, id);
          // A root row added through a document is one it holds: a list's, given
          // its bindings, meets the rest of its conditions too, and a single
          // document's own root added back the whole of its name's scope -- else
          // refused, and the write undone (0.10.0 review, todo #66).
          if (((list && collKey === def.root) || isRoot) && !holds(def, scope, collKey, fullRow)) {
            refuse(404, `Row not found: ${collKey}/${id} -- the add is not one ${docName} holds`);
          }
          // ... and a single document's own root, added back in the write that took
          // it out, goes back under the parent it had: another would be a move, and
          // the document holds no parent of its root (0.10.0 review).
          if (isRoot && rootWas && parent && !sameId(fullRow[parent.fkColumn], rootWas[parent.fkColumn])) {
            refuse(404, `Row not found: ${parent.collection}/${fullRow[parent.fkColumn] ?? ""}`);
          }
          if (table.temporal) made.add(`${collKey}/${id}`);
          if (isRoot) doc[collKey] = fullRow;
          else if (!outside) doc[collKey][id] = fullRow;
          broadcastOps.push({ op: "add", path: joinPath(collKey, String(id)), value: fullRow });
          touched.push({ coll: collKey, id, before: new Map(), after: fullRow });
        } else if (op.op === "remove") {
          // Remove row + cascades. The removal addresses rows by id ALONE, so
          // without this gate a client could name any id and delete a sibling
          // doc's row -- or one that has left this document earlier in the write.
          if (!(outside ? readRow(table, id) : held(table, id))) refuse(404, `Row not found: ${collKey}/${id}`);
          if (isRoot) rootWas = readRow(table, id);
          // the row and every row its removal takes, and who holds each, asked before any is gone
          const cascade = cascadeRows(table, id).map(({ table: t, row }) => ({ t, row, before: heldBy(t.docKey, row, docName) }));
          for (const { t, row, before } of cascade) {
            if (t.temporal) closeRow(db, t, row.id, ts);
            else db.run(`DELETE FROM ${t.name} WHERE id = ?`, [row.id]);
            delete doc[t.docKey]?.[row.id];
            if (t.docKey !== def.root && !def.include.includes(t.docKey)) beyond.push({ coll: t.docKey, row });
            broadcastOps.push({ op: "remove", path: joinPath(t.docKey, String(row.id)) });
            touched.push({ coll: t.docKey, id: row.id, before, after: null });
          }
          if (isRoot) doc[collKey] = null;
        } else if (op.op === "replace") {
          // Whole-row replace: /<coll>/<id> -- the row, as an add's value is
          replaceRow(table, id, (op as any).value as Record<string, unknown>, false, true);
        }
      } else if (parts.length === 3 && op.op === "replace") {
        // Field update: /<coll>/<id>/<field>
        replaceRow(table, rowId(parts[1]!), { [parts[2]!]: (op as any).value }, false);
      } else {
        throw new Error(`Invalid op: ${op.op} ${op.path}`);
      }
    }
    endRun();

    return { applied: broadcastOps, touched, beyond };
  }

  /**
   * What each document that held or holds a row the write changed is told, the
   * writer's first -- Postgres's `_delta_tell`: a row that arrives is an add,
   * one that stays a replace of each field that changed (none: nothing), one
   * that leaves a remove; where the row is the document's root, a replace of the
   * root when it arrives (null when it leaves -- or, for an implied document,
   * the empty root it then opens with). A holder is told what changed, never
   * the whole row again.
   *
   * Each touch is told in turn, so a copy is told every step of a row the write
   * touches twice: who holds the row after a touch is who held it at its next,
   * and after its last, who holds it once the write is done. A row made and
   * then taken out (a drink, with its course) is told its add wherever its
   * remove is told, never a remove alone (todo #75). `_delta_tell` keeps the same.
   */
  function tell(writer: string | undefined, touched: Touched[]): Map<string, DeltaOp[]> {
    const rows = touched.map((t) => ({ ...t, before: t.before.get(me) ?? [], now: [] as string[] }));
    const next = new Map<string, string[]>();   // a row's holders, as its next touch found them
    for (const t of rows.toReversed()) {
      const key = `${t.coll}/${t.id}`;
      t.now = next.get(key) ?? holders(t.coll, t.after, writer);
      next.set(key, t.before);
    }
    const targets = new Set<string>(writer === undefined ? [] : [writer]);
    for (const t of rows) for (const name of [...t.before, ...t.now]) targets.add(name);
    const told = new Map<string, DeltaOp[]>();
    for (const target of targets) {
      const m = findDoc(target);
      if (!m) continue;
      const single = resolveScope(m.def, m.docId).mode === "single";
      const ops: DeltaOp[] = [];
      for (const t of rows) {
        const was = t.before.includes(target);
        const is = t.now.includes(target);
        if ((!was && !is) || (t.carried && was && is)) continue;
        const root = single && t.coll === m.def.root;
        const path = root ? joinPath(t.coll) : joinPath(t.coll, String(t.id));
        const show = (row: any) => showRow(m.def, schema, t.coll, row);   // the columns it holds (todo #70)
        if (was && is) ops.push(...changedFields(path, show(t.was), show(t.after)));
        else if (is) ops.push({ op: root ? "replace" : "add", path, value: show(t.after) });
        else ops.push(root ? { op: "replace", path, value: m.def.implied ? show(emptyDoc(m.def, m.docId)[m.def.root]) : null } : { op: "remove", path });
      }
      told.set(target, ops);
    }
    return told;
  }

  // ---------------------------------------------------------------------------
  // WebSocket handlers
  // ---------------------------------------------------------------------------

  ws.on("open", guarded((msg, client, respond) => {
    const docName = msg.doc as string;
    if (custom.find(docName) || findDoc(docName)) heardElsewhere();

    // Custom doc path first (independent prefix space).
    const customMatch = custom.find(docName);
    if (customMatch) {
      let doc: any;
      try { doc = custom.open(client, docName, customMatch, identityOf(client)); }
      catch (err: any) { log.error(`open custom ${docName} failed: ${err.message}`); return respond({ error: failure(err) }); }
      if (doc == null) return respond({ error: NOT_FOUND });
      trackSubscribe(client, docName);
      onClientDrop(client, releaseClient);
      respond({ result: doc });
      log.info(`opened ${docName} (custom${customMatch.def.recompute ? ", recompute" : ""})`);
      return;
    }

    const match = findDoc(docName);
    if (!match) return;

    let doc: any;
    try { doc = load(docName, match.def, match.docId); }
    catch (err: any) { return respond({ error: failure(named(err)) }); }
    if (!doc) {
      respond({ error: { code: 404, message: `Not found: no ${match.def.root} row ${match.docId}. Make the row first, or declare the document implied: true` } });
      return;
    }

    trackSubscribe(client, docName);
    if (!subscriptions.has(docName)) subscriptions.set(docName, new Set());
    subscriptions.get(docName)!.add(client);
    onClientDrop(client, releaseClient);

    // with a ledger, the version the document is at, as the Postgres backend's open says it (`_v`),
    // so a copy kept from the stream of changes knows where it starts; its rows as it shows them
    // (the copy kept here is whole: what undo and the inverse read)
    const shown = showDoc(match.def, schema, doc, resolveScope(match.def, match.docId).mode === "single");
    respond({ result: ledger ? { ...shown, _v: ledger.version(docName) } : shown });
    log.info(`opened ${docName}`);
  }));

  /** A document from the cache, or loaded into it: an implied one opens empty, and its first write makes its row. */
  function load(docName: string, def: DocDef, docId: string): any | null {
    let doc = cache.get(docName);
    if (doc) return doc;
    doc = readDoc(db, schema, def, resolveScope(def, docId));
    if (!doc && def.implied) {
      doc = emptyDoc(def, docId);
      implied.add(docName);
    }
    if (doc) cache.set(docName, doc);
    return doc;
  }

  type Written = { ops: DeltaOp[]; inverse: DeltaOp[]; version?: number; entry?: number };
  type Failed = { error: { code: number; message: string } };

  /**
   * Read back every doc someone has open that `evict()` dropped, before a
   * write: fan-out checks a target's scope against its copy, and one with no
   * copy used to lose its removes and grandchildren for good (v0.5.0 review #6).
   */
  function reloadEvicted(): void {
    for (const [name, subs] of subscriptions) {
      if (!subs.size || cache.has(name)) continue;
      const match = findDoc(name);
      if (match) load(name, match.def, match.docId);
    }
    custom.reread();
  }

  /**
   * The one write path -- a fresh write, an undo, a redo: validated, applied in
   * one transaction with its ledger entry (a savepoint inside a caller's own),
   * and then told: to the document's subscribers, to the other open documents
   * that share its rows, and to the custom documents that watch them.
   */
  function write(docName: string, def: DocDef, doc: any, ops: DeltaOp[], by: { who: string | null; cursor: string | null; undoes?: number; undoable?: boolean }): Written | Failed {
    // Each op is validated as it comes (applyOps), unknown collections, fields and bad types refused
    // rather than acked and dropped by the database.
    const scope = resolveScope(def, docName.slice(def.prefix.length));
    // a document named with a time reads it as it stood: what is written now is not its to write
    if (scope.at !== undefined) return { error: { code: 403, message: `${docName} reads ${def.root} as it stood at ${scope.at}: it takes no writes. Write through a document with no time in its name.` } };

    let snapshot = structuredClone(doc); // for rollback, and for the inverse
    spent.length = 0;
    passing.clear();
    let written: Written;
    let touched: Touched[] = [];
    try {
      // `db.transaction` rather than a bare BEGIN: inside a caller's own
      // transaction (a server-side renderer writing several things as one, a
      // test that rolls every case back) it becomes a savepoint, and still
      // rolls back alone. Rollback owns only this region: a failure in the
      // post-commit block below must not look like a failed write.
      // an implied document's first write makes its root row -- unless it adds the root itself (an undo of its removal)
      const addsRoot = scope.mode === "single" && ops.some((op) => op.op === "add" && splitPath(op.path).length === 2 && splitPath(op.path)[0] === def.root);
      // Immediate: the write lock first, waiting for another process's (busy_timeout),
      // then the reads -- a deferred transaction that read before another committed
      // could not then write (SQLITE_BUSY). Under it, a copy another wrote past is read again.
      written = db.transaction(() => {
        if (heardElsewhere()) {
          reloadEvicted();
          doc = load(docName, def, docName.slice(def.prefix.length)) ?? rootless(def, docName.slice(def.prefix.length));
          snapshot = structuredClone(doc);
        }
        const made = implied.has(docName) && !addsRoot && ops.length > 0 ? ensureImpliedRoot(def, doc, docName) : undefined;   // an empty write makes nothing
        const done = applyOps(docName, def, doc, ops, by.undoes !== undefined);
        passNamed();
        touched = made ? [made, ...done.touched] : done.touched;
        const inverse = inverseOf(besides(snapshot, done.beyond), done.applied, ops);
        const recorded = ledger?.record({ doc: docName, ops: done.applied, inverse, ...by });
        return { ops: done.applied, inverse, version: recorded?.version, entry: recorded?.entry };
      }).immediate();
      if (ops.length > 0) implied.delete(docName);
    } catch (err: any) {
      for (const take of spent) take();
      if (spent.length) options.committed?.();   // the serials it spent are kept: the JSON file saves them
      if (cache.has(docName)) cache.set(docName, snapshot); // restore in-memory cache (a rootless walk's copy was never in it)
      named(err);
      log.error(`delta failed: ${err.message}`);
      // A refusal carries its wire code (`refuse`); anything else is the server's.
      return { error: failure(err) };
    }

    // Committed. The telling is a post-commit side effect: a failure here must
    // not roll back (the write is durable) nor masquerade as a write error.
    try {
      // Every document that held or holds a row the write changed is told what
      // changed for it (todo #28) -- the writer's own first, with the version
      // its write made; each other, with a version of its own. Through
      // `createLocal().onPublish`, the one stream of changes an in-process
      // caller (eta) redraws from.
      announce(touched, written.ops, { name: docName, version: written.version });
      for (const f of fanouts) if (f !== me) f.announce(touched, written.ops);
      options.committed?.();
    } catch (err: any) {
      log.error(`delta fan-out failed (write committed): ${err.message}`);
    }
    log.info(`delta ${docName} [${ops.map((o: DeltaOp) => `${o.op} ${o.path}`).join(", ")}]`);
    return written;
  }

  /**
   * Tell the documents open here what a write changed (`writer`: the one
   * written through, if it is this registration's), and the custom documents
   * that watch its rows. Every document that held or holds a row the write
   * changed is told what changed for it (todo #28) -- the writer's own first,
   * with the version its write made; each other, with a version of its own.
   * Through `createLocal().onPublish`, the one stream of changes an in-process
   * caller (eta) redraws from.
   */
  function announce(touched: Touched[], applied: DeltaOp[], writer?: { name: string; version?: number }): void {
    const changes: { name: string; change: Record<string, unknown> }[] = [];
    for (const [name, tOps] of tell(writer?.name, touched)) {
      if (name === writer?.name) {
        // a write that changed nothing tells nothing, and made no version (as on Postgres)
        if (applied.length > 0) changes.push({ name, change: { doc: name, ops: tOps, ...(writer.version !== undefined ? { v: writer.version } : {}) } });
      } else if (tOps.length > 0) {
        const v = ledger?.bump(name);   // numbered as committed, told in that order
        changes.push({ name, change: { doc: name, ops: tOps, ...(v !== undefined ? { v } : {}) } });
      }
      // an open copy is read again from the tables: it holds exactly what a fresh open would
      if (cache.has(name) || name === writer?.name) refresh(name);
    }
    inOrder(() => {
      // With auth, only to those who may still hear each document (todo #17's rule).
      const asked = auth ? [...changes.map(({ name }) => custom.letGo(name, subscriptions.get(name), options.owns, { dropped: () => unheld(name) })), custom.letGoWatching(applied)] : [];
      const publish = () => {
        for (const { name, change } of changes) ws.publish(name, change);
        custom.tell(applied);
      };
      const waiting = asked.filter((a): a is Promise<void> => isPromise(a));
      if (!waiting.length) return publish();
      return Promise.all(waiting).then(publish);
    });
  }

  /** Read an open document's copy again from the tables. */
  function refresh(docName: string): void {
    const m = findDoc(docName);
    if (!m) return;
    const doc = readDoc(db, schema, m.def, resolveScope(m.def, m.docId));
    if (doc) cache.set(docName, doc);
    else if (m.def.implied) { cache.set(docName, emptyDoc(m.def, m.docId)); implied.add(docName); }
    else cache.delete(docName);
  }

  ws.on("delta", guarded((msg, client, respond) => {
    const docName = msg.doc as string;

    if (custom.find(docName)) {
      respond({ error: { code: 403, message: "Custom docs are read-only; write through the source doc." } });
      return;
    }

    const match = findDoc(docName);
    if (!match) return;
    // every path is a JSON Pointer, asked of the whole write before anything else (400), as delta_apply asks it
    try { for (const op of msg.ops as DeltaOp[]) splitPath(op.path); }
    catch (err: any) { return respond({ error: failure(err) }); }

    heardElsewhere();
    reloadEvicted();
    const doc = cache.get(docName);
    if (!doc) {
      // a name its root's columns cannot take is the writer's mistake (400), as on Postgres, before it is a document not open
      try { whereOf(resolveScope(match.def, match.docId), keeping(db, schema.tables[match.def.root]!)); }
      catch (err: any) { if (typeof err.code === "number") return respond({ error: { code: err.code, message: err.message } }); }
      respond({ error: { code: 404, message: `Doc not loaded: open ${docName} before writing to it` } });
      return;
    }

    const out = write(docName, match.def, doc, msg.ops as DeltaOp[], { who: whoOf(client), cursor: cursorOf(msg, client), undoable: msg.undoable !== false });
    if ("error" in out) return respond(out);
    // A writer that keeps its own history asks for the inverse (or keeps a
    // ledger): what delta applied, walked back, read from the document as it
    // was. Opt-in, so a browser writer is not sent rows it never asked for.
    // as the document shows them: its writer is answered no column it does not hold (the ledger keeps them whole)
    const shown = (o: Written) => ({ ...o, ops: showOps(match.def, schema, o.ops), inverse: showOps(match.def, schema, o.inverse) });
    respond({ result: msg.inverse || ledger ? { ack: true, ...shown(out) } : { ack: true } });
  }, { gatesCustom: false }));

  if (ledger) {
    /**
     * The entry a walk takes: the named change's next (`change`), or else the
     * cursor's; 400 for a change that is not an entry's id, 404 for one that is
     * no change of this cursor's.
     */
    const nextWalk = (way: "undo" | "redo", msg: any, client: any) => {
      const cursor = cursorOf(msg, client);
      if (msg.change == null) {
        const entry = cursor === null ? undefined : way === "undo" ? ledger.nextUndo(cursor) : ledger.nextRedo(cursor);
        return { entry, cursor, named: false };
      }
      if (!isEntryId(msg.change)) return { error: { code: 400, message: "change must be an entry's id: a whole number from 1" } };
      const entry = cursor === null ? null : ledger.changeTip(cursor, msg.change, way === "undo");
      if (entry === null) return { error: { code: 404, message: `Entry ${msg.change} is no change of this cursor's` } };
      return { entry, cursor, named: true };
    };
    /**
     * Undo or redo: the cursor's next entry, walked through the same write path
     * and recorded as walking it -- only the fields it changed, guarded by what
     * it left (`planWalk`). A walk that meets a later write by someone else, or
     * that no longer applies, changes nothing and answers `conflict`; it is
     * recorded all the same, so the next walk goes on to the entry before it.
     * `dry: true` answers what the walk would do and walks nothing; `entry: id`
     * walks only if that is the cursor's next entry (409 otherwise).
     *
     * `change: id` walks one change instead of the cursor's next: the chain
     * that holds that entry, which must be the cursor's own (404), walked at its
     * tip (`ledger.changeTip`). A named walk that meets a conflict, or that the
     * document refuses, walks nothing and records nothing: no cursor has to
     * move past it, and the change stays to be walked once it can be.
     */
    /**
     * An entry's ops with each time as a row now reads it, in UTC (decodeRow): an entry an earlier
     * release kept holds the text it was given ("10:00:00+02:00"), and a walk compares it to the row
     * by the instant it names, and puts it back in the form the row is now read in.
     */
    const inUtc = (ops: DeltaOp[]): DeltaOp[] => ops.map((op) => {
      if (!("value" in op)) return op;
      const [coll, , field] = splitPath(op.path);
      const columns = schema.tables[coll!]?.columns ?? {};
      const time = (col: string) => columns[col]?.type === "timestamptz";
      const value: any = op.value;
      if (field !== undefined) return time(field) ? { ...op, value: utcTime(value) } : op;
      if (value === null || typeof value !== "object") return op;
      return { ...op, value: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, time(k) && v != null ? utcTime(v) : v])) };
    });

    const walk = (way: "undo" | "redo") => (msg: any, client: any, respond: (r: any) => void) => {
      const next = nextWalk(way, msg, client);
      if ("error" in next) return respond(next);
      const { entry, cursor, named } = next;
      if (!entry) return respond({ result: null });
      if (msg.entry != null && msg.entry !== entry.id) {
        return respond({ error: { code: 409, message: `The ${named ? "change" : "cursor"}'s next entry to ${way} is ${entry.id}, not ${msg.entry}` } });
      }
      const match = findDoc(entry.doc);
      if (!match) return;   // written through another registration's document (one ledger, one database): its walk answers
      heardElsewhere();
      reloadEvicted();   // a walk is a write: its fan-out needs every open doc's copy, as delta's does
      // a single document whose root is gone (removed through it) is walked from
      // its root absent, as Postgres reads it: an undo of the removal puts it back
      const doc = load(entry.doc, match.def, match.docId) ?? rootless(match.def, match.docId);
      try {
        // an implied document whose root row is not written yet holds no root to guard
        // what removing a row would take with it: the rows its cascade reaches
        const under = (key: string) => {
          const [coll, id] = splitPath(key);
          const table = schema.tables[coll!];
          return table && id !== undefined ? cascadeRows(table, id).slice(1).map(({ table: t, row }) => joinPath(t.docKey, String(row.id))) : [];
        };
        // a row outside the document the entry's cascade took is guarded by the tables, as they hold it now
        const outside = [...entry.ops, ...entry.inverse].flatMap((op) => {
          const [coll, id] = splitPath(op.path);
          const table = schema.tables[coll!];
          const row = table && id !== undefined && coll !== match.def.root && !match.def.include.includes(coll!) ? readRow(table, rowId(id)) : null;
          return row ? [{ coll: coll!, row }] : [];
        });
        const plan = planWalk({ ops: inUtc(entry.ops), inverse: inUtc(entry.inverse) }, besides(implied.has(entry.doc) ? { ...doc, [match.def.root]: null } : doc, outside), under);
        const show = (ops: DeltaOp[]) => showOps(match.def, schema, ops);   // as the document shows them (todo #70)
        if (msg.dry) return respond({ result: { doc: entry.doc, entry: entry.id, ops: show(plan.ops), ...(plan.conflict.length ? { conflict: plan.conflict } : {}) } });
        const by = { who: whoOf(client), cursor };
        const out = plan.conflict.length || !plan.ops.length ? null : write(entry.doc, match.def, doc, plan.ops, { ...by, undoes: entry.id });
        if (out && !("error" in out) && out.entry !== undefined) return respond({ result: { doc: entry.doc, ...out, ops: show(out.ops), inverse: show(out.inverse) } });
        if (out && "error" in out && out.error.code >= 500) return respond(out);
        const conflict = plan.conflict.length ? plan.conflict : out && "error" in out ? plan.ops.map((o) => o.path) : undefined;
        const said = conflict ? { conflict } : {};
        // named, it is left as it is: nothing walked, nothing recorded
        if (named) return respond({ result: { doc: entry.doc, ops: [], inverse: [], version: ledger.version(entry.doc), ...said } });
        // A conflict, a walk the document refuses, or one that changes nothing: walked all the same.
        const skipped = ledger.skip({ doc: entry.doc, ...by, undoes: entry.id });
        options.committed?.();
        respond({ result: { doc: entry.doc, ops: [], inverse: [], version: skipped.version, entry: skipped.entry, ...said } });
      } finally {
        if (!subscriptions.has(entry.doc)) cache.delete(entry.doc); // loaded for this walk only
      }
    };
    /**
     * With `auth`, a walk passes the gate (401) and writes to its entry's
     * document only for one who owns it (404), as on Postgres: asked of the
     * cursor's next entry, which the walk then takes alone (409 if it has
     * moved on meanwhile).
     */
    const walkAs = (way: "undo" | "redo") => {
      const walked = underLock(walk(way));
      return (msg: any, client: any, respond: (r: any) => void) => {
        if (!auth) return walked(msg, client, respond);
        const g = gated(client);
        if ("error" in g) return respond(g);
        const next = nextWalk(way, msg, client);
        const entry = "error" in next ? undefined : next.entry;
        if (!entry || !options.owns || !findDoc(entry.doc)) return walked(msg, client, respond);   // another registration's: it asks its own owns
        return whenOwned(options.owns(g.identity, entry.doc), respond, () => walked(msg.entry == null ? { ...msg, entry: entry.id } : msg, client, respond));
      };
    };
    ws.on("undo", walkAs("undo"));
    ws.on("redo", walkAs("redo"));
    // A document's recent history, to whoever may open it: each entry says `mine`, never who wrote it.
    ws.on("history", guarded((msg, client, respond) => {
      const match = findDoc(msg.doc);
      if (!match) return;
      let there: unknown;
      try { there = match.def.implied || readDoc(db, schema, match.def, resolveScope(match.def, match.docId)); }
      catch (err: any) { return respond({ error: failure(named(err)) }); }
      if (!there) return respond({ error: NOT_FOUND });
      respond({ result: ledger.history(msg.doc, cursorOf(msg, client), msg.limit).map((e) => ({ ...e, ops: showOps(match.def, schema, e.ops), inverse: showOps(match.def, schema, e.inverse) })) });
    }));
  }

  // A document as it stood at a time (`at`, ISO-8601): its temporal rows as they were then, as on Postgres.
  ws.on("open_at", guarded((msg, _client, respond) => {
    const match = findDoc(msg.doc as string);
    if (!match) return;
    if (!msg.at) return respond({ error: { code: 400, message: "at is required" } });
    let doc: any;
    try { doc = loadDocAt(db, schema, match.def, match.docId, String(msg.at)); }
    catch (err: any) { return respond({ error: failure(named(err)) }); }
    respond(doc ? { result: showDoc(match.def, schema, doc, resolveScope(match.def, match.docId).mode === "single") } : { error: NOT_FOUND });
  }));

  ws.on("close", guarded((msg, client, respond) => {
    const docName = msg.doc as string;
    const isCustom = custom.find(docName) != null;
    if (!isCustom && !findDoc(docName)) return;

    trackUnsubscribe(client, docName);
    if (isCustom) custom.leave(client, docName);
    else if (subscriptions.get(docName)?.delete(client)) unheld(docName);

    respond({ result: { ack: true } });
    log.debug(`closed ${docName}`);
  }, { owned: false, gatesCustom: false }));

  return {
    /**
     * Drop a doc's cached copy; the next open, write or fan-out that needs it
     * reads it again from the tables (`reloadEvicted`). Its subscribers stay
     * subscribed, and re-open to see what changed.
     */
    evict(docName: string) {
      cache.delete(docName);
      implied.delete(docName);
      custom.forget(docName);
    },
  };
}

// ---------------------------------------------------------------------------
// Inverse
// ---------------------------------------------------------------------------

/** A row as a write may carry it: its temporal columns are storage, not data. */
function withoutStorage(row: any): any {
  if (!row || typeof row !== "object" || !("valid_from" in row || "valid_to" in row)) return row;
  const { valid_from: _from, valid_to: _to, ...data } = row;
  return data;
}

/** A row's path as a write tells it: its id as kept (`/courses/007` is told at /courses/7). */
function toldAt(path: string): string {
  const parts = splitPath(path);
  return parts.length === 2 ? joinPath(parts[0]!, String(rowId(parts[1]!))) : path;
}

/**
 * The inverse of a write, from the document as it was before and the ops the
 * backend applied. Applied ops are whole rows (`/coll/id`) or the root
 * (`/root`; added or removed, `/root/id`, read where the document holds it:
 * `rowAt`), so the inverse of each is the row as it was: an add is removed,
 * a remove is added back, a replace is replaced by its old self. Written in
 * reverse order, except that a remove and the rows its removal cascaded to (a
 * run) are added back in their own order, parent first, so each child finds
 * its parent in scope.
 *
 * `asked`, the ops as the caller sent them, says where each run starts: at a
 * remove the caller asked for. An undo's removes come children first, each
 * asked for, so each is its own run, and the runs come back in reverse: parent
 * first again. Without `asked`, removes one after another are taken for one
 * run, which is right only for a single remove and its cascade.
 *
 * A single document's root written and then removed by the write is one row
 * at two paths (`/<root>`, `/<root>/<id>`): the add that takes back its
 * removal puts it back as it was before the write, so its replaces before the
 * removal have no inverse of their own -- a walk would find `/<root>` gone.
 *
 * A row the write makes and takes out again never was outside it: its make,
 * and what it had since, walk back nothing, and its removal adds nothing back
 * -- `[add, remove]` inverts to `[]`, `[add, remove, add]` to `[remove]` (todo #67).
 */
export function inverseOf(before: any, applied: DeltaOp[], asked?: DeltaOp[]): DeltaOp[] {
  const heads = asked && new Set(asked.filter((op) => op.op === "remove").map((op) => toldAt(op.path)));
  let inverse: DeltaOp[] = [];
  let run: DeltaOp[] = [];
  const made = new Map<string, DeltaOp[]>();   // each row the write made, by path: its inverse since
  const flush = () => {
    inverse.unshift(...run);
    run = [];
  };
  const rootAt = (coll: string) => (before?.[coll]?.id != null ? joinPath(coll, String(before[coll].id)) : undefined);
  const lastRemoved = new Map<string, number>();   // each path the write removes, at its last remove: one pass, however long the write
  applied.forEach((op, i) => { if (op.op === "remove") lastRemoved.set(op.path, i); });
  for (const [i, op] of applied.entries()) {
    const parts = splitPath(op.path);
    const root = parts.length === 1 ? rootAt(parts[0]!) : undefined;
    if (op.op === "replace" && root !== undefined && (lastRemoved.get(root) ?? -1) > i) continue;
    if (op.op === "remove" && made.has(op.path)) {
      const since = new Set(made.get(op.path));
      made.delete(op.path);
      inverse = inverse.filter((back) => !since.has(back));
      continue;
    }
    const prior = withoutStorage(rowAt(before, op.path)) ?? null;   // null: not there before the write (made by it), as Postgres says it
    if (op.op === "remove") {
      if (heads?.has(op.path)) flush();   // a remove asked for starts its own run; one it cascaded to joins it
      run.push({ op: "add", path: op.path, value: prior });
      continue;
    }
    flush();
    const back: DeltaOp = op.op === "add" ? { op: "remove", path: op.path } : { op: "replace", path: op.path, value: prior };
    inverse.unshift(back);
    if (op.op === "add") made.set(op.path, [back]);
    else made.get(op.path)?.push(back);
  }
  flush();
  return inverse;
}

