# shared-state

To chat you need the conversation in front of you. That is one document, `chat:room`, kept in a
JSON file. Open it in two tabs and you hold it in both: a message typed in one appears in the
other as it is sent, and the file keeps it for whoever opens the room next. No database, no
schema, no fetch.

## Run

```sh
bun examples/shared-state/server.ts                # default port 3100
PORT=3199 bun examples/shared-state/server.ts      # override if 3100 is busy
```

Open <http://localhost:3100> in two browser tabs. Type in one — see it appear
in the other. The conversation is kept in `examples/shared-state/chat-room.json`; restart the
server, refresh the page, the history is still there.

## What it costs

- `server.ts` — a few dozen lines: one `registerDoc`, one `Bun.serve`.
- `client.ts` — a few dozen lines: connect, open, initial paint, `onOps`, send.
- `index.html` — markup + a little CSS.

The document lives in one file and three calls:

```ts
// server
registerDoc(ws, "chat:room", { file: "./chat-room.json", empty: { messages: {} } });

// client
const doc = openDoc("chat:room", ws);
await doc.send([{ op: "add", path: "/messages/-", value: {...} }]);   // the server names it
doc.onOps((ops) => /* patch DOM with applyOpsToCollection */);
```

That's it. Read the two files end-to-end — they fit on one screen.

## Where it grows

A free-form document like this one does a lot on its own: no schema, any shape. When documents
come to share rows, give the rows a schema and keep them in a JSON file (`registerDocs` from
`@blueshed/delta/json`), or in SQLite when you want undo and history (`@blueshed/delta/sqlite`,
the same call), or in Postgres when servers share the data or people should see only their own.
The client opens and sends as it does here; the rows get serial ids.

[../sites-bbox/](../sites-bbox/) shows two documents over the same rows, on SQLite and Postgres;
[../kanban/](../kanban/) a board on Postgres; [../todos-vs-rls/](../todos-vs-rls/) people who
should see only their own.
