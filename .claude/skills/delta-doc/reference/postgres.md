# Postgres (a server, or PGlite in process)

From `examples/kanban/serve.ts` and its `setup.ts`: the framework, the tables, the listener.

```ts
import { Pool } from "pg";
import { createWs } from "@blueshed/delta/server";
import { applyFramework, applySql, generateSql, createDocListener, docTypeFromDef } from "@blueshed/delta/postgres";
import { schema, docs } from "./schema";

const pool = new Pool({ connectionString: process.env.PG_URL });   // or: await openPglite(dir?)
await applyFramework(pool);                          // 001a–001g, idempotent
await applySql(pool, generateSql(schema, docs));     // your tables

const ws = createWs();
const listener = await createDocListener(ws, pool, { types: docs.map((def) => docTypeFromDef(def, pool)) });
const server = Bun.serve({ routes: { "/": index, [ws.path]: ws.upgrade }, websocket: ws.websocket });
ws.setServer(server);   // REQUIRED: without it nothing is broadcast

// shutdown: the listener holds a pool client for LISTEN
await listener.destroy();
await pool.end();
```

Options: `createDocListener` and `docTypeFromDef` in `src/server/postgres/listener.ts` and
`registry.ts`. With auth: `auth.md`, `ownership.md`, `rls.md`.

## Setting up the database

- **Programmatic**: `applyFramework(pool)`, `applyAuthJwtSchema(pool)` (if `jwtAuth`), then
  `applySql(pool, generateSql(schema, docs))`.
- **Vendored** (a migration tool or `docker-entrypoint-initdb.d` owns the database):
  `bunx @blueshed/delta init init_db --with-auth` copies `001a–001g` (and `002-users.sql`);
  `bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql` writes your tables. The SQL
  is yours, in git; only the SQL is vendored, the TypeScript is imported.
- **Upgrading the app**: `migrate(pool, migrations, { app, schema })` first, then
  `applyFramework` and `applySql(pool, generateSql(…))`. `generateSql` adds a column a later
  schema declares; a migration does the rest (`migrations.md`). Give the listener your
  `schema` (`createDocListener(ws, pool, { types, schema })`): it sends and writes the columns
  it declares, so two versions on one database each see their own.
- **After upgrading delta**, run `init <dir> --upgrade` (it keeps `.bak`s and says what changed)
  or `applyFramework` again. Never edit `001*` by hand: it is the stored-function contract.
- Mount `init_db/` at `/docker-entrypoint-initdb.d`: Postgres applies it alphabetically on the
  first boot of an empty volume, then skips; `docker compose down -v` starts fresh.

## Gotchas

- `bun add pg`, and `bun add -d @types/pg` to type-check (delta ships TS source).
- Ids are BIGINTs from `seq_<table>`: a client id that is not a number, or past 2^53 - 1, is a
  400; one that is moves the sequence past it.
- Implied documents are named by number here (`room:7`).
- **Each listener has its own types**: two servers in one process each answer for theirs. One
  prefix, one type; `listener.register(type)` replaces its prefix's type (for `bun --hot`).
- `delta_open` raises on configuration errors (unknown prefix or root); NULL only means a
  single root row is not there, which the listener answers 404.
- Write through `delta_apply` (the listener, or `delta_apply_as` from SQL), never a raw
  `INSERT`: only that path versions, logs and NOTIFYs (`sql.md`).
- A hand-written `DocType` hears only its own writes (`custom-docs.md`).
- `_delta_ops_log` is a catch-up buffer: prune it with `pruneOpsLog(pool)` (`delta_prune_ops`).
- PGlite (`openPglite(dir?)`, `bun add @electric-sql/pglite`) is one process: a `Pool` that
  `./postgres` runs on unchanged.
- **The superuser bypasses RLS**, even with `FORCE`: documents need a non-superuser pool (`rls.md`).
