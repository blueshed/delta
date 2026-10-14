# SQLite (and the JSON file)

A schema, validation (400 for unknown fields, wrong types, missing required ones), temporal
history and the ledger, with no database server. The JSON file is the same engine: SQLite in
memory, loaded from the file and saved after every change.

```ts
import { Database } from "bun:sqlite";
import { createWs } from "@blueshed/delta/server";
import { defineSchema, defineDoc, createTables, registerDocs } from "@blueshed/delta/sqlite";

export const schema = defineSchema({
  lists: { columns: { title: "text?" } },
  todos: { parent: "lists", columns: { text: "text", done: { type: "boolean", default: false } } },
});
export const listDoc = defineDoc("list:", { root: "lists", include: ["todos"], implied: true });

const db = new Database("app.db");
createTables(db, schema);                  // before the first open
const ws = createWs();
registerDocs(ws, db, schema, [listDoc]);   // , customDocs?, { ledger, auth, owns, shared, who }
```

Options: `RegisterOptions` in `src/server/sqlite.ts`. It returns `{ evict }` (the JSON file's
also `persisted()`, resolving once every change so far is in the file).

## Gotchas

- `createTables(db, schema)` before the first open; a missing table's error says so.
  `migrateSchema(db, schema)` only adds what a later schema declares (columns, and
  `console.warn`s on type drift: treat that as a real signal). A rename, a drop, a change of
  type or data moved is a migration, run first: `migrations.md`.
- A single document's root row must exist before it opens: seed it, or declare it `implied: true`.
- A `delta` for a name this process has not opened is 404 `Doc not loaded`. `doc.send` never
  meets it; a script sending `delta` itself opens the document first.
- **Processes may share the file.** A write takes the lock (`BEGIN IMMEDIATE`, 5 s
  `busy_timeout` unless the app set its own) and re-reads any copy another process changed. But a
  document open in one process is **not told** of a write in another until it is next opened or
  written through: live fan-out across processes is Postgres's.
- `bun:sqlite` is synchronous: waiting for another process's lock blocks the event loop. Keep
  writes short on a shared file; a write from another process drops every cached copy here.
- **Auth without RLS.** `{ auth, owns }` (or `shared: true`) covers every document of the call:
  one `owns`, switch on the name's prefix. Nothing filters what a document reads: the name is the
  whole check, so scope per-user documents by owner (`scope: { owner_id: ":id" }`) and have
  `owns` match the id. A custom doc's `query`, `matches`, `recompute` must check rows themselves.
- Two registrations on one database (a public set with `shared`, a private set with `owns`)
  share the ledger and the fan-out: a write through either is told to every document open on
  that handle. A name goes to the longest matching prefix; a prefix already held is refused.
- The JSON file's registrations of one file on one server share one database.
- An included collection with no `parent` is shared: every document of the prefix holds all of it.
- Writing inside your own transaction makes delta's write a savepoint: see `local.md`.
