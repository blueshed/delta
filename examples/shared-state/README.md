# shared-state — the canonical recipe

This is what **"use delta-doc for shared state"** produces.

A live multi-user chat. One server, one JSON file on disk, two browser tabs.
No database, no schema, no codegen, no fetch calls in the client. Every
keystroke from one tab is mirrored in the other within a network round trip.

## Run

```sh
bun examples/shared-state/server.ts                # default port 3100
PORT=3199 bun examples/shared-state/server.ts      # override if 3100 is busy
```

Open <http://localhost:3100> in two browser tabs. Type in one — see it appear
in the other. The conversation is persisted to `chat-room.json`; restart the
server, refresh the page, the history is still there.

## What it costs

- `server.ts` — 27 lines.
- `client.ts` — 47 lines.
- `index.html` — markup + a little CSS.

That's the whole sync layer. No backend SDK, no live-query subscription
config, no auth-token passing. The doc lives in one file and three primitives:

```ts
// server
registerDoc(ws, "chat:room", { file: "./chat-room.json", empty: { messages: {} } });

// client
const doc = openDoc("chat:room", ws);
await doc.send([{ op: "add", path: "/messages/<id>", value: {...} }]);
doc.onOps((ops) => /* patch DOM with applyOpsToCollection */);
```

That's it. Read the two files end-to-end — they fit on one screen.

## When to grow up

Three backends, same client code, same op vocabulary. Move to the next tier
only when you outgrow the one you're on:

| When you need… | Switch to | Server-side change |
|---|---|---|
| relational queries, many docs, history | **SQLite** | `registerDocs(ws, db, schema, docs)` from `@blueshed/delta/sqlite` |
| multi-process fan-out, RLS, stored auth | **Postgres** | `createDocListener(ws, pool)` + `registerDocType(...)` |

The client never changes. Same `openDoc`. Same op verbs. Same protocol on the
wire. Whatever browser code you wrote against this example keeps working.

See `examples/sites-bbox/` for SQLite + Postgres with a custom doc predicate.
See `examples/kanban/` for the full Postgres path with stored functions.
