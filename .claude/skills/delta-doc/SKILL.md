---
name: delta-doc
metadata:
  version: 0.13.1
description: "Use in a project that uses @blueshed/delta (it is in package.json, or the live-app guide chose it): documents, their three op verbs, storage in JSON, SQLite or Postgres, the ledger and undo, createLocal() for a server that renders, and the wire a client speaks. For choosing a stack for a new live app, use blueshed:live-app first: a whole live app drawn on the server is eta's (eta-app), reactive JSX on real DOM is railroad's."
---

# delta-doc

**A document is what someone needs in front of them to act.** To place an order: the catalogue
and your order, two documents over shared rows. Think in documents, not entities; the tables
follow. Open a document and you are subscribed: every change anyone makes reaches you, with
nothing to poll, fetch or refresh. Change it with `add`, `replace` or `remove` on a JSON Pointer
path, and everyone holding it sees it. What grows is where documents are kept (a JSON file,
SQLite, Postgres); the client stays the same.

## Order of work

1. **Name the documents**: for each thing a person does, what must be in front of them.
2. **Declare them**: `defineSchema` (tables, `parent` chains) and `defineDoc` (prefix, root,
   include, scope) in one `types.ts`.
3. **Keep them in the smallest backend that fits** (the JSON file first), registered on
   `createWs()` (a socket) or `createLocal()` (in-process).
4. **Client**: `connectWs`, `openDoc`, one keyed render path, `doc.send(ops)`. The echo renders.
5. **Grow when a story needs it**: `{ ledger: true }` for undo, `auth` + `owns` for who sees
   what, Postgres for several processes and RLS. The app does not change.

Start from `reference/recipe.md`, a chat room in four files that `tests/recipe.test.ts` runs.

## Invariants

- Three verbs only, on `/<coll>/<id>[/<field>]`. Never invent a verb. A replace of a row is
  the whole row (left-out fields take defaults); to change fields, replace each field.
- A batch applies whole or not at all.
- New rows are `add /<coll>/-`; the server names the id. Address rows by id, never position.
- Never update optimistically, never reload. `doc.send` echoes back through `onOps` and
  `doc.data`; touching the DOM too applies it twice. Reconnect re-opens every document itself.
- One render path, keyed: `applyOpsToCollection` (vanilla DOM) or railroad's `list()` (JSX),
  never both, never a rebuild from `doc.data` in an `effect`.
- A told replace may be one field: apply broadcasts with `applyOps`, never assume a whole row.
- Undo is the ledger's (`{ ledger: true }`), never a hand-rolled stack.
- The schema is the contract: delta reads and writes only declared columns. A database may hold
  more, never less: at start-up `migrate`, then `createTables` / `migrateSchema`.
- With `auth`, every document says who may have it: `owns` or `shared: true`. A name is its
  broadcast channel; RLS filters reads, not the channel.
- Tokens never in the socket URL. Sign in with `connectWs(url, { onConnect })`.
- No Redux, REST, `fetch` of state, React or Supabase patterns. `doc.data` is a signal.

## The types are the contract

Paths below are in the package (`node_modules/@blueshed/delta/` in an app). `src/core.ts`
(`DeltaOp`, `applyOps`, `joinPath`), `src/schema.ts` (`DocDef`, column types),
`src/client/client.ts` (`Doc`, `ConnectOptions`), `src/server/sqlite.ts` (`RegisterOptions`),
`src/server/custom.ts` (`CustomDoc`), `src/server/postgres/registry.ts` (`DocType`),
`src/server/auth.ts` (`DeltaAuth`), `src/server/kinds.ts`, `src/server/local.ts`. The
exports map is `package.json`'s `exports`.

## Which reference for which job

- First app: `reference/recipe.md`. Choosing or moving storage: `reference/backends.md`,
  `reference/sqlite.md`, `reference/postgres.md`.
- Paths, ids, error codes: `reference/paths.md`. Tables: `reference/schema.md`.
- Document shapes: `reference/documents.md`; names and filters: `reference/scope.md`.
- What a write may do: `reference/writes.md`; who is told: `reference/fanout.md`.
- Derived views: `reference/custom-docs.md`. Memory, source, static, free-form:
  `reference/kinds.md`.
- The page: `reference/rendering.md`, `reference/write-loop.md`. The server: `reference/server.md`.
- Sign-in: `reference/auth.md`; who may open what: `reference/ownership.md`; Postgres RLS:
  `reference/rls.md`; SQL functions: `reference/sql.md`.
- Undo and history: `reference/ledger.md`. In-process: `reference/local.md`.
- Upgrading a database that holds data (rename, drop, move): `reference/migrations.md`.
- The wire: `reference/wire.md`. CLI: `reference/cli.md`. Tests and scripts: `reference/testing.md`.
