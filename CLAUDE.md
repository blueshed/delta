# CLAUDE.md

Guidance for a Claude session working on **@blueshed/delta**: JSON-Patch document sync. Three op
verbs, one WebSocket, documents kept where their truth lives (JSON file, SQLite, Postgres,
memory, an outside source, static), a ledger for undo, and `createLocal()` for running it
in-process.

## Load first

- **`delta-doc`** (`.claude/skills/delta-doc/`) is this package's published skill: `SKILL.md`
  is the start, `reference.md` the manual. It must describe `main` as it is; update it with
  any change to the API, the wire protocol or the SQL.
- **Docs: the front door is small.** README.md and SKILL.md open with the concept, in the
  owner's words (a document is what you need in front of you to act; open it and you're
  subscribed; documents, not entities; what grows is where they're kept). Then small: README's
  Try it (run byte for byte by `tests/readme.test.ts`) and a line for each thing you grow into;
  SKILL.md's recipe (run as written by `tests/recipe.test.ts`) and the rules a first app needs.
  Everything else goes in `reference.md`, read on request. Don't swamp the reader.
- **`railroad`** (`.claude/skills/`) is vendored from @blueshed/railroad, for the examples, and
  synced at its release. Do not edit it here. Its `bun-route` is not: nothing here scaffolds pages,
  and `install-skills` gives a consumer both from railroad's own package.

## Commands and the gate

Bun only: never `npm`, `npx` or `node`.

| Task | Command |
|---|---|
| Install | `bun install` |
| Typecheck | `bun check` (Bun's type check, TypeScript 7; no `check` script, which would shadow it), and `bun check -p examples/kanban` for its JSX |
| Fast tests, no database | `bun run test`: every file that needs no Postgres server (PGlite runs in process) |
| One file | `bun test tests/local.test.ts` (Postgres needed by `postgres*`, `auth-jwt`, `review-findings`, `write-scope`, `create-row` and `error-codes`; a new file that needs no Postgres goes into `test` too) |
| Start / stop Postgres | `bun run db:up` / `bun run db:down` (Docker, `compose.yml`) |
| Postgres tests | `bun run db:up`, then `bun run test:pg` or `bun test tests/postgres-ledger.test.ts` |
| Everything | `bun run test:all` (Postgres must be up) |
| **The gate** | **`bun run ci`**: `db:up` → `bun check` (and kanban's) → `test:all` → `db:down` |
| Benchmarks | `bun run db:up`, then `bun run bench` (it needs Postgres; `BENCH_PG_URL` to point elsewhere) |
| Release | `/publish patch\|minor\|major` (`.claude/commands/publish.md`, shared with railroad and eta) |

**Postgres runs in Docker.** `compose.yml` starts `postgres:18-alpine` with its data on tmpfs,
mapped to **localhost:5433** so it does not clash with a Postgres on 5432. The suite connects to
`postgres://delta:delta@localhost:5433/delta_test` unless `DELTA_TEST_PG_URL` says otherwise.
`bun run db:down` removes the container and its data. GitHub Actions (`.github/workflows/ci.yml`
on push, `publish.yml` on a published release) runs the same steps.

**CI runs one Bun, pinned**: `bun-version: 1.4.3` in both workflows, the Bun the repo is
developed on, so a Bun release cannot turn the gate red with no change here. To move it: install
the new Bun, run `bun run ci` on it, then set `bun-version` in `ci.yml` and `publish.yml` to
`bun --version` in one commit (`tests/package-exports.test.ts` fails if the two differ or say
`latest`).

## Invariants

- **Three op verbs** (`add`, `replace`, `remove`) on `/<coll>/<id>[/field]` paths. No new verbs.
  They mean what RFC 6902 says on every backend: a replace of a row is the row (a field it
  leaves out takes its default; its id and parent key stay), never a merge.
- **One pointer grammar, two parsers.** Strict RFC 6901: `splitPath` / `joinPath` in
  `src/core.ts` (which `applyOps`, `dom-ops` and every backend use) and `_delta_split_path` /
  `_delta_build_path` in `001a`. `tests/postgres-pointer.test.ts` runs both on one set of
  vectors (`src/pointer-vectors.json`, published in `./testing`); change them together. Build a
  path from ids with `joinPath`, never a template.
- **A batch applies whole or not at all**, on every backend (`applyOps` undoes in place).
- **`add /<coll>/-` makes a row the server names**, on every backend, and the echo carries
  `/<coll>/<id>` (`tests/create-row.test.ts`). The path's id wins over one in the value.
- **One error-code table**: 400 malformed, 401, 403 read-only, 404 not there, 409 already
  there, 500 the server's; `tests/error-codes.test.ts` asks every backend. Postgres raises
  SQLSTATEs the listener maps (`CODE_OF_SQLSTATE` in `listener.ts`).
- **With `auth`, a document says who owns it** (`owns`, or `shared: true`): its name is its
  broadcast channel, and RLS does not filter the channel. `docTypeFromDef` throws without
  one; so does `createDocListener` with `auth` for a `DocType` in its `types` or a custom doc
  with neither, and its `register` after. A membership custom doc
  is queried, cached and fanned out per identity. `tests/postgres-rls.test.ts` pins it as a
  `NOSUPERUSER` role.
- **The framework SQL `src/sql/001a–001g-*.sql` is a contract.** Consumers vendor it with
  `bunx @blueshed/delta init`; `applyFramework` applies every `001*` file in order. Change it
  only idempotently (`CREATE OR REPLACE`, `IF NOT EXISTS`) and say so in the changelog.
- **You may write what you may read.** Every row-addressed write is gated on the same scope as
  the read, on both backends.
- **A holder is told what changed**: a row that arrives whole (`add`), one that leaves
  (`remove`), and one that stays as a `replace` of each field whose value changed -- the write's,
  a default's, a trigger's -- compared row before and after (`changedFields` in `core.ts`;
  `_delta_tell` in `001d`; a membership view in `custom.ts`). A memory or free-form document
  tells its ops as applied. The client freshens the row a field op lands in (maps kept), so a keyed `list()`
  sees the row as new. A write's answer and ledger entry keep whole rows: they are its record.
- **A document may hold some columns** (`defineDoc`'s `columns`, todo #70): it is opened, told
  and written by those, the id and the parent key alone (`holdsField` / `showRow` in `schema.ts`;
  `_delta_show`, `_delta_held_columns` in `001c`/`001d`). The store, the copies kept server-side
  and the ledger keep rows whole: a document's columns are what it shows and takes.
- **Opt-in stays opt-in.** Without `ledger: true` / `inverse: true`, answers and broadcasts
  keep their 0.5 shapes.
- **One app, every backend.** The JSON file (`./json`), SQLite, Postgres in process (`./pglite`)
  and a Postgres server take the same schema, documents and writes, and answer the same:
  serial ids (numbers), no validity columns in rows, list mode and one scope rule
  (`src/server/scope.ts` is `_delta_resolve_scope`'s twin), `open_at`, the error table.
  `tests/helpers/path.ts` asks every case of each (`tests/path-*.test.ts`,
  `tests/postgres-path.test.ts`, which also carries one app's data through all four). A
  backend that answers differently is wrong: change both sides together.
- **Fan-out is the same on every backend.** A write is told to every document that held or
  holds a row it changed, each what changed for it (arrived: add; stayed: its changed fields; left:
  remove; the root: replaced, or null). On Postgres it is worked out in `delta_apply`
  (`_delta_holders`, `_delta_tell`, `001b`/`001d`) over the names open now (`_delta_held`, each
  listener's), so every process hears it; on SQLite and the JSON file, in `write()` (`holders`,
  `tell`), over every registration on the database handle (`fanoutsOn`).
  `tests/postgres-isolation.test.ts` and `tests/sqlite-isolation.test.ts` pin that nobody else
  is told. On Postgres the documents are those the database knows (`defineDoc`) and custom
  docs; a hand-written `DocType` is told only its own writes (`tests/postgres.test.ts`, "a
  DocType written by hand").
- **Rows carry from one backend to the next** with `exportTables` / `importTables` (the same
  `Snapshot` on each): every row, every temporal version, and each sequence, so the next serial
  follows on. Not the ledger: undo history starts fresh on the next backend. The free-form
  document (`registerDoc`) is not one of the four: no schema, uuid ids.
- **A walk is guarded, the same on both backends**: `planWalk` (`src/server/ledger.ts`) and
  `_delta_walk_plan` (`001g`) set back only what an entry changed, where the document still
  holds what it left (and a row it made is removed only if nobody has put rows under it); a
  conflict walks nothing and is recorded as walked -- but for a walk of a
  named change (`change`: `changeTip` / `_delta_change_tip`), which records nothing. Change them
  together (`tests/walk-plan.test.ts` runs both on one set of vectors, `src/walk-vectors.json`,
  published in `./testing`; `tests/ledger.test.ts`, `tests/postgres-ledger.test.ts`, "undo beside
  someone else"; `tests/helpers/path.ts`, "a change named by its entry").
- **The cursor**: named by an in-process caller (`client.data.local`); over a socket the
  connection's `clientId`, and signed in, the person with it (`socketCursor` in
  `src/server/ledger.ts`). A socket client never names another's.
- **`who`** is `client.data.identity` on both backends, or on Postgres with an `auth` module,
  what the gate gives.
- **Changelog**: Keep a Changelog, with `## [Unreleased]` at the top written as work lands;
  `/publish` promotes it. The skill's `metadata.version` is stamped by `/publish`; don't bump it by hand.

## Where the contracts live

- `src/core.ts`: `applyOps`, `DeltaOp`, `splitPath`, `joinPath`, `escapeSegment`,
  `changedFields` (no dependencies).
- `src/client/`: `client.ts` (reconnecting socket with `onConnect`, reactive `openDoc`,
  version-gap resync, `send` after its echo), `dom-ops.ts` (`applyOpsToCollection`). It
  imports railroad's subpaths, never the root barrel.
- `src/server/server.ts`: `createWs`, the free-form document (`registerDoc`), `WsServer`.
- `src/server/sqlite.ts`: the SQLite backend (`registerDocs`, custom docs, fan-out, implied
  docs, `inverseOf`; with `{ ledger: true }`, `undo` / `redo` / `history`), and the package's
  `./sqlite` entry. Beside it, `src/server/sqlite/`: `ddl` (createTables, migrateSchema),
  `validate`, `rows` (writes and codecs), `keep` (a scope's values as columns keep them), `read`
  (open and open_at), `carry` (`exportTables` / `importTables`).
- `src/server/json.ts`: the JSON file, the same documents as SQLite (SQLite in memory, loaded
  from the file and saved to it after every change).
- `src/server/pglite.ts`: Postgres in process -- PGlite behind the slice of `pg`'s Pool delta
  uses, so `./postgres` runs on it unchanged (from epsilon's `pglite.ts`).
- `src/server/scope.ts`: a doc name's scope, for the backends that are not Postgres.
- `src/server/custom.ts`: custom documents (`defineCustomDoc`) on SQLite and Postgres alike --
  views, recompute reads, who may still hear a document (`letGo`), the per-row telling.
- `src/server/ledger.ts`: the SQLite ledger (entries, the cursor's chains).
- `src/server/file.ts`: how `registerDoc` and `./json` keep their file (a save whole or not
  at all: temp beside the real file, its mode, synced, renamed; stale temps cleared at start).
- `src/server/local.ts`: `createLocal()`, delta in-process with no socket.
- `src/server/kinds.ts`: `registerMemory`, `registerStatic`, `registerSource`.
- `src/schema.ts`: `defineSchema`, `defineDoc` (shared by both backends). `validateOps` is
  per backend: `sqlite/validate.ts` (the one the backend runs) and `postgres/schema.ts` (exported;
  the listener relies on `delta_apply`'s own checks).
- `src/server/postgres/`: the Postgres backend (`listener.ts`, `registry.ts` with `DocType`,
  a listener's own `docTypes` and `docTypeFromDef`'s `owns`, `codegen.ts`, `schema.ts`, `bootstrap.ts`, `auth.ts`).
- `src/server/logger.ts`: a copy of railroad's `logger.ts`, so a server needs no railroad (an
  optional peer only the client imports); `tests/server.test.ts` fails when the two differ.
- `src/sql/001a–001f-*.sql`: the stored functions; `001g-delta-ledger.sql`: the Postgres
  ledger (`delta_apply_logged`, `delta_walk` and its `_delta_walk_plan`, `delta_undo`, `delta_redo`,
  `delta_history`, `_as` forms).
- `src/server/auth*.ts`, `src/sql/auth-jwt.sql`: the `DeltaAuth` contract and the JWT reference.
- `cli.ts`: `bunx @blueshed/delta` (open, watch, delta, call, init, sql, install-skills;
  install-skills copies `@blueshed/*` skills and the packages `claudeSkills` names). The runtime
  commands take `--token` / `DELTA_TOKEN` and `--json` for an agent; `tests/cli.test.ts` runs them.
- `src/testing.ts` (`./testing`): `mockClient`, `sendAndAwait`, `waitFor`, `pointerVectors` and
  `walkVectors` (the two-language rules' cases, `src/*-vectors.json`), for delta's tests and a consumer's.
  `tests/setup.ts`: the Postgres ones (`newPool`, `applyFramework`, `resetState`). `createLocal()` is
  the lighter harness for SQLite and the kinds.
- `examples/`: `shared-state`, `sites-bbox`, `kanban`, `todos-vs-rls`, each run as its README says by
  `tests/recipe.test.ts`, `tests/examples.test.ts` and `tests/postgres-examples.test.ts`
  (`tests/helpers/examples.ts`).

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
bun check && bun check -p examples/kanban && DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test" bun test tests/
```

A psql shell: `PGPASSWORD=delta psql -h localhost -p 5432 -U delta -d delta_test`. Nothing in
the container survives reclamation: commit what is worth keeping.
