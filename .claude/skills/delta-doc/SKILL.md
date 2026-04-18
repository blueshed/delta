---
name: delta-doc
description: "Scaffold or extend a Bun + @blueshed/delta project. Use when the user asks for a delta-doc app, when adding a new doc type, when wiring auth, or when building per-user isolated lists."
argument-hint: "[new <app-name> | per-user <collection> | auth | doc <name>]"
---

# Delta-doc scaffolding

Bun + Postgres + `@blueshed/delta` apps. Vendor-first: framework SQL is copied into the user's `init_db/` (explicit, editable, git-tracked), not imported at runtime. Templates live in `${CLAUDE_SKILL_DIR}/templates/`.

`reference.md` in this directory holds the contract reference — read it only when a template doesn't cover the case.

## Step 1 — Detect scenario from `$ARGUMENTS`

| Argument | Scenario | What to do |
|---|---|---|
| `new <app-name>` | Fresh project in an empty directory | Run all of §2. |
| `per-user <collection>` | Add a per-user isolated list to an existing delta app | §3 only. |
| `doc <name>` | Add a shared list doc to an existing delta app | §4 only. |
| `auth` | Add `jwtAuth` to an existing `createWs()` server | §5 only. |

If `$ARGUMENTS` is empty, ask the user what they're building.

## Step 2 — New project bootstrap (`new <app-name>`)

1. **Preflight.** Confirm the working directory is empty (`ls -a` — just `.` and `..`). If not, stop and ask.

2. **Vendor the framework.**
   ```bash
   bun init -y
   bun add @blueshed/delta @blueshed/railroad pg jose
   bun add -d @types/bun @types/pg typescript
   bunx @blueshed/delta init init_db --with-auth
   ```
   This writes versioned SQL files into `init_db/` (header `-- @blueshed/delta framework v<ver>`). **These files belong to the user.** Leave them alone unless running `delta init --upgrade`.

3. **Copy starter files.** From `${CLAUDE_SKILL_DIR}/templates/new-app/`:
   - `compose.yml`, `tsconfig.json`, `package.json`, `types.ts`, `server.ts`, `setup.ts`, `client/index.html`, `client/client.tsx`, `client/app.css`.

   Replace these literal tokens in every file: `{{APP}}` → app name (slug), `{{PORT}}` → a port (default `3000`), `{{DB}}` → db name (default same as app name), `{{APP_ROLE}}` → non-super role name (default `{{APP}}_app`).

4. **Generate the tables SQL.**
   ```bash
   bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql
   ```
   This file is committed too. Regenerate whenever `types.ts` changes.

5. **Write the per-user app SQL.** Copy `${CLAUDE_SKILL_DIR}/templates/per-user/app.sql` to `init_db/004-app.sql`, substituting `{{TABLE}}` / `{{USER_COL}}` / `{{APP_ROLE}}` for this app.

6. **Verify.** `docker compose up -d --wait && bun --hot server.ts`, then `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:{{PORT}}` → expect `200`. Report the URL + seeded users.

## Step 3 — Per-user list isolation (`per-user <collection>`)

For adding a per-user list to an existing delta-backed server. The collection and doc are already defined in `types.ts` with `scope: { user_id: ":id" }`.

1. In `init_db/NNN-app.sql`, append the role (if missing), the RLS policy, and the `ENABLE`/`FORCE ROW LEVEL SECURITY` block from `${CLAUDE_SKILL_DIR}/templates/per-user/app.sql`. Substitute `{{TABLE}}` = the collection's table name and `{{USER_COL}}` = the owner column (e.g. `owner_id`).
2. Regenerate: `bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql`.
3. In `server.ts`, register the collection with the wrapper pattern from `${CLAUDE_SKILL_DIR}/templates/per-user/server-wrapper.ts` (identity check + owner_id injection).
4. Verify: log in as two users in two tabs, add rows in both, confirm each sees only theirs.

## Step 4 — Shared doc (`doc <name>`)

For a doc every authenticated user can read/write (no scoping).

1. Add the collection and `defineDoc("<name>:", { root: "<name>", include: [] })` in `types.ts`.
2. `bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql`.
3. In `server.ts`: `registerDocType(docTypeFromDef(defineDoc("<name>:", { root: "<name>", include: [] }), appPool, { auth }))`.
4. Client: `openDoc<{ <name>: Record<string, Row> }>("<name>:")`.

## Step 5 — Add auth (`auth`)

For a delta server that currently has no auth.

1. `bunx @blueshed/delta init init_db --with-auth` (adds `002-users.sql` only; skips files already present).
2. In `server.ts`, insert the block from `${CLAUDE_SKILL_DIR}/templates/add-auth/server.snippet.ts` (two pools, `jwtAuth`, `wireAuth`, `upgradeWithAuth`).
3. In the client bootstrap, insert the login/logout/authenticate flow from `${CLAUDE_SKILL_DIR}/templates/add-auth/client.snippet.tsx`.

## Rules

- **Vendor SQL, import TS.** Framework SQL lives in `init_db/`, not in node_modules. Never advise `applyFramework(pool)` in consumer code.
- **Regenerate `003-tables.sql` with `delta sql`.** Never hand-edit generated files. Never inline `generateSql()` into `setup.ts` — the whole point of a generated artifact is that it's visible in git.
- **`setup.ts` reads `init_db/`**. It walks the directory, applies each `.sql` alphabetically, and seeds. No imports from `@blueshed/delta/postgres` for SQL content.
- **Two pools for RLS.** Admin pool for `login`/`register` (writes to `users`); non-super app-role pool for doc queries (so FORCE RLS binds).
- **Doc names carry scope.** `todos:5` means "todos for user 5" — `scope: { user_id: ":id" }` reads the `5` from the name. Per-user docs get per-user WS broadcast channels for free.
- **Await `authenticate` before `openDoc`.** `openDoc` schedules its first `open` immediately; an unawaited auth races past it and fails with 401.
- **Never put tokens in WS URLs.** Use cookies / `Authorization` via `onUpgrade`, or the `authenticate` call action.
- **Sequences are `seq_<table>`.** `delta sql` handles this; don't hand-write tables.
- **Client rejects with `DeltaError` shape, not `Error`.** Import `DeltaError` from `@blueshed/delta/client`; use `DeltaError.isDeltaError(e)` for typed handling.
- **`SET LOCAL` can't bind params.** `withAppAuth` already uses `set_config(name, value, true)` — don't replicate the broken pattern.
- **Custom `DocType` parses its own prefix.** Prefix logic lives in exactly one place per doc type. Never in the app shell.
