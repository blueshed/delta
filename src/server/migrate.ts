/**
 * Migrations: the changes to a database a schema cannot say -- a column
 * renamed or dropped, a table renamed, data moved -- run once each, in order,
 * at start-up, before the schema's own `createTables` / `migrateSchema` (or
 * `generateSql`) add what it declares. The same on SQLite (`./sqlite`) and
 * Postgres (`./postgres`, PGlite too); each backend's `migrate` is this
 * runner over its own database.
 *
 * - Migrations belong to an app (`app`, default ""): several apps may share a
 *   database, each its own list, and an id is one app's.
 * - Recorded in `delta_migrations (app, id, ran_at)`: an app's id there never
 *   runs again.
 * - Each in its own transaction, with its record: a failure rolls that one
 *   back, stops, and throws naming it; the ones before it stay.
 * - An id recorded that the list no longer has is a warning, never an error.
 * - An app new to the database (nothing recorded for it, and none of its
 *   tables there: its schema's, or without one any table but delta's own)
 *   runs none: the schema it is about to be made from is already where they
 *   lead, so each is recorded as run.
 * - The ledger is fenced: a migration changes rows under the ledger's paths,
 *   so the app's entries before it -- those over its schema's collections; with
 *   no schema, every entry -- are made not undoable (undo answers null,
 *   nothing to walk), and history still shows them. Another app's undo goes on.
 */
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createLogger } from "./logger";
import type { Schema } from "../schema";

/** One change to a database: `up` gets the transaction it runs in (SQLite: the `Database`; Postgres: the pool's client). */
export type Migration<Tx = any> = {
  /** Its name, recorded once it has run: `002-name-is-full-name`. Never change it, or the migration, once it has run anywhere. */
  id: string;
  up(tx: Tx): void | Promise<void>;
};

/** What `migrate` did: the ids it ran, in order; whether the database was new (every id recorded, none run); ids recorded the list no longer has. */
export type MigrateResult = { ran: string[]; fresh: boolean; unknown: string[] };

/** Where a database stands against a list: what has run (and when), what would run, ids recorded the list no longer has, and whether it is new (`migrate` would record every id without running it). */
export type MigrationStatus = { fresh: boolean; ran: { id: string; ran_at: string }[]; pending: string[]; unknown: string[] };

/** Whose migrations, and how to tell whether the app is new here. */
export type MigrateOptions = {
  /** The app the list belongs to, recorded with each id (default ""): give one when apps share a database. */
  app?: string;
  /**
   * The app's schema: the app is new to the database when none of its tables are there, or
   * all are, made from it (every declared column) and holding no row -- `init_db/` made them
   * at first boot. Its collections are what a migration fences. Without one, any table but
   * delta's own says the app has lived here, and a migration fences the whole ledger.
   */
  schema?: Schema;
};

/** A backend's side of the runner, for one app. */
export interface Store<Tx> {
  /** The runner holds this while it works (Postgres: an advisory lock), and lets it go after. */
  lock(): Promise<void>;
  unlock(): Promise<void>;
  /** Whether `delta_migrations` is there. */
  exists(): Promise<boolean>;
  /** Whether a table is there that is not delta's own (`isDeltasOwn`). */
  hasAppTables(): Promise<boolean>;
  /** Of the tables named, those that are there: each its columns, and whether it holds a row. */
  tables(names: string[]): Promise<Map<string, { columns: string[]; rows: boolean }>>;
  /** Makes `delta_migrations` (if it is not there). */
  create(): Promise<void>;
  /** What has run of the app's, oldest first. */
  recorded(): Promise<{ id: string; ran_at: string }[]>;
  /** Runs `fn` in a transaction: committed if it returns, rolled back if it throws. */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** In a transaction: whether `id` is recorded (another process may have run it since the runner looked). */
  has(tx: Tx, id: string): Promise<boolean>;
  /** In a transaction: records `id` as run at `at`. */
  record(tx: Tx, id: string, at: string): Promise<void>;
  /** In a transaction: makes the app's ledger entries so far not undoable (the fence): those over its schema's collections (`fenced`), or with no schema, every entry. */
  fence(tx: Tx): Promise<void>;
}

const log = createLogger("[delta-migrate]");

/** A table delta keeps for itself: never the app's. */
export const isDeltasOwn = (table: string): boolean => /^_?delta_/.test(table);

/** The list as given, checked: each has a name and an `up`, and no name twice. */
function checked<Tx>(migrations: Migration<Tx>[]): Migration<Tx>[] {
  const seen = new Set<string>();
  for (const m of migrations) {
    if (typeof m?.id !== "string" || !m.id.trim()) throw new Error(`[delta-migrate] a migration has no id: ${JSON.stringify(m)}`);
    if (typeof m.up !== "function") throw new Error(`[delta-migrate] migration ${m.id} has no up(tx)`);
    if (seen.has(m.id)) throw new Error(`[delta-migrate] two migrations are named ${m.id}`);
    seen.add(m.id);
  }
  return migrations;
}

/**
 * The app is new to the database: nothing recorded for it, and its tables not
 * there -- or there as its schema makes them, every declared column, holding
 * no row (made from the schema before its first start: `init_db/` at a
 * Postgres's first boot). A row is data a migration is for: then, or in
 * another shape (an earlier version's), the app has lived here, and its list runs.
 */
async function isNew<Tx>(store: Store<Tx>, options: MigrateOptions): Promise<boolean> {
  if ((await store.exists()) && (await store.recorded()).length > 0) return false;
  if (!options.schema) return !(await store.hasAppTables());
  const wanted = Object.values(options.schema.tables).map((t) => ({ name: t.name, columns: ["id", ...(t.parent ? [t.parent.fkColumn] : []), ...Object.keys(t.columns)] }));
  const there = await store.tables(wanted.map((t) => t.name));
  if (there.size === 0) return true;
  return wanted.every((t) => t.columns.every((c) => there.get(t.name)?.columns.includes(c))) && [...there.values()].every((t) => !t.rows);
}

/** The collections whose ledger entries a migration of the app fences: its schema's, as JSON; none named, every entry (undefined). */
export const fenced = (options: MigrateOptions): string | undefined =>
  options.schema ? JSON.stringify(Object.keys(options.schema.tables)) : undefined;

/** The app a list belongs to: a name, or "" for a database's one app. */
export function appOf(options: MigrateOptions): string {
  const app = options.app ?? "";
  if (typeof app !== "string") throw new Error(`[delta-migrate] app is a name: ${JSON.stringify(app)}`);
  return app;
}

/** Where the list stands against what is recorded. */
function plan<Tx>(migrations: Migration<Tx>[], recorded: { id: string; ran_at: string }[]) {
  const done = new Set(recorded.map((r) => r.id));
  const named = new Set(migrations.map((m) => m.id));
  return {
    pending: migrations.filter((m) => !done.has(m.id)),
    unknown: recorded.map((r) => r.id).filter((id) => !named.has(id)),
  };
}

/** Runs every pending migration of the list, in its order, each once. */
export async function runMigrations<Tx>(store: Store<Tx>, migrations: Migration<Tx>[], options: MigrateOptions = {}): Promise<MigrateResult> {
  checked(migrations);
  const app = appOf(options);
  const named = (id: string) => (app ? `${app}'s ${id}` : id);
  await store.lock();
  try {
    const fresh = await isNew(store, options);
    await store.create();
    if (fresh) {
      // made from the schema as it is now: where every migration leads
      const at = new Date().toISOString();
      await store.transaction(async (tx) => { for (const m of migrations) if (!(await store.has(tx, m.id))) await store.record(tx, m.id, at); });
      return { ran: [], fresh, unknown: [] };
    }
    const { pending, unknown } = plan(migrations, await store.recorded());
    for (const id of unknown) log.warn(`${named(id)} has run here but is not in the list: left as it is`);
    const ran: string[] = [];
    for (const m of pending) {
      const done = await store.transaction(async (tx) => {
        if (await store.has(tx, m.id)) return false;   // another process ran it
        try {
          await m.up(tx);
        } catch (err) {
          throw new Error(`[delta-migrate] migration ${named(m.id)} failed, and was rolled back: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
        }
        await store.record(tx, m.id, new Date().toISOString());
        await store.fence(tx);
        return true;
      });
      if (done) { ran.push(m.id); log.info(`ran ${named(m.id)}`); }
    }
    return { ran, fresh, unknown };
  } finally {
    await store.unlock();
  }
}

/** Where a database stands against the list; changes nothing. */
export async function statusOf<Tx>(store: Store<Tx>, migrations: Migration<Tx>[], options: MigrateOptions = {}): Promise<MigrationStatus> {
  checked(migrations);
  const fresh = await isNew(store, options);
  const recorded = (await store.exists()) ? await store.recorded() : [];
  const { pending, unknown } = plan(migrations, recorded);
  return { fresh, ran: recorded, pending: pending.map((m) => m.id), unknown };
}

/**
 * The migrations in a folder, by file name: each `NNN-name.ts` (or `.js`)
 * exports `up`, and its id is its name without the extension. Sorted by name,
 * so number them: `001-…`, `002-…`.
 */
export async function fromFolder<Tx = any>(dir: string): Promise<Migration<Tx>[]> {
  const files = readdirSync(dir).filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.(d|test)\.\w+$/.test(f)).toSorted();
  const out: Migration<Tx>[] = [];
  for (const file of files) {
    const mod = await import(resolve(join(dir, file)));
    if (typeof mod.up !== "function") throw new Error(`[delta-migrate] ${file} exports no up(tx)`);
    out.push({ id: file.replace(/\.\w+$/, ""), up: mod.up });
  }
  return out;
}
