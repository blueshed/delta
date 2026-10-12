# @blueshed/delta

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

Delta runs on [Bun](https://bun.sh) and ships TypeScript source.

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
list:1 v2 [{"op":"replace","path":"/items/1/done","value":true}]
list:1 v3 [{"op":"replace","path":"/items/1/done","value":false}]
{
  "1": {
    id: 1,
    lists_id: 1,
    text: "milk",
    done: false,
  },
}
```

Three writes, each heard as a change with its version: a row that arrives whole, a field that
changes by itself, and the undo, which the ledger worked out for itself. The server named the new
row `1`. The document did not exist until its first write made it (`implied: true`).

In a browser, `openDoc("list:1", connectWs("/ws"))` holds the same document as a live value
(`bun add @blueshed/railroad`: the client is drawn with it). The skill's
[recipe](.claude/skills/delta-doc/SKILL.md#the-recipe) is a chat room in a browser, kept in a JSON
file, in four short files.

## When you grow

Each of these is a section of the skill's [reference](.claude/skills/delta-doc/reference.md):

- **SQLite, then Postgres** -- carry the rows with `exportTables` / `importTables`; the app stays
  as it is: [*Backends side by side*](.claude/skills/delta-doc/reference.md#backends-side-by-side).
- **Postgres** in this process (`openPglite`) or a server (`createDocListener`, `bun add pg`):
  [*Quick start (Postgres backend)*](.claude/skills/delta-doc/reference.md#quick-start-postgres-backend).
- **People see only their own** -- row-level security, `owns` for who may open a document, and
  `jwtAuth` to sign in (`bun add jose pg`): [*RLS*](.claude/skills/delta-doc/reference.md#rls-with-appuser_id).
- **Custom documents** -- a view joined or worked out per person (`defineCustomDoc`):
  [*Custom read docs*](.claude/skills/delta-doc/reference.md#custom-read-docs--definecustomdoc).
- **The kinds** -- who is online (memory), a sensor or an API (source), static data:
  [*Document kinds*](.claude/skills/delta-doc/reference.md#document-kinds--memory-source-static).
- **The CLI** -- `bunx @blueshed/delta` opens, watches and writes documents from a terminal:
  [*CLI*](.claude/skills/delta-doc/reference.md#cli).
- **Your own tests** -- `@blueshed/delta/testing` (`mockClient`, `sendAndAwait`, `waitFor`):
  [*Testing*](.claude/skills/delta-doc/reference.md#testing).

`bunx @blueshed/delta install-skills` copies the skill into your project for Claude Code. In a
clone of this repository, [`examples/`](examples/) has a chat, a kanban board on Postgres and
row-level security side by side. [CHANGELOG.md](CHANGELOG.md) says what changed in each release.

MIT licence.
