# todos-vs-rls

Alice needs her todos in front of her, with how many are open and done; her team needs the
team's. Those are the documents: `todos-mine:<id>`, `todos-team:<id>` and `todos-summary:<id>`,
over one Postgres table that a row-level security policy guards ([rls.sql](rls.sql)): you see a
todo if it is yours or your team's, and you may only write your own.

The example builds the same thing twice, on the same table and policy, both as `example_app`, a
role with no superuser and no BYPASSRLS, so the policy really holds:

- **`raw-rls.ts`**: a pool and plain queries. The policy is the whole story.
- **`delta.ts`**: the three documents, from delta's own parts: two `defineDoc` lenses with who
  `owns` each name, and a custom document for the summary.

They give the same answers. What delta adds is everything the policy cannot say:

1. **Shape.** "My todos with counts" is two queries and a merge on the raw side; on delta's it
   is one open of `todos-summary:1`, read as Alice, so the policy still scopes it.
2. **The owner.** A raw INSERT must send its own `owner_id` (the policy only rejects a wrong
   one), and changes the table behind everyone's back: no one holding the todos is told. An
   `add /todos/-` through `todos-mine:1` takes `owner_id` from the name, whatever the value
   says, and everyone holding `todos-mine:1` is told.
3. **Who may open a name.** A name is the channel its changes are told on, and the policy
   filters rows, not channels. So `owns` answers first: Bob opening `todos-mine:1`, or Carol
   (not on team 1) opening `todos-team:1`, is a 404 before anything is read.

## Run

```sh
bun run db:up
bun run examples/todos-vs-rls/run.ts
```

Each run drops and re-seeds its `example_*` tables, and makes the `example_app` role the first
time. Delta runs in the process (`createLocal()`), so the run opens and writes as each person
with `local.as(ALICE)`, with no socket; a server puts the same registrations on `createWs()`
with an auth module that reads a token (`jwtAuth`).

`tests/postgres-examples.test.ts` checks that both sides answer the same, for each person and
each lens, as `example_app`.
