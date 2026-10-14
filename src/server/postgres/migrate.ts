/**
 * Postgres's migrations (PGlite's too; `../migrate.ts` says the rules):
 * `migrate` runs a list at start-up, before `applyFramework` and
 * `applySql(pool, generateSql(…))`; the helpers are the changes people make
 * most, each SQL that keeps delta's scaffolding in step (a temporal table's
 * `current_<table>` view and its grants, the `idx_<table>_…` indexes, the
 * `seq_<table>` serial, `_delta_collections`). Two processes starting at once
 * take turns on an advisory lock, so each migration runs once.
 */
import type { Pool, PoolClient } from "pg";
import { q } from "../../schema";
import { appOf, runMigrations, statusOf, type MigrateOptions, type MigrateResult, type Migration, type MigrationStatus, type Store } from "../migrate";

export { fromFolder, type Migration, type MigrateOptions, type MigrateResult, type MigrationStatus } from "../migrate";

/** What a helper runs its SQL on: the client `up` is given. */
type Tx = Pick<PoolClient, "query">;

/** The advisory lock's key: one per database, for delta's migrations. */
const LOCK = "hashtext('delta_migrations')";

const regclass = async (tx: Tx, name: string): Promise<boolean> =>
  (await tx.query("SELECT to_regclass($1) IS NOT NULL AS there", [q(name)])).rows[0]?.there === true;

function store(client: PoolClient, app: string): Store<PoolClient> {
  return {
    async lock() { await client.query(`SELECT pg_advisory_lock(${LOCK})`); },
    async unlock() { await client.query(`SELECT pg_advisory_unlock(${LOCK})`); },
    async exists() { return regclass(client, "delta_migrations"); },
    async hasTables(names) {
      if (names) return (await client.query("SELECT 1 FROM pg_tables WHERE schemaname = current_schema() AND tablename IN (SELECT jsonb_array_elements_text($1::jsonb))", [JSON.stringify(names)])).rows.length > 0;
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = current_schema() AND tablename !~ '^_?delta_'",
      );
      return rows[0]!.n > 0;
    },
    async create() { await client.query("CREATE TABLE IF NOT EXISTS delta_migrations (app TEXT NOT NULL, id TEXT NOT NULL, ran_at TEXT NOT NULL, PRIMARY KEY (app, id))"); },
    async recorded() { return (await client.query("SELECT id, ran_at FROM delta_migrations WHERE app = $1 ORDER BY ran_at, id", [app])).rows; },
    async transaction(fn) {
      await client.query("BEGIN");
      try {
        const out = await fn(client);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    },
    async has(tx, id) { return (await tx.query("SELECT 1 FROM delta_migrations WHERE app = $1 AND id = $2", [app, id])).rows.length > 0; },
    async record(tx, id, at) { await tx.query("INSERT INTO delta_migrations (app, id, ran_at) VALUES ($1, $2, $3)", [app, id, at]); },
    async fence(tx) { if (await regclass(tx, "_delta_ledger")) await tx.query("UPDATE _delta_ledger SET undoable = FALSE WHERE undoable"); },
  };
}

/** Runs `fn` on a client of its own, holding nothing after. */
async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); }
  finally { client.release(); }
}

/**
 * Runs each migration of the app's list not yet run here, in order, each in
 * its own transaction on one client (`up(client)`). Call it at start-up, before
 * `applyFramework` and the schema's `generateSql`; name the app and give its
 * schema when apps share the database.
 */
export function migrate(pool: Pool, migrations: Migration<PoolClient>[], options: MigrateOptions = {}): Promise<MigrateResult> {
  return withClient(pool, (client) => runMigrations(store(client, appOf(options)), migrations, options));
}

/** What of the app's has run here, what would run, and whether the app is new here; changes nothing. */
export function migrationStatus(pool: Pool, migrations: Migration<PoolClient>[], options: MigrateOptions = {}): Promise<MigrationStatus> {
  return withClient(pool, (client) => statusOf(store(client, appOf(options)), migrations, options));
}

// ---------------------------------------------------------------------------
// Helpers: each one change, with delta's scaffolding kept in step. Each takes
// the client `up` is given.
// ---------------------------------------------------------------------------

/** Renames a column, every version of every row with it, and in the table's `current_` view; its `idx_<table>_<from>` index goes by the new name. */
export async function renameColumn(tx: Tx, table: string, from: string, to: string): Promise<void> {
  await tx.query(`ALTER TABLE ${q(table)} RENAME COLUMN ${q(from)} TO ${q(to)}`);
  if (await regclass(tx, `current_${table}`)) await tx.query(`ALTER VIEW ${q(`current_${table}`)} RENAME COLUMN ${q(from)} TO ${q(to)}`);
  await tx.query(`ALTER INDEX IF EXISTS ${q(`idx_${table}_${from}`)} RENAME TO ${q(`idx_${table}_${to}`)}`);
}

/**
 * Drops a column and what it held. A temporal table's `current_` view reads
 * every column, so it is made again without it, with the grants it had. Move
 * what must be kept first.
 */
export async function dropColumn(tx: Tx, table: string, column: string): Promise<void> {
  const view = `current_${table}`;
  if (!(await regclass(tx, view))) {
    await tx.query(`ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`);
    return;
  }
  const { rows: grants } = await tx.query(
    `SELECT grantee, privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = current_schema() AND table_name = $1 AND grantee <> current_user`, [view]);
  await tx.query(`DROP VIEW ${q(view)}`);
  await tx.query(`ALTER TABLE ${q(table)} DROP COLUMN ${q(column)}`);
  await tx.query(`CREATE VIEW ${q(view)} WITH (security_invoker = true) AS SELECT * FROM ${q(table)} WHERE valid_to IS NULL`);
  for (const g of grants) await tx.query(`GRANT ${g.privilege_type} ON ${q(view)} TO ${g.grantee === "PUBLIC" ? "PUBLIC" : q(g.grantee)}`);
}

/**
 * Renames a table, with its `current_<table>` view, its `idx_<table>_…`
 * indexes and primary key, its `seq_<table>` serial (the next id follows on),
 * and the name `_delta_collections` keeps for it.
 */
export async function renameTable(tx: Tx, from: string, to: string): Promise<void> {
  await tx.query(`ALTER TABLE ${q(from)} RENAME TO ${q(to)}`);
  await tx.query(`ALTER VIEW IF EXISTS ${q(`current_${from}`)} RENAME TO ${q(`current_${to}`)}`);
  await tx.query(`ALTER SEQUENCE IF EXISTS ${q(`seq_${from}`)} RENAME TO ${q(`seq_${to}`)}`);
  const { rows: indexes } = await tx.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND starts_with(indexname, $2)", [to, `idx_${from}_`]);
  for (const { indexname } of indexes) await tx.query(`ALTER INDEX ${q(indexname)} RENAME TO ${q(`idx_${to}_${indexname.slice(`idx_${from}_`.length)}`)}`);
  const { rows: pkey } = await tx.query(
    "SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2", [q(to), `${from}_pkey`]);
  if (pkey.length) await tx.query(`ALTER TABLE ${q(to)} RENAME CONSTRAINT ${q(`${from}_pkey`)} TO ${q(`${to}_pkey`)}`);
  if (await regclass(tx, "_delta_collections")) await tx.query("UPDATE _delta_collections SET table_name = $2 WHERE table_name = $1", [from, to]);
}
