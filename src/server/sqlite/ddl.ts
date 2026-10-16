/**
 * SQLite's tables from the schema: created (`createTables`), and migrated as
 * the schema grows (`migrateSchema`) -- columns, their types and defaults, the
 * temporal scaffolding, the sequences ids are minted from.
 */
import { defaultForType, q, type ColumnDef, type Schema } from "../../schema";

/** Generate CREATE TABLE statements from the schema and execute them. */
export function createTables(db: any, schema: Schema) {
  waitForLocks(db);
  db.run("PRAGMA journal_mode = WAL");
  createSequences(db);

  for (const [, table] of Object.entries(schema.tables)) createTable(db, table);
}

/** One table, as `createTables` makes each (if it is not there): its columns, a temporal one's view, a parent key's index. */
export function createTable(db: any, table: Schema["tables"][string]) {
  const name = q(table.name);
  // Ids and parent keys have integer affinity: a serial is kept, and read, as
  // a number -- as Postgres keeps it -- and an id that is not one (a session's
  // token) as the text it is. `INT`, not `INTEGER`: an INTEGER key would be
  // the rowid, and refuse the text.
  const cols: string[] = ["id INT NOT NULL"];

  // FK columns from parent
  if (table.parent) {
    cols.push(`${q(table.parent.fkColumn)} INT NOT NULL`);
  }

  // User-defined columns
  for (const [col, def] of Object.entries(table.columns)) {
    const sqlType = columnSqlType(def);
    const notNull = def.nullable ? "" : " NOT NULL";
    const defaultVal = def.default !== undefined ? ` DEFAULT ${sqlDefault(def.default)}` : "";
    cols.push(`${q(col)} ${sqlType}${notNull}${defaultVal}`);
  }

  if (table.temporal) {
    cols.push("valid_from TEXT NOT NULL DEFAULT (datetime('now'))");
    cols.push("valid_to TEXT");
    cols.push("PRIMARY KEY (id, valid_from)");
  } else {
    cols.push("PRIMARY KEY (id)");
  }

  db.run(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`);

  // Current-state view and indexes for temporal tables
  if (table.temporal) createCurrent(db, table.name);

  // FK index for child tables
  if (table.parent) {
    const fk = table.parent.fkColumn;
    db.run(`CREATE INDEX IF NOT EXISTS ${q(`idx_${table.name}_${fk}`)} ON ${name} (${q(fk)})`);
  }
}

/** A temporal table's current-state view (`current_<table>`, read by `current()`) and its index. */
function createCurrent(db: any, table: string): void {
  db.run(`CREATE VIEW IF NOT EXISTS ${q(`current_${table}`)} AS SELECT * FROM ${q(table)} WHERE valid_to IS NULL`);
  db.run(`CREATE INDEX IF NOT EXISTS ${q(`idx_${table}_id_valid`)} ON ${q(table)} (id, valid_to)`);
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
// Schema migrations
// ---------------------------------------------------------------------------

/** Compare schema against existing tables and apply ALTER TABLE ADD COLUMN for new columns. */
export function migrateSchema(db: any, schema: Schema): string[] {
  const applied: string[] = [];

  for (const [, table] of Object.entries(schema.tables)) {
    const name = q(table.name);
    const info = db.query(`PRAGMA table_info(${name})`).all() as any[];
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
      const sql = `ALTER TABLE ${name} ADD COLUMN ${q(table.parent.fkColumn)} TEXT`;
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
      const sql = `ALTER TABLE ${name} ADD COLUMN ${q(col)} ${sqlType}${defaultVal}`;
      db.run(sql);
      applied.push(sql);
    }

    // Retrofit temporal scaffolding when a table gained `temporal: true`.
    // Without this the reads target a current_<table> view that doesn't exist
    // ("no such table") after a non-temporal→temporal flag flip.
    if (table.temporal) {
      if (!existingCols.has("valid_from")) {
        const sql = `ALTER TABLE ${name} ADD COLUMN valid_from TEXT NOT NULL DEFAULT (datetime('now'))`;
        db.run(sql);
        applied.push(sql);
      }
      if (!existingCols.has("valid_to")) {
        const sql = `ALTER TABLE ${name} ADD COLUMN valid_to TEXT`;
        db.run(sql);
        applied.push(sql);
      }
      createCurrent(db, table.name);
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

/** The sequences a collection's serials are minted from (`add /coll/-`), as Postgres's `seq_<table>`. */
export function createSequences(db: any): void {
  db.run("CREATE TABLE IF NOT EXISTS _delta_sequences (collection TEXT PRIMARY KEY, last INTEGER NOT NULL)");
}

/**
 * Wait for another connection's lock (up to 5s) rather than fail at once with
 * SQLITE_BUSY: several processes may share the file. A timeout the
 * app set is kept.
 */
export function waitForLocks(db: any): void {
  const set = db.query("PRAGMA busy_timeout").get() as { timeout?: number } | null;
  if (!set?.timeout) db.run("PRAGMA busy_timeout = 5000");
}
