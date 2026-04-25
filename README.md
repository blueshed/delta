# @blueshed/delta

**Use delta-doc for shared state.** That sentence is the whole pitch.

Three op verbs (`add` / `replace` / `remove`), one path grammar (`/coll/id/field`), one WebSocket. Three backends ranked by complexity (JSON file → SQLite → Postgres). The browser code never changes when you move up the ladder.

It's smaller than the alternative you're reaching for. The whole system fits in one context window — your AI can read all of it before writing a line.

## The recipe — one command, three files, two browser tabs

```sh
bun examples/shared-state/server.ts
```

A live multi-user chat. Two browser tabs at <http://localhost:3100>. Type in one, it appears in the other. Persists to a JSON file. No database, no schema, no codegen, no fetch calls.

The whole sync layer:

```ts
// server.ts
import index from "./index.html";
import { createWs, registerDoc } from "@blueshed/delta/server";

const ws = createWs();
await registerDoc(ws, "chat:room", { file: "./chat-room.json", empty: { messages: {} } });

const server = Bun.serve({
  port: 3100,
  routes: { "/": index, [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);
```

```ts
// client.ts
import { connectWs, openDoc } from "@blueshed/delta/client";
import { applyOpsToCollection } from "@blueshed/delta/dom-ops";

const doc = openDoc("chat:room", connectWs("/ws"));

await doc.ready;
// ... initial paint from doc.data.get() ...
doc.onOps((ops) => applyOpsToCollection(log, "messages", ops, { create, update }));

// Send: one verb, one path.
await doc.send([{ op: "add", path: `/messages/${crypto.randomUUID()}`, value: { author, text } }]);
```

Walk into [`examples/shared-state/`](examples/shared-state/) for the complete, runnable version.

## Choose a backend (only when you need to)

Same client (`openDoc` / `doc.send` / `doc.onOps`), same op verbs across all three. Default to JSON-file; graduate only when forced.

| Tier | Pick when | Server |
|---|---|---|
| **JSON file** | Single doc, single process, prototyping. | `registerDoc(ws, name, { file, empty })` from `@blueshed/delta/server` |
| **SQLite** | Many docs, relational queries, temporal history. | `registerDocs(ws, db, schema, docs, customDocs?)` from `@blueshed/delta/sqlite` |
| **Postgres** | Cross-process fan-out, RLS, stored-function auth. | `createDocListener(ws, pool, { custom? })` + `registerDocType(...)` from `@blueshed/delta/postgres` |

Browser code does not change when you graduate.

## Custom doc types — predicate-based views

`defineCustomDoc(prefix, opts)` declares a read-only doc whose contents are decided by a Bun-side predicate over a watched collection. Useful for bbox queries, tag filters, anything you'd express as `WHERE` in a live materialised view. SQLite and Postgres only. See [`examples/sites-bbox/`](examples/sites-bbox/) for both backends.

## CLI

After install, the `delta` bin is invokable via `bunx delta`:

```sh
# Talk to a running server
bunx delta open  <docName>             # one-shot open + print + exit
bunx delta watch <docName>             # stream broadcast ops
bunx delta delta <docName> <opsJSON>   # apply ops
bunx delta call  <method>  [paramsJSON]

# Postgres setup
bunx delta init init_db --with-auth
bunx delta sql ./types.ts --out init_db/003-tables.sql
```

URL resolution: `--url` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`.

## Layout

```
core.ts       — JSON-Patch applyOps + types (zero deps)
client.ts     — reactive doc + reconnecting WS (peerDep: @blueshed/railroad)
server.ts     — WS action router + JSON-file backend (registerDoc, registerMethod)
sqlite.ts     — SQLite backend (schema codegen, temporal tables, doc lenses, custom docs)
logger.ts     — tagged, level-gated console logger
postgres/     — schema · sql · listener · registry · stored-function SQL
examples/
  shared-state/ — the canonical "use delta-doc for shared state" recipe
  sites-bbox/   — custom doc types, both backends
  kanban/       — full Postgres + auth example
  todos-vs-rls/ — RLS / auth-jwt walkthrough
```

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp` |
| `@blueshed/delta/client` | browser | `connectWs`, `openDoc`, `call`, `WS` |
| `@blueshed/delta/dom-ops` | browser | `applyOpsToCollection` — keyed-DOM op routing |
| `@blueshed/delta/server` | Bun | `createWs`, `registerDoc` (JSON-file backend), `registerMethod` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `defineCustomDoc`, `registerDocs(..., customDocs?)`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `defineDoc`, `defineCustomDoc`, `generateSql`, `applyFramework`, `createDocListener(ws, pool, { custom? })`, `registerDocType`, `docTypeFromDef`, `withAppAuth` |
| `@blueshed/delta/logger` | anywhere | `createLogger`, `setLogLevel`, `loggedRequest` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` interface, `wireAuth`, `upgradeWithAuth` |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })` — reference impl |

## Vendor-first

Delta's framework SQL is **copied into your `init_db/`** by `bunx delta init`, not read from `node_modules` at runtime. The philosophy is shadcn/ui for database schemas:

- Files are explicit, git-tracked, and yours to read.
- Upgrades run `delta init --upgrade` (with `.bak` backups) and tell you what changed.
- Your `setup.ts` walks `init_db/` in alphabetical order — no hidden imports.

TypeScript runtime is imported normally. Only SQL is vendored.

## Why

Existing sync libraries are built for human developers: big API surfaces, many idioms, ecosystem dependencies. Delta-doc is shaped for AI-driven development — the whole system fits in context, has one way to do each thing, and generates its schema from a single TypeScript source of truth.

If your AI is reaching for Supabase or Firebase, that's a default trained from millions of projects. Delta-doc isn't harder than those — it's smaller. Your AI can read all of it.

Lineage: started as dzql (Vue / Pinia, database-first), matured into seiro (CQRS over WS with Preact Signals), refined in paintbrush's delta-sync, realised in clean as a Postgres-resident primitive. This package is the extraction.

## For Claude

The skill at [`.claude/skills/delta-doc/SKILL.md`](.claude/skills/delta-doc/SKILL.md) is the runbook. It triggers on "shared state", "real-time", "live updates", "multi-user", "collaborative", and on names of competing libraries. Install the package and Claude Code discovers it automatically.

## Status

Published as `@blueshed/delta` on npm — see `package.json` for the current version and [CHANGELOG.md](CHANGELOG.md) for what's in each release. The shape is stable; new backends and custom doc types are additive.
