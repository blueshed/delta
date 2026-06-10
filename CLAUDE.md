# CLAUDE.md

Guidance for Claude Code (and humans) working on **@blueshed/delta** — a
JSON-Patch document-sync framework (three op verbs, one WebSocket, three
backends: JSON file → SQLite → Postgres).

## TL;DR

```bash
bun install
bun test tests/core.test.ts tests/server.test.ts tests/sqlite.test.ts   # no DB needed
# Postgres tests need a running PG — see "Testing in this environment" below.
```

## Testing in this environment (remote sandbox / Claude Code on the web)

This is an **ephemeral container with no Docker daemon**. The repo's normal
DB workflow (`bun run db:up` / `bun run ci`) shells out to `docker compose`
(see `compose.yml`) and **will fail here**:

```
unable to get image 'postgres:18-alpine': ... docker.sock: no such file
```

Instead, use the **Postgres 16 cluster that ships in this image**. The steps
below are idempotent; re-run them after any container restart (nothing in the
container survives reclamation).

### One-time setup per container

```bash
# 1. Latest Bun via npm (a 1.3.x bun may already be on PATH; this pins latest).
npm install -g bun

# 2. Start the local Postgres 16 cluster (starts DOWN; listens on :5432).
pg_ctlcluster 16 main start
pg_lsclusters                      # expect: 16 main 5432 online

# 3. Create the role + database the test suite expects.
#    `delta` is a SUPERUSER on purpose — it mirrors the compose stack, where
#    POSTGRES_USER=delta is the container superuser (see the RLS note below).
su postgres -c "psql -v ON_ERROR_STOP=1 -c \"DO \\\$\\\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='delta') THEN
    CREATE ROLE delta LOGIN SUPERUSER PASSWORD 'delta';
  END IF; END \\\$\\\$;\""
su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='delta_test'\"" \
  | grep -q 1 || su postgres -c "createdb -O delta delta_test"

# 4. Install JS deps.
bun install
```

Verify the DB is reachable over TCP with password auth:

```bash
PGPASSWORD=delta psql -h localhost -p 5432 -U delta -d delta_test -tAc "select version()"
```

### Running the tests

The suite defaults to `postgres://delta:delta@localhost:5433/delta_test` (the
compose port). The local cluster is on **5432**, so override `DELTA_TEST_PG_URL`:

```bash
export DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test"

bun test tests/            # full suite (321 tests, ~11s) — the real gate here
bun run check              # tsc --noEmit (no DB needed)
```

`bun run test:all` works too, but **do not run `bun run ci`** in this
environment — it wraps the suite in `db:up`/`db:down` (Docker) and aborts
before any test runs. The CI-equivalent here is:

```bash
bun run check && DELTA_TEST_PG_URL="postgres://delta:delta@localhost:5432/delta_test" bun test tests/
```

The GitHub Actions workflow (`.github/workflows/publish.yml`) runs the
Docker-based gate on release; reproducing that gate locally here is what the
command above is for.

### Test fixtures & framework SQL — applied automatically

`tests/setup.ts` owns DB bring-up per test file:

- `newPool()` → `Pool` from `DELTA_TEST_PG_URL` (defaults to `:5433`).
- `applyFramework(pool)` runs `src/sql/001a–001f-*.sql` in order.
- `applyAuthJwt(pool)` runs `src/sql/auth-jwt.sql` (users + login/register).
- `applyItemsFixture(pool)` / fixtures in `tests/fixtures/`.
- `resetState(pool)` truncates between tests.

You don't seed anything by hand — just have the cluster running and the
`delta` / `delta_test` role+DB present.

## Command reference

| Task | Command |
|---|---|
| Install deps | `bun install` |
| Typecheck | `bun run check` |
| Fast tests (no DB) | `bun test tests/core.test.ts tests/server.test.ts tests/sqlite.test.ts tests/auth.test.ts` |
| Postgres tests | `DELTA_TEST_PG_URL=postgres://delta:delta@localhost:5432/delta_test bun test tests/postgres.test.ts tests/auth-jwt.test.ts` |
| Full suite | `DELTA_TEST_PG_URL=postgres://delta:delta@localhost:5432/delta_test bun test tests/` |
| Start local PG | `pg_ctlcluster 16 main start` |
| PG status | `pg_lsclusters` |
| psql shell | `PGPASSWORD=delta psql -h localhost -p 5432 -U delta -d delta_test` |

## Notes & gotchas

- **No Docker here.** `compose.yml`, `db:up`, `db:down`, and `ci` all assume a
  Docker daemon. Use the local PG-16 cluster instead (above).
- **Port 5432 vs 5433.** The suite's default URL is `:5433` (compose maps the
  container's 5432 → host 5433 so it won't clash with a host Postgres). The
  bundled cluster listens on `:5432`, so always set `DELTA_TEST_PG_URL`.
- **`delta` is a superuser, which has `BYPASSRLS`.** This matches the compose
  stack. Consequently the Postgres tests verify RLS *plumbing* (that
  `withAppAuth` sets `app.user_id`) rather than full policy *enforcement* —
  full `FORCE ROW LEVEL SECURITY` enforcement requires a non-superuser role
  (see the comment in `tests/auth-jwt.test.ts`). If you add tests that must
  prove a policy actually blocks cross-tenant reads, create a dedicated
  `NOSUPERUSER` role for them.
- **Two Bun installs may exist** (`/root/.bun/bin/bun` preinstalled,
  `/opt/node22/bin/bun` from `npm -g`). `npm install -g bun` keeps the
  npm-global one latest; `command -v bun` shows which is active on PATH.
- **Ephemeral container.** Re-run the one-time setup after any restart;
  commit anything worth keeping.

## Layout

- `src/core.ts` — `applyOps`, `DeltaOp` (no deps; runs anywhere).
- `src/client/` — `client.ts` (reconnecting WS + reactive `openDoc`),
  `dom-ops.ts` (`applyOpsToCollection`).
- `src/server/server.ts` — `createWs` + JSON-file backend (`registerDoc`).
- `src/server/sqlite.ts` — SQLite backend (`registerDocs`, custom docs).
- `src/server/postgres/` — Postgres backend (listener, registry, codegen,
  schema, bootstrap, auth).
- `src/server/auth*.ts` — `DeltaAuth` contract + reference JWT impl.
- `src/sql/001a–001f-*.sql` — framework stored functions (read-only contract).
- `tests/` — `bun test`; `tests/setup.ts` is the shared harness.
- `.claude/skills/delta-doc/` — the published skill (SKILL.md is the router,
  reference.md the manual). Version in SKILL.md frontmatter tracks
  `package.json` and is bumped by the `/publish` flow.
</content>
</invoke>
