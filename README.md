# @blueshed/delta

Delta keeps JSON documents and tells everyone who has one open when it changes. A change is a
list of ops with three verbs (`add`, `replace`, `remove`) on paths like `/items/milk/done`, and
one WebSocket carries opens, writes and changes to the browser.

It exists because shared, live state should be one small idea rather than a stack of fetch
calls, caches and sockets. The whole package is small enough to read in one sitting (and to
fit in an AI's context), there is one way to do each thing, and the browser code stays the same
wherever the truth is kept.

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
  items: { parent: "lists", columns: { text: "text", done: "boolean" }, temporal: false },
});
const list = defineDoc("list:", { root: "lists", include: ["items"], implied: true });

const db = new Database(":memory:");
createTables(db, schema);

// Delta in this process. registerDocs(createWs(), ...) serves the same documents to browsers.
const delta = createLocal();
registerDocs(delta.server, db, schema, [list], [], { ledger: true });
delta.onPublish((doc, change) => console.log(doc, `v${change.v}`, JSON.stringify(change.ops)));

const ada = delta.as("ada");
const doc = "list:groceries";
await ada.call("open", { doc });
await ada.call("delta", { doc, cursor: "tab-1", ops: [{ op: "add", path: "/items/milk", value: { text: "milk" } }] });
await ada.call("delta", { doc, cursor: "tab-1", ops: [{ op: "replace", path: "/items/milk/done", value: true }] });
await ada.call("undo", { cursor: "tab-1" });

console.log((await ada.call("open", { doc })).result.items);
```

Run `bun try.ts`:

```
list:groceries v1 [{"op":"add","path":"/items/milk","value":{"id":"milk","text":"milk","lists_id":"groceries","done":false}}]
list:groceries v2 [{"op":"replace","path":"/items/milk","value":{"id":"milk","text":"milk","lists_id":"groceries","done":true}}]
list:groceries v3 [{"op":"replace","path":"/items/milk","value":{"id":"milk","text":"milk","lists_id":"groceries","done":false}}]
{
  milk: {
    id: "milk",
    text: "milk",
    lists_id: "groceries",
    done: false,
  },
}
```

Three writes, each heard as a change with its version. The last one is the undo, which the
ledger worked out for itself. The document did not exist until its first write made it
(`implied: true`).

## Where the truth lives

Each kind of document registers on the same server, and the browser opens every one of them the
same way.

| The truth is | Register it with | From |
|---|---|---|
| a JSON file | `await registerDoc(ws, name, { file, empty })` | `@blueshed/delta/server` |
| a SQLite database | `registerDocs(ws, db, schema, docs)` | `@blueshed/delta/sqlite` |
| a Postgres database, shared by processes | `createDocListener(ws, pool)` and `registerDocType(docTypeFromDef(def, pool))` | `@blueshed/delta/postgres` |
| this process (who is online) | `registerMemory(ws, { prefix, empty })` | `@blueshed/delta/kinds` |
| outside (a sensor, an API) | `registerSource(ws, { prefix, read, every })` | `@blueshed/delta/kinds` |
| the release (countries, units) | `registerStatic(ws, { prefix, value })` | `@blueshed/delta/kinds` |

Start with a JSON file and move to a database when you need queries or more than one process.

## Undo comes with the ledger

Pass `{ ledger: true }` to the SQLite or Postgres backend and every write is recorded in the
write's own transaction: what it did, its inverse, the document's version, who made it and the cursor undo
walks. `undo`, `redo` and `history` then work with no more code. Over a socket the cursor is
the connection, so a browser undoes only what it wrote:

```ts
const ws = connectWs("/ws");
await ws.send({ action: "undo" });   // or "redo"; answers null when there is nothing to walk
```

On Postgres the ledger is in the database, so a write made in one process can be undone from
another.

## In the browser, or in the same process

Served over a socket with `createWs()`, a browser opens a document as a reactive value (the
client needs `@blueshed/railroad`: `bun add @blueshed/railroad`):

```ts
import { connectWs, openDoc } from "@blueshed/delta/client";

const doc = openDoc("list:groceries", connectWs("/ws"));
await doc.ready;
doc.onOps((ops) => render(ops));   // every change, including your own
await doc.send([{ op: "replace", path: "/items/milk/done", value: true }]);
```

In a clone of this repository (`examples/` is not in the npm package),
`bun examples/shared-state/server.ts` runs a chat in two browser tabs on a JSON file, with no
database and no schema.

Run in the same process with `createLocal()`, as in the example above, a server that renders
its own pages, a job or a test speaks to delta by function call. `as(identity)` says who is
writing, and `onPublish` is the one stream of changes to redraw from.

## Pairs with

- [`@blueshed/railroad`](https://www.npmjs.com/package/@blueshed/railroad) draws in the browser.
  `doc.data` is a railroad signal, so its `list()` renders a collection row by row.
- delta keeps the documents.
- eta, a private server-rendering kernel, builds on delta in-process through `createLocal()`.

Starting a new app? `bun create blueshed my-app` sets up delta and railroad together.

## Optional peers

`bun add @blueshed/delta` installs none of these; add the ones the parts you use need.

| You use | Also add |
|---|---|
| `@blueshed/delta/client` (the browser) | `@blueshed/railroad` |
| `@blueshed/delta/postgres` | `pg` |
| `@blueshed/delta/auth-jwt` | `jose` and `pg` |

The core, the JSON-file and SQLite backends, `local`, `kinds`, `dom-ops` and `logger` need
nothing else.

## Where to go next

- The `delta-doc` skill is the manual: [`SKILL.md`](.claude/skills/delta-doc/SKILL.md) routes,
  [`reference.md`](.claude/skills/delta-doc/reference.md) has the API, patterns, auth, row-level
  security, the ledger, the kinds and the wire protocol. `bunx delta install-skills` copies it
  into your project for Claude Code.
- [`examples/`](examples/): `shared-state` (JSON file), `sites-bbox` (custom views on SQLite
  and Postgres), `kanban` (Postgres with railroad), `todos-vs-rls` (row-level security).
- [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

MIT licence.
