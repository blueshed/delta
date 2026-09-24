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
| One file | `bun test tests/local.test.ts` (Postgres needed by `postgres*`, `auth-jwt`, `review-findings` and `write-scope`) |
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
- **The framework SQL `src/sql/001a–001g-*.sql` is a contract.** Consumers vendor it with
  `bunx delta init`; `applyFramework` applies every `001*` file in order. Change it only
  idempotently (`CREATE OR REPLACE`, `IF NOT EXISTS`) and say so in the changelog.
- **You may write what you may read.** Every row-addressed write is gated on the same scope as
  the read, on both backends.
- **Broadcasts are row-level**: a field write goes out as the whole row, on every backend.
- **Opt-in stays opt-in.** Without `ledger: true` / `inverse: true`, answers and broadcasts
  keep their 0.5 shapes.
- **Fan-out differs by backend, on purpose.** SQLite forwards a write to every open document
  that holds the row; Postgres publishes only on the channel of the document written through.
  `tests/postgres-fanout.test.ts` and `tests/postgres-isolation.test.ts` pin the Postgres side.
- **The cursor**: named by an in-process caller (`client.data.local`); over a socket the
  connection's `clientId`, and signed in, the person with it (`socketCursor` in
  `src/server/ledger.ts`). A socket client never names another's.
- **`who`** is `client.data.identity` on both backends, or on Postgres with an `auth` module,
  what the gate gives.
- **Changelog**: Keep a Changelog, with `## [Unreleased]` at the top written as work lands;
  `/publish` promotes it. The skill's `version:` is stamped by `/publish`; don't bump it by hand.

## Where the contracts live

- `src/core.ts`: `applyOps`, `DeltaOp` (no dependencies).
- `src/client/`: `client.ts` (reconnecting socket, reactive `openDoc`, version-gap resync),
  `dom-ops.ts` (`applyOpsToCollection`).
- `src/server/server.ts`: `createWs`, the JSON-file backend (`registerDoc`), `WsServer`.
- `src/server/sqlite.ts`: the SQLite backend (`registerDocs`, custom docs, fan-out, implied
  docs, `inverseOf`; with `{ ledger: true }`, `undo` / `redo` / `history`).
- `src/server/ledger.ts`: the SQLite ledger (entries, the cursor's chains).
- `src/server/local.ts`: `createLocal()`, delta in-process with no socket.
- `src/server/kinds.ts`: `registerMemory`, `registerStatic`, `registerSource`.
- `src/schema.ts`: `defineSchema`, `defineDoc`, `validateOps` (shared by both backends).
- `src/server/postgres/`: the Postgres backend (`listener.ts`, `registry.ts` with `DocType`,
  `codegen.ts`, `schema.ts`, `bootstrap.ts`, `auth.ts`).
- `src/sql/001a–001f-*.sql`: the stored functions; `001g-delta-ledger.sql`: the Postgres
  ledger (`delta_apply_logged`, `delta_undo`, `delta_redo`, `delta_history`, `_as` forms).
- `src/server/auth*.ts`, `src/sql/auth-jwt.sql`: the `DeltaAuth` contract and the JWT reference.
- `cli.ts`: `bunx delta` (open, watch, delta, call, init, sql, install-skills).
- `tests/setup.ts`: `newPool`, `applyFramework`, `resetState`, `mockClient`, `sendAndAwait`,
  `waitFor`. `createLocal()` is the lighter harness for SQLite and the kinds.
- `examples/`: `shared-state`, `sites-bbox`, `kanban`, `todos-vs-rls`.

## Notes

- **`delta` is a superuser** in the compose stack, so it bypasses row-level security. The
  Postgres tests check the RLS plumbing (`withAppAuth` sets `app.user_id`), not enforcement; a
  test that must prove a policy blocks a read needs its own `NOSUPERUSER` role (see
  `tests/auth-jwt.test.ts`).
- **The railroad devDependency** points at a railroad commit until railroad 0.12.0 is
  released; the lead switches it. Leave it alone.
- `TODO.md` holds the open findings from the v0.5.0 review.

## In a remote container with no Docker

Claude Code on the web runs in an ephemeral container with no Docker daemon, so `db:up` and
`ci` fail there. `.claude/hooks/session-start.sh` provisions that container when
`CLAUDE_CODE_REMOTE=true`: it starts the bundled Postgres 16 cluster on **5432**, creates the
`delta` role (superuser, as in compose) and the `delta_test` database, runs `bun install`, and
exports `DELTA_TEST_PG_URL`. By hand, the same is:

```bash
pg_ctlcluster 16 main start          # pg_lsclusters → 16 main 5432 online
su postgres -c "psql -v ON_ERROR_STOP=1 -c \"DO \\\$\\\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='delta') THEN
    CREATE ROLE delta LOGIN SUPERUSER PASSWORD 'delta';
  END IF; END \\\$\\\$;\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='delta_test'\"" \
  | grep -q 1 || su postgres -c "createdb -O delta delta_test"
bun install
```

The gate there, in place of `bun run ci`:

```bash
bun run check && DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test" bun test tests/
```

A psql shell: `PGPASSWORD=delta psql -h localhost -p 5432 -U delta -d delta_test`. Nothing in
the container survives reclamation: commit what is worth keeping.
