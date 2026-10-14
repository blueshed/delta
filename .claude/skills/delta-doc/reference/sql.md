# The stored functions, and calling them from SQL

From `bench/adapters/delta-new.ts`: a write as a person, in one round trip.

```ts
await pool.query("SELECT delta_apply_as($1, $2, $3) AS result",
  [String(userId), "items:", JSON.stringify([{ op: "replace", path: `/items/${id}/value`, value: 2 }])]);
```

The same from your own `plpgsql`, so a stored write still broadcasts:

```sql
CREATE FUNCTION accept_thing(p_user_id text, p_id bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN delta_apply_as(p_user_id, 'invite:' || p_id,
    jsonb_build_array(jsonb_build_object('op','replace','path','/status','value','"accepted"')));
END $$;
```

The functions are in `src/sql/001a–001g-*.sql`, applied in order (`postgres.md`), each
`SECURITY INVOKER`. Read them there; the ones you call:

- `delta_open(doc)`, `delta_open_at(doc, timestamptz)`: a document now, or as it stood.
- `delta_apply(doc, ops)`: apply, log to `_delta_ops_log`, NOTIFY.
- `delta_fetch_ops(doc, since_version)`: the log after a version.
- `delta_open_as` / `delta_open_at_as` / `delta_apply_as(user_id, …)`: the same with
  `app.user_id` set for that statement. `docTypeFromDef({ auth })` uses them; no opt-in.
- Ledger (`001g`): `delta_apply_logged`, `delta_walk`, `delta_undo`, `delta_redo`,
  `delta_history`, and their `_as` forms (`ledger.md`).
- `delta_snapshot(name, at)` / `delta_resolve_snapshot(name)`: pin a time to a label.
- `delta_prune_ops(interval)` (`pruneOpsLog(pool)`): trims the log and forgets names nobody holds.

## Rules

- **Read as the caller**: `delta_open_as`, never a bare `delta_open` or `SELECT` on an RLS
  table. Unbound, `app.user_id` is `''`: rows scope to nothing, and a `::bigint` cast throws.
  Bind for what the function reads, not only where `:user_id` appears.
- **Write through `delta_apply` / `delta_apply_as`**, never `INSERT` / `UPDATE` on a delta
  table: only that path versions, logs and NOTIFYs, so subscribers stay live.
- **`SECURITY DEFINER` bypasses RLS.** Delta is persistence and broadcast, not authorization:
  such a function checks its own preconditions (through `_`-prefixed guard helpers, never
  callable from the wire), and its named adds are judged as the session's role (`paths.md`).
- Never edit `001*`, nor `_delta_collections` / `_delta_docs` by hand: `generateSql` fills them.
- Tables need `seq_<table>` sequences: `generateSql` makes them; do not hand-write tables.
- A framework older than the listener (no `_delta_fetch_log`) still works, with a warning:
  re-apply it (`applyFramework` or `init --upgrade`).
