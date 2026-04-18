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
| `@blueshed/delta/client` | browser | `connectWs`, `openDoc`, `call`, `WS` |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc`, `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `registerDocs`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `createDocListener`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` contract, `wireAuth`, `upgradeWithAuth` |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })` reference impl |

## Files to read when deeper detail is needed

`core.ts` · `client.ts` · `server.ts` · `sqlite.ts` · `logger.ts` · `auth.ts` · `auth-jwt.ts`
`postgres/index.ts` · `postgres/schema.ts` · `postgres/listener.ts` · `postgres/registry.ts` · `postgres/auth.ts`
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
- **Never edit generated SQL**: `002-tables.sql` comes from `defineSchema` codegen. Regenerate it.
- **Never edit framework SQL**: `001a-001e-*.sql` are the stored-function contract.
- **Never put tokens in WS URLs**: use `onUpgrade` (cookies / Authorization) or the `authenticate` call action.
- **No bare `pool.query` when auth is enabled**: let `docTypeFromDef({ auth })` route through `withAppAuth`.
- **Sequences follow `seq_<table>` convention**: `delta_apply` expects `nextval('seq_items')`, not `items_id_seq`.
- **`SET LOCAL` can't bind params**: use `set_config(name, value, true)` instead. (This is why `withAppAuth` looks the way it does.)
- **Custom `DocType` parses its own prefix**: do not put prefix logic anywhere else in the app.
- **Doc names are data**: `items:` (list), `venue:42` (single), `venue-at:42:2026-06-16` (temporal scoped). Prefix up to and including `:` owns the handler.
- **Client is signal-driven**: subscribers on `doc.data` auto-update; do not re-read the doc manually.
