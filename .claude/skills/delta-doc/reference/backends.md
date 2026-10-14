# Backends: where documents are kept

Moving the recipe's chat from the JSON file to SQLite changes `server.ts`'s wiring only:

```ts
import { Database } from "bun:sqlite";
import { exportTables } from "@blueshed/delta/json";
import { createTables, importTables, registerDocs } from "@blueshed/delta/sqlite";

const db = new Database("chat.db");
createTables(db, schema);
importTables(db, schema, exportTables("./chat.json", schema));   // once, into empty tables
registerDocs(ws, db, schema, [room]);
```

## Pick the smallest that fits

- **JSON file** (`registerDocs(ws, file, …)`, `./json`): starting out, one process, a file you can read.
- **SQLite** (`createTables` then `registerDocs(ws, db, …)`, `./sqlite`): more rows; processes may
  share the file but hear only their own writes live (`sqlite.md`).
- **PGlite** (`openPglite(dir?)`, `./pglite`, `bun add @electric-sql/pglite`): Postgres's stored
  functions in this process, no server; then as Postgres.
- **Postgres server** (`createDocListener`, `./postgres`): several processes, RLS (`postgres.md`).
- **Free-form, memory, source, static**: not tables (`kinds.md`).

The four table backends take one schema and one set of `defineDoc`s; `./json`, `./sqlite` and
`./postgres` each export `defineSchema`, `defineDoc`, `defineCustomDoc`, so moving on changes
the import path.

## Moving on

`exportTables` from where the rows are, `importTables` into where they go (every table backend
has both; one `Snapshot`, `src/schema.ts`). Rows, temporal versions and sequences carry, so the
next id follows on. The ledger does not: undo history starts fresh.

## The same on every table backend

`tests/helpers/path.ts` asks each of them:

- One scope rule, single or list (`scope.md`); one error table (`paths.md`).
- A replace of a row is the row; `add /<coll>/-` takes the next serial (`paths.md`).
- Ids and parent keys come back as numbers; temporal rows without `valid_from` / `valid_to`.
- A write is told to every open document holding a row it changed (`fanout.md`).
- `open_at`; with `ledger: true`, undo, redo, history and a version on every change.
- `auth`, `owns` and `shared` (`ownership.md`).

## What differs

- A client-chosen id must be a number on Postgres; the JSON file and SQLite also keep text ids.
- An implied document named by text (`room:attic`) works only on the JSON file and SQLite; name
  by number (`room:7`) for an app that will move.
- Postgres always versions; elsewhere only with `ledger: true`.
- RLS, and one process told live of another's writes, are Postgres's.

## Gotchas

- Several kinds and backends register on one server, each owning its prefix. Register the
  Postgres listener **last**: it answers 404 for any name it does not own, and the first answer wins.
- Postgres type-checking needs `bun add pg` and `bun add -d @types/pg` (delta ships TS source,
  so `skipLibCheck` does not cover it).
