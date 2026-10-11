# @blueshed/delta

**delta keeps data live between everyone who has it open: change it in one browser and every
other browser showing it updates at once. It starts on a JSON file and grows to a Postgres
server without changing your app.**

Your data lives in ordinary tables. A *document* is the part of them one screen shows (a
shopping list and its items, a venue and its rooms), named by a string such as `list:1`. A
browser opens a document and changes it with three verbs (`add`, `replace`, `remove`) on paths
like `/items/3/done`. The server applies the change and passes it to every open document that
holds the row, so each one sees the row arrive, change or leave. Turn on the *ledger*, a record
of every write, and each person can undo their own writes while others keep writing. A table
also keeps every version of its rows (unless you turn that off), so a document can be read as it
stood last March.

Start on a JSON file, move to SQLite, then to Postgres in the same process, and deliver on a
Postgres server. Each step changes the few lines that say where the data is kept, and nothing
else: the tables, the documents and the writes stay the same, and the rows move with their
ids. The undo history (the ledger) does not move: it starts fresh on the next backend. No
rewrite, no second data layer, no reload logic.

It exists because shared, live state should be one small idea rather than a stack of fetch
calls, caches and sockets, and there is one way to do each thing.

Delta runs on [Bun](https://bun.sh). It ships TypeScript source (the exports are `.ts` files),
the SQLite backend uses `bun:sqlite` and the server uses `Bun.serve`. The browser code needs a
bundler; Bun's HTML imports do it with no configuration.

## Try it

```sh
mkdir try-delta && cd try-delta && bun add @blueshed/delta
```

Save this as `try.ts`:

```ts
import { Database } from "bun:sqlite";
import { createLocal } from "@blueshed/delta/local";
import { setLogLevel } from "@blueshed/delta/logger";
import { createTables, defineDoc, defineSchema, registerDocs } from "@blueshed/delta/sqlite";

setLogLevel("warn");

// A shopping list: a row per list, its items in a map.
const schema = defineSchema({
  lists: { columns: { title: "text?" }, temporal: false },
  items: { parent: "lists", columns: { text: "text", done: { type: "boolean", default: false } }, temporal: false },
});
const list = defineDoc("list:", { root: "lists", include: ["items"], implied: true });

const db = new Database(":memory:");
createTables(db, schema);

// Delta in this process, no network. registerDocs(createWs(), ...) serves the same documents to browsers.
const delta = createLocal();
registerDocs(delta.server, db, schema, [list], [], { ledger: true });
delta.onPublish((doc, change) => console.log(doc, `v${change.v}`, JSON.stringify(change.ops)));

const ada = delta.as("ada");   // who is writing
const doc = "list:1";
await ada.call("open", { doc });
// "-" asks the server to name the new row; it names it 1. The cursor is what undo walks back.
await ada.call("delta", { doc, cursor: "tab-1", ops: [{ op: "add", path: "/items/-", value: { text: "milk" } }] });
await ada.call("delta", { doc, cursor: "tab-1", ops: [{ op: "replace", path: "/items/1/done", value: true }] });
await ada.call("undo", { cursor: "tab-1" });

console.log((await ada.call("open", { doc })).result.items);
```

Run `bun try.ts`:

```
list:1 v1 [{"op":"add","path":"/items/1","value":{"id":1,"lists_id":1,"text":"milk","done":false}}]
list:1 v2 [{"op":"replace","path":"/items/1","value":{"id":1,"lists_id":1,"text":"milk","done":true}}]
list:1 v3 [{"op":"replace","path":"/items/1","value":{"id":1,"lists_id":1,"text":"milk","done":false}}]
{
  "1": {
    id: 1,
    lists_id: 1,
    text: "milk",
    done: false,
  },
}
```

Three writes, each heard as a change with its version. The server named the new row `1`: ids are
serial numbers on every table backend (the JSON file, SQLite, PGlite and Postgres); a free-form
document and a memory document name a new row with a uuid. The last change is the undo, which the ledger worked out for
itself. The document did not exist until its first write made it (`implied: true`).

## Where the truth lives

Each kind of document registers on the same server, and the browser opens every one of them the
same way.

| The truth is | Register it with | From |
|---|---|---|
| a JSON file | `registerDocs(ws, file, schema, docs)` | `@blueshed/delta/json` |
| a SQLite database | `registerDocs(ws, db, schema, docs)` | `@blueshed/delta/sqlite` |
| Postgres in this process | `openPglite(dir?)`, then as a Postgres database | `@blueshed/delta/pglite` |
| a Postgres database, shared by processes | `createDocListener(ws, pool)` and `registerDocType(docTypeFromDef(def, pool))` | `@blueshed/delta/postgres` |
| a free-form document (no schema, one JSON value in a file) | `await registerDoc(ws, name, { file, empty })` | `@blueshed/delta/server` |
| this process (who is online) | `registerMemory(ws, { prefix, empty })` | `@blueshed/delta/kinds` |
| outside (a sensor, an API) | `registerSource(ws, { prefix, read, every })` | `@blueshed/delta/kinds` |
| the release (countries, units) | `registerStatic(ws, { prefix, value })` | `@blueshed/delta/kinds` |

Start with a JSON file; move to SQLite, then Postgres in this process, then a Postgres server,
without changing the app: the same schema, the same documents, the same writes, and the same
answers from each -- serial ids, a write told to every open document that holds the rows it
changed, one scope rule. Carry the data with `exportTables` from where it is and
`importTables` into where it goes; ids and sequences carry, so the next row named follows on.
The ledger does not carry: undo history starts fresh on the next backend. A free-form document
is not on this path: it has no schema and no `exportTables`.

## Undo comes with the ledger

Pass `{ ledger: true }` to the JSON file, SQLite or Postgres and every write is recorded in the
write's own transaction: what it did, its inverse, the document's version, who made it and the cursor undo
walks. `undo`, `redo` and `history` then work with no more code. Over a socket the cursor is
the connection, so a browser undoes only what it wrote:

```ts
const ws = connectWs("/ws");
await ws.send({ action: "undo" });   // or "redo"; answers null when there is nothing to walk
await ws.send({ action: "undo", change: 7 });   // one change of this cursor's, by its entry, not its last
```

On Postgres the ledger is in the database, so a write made in one process can be undone from
another.

## In the browser, or in the same process

Served over a socket with `createWs()`, a browser opens a document as a reactive value (the
client needs `@blueshed/railroad`: `bun add @blueshed/railroad`):

```ts
import { connectWs, openDoc } from "@blueshed/delta/client";

const doc = openDoc("list:1", connectWs("/ws"));
await doc.ready;
doc.onOps((ops) => render(ops));   // every change, including your own
await doc.send([{ op: "replace", path: "/items/1/done", value: true }]);
```

In a clone of this repository (`examples/` is not in the npm package),
`bun examples/shared-state/server.ts` runs a chat in two browser tabs on a free-form document,
with no database and no schema.

Run in the same process with `createLocal()`, as in the example above, a server that renders
its own pages, a job or a test speaks to delta by function call. `as(identity)` says who is
writing, and `onPublish` is the one stream of changes to redraw from.

## Pairs with

- [`@blueshed/railroad`](https://www.npmjs.com/package/@blueshed/railroad) draws in the browser.
  `doc.data` is a railroad signal, so its `list()` renders a collection row by row.
- delta keeps the documents.

Starting a new app? `bun create blueshed my-app` makes a Bun site from
[paintbrush](https://github.com/blueshed/paintbrush), with railroad for the page; its `evolve`
skill turns a resource into a delta document when several people edit it at once.

## Optional peers

`bun add @blueshed/delta` installs none of these; add the ones the parts you use need.

| You use | Also add |
|---|---|
| `@blueshed/delta/client` (the browser) | `@blueshed/railroad` |
| `@blueshed/delta/postgres` | `pg` (and `@types/pg` to type-check: delta ships TypeScript source) |
| `@blueshed/delta/pglite` | `@electric-sql/pglite` (and `@types/pg` to type-check) |
| `@blueshed/delta/auth-jwt` | `jose` and `pg` |

The core, `server` (with the free-form document), `json`, `sqlite`, `local`, `kinds`,
`dom-ops` and `logger` need nothing else.

## Where to go next

- The `delta-doc` skill is the manual: [`SKILL.md`](.claude/skills/delta-doc/SKILL.md) routes,
  [`reference.md`](.claude/skills/delta-doc/reference.md) has the API, patterns, auth, row-level
  security, the ledger, the kinds and the wire protocol. `bunx @blueshed/delta install-skills` copies it
  into your project for Claude Code.
- [`examples/`](examples/): `shared-state` (a free-form document), `sites-bbox` (custom views on SQLite
  and Postgres), `kanban` (Postgres with railroad), `todos-vs-rls` (row-level security).
- [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

MIT licence.
