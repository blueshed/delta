# @blueshed/delta

Delta-doc — JSON-Patch document sync over WebSocket, with pluggable backends.

A narrow, AI-legible primitive: one op vocabulary (`add` / `replace` / `remove` on `/coll/id` paths), one transport (WebSocket), two backends (SQLite, Postgres stored functions + LISTEN/NOTIFY), one reactive client (signals).

## Layout

```
core.ts       — JSON-Patch applyOps + types (zero deps)
client.ts     — reactive doc + reconnecting WS (peerDep: @blueshed/railroad)
server.ts     — WS action router + JSON-file doc registration
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

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp` |
| `@blueshed/delta/client` | browser | `connectWs`, `openDoc`, `call`, `WS` |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc`, `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `registerDocs`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `createDocListener`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/logger` | anywhere | `createLogger`, `setLogLevel`, `loggedRequest` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` interface, `wireAuth`, `upgradeWithAuth` — the authentication extension point |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })` — reference `DeltaAuth` implementation |

## Why

Existing sync libraries are built for human developers: big API surfaces, many idioms, ecosystem dependencies. Delta-doc is shaped for AI-driven development — the whole system fits in context, has one way to do each thing, and generates its schema from a single TypeScript source of truth.

Lineage: started as dzql (Vue / Pinia, database-first), matured into seiro (CQRS over WS with Preact Signals), refined in paintbrush's delta-sync, realised in clean as a Postgres-resident primitive. This package is the extraction.

## For Claude

The authoritative documentation is the bundled skill at [`.claude/skills/delta-doc/SKILL.md`](.claude/skills/delta-doc/SKILL.md). Install the package and Claude Code discovers it automatically; the skill fits in one context load and covers the whole API surface with examples.

## Status

`0.1.0` — initial extraction from `@blueshed/railroad` and the `clean` venue-manager. Tests and types ported. Packaging and docs are first-pass.
