# examples/todos-vs-rls

A side-by-side model of two ways to build the same feature — a per-user +
per-team todo list — hitting the same Postgres, the same RLS policy, as the
same NOSUPERUSER role (so the policy really holds).

- **`raw-rls.ts`** — plain Pool + explicit queries. RLS is the whole auth story.
- **`delta.ts`** — delta's own parts on the same table: two `defineDoc` lenses
  through `docTypeFromDef` with `owns`, and one custom read doc. Nothing on the
  delta side touches the table by hand.

The point is not "RLS is bad". The RLS policy in [rls.sql](rls.sql) is the
authoritative gate in both approaches, and you want it there. The point is
that **RLS handles visibility and only visibility** — everything else (shape,
write-time injection, dispatch on a doc name, who may hear a name) lives
outside the policy. Delta is that "everything else" layer.

## Run

```
bun run db:up
bun run examples/todos-vs-rls/run.ts
bun run db:down
```

The run drops and re-seeds its tables (`example_*`) each invocation, and
makes the `example_app` role the first time, so it doesn't leak into other
work on the dev DB. Delta runs in the process (`createLocal()`), so the run
calls `open` and `delta` as each person, `local.as(ALICE)`, with no socket.

## What the three sections show

### 1. Reshape

Task: *"list my todos, with open/done counts for a header badge."*

**raw-rls** — two queries, the client merges them. Counts don't come from
RLS — RLS just filters.

**delta** — `todos-summary:1`, a custom read doc (`defineCustomDoc` with
`recompute`) that reads `{ todos, counts }` in one statement, as Alice
(`withAppAuth`), so the policy scopes it. One open, one composed object, and it
is recomputed when a watched collection is written.

### 2. Inject

Task: *"add a todo."*

**raw-rls** — the client supplies `owner_id` and `team_id`. RLS `WITH CHECK`
rejects a row whose `owner_id` isn't the caller, but the client still has to
*know* to send its own id. And the INSERT goes behind delta's back: nothing is
versioned or broadcast, so the run's listener hears nothing.

**delta** — the client sends `{ text, team_id }` through `todos-mine:1`:

```ts
await local.as(ALICE).call("delta", { doc: "todos-mine:1", ops: [
  { op: "add", path: "/todos/-", value: { text: "…", team_id: 1 } },
] });
```

`todos-mine:` is scoped by `owner_id: ":id"`, so an add through it takes
`owner_id` from the name, never the value, and `owns` says `todos-mine:1` is
Alice's alone. A value that forges `owner_id: BOB.id` is overwritten. The
write goes through `delta_apply_as`: it is versioned, logged and heard on
`todos-mine:1`'s channel.

### 3. Dispatch

Task: *"show me team 1's todos"* vs *"show me my todos"*.

**raw-rls** needs a function per lens, each with its own WHERE clause.

**delta** gives each lens a name and a `defineDoc` line, each with who owns it:

```
todos-mine:<id>   scope owner_id = <id>   owns: the name is the identity's own
todos-team:<id>   scope team_id  = <id>   owns: the identity is on the team
```

A name is the channel its writes are broadcast on, and RLS filters what an
open reads, not what the channel carries. So `owns` answers first: Carol
opening `todos-team:1`, or Bob opening `todos-mine:1`, is a 404 before
anything is read. Delta refuses to start with `auth` until every document
says who owns it (or `shared: true`).

## Sample output (abridged)

```
── 2. INJECT: add a todo (client sends no owner) ───────────────────────────
  raw.addTodo(Alice, {owner_id, team_id, text}) →  { "id": "7" }
    ...and no one is told: delta heard 0 changes.
  heard on todos-mine:1 (versioned, logged, NOTIFY'd) →
    { "doc": "todos-mine:1", "ops": [ { "op": "add", "path": "/todos/8",
        "value": { "id": 8, "done": false, "text": "delta: write the blog post",
                   "team_id": 1, "owner_id": 1 } } ] }
  rows named 'delta: forged' →  [ { "id": "9", "text": "delta: forged", "owner_id": "1" } ]

── 3. DISPATCH: two lenses, and who may open each ──────────────────────────
  Alice todos-mine:1  →  "6 todos"
  Alice todos-team:1  →  "8 todos"
  Bob   todos-team:1  →  "8 todos"
  Carol todos-team:1  →  "404 Not found"
  Bob   todos-mine:1  →  "404 Not found"
```

## What this doesn't cover

- The WebSocket transport. In a server, the same registrations go on
  `createWs()` in place of `createLocal()`, with an auth module that reads a
  token (`jwtAuth`, see the skill's *Authentication*).
- The ledger (`ledger: true` on the listener) and undo.
