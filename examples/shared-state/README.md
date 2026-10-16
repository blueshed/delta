# shared-state

A document is what you need in front of you to take an action. To chat you need the room in front
of you: one document, `room:1`, the room and its messages, kept in a JSON file.

A document is never a poster on the wall. It's a conversation. Open it in two tabs and you're
subscribed in both: a message typed in one reaches the other as it is sent, with nothing to poll,
fetch or refresh, and the file keeps it for whoever opens the room next.

This is the delta-doc skill's recipe (`reference/recipe.md`), with a little more page.

## Run

```sh
bun examples/shared-state/server.ts                # default port 3100
PORT=3199 bun examples/shared-state/server.ts      # override if 3100 is busy
```

Open <http://localhost:3100> in two browser tabs. Type in one; see it appear in the other. The
room is kept in `examples/shared-state/chat-room.json`; restart the server, refresh the page, the
messages are still there.

## The files

- `types.ts`: the tables (`defineSchema`: rooms, and messages under them) and the document
  (`defineDoc`: a room and its messages).
- `server.ts`: one `registerDocs` on the JSON file, one `Bun.serve`.
- `client.ts`: connect, open, first paint, `onOps`, send.
- `index.html`: markup and a little CSS.

```ts
// server
registerDocs(ws, "./examples/shared-state/chat-room.json", schema, [room]);

// client
const doc = openDoc<Room>("room:1", ws);
await doc.send([{ op: "add", path: "/messages/-", value: {...} }]);   // the server names it: /messages/1
doc.onOps((ops) => /* patch the DOM with applyOpsToCollection */);
```

## Where it grows

**What grows is where they're kept.** A shared JSON document does a lot on its own. SQLite earns
its place when documents share the same rows, as the catalogue and every order do, or when you
want undo and history. Postgres comes in when servers share the data, or people should see only
their own: that step is dzql (compiled Postgres). The page and its documents stay the same as
the storage grows: here, moving to SQLite changes `server.ts`'s one `registerDocs` line
(`@blueshed/delta/sqlite`, on a database after `createTables`), and `types.ts`, `client.ts` and
the page stay as they are.

[../sites-bbox/](../sites-bbox/) shows two documents over the same rows, on SQLite;
[../kanban/](../kanban/) a board on SQLite.
