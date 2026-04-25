/**
 * Delta SQLite — relational backend for delta-doc.
 *
 * Backs delta-doc documents with SQLite temporal tables. The schema describes
 * tables and relationships once; doc definitions are lenses (views) into that
 * schema with optional scope filters.
 *
 * Usage:
 *   import { defineSchema, defineDoc, createTables, registerDocs } from "@blueshed/railroad/delta-sqlite";
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
import { applyOps as deltaApplyOps, type DeltaOp } from "../core";
import { createLogger } from "./logger";
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
export function registerDocs(
  ws: WsServer,
  db: any,
  schema: Schema,
  docs: DocDef[],
  customDocs: CustomDocDef<any>[] = [],
) {
  // Build lookup: prefix → DocDef
  const docByPrefix = new Map<string, DocDef>();
  for (const doc of docs) {
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

    for (const op of ops) {
      const parts = op.path.split("/").filter(Boolean);
      const collKey = parts[0]!;
      const table = schema.tables[collKey];

      // Root-level field update: /<root>/fieldName
      if (collKey === def.root && parts.length === 2) {
        if (op.op !== "replace") throw new Error(`Root fields only support replace`);
        const field = parts[1]!;
        const rootTable = schema.tables[def.root]!;
        const ts = now();
        if (rootTable.temporal) closeRow(db, rootTable, rootId);
        const updated = { ...doc[def.root], [field]: (op as any).value };
        if (rootTable.temporal) { updated.valid_from = ts; updated.valid_to = null; }
        insertRootRow(db, rootTable, updated, ts);
        doc[def.root] = updated;
        broadcastOps.push({ op: "replace", path: `/${def.root}`, value: updated });
        continue;
      }

      if (!table || !def.include.includes(collKey)) {
        throw new Error(`Unknown collection: ${collKey}`);
      }

      if (parts.length === 2) {
        const id = parts[1]!;
        if (op.op === "add") {
          // Add row
          const row = (op as any).value as Record<string, unknown>;
          const ts = now();
          const fullRow = insertCollectionRow(db, schema, table, id, rootId, def, row, ts);
          doc[collKey][id] = fullRow;
          broadcastOps.push({ op: "add", path: `/${collKey}/${id}`, value: fullRow });
        } else if (op.op === "remove") {
          // Remove row + cascades
          const cascadeOps = removeRow(db, schema, table, collKey, id, doc, def);
          broadcastOps.push(...cascadeOps);
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

    // Apply batched field updates
    for (const [, batch] of rowFieldBatches) {
      const collKey = batch.table.docKey;
      const current = doc[collKey]?.[batch.id];
      if (!current) throw new Error(`Row not found: ${collKey}/${batch.id}`);

      const ts = now();
      if (batch.table.temporal) closeRow(db, batch.table, batch.id);

      const updated = { ...current };
      if (batch.table.temporal) { updated.valid_from = ts; updated.valid_to = null; }
      for (const [field, value] of batch.fields) {
        updated[field] = value;
      }
      reinsertRow(db, batch.table, batch.id, updated, ts);
      doc[collKey][batch.id] = updated;
      broadcastOps.push({ op: "replace", path: `/${collKey}/${batch.id}`, value: updated });
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
      const { def, docId } = customMatch;
      let doc = cache.get(docName);
      if (!doc) {
        const criteria = def.parse(docId);
        const rowsByColl = def.query(db, criteria);
        doc = {};
        for (const coll of def.watch) doc[coll] = toMap(rowsByColl[coll] ?? []);
        cache.set(docName, doc);
        customCriteria.set(docName, criteria);
      }

      client.subscribe(docName);
      if (!subscriptions.has(docName)) subscriptions.set(docName, new Set());
      subscriptions.get(docName)!.add(client);

      respond({ result: doc });
      log.info(`opened ${docName} (custom)`);
      return;
    }

    const match = findDoc(docName);
    if (!match) return;

    const { def, docId } = match;
    let doc = cache.get(docName);
    if (!doc) {
      const scope = resolveScope(def, docId);
      doc = loadDocFromSql(def, scope);
      if (!doc) {
        respond({ error: { code: 404, message: "Not found" } });
        return;
      }
      cache.set(docName, doc);
    }

    client.subscribe(docName);
    if (!subscriptions.has(docName)) subscriptions.set(docName, new Set());
    subscriptions.get(docName)!.add(client);

    respond({ result: doc });
    log.info(`opened ${docName}`);
  });

  ws.on("delta", (msg, _client, respond) => {
    const docName = msg.doc as string;

    if (findCustom(docName)) {
      respond({ error: { code: 403, message: "Custom docs are read-only; write through the source doc." } });
      return;
    }

    const match = findDoc(docName);
    if (!match) return;

    const { def } = match;
    const doc = cache.get(docName);
    if (!doc) {
      respond({ error: { code: 404, message: "Doc not loaded" } });
      return;
    }

    // Snapshot cache for rollback
    const snapshot = structuredClone(doc);

    try {
      db.run("BEGIN");
      const broadcastOps = applyOps(docName, def, doc, msg.ops as DeltaOp[]);
      db.run("COMMIT");

      // Primary broadcast: to the doc's own subscribers
      ws.publish(docName, { doc: docName, ops: broadcastOps });

      // Cross-doc fan-out: find other open docs affected by these changes
      fanOut(ws, broadcastOps, docName);

      // Custom-doc cross-pollination: predicate-based membership.
      customFanOut(broadcastOps);

      respond({ result: { ack: true } });
      log.info(`delta ${docName} [${(msg.ops as DeltaOp[]).map((o: DeltaOp) => `${o.op} ${o.path}`).join(", ")}]`);
    } catch (err: any) {
      db.run("ROLLBACK");
      // Restore in-memory cache from snapshot
      cache.set(docName, snapshot);
      log.error(`delta failed: ${err.message}`);
      respond({ error: { code: 500, message: err.message } });
    }
  });

  ws.on("close", (msg, client, respond) => {
    const docName = msg.doc as string;
    const isCustom = findCustom(docName) != null;
    const isStandard = findDoc(docName) != null;
    if (!isCustom && !isStandard) return;

    client.unsubscribe(docName);
    subscriptions.get(docName)?.delete(client);
    if (subscriptions.get(docName)?.size === 0) {
      subscriptions.delete(docName);
      cache.delete(docName); // evict when no subscribers
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
      // (b) belong to this doc's scope by parent-FK lineage.
      const relevantOps = ops.filter((op) => {
        const parts = op.path.split("/").filter(Boolean);
        const collKey = parts[0];
        if (!collKey) return false;
        if (!def.include.includes(collKey) && collKey !== def.root) return false;

        const id = parts[1];

        if (op.op === "remove") {
          // Forward removes only if the id is currently in the target's cache.
          // If we don't have it, this row was never in the target's scope.
          return id != null && cached?.[collKey]?.[id] != null;
        }

        // add / replace — `value` is the full row (per applyOps' broadcastOps).
        const row = (op as any).value;
        if (collKey === def.root && parts.length === 1) {
          return row && String(row.id) === docId;       // root-level replace
        }
        return rowInScope(collKey, row, def, docId, cached);
      });

      if (relevantOps.length === 0) continue;

      // Apply deltas to cached doc
      if (cached) deltaApplyOps(cached, relevantOps);

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
      const parts = op.path.split("/").filter(Boolean);
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
            emitted.push({ op: "add", path: `/${coll}/${id}`, value: row });
          } else if (wasIn && shouldBeIn) {
            cached[coll][id] = row;
            emitted.push({ op: "replace", path: `/${coll}/${id}`, value: row });
          } else if (wasIn && !shouldBeIn) {
            delete cached[coll][id];
            emitted.push({ op: "remove", path: `/${coll}/${id}` });
          }
          // else: neither in nor becoming in — ignore.

          if (emitted.length) ws.publish(docName, { doc: docName, ops: emitted });
        }
      }
    }
  }

  return {
    /** Evict a doc from cache. */
    evict(docName: string) {
      cache.delete(docName);
      customCriteria.delete(docName);
    },
  };
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
    const parts = op.path.split("/").filter(Boolean);
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

    // Validate add ops — check required fields and types
    if (op.op === "add" && parts.length === 2) {
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (!value || typeof value !== "object") {
        errors.push({ path: op.path, message: "Add value must be an object" });
        continue;
      }

      for (const [col, colDef] of Object.entries(table.columns)) {
        if (!colDef.nullable && colDef.default === undefined && value[col] === undefined) {
          // Check if it has a type default
          if (defaultForType(colDef.type) === null) {
            errors.push({ path: op.path, message: `Required field missing: ${col}` });
          }
        }
      }

      // Validate field types
      for (const [field, fieldValue] of Object.entries(value)) {
        const colDef = table.columns[field];
        if (!colDef) continue; // FK or extra field — skip
        const typeErr = validateFieldType(colDef, field, fieldValue);
        if (typeErr) errors.push({ path: `${op.path}/${field}`, message: typeErr });
      }
    }

    // Validate replace ops — check field exists and type
    if (op.op === "replace" && parts.length === 3) {
      const field = parts[2]!;
      const colDef = table.columns[field];
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

function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function toMap(arr: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const item of arr) m[item.id] = item;
  return m;
}

function closeRow(db: any, table: ResolvedTable, id: string) {
  const ts = now();
  db.run(`UPDATE ${table.name} SET valid_to = ? WHERE id = ? AND valid_to IS NULL`, [ts, id]);
  return ts;
}

function insertRootRow(db: any, table: ResolvedTable, row: any, ts: string) {
  const cols = ["id", ...Object.keys(table.columns)];
  if (table.temporal) cols.push("valid_from");
  const vals = cols.map((c) => c === "valid_from" ? ts : encodeValue(table, c, row[c]));
  const placeholders = cols.map(() => "?").join(", ");
  db.run(`INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${placeholders})`, vals);
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
  const fullRow: any = { id, ...row };
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

  const cols = ["id"];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (table.temporal) cols.push("valid_from");

  const vals = cols.map((c) => {
    if (c === "valid_from") return ts;
    return encodeValue(table, c, fullRow[c]);
  });

  const placeholders = cols.map(() => "?").join(", ");
  db.run(`INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${placeholders})`, vals);

  // Decode for in-memory representation
  decodeRow(table, fullRow);
  return fullRow;
}

function reinsertRow(db: any, table: ResolvedTable, id: string, row: any, ts: string) {
  const cols = ["id"];
  if (table.parent) cols.push(table.parent.fkColumn);
  cols.push(...Object.keys(table.columns));
  if (table.temporal) cols.push("valid_from");

  const vals = cols.map((c) => {
    if (c === "valid_from") return ts;
    return encodeValue(table, c, row[c]);
  });

  const placeholders = cols.map(() => "?").join(", ");
  db.run(`INSERT INTO ${table.name} (${cols.join(", ")}) VALUES (${placeholders})`, vals);
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
  ops.push({ op: "remove", path: `/${collKey}/${id}` });

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

  if (def.type === "json" && value != null && typeof value !== "string") {
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
      try { row[col] = JSON.parse(row[col]); } catch {}
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
