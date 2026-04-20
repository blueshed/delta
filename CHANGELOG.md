# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-04-20

### Added

- **GitHub Actions publish workflow** (`.github/workflows/publish.yml`) — fires on `v*` tag push, spins up Postgres 18 via `docker compose`, runs `bunx tsc --noEmit` + `bun test tests/`, verifies the pushed tag matches `package.json` version (catches tag/version drift before it hits the registry), and publishes to npm with `NPM_TOKEN` from repo secrets. The tag push on `git push --follow-tags` is now the explicit "make public" moment; the rest is automated.

### Changed

- **Tarball trim** — `.claude/commands/publish.md` is no longer shipped in the npm tarball. Each project adopting `@blueshed/delta` should copy the publish skill into their own `.claude/commands/` and tune the release cadence to fit (different preflight checks, CI gates, auth). The skill stays in-repo for our own releases.

## [0.4.0] — 2026-04-20

### Added

- **`src/schema.ts`** — shared schema vocabulary (`ColumnDef`, `ColumnType`, `TableDef`, `Schema`, `ResolvedTable`, `DocDef`, `defineSchema`, `defineDoc`, `ValidationError`) used by both the Postgres and SQLite backends. Previously duplicated word-for-word across `src/server/postgres/schema.ts` and `src/server/sqlite.ts`; the backends now re-export from here and only carry their own SQL helpers (`columnSqlType`, `defaultForType`, `validateFieldType`). SQLite now accepts `timestamptz` columns (stored as `TEXT` / ISO-8601) to match the shared type union.
- **`examples/kanban/`** — runnable reference server + three reactive clients demonstrating the core pitch: state in Postgres, views on every device, ops as the sync vocabulary. One `delta_open` composes a nested doc from three relational tables via JSON functions; `delta_apply` mutates them atomically; `pg_notify` / `createDocListener` / `ws.publish` fan the ops out to every subscriber; each client's reactive `data` signal updates via the client's built-in `applyOps` dispatch. No hand-written SQL in the write path.
- **`examples/todos-vs-rls/`** — side-by-side model of delta's `DocType` layer vs raw RLS. Shows three things RLS alone can't cleanly do: reshape (add computed aggregates to the response), inject on write (stamp `owner_id` / `created_at` from identity), and dispatch (`todos:me` vs `todos:team:42` through one handler).
- **`WsClient.close()`** (`src/client/client.ts`) — closes the reconnecting socket, suppresses the reconnect loop, rejects pending `send` promises, and clears per-client doc subscriptions. Idempotent. Tests and scripts that tear down a server no longer need `process.exit` workarounds.
- **Multi-instance `openDoc(name, ws?)`** — each `connectWs()` instance now owns its own reactive state map, so two clients in one process get independent `data` signals + `onOps` handlers. Browser DI path unchanged (`openDoc("foo")` still resolves the client from `inject(WS)`); scripts pass the client explicitly. `call(method, params, ws?)` gets the same optional parameter.
- **Scope DSL test matrix** (`tests/postgres.test.ts`) — every operator (`:id`, `=:name`, `>=:start`, `<=:end`, `like:prefix`, multi-key AND, empty-scope single/list, invalid-operator raise, end-to-end `delta_open` with scope) now has a direct assertion. Previously the operators had zero coverage.
- **Skill + reference updates** — `SKILL.md` gains four new rules covering fail-fast scope validation, the `delta_open` raising contract, `openDoc(name, ws?)` multi-instance usage, and `wsClient.close()` for clean teardown. `reference.md` adds the "scope keys must be real columns" note, a "Client-side tests and one-shot scripts" subsection, and a fixed scoped-single example that uses bare column names (not dotted keys).

### Changed

- **Fail-fast on `delta_open` / `delta_open_at` config errors** (`src/sql/001c-delta-read.sql`, `src/sql/001e-delta-ops.sql`). Unknown doc prefix and unknown root collection now raise `P0001` with a pointed message instead of returning NULL. The list-mode `open_at` case still returns NULL (supported "can't time-travel this shape" signal; `loadDocAt` maps it to `null`).
- **`_delta_resolve_scope` validates scope keys + whitelists range operators** (`src/sql/001b-delta-scope.sql`) — `scope: { "items.id": ":id" }` errors with `scope key "items.id" is not a column of "items" (valid keys: id, …)` instead of silently matching no rows. Range operators are whitelisted to `=, >=, <=, >, <, !=` so no future exposure of scope values to user input can smuggle arbitrary SQL into the generated WHERE clause.
- **`generateSql` emits `ALTER SEQUENCE … OWNED BY table.id`** (`src/server/postgres/codegen.ts`) — so `TRUNCATE … RESTART IDENTITY` resets the sequence. Non-breaking; fixes a silent-drift trap where re-seeds inherited stale counter values across runs.
- **`SKILL.md` "Regenerate 003-tables.sql" rule** — was `002-tables.sql`, which collided with the auth-jwt reference schema's `002-users.sql`. Now consistent with the CLI defaults and every other mention in the skill / CLI / examples.

### Driven by

A feedback loop from building two examples against the skill and noticing the first kanban iteration wasn't really *using* the library — it hand-rolled SQL around `_delta_bump_and_notify` instead of going through `docTypeFromDef` + `delta_apply` + `createDocListener`. Reworking it surfaced four ergonomic bugs that block "easy for Claude" in practice: silent NULL on config errors, `seq_*` counters drifting because `TRUNCATE RESTART IDENTITY` doesn't reset un-owned sequences, `connectWs` reconnecting forever after a server stop, and `openDoc`'s hidden module-level state blocking multi-client scripts. Each is now either fast-failing or per-client, with a message that says what's wrong and what's valid. A parallel four-agent review then flagged the schema-type duplication between the Postgres and SQLite backends, a scope-DSL example in `reference.md` that the new fail-fast raise would reject, a filename drift in `SKILL.md`, and the lack of scope-operator test coverage — all addressed here.

## [0.3.0] — 2026-04-20

### Added

- **`@blueshed/delta/dom-ops` subpath** (`src/client/dom-ops.ts`): `applyOpsToCollection(parent, collection, ops, { key, create, update?, remove? }, nodes?)` routes delta ops to a keyed `Map<id, Node>` and mutates the DOM surgically — no rebuild from `doc.data`, so focus, scroll, inputs in flight, and CSS transitions survive every op. Paired with six tests in `tests/dom-ops.test.ts`.
- **`Doc.onOps(handler)`** (`src/client/client.ts`): subscribe to raw `DeltaOp[]` **before** the full-state `doc.data` signal updates. Lets DOM patchers see the change-event, not a state blob. Returns an unsubscribe function.
- **1-RTT identity-scoped stored functions** (new `src/sql/001f-delta-as.sql`): `delta_open_as(user_id, doc_name)`, `delta_apply_as(user_id, doc_name, ops)`, `delta_open_at_as(user_id, doc_name, at)`. Each wraps `PERFORM set_config('app.user_id', …, true)` + the base call; the SELECT's implicit transaction scopes the setting, and RLS reads it back identically.
- **Bench suite** (`bench/`): single-write workload across `delta-new`, `delta-old`, and `raw-postgres` adapters. Results captured in [bench/results-0.3.0.md](bench/results-0.3.0.md) — on realistic (20 ms RTT) networks, `delta-new` is ~4× faster per authenticated op than `delta-old`.
- **Skill updates** (`.claude/skills/delta-doc/`): `SKILL.md` + `reference.md` cover the `dom-ops` export, the "never rebuild a collection inside an `effect`" rule, the canonical `onOps` + `applyOpsToCollection` pattern, and the `*_as` stored-function row + transparency note.

### Changed

- **`docTypeFromDef` hot path** (`src/server/postgres/registry.ts`): when `opts.auth?.asSqlArg` is set, `open` / `apply` / `openAt` call the `delta_*_as` variants directly — one round-trip per op. `withAppAuth` is no longer on the auth hot path; it stays exported as the escape hatch for arbitrary queries under an identity that can't be expressed as a single SELECT.

### Driven by

Two observations from feedback sessions. (1) `withAppAuth` was taking four round-trips (`BEGIN` / `set_config` / call / `COMMIT`) for one logical op the protocol can do in one — at 20 ms RTT, an 80 ms tax per authenticated write, compounding into UI lag on a mobile app. (2) The dominant client pattern would be `effect(() => rebuild(list, doc.data.get()))`, which throws away the op-level precision delta already has — focus, scroll, animations all reset on every keystroke in a collaborative doc. `dom-ops` + `onOps` preserves that precision end-to-end; the `*_as` variants collapse the four RTTs into one.

## [0.2.1] — 2026-04-19

### Added

- **Codegen** (`src/server/postgres/codegen.ts`): `generateSql(schema, docs)` produces a self-contained `CREATE TABLE` + `_delta_collections` + `_delta_docs` SQL file from TypeScript. Ported from `clean/tasks.ts`.
- **Bootstrap helpers** (`src/server/postgres/bootstrap.ts`): `applyFramework(pool)`, `applySql(pool, sql)`, `frameworkSql()`, `frameworkSqlFiles()` for programmatic DB setup.
- **Auth-JWT bootstrap** (`src/server/auth-jwt.ts`): `applyAuthJwtSchema(pool)`, `authJwtSql()`, `authJwtSqlFile()`.
- **CLI** (`cli.ts`): `delta sql <module>` regenerates table SQL; `delta init <dir> [--with-auth]` copies framework + optional users SQL into a consumer's `init_db/` with a `-- @blueshed/delta <kind> v<version>` header. `--upgrade` replaces older files with `.bak` backups, refuses to clobber files missing the header or at a newer version, and no-ops when already current.
- **`logout` action** on `jwtAuth` — clears `client.data.identity` for identity-switching on a live socket.
- **`DeltaError`** type export from `src/client/client.ts` with an `isDeltaError(e)` narrowing helper for typed rejection handling.
- **Skill recipes** in `reference.md`: per-user list isolation (most common multi-tenant shape), RLS two-pool pattern (admin + non-super `app` role for real RLS enforcement), auth-before-open race note, `scope` syntax table (`:id` vs `id` distinction), `owner_id` injection + RLS `WITH CHECK` rationale, Bun HTML-route + WebSocket co-serve recipe, `docker-entrypoint-initdb.d` bootstrap option, session-restore client flow (`localStorage.token` → `call("authenticate", ...)` on load).
- **`/publish` command** at `.claude/commands/publish.md` — reproducible release pipeline (preflight → CI → bump → CHANGELOG promote → commit → tag). Prints the `git push` command but does not push.

### Changed

- **`src/` layout.** All library code moved under `src/` with three children: `src/client/` (browser), `src/server/` (Bun + backends), `src/sql/` (vendored SQL — framework `001a-001e-*.sql` plus `auth-jwt.sql`). Shared `DeltaOp` primitive is `src/core.ts`. Subpath exports from `package.json` are unchanged (`@blueshed/delta/client`, `/server`, `/postgres`, `/auth`, `/auth-jwt`, etc.) — the reorganization is internal only.
- `compose.yml` annotated as test-only (`tmpfs` is ephemeral; real apps use a named volume).

### Fixed

- **`delta init` no longer requires `jose` to be installed.** The CLI was eagerly importing `auth-jwt.ts` (which value-imports jose at module load) just to read a file path constant. Split the SQL-file helpers into `src/server/auth-jwt-sql.ts` — the CLI imports from there; `@blueshed/delta/auth-jwt` still re-exports them for consumers.

### Driven by

Three fresh Claude sessions that built the same multi-user todo app against the skill. The first surfaced the codegen gap, the missing per-user recipe, the RLS two-pool requirement, the auth-before-open race, and the missing logout / error-type primitives. The second (with those fixes in place) surfaced the `scope` syntax subtlety, the injection-vs-RLS overlap, and the Bun route + WS wiring question. The third surfaced the CLI's eager jose import and the missing `docker-entrypoint-initdb.d` + session-restore recipes — all now in `reference.md`.

## [0.1.0] — 2026-04-18

Initial extraction from `@blueshed/railroad` (delta-*) and the `clean` venue-manager.

### Added

- **Core primitive** (`core.ts`): `applyOps` and `DeltaOp` (add/replace/remove on JSON-Pointer paths).
- **Client** (`client.ts`): reconnecting WebSocket, `openDoc` reactive signal, `call` RPC. Peer-deps `@blueshed/railroad`.
- **Server** (`server.ts`): `createWs` action router, `registerDoc` JSON-file doc, `registerMethod` RPC.
- **SQLite backend** (`sqlite.ts`): `defineSchema` / `defineDoc` / `registerDocs` with temporal tables.
- **Postgres backend** (`postgres/`): schema definition, SQL helpers, stored-function framework (`001a-001e-*.sql`), single-LISTEN dispatch (`createDocListener`), doc-type registry (`registerDocType`, `docTypeFromDef`).
- **Auth extension** (`auth.ts`): `DeltaAuth<Identity>` contract, `wireAuth`, `upgradeWithAuth`. No URL-token path by construction.
- **JWT reference** (`auth-jwt.ts` + `auth-jwt.sql`): `jwtAuth({ pool, secret })` with login/register/authenticate actions, bcrypt via pgcrypto.
- **RLS plumbing** (`postgres/auth.ts`): `withAppAuth(pool, sqlArg, fn)` sets `app.user_id` for the transaction.
- **Test infrastructure**: `compose.yml` (Postgres 18), setup helpers, 171 tests across 7 files (85% functions / 87% lines).
- **Skill**: `.claude/skills/delta-doc/` with router SKILL.md and reference.md.

### Lineage

Evolution of `dzql` (database-first codegen for Vue/Pinia), `seiro` (CQRS over WebSocket with Preact Signals), and `paintbrush` (delta-sync WS infrastructure). Realised as a Postgres-native primitive in the `clean` venue-manager; this package is the extraction.

### Known gaps

- `postgres/sql.ts` codegen (TS schema → `002-tables.sql`) not yet extracted — consumers bring their own or write SQL by hand.
- `@blueshed/railroad` still ships its own `delta-*` modules; strip after delta bakes.
- Full RLS policy enforcement requires a non-superuser role (BYPASSRLS overrides FORCE). Test suite verifies plumbing only.
