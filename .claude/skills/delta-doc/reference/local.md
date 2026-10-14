# In-process: `createLocal()`

From the README's *Try it* (run by `tests/readme.test.ts`): delta with no socket, for a server
that renders its own pages, a CLI, a job or a test.

```ts
const db = new Database(":memory:");
createTables(db, schema);

const delta = createLocal();                          // @blueshed/delta/local
registerDocs(delta.server, db, schema, [list], [], { ledger: true });
delta.onPublish((doc, change) => console.log(doc, `v${change.v}`, JSON.stringify(change.ops)));

const ada = delta.as("ada");                          // who is writing
await ada.call("open", { doc: "list:1" });
await ada.call("delta", { doc: "list:1", cursor: "tab-1", ops: [{ op: "add", path: "/items/-", value: { text: "milk" } }] });
await ada.call("undo", { cursor: "tab-1" });
```

`Local` and `Caller` in `src/server/local.ts` are the contract. Any backend registers on
`local.server` as on `createWs()`: `registerDocs`, `createDocListener`, `registerDoc`, the kinds.

## Rules

- **`call(action, msg)` is async on every backend**: always `await`. It resolves with
  `{ result }` or `{ error: { code, message } }`, never rejects: an unknown action is 400
  `Unknown action`, a name nobody owns 404 `No handler matched`, a throw its error's code.
- **`as(identity)`** is a caller that is that identity (`client.data.identity`, for the gate and
  the ledger's `who`), one client per identity. `local.call` itself is anonymous.
- **The cursor is yours to name** (`cursor` on the message): in-process callers carry
  `data.local`, which a socket client cannot (`ledger.md`).
- **`onPublish(fn)`** hears every broadcast on every channel, the one stream of changes, and
  each view sent to one caller alone (a custom document's) with a third argument
  `to: { identity }`. It returns the unsubscribe. A listener that throws is logged; the others
  are still told. A rendering server can redraw from it without subscribing per document.
- **Every answer and broadcast is your own copy**, as over a socket: changing it changes nothing
  the backend serves. Keep what you open and apply what you are told to it.

## Your own SQLite transaction

The SQLite backend writes with `db.transaction(…).immediate()`, so inside your transaction its
write is a savepoint. But its cache, its broadcasts and its version numbers are outside your
transaction. After a `ROLLBACK`, subscribers have heard a change that did not happen, and with
a ledger the version number is reused, so a browser at that `v` drops the next real change.

```ts
db.exec("BEGIN");
await local.call("delta", { doc: "room:a", ops });
db.exec("ROLLBACK");
await local.call("close", { doc: "room:a" });   // and every other subscriber of room:a
await local.call("open", { doc: "room:a" });    // reads the tables: _v as it was
```

- `evict(docName)` alone is not enough: every subscriber must re-open (a browser does on reconnect).
- Better: keep writes that may roll back away from documents anyone is watching.
