# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Codegen** (`postgres/codegen.ts`): `generateSql(schema, docs)` produces a self-contained `CREATE TABLE` + `_delta_collections` + `_delta_docs` SQL file from TypeScript. Ported from `clean/tasks.ts`.
- **Bootstrap helpers** (`postgres/bootstrap.ts`): `applyFramework(pool)`, `applySql(pool, sql)`, `frameworkSql()`, `frameworkSqlFiles()` for programmatic DB setup.
- **Auth-JWT bootstrap** (`auth-jwt.ts`): `applyAuthJwtSchema(pool)`, `authJwtSql()`, `authJwtSqlFile()`.
- **CLI** (`cli.ts`): `delta sql <module>` regenerates table SQL; `delta init <dir> [--with-auth]` copies framework + optional users SQL into a consumer's `init_db/`.
- **`logout` action** on `jwtAuth` — clears `client.data.identity` for identity-switching on a live socket.
- **`DeltaError`** type export from `client.ts` with an `isDeltaError(e)` narrowing helper for typed rejection handling.
- **Skill recipes**: per-user list isolation (most common multi-tenant shape), RLS two-pool pattern (admin + non-super `app` role for real RLS enforcement), auth-before-open race note.
- **`/publish` command** at `.claude/commands/publish.md` — reproducible release pipeline (preflight → CI → bump → CHANGELOG promote → commit → tag). Prints the `git push` command but does not push.

### Changed

- Skill updated with the full bootstrap story (programmatic + CLI paths), codegen workflow, and the recipes above.
- `compose.yml` annotated as test-only (`tmpfs` is ephemeral; copy with a named volume for real apps).

### Driven by

Feedback from a fresh Claude session that built a multi-user todo app against the 0.1.0 skill — surfaced the codegen gap, the missing per-user recipe, the RLS two-pool requirement, the auth-before-open race, and the missing logout/error-type primitives.

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
