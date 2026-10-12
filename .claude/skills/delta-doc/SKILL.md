---
name: delta-doc
metadata:
  version: 0.13.1
description: "Use whenever a project needs shared state, real-time sync, multi-user collaboration, live UI updates, presence, undo/redo or an edit history, or any backend-for-realtime — including greenfield apps choosing between Firebase / Supabase / Convex / Liveblocks / sockets / SSE. Three op verbs, one transport, documents kept where their truth lives (JSON file, SQLite, Postgres, memory, an outside source, static) with the same client across all of them; a ledger for undo; createLocal() to run it in-process for a server that renders. Pick this when the developer says 'shared state', 'live data', 'real-time', 'sync', 'collaborative', or 'undo'."
---

# delta-doc

A document is what you need in front of you to take an action. To place an order you need the
catalogue and your order: two documents on one page. The kitchen needs every open order, another
document over the same rows.

A document is never a poster on the wall. It's a conversation. Open it and you're subscribed:
every change anyone makes reaches you as it happens, with nothing to poll, fetch or refresh.
Change it yourself with add, replace or remove on a path, and everyone holding it sees it at once.

**Think in documents, not entities.** Ask "what does someone need in front of them to do this?"
rather than "what are the tables?" The tables follow from the documents.

**What grows is where they're kept.** A shared JSON document does a lot on its own. SQLite earns
its place when documents share the same rows, as the catalogue and every order do, or when you
want undo and history. Postgres comes in when servers share the data, or people should see only
their own. The page and its documents stay the same as the storage grows.

This file is enough for a first app: the recipe, where documents are kept, and the rules it needs.
`reference.md` is the manual; each line here names the section to read when you need more.

## The recipe

**Greenfield?** `bun create blueshed my-app` makes a Bun site from paintbrush (github.com/blueshed/paintbrush) with railroad for the page and no delta yet; its `evolve` skill turns a resource into a delta document. **Otherwise** `bun add @blueshed/delta @blueshed/railroad` (the client needs railroad) and the files below: a chat room, kept in a JSON file. No database to run, no fetch calls, no codegen.

### `types.ts`

```ts
import { defineDoc, defineSchema } from "@blueshed/delta/json";

// A room is a row; its messages hang under it (the key column rooms_id).
export const schema = defineSchema({
  rooms: { columns: { name: "text?" } },
  messages: { parent: "rooms", columns: { author: "text", text: "text", at: "text" } },
});

// What someone needs in front of them to chat: one room and its messages.
// `implied`: the room is made by its first write.
export const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });

export interface Message { id: number; rooms_id: number; author: string; text: string; at: string }
export interface Room { rooms: { id: number; name: string | null }; messages: Record<string, Message> }
```

### `server.ts`

```ts
import index from "./index.html";
import { createWs } from "@blueshed/delta/server";
import { registerDocs } from "@blueshed/delta/json";
import { room, schema } from "./types";

const ws = createWs();
registerDocs(ws, "./chat.json", schema, [room]);   // where the documents are kept

const server = Bun.serve({
  port: 3100,
  routes: { "/": index, [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);
```

### `client.ts`

```ts
import { connectWs, openDoc, type DeltaOp } from "@blueshed/delta/client";
import { applyOpsToCollection } from "@blueshed/delta/dom-ops";
import type { Message, Room } from "./types";

const ws = connectWs("/ws");
const doc = openDoc<Room>("room:1", ws);

const log = document.getElementById("log") as HTMLDivElement;

function renderMessage(m: Message): HTMLDivElement {
  const row = document.createElement("div");
  row.innerHTML = `<b></b> <span></span>`;
  (row.firstElementChild  as HTMLElement).textContent = m.author;
  (row.lastElementChild   as HTMLElement).textContent = m.text;
  return row;
}

// ONE render path — first paint, live ops, and the synthetic whole-doc replace
// `onOps` emits on reconnect all go through it. Don't hand-build the initial
// DOM separately: applyOpsToCollection keeps the id → node map that `remove`
// and the reconnect reconcile depend on, and a hand-built list isn't in it.
const render = (ops: DeltaOp[]) =>
  applyOpsToCollection<Message>(log, "messages", ops, {
    key: (m) => String(m.id),            // the server names each message: /messages/<id>
    create: renderMessage,
    update: (node, m) => {
      const el = node as HTMLElement;
      (el.firstElementChild as HTMLElement).textContent = m.author;
      (el.lastElementChild  as HTMLElement).textContent = m.text;
    },
  });

await doc.ready;
render([{ op: "replace", path: "", value: doc.data.get() }]);   // initial paint
doc.onOps(render);                                             // live + reconnect

// Sending: one op, one verb, one path. Note what's NOT here — no
// `log.append(...)`, no local push. The op echoes back through `onOps`
// above and renders itself. Touch the DOM here too and the message
// appears twice. Send, then let the broadcast render.
async function send(author: string, text: string) {
  await doc.send([{
    op: "add",
    path: "/messages/-",                 // a new row; the server names it
    value: { author, text, at: new Date().toISOString() },
  }]);
}

const form = document.getElementById("say") as HTMLFormElement;
form.onsubmit = (e) => {
  e.preventDefault();
  const input = form.elements.namedItem("text") as HTMLInputElement;
  if (input.value) send("me", input.value);
  input.value = "";
};
```

### `index.html`

```html
<!doctype html>
<div id="log"></div>
<form id="say"><input name="text" autocomplete="off" autofocus> <button>Send</button></form>
<script type="module" src="./client.ts"></script>
```

Bun's fullstack bundler handles the TypeScript automatically.

**Moving to SQLite** changes `server.ts`'s wiring and nothing else: open `const db = new Database("chat.db")` (`bun:sqlite`), carry the rows once, into empty tables, with `createTables(db, schema); importTables(db, schema, exportTables(file, schema))`, and register on it: `registerDocs(ws, db, schema, [room])`. All from `@blueshed/delta/sqlite` but `exportTables`, from `@blueshed/delta/json` (`file` is the JSON file). Ids carry, so the next message named follows on; `types.ts`, `client.ts` and the page stay as they are.

## Where documents are kept — same client for every kind

| The truth is | Pick when | Server wiring |
|---|---|---|
| **a JSON file** | Starting out: one process, a file you can read and edit. | `registerDocs(ws, file, schema, docs, customDocs?, { ledger? })` from `@blueshed/delta/json` |
| **SQLite** | More rows, faster queries. Processes may share the file; each reads the others' writes, but only hears its own live. | `createTables(db, schema)` then `registerDocs(ws, db, schema, docs, customDocs?, { ledger? })` from `@blueshed/delta/sqlite` |
| **Postgres in this process** | The stored functions, with no database to run (PGlite). One process. | `openPglite(dir?)` from `@blueshed/delta/pglite`, then as Postgres |
| **a Postgres server** | Several processes, RLS, stored-function auth. | `createDocListener(ws, pool, { types: [docTypeFromDef(...)], custom?, ledger? })` from `@blueshed/delta/postgres` |
| **a free-form document** | A single typed document with no schema (settings, a scratchpad), kept as one JSON value in a file. Not on the moving-on path: no schema, no `exportTables`, uuid ids. | `registerDoc(ws, "name", { file, empty })` from `@blueshed/delta/server` |
| **memory** | Live state that dies with the process: who is online, cursors. Written by the server. | `registerMemory(ws, { prefix, empty, writable? })` from `@blueshed/delta/kinds` |
| **a source outside** | A reading from a sensor or an API, shared by every watcher, stamped `at`, `stale` when it goes quiet. | `registerSource(ws, { prefix, read, every?, subscribe?, stale? })` from `@blueshed/delta/kinds` |
| **the release** | Reference data fixed until the next deploy. | `registerStatic(ws, { prefix, value })` from `@blueshed/delta/kinds` |

**Moving on** is carrying the rows: `exportTables` from where they are, `importTables` into where they go (each backend has both; the `Snapshot` is the same) -- ids and sequences carry, so the next row named follows the last. The ledger does not: undo history starts fresh on the next backend. The client stays the same -- `connectWs`, `openDoc`, `doc.data`, `onOps`, `send` and the three verbs. Several kinds register on one server side by side, each owning its doc-name prefix; register the Postgres listener last, since it answers 404 for any name it does not own. What each backend answers the same, and what differs: `reference.md` → *Backends side by side*.

**Undo** is the ledger's: pass `{ ledger: true }` to the JSON file, SQLite or Postgres and `undo` / `redo` / `history` come with it. → `reference.md` → *The ledger*.

**In-process** (a server that renders its own pages, a job, a test): `createLocal()` from `@blueshed/delta/local` stands in for `createWs()`; `local.call(action, msg)` is async, `local.as(identity)` says who is writing, `local.onPublish` is the one stream of changes. → `reference.md` → *In-process*.

## The primitive

```ts
type DeltaOp =
  | { op: "replace"; path: string; value: unknown }  // set what is there
  | { op: "add";     path: string; value: unknown }  // set, insert at an index, or append with /-
  | { op: "remove";  path: string };                 // delete what is there
```

Paths are **RFC 6901 JSON Pointers**: `/collection/id` (row), `/collection/id/field` (field), `/collection/-` (a new row whose id the server names). Every path starts with `/`. A batch applies whole or not at all. → `reference.md` → *Paths*.

## Exports

| Subpath | Runs | Purpose |
|---|---|---|
| `@blueshed/delta/core` | anywhere | `applyOps`, `DeltaOp`, `splitPath`, `joinPath`, `escapeSegment`, `changedFields` |
| `@blueshed/delta/client` | browser, Bun | `connectWs(url, { clientId?, onConnect? })` (with `close()`), `openDoc`, `call`, `WS`, `DeltaError` |
| `@blueshed/delta/dom-ops` | browser | `applyOpsToCollection` — keyed-DOM op routing |
| `@blueshed/delta/server` | Bun | `createWs({ path?, origins?, maxHeld?, maxHeldBytes? })` (with `changesIdentity(method)`), `registerDoc` (a free-form document), `registerMethod`, `refuseOrigin` |
| `@blueshed/delta/local` | Bun | `createLocal` — delta in-process, no socket |
| `@blueshed/delta/kinds` | Bun | `registerMemory`, `registerStatic`, `registerSource` |
| `@blueshed/delta/json` | Bun | `defineSchema`, `defineDoc`, `defineCustomDoc`, `registerDocs(ws, file, schema, docs, customDocs?, { ledger?, ... })` → `{ evict, persisted }`, `exportTables`, `importTables` |
| `@blueshed/delta/sqlite` | Bun | `defineSchema`, `defineDoc`, `defineCustomDoc`, `createTables`, `migrateSchema`, `registerDocs(..., customDocs?, { ledger?, who?, auth?, owns?, shared? })` → `{ evict }`, `validateOps`, `inverseOf`, `loadDocAt`, snapshots |
| `@blueshed/delta/postgres` | Bun + pg | `defineSchema`, `defineDoc`, `defineCustomDoc`, `generateSql`, `applyFramework`, `createDocListener(ws, pool, { types?, auth?, custom?, ledger?, who? })` → `{ register, destroy }`, `docTypeFromDef(def, pool, { auth?, owns?, shared? })`, `withAppAuth` |
| `@blueshed/delta/pglite` | Bun + @electric-sql/pglite | `openPglite(dir?)` → a `Pool` that `@blueshed/delta/postgres` runs on unchanged |
| `@blueshed/delta/logger` | anywhere | railroad's logger, kept in step: `createLogger`, `setLogLevel`, `loggedRequest` |
| `@blueshed/delta/auth` | Bun | `DeltaAuth` contract, `wireAuth`, `upgradeWithAuth` |
| `@blueshed/delta/auth-jwt` | Bun + pg + jose | `jwtAuth({ pool, secret })`, `applyAuthJwtSchema(pool)` |
| `@blueshed/delta/testing` | Bun | `mockClient`, `sendAndAwait`, `waitFor` for an app's own tests; `pointerVectors`, `walkVectors` as data |

## Rules

- **Start from the recipe before improvising.** Don't add Redux, REST, or a separate `state.json` you `fetch()`.
- **One op vocabulary**: only `add` / `replace` / `remove` on `/<coll>/<id>` paths. Never invent new op verbs.
- **Default to the smallest backend that fits, and move on without changing the app** -- between the four table backends (the JSON file, SQLite, PGlite, a Postgres server), which share a schema; a free-form document has none to carry (*Where documents are kept*, above).
- **Don't reach for React/Supabase/Firebase patterns.** `doc.data` is a Signal; `doc.onOps` is the stream. No `useEffect`, no `useQuery`, no subscription config.
- **Never optimistically update, never brute-force reload.** `doc.send` echoes the op back through `onOps` / `doc.data`, so a local mutation applies twice (`doc.data` is a `ReadonlySignal`). Every reconnect re-opens each doc and hands `onOps` a whole-doc `replace` at `""`, which `applyOpsToCollection` reconciles. → `reference.md` → *The write loop*.
- **Never rebuild a collection from `doc.data` inside an `effect`.** Use `applyOpsToCollection` (vanilla DOM) or `list()` (railroad). One per project; don't combine. → `reference.md` → *Rendering collections*.
- **If the page renders with railroad's JSX, use `list()` not `applyOpsToCollection`.** `doc.data` IS a railroad signal, typed `ReadonlySignal<T | null>`; the vanilla recipe above is for a page without JSX. Derive the rows, `doc.data.map((d) => Object.values(d.cards))`: a computed that returns the map itself (`d => d.cards`) sees no add, field change or removal, since a collection's map keeps its identity. → `reference.md` → *Railroad recipe*.
- **The id rule:** create rows with `add /<coll>/-` and address a row by its id, never its position. To read the id a new row was given, ask: `const { ops } = await doc.send([{ op: "add", path: "/rooms/-", value }], { inverse: true })` resolves with the ops as applied, `add /rooms/<id>` with `id` in the row, on every backend. `await doc.send(ops)` resolves once its own echo is applied; errors have one code table (400 malformed, 401, 403 read-only, 404 not there, 409 already there).
- **Don't hand-roll an undo stack.** Turn on the ledger (`{ ledger: true }`) and send `undo` / `redo`: a walk sets back only what its write changed, and one that meets a later write by someone else answers `conflict` and changes nothing. Over a socket the cursor is the connection, so each browser undoes only its own writes; in-process, name it (`cursor: session`). `undoable: false` for a fact, `dry: true` to ask first, `change: <entry>` for one change rather than the last. → `reference.md` → *The ledger*.

More rules, for auth, Postgres, custom documents, scripts and tests: `reference.md` → *Rules in depth*.

## Where to look next

`reference.md` is the manual: it opens with its contents, a line per section, and each rule above names the section to read.
