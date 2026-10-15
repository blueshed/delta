# What a write may do

From `examples/kanban/client.tsx`: moving a card is writing its parent key, through the board
that holds both columns.

```ts
await doc.send([{ op: "replace", path: `/kanban_cards/${card.id}/kanban_columns_id`, value: next.id }]);
```

## A batch

- Ops land in the order sent and the batch applies whole or not at all.
- It is checked op by op: the first refused op answers (a 404 before a later 400, or the
  reverse), nothing lands, and serials taken before it are spent.
- A path that is not a JSON Pointer is 400 before any op. An op the schema refuses (unknown
  field, wrong type, a parent key that is not an id) is 400 before its row is looked up.
- A row removed earlier in the batch, or moved out of the document, is not there for a later op (404).
- Several replaces of one row in a row are one write of it: one temporal version.

## Moving a row

- Only under a parent the document holds: through `wedding:1`,
  `replace /households/7/weddings_id 2` is 404 and nobody is told. Move it through a document
  that holds both parents (a list).
- A single document holds no parent of its own root: move the root through a list.
- The parent must exist: adding or moving under a deleted parent, or an implied root not yet
  written, is 404 on every backend (an undo that would put a row back under one: a conflict).
- A parent key written as it already is, is no move.
- A row moved takes the rows under it along.

## Removing a row

- It takes, through `parent` and `cascadeOn`, every row under it and theirs in turn, whichever
  document it goes through. Every document that held them is told.
- A document removes only a row it holds. The answer and the ledger keep every cascaded
  remove, so undo puts them all back, parent first; redo takes them again, children first.

## Removing a single document's root

- `remove /venues/42` through `venue:42` takes the venue and the rows under it; the open copy is
  told `replace /venues` null and each row removed. Code rendering a single document must allow
  its root to be `null`.
- Then the document is 404 (an implied one opens empty again) and takes no writes until undo,
  except the root's own add back in the same write: `[remove /venues/42, add /venues/42 {…}]`.
- `/venues/<other id>` is 404 to remove, and 400 to add.
- `replace /venues/<field>`, `/venues/42` and `/venues/42/<field>` all write the root, told as
  `replace /venues…`.

## Gotchas

- A replace of a row is the whole row (`paths.md`); to change one field, replace the field.
- A list writes only inside its scope; a single root stays inside the rest of its scope (`scope.md`).
- Who hears the write: `fanout.md`.
