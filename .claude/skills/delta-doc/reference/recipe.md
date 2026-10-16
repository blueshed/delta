# The recipe: a chat room in a JSON file

`bun add @blueshed/delta @blueshed/railroad` (the client needs railroad), then these four files.
No database to run, no fetch, no codegen. `tests/recipe.test.ts` runs them as written, so keep
the headings and blocks exact.

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

// ONE render path: first paint, live ops and the reconnect's whole-doc replace.
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

// Send only: the op echoes back through onOps and renders itself.
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

