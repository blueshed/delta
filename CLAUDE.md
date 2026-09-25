# CLAUDE.md

Guidance for a Claude session working on **@blueshed/delta**: JSON-Patch document sync. Three op
verbs, one WebSocket, documents kept where their truth lives (JSON file, SQLite, Postgres,
memory, an outside source, static), a ledger for undo, and `createLocal()` for running it
in-process.

## Load first

- **`delta-doc`** (`.claude/skills/delta-doc/`) is this package's published skill: `SKILL.md`
  is the router, `reference.md` the manual. It must describe `main` as it is; update it with
  any change to the API, the wire protocol or the SQL.
- **`railroad`** and **`bun-route`** (`.claude/skills/`) are vendored from @blueshed/railroad and
  synced at its release. Do not edit them here.

## Commands and the gate

Bun only: never `npm`, `npx` or `node`.

| Task | Command |
|---|---|
| Install | `bun install` |
| Typecheck | `bun run check` |
| Fast tests, no database | `bun run test` (core, server, sqlite, auth, railroad-client) |
| One file | `bun test tests/local.test.ts` (Postgres needed by `postgres*`, `auth-jwt`, `review-findings`, `write-scope`, `create-row` and `error-codes`) |
| Start / stop Postgres | `bun run db:up` / `bun run db:down` (Docker, `compose.yml`) |
| Postgres tests | `bun run db:up`, then `bun run test:pg` or `bun test tests/postgres-ledger.test.ts` |
| Everything | `bun run test:all` (Postgres must be up) |
| **The gate** | **`bun run ci`**: `db:up` → `check` → `test:all` → `db:down` |
| Benchmarks | `bun run db:up`, then `bun run bench` (it needs Postgres; `BENCH_PG_URL` to point elsewhere) |
| Release | `/publish patch\|minor\|major` (`.claude/commands/publish.md`, shared with railroad and eta) |

**Postgres runs in Docker.** `compose.yml` starts `postgres:18-alpine` with its data on tmpfs,
mapped to **localhost:5433** so it does not clash with a Postgres on 5432. The suite connects to
`postgres://delta:delta@localhost:5433/delta_test` unless `DELTA_TEST_PG_URL` says otherwise.
`bun run db:down` removes the container and its data. GitHub Actions (`.github/workflows/ci.yml`
on push, `publish.yml` on a published release) runs the same steps.

## Invariants

- **Three op verbs** (`add`, `replace`, `remove`) on `/<coll>/<id>[/field]` paths. No new verbs.
- **One pointer grammar, two parsers.** Strict RFC 6901: `splitPath` / `joinPath` in
  `src/core.ts` (which `applyOps`, `dom-ops` and every backend use) and `_delta_split_path` /
  `_delta_build_path` in `001a`. `tests/postgres-pointer.test.ts` runs both on one set of
  vectors; change them together. Build a path from ids with `joinPath`, never a template.
- **A batch applies whole or not at all**, on every backend (`applyOps` undoes in place).
- **`add /<coll>/-` makes a row the server names**, on every backend, and the echo carries
  `/<coll>/<id>` (`tests/create-row.test.ts`). The path's id wins over one in the value.
- **One error-code table**: 400 malformed, 401, 403 read-only, 404 not there, 409 already
  there, 500 the server's; `tests/error-codes.test.ts` asks every backend. Postgres raises
  SQLSTATEs the listener maps (`CODE_OF_SQLSTATE` in `listener.ts`).
- **With `auth`, a document says who owns it** (`owns`, or `shared: true`): its name is its
  broadcast channel, and RLS does not filter the channel. `docTypeFromDef` throws without
  one; so does `createDocListener` with `auth` for a registered `DocType` or a custom doc
  with neither, and `registerDocType` while such a listener runs. A membership custom doc
  is queried, cached and fanned out per identity. `tests/postgres-rls.test.ts` pins it as a
  `NOSUPERUSER` role.
- **The framework SQL `src/sql/001a–001g-*.sql` is a contract.** Consumers vendor it with
  `bunx @blueshed/delta init`; `applyFramework` applies every `001*` file in order. Change it
  only idempotently (`CREATE OR REPLACE`, `IF NOT EXISTS`) and say so in the changelog.
- **You may write what you may read.** Every row-addressed write is gated on the same scope as
  the read, on both backends.
- **Broadcasts are row-level**: a field write goes out as the whole row, on every backend.
- **Opt-in stays opt-in.** Without `ledger: true` / `inverse: true`, answers and broadcasts
  keep their 0.5 shapes.
- **Fan-out differs by backend, on purpose.** SQLite forwards a write to every open document
  that holds the row; Postgres publishes only on the channel of the document written through.
  `tests/postgres-fanout.test.ts` and `tests/postgres-isolation.test.ts` pin the Postgres side.
- **A walk is guarded, the same on both backends**: `planWalk` (`src/server/ledger.ts`) and
  `_delta_walk_plan` (`001g`) set back only what an entry changed, where the document still
  holds what it left; a conflict walks nothing and is recorded as walked. Change them together
  (`tests/ledger.test.ts`, `tests/postgres-ledger.test.ts`, "undo beside someone else").
- **The cursor**: named by an in-process caller (`client.data.local`); over a socket the
  connection's `clientId`, and signed in, the person with it (`socketCursor` in
  `src/server/ledger.ts`). A socket client never names another's.
- **`who`** is `client.data.identity` on both backends, or on Postgres with an `auth` module,
  what the gate gives.
- **Changelog**: Keep a Changelog, with `## [Unreleased]` at the top written as work lands;
  `/publish` promotes it. The skill's `version:` is stamped by `/publish`; don't bump it by hand.

## Where the contracts live

- `src/core.ts`: `applyOps`, `DeltaOp`, `splitPath`, `joinPath`, `escapeSegment` (no
  dependencies).
- `src/client/`: `client.ts` (reconnecting socket with `onConnect`, reactive `openDoc`,
  version-gap resync, `send` after its echo), `dom-ops.ts` (`applyOpsToCollection`). It
  imports railroad's subpaths, never the root barrel.
- `src/server/server.ts`: `createWs`, the JSON-file backend (`registerDoc`), `WsServer`.
- `src/server/sqlite.ts`: the SQLite backend (`registerDocs`, custom docs, fan-out, implied
  docs, `inverseOf`; with `{ ledger: true }`, `undo` / `redo` / `history`).
- `src/server/ledger.ts`: the SQLite ledger (entries, the cursor's chains).
- `src/server/local.ts`: `createLocal()`, delta in-process with no socket.
- `src/server/kinds.ts`: `registerMemory`, `registerStatic`, `registerSource`.
- `src/schema.ts`: `defineSchema`, `defineDoc` (shared by both backends). `validateOps` is
  per backend: `sqlite.ts` (the one the backend runs) and `postgres/schema.ts` (exported;
  the listener relies on `delta_apply`'s own checks).
- `src/server/postgres/`: the Postgres backend (`listener.ts`, `registry.ts` with `DocType`
  and `docTypeFromDef`'s `owns`, `codegen.ts`, `schema.ts`, `bootstrap.ts`, `auth.ts`).
- `src/server/logger.ts`: a copy of railroad's `logger.ts`, so a server needs no railroad (an
  optional peer only the client imports); `tests/server.test.ts` fails when the two differ.
- `src/sql/001a–001f-*.sql`: the stored functions; `001g-delta-ledger.sql`: the Postgres
  ledger (`delta_apply_logged`, `delta_walk` and its `_delta_walk_plan`, `delta_undo`, `delta_redo`,
  `delta_history`, `_as` forms).
- `src/server/auth*.ts`, `src/sql/auth-jwt.sql`: the `DeltaAuth` contract and the JWT reference.
- `cli.ts`: `bunx @blueshed/delta` (open, watch, delta, call, init, sql, install-skills;
  install-skills copies `@blueshed/*` skills and the packages `claudeSkills` names).
- `tests/setup.ts`: `newPool`, `applyFramework`, `resetState`, `mockClient`, `sendAndAwait`,
  `waitFor`. `createLocal()` is the lighter harness for SQLite and the kinds.
- `examples/`: `shared-state`, `sites-bbox`, `kanban`, `todos-vs-rls`.

## Notes

- **`delta` is a superuser** in the compose stack, so it bypasses row-level security. Most
  Postgres tests check the RLS plumbing (`withAppAuth` sets `app.user_id`), not enforcement; a
  test that must prove a policy blocks a read makes its own `NOSUPERUSER` role, as
  `tests/postgres-rls.test.ts` does (`delta_rls`).
- `todo.jsonl` holds what is still open, one JSON object per line (`n, status, severity, area,
  file, summary, detail, note`, as eta's). Add to it; the CHANGELOG records what is fixed.

## In a remote container with no Docker

Claude Code on the web runs in an ephemeral container with no Docker daemon, so `db:up` and
`ci` fail there. `.claude/hooks/session-start.sh` provisions that container when
`CLAUDE_CODE_REMOTE=true`: it starts the bundled Postgres 16 cluster on **5432**, creates the
`delta` role (superuser, as in compose) and the `delta_test` database, runs `bun install`, and
exports `DELTA_TEST_PG_URL`. By hand, the same is
`CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh`; it is idempotent.

The gate there, in place of `bun run ci`:

```bash
bun run check && DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test" bun test tests/
```

A psql shell: `PGPASSWORD=delta psql -h localhost -p 5432 -U delta -d delta_test`. Nothing in
the container survives reclamation: commit what is worth keeping.
