---
name: delta-doc
description: "Delta-doc — JSON-Patch document sync over WebSocket with Postgres or SQLite. Use when importing @blueshed/delta, defining doc types, writing ops against a delta-doc backend, or wiring authentication."
---

Narrow AI-native primitive. Mutations are JSON-Patch ops on `/collection/id`. Transport is WebSocket. Backends are Postgres (stored functions + LISTEN/NOTIFY + temporal tables) or SQLite. Clients get reactive signals via `@blueshed/railroad`.

**For the full API, patterns, and recipes: read `reference.md` (in this skill directory).** This file is the router; reference.md is the manual.

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp` |
| `@blueshed/delta/client` | browser | `connectWs` (with `close()`), `openDoc`, `call`, `WS` |
| `@blueshed/delta/dom-ops` | browser | `applyOpsToCollection` — route ops to keyed DOM nodes without rebuilding |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc`, `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `registerDocs`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `defineDoc`, `generateSql`, `applyFramework`, `createDocListener`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` contract, `wireAuth`, `upgradeWithAuth` |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })`, `applyAuthJwtSchema(pool)` |

## CLI

`bunx @blueshed/delta` (available after `bun install`):

```bash
# Copy framework SQL (001a–001e) into init_db/. Add --with-auth for the users schema.
bunx @blueshed/delta init init_db --with-auth

# Regenerate your table SQL from types.ts (must export `schema` and `docs`).
bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql
```

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
bunx @blueshed/delta init init_db --with-auth
bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql
```

Everything is idempotent — safe to re-apply on every boot.

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
- **Regenerate `003-tables.sql` with the CLI**: `bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql`. Never hand-edit. (Framework SQL is `001a–001f`, auth-jwt is `002`, your tables are `003`.)
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
