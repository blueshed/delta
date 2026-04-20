# examples/todos-vs-rls

A side-by-side model of two ways to build the same feature — a per-user +
per-team todo list — hitting the same Postgres, the same RLS policy.

- **`raw-rls.ts`** — plain Pool + explicit queries. RLS is the whole auth story.
- **`delta.ts`** — one custom `DocType` layered on top of the same RLS.

The point is not "RLS is bad". The RLS policy in [schema.sql](schema.sql) is the
authoritative gate in both approaches, and you want it there. The point is
that **RLS handles visibility and only visibility** — everything else (shape,
write-time injection, dispatch on a logical doc-name) lives outside the
policy. The delta `DocType` is that "everything else" layer.

## Run

```
bun run db:up
bun run examples/todos-vs-rls/run.ts
bun run db:down
```

The run drops and re-seeds its tables (`example_*`) each invocation, so it
doesn't leak into other work on the dev DB.

## What the three sections show

### 1. Reshape

Task: *"list my todos, with open/done counts for a header badge."*

**raw-rls** — two queries, client merges:

```json
{
  "todos":  [ { "id": "1", "text": "wire up the bench", "done": true }, … ],
  "counts": { "open": 1, "done": 2 }
}
```

Counts don't come from RLS — RLS just filters. The second aggregate query is
your app's job. Every view with a computed field is another round-trip.

**delta** — `openTodos("todos:me", Alice)`:

```json
{
  "scope":  "me",
  "todos":  { "1": { …full row… }, "2": { … }, "3": { … } },
  "counts": { "done": 2, "open": 1 }
}
```

One call, one composed object. The DocType's `open()` is free SQL — we
`WITH scoped AS (…)` then aggregate twice in the same statement.

### 2. Inject

Task: *"add a todo."*

**raw-rls** — client supplies `owner_id` and `team_id`:

```ts
await raw.addTodo(pool, Alice, {
  owner_id: Alice.id,   // client must send
  team_id:  1,
  text:     "…",
});
```

RLS `WITH CHECK` rejects rows whose `owner_id` isn't the caller — but the
client still has to *know* to send its own id. Miss it and you get an error,
not a corrected row. Pass someone else's id and you get rejected after the
round-trip.

**delta** — client sends only `text`:

```ts
await applyTodos(dt, "todos:team:1", [
  { op: "add", path: "/todos/-", value: { text: "…" } },
], Alice);
```

The DocType's `apply()` stamps `owner_id` from `identity`, `team_id` from
the doc-name, and lets Postgres stamp `created_at`. A client that tries to
forge `owner_id: BOB.id` in the value gets it silently overwritten:

```json
// row after the forgery attempt:
[{ "id": "9", "text": "delta: forged", "owner_id": 1 }]
//                                                  ↑ still Alice
```

RLS would have rejected the forgery too — but with delta the forgery never
reaches the DB. The authoritative policy is still in Postgres; the DocType
is a cheaper first line that keeps the DB honest to a known-good shape.

### 3. Dispatch

Task: *"show me team-1's todos"* vs *"show me my todos"* — same
underlying endpoint.

**raw-rls** needs two different call sites (`listMyTodos` vs
`listTeamTodos`, each with its own WHERE clause, its own set of parameters).
Each new lens is another function.

**delta** uses one doc prefix:

```
todos:me           → owner_id = identity.id
todos:team:1       → team_id  = 1
todos:team:2       → team_id  = 2  (RLS returns empty set if not a member)
```

`todosDocType.parse(name)` disambiguates; the same `open()` routes either
way. Adding a new lens (say `todos:mentions:<user>`) is a new `parse` branch
and a new `WHERE`, not a new function exported to the network.

---

## Sample output

```
── 1. RESHAPE: list my todos + counts ──────────────────────────────────────
    raw-rls needs two queries, client merges the result:
  raw.listMyTodosWithCounts(Alice) →
    { "todos": [ { "id": "1", "text": "wire up the bench", "done": true }, … ],
      "counts": { "open": 1, "done": 2 } }

    delta open() returns one composed object:
  openTodos('todos:me', Alice) →
    { "scope": "me",
      "todos":  { "1": { …full row… }, "2": { … }, "3": { … } },
      "counts": { "done": 2, "open": 1 } }

── 2. INJECT: add a todo (client sends only text) ──────────────────────────
    …
    forged owner_id is silently overwritten by the DocType — not trusted:
    [{ "id": "9", "text": "delta: forged", "owner_id": 1 }]

── 3. DISPATCH: one DocType, two lenses ────────────────────────────────────
    todos:me       → { "done": 2, "open": 4 }
    todos:team:1   → { "done": 2, "open": 6 }
```

## What this doesn't cover

- The WebSocket transport — both approaches are called directly against the
  pool here. In a real server you'd register `todosDocType(pool)` via
  `registerDocType` (see `reference.md` § Custom DocType) and the wire
  protocol from `src/server/server.ts` takes over.
- The 1-RTT hot path (`delta_apply_as`) from 0.3.0 — this example uses
  direct SQL inside a `withIdentity` transaction for clarity. The bench
  (`bench/results-0.3.0.md`) covers the RTT story separately.
- Delta's framework path (`delta_open` / `delta_apply` through
  `_delta_collections`). The ops-log + temporal + NOTIFY machinery is what
  you get if you also call `defineSchema` + `generateSql` for these tables;
  omitted here so the reader can see the DocType contract in isolation.
