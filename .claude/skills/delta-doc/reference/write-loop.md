# The write loop: send, and let the echo render

From the recipe's `client.ts` (`recipe.md`):

```ts
// WRONG: the op echoes back and the message shows twice
log.append(renderMessage(m));
await doc.send([{ op: "add", path: "/messages/-", value: m }]);

// RIGHT: send only; onOps / doc.data render it when it echoes back
await doc.send([{ op: "add", path: "/messages/-", value: m }]);
```

`doc.send(ops)` does not change your view. The server applies the ops and broadcasts them to
every holder, the sender included. `Doc` in `src/client/client.ts` is the contract.

## What the client does with a broadcast

1. Calls every `doc.onOps` handler (DOM patchers run here).
2. Applies the ops to `doc.data` in place and bumps `dataVersion`, in one railroad `batch()`.

`await doc.send(ops)` resolves once its own echo is applied, on every backend (an answer that
comes first waits for the version it names). It rejects with a
`DeltaError` (`DeltaError.isDeltaError(err)`, `err.code`: `paths.md`).

## Never reload

The framework does the only two full reads itself:

- **Open**: full state into `doc.data`; render once after `doc.ready`.
- **Reconnect**: every socket open re-opens every document, resets `doc.data`, and hands
  `onOps` a whole-document `replace ""`, which `applyOpsToCollection` reconciles. An outage heals
  itself on both render paths.

So none of these needs a reload: after a write (it echoes), after a reconnect (automatic), on
tab focus (the socket stayed subscribed), "might be out of sync" (versions catch gaps),
"to be safe" (`doc.data` is the latest). A second `openDoc`, a `fetch` of the document, or a
rebuild from `doc.data` is a category error.

## Versions: `v` and `_v`

- A change arrives as `{ doc, ops, v }`, `v` the document's version after it. An open answers
  with `_v`, the snapshot's version (the client strips it from `doc.data`).
- The client applies the next `v`, ignores one it has, and **re-opens on a gap** or on a
  broadcast that does not apply to its copy (a remove of a row it lacks).
- Versioned: SQLite and the JSON file with a ledger; memory and source kinds.
  Without `v` (the free-form document, no ledger, custom docs) broadcasts apply as they come.

## Gotchas

- `doc.data` is a `ReadonlySignal`: there is no `set` to update optimistically.
- Need instant feedback? Give **transient** feedback that is not the data (disable the button,
  dim the row, a spinner) and let the broadcast update the collection. Never fork a local copy.
- Code reading broadcasts itself applies them with `applyOps`; a replace may be one field.
- After rolling back your own transaction around a write, subscribers have heard a change that
  did not happen: `local.md`.
