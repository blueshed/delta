/**
 * SQLite's migrations (`../migrate.ts` says the rules): `migrate` runs a list
 * at start-up, before `createTables` / `migrateSchema`; the helpers are the
 * changes people make most, each SQL that keeps delta's scaffolding in step
 * (a temporal table's `current_<table>` view, the `idx_<table>_…` indexes, the
 * serial a collection is minted from).
 */
import type { Database } from "bun:sqlite";
import { q } from "../../schema";
import { appOf, fenced, isDeltasOwn, runMigrations, statusOf, type MigrateOptions, type MigrateResult, type Migration, type MigrationStatus, type Store } from "../migrate";
import { waitForLocks } from "./ddl";

export { fromFolder, type Migration, type MigrateOptions, type MigrateResult, type MigrationStatus } from "../migrate";

const has = (db: Database, type: "table" | "view", name: string): boolean =>
  !!db.query("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name);

function store(db: Database, app: string, collections?: string): Store<Database> {
  return {
    async lock() {
      if (db.inTransaction) throw new Error("[delta-migrate] migrate runs outside a transaction: each migration is its own");
      waitForLocks(db);
    },
    async unlock() {},
    async exists() { return has(db, "table", "delta_migrations"); },
    async tables(names) {
      const out = new Map<string, { columns: string[]; rows: boolean }>();
      for (const name of names) {
        if (!has(db, "table", name)) continue;
        const columns = (db.query(`PRAGMA table_info(${q(name)})`).all() as { name: string }[]).map((c) => c.name);
        out.set(name, { columns, rows: !!db.query(`SELECT 1 FROM ${q(name)} LIMIT 1`).get() });
      }
      return out;
    },
    async hasAppTables() {
      const tables = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'").all() as { name: string }[];
      return tables.some((t) => !isDeltasOwn(t.name));
    },
    async create() { db.run("CREATE TABLE IF NOT EXISTS delta_migrations (app TEXT NOT NULL, id TEXT NOT NULL, ran_at TEXT NOT NULL, PRIMARY KEY (app, id))"); },
    async recorded() { return db.query("SELECT id, ran_at FROM delta_migrations WHERE app = ? ORDER BY ran_at, rowid").all(app) as { id: string; ran_at: string }[]; },
    async transaction(fn) {
      // IMMEDIATE: the write lock first, so another process starting at once waits, then finds it recorded
      db.run("BEGIN IMMEDIATE");
      try {
        const out = await fn(db);
        db.run("COMMIT");
        return out;
      } catch (err) {
        if (db.inTransaction) db.run("ROLLBACK");
        throw err;
      }
    },
    async has(tx, id) { return !!tx.query("SELECT 1 FROM delta_migrations WHERE app = ? AND id = ?").get(app, id); },
    async record(tx, id, at) { tx.run("INSERT INTO delta_migrations (app, id, ran_at) VALUES (?, ?, ?)", [app, id, at]); },
    async fence(tx) {
      if (!has(tx, "table", "delta_ledger")) return;
      if (collections === undefined) return void tx.run("UPDATE delta_ledger SET undoable = 0 WHERE undoable = 1");
      // an entry is the app's when an op of it, or of its inverse, names one of the app's collections: /<coll>/...
      tx.run(`UPDATE delta_ledger SET undoable = 0 WHERE undoable = 1 AND EXISTS (
        SELECT 1 FROM (SELECT substr(json_extract(value, '$.path'), 2) AS rest FROM json_each(delta_ledger.ops)
                       UNION ALL SELECT substr(json_extract(value, '$.path'), 2) FROM json_each(delta_ledger.inverse)) AS p
         WHERE (CASE WHEN instr(p.rest, '/') > 0 THEN substr(p.rest, 1, instr(p.rest, '/') - 1) ELSE p.rest END) IN (SELECT value FROM json_each(?)))`, [collections]);
    },
  };
}

/**
 * Runs each migration of the app's list not yet run here, in order, each in
 * its own transaction (`up(db)` may be async). Call it at start-up, before
 * `createTables` and `migrateSchema`, outside any transaction; name the app
 * and give its schema when apps share the database.
 */
export function migrate(db: Database, migrations: Migration<Database>[], options: MigrateOptions = {}): Promise<MigrateResult> {
  return runMigrations(store(db, appOf(options), fenced(options)), migrations, options);
}

/** What of the app's has run here, what would run, and whether the app is new here; changes nothing. */
export function migrationStatus(db: Database, migrations: Migration<Database>[], options: MigrateOptions = {}): Promise<MigrationStatus> {
  return statusOf(store(db, appOf(options)), migrations, options);
}

// ---------------------------------------------------------------------------
// Helpers: each one change, with delta's scaffolding kept in step.
// ---------------------------------------------------------------------------

/** The table's indexes made by CREATE INDEX: name, columns, unique. */
function indexesOf(db: Database, table: string): { name: string; columns: string[]; unique: boolean }[] {
  return (db.query(`PRAGMA index_list(${q(table)})`).all() as { name: string; unique: number; origin: string }[])
    .filter((i) => i.origin === "c")
    .map((i) => ({
      name: i.name,
      unique: i.unique === 1,
      columns: (db.query(`PRAGMA index_info(${q(i.name)})`).all() as { name: string }[]).map((c) => c.name),
    }));
}

/** Renames the table's indexes `rename` names anew (SQLite has no ALTER INDEX: dropped and made again). */
function renameIndexes(db: Database, table: string, rename: (name: string) => string | undefined): void {
  for (const index of indexesOf(db, table)) {
    const name = rename(index.name);
    if (!name || name === index.name) continue;
    db.run(`DROP INDEX ${q(index.name)}`);
    db.run(`CREATE ${index.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${q(name)} ON ${q(table)} (${index.columns.map(q).join(", ")})`);
  }
}

/** Renames a column, every version of every row with it; its `idx_<table>_<from>` index (a parent key's) goes by the new name. */
export function renameColumn(db: Database, table: string, from: string, to: string): void {
  db.run(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`);
  renameIndexes(db, table, (name) => (name === `idx_${table}_${from}` ? `idx_${table}_${to}` : undefined));
}

/** Drops a column and what it held: an index on it goes with it. Move what must be kept first. */
export function dropColumn(db: Database, table: string, column: string): void {
  for (const index of indexesOf(db, table)) if (index.columns.includes(column)) db.run(`DROP INDEX ${q(index.name)}`);
  db.run(`ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`);
}

/**
 * Renames a table, with its `current_<table>` view, its `idx_<table>_…`
 * indexes and its serial (`_delta_sequences`, kept by collection: renamed
 * when it is named as the table, the default when the schema gives no `table:`).
 */
export function renameTable(db: Database, from: string, to: string): void {
  const temporal = has(db, "view", `current_${from}`);
  if (temporal) db.run(`DROP VIEW ${q(`current_${from}`)}`);
  db.run(`ALTER TABLE ${q(from)} RENAME TO ${q(to)}`);
  renameIndexes(db, to, (name) => (name.startsWith(`idx_${from}_`) ? `idx_${to}_${name.slice(`idx_${from}_`.length)}` : undefined));
  if (temporal) db.run(`CREATE VIEW IF NOT EXISTS ${q(`current_${to}`)} AS SELECT * FROM ${q(to)} WHERE valid_to IS NULL`);
  if (has(db, "table", "_delta_sequences")) {
    db.run("UPDATE _delta_sequences SET collection = ?2 WHERE collection = ?1 AND NOT EXISTS (SELECT 1 FROM _delta_sequences WHERE collection = ?2)", [from, to]);
  }
}
