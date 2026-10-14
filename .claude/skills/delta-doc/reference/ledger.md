# The ledger: undo, redo, history

From `tests/ledger.test.ts`'s shape: turn it on, write with a cursor, walk it back.

```ts
registerDocs(ws, db, schema, docs, customDocs, { ledger: true, who: (i) => String((i as { id: number }).id) });
// Postgres (needs 001g): createDocListener(ws, pool, { types, auth, ledger: true, who })

await local.call("delta", { doc: "room:a", ops, cursor: "s1" });   // in-process: name the cursor
await local.call("undo", { cursor: "s1" });     // → { doc, ops, inverse, version, entry } | conflict | null
await local.call("redo", { cursor: "s1" });
await local.call("history", { doc: "room:a" }); // → newest first, limit 50, each with `mine`
```

Message shapes: `wire.md`. Every write is recorded in its own transaction: ops, inverse,
version, **who** (for the audit) and the **cursor** (what undo walks). SQLite keeps
`delta_ledger`; Postgres `_delta_ledger`, shared by every process, so one process can undo
another's write and every process broadcasts it.

## The cursor

- In-process (`createLocal`, `data.local`): the caller names it, e.g. a session id.
- Over a socket: the connection's `clientId` (a `cursor` on the message is ignored); signed
  in, the person and the `clientId` together. **A browser undoes only its own writes.**
- `connectWs(url, { clientId })` keeps the cursor across reconnects. Without sign-in, anyone
  who learns a chosen id can walk it: treat it as a secret.

## The walk

- Undo walks the cursor's writes back, newest first, across documents; redo forward; a fresh
  write ends redo. Each walk is an ordinary write: validated, recorded, broadcast.
- **The guard**: a walk sets back only what its entry changed, where the document still holds
  what it left. A field written since by anyone is a **conflict**: nothing changes and the
  answer has `conflict: [paths]`. Do not force the old values with your own replaces.
- A conflicting walk is recorded as walked (an empty entry), so the next undo goes on to the
  one before. `null` means nothing to walk.
- Each row is walked once by its net change; a single root is one row whichever path named it.
  A made row someone edited or put rows under is not removed.
- Removed rows come back under their ids, a cascade parent first. An undo reaches a document
  nobody has open.
- `walkVectors` (`./testing`) is the guard as data; `planWalk` and `_delta_walk_plan` both answer it.

## Options on a walk

- `undoable: false` on a write: a **fact** (a price tick), recorded, never walked, ends no redo.
- `dry: true`: answers what the walk would do and walks nothing; then `entry: <id>` walks only if
  that is still the cursor's next (409 otherwise).
- `change: <entry>`: one change of the cursor's (two writers on one cursor each undo their
  own). Another cursor's, a fact, or none is 404; a non-whole id 400. A conflicting named walk
  records nothing.

## Gotchas

- Answers, `history` and dry runs show only what the document holds (its columns, its
  collections); the ledger keeps rows whole, so undo puts everything back.
- `history` goes to whoever may open the document; `mine` says whether the asker's cursor wrote
  it, never who did.
- With `auth`, undo and redo pass the gate and `owns` of the entry's document; Postgres uses `_as`.
- An empty write records nothing. The ledger does not carry to the next backend.
- **Without a ledger**, `inverse: true` on a `delta` answers `{ ack, ops, inverse }` on SQLite
  (`inverseOf` in `./sqlite`); on Postgres and the free-form document, the ops as applied only.
  A row made and removed in one write has no inverse.
