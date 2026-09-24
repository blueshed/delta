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
import { trackSubscribe, trackUnsubscribe, onClientDrop } from "./server";
import { applyOps as deltaApplyOps, type DeltaOp, splitPath, joinPath } from "../core";
import { createLogger } from "./logger";
import { createLedger, socketCursor } from "./ledger";
import {
  type ColumnDef,
  type Schema,
  type ResolvedTable,
  type DocDef,
  type ValidationError,
  defineSchema as defineSchemaShared,
  defineDoc as defineDocShared,
} from "../schema";

export type {
  ColumnType,
  ColumnDef,
  ColumnShorthand,
  TableDef,
  Schema,
  ResolvedTable,
  DocDef,
  ValidationError,
} from "../schema";
export const defineSchema = defineSchemaShared;
export const defineDoc = defineDocShared;

// ---------------------------------------------------------------------------
// Custom doc definition — predicate-based membership over watched collections.
// ---------------------------------------------------------------------------

export interface CustomDocDef<C = unknown> {
  /** Doc name prefix (e.g. "sites-in-bbox:"). */
  prefix: string;
  /** Collections the doc watches for cross-pollination. */
  watch: string[];
  /** Parse the portion of docName after prefix into criteria. */
  parse: (docId: string) => C;
  /** Initial load. Return the rows this doc should expose, keyed by collection. */
  query: (db: any, criteria: C) => Record<string, any[]>;
  /** True when `row` belongs in a doc opened under `criteria`. */
  matches: (collection: string, row: any, criteria: C) => boolean;
}

export function defineCustomDoc<C>(
  prefix: string,
  opts: Omit<CustomDocDef<C>, "prefix">,
): CustomDocDef<C> {
  return { prefix, ...opts };
}

// ---------------------------------------------------------------------------
// createTables
// ---------------------------------------------------------------------------

/** Generate CREATE TABLE statements from the schema and execute them. */
export function createTables(db: any, schema: Schema) {
  db.run("PRAGMA journal_mode = WAL");

  for (const [, table] of Object.entries(schema.tables)) {
    const cols: string[] = ["id TEXT NOT NULL"];

    // FK columns from parent
    if (table.parent) {
      cols.push(`${table.parent.fkColumn} TEXT NOT NULL`);
    }

    // User-defined columns
    for (const [col, def] of Object.entries(table.columns)) {
      const sqlType = columnSqlType(def);
      const notNull = def.nullable ? "" : " NOT NULL";
      const defaultVal = def.default !== undefined ? ` DEFAULT ${sqlDefault(def.default)}` : "";
      cols.push(`${col} ${sqlType}${notNull}${defaultVal}`);
    }

    if (table.temporal) {
      cols.push("valid_from TEXT NOT NULL DEFAULT (datetime('now'))");
      cols.push("valid_to TEXT");
      cols.push("PRIMARY KEY (id, valid_from)");
    } else {
      cols.push("PRIMARY KEY (id)");
    }

    db.run(`CREATE TABLE IF NOT EXISTS ${table.name} (${cols.join(", ")})`);

    // Current-state view and indexes for temporal tables
    if (table.temporal) {
      db.run(
        `CREATE VIEW IF NOT EXISTS current_${table.name} AS SELECT * FROM ${table.name} WHERE valid_to IS NULL`,
      );
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_${table.name}_id_valid ON ${table.name} (id, valid_to)`,
      );
    }

    // FK index for child tables
    if (table.parent) {
      db.run(
        `CREATE INDEX IF NOT EXISTS idx_${table.name}_${table.parent.fkColumn} ON ${table.name} (${table.parent.fkColumn})`,
      );
    }
  }
}

function columnSqlType(def: ColumnDef): string {
  switch (def.type) {
    // SQLite stores timestamps as TEXT (ISO-8601) — the conventional mapping
    // for `timestamptz` from the shared schema vocabulary.
    case "text": case "json": case "timestamptz": return "TEXT";
    case "integer": case "boolean": return "INTEGER";
    case "real": return "REAL";
  }
}

function sqlDefault(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "NULL";
}

// ---------------------------------------------------------------------------
// registerDocs
// ---------------------------------------------------------------------------

const log = createLogger("[delta-sqlite]");

/** Register all doc definitions with the WebSocket server. */
export interface RegisterOptions {
  /**
   * Keep a ledger (`./ledger`): every write recorded with its inverse, its
   * version, who made it and the cursor undo walks; and `undo`, `redo` and
   * `history` actions over it.
   */
  ledger?: boolean;
  /** How an identity is written in the ledger. Default: a string or number as it is, anything else as JSON. */
  who?: (identity: unknown) => string;
}

export function registerDocs(
  ws: WsServer,
  db: any,
  schema: Schema,
  docs: DocDef[],
  customDocs: CustomDocDef<any>[] = [],
  options: RegisterOptions = {},
) {
  const ledger = options.ledger ? createLedger(db) : undefined;
  const whoOf = (client: any): string | null => {
    const identity = client?.data?.identity;
    if (identity === undefined || identity === null) return null;
    if (options.who) return options.who(identity);
    return typeof identity === "string" || typeof identity === "number" ? String(identity) : JSON.stringify(identity);
  };
  // The cursor undo walks: named by a caller in this process (`createLocal`),
  // and over the socket the connection itself -- signed in, the person and the
  // connection together, so another person holding the same connection id
  // (a client may choose it, to keep its cursor across a reconnect) cannot walk it.
  const cursorOf = (msg: any, client: any): string | null =>
    client?.data?.local ? (typeof msg.cursor === "string" ? msg.cursor : null) : socketCursor(whoOf(client), client?.data?.clientId);
  // Build lookup: prefix → DocDef
  const docByPrefix = new Map<string, DocDef>();
  for (const doc of docs) {
    // A Postgres scope binding would be taken here as a literal to match, and
    // the document would open as 404 for every name: say so at registration.
    for (const [col, binding] of Object.entries(doc.scope)) {
      if (binding !== ":docId" && /^(:|=:|<=:|>=:|like:|at:)/.test(binding)) {
        throw new Error(
          `registerDocs("${doc.prefix}"): scope { ${col}: "${binding}" } is the Postgres scope DSL; ` +
          `SQLite reads the doc name with ":docId" only (scope: { ${col}: ":docId" })`,
        );
      }
    }
    docByPrefix.set(doc.prefix, doc);
  }

  // Custom doc lookup: prefix → CustomDocDef
  const customByPrefix = new Map<string, CustomDocDef<any>>();
  for (const cd of customDocs) {
    customByPrefix.set(cd.prefix, cd);
  }

  // Which collections are watched by any custom doc type.
  const watchedCollections = new Set<string>();
  for (const cd of customDocs) {
    for (const coll of cd.watch) watchedCollections.add(coll);
  }

  // In-memory doc cache: docName → loaded doc object
  const cache = new Map<string, any>();

  // Open implied docs whose root row has not been written yet.
  const implied = new Set<string>();

  function emptyDoc(def: DocDef, docId: string): any {
    const rootTable = schema.tables[def.root]!;
    const root: any = { id: docId };
    for (const [col, colDef] of Object.entries(rootTable.columns)) {
      root[col] = colDef.default ?? (colDef.nullable ? null : defaultForType(colDef.type));
    }
    const doc: any = { [def.root]: root };
    for (const coll of def.include) doc[coll] = {};
    return doc;
  }

  function ensureImpliedRoot(def: DocDef, doc: any): void {
    const rootTable = schema.tables[def.root]!;
    const viewName = rootTable.temporal ? `current_${rootTable.name}` : rootTable.name;
    const root = doc[def.root];
    if (db.query(`SELECT 1 FROM ${viewName} WHERE id = ?`).get(root.id)) return;
    const ts = now();
    if (rootTable.temporal) { root.valid_from = ts; root.valid_to = null; }
    insertRow(db, rootTable, root, ts);
  }

  // Parsed criteria per open custom doc name (shared across clients of the same name).
  const customCriteria = new Map<string, unknown>();

  // Track which doc names are subscribed (for scoped fan-out)
  const subscriptions = new Map<string, Set<any>>(); // docName → Set<ws clients>

  function findDoc(docName: string): { def: DocDef; docId: string } | null {
    for (const [prefix, def] of docByPrefix) {
      if (docName.startsWith(prefix)) {
        return { def, docId: docName.slice(prefix.length) };
      }
    }
    return null;
  }

  function findCustom(docName: string): { def: CustomDocDef<any>; docId: string } | null {
    for (const [prefix, def] of customByPrefix) {
      if (docName.startsWith(prefix)) {
        return { def, docId: docName.slice(prefix.length) };
      }
    }
    return null;
  }

  // Transport-level teardown (socket drop / logout via dropClientSubscriptions):
  // a dropped socket never sends the polite `close` action, so without this
  // every abandoned doc stayed cached forever and its dead socket sat in
  // `subscriptions`, growing the fan-out set monotonically (v0.5.0 review #7).
  // Mirrors the `close`-action eviction below.
  function releaseClient(client: any): void {
    for (const [docName, subs] of subscriptions) {
      if (!subs.delete(client)) continue;
      if (subs.size === 0) {
        subscriptions.delete(docName);
        cache.delete(docName);
        implied.delete(docName);
        customCriteria.delete(docName);
      }
    }
  }

  function resolveScope(def: DocDef, docId: string): Record<string, string> {
    const resolved: Record<string, string> = {};
    if (Object.keys(def.scope).length === 0) {
      // Default: root table PK = docId
      resolved["id"] = docId;
    } else {
      // Split docId by ":" for compound scopes
      const parts = docId.split(":");
      let i = 0;
      for (const [col, binding] of Object.entries(def.scope)) {
        if (binding === ":docId") {
          resolved[col] = parts[i++] ?? docId;
        } else {
          resolved[col] = binding;
        }
      }
    }
    return resolved;
  }

  // ---------------------------------------------------------------------------
  // Load doc from SQL
  // ---------------------------------------------------------------------------

  function loadDocFromSql(def: DocDef, scope: Record<string, string>): any | null {
    const rootTable = schema.tables[def.root];
    if (!rootTable) return null;

    const viewName = rootTable.temporal ? `current_${rootTable.name}` : rootTable.name;

    // Build WHERE clause from scope
    const whereParts = Object.keys(scope).map((k) => `${k} = ?`);
    const whereParams = Object.values(scope);

    const rows = db.query(`SELECT * FROM ${viewName} WHERE ${whereParts.join(" AND ")}`).all(...whereParams);
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      // A single-mode doc exposes exactly one root row. A scope that matches
      // several (e.g. a non-unique column) silently drops all but the first
      // here AND only loads the first row's children — surface it.
      console.warn(
        `[delta-sqlite] scope for doc root "${def.root}" matched ${rows.length} rows; using the first only. A single-mode doc's scope must match at most one row.`,
      );
    }
    const rootRow = rows[0];
    decodeRow(rootTable, rootRow);

    const doc: any = { [def.root]: rootRow };

    // Load each included collection
    for (const collKey of def.include) {
      const table = schema.tables[collKey];
      if (!table) continue;

      const collRows = loadCollection(table, def, rootRow, scope);
      // Apply field codecs
      for (const row of collRows) {
        decodeRow(table, row);
      }
      doc[collKey] = toMap(collRows);
    }

    return doc;
  }

  /** Recursively load a collection's rows by walking up to find the join path to the root. */
  function loadCollection(table: ResolvedTable, def: DocDef, rootRow: any, scope: Record<string, string>): any[] {
    if (!table.parent) {
      // No parent — must be filtered by scope directly
      const viewName = table.temporal ? `current_${table.name}` : table.name;
      const whereParts = Object.keys(scope).map((k) => `${k} = ?`);
      return db.query(`SELECT * FROM ${viewName} WHERE ${whereParts.join(" AND ")}`).all(...Object.values(scope));
    }

    const parentCollection = table.parent.collection;

    if (parentCollection === def.root) {
      // Direct child of root — filter by FK = root ID
      const viewName = table.temporal ? `current_${table.name}` : table.name;
      return db.query(`SELECT * FROM ${viewName} WHERE ${table.parent.fkColumn} = ?`).all(rootRow.id);
    }

    // Grandchild — load parent rows first, then filter by their IDs
    const parentTable = schema.tables[parentCollection];
    if (!parentTable) return [];
    const parentRows = loadCollection(parentTable, def, rootRow, scope);
    const parentIds = parentRows.map((r: any) => r.id);
    if (parentIds.length === 0) return [];

    const viewName = table.temporal ? `current_${table.name}` : table.name;
    const placeholders = parentIds.map(() => "?").join(", ");
    return db.query(`SELECT * FROM ${viewName} WHERE ${table.parent.fkColumn} IN (${placeholders})`).all(...parentIds);
  }

  // ---------------------------------------------------------------------------
  // Delta ops → SQL
  // ---------------------------------------------------------------------------

  function applyOps(docName: string, def: DocDef, doc: any, ops: DeltaOp[]): DeltaOp[] {
    const scope = resolveScope(def, docName.slice(def.prefix.length));
    const rootId = scope["id"] ?? doc[def.root]?.id;
    const broadcastOps: DeltaOp[] = [];

    // Separate row-field updates for batching
    const rowFieldBatches = new Map<string, { table: ResolvedTable; id: string; fields: Map<string, unknown> }>();
    // Root-level field updates are batched too: applying them one-at-a-time
    // did closeRow+insert per op, so two root-field replaces in one delta
    // collided on the temporal PK (same valid_from). Accumulate and emit one
    // close+insert for the whole delta.
    const rootFieldUpdates = new Map<string, unknown>();

    for (const op of ops) {
      const parts = splitPath(op.path);
      const collKey = parts[0]!;
      const table = schema.tables[collKey];

      // Root-level field update: /<root>/fieldName
      if (collKey === def.root && parts.length === 2) {
        if (op.op !== "replace") throw new Error(`Root fields only support replace`);
        rootFieldUpdates.set(parts[1]!, (op as any).value);
        continue;
      }

      // Whole-root replace: /<root> — merge the value's fields into the root
      // row (Postgres parity: delta_apply merges over the current row). The
      // path carries the row identity, so `id` and the temporal columns are
      // ignored rather than trusted from the value.
      if (collKey === def.root && parts.length === 1) {
        if (op.op !== "replace") throw new Error(`Root supports replace only`);
        for (const [field, value] of Object.entries((op as any).value as Record<string, unknown>)) {
          if (field === "id" || field === "valid_from" || field === "valid_to") continue;
          rootFieldUpdates.set(field, value);
        }
        continue;
      }

      if (!table || !def.include.includes(collKey)) {
        throw new Error(`Unknown collection: ${collKey}`);
      }

      if (parts.length === 2) {
        // `add /<coll>/-` is a new row the server names: a uuid, carried by the
        // broadcast path and the row, as Postgres does with its sequence.
        const id = op.op === "add" && parts[1] === "-" ? crypto.randomUUID() : parts[1]!;
        if (op.op === "add") {
          // Add row
          const row = (op as any).value as Record<string, unknown>;
          // A DIRECT child's FK is forced to `rootId` by insertCollectionRow, but a
          // grandchild's comes verbatim from the client. Unchecked, that grafts the
          // new row onto another doc's parent — a cross-doc write. Require the named
          // parent to be in THIS doc's scope.
          assertParentInScope(doc, def, table, row);
          const ts = now();
          const fullRow = insertCollectionRow(db, schema, table, id, rootId, def, row, ts);
          doc[collKey][id] = fullRow;
          broadcastOps.push({ op: "add", path: joinPath(collKey, id), value: fullRow });
        } else if (op.op === "remove") {
          // Remove row + cascades. `removeRow` addresses rows by id ALONE, so
          // without this gate a client could name any id and delete a sibling
          // doc's row (the field-replace path below has always made the
          // equivalent check via `doc[collKey]?.[id]`).
          assertRowInScope(doc, collKey, id);
          const cascadeOps = removeRow(db, schema, table, collKey, id, doc, def);
          broadcastOps.push(...cascadeOps);
        } else if (op.op === "replace") {
          // Whole-row replace: /<coll>/<id> — a partial merge over the current
          // row (Postgres parity: delta_apply does `v_row || value`). Rides the
          // field-batch writer below so it collapses with field-level ops on
          // the same row and shares the temporal/non-temporal write path.
          // validateOps accepted this shape all along, but it used to fall
          // through here and ack as a silent no-op (v0.5.0 review #3).
          const key = `${collKey}/${id}`;
          if (!rowFieldBatches.has(key)) {
            rowFieldBatches.set(key, { table, id, fields: new Map() });
          }
          const fields = rowFieldBatches.get(key)!.fields;
          for (const [field, value] of Object.entries((op as any).value as Record<string, unknown>)) {
            if (field === "id" || field === "valid_from" || field === "valid_to") continue;
            fields.set(field, value);
          }
        }
      } else if (parts.length === 3 && op.op === "replace") {
        // Field update — batch per row
        const id = parts[1]!;
        const field = parts[2]!;
        const key = `${collKey}/${id}`;
        if (!rowFieldBatches.has(key)) {
          rowFieldBatches.set(key, { table, id, fields: new Map() });
        }
        rowFieldBatches.get(key)!.fields.set(field, (op as any).value);
      } else {
        throw new Error(`Invalid op: ${op.op} ${op.path}`);
      }
    }

    // Apply batched root-field updates as a single close + reinsert (temporal)
    // or one in-place UPDATE (non-temporal — `id` is the whole PK there, so a
    // reinsert would collide).
    if (rootFieldUpdates.size > 0) {
      const rootTable = schema.tables[def.root]!;
      const ts = now();
      if (rootTable.temporal) closeRow(db, rootTable, rootId, ts);
      const updated = { ...doc[def.root] };
      for (const [field, value] of rootFieldUpdates) updated[field] = value;
      if (rootTable.temporal) {
        updated.valid_from = ts; updated.valid_to = null;
        insertRow(db, rootTable, updated, ts);
      } else {
        updateRow(db, rootTable, rootId, updated);
      }
      doc[def.root] = updated;
      broadcastOps.push({ op: "replace", path: joinPath(def.root), value: updated });
    }

    // Apply batched field updates
    for (const [, batch] of rowFieldBatches) {
      const collKey = batch.table.docKey;
      const current = doc[collKey]?.[batch.id];
      if (!current) refuse(404, `Row not found: ${collKey}/${batch.id}`);

      const ts = now();
      if (batch.table.temporal) closeRow(db, batch.table, batch.id, ts);

      const updated = { ...current };
      if (batch.table.temporal) { updated.valid_from = ts; updated.valid_to = null; }
      for (const [field, value] of batch.fields) {
        updated[field] = value;
      }
      if (batch.table.temporal) insertRow(db, batch.table, updated, ts);
      else updateRow(db, batch.table, batch.id, updated);
      doc[collKey][batch.id] = updated;
      broadcastOps.push({ op: "replace", path: joinPath(collKey, batch.id), value: updated });
    }

    return broadcastOps;
  }

  // ---------------------------------------------------------------------------
  // WebSocket handlers
  // ---------------------------------------------------------------------------

  ws.on("open", (msg, client, respond) => {
    const docName = msg.doc as string;

    // Custom doc path first (independent prefix space).
    const customMatch = findCustom(docName);
    if (customMatch) {
      const doc = loadCustom(docName, customMatch.def, customMatch.docId);

      trackSubscribe(client, docName);
      if (!subscriptions.has(docName)) subscriptions.set(docName, new Set());
      subscriptions.get(docName)!.add(client);
      onClientDrop(client, releaseClient);

      respond({ result: doc });
      log.info(`opened ${docName} (custom)`);
      return;
    }

    const match = findDoc(docName);
    if (!match) return;

    let doc: any;
    try { doc = load(docName, match.def, match.docId); }
    catch (err: any) { return respond({ error: { code: 500, message: named(err).message } }); }
    if (!doc) {
      // Say why: a SQLite document is one root row (there is no list mode).
      const where = Object.entries(resolveScope(match.def, match.docId)).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(" and ");
      respond({ error: { code: 404, message: `Not found: no ${match.def.root} row where ${where}. A SQLite document is one root row and its children: make the row first, or declare the document implied: true` } });
      return;
    }

    trackSubscribe(client, docName);
    if (!subscriptions.has(docName)) subscriptions.set(docName, new Set());
    subscriptions.get(docName)!.add(client);
    onClientDrop(client, releaseClient);

    // with a ledger, the version the document is at, as the Postgres backend's open says it (`_v`),
    // so a copy kept from the stream of changes knows where it starts
    respond({ result: ledger ? { ...doc, _v: ledger.version(docName) } : doc });
    log.info(`opened ${docName}`);
  });

  /** A custom document from the cache, or queried into it. */
  function loadCustom(docName: string, def: CustomDocDef<any>, docId: string): any {
    let doc = cache.get(docName);
    if (!doc) {
      const criteria = def.parse(docId);
      const rowsByColl = def.query(db, criteria);
      doc = {};
      for (const coll of def.watch) doc[coll] = toMap(rowsByColl[coll] ?? []);
      cache.set(docName, doc);
      customCriteria.set(docName, criteria);
    }
    return doc;
  }

  /** A document from the cache, or loaded into it: an implied one opens empty, and its first write makes its row. */
  function load(docName: string, def: DocDef, docId: string): any | null {
    let doc = cache.get(docName);
    if (doc) return doc;
    doc = loadDocFromSql(def, resolveScope(def, docId));
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
   * The one write path -- a fresh write, an undo, a redo: validated, applied in
   * one transaction with its ledger entry (a savepoint inside a caller's own),
   * and then told: to the document's subscribers, to the other open documents
   * that share its rows, and to the custom documents that watch them.
   */
  /**
   * Read back every doc someone has open that `evict()` dropped, before a
   * write: fan-out checks a target's scope against its copy, and one with no
   * copy used to lose its removes and grandchildren for good (v0.5.0 review #6).
   */
  function reloadEvicted(): void {
    for (const [name, subs] of subscriptions) {
      if (!subs.size || cache.has(name)) continue;
      const custom = findCustom(name);
      const match = custom ? null : findDoc(name);
      if (custom) loadCustom(name, custom.def, custom.docId);
      else if (match) load(name, match.def, match.docId);
    }
  }

  function write(docName: string, def: DocDef, doc: any, ops: DeltaOp[], by: { who: string | null; cursor: string | null; undoes?: number; undoable?: boolean }): Written | Failed {
    // Pre-flight validation — reject unknown collections/fields and bad types
    // up front instead of silently acking an op that diverges cache/broadcast
    // from what the DB can persist.
    const validationErrors = validateOps(schema, def, ops);
    if (validationErrors.length) {
      return { error: { code: 400, message: validationErrors.map((e) => `${e.path}: ${e.message}`).join("; ") } };
    }

    const snapshot = structuredClone(doc); // for rollback, and for the inverse
    let written: Written;
    try {
      // `db.transaction` rather than a bare BEGIN: inside a caller's own
      // transaction (a server-side renderer writing several things as one, a
      // test that rolls every case back) it becomes a savepoint, and still
      // rolls back alone. Rollback owns only this region: a failure in the
      // post-commit block below must not look like a failed write.
      written = db.transaction(() => {
        if (implied.has(docName)) ensureImpliedRoot(def, doc);
        const applied = applyOps(docName, def, doc, ops);
        const inverse = inverseOf(snapshot, applied);
        const recorded = ledger?.record({ doc: docName, ops: applied, inverse, ...by });
        return { ops: applied, inverse, version: recorded?.version, entry: recorded?.entry };
      })();
      implied.delete(docName);
    } catch (err: any) {
      cache.set(docName, snapshot); // restore in-memory cache
      named(err);
      log.error(`delta failed: ${err.message}`);
      // A refusal carries its wire code (`refuse`); anything else is the server's.
      return { error: { code: typeof err.code === "number" ? err.code : 500, message: err.message } };
    }

    // Committed. Fan-out is a post-commit side effect: a failure here must not
    // roll back (the write is durable) nor masquerade as a write error.
    try {
      // Primary broadcast: to the doc's own subscribers -- and, through
      // `createLocal().onPublish`, the one stream of changes an in-process
      // caller (eta) redraws from
      ws.publish(docName, { doc: docName, ops: written.ops, ...(written.version !== undefined ? { v: written.version } : {}) });
      // Cross-doc fan-out: find other open docs affected by these changes
      fanOut(ws, written.ops, docName);
      // Custom-doc cross-pollination: predicate-based membership.
      customFanOut(written.ops);
    } catch (err: any) {
      log.error(`delta fan-out failed (write committed): ${err.message}`);
    }
    log.info(`delta ${docName} [${ops.map((o: DeltaOp) => `${o.op} ${o.path}`).join(", ")}]`);
    return written;
  }

  ws.on("delta", (msg, client, respond) => {
    const docName = msg.doc as string;

    if (findCustom(docName)) {
      respond({ error: { code: 403, message: "Custom docs are read-only; write through the source doc." } });
      return;
    }

    const match = findDoc(docName);
    if (!match) return;

    reloadEvicted();
    const doc = cache.get(docName);
    if (!doc) {
      respond({ error: { code: 404, message: `Doc not loaded: open ${docName} before writing to it` } });
      return;
    }

    const out = write(docName, match.def, doc, msg.ops as DeltaOp[], { who: whoOf(client), cursor: cursorOf(msg, client), undoable: msg.undoable !== false });
    if ("error" in out) return respond(out);
    // A writer that keeps its own history asks for the inverse (or keeps a
    // ledger): what delta applied, walked back, read from the document as it
    // was. Opt-in, so a browser writer is not sent rows it never asked for.
    respond({ result: msg.inverse || ledger ? { ack: true, ...out } : { ack: true } });
  });

  if (ledger) {
    /** Undo or redo: the cursor's next entry, walked through the same write path, recorded as walking it. */
    const walk = (way: "undo" | "redo") => (msg: any, client: any, respond: (r: any) => void) => {
      const cursor = cursorOf(msg, client);
      const entry = cursor === null ? undefined : way === "undo" ? ledger.nextUndo(cursor) : ledger.nextRedo(cursor);
      if (!entry) return respond({ result: null });
      const match = findDoc(entry.doc);
      const doc = match && load(entry.doc, match.def, match.docId);
      if (!match || !doc) return respond({ error: { code: 404, message: `Not found: ${entry.doc}` } });
      const out = write(entry.doc, match.def, doc, entry.inverse, { who: whoOf(client), cursor, undoes: entry.id });
      if (!subscriptions.has(entry.doc)) cache.delete(entry.doc); // loaded for this walk only
      respond("error" in out ? out : { result: { doc: entry.doc, ...out } });
    };
    ws.on("undo", walk("undo"));
    ws.on("redo", walk("redo"));
    // A document's recent history: each entry says `mine`, never who wrote it.
    ws.on("history", (msg, client, respond) => {
      if (!findDoc(msg.doc)) return;
      respond({ result: ledger.history(msg.doc, cursorOf(msg, client), msg.limit) });
    });
  }

  ws.on("close", (msg, client, respond) => {
    const docName = msg.doc as string;
    const isCustom = findCustom(docName) != null;
    const isStandard = findDoc(docName) != null;
    if (!isCustom && !isStandard) return;

    trackUnsubscribe(client, docName);
    subscriptions.get(docName)?.delete(client);
    if (subscriptions.get(docName)?.size === 0) {
      subscriptions.delete(docName);
      cache.delete(docName); // evict when no subscribers
      implied.delete(docName);
      if (isCustom) customCriteria.delete(docName);
    }

    respond({ result: { ack: true } });
    log.debug(`closed ${docName}`);
  });

  // ---------------------------------------------------------------------------
  // Cross-doc fan-out
  // ---------------------------------------------------------------------------

  /**
   * True if `row` (in `coll`) belongs to the doc identified by (`def`,`docId`),
   * tracing the parent-FK chain. For grandchildren, walks up via `cached` —
   * the target doc's own cache — because each link of the chain must already
   * be in scope for the row itself to be in scope.
   */
  function rowInScope(
    coll: string,
    row: any,
    def: DocDef,
    docId: string,
    cached: any,
  ): boolean {
    if (!row) return false;
    if (coll === def.root) return String(row.id) === docId;
    const table = schema.tables[coll];
    if (!table?.parent) return true;                  // unscoped collection — preserve existing behaviour
    const fkVal = row[table.parent.fkColumn];
    if (fkVal == null) return false;
    const parentColl = table.parent.collection;
    if (parentColl === def.root) return String(fkVal) === docId;
    const parentRow = cached?.[parentColl]?.[String(fkVal)];
    if (!parentRow) return false;                     // parent isn't in this doc's scope
    return rowInScope(parentColl, parentRow, def, docId, cached);
  }

  /** Forward relevant delta ops to other subscribed docs that share affected collections. */
  function fanOut(ws: WsServer, ops: DeltaOp[], sourceDocName: string) {
    for (const [docName] of subscriptions) {
      if (docName === sourceDocName) continue;

      const match = findDoc(docName);
      if (!match) continue;
      const { def, docId } = match;
      const cached = cache.get(docName);

      // Filter to ops that (a) affect a collection this doc includes AND
      // (b) belong to this doc's scope by parent-FK lineage. A root-level
      // `replace /<coll>` from the source (its single-object root) must be
      // REWRITTEN to a keyed `/<coll>/<id>` when the target treats <coll> as
      // an included map — otherwise applying `/<coll>` would clobber the whole
      // collection map with one row object.
      const relevantOps: DeltaOp[] = [];
      // Each op taken is applied to the target at once, so a row later in the write finds a
      // parent that came earlier in it (a course and its drinks, put back together by an undo).
      const take = (op: DeltaOp) => {
        relevantOps.push(op);
        if (cached) deltaApplyOps(cached, [op]);
      };
      for (const op of ops) {
        const parts = splitPath(op.path);
        const collKey = parts[0];
        if (!collKey) continue;
        if (!def.include.includes(collKey) && collKey !== def.root) continue;

        const id = parts[1];

        // The mirror of the rewrite below: a keyed row `/<coll>/<id>` from a source that holds
        // <coll> as a map, onto a target whose ROOT is that row. Applied as it is, it would add a
        // key to the root object; it is the root, replaced whole -- or, the row gone, null.
        if (collKey === def.root && parts.length === 2) {
          if (id !== docId) continue;
          take({ op: "replace", path: joinPath(collKey), value: op.op === "remove" ? null : (op as any).value });
          continue;
        }

        if (op.op === "remove") {
          // Forward removes only if the id is currently in the target's cache.
          // If we don't have it, this row was never in the target's scope.
          if (id != null && cached?.[collKey]?.[id] != null) take(op);
          continue;
        }

        // add / replace — `value` is the full row (per applyOps' broadcastOps).
        const row = (op as any).value;
        if (parts.length === 1) {
          // Source root-level replace.
          if (collKey === def.root) {
            // Target also treats this collection as its single-object root.
            if (row && String(row.id) === docId) take(op);
          } else if (row && rowInScope(collKey, row, def, docId, cached)) {
            // Target treats it as an included map — rewrite to a keyed op.
            take({ op: "replace", path: joinPath(collKey, row.id), value: row });
          }
          continue;
        }
        if (rowInScope(collKey, row, def, docId, cached)) take(op);
      }

      if (relevantOps.length === 0) continue;

      // Broadcast the deltas
      ws.publish(docName, { doc: docName, ops: relevantOps });
    }
  }

  // ---------------------------------------------------------------------------
  // Custom-doc cross-pollination
  // ---------------------------------------------------------------------------

  /**
   * For each broadcast op, test membership against every open custom doc whose
   * `watch` includes the affected collection. Emit transition ops
   * (add / replace / remove) on the custom doc's own shape.
   */
  function customFanOut(ops: DeltaOp[]) {
    if (customByPrefix.size === 0) return;

    for (const op of ops) {
      const parts = splitPath(op.path);
      // We only handle /<coll>/<id> with a full row value (or a plain remove).
      // Root-level or field-level paths are ignored — the writer's broadcastOps
      // always carry full row values for add/replace.
      if (parts.length < 2) continue;
      const coll = parts[0]!;
      const id = parts[1]!;
      if (!watchedCollections.has(coll)) continue;

      const row = (op as any).value as any | undefined;

      // Bucket open docs by custom type.
      for (const [prefix, def] of customByPrefix) {
        if (!def.watch.includes(coll)) continue;

        // Memoize the membership decision per distinct criteria for this op.
        const decisionByCriteria = new Map<unknown, boolean>();

        for (const [docName] of subscriptions) {
          if (!docName.startsWith(prefix)) continue;
          const criteria = customCriteria.get(docName);
          if (criteria === undefined) continue;
          const cached = cache.get(docName);
          if (!cached) continue;

          let shouldBeIn = decisionByCriteria.get(criteria);
          if (shouldBeIn === undefined) {
            shouldBeIn = row == null ? false : def.matches(coll, row, criteria);
            decisionByCriteria.set(criteria, shouldBeIn);
          }

          const wasIn = cached[coll]?.[id] != null;
          const emitted: DeltaOp[] = [];

          if (!wasIn && shouldBeIn) {
            cached[coll][id] = row;
            emitted.push({ op: "add", path: joinPath(coll, id), value: row });
          } else if (wasIn && shouldBeIn) {
            cached[coll][id] = row;
            emitted.push({ op: "replace", path: joinPath(coll, id), value: row });
          } else if (wasIn && !shouldBeIn) {
            delete cached[coll][id];
            emitted.push({ op: "remove", path: joinPath(coll, id) });
          }
          // else: neither in nor becoming in — ignore.

          if (emitted.length) ws.publish(docName, { doc: docName, ops: emitted });
        }
      }
    }
  }

  return {
    /**
     * Drop a doc's cached copy; the next open, write or fan-out that needs it
     * reads it again from the tables (`reloadEvicted`). Its subscribers stay
     * subscribed, and re-open to see what changed.
     */
    evict(docName: string) {
      cache.delete(docName);
      implied.delete(docName);
      customCriteria.delete(docName);
    },
  };
}

// ---------------------------------------------------------------------------
// Inverse
// ---------------------------------------------------------------------------

/**
 * The inverse of a write, from the document as it was before and the ops the
 * backend applied. Applied ops are whole rows (`/coll/id`) or the root
 * (`/root`), so the inverse of each is the row as it was: an add is removed,
 * a remove is added back, a replace is replaced by its old self. Written in
 * reverse order, except that a run of removes (a row and the children its
 * removal cascaded to) is added back in its own order, parent first, so each
 * child finds its parent in scope.
 */
/** A row as a write may carry it: its temporal columns are storage, not data. */
function withoutStorage(row: any): any {
  if (!row || typeof row !== "object" || !("valid_from" in row || "valid_to" in row)) return row;
  const { valid_from: _from, valid_to: _to, ...data } = row;
  return data;
}

export function inverseOf(before: any, applied: DeltaOp[]): DeltaOp[] {
  const inverse: DeltaOp[] = [];
  let run: DeltaOp[] = [];
  const flush = () => {
    inverse.unshift(...run);
    run = [];
  };
  for (const op of applied) {
    const [coll, id] = splitPath(op.path);
    const prior = withoutStorage(id === undefined ? before[coll!] : before[coll!]?.[id]);
    if (op.op === "remove") {
      run.push({ op: "add", path: op.path, value: prior });
      continue;
    }
    flush();
    inverse.unshift(op.op === "add" ? { op: "remove", path: op.path } : { op: "replace", path: op.path, value: prior });
  }
  flush();
  return inverse;
}

// ---------------------------------------------------------------------------
// Time-travel
// ---------------------------------------------------------------------------

/** Load a doc as it existed at a specific point in time. */
export function loadDocAt(db: any, schema: Schema, def: DocDef, docId: string, at: string): any | null {
  const rootTable = schema.tables[def.root];
  if (!rootTable) return null;

  const rootRows = temporalQuery(db, rootTable, "id = ?", [docId], at);
  if (rootRows.length === 0) return null;
  const rootRow = rootRows[0];
  decodeRow(rootTable, rootRow);

  const doc: any = { [def.root]: rootRow };

  for (const collKey of def.include) {
    const table = schema.tables[collKey];
    if (!table) continue;

    const collRows = loadCollectionAt(db, schema, table, def, rootRow, at);
    for (const row of collRows) decodeRow(table, row);
    doc[collKey] = toMap(collRows);
  }

  return doc;
}

function temporalQuery(db: any, table: ResolvedTable, where: string, params: any[], at: string): any[] {
  if (table.temporal) {
    return db.query(
      `SELECT * FROM ${table.name} WHERE ${where} AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`,
    ).all(...params, at, at);
  }
  return db.query(`SELECT * FROM ${table.name} WHERE ${where}`).all(...params);
}

function loadCollectionAt(db: any, schema: Schema, table: ResolvedTable, def: DocDef, rootRow: any, at: string): any[] {
  if (!table.parent) return [];

  if (table.parent.collection === def.root) {
    return temporalQuery(db, table, `${table.parent.fkColumn} = ?`, [rootRow.id], at);
  }

  const parentTable = schema.tables[table.parent.collection];
  if (!parentTable) return [];
  const parentRows = loadCollectionAt(db, schema, parentTable, def, rootRow, at);
  const parentIds = parentRows.map((r: any) => r.id);
  if (parentIds.length === 0) return [];

  const placeholders = parentIds.map(() => "?").join(", ");
  return temporalQuery(db, table, `${table.parent.fkColumn} IN (${placeholders})`, parentIds, at);
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

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/** Compare schema against existing tables and apply ALTER TABLE ADD COLUMN for new columns. */
export function migrateSchema(db: any, schema: Schema): string[] {
  const applied: string[] = [];

  for (const [, table] of Object.entries(schema.tables)) {
    const info = db.query(`PRAGMA table_info(${table.name})`).all() as any[];
    if (info.length === 0) {
      // Table doesn't exist yet — createTables will handle it
      continue;
    }

    const existingCols = new Set(info.map((c: any) => c.name));

    // Warn on column type mismatches
    for (const c of info) {
      const def = table.columns[c.name];
      if (def) {
        const expectedType = columnSqlType(def).toUpperCase();
        const actualType = c.type.toUpperCase();
        if (actualType !== expectedType) {
          console.warn(
            `[delta-sqlite] Type mismatch for ${table.name}.${c.name}: schema expects ${expectedType} (${def.type}), database has ${actualType}`,
          );
        }
      }
    }

    // Check for FK column from parent
    if (table.parent && !existingCols.has(table.parent.fkColumn)) {
      const sql = `ALTER TABLE ${table.name} ADD COLUMN ${table.parent.fkColumn} TEXT`;
      db.run(sql);
      applied.push(sql);
    }

    // Check user-defined columns
    for (const [col, def] of Object.entries(table.columns)) {
      if (existingCols.has(col)) continue;
      const sqlType = columnSqlType(def);
      const defaultVal = def.default !== undefined
        ? ` DEFAULT ${sqlDefault(def.default)}`
        : (def.nullable ? "" : ` DEFAULT ${sqlDefault(defaultForType(def.type))}`);
      const sql = `ALTER TABLE ${table.name} ADD COLUMN ${col} ${sqlType}${defaultVal}`;
      db.run(sql);
      applied.push(sql);
    }

    // Retrofit temporal scaffolding when a table gained `temporal: true`.
    // Without this the reads target a current_<table> view that doesn't exist
    // ("no such table") after a non-temporal→temporal flag flip.
    if (table.temporal) {
      if (!existingCols.has("valid_from")) {
        const sql = `ALTER TABLE ${table.name} ADD COLUMN valid_from TEXT NOT NULL DEFAULT (datetime('now'))`;
        db.run(sql);
        applied.push(sql);
      }
      if (!existingCols.has("valid_to")) {
        const sql = `ALTER TABLE ${table.name} ADD COLUMN valid_to TEXT`;
        db.run(sql);
        applied.push(sql);
      }
      db.run(`CREATE VIEW IF NOT EXISTS current_${table.name} AS SELECT * FROM ${table.name} WHERE valid_to IS NULL`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_${table.name}_id_valid ON ${table.name} (id, valid_to)`);
      if (!existingCols.has("valid_from")) {
        // NOTE: SQLite can't alter the PRIMARY KEY in place. A real
        // non-temporal→temporal migration of EXISTING data needs the composite
        // (id, valid_from) PK, which requires rebuilding the table. The columns
        // and view above unblock reads, but historical versioning of rows that
        // predate the flip requires a manual table rebuild + backfill.
        console.warn(
          `[delta-sqlite] table "${table.name}" became temporal: added valid_from/valid_to + current_ view, but the composite (id, valid_from) PRIMARY KEY cannot be added by ALTER. Rebuild the table to fully enable temporal versioning.`,
        );
      }
    }
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate delta ops against the schema. Returns an array of errors (empty = valid). */
export function validateOps(schema: Schema, def: DocDef, ops: DeltaOp[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const op of ops) {
    let parts: string[];
    try { parts = splitPath(op.path); }
    catch (err: any) { errors.push({ path: String(op.path), message: err.message }); continue; }
    const collKey = parts[0];
    if (!collKey) {
      errors.push({ path: op.path, message: "Empty path" });
      continue;
    }

    // Check collection exists
    if (collKey !== def.root && !def.include.includes(collKey)) {
      errors.push({ path: op.path, message: `Unknown collection: ${collKey}` });
      continue;
    }

    const table = schema.tables[collKey];
    if (!table) {
      errors.push({ path: op.path, message: `No table for collection: ${collKey}` });
      continue;
    }

    const fkCol = table.parent?.fkColumn;
    // Own columns only: `table.columns.toString` is Object.prototype's, not a column.
    const columnOf = (k: string): ColumnDef | undefined => (Object.hasOwn(table.columns, k) ? table.columns[k] : undefined);
    const isKnownKey = (k: string) => k === "id" || k === fkCol || columnOf(k) !== undefined;

    // One-segment paths: /<root> is a whole-root partial merge (replace only);
    // /<coll> on an included collection has no meaning for a client op — reject
    // it here so it 400s instead of reaching the executor's throw (500).
    if (parts.length === 1) {
      if (collKey !== def.root) {
        errors.push({ path: op.path, message: `Whole-collection ops are not supported: ${op.op} ${op.path}` });
        continue;
      }
      if (op.op !== "replace") {
        errors.push({ path: op.path, message: "Root supports replace only" });
        continue;
      }
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (value == null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ path: op.path, message: "Replace value must be an object" });
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!isKnownKey(key)) errors.push({ path: op.path, message: `Unknown field: ${key}` });
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        const colDef = columnOf(field);
        if (!colDef) continue;
        const typeErr = validateFieldType(colDef, field, fieldValue);
        if (typeErr) errors.push({ path: `${op.path}/${field}`, message: typeErr });
      }
      continue;
    }

    // Root collection is single-mode: /<root>/<field> is a FIELD replace
    // (not /<root>/<id> row), so validate parts[1] as a column name.
    if (collKey === def.root && parts.length === 2) {
      if (op.op !== "replace") {
        errors.push({ path: op.path, message: "Root fields only support replace" });
        continue;
      }
      const field = parts[1]!;
      const colDef = columnOf(field);
      if (!colDef) {
        errors.push({ path: op.path, message: `Unknown field: ${field}` });
        continue;
      }
      const typeErr = validateFieldType(colDef, field, (op as any).value);
      if (typeErr) errors.push({ path: op.path, message: typeErr });
      continue;
    }

    // Whole-row add / replace on an included collection: /<coll>/<id> (or /<coll>/- for add).
    if ((op.op === "add" || op.op === "replace") && parts.length === 2) {
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (value == null || typeof value !== "object" || Array.isArray(value)) {
        // Rejecting a bad REPLACE matters as much as a bad add now that the
        // executor implements whole-row replace — before, a non-object value
        // was silently dropped along with the rest of the op.
        errors.push({
          path: op.path,
          message: `${op.op === "add" ? "Add" : "Replace"} value must be an object`,
        });
        continue;
      }

      // Unknown fields are rejected: otherwise the op acks, rides the broadcast
      // and cache, but is dropped by the DB write — diverging clients from disk.
      for (const key of Object.keys(value)) {
        if (!isKnownKey(key)) errors.push({ path: op.path, message: `Unknown field: ${key}` });
      }

      // Required-field check applies to adds only: a column that is neither
      // nullable nor has a default must be given (it used to be stored as "",
      // 0 or false, acked and broadcast).
      if (op.op === "add") {
        for (const [col, colDef] of Object.entries(table.columns)) {
          if (!colDef.nullable && colDef.default === undefined && value[col] === undefined) {
            errors.push({ path: op.path, message: `Required field missing: ${col} (give it a value, or declare a default or make it nullable in the schema)` });
          }
        }
      }

      // Type-check the fields that map to declared columns.
      for (const [field, fieldValue] of Object.entries(value)) {
        const colDef = columnOf(field);
        if (!colDef) continue; // id / FK — not schema-typed
        const typeErr = validateFieldType(colDef, field, fieldValue);
        if (typeErr) errors.push({ path: `${op.path}/${field}`, message: typeErr });
      }
    }

    // Field-level replace: /<coll>/<id>/field
    if (op.op === "replace" && parts.length === 3) {
      const field = parts[2]!;
      const colDef = columnOf(field);
      if (!colDef) {
        errors.push({ path: op.path, message: `Unknown field: ${field}` });
        continue;
      }
      const typeErr = validateFieldType(colDef, field, (op as any).value);
      if (typeErr) errors.push({ path: op.path, message: typeErr });
    }
  }

  return errors;
}

function validateFieldType(def: ColumnDef, field: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return def.nullable ? null : `${field} cannot be null`;
  }
  switch (def.type) {
    case "text":
      if (typeof value !== "string") return `${field} must be a string`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${field} must be an integer`;
      break;
    case "real":
      if (typeof value !== "number") return `${field} must be a number`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${field} must be a boolean`;
      break;
    case "json":
      break; // any type is valid for json
    case "timestamptz":
      // SQLite stores as TEXT (ISO-8601). Accept strings or Date instances.
      if (typeof value !== "string" && !(value instanceof Date)) {
        return `${field} must be an ISO-8601 string or Date`;
      }
      break;
  }
  return null;
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
function now(): string {
  let ms = Date.now();
  if (ms <= _lastNowMs) ms = _lastNowMs + 1;
  _lastNowMs = ms;
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

function toMap(arr: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const item of arr) m[item.id] = item;
  return m;
}

// Close the live version of a row. When a reinsert follows, the caller MUST
// pass the reinsert's `ts` so the old row's valid_to EXACTLY equals the new
// row's valid_from — otherwise (with monotonic sub-second now()) the close
// lands a tick later than the reinsert, leaving a temporal overlap that makes
// half-open time-travel reads (valid_to > at) match two versions at once.
function closeRow(db: any, table: ResolvedTable, id: string, ts: string = now()) {
  db.run(`UPDATE ${table.name} SET valid_to = ? WHERE id = ? AND valid_to IS NULL`, [ts, id]);
  return ts;
}

/**
 * Insert one version of a row -- a new row, a root row, or the next version of
 * a temporal one: its id, its parent key, its columns, and on a temporal
 * table `valid_from = ts`. The one row writer: the three it replaces had
 * drifted, and the root's had lost the parent key (v0.5.0 review #5).
 */
function insertRow(db: any, table: ResolvedTable, row: any, ts: string) {
  const cols = ["id"];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (table.temporal) cols.push("valid_from");
  const vals = cols.map((c) => (c === "valid_from" ? ts : encodeValue(table, c, row[c])));
  db.run(`INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, vals);
}

/** An error the writer is answered with: `code` is its wire code. */
function refuse(code: number, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** SQLite's own error, with the fix when the fix is a call the app left out. */
function named(err: any): any {
  if (typeof err?.message === "string" && /no such table/.test(err.message) && !/createTables/.test(err.message)) {
    err.message += " -- call createTables(db, schema) before the first open";
  }
  return err;
}

function insertCollectionRow(
  db: any,
  schema: Schema,
  table: ResolvedTable,
  id: string,
  rootId: string,
  def: DocDef,
  row: Record<string, unknown>,
  ts: string,
): any {
  // An add names a new row. On a temporal table the key is (id, valid_from),
  // so an add of a live id would insert a second live version of it (and on a
  // plain table fail UNIQUE as a 500): refuse it, in any document's scope.
  const live = table.temporal ? `current_${table.name}` : table.name;
  if (db.query(`SELECT 1 FROM ${live} WHERE id = ?`).get(id)) {
    refuse(409, `Row already exists: ${joinPath(table.docKey, id)} -- replace it, or add to ${joinPath(table.docKey, "-")} for a new id`);
  }
  const fullRow: any = { id, ...row };
  fullRow.id = id;   // the path names the row, whatever the value says
  if (table.temporal) { fullRow.valid_from = ts; fullRow.valid_to = null; }

  // Resolve FK column
  if (table.parent) {
    if (table.parent.collection === def.root) {
      fullRow[table.parent.fkColumn] = rootId;
    } else {
      // FK should already be in the row (e.g. node_id for activities)
    }
  }

  // Apply defaults
  for (const [col, colDef] of Object.entries(table.columns)) {
    if (fullRow[col] === undefined) {
      fullRow[col] = colDef.default ?? (colDef.nullable ? null : defaultForType(colDef.type));
    }
  }

  insertRow(db, table, fullRow, ts);

  // Decode for in-memory representation
  decodeRow(table, fullRow);
  return fullRow;
}

/**
 * Overwrite a NON-temporal row in place.
 *
 * A temporal row is updated by closing the old version and inserting a new one
 * — the composite `(id, valid_from)` key keeps both. A non-temporal table has
 * `id` as its whole primary key, so that same insert collides: replaces against
 * one used to fail with `UNIQUE constraint failed`, making non-temporal rows
 * unupdatable. UPDATE rather than DELETE+INSERT (which is what the Postgres
 * backend does) so the row is never briefly absent.
 */
function updateRow(db: any, table: ResolvedTable, id: string, row: any) {
  const cols: string[] = [];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (cols.length === 0) return;

  const sets = cols.map((c) => `${c} = ?`).join(", ");
  const vals = cols.map((c) => encodeValue(table, c, row[c]));
  db.run(`UPDATE ${table.name} SET ${sets} WHERE id = ?`, [...vals, id]);
}

// ---------------------------------------------------------------------------
// Write scoping
// ---------------------------------------------------------------------------
//
// A loaded doc holds EXACTLY the rows its scope admits — that's what
// `loadDocFromSql` builds. So "is this row in the doc?" IS the scope check,
// and these two guards make every write path ask it. Reads were always scoped;
// writes addressed rows by bare id, so a client holding `customer:alice` could
// name a row of `customer:bob` and reach it. The error message deliberately
// matches the "not there" case — a distinct "forbidden" would confirm the row
// exists to someone probing ids.

/** Throw unless `id` is a row this doc actually holds. */
function assertRowInScope(doc: any, collKey: string, id: string): void {
  if (doc[collKey]?.[id] == null) refuse(404, `Row not found: ${collKey}/${id}`);
}

/**
 * Throw unless a new row's parent is in scope. Only meaningful for
 * grandchildren-and-deeper: a direct child of the doc root has its FK assigned
 * server-side, and an unparented collection is loaded in full (so every row of
 * it is in scope by construction).
 */
function assertParentInScope(
  doc: any,
  def: DocDef,
  table: ResolvedTable,
  row: Record<string, unknown> | undefined,
): void {
  const parent = table.parent;
  if (!parent || parent.collection === def.root) return;
  const fk = row?.[parent.fkColumn];
  if (fk == null || doc[parent.collection]?.[String(fk)] == null) {
    refuse(404, `Row not found: ${parent.collection}/${fk ?? ""}`);
  }
}

function removeRow(
  db: any,
  schema: Schema,
  table: ResolvedTable,
  collKey: string,
  id: string,
  doc: any,
  def: DocDef,
): DeltaOp[] {
  const ops: DeltaOp[] = [];

  if (table.temporal) {
    closeRow(db, table, id);
  } else {
    db.run(`DELETE FROM ${table.name} WHERE id = ?`, [id]);
  }
  delete doc[collKey][id];
  ops.push({ op: "remove", path: joinPath(collKey, id) });

  // Cascade via parent relationship (children)
  for (const childKey of table.children) {
    if (!def.include.includes(childKey)) continue;
    const childTable = schema.tables[childKey];
    if (!childTable?.parent) continue;

    const viewName = childTable.temporal ? `current_${childTable.name}` : childTable.name;
    const childRows = db.query(`SELECT id FROM ${viewName} WHERE ${childTable.parent.fkColumn} = ?`).all(id) as any[];
    for (const row of childRows) {
      ops.push(...removeRow(db, schema, childTable, childKey, row.id, doc, def));
    }
  }

  // Cascade via cascadeOn references
  for (const ref of table.referencedBy) {
    if (!def.include.includes(ref.collection)) continue;
    const refTable = schema.tables[ref.collection];
    if (!refTable) continue;

    const viewName = refTable.temporal ? `current_${refTable.name}` : refTable.name;
    const refRows = db.query(`SELECT id FROM ${viewName} WHERE ${ref.fkColumn} = ?`).all(id) as any[];
    for (const row of refRows) {
      ops.push(...removeRow(db, schema, refTable, ref.collection, row.id, doc, def));
    }
  }

  return ops;
}

// ---------------------------------------------------------------------------
// Field codecs
// ---------------------------------------------------------------------------

function encodeValue(table: ResolvedTable, col: string, value: unknown): any {
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
  return value ?? null;
}

function decodeRow(table: ResolvedTable, row: any) {
  for (const [col, def] of Object.entries(table.columns)) {
    if (def.type === "json" && typeof row[col] === "string") {
      try { row[col] = JSON.parse(row[col]); } catch { /* a string an earlier release stored raw: keep it */ }
    }
    if (def.type === "boolean" && row[col] != null) {
      row[col] = !!row[col];
    }
  }
}

function defaultForType(type: ColumnDef["type"]): unknown {
  switch (type) {
    case "text": return "";
    case "integer": return 0;
    case "real": return 0;
    case "boolean": return false;
    case "json": return null;
    case "timestamptz": return null;   // no sensible default — must be supplied
  }
}
