# The wire

What `doc.send` and `openDoc` say for you; you need it only for a script or a custom handler.
From `tests/local.test.ts`, the same messages in-process:

```ts
await local.call("open",  { doc: "room:a" });   // → { rooms: { id: "a", topic: null }, messages: {} }
await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
// → { ack: true }; told on "room:a": { doc: "room:a", ops: [{ op: "add", path: "/messages/m1",
//   value: { id: "m1", rooms_id: "a", text: "hi" } }] }
```

Every message is JSON, `{ id?, action, ...rest }`; the answer mirrors the `id` as
`{ id, result }` or `{ id, error: { code, message } }` (codes: `paths.md`).

## Client to server

- `open { doc }` → the document, with `_v` where the backend versions.
- `delta { doc, ops, cursor?, undoable?, inverse? }` → `{ ack: true, version? }`; with a ledger
  also `ops`, `inverse`, `entry`; asked (`inverse: true`), `ops` (and `inverse` on SQLite).
  `cursor` counts in-process only. On SQLite and the JSON file the document must be open in
  this process (404 `Doc not loaded`): a script opens before it writes.
- `undo` / `redo { cursor?, dry?, entry?, change? }` (ledger) → `{ doc, ops, inverse, version,
  entry }`, a conflict, or `null`.
- `history { doc, cursor?, limit? }` (ledger) → `[{ id, doc, version, ops, inverse, at, undoable, mine }]`.
- `open_at { doc, at }` → the document as it stood.
- `close { doc }` → `{ ack: true }`.
- `call { method, params }` → `{ result }`: `login`, `register`, `authenticate`, `logout`, yours.

## Server to client, unasked

- `{ doc, ops, v? }`: a change, `v` the version after it where the backend versions.
- `{ doc, error: { code, message } }`: this socket may no longer hear `doc` (with `auth`). 401:
  the gate refused, the client reconnects; 404: `owns` refused, the client re-opens and lets
  its copy go if refused again.

## Gotchas

- Messages from one socket run side by side, except around an identity change (`auth.md`);
  past `maxHeld` (1000) or `maxHeldBytes` (1 MiB) waiting, the socket closes with 1008.
- Ops are three verbs on JSON Pointers (`paths.md`); a write names a document and a path,
  never a function.
