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
- **Postgres**: servers that share the data, people who see only their own: the next step is
  dzql's, not delta's (`postgres.md`).
- **Free-form, memory, source, static**: not tables (`kinds.md`).

The two table backends take one schema and one set of `defineDoc`s; `./json` and `./sqlite` each
export `defineSchema`, `defineDoc`, `defineCustomDoc`, so moving on changes the import path.

## Moving on

`exportTables` from where the rows are, `importTables` into where they go (both table backends
have them; one `Snapshot`, `src/schema.ts`). Rows, temporal versions and sequences carry, so the
next id follows on. The ledger does not: undo history starts fresh.

## The same on every table backend

`src/cases/path.ts` asks each of them (dzql answers the same cases for Postgres):

- One scope rule, single or list (`scope.md`); one error table (`paths.md`).
- A replace of a row is the row; `add /<coll>/-` takes the next serial (`paths.md`).
- Ids and parent keys come back as numbers; temporal rows without `valid_from` / `valid_to`.
- A write is told to every open document holding a row it changed (`fanout.md`).
- `open_at`; with `ledger: true`, undo, redo, history and a version on every change.
- `auth`, `owns` and `shared` (`ownership.md`).

## What differs

- The JSON file is one process, a file you can read; SQLite's processes may share the file, each
  told live only of its own writes (`sqlite.md`).
- The JSON file has no migrations: keep data that must last across upgrades in SQLite
  (`migrations.md`).
- An implied document named by text (`room:attic`) works on both; name by number (`room:7`) for
  an app that will move on to Postgres.

## Gotchas

- Several kinds and backends register on one server, each owning its prefix.
