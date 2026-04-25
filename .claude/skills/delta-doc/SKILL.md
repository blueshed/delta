---
name: delta-doc
description: "Delta-doc — JSON-Patch document sync over WebSocket with three backends (JSON file, SQLite, Postgres). Use when picking a backend, importing @blueshed/delta, defining doc or custom-doc types, writing ops, wiring authentication, or driving a running server from the CLI."
---

Narrow AI-native primitive. Mutations are JSON-Patch ops on `/collection/id`. Transport is WebSocket. Three server-side backends, same client and same op vocabulary across all of them:

1. **JSON file** — `registerDoc(ws, name, { file, empty })` from `@blueshed/delta/server`. One doc per file, single process. Right for prototyping, single-doc apps, config-shaped state.
2. **SQLite** — `registerDocs(ws, db, schema, docs, customDocs?)` from `@blueshed/delta/sqlite`. Many docs, relational queries, temporal history. Single process.
3. **Postgres** — `createDocListener(ws, pool, { custom? })` + `registerDocType(docTypeFromDef(...))` from `@blueshed/delta/postgres`. Cross-process fan-out via LISTEN/NOTIFY, scope operators, stored-function auth.

Move up the ladder when you outgrow the tier you're on; the browser code does not change. Custom doc types (predicate-based membership views) are supported on SQLite and Postgres via `defineCustomDoc`.

**For the full API, patterns, and recipes: read `reference.md` (in this skill directory).** This file is the router; reference.md is the manual.

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp` |
| `@blueshed/delta/client` | browser | `connectWs` (with `close()`), `openDoc`, `call`, `WS` |
| `@blueshed/delta/dom-ops` | browser | `applyOpsToCollection` — route ops to keyed DOM nodes without rebuilding |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc` (JSON-file backend), `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `defineCustomDoc`, `registerDocs(..., customDocs?)`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `defineDoc`, `defineCustomDoc`, `generateSql`, `applyFramework`, `createDocListener(ws, pool, { custom? })`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` contract, `wireAuth`, `upgradeWithAuth` |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })`, `applyAuthJwtSchema(pool)` |

## CLI

The package ships a `delta` bin; invoke it via `bunx delta`.

**Build-time:**

```bash
# Copy framework SQL (001a–001e) into init_db/. Add --with-auth for the users schema.
bunx delta init init_db --with-auth

# Regenerate your table SQL from types.ts (must export `schema` and `docs`).
bunx delta sql ./types.ts --out init_db/003-tables.sql
```

**Runtime — talk to a running delta server:**

```bash
bunx delta open  <docName>             # one-shot: open + print state + exit
bunx delta watch <docName>             # open, then stream broadcast ops
bunx delta delta <docName> <opsJSON>   # opens + applies ops + prints ack
bunx delta call  <method>  [paramsJSON]  # invokes an RPC method
```

URL resolution (in order): `--url <url>` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`.

## Bootstrap (two ways)

**Programmatic** (recommended when the app owns the DB):

```ts
import { Pool } from "pg";
import { applyFramework, applySql, generateSql } from "@blueshed/delta/postgres";
import { applyAuthJwtSchema } from "@blueshed/delta/auth-jwt";
import { schema, docs } from "./types";

const pool = new Pool({ connectionString: process.env.PG_URL });
await applyFramework(pool);              // 001a–001e framework SQL
await applyAuthJwtSchema(pool);          // users + register/login (opt-in)
await applySql(pool, generateSql(schema, docs));  // your 002-tables equivalent
```

**File-based** (when `docker-entrypoint-initdb.d` or a migration tool owns the DB):

```bash
bunx delta init init_db --with-auth
bunx delta sql ./types.ts --out init_db/003-tables.sql
```

Everything is idempotent — safe to re-apply on every boot.

## Custom doc types — predicate-based membership views

`defineCustomDoc` declares a read-only doc whose contents are decided by a
user-supplied predicate over a watched collection. Writes still go through
the standard doc; the framework evaluates membership for every open custom
doc on each commit and emits transition ops (`add` / `replace` / `remove`)
on the custom doc's own shape.

```ts
import { defineCustomDoc } from "@blueshed/delta/sqlite";   // or .../postgres

const sitesInBbox = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse:   (docId) => parseBbox(docId),                      // docId → criteria
  query:   (db, c) => ({ sites: db.query("...").all(...) }), // initial load
  matches: (_coll, row, c) => inBbox(row, c),                // membership predicate
});

// SQLite: 5th arg of registerDocs.
registerDocs(ws, db, schema, [worldDoc], [sitesInBbox]);

// Postgres: opts.custom on createDocListener.
await createDocListener(ws, pool, { custom: [sitesInBbox] });
```

Custom docs are read-only — `delta` against a custom doc returns 403; write
through the source doc instead. The full worked example lives in
`examples/sites-bbox/`.

## Files to read when deeper detail is needed

`core.ts` · `client.ts` · `server.ts` · `sqlite.ts` · `logger.ts` · `auth.ts` · `auth-jwt.ts` · `cli.ts`
`postgres/index.ts` · `postgres/schema.ts` · `postgres/codegen.ts` · `postgres/bootstrap.ts` · `postgres/listener.ts` · `postgres/registry.ts` · `postgres/auth.ts`
`postgres/sql/001a-001e-*.sql` (framework stored functions — read-only) · `auth-jwt.sql` (reference users schema)

## The primitive

```ts
type DeltaOp =
  | { op: "replace"; path: string; value: unknown }  // set at path
  | { op: "add";     path: string; value: unknown }  // set, or append with /-
  | { op: "remove";  path: string };                 // delete by path
```

Paths: `/collection` (list), `/collection/id` (row), `/collection/id/field` (field), `/collection/-` (append).

## Rules

- **One op vocabulary**: only `add` / `replace` / `remove` on `/<coll>/<id>` paths. Never invent new op verbs.
- **Regenerate `003-tables.sql` with the CLI**: `bunx delta sql ./types.ts --out init_db/003-tables.sql`. Never hand-edit. (Framework SQL is `001a–001f`, auth-jwt is `002`, your tables are `003`.)
- **Never edit framework SQL**: `001a-001e-*.sql` are the stored-function contract.
- **Never put tokens in WS URLs**: use `onUpgrade` (cookies / Authorization) or the `authenticate` call action.
- **No bare `pool.query` when auth is enabled**: let `docTypeFromDef({ auth })` route through `withAppAuth`.
- **Scope keys must be real columns of the root collection**: `scope: { "items.id": ":id" }` looks reasonable but raises at runtime — use `scope: { id: ":id" }` (or leave the scope empty for single-mode; the framework defaults to `WHERE id = <doc-id>`). Same for any scope key: typos / dotted forms fail fast.
- **`delta_open` raises on config errors**: unknown doc prefix or unknown root collection → exception, not NULL. NULL only means "single-mode row doesn't exist yet" — the listener maps that to 404.
- **`openDoc(name, ws?)` takes an optional client for multi-client scripts**: each `connectWs()` instance owns its own reactive state. `openDoc("foo")` without a client falls back to `inject(WS)` (browser DI path); `openDoc("foo", alice)` / `openDoc("foo", bob)` give two independent signals + ops handlers.
- **Close sockets with `wsClient.close()` in tests/scripts**: `connectWs` gives a reconnecting socket. Without `close()` it reconnects forever after the server stops.
- **Sequences follow `seq_<table>` convention**: `delta_apply` expects `nextval('seq_items')`. `generateSql` handles this — don't hand-write tables.
- **`SET LOCAL` can't bind params**: use `set_config(name, value, true)` instead. (This is why `withAppAuth` looks the way it does.)
- **Custom `DocType` parses its own prefix**: do not put prefix logic anywhere else in the app.
- **Doc names are data**: `items:` (list), `venue:42` (single), `venue-at:42:2026-06-16` (temporal scoped). Prefix up to and including `:` owns the handler.
- **Client is signal-driven**: subscribers on `doc.data` auto-update; do not re-read the doc manually.
- **Never rebuild a collection from `doc.data` inside an `effect`**: patterns like `effect(() => { list.innerHTML = ""; for (const r of doc.data.get().rows) list.append(render(r)); })` throw away the op-level precision the protocol gave you — focus, scroll, animations, cursor all reset on every op. **Use `doc.onOps(handler)` with `applyOpsToCollection` from `@blueshed/delta/dom-ops`** for any list of more than ~10 rows.
- **Await `authenticate` before `openDoc`**: an unauthenticated `open` will race past the auth response and fail with 401. Order: `await call("authenticate", {...})` → then `openDoc(...)`.
