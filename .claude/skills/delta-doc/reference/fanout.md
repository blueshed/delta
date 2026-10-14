# Fan-out: who is told what

From the README's *Try it* (run by `tests/readme.test.ts`): what `list:1` is told for an add, a
field written, and its undo.

```
list:1 v1 [{"op":"add","path":"/items/1","value":{"id":1,"lists_id":1,"text":"milk","done":false}}]
list:1 v2 [{"op":"replace","path":"/items/1/done","value":true}]
list:1 v3 [{"op":"replace","path":"/items/1/done","value":false}]
```

**A write is told to every open document that holds a row it changed**, on every backend: the
one written through and every other over the same rows. Each is told what changed **for it**,
judged on who held the row before and after the op:

- a row that **arrives** (added, or moved into scope): `add /<coll>/<id>`, the row whole;
- a row that **stays**: `replace /<coll>/<id>/<field>` for each field that changed, by name,
  whatever set it (the write, a default, a trigger). A field written as it was: nothing;
- a row that **leaves** (removed, moved to another parent, out of a list's condition):
  `remove /<coll>/<id>`;
- a root: `replace /<root>/<field>` while it stays, `replace /<root>` with the row when it
  arrives, `null` when it leaves (an implied document: its empty root).

## Gotchas

- **Never assume a replace carries a whole row.** Apply what you are told with `applyOps`
  (`src/core.ts`); `changedFields` there is the rule.
- Told ops apply in order to the holder's copy (RFC 6902): a parent and child added together
  arrive parent first; a cascade arrives with its remove (children by collection, rows by id,
  then `cascadeOn` rows); a row made and removed in one write is told both, never a remove alone.
- The writer's own document is told first, once, like every holder. Its **answer** (and ledger
  entry) is different: the ops as applied, whole rows, beside the inverse. The answer is the
  record; the broadcast is the telling.
- Each told document advances its own version `v` where the backend versions (`write-loop.md`).
- A custom membership doc hears each write once, row by row, tested against `matches`: an
  `add` of the row as its `query` reads it, a `replace` of each field it holds that changed, or a
  `remove` when the row no longer matches. A recompute doc is read again whole; read as null,
  its subscribers are let go with 404 (`custom-docs.md`).
- A hand-written Postgres `DocType` is told only its own writes (`custom-docs.md`).
- With `auth`, `owns` and the gate are asked again before each telling (`ownership.md`).

## Where it is worked out

- **Postgres**: in the database. `delta_apply` asks `_delta_holders` before and after and
  `_delta_tell` logs and NOTIFYs each name, over the names open now (`_delta_held`), so every
  process hears it. A write runs at READ COMMITTED: one inside a `REPEATABLE READ` or
  `SERIALIZABLE` transaction is refused (SQLSTATE `0A000`).
- **SQLite and the JSON file**: in the process, over every registration on the database handle.
  Another process is not told (`sqlite.md`).
- `tests/postgres-isolation.test.ts` and `tests/sqlite-isolation.test.ts` pin that nobody else is told.
