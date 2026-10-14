# Migrations: upgrading a database that holds real data

**The schema is the contract.** delta sees only what the schema declares: reads, writes,
inverses and undo use the declared columns (and the id, the parent key, a temporal row's
validity). A database may hold **more** (a migration ahead of this version), never **less**:
at start-up `migrate`, then `createTables` / `migrateSchema` (Postgres: `generateSql`), make
what is declared. So an upgrade can expand and contract with two versions on one database:

1. **Expand**: a migration adds a column; the running version is blind to it (its writes leave
   it as it is; a new row takes its database default).
2. The new version declares it and uses it, beside the old one.
3. **Contract**: once no running version declares the old column, a later migration drops it.

`tests/schema-contract.test.ts` runs those steps; `tests/migrate.test.ts` the rest, on SQLite
and Postgres (PGlite) alike.

## A migration

From `tests/migrate.test.ts`: version two renames `name` to `full_name`, moves the fax into the
phone and drops it, and declares a new `email`, which `migrateSchema` adds.

```ts
import { Database } from "bun:sqlite";
import { createTables, migrateSchema, migrate, renameColumn, dropColumn, type Migration } from "@blueshed/delta/sqlite";

const migrations: Migration<Database>[] = [
  { id: "001-name-is-full-name", up: (db) => renameColumn(db, "people", "name", "full_name") },
  { id: "002-fax-into-phone", up: (db) => db.run("UPDATE people SET phone = fax WHERE phone IS NULL") },
  { id: "003-no-fax", up: (db) => dropColumn(db, "people", "fax") },
];

await migrate(db, migrations, { app: "team", schema });   // first: the changes a schema cannot say
createTables(db, schema);                                  // then what the schema declares
migrateSchema(db, schema);
```

Postgres (and PGlite) is the same shape from `@blueshed/delta/postgres`: `up(client)` is async
and the helpers are awaited; `await migrate(pool, migrations, { app, schema })`, then
`applyFramework(pool)` and `applySql(pool, generateSql(schema, docs))`.

- **Run once, in order.** Each runs in its own transaction with its record in
  `delta_migrations (app, id, ran_at)`; an id recorded never runs again. A failure rolls that
  one back and throws naming it; the ones before it stay. Postgres takes an advisory lock, so
  two processes starting at once run each once.
- **Helpers** (each keeps the `current_<table>` view, the `idx_<table>_…` indexes and the serial
  in step): `renameColumn`, `dropColumn`, `renameTable`. Moving data is SQL on `tx`.
- **`fromFolder(dir)`**: `migrations/NNN-name.ts`, each exporting `up`, sorted by name, the id
  the file's name.
- **`migrationStatus(db, list, options)`**: what ran, what is pending, ids recorded the list no
  longer has, and whether the app is new here. From a shell: `bunx @blueshed/delta migrate
  <database> --app <name> --status` (`cli.md`).
- Types: `Migration`, `MigrateOptions`, `MigrateResult`, `MigrationStatus` in
  `src/server/migrate.ts`.

## Gotchas

- **Never edit a migration that has run anywhere**, nor rename its id: write the next one.
- **A migration is for data that must be kept.** A new database (or an app new to it: nothing
  recorded for it, none of its schema's tables there) runs none: it is made from the schema,
  already where they lead, and each is recorded as run. Seed data is the seed's, not a migration's.
- **Name the app when apps share a database** (`{ app, schema }`): an id is one app's, and
  "new here" is asked of its schema's tables. Without a schema, any table but delta's own says
  the app has lived here: a first start that renames every table of an app that never ran
  `migrate` would look new, so run `migrate` once before such a release.
- **The ledger is fenced.** A migration moves rows under the ledger's paths, so each one makes
  every entry before it not undoable: undo and redo answer `null` (nothing to walk) and
  `history` shows them with `undoable: false`. The fence covers the whole database's ledger.
- To move data into a column the schema is adding, add it in the migration (`ALTER TABLE … ADD
  COLUMN`); `migrateSchema` then finds it there.
- Run migrations at start-up, outside a transaction, before any document opens: a process
  already serving keeps copies of what a migration changed.
- **On Postgres the declaration is the database's** (`_delta_collections`, the last
  `generateSql` applied): during step 2 the old version's documents show the new column too.
- The JSON file (`./json`) has no migrations: move to SQLite (`exportTables` / `importTables`)
  to migrate. A Postgres whose tables `init_db/` made at first boot looks lived-in to
  `migrate`, whose list would then run against tables already at their end: let the app's
  start-up make its tables (`applySql(pool, generateSql(…))`), and vendor only the framework.
