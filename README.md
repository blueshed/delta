# @blueshed/delta

Delta-doc — JSON-Patch document sync over WebSocket, with pluggable backends.

A narrow, AI-legible primitive: one op vocabulary (`add` / `replace` / `remove` on `/coll/id` paths), one transport (WebSocket), three backends (JSON file, SQLite, Postgres), one reactive client (signals).

## Layout

```
core.ts       — JSON-Patch applyOps + types (zero deps)
client.ts     — reactive doc + reconnecting WS (peerDep: @blueshed/railroad)
server.ts     — WS action router + JSON-file backend (registerDoc, registerMethod)
sqlite.ts     — SQLite backend (schema codegen, temporal tables, doc lenses)
logger.ts     — tagged, level-gated console logger
postgres/
  schema.ts   — defineSchema + defineDoc + validation
  sql.ts      — SQL generation helpers
  listener.ts — single LISTEN, fan-out to WS subscribers
  registry.ts — DocType registry (docTypeFromDef for generics, custom for bespoke)
  sql/        — stored function definitions (meta, scope, read, write, ops)
tests/        — bun:test suites for core, server, sqlite
```

## Choosing a backend

Three backends, same client, same op vocabulary. Start at the top; move down when you outgrow it.

| Backend | Use when | Server-side entry point |
|---|---|---|
| **JSON file** | Single doc per file, single process, prototyping, config-shaped state. | `registerDoc(ws, name, { file, empty })` from `@blueshed/delta/server` |
| **SQLite** | Many docs, relational queries, temporal history, still single process. | `registerDocs(ws, db, schema, docs)` from `@blueshed/delta/sqlite` |
| **Postgres** | Cross-process fan-out (LISTEN/NOTIFY), scope operators, stored-function auth. | `registerDocType(...)` from `@blueshed/delta/postgres` |

Client (`openDoc`, `call`, signals, `applyOpsToCollection`) and RPC (`registerMethod`) are identical across all three. Moving up the ladder is a server-side swap — the browser code does not change.

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp` |
| `@blueshed/delta/client` | browser | `connectWs`, `openDoc`, `call`, `WS` |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc` (JSON-file backend), `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `defineCustomDoc`, `registerDocs(..., customDocs?)`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `defineCustomDoc`, `createDocListener(ws, pool, { custom? })`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/logger` | anywhere | `createLogger`, `setLogLevel`, `loggedRequest` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` interface, `wireAuth`, `upgradeWithAuth` — the authentication extension point |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })` — reference `DeltaAuth` implementation |

## Why

Existing sync libraries are built for human developers: big API surfaces, many idioms, ecosystem dependencies. Delta-doc is shaped for AI-driven development — the whole system fits in context, has one way to do each thing, and generates its schema from a single TypeScript source of truth.

Lineage: started as dzql (Vue / Pinia, database-first), matured into seiro (CQRS over WS with Preact Signals), refined in paintbrush's delta-sync, realised in clean as a Postgres-resident primitive. This package is the extraction.

## Vendor-first

Delta's framework SQL is **copied into your `init_db/`** by `bunx delta init`, not read from `node_modules` at runtime. The philosophy is shadcn/ui for database schemas:

- Files are explicit, git-tracked, and yours to read.
- Upgrades run `delta init --upgrade` which replaces the vendored files (with `.bak` backups) and tells you what changed.
- Your `setup.ts` walks `init_db/` in alphabetical order — no `applyFramework(pool)` call that imports SQL from a black box.

TypeScript runtime is imported normally (`createWs`, `jwtAuth`, `docTypeFromDef`, `openDoc`). Only SQL is vendored.

## CLI

The package ships a `delta` bin, invoked via `bunx delta` (or `bun x delta`).

**Build-time** (vendor framework SQL, regenerate table SQL):

```sh
bunx delta init init_db --with-auth
bunx delta sql ./types.ts --out init_db/003-tables.sql
```

**Runtime** (talk to a running delta server):

```sh
bunx delta open  <docName>             # one-shot open + print + exit
bunx delta watch <docName>             # stream broadcast ops
bunx delta delta <docName> <opsJSON>   # apply ops
bunx delta call  <method>  [paramsJSON]
```

URL resolution: `--url <url>` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`.

## Custom doc types

`defineCustomDoc(prefix, opts)` declares a read-only doc whose contents are decided by a user-supplied predicate over a watched collection. Available on both SQLite and Postgres backends; writes still go through standard docs and the framework fans the right transition ops out to every open custom doc.

A worked example (sites within a bounding box, both backends) lives in [`examples/sites-bbox/`](examples/sites-bbox/).

## For Claude

The authoritative documentation is the bundled skill at [`.claude/skills/delta-doc/SKILL.md`](.claude/skills/delta-doc/SKILL.md) plus the templates in [`.claude/skills/delta-doc/templates/`](.claude/skills/delta-doc/templates/). Install the package and Claude Code discovers them automatically. The skill is a runbook (not a reference manual) that points at paste-ready template files for new apps, per-user isolation, and auth.

## Status

Published as `@blueshed/delta` on npm — see `package.json` for the current version and [CHANGELOG.md](CHANGELOG.md) for what's in each release. The shape is stable; new backends and custom doc types are additive.
