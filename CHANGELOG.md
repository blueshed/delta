# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
