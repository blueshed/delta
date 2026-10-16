# CLAUDE.md

Guidance for a Claude session working on **@blueshed/delta**: JSON-Patch document sync. Three op
verbs, one WebSocket, documents kept where their truth lives (JSON file, SQLite, memory, an
outside source, static), a ledger for undo, and `createLocal()` for running it in-process.
delta's storage path is the JSON file, then SQLite; Postgres is the next step, and it is dzql's
(compiled Postgres, `dzql/postgres`), built on `./backend` and answering `./testing`.

## Load first

- **`delta-doc`** (`.claude/skills/delta-doc/`) is this package's published skill: `SKILL.md`
  is the compass (under ~600 words), `reference/<topic>.md` the manual, a page per job, each
  leading with one true example from the repo. It must describe `main` as it is; update the
  page a change to the API or the wire protocol touches. Point to the types rather than
  re-typing them; history, rationale and measured numbers go in CHANGELOG.md or README.md, not
  the skill.
- **Docs: the front door is small.** README.md and SKILL.md open with the concept, in the
  owner's words (a document is what you need in front of you to act; open it and you're
  subscribed; documents, not entities; what grows is where they're kept). Then small: README's
  Try it (run byte for byte by `tests/readme.test.ts`) and a line for each thing you grow into;
  SKILL.md's order of work and invariants. The recipe is `reference/recipe.md` (run as written
  by `tests/recipe.test.ts`); everything else is a `reference/` page, read on request. Don't
  swamp the reader.
- **`railroad`** (`.claude/skills/`, git-ignored) is railroad's own skill, for the examples: `bun install`
  copies it from `node_modules/@blueshed/railroad` (package.json `prepare`), so it is always the
  version installed. Never edit it here. Its `bun-route` is not copied: nothing here scaffolds pages,
  and `install-skills` gives a consumer both from railroad's own package.

## Commands and the gate

Bun only: never `npm`, `npx` or `node`.

| Task | Command |
|---|---|
| Install | `bun install` |
| Typecheck | `bun check` (Bun's type check, TypeScript 7; no `check` script, which would shadow it), and `bun check -p examples/kanban` for its JSX |
| Tests | `bun run test`: every test (no database server, no Docker; about 17 s) |
| One file | `bun test tests/local.test.ts` |
| **The gate** | **`bun run ci`**: `bun check` (and kanban's) → `bun test tests/` |
| Release | `/publish patch\|minor\|major` (`.claude/commands/publish.md`, shared with railroad and eta) |

GitHub Actions (`.github/workflows/ci.yml` on push, `publish.yml` on a published release) runs
the same steps.

**CI runs one Bun, pinned**: `bun-version: 1.4.3` in both workflows, the Bun the repo is
developed on, so a Bun release cannot turn the gate red with no change here. To move it: install
the new Bun, run `bun run ci` on it, then set `bun-version` in `ci.yml` and `publish.yml` to
`bun --version` in one commit (`tests/package-exports.test.ts` fails if the two differ or say
`latest`).

## Invariants

- **The schema is the contract.** delta sends and writes only the columns a schema declares (and the
  id, the parent key, a temporal row's validity); a database may hold more, never less. The ledger
  keeps rows as stored, so an undo restores them whole. An upgrade that renames, drops or moves
  is a migration (`migrate`, per app, run once each, fencing that app's undo); add, then use, then
  drop, so two versions on one database both work. `tests/schema-contract.test.ts`,
  `tests/migrate.test.ts`.
- **Three op verbs** (`add`, `replace`, `remove`) on `/<coll>/<id>[/field]` paths. No new verbs.
  They mean what RFC 6902 says on every backend: a replace of a row is the row (a field it
  leaves out takes its default; its id and parent key stay), never a merge.
- **One pointer grammar.** Strict RFC 6901: `splitPath` / `joinPath` in `src/core.ts` (which
  `applyOps`, `dom-ops` and every backend use). Its vectors (`src/pointer-vectors.json`) are
  published in `./testing` as `pointerVectors`, for dzql to answer; `tests/pointer-vectors.test.ts`
  asks `splitPath` every one. Change them with the rule.
  Build a path from ids with `joinPath`, never a template.
- **A batch applies whole or not at all**, on every backend (`applyOps` undoes in place).
- **`add /<coll>/-` makes a row the server names**, on every backend, and the echo carries
  `/<coll>/<id>` (`createRowCases` in `src/cases/writes.ts`). The path's id wins over one in the value.
- **One error-code table**: 400 malformed, 401, 403 read-only, 404 not there, 409 already
  there, 500 the server's; `errorCodeCases` in `src/cases/writes.ts` asks every backend.
- **With `auth`, a document says who owns it** (`owns`, or `shared: true`): its name is its
  broadcast channel. `registerDocs` and a custom doc's registration throw without one
  (`ownerless` in `src/server/auth.ts`). A membership custom doc is queried, cached and fanned
  out per identity. `ownsCases` (`src/cases/owns.ts`) asks it of every backend.
- **You may write what you may read.** Every row-addressed write is gated on the same scope as
  the read, on every backend.
- **A holder is told what changed**: a row that arrives whole (`add`), one that leaves
  (`remove`), and one that stays as a `replace` of each field whose value changed -- the write's,
  a default's, a trigger's -- compared row before and after (`changedFields` in `core.ts`; a
  membership view in `custom.ts`). A memory or free-form document
  tells its ops as applied. The client freshens the row a field op lands in (maps kept), so a keyed `list()`
  sees the row as new. A write's answer and ledger entry keep whole rows: they are its record.
- **A document may hold some columns** (`defineDoc`'s `columns`, todo #70): it is opened, told
  and written by those, the id and the parent key alone (`holdsField` / `showRow` in
  `schema.ts`). The store, the copies kept server-side and the ledger keep rows whole: a
  document's columns are what it shows and takes.
- **Opt-in stays opt-in.** Without `ledger: true` / `inverse: true`, answers and broadcasts
  keep their 0.5 shapes.
- **One app, every backend.** The JSON file (`./json`) and SQLite take the same schema,
  documents and writes, and answer the same: serial ids (numbers), no validity columns in rows,
  list mode and one scope rule (`resolveScope` in `src/server/scope.ts`), `open_at`, the error
  table. `src/cases/path.ts` asks every case of each (`tests/path-*.test.ts`), and is published
  in `./testing` for dzql to answer on Postgres. A backend that answers differently is wrong.
- **Fan-out is the same on every backend.** A write is told to every document that held or
  holds a row it changed, each what changed for it (arrived: add; stayed: its changed fields; left:
  remove; the root: replaced, or null). It is worked out in `write()` (`holders`, `tell` in
  `src/server/sqlite.ts`), over every registration on the database handle (`fanoutsOn`).
  `tests/sqlite-isolation.test.ts` pins that nobody else is told.
- **Rows carry from one backend to the next** with `exportTables` / `importTables` (the same
  `Snapshot` on each): every row, every temporal version, and each sequence, so the next serial
  follows on. Not the ledger: undo history starts fresh on the next backend. The free-form
  document (`registerDoc`) is not a table backend: no schema, uuid ids.
- **A walk is guarded**: `planWalk` (`src/server/ledger.ts`) sets back only what an entry
  changed, where the document still holds what it left (and a row it made is removed only if
  nobody has put rows under it); a conflict walks nothing and is recorded as walked -- but for a
  walk of a named change (`change`: `changeTip`), which records nothing. Its vectors
  (`src/walk-vectors.json`) are published in `./testing` as `walkVectors`, for dzql's planner to
  answer; change them with the rule (`tests/walk-plan.test.ts`; `tests/ledger.test.ts`, "undo
  beside someone else"; `src/cases/path.ts`, "a change named by its entry").
- **The cursor**: named by an in-process caller (`client.data.local`); over a socket the
  connection's `clientId`, and signed in, the person with it (`socketCursor` in
  `src/server/ledger.ts`). A socket client never names another's.
- **`who`** is `client.data.identity`, named by `registerDocs`' `who` when given (`ledgerWho` in
  `src/server/ledger.ts`).
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
- `src/server/scope.ts`: a doc name's scope (`resolveScope`), one rule for every backend.
- `src/server/custom.ts`: custom documents (`defineCustomDoc`) on SQLite and the JSON file (and,
  through `./backend`, dzql's) -- views, recompute reads, who may still hear a document
  (`letGo`), the per-row telling.
- `src/server/ledger.ts`: the SQLite ledger (entries, the cursor's chains, `planWalk`).
- `src/server/migrate.ts`: the migration runner (`runMigrations`); `sqlite/migrate.ts` is
  SQLite's `migrate` over it.
- `src/server/file.ts`: how `registerDoc` and `./json` keep their file (a save whole or not
  at all: temp beside the real file, its mode, synced, renamed; stale temps cleared at start).
- `src/server/local.ts`: `createLocal()`, delta in-process with no socket.
- `src/server/kinds.ts`: `registerMemory`, `registerStatic`, `registerSource`.
- `src/schema.ts`: `defineSchema`, `defineDoc` (shared by every backend, dzql's too).
  `validateOps` is `sqlite/validate.ts`, asked of each op as it comes.
- `src/paths.ts` (`./paths`): a document's `owns` as a path: `parsePath`, `checkPath`, `pathSql`
  (the lowering both SQLite and dzql use), `startOf`. `permissionCases` (`src/cases/permissions.ts`)
  asks every backend.
- `src/server/logger.ts`: a copy of railroad's `logger.ts`, so a server needs no railroad (an
  optional peer only the client imports); `tests/server.test.ts` fails when the two differ.
- `src/server/auth.ts`: the `DeltaAuth` contract (`wireAuth`, `upgradeWithAuth`).
- `cli.ts`: `bunx @blueshed/delta` (open, watch, delta, call, migrate, install-skills;
  install-skills copies `@blueshed/*` skills and the packages `claudeSkills` names; migrate takes
  a SQLite file, and sends a `postgres://` URL or a folder to `dzql migrate`). The runtime
  commands take `--token` / `DELTA_TOKEN` and `--json` for an agent; `tests/cli.test.ts` runs them.
- `src/backend.ts` (`./backend`): what a backend outside the package (dzql) builds on: scope,
  showing, custom documents, the ledger's cursor, the migration runner, socket subscriptions. Change
  what it gives only with `tests/package-exports.test.ts`'s list, and say so in the changelog.
- `src/testing.ts` (`./testing`): `mockClient`, `sendAndAwait`, `waitFor` (`src/cases/support.ts`),
  `pointerVectors` and `walkVectors` (the pointer grammar and the walk guard as data,
  `src/*-vectors.json`, for dzql to answer), and the case suite every backend answers alike, for
  delta's tests and dzql's: `src/cases/` (`path`, `law`, `owns`, `isolation`, `writes`). delta's
  own tests import it as `@blueshed/delta/testing`, as a consumer would; what is a backend's own
  (SQLite's adapters, the stand-ups in `tests/helpers/case-backends.ts`) stays beside the tests.
  `createLocal()` is the lighter harness for SQLite and the kinds.
- `examples/`: `shared-state`, `sites-bbox`, `kanban`, each run as its README says by
  `tests/recipe.test.ts` and `tests/examples.test.ts` (`tests/helpers/examples.ts`).

## Notes

- `todo.jsonl` holds what is still open, one JSON object per line (`n, status, severity, area,
  file, summary, detail, note`, as eta's). Add to it; the CHANGELOG records what is fixed.

## In a remote container

Claude Code on the web runs in an ephemeral container. `.claude/hooks/session-start.sh`
provisions it when `CLAUDE_CODE_REMOTE=true`: the latest Bun, `bun install`, and
`scripts/setup-webview.sh` if one is added. By hand, the same is
`CLAUDE_CODE_REMOTE=true .claude/hooks/session-start.sh`; it is idempotent. The gate, `bun run ci`,
runs there as it does locally: no database server, no Docker. Nothing in the container survives
reclamation: commit what is worth keeping.
