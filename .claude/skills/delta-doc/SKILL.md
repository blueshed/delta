---
name: delta-doc
metadata:
  version: 1.2.0
description: "Use in a project that uses @blueshed/delta (it is in package.json): documents, their three op verbs, storage in a JSON file or SQLite (Postgres: dzql), migrations, sign-in by link, who may open what, the ledger and undo, createLocal(), and the wire a client speaks. Choosing a stack for a new live app is blueshed:live-app's."
---

# delta-doc

**A document is what someone needs in front of them to act.** To place an order: the catalogue
and your order, two documents over shared rows. Think in documents, not entities; the tables
follow. Open a document and you are subscribed: every change anyone makes reaches you. Change it with `add`, `replace` or `remove` on a JSON Pointer
path, and everyone holding it sees it. What grows is where documents are kept (a JSON file,
then SQLite, then Postgres on dzql); the client stays the same.

## Order of work

1. **Name the documents**: for each thing a person does, what must be in front of them.
2. **Declare them**: `defineSchema` (tables, `parent` chains) and `defineDoc` (prefix, root,
   include, scope) in one `types.ts`.
3. **Keep them in the smallest backend that fits** (the JSON file first), registered on
   `createWs()` (a socket) or `createLocal()` (in-process).
4. **Client**: `connectWs`, `openDoc`, one keyed render path, `doc.send(ops)`. The echo renders.
5. **Grow when a story needs it**: `{ ledger: true }` for undo, `auth` and a document's `owns`
   for who sees what, a migration for each change to the tables, dzql when servers share the
   data. The app does not change.

## Invariants

- Three verbs only, on `/<coll>/<id>[/<field>]`. A replace of a row is
  the whole row (left-out fields take defaults); to change fields, replace each field.
- A batch applies whole or not at all.
- New rows are `add /<coll>/-`; the server names the id. Address rows by id, never position.
- Never update optimistically, never reload: `doc.send` echoes back through `onOps` and
  `doc.data`. Reconnect re-opens every document itself.
- One render path, keyed: `applyOpsToCollection` (vanilla DOM) or railroad's `list()` (JSX),
  never both, never a rebuild from `doc.data` in an `effect`.
- A told replace may be one field: apply broadcasts with `applyOps`, never assume a whole row.
- Undo is the ledger's (`{ ledger: true }`), never a hand-rolled stack.
- The schema is the contract: delta sends and writes only declared columns. A database may
  hold more, never less. Its tables are made by its migrations, from empty: change the schema,
  then `delta migrations make` writes the next one; `migrate` runs them at start-up.
- With `auth`, every document says who may have it: `owns` (a path from its row to the person)
  or `shared: true`. A name is its broadcast channel: whoever holds it hears every write through it.
- Tokens never in the socket URL. Sign in with `connectWs(url, { onConnect })`.
- No Redux, REST, `fetch` of state, React or Supabase patterns. `doc.data` is a signal.

## The types are the contract

In the package (`node_modules/@blueshed/delta/`): `src/core.ts`, `src/schema.ts`,
`src/client/client.ts`, `src/server/sqlite.ts`, `src/server/auth.ts`, `src/server/auth-link.ts`,
`src/paths.ts`, `src/server/changes.ts`, `src/server/migrate.ts`; the exports map in `package.json`.

## Which reference for which job

- First app: `reference/recipe.md`. Storage: `reference/backends.md`, `reference/sqlite.md`;
  moving on to Postgres: `reference/postgres.md`; upgrading, data kept: `reference/migrations.md`.
- JSON Pointer paths, ids, error codes: `reference/paths.md`. Tables: `reference/schema.md`.
- Document shapes: `reference/documents.md`; names and filters: `reference/scope.md`.
- What a write may do: `reference/writes.md`; who is told: `reference/fanout.md`.
- Derived views: `reference/custom-docs.md`. Other kinds: `reference/kinds.md`.
- The page: `reference/rendering.md`, `reference/write-loop.md`. The server: `reference/server.md`.
- Sign-in: `reference/auth.md` (a link is someone; no passwords). Who opens what, `owns` as a
  path: `reference/ownership.md`.
- Undo and history: `reference/ledger.md`. In-process: `reference/local.md`.
- The wire: `reference/wire.md`. CLI: `reference/cli.md`. Tests and scripts: `reference/testing.md`.
