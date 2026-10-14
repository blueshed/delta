# Migrations: upgrading a database that holds real data

**The schema is the contract.** delta sees only what the schema declares: what it sends
(documents, answers, broadcasts, history) and what it writes are the declared columns (and the
id, the parent key, a temporal row's validity). A database may hold **more** (a migration ahead
of this version), never **less**: at start-up `migrate`, then `createTables` / `migrateSchema`
(Postgres: `generateSql`), make what is declared. A column a version does not declare keeps what
it holds: a write leaves it, a new row takes its database default, and the ledger keeps rows as
stored, so undoing a remove puts the row back whole. So an upgrade can expand and contract with
two versions on one database:

1. **Expand**: a migration adds a column; the running version is blind to it.
2. The new version declares it and uses it, beside the old one.
3. **Contract**: once no running version declares the old column, a later migration drops it.

On Postgres each process declares by its own schema: `createDocListener(ws, pool, { types,
schema })`. Without `schema` it takes what the database declares as it starts (the last
`generateSql` applied). `tests/schema-contract.test.ts` runs the steps on SQLite and PGlite.

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

- **Once, in order.** Each runs in its own transaction with its record in
  `delta_migrations (app, id, ran_at)`. A failure rolls that one back and throws naming it; the
  ones before it stay. Postgres takes an advisory lock: two processes starting at once run each once.
- **Helpers** (each keeps the `current_<table>` view, the `idx_<table>_…` indexes and the serial
  in step): `renameColumn`, `dropColumn`, `renameTable`. Moving data is SQL on `tx`.
- **`fromFolder(dir)`**: `migrations/NNN-name.ts`, each exporting `up`, sorted by name.
- **`migrationStatus(db, list, options)`**: what ran, what is pending, ids recorded that the list
  no longer has (a warning, never an error), and whether the app is new here. From a shell:
  `bunx @blueshed/delta migrate <database> --app <name> --status` (`cli.md`).
- Types: `Migration`, `MigrateOptions`, `MigrateResult`, `MigrationStatus` in `src/server/migrate.ts`.

## New, and lived in

An app is **new** to a database when nothing is recorded for it and its schema's tables are not
there, or are there as its schema makes them (every declared column) with no row: `init_db/`
made them at a Postgres's first boot. A new app records every migration and runs none. A row is
data a migration is for: then, or with tables of another shape (an earlier version's), the app
has lived here and its list runs. Give `app` and `schema` when apps share a database.

## Gotchas

- **Never edit a migration that has run anywhere**, nor rename its id: write the next one.
- **A migration is for data that must be kept.** Seed data is the seed's, not a migration's.
- **The ledger is fenced.** A migration moves rows under the ledger's paths, so it makes the
  app's entries before it (those over its schema's collections; with no schema, every entry)
  not undoable: undo and redo answer `null`, `history` shows them with `undoable: false`.
  Another app on the database undoes on.
- To move data into a column the schema is adding, add it in the migration; `migrateSchema`
  then finds it there.
- Run migrations at start-up, outside a transaction, before any document opens.
- **The JSON file has no migrations.** The file backend is for documents you can reset; to keep
  data across upgrades, keep it in SQLite or Postgres.
