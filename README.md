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
their own: that step is [dzql](.claude/skills/delta-doc/reference/postgres.md), compiled Postgres.
The page and its documents stay the same as the storage grows.

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
[recipe](.claude/skills/delta-doc/reference/recipe.md) is a chat room in a browser, kept in a JSON
file, in four short files.

## When you grow

Each of these is a page of the skill's [reference](.claude/skills/delta-doc/reference/):

- **The JSON file, then SQLite** -- carry the rows with `exportTables` / `importTables`; the app
  stays as it is: [*Backends*](.claude/skills/delta-doc/reference/backends.md).
- **Then Postgres** -- the same definitions on [dzql](https://github.com/blueshed/dzql), compiled:
  [*Moving on to Postgres*](.claude/skills/delta-doc/reference/postgres.md).
- **Upgrades that keep the data** -- the tables are made by a history of migrations from empty;
  change the schema and `delta migrations make` writes the next one (`@blueshed/delta/migrations`):
  [*Migrations*](.claude/skills/delta-doc/reference/migrations.md).
- **Who may have a document** -- its `owns`, a path from its row to the person
  (`@blueshed/delta/paths`): [*Ownership*](.claude/skills/delta-doc/reference/ownership.md).
- **Signing in, with no passwords** -- a link is someone; tapping it signs them in
  (`@blueshed/delta/auth-link`): [*Signing in*](.claude/skills/delta-doc/reference/auth.md).
- **Custom documents** -- a view joined or worked out per person (`defineCustomDoc`):
  [*Custom documents*](.claude/skills/delta-doc/reference/custom-docs.md).
- **The kinds** -- who is online (memory), a sensor or an API (source), static data:
  [*Kinds*](.claude/skills/delta-doc/reference/kinds.md).
- **The CLI** -- `bunx @blueshed/delta` opens, watches and writes documents from a terminal:
  [*CLI*](.claude/skills/delta-doc/reference/cli.md).
- **Your own tests** -- `@blueshed/delta/testing` (`mockClient`, `sendAndAwait`, `waitFor`):
  [*Testing*](.claude/skills/delta-doc/reference/testing.md).

`bunx @blueshed/delta install-skills` copies the skill into your project for Claude Code. In a
clone of this repository, [`examples/`](examples/) has a chat, a kanban board, and the sites
inside a box on a map. [CHANGELOG.md](CHANGELOG.md) says what changed in each release.

## Why delta

Sync libraries are built for human developers: big API surfaces, many idioms, ecosystem
dependencies. Delta is shaped for AI-driven development: the whole system fits in one context
window, there is one way to do each thing, and the schema comes from one TypeScript source. If an
assistant reaches for Supabase or Firebase, that is a default trained from millions of projects;
delta is not harder than those, it is smaller, and it can be read in full before a line is
written. It grew from dzql, seiro, paintbrush's delta-sync and the clean venue manager
([CHANGELOG.md](CHANGELOG.md), 0.1.0).

MIT licence.
