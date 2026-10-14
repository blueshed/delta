# Documents not kept in tables: memory, source, static, free-form

From `tests/kinds.test.ts`: who is here, live, written by the server.

```ts
const here = registerMemory(local.server, { prefix: "here:", empty: () => ({ people: {} }) });
await local.call("open", { doc: "here:general" });   // → { people: {}, _v: 0 }
await local.call("delta", { doc: "here:general", ops: [{ op: "add", path: "/people/p1", value: "Ada" }] });
// told { doc: "here:general", ops: [...], v: 1 }
here.peek("here:general");                            // { people: { p1: "Ada" } }; forget(name) empties it
```

Options and handles: `MemoryOptions`, `SourceOptions`, `StaticOptions`, `Sourced` in
`src/server/kinds.ts` (`@blueshed/delta/kinds`); `DocOptions` in `src/server/server.ts` for the
free-form document. Each registers a prefix on any `WsServer` and the browser opens it like any
document. Register them **before** `createDocListener` (it answers 404 for names it does not own).

## Memory: the truth is this process

Who is online, cursors, a lobby. Gone on restart, never on a ledger.

- Written by a caller in this process; over a socket a `delta` is 403 unless `writable: "any"`.
- An op that does not land changes nothing: 404 for what is not there, 400 malformed.
- `add /<coll>/-` on a map of rows names the row with a uuid (path and `id`); on an array, appends.
- Open answers `{ ...value, _v }`; a write `{ ack, version, ops }`, broadcast with `v`.

## Source: the truth is outside

```ts
const reactor = registerSource(ws, { prefix: "reactor:", read: async (id) => readSensor(id),
  every: 5_000, stale: 30_000 });   // or subscribe: (id, push) => stop
// open "reactor:core" → { reading, at, stale, _v };  reactor.stopAll() on shutdown
```

- One reading shared by every watcher: read on the first open, polled or pushed while anyone
  watches, stopped when the last leaves.
- `stale` turns true when no reading comes within `stale` ms, so a page can say so. A failed
  read gives no reading (a first one opens `{ reading: null, at: null, stale: true }`).
- A reading equal to the last only moves `at`. Every write is 403.

## Static: the truth is the release

`registerStatic(ws, { prefix: "units:", value: (id) => UNITS[id] })`: undefined is 404. The
value must be an object; open answers it spread with `_v: 1`. Every write is 403.

## Free-form: one JSON value in a file

`await registerDoc(ws, "notes", { file, empty: { lines: {} } })` (`@blueshed/delta/server`): a
single typed document with no schema (settings, a scratchpad).

- Not on the moving-on path: no schema, no `exportTables`, uuid ids for `add /<coll>/-`.
- Saved whole or not at all (a temp file beside it, renamed); a file there but not JSON is
  refused at start, naming it.
- Broadcasts carry no `v`; `inverse: true` answers `{ ack, ops }`.
