# Row-level security with `app.user_id`

From `examples/todos-vs-rls/rls.sql`: you see a todo you own or your team's; you write only your own.

```sql
ALTER TABLE example_todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE example_todos FORCE  ROW LEVEL SECURITY;

CREATE POLICY example_todos_visibility ON example_todos
  FOR ALL
  USING (
    owner_id = NULLIF(current_setting('app.user_id', true), '')::int
    OR team_id IN (SELECT team_id FROM example_team_members
                   WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::int)
  )
  WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::int);

GRANT USAGE ON SCHEMA public TO example_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO example_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO example_app;
```

With `auth.asSqlArg` set, every `docTypeFromDef({ auth, owns })` query runs as the identity:
the `*_as` stored functions set `app.user_id` with `set_config(…, true)` in the same statement
(one round trip). `withAppAuth(pool, id, fn)` does the same for your own queries
(`BEGIN`, `set_config`, `fn`, `COMMIT`). `NULLIF(…, '')` keeps an unbound session from
throwing on the cast.

## Two pools

**Superusers bypass RLS, even with `FORCE`** (the default `postgres` role; the repo's compose
`delta` role too). So:

- an **admin pool** for schema and `jwtAuth` (login and register write `users` unscoped);
- an **app pool**, a role without `BYPASSRLS`, for every document:
  `createDocListener(ws, appPool, { types: [docTypeFromDef(def, appPool, { auth, owns })], auth })`.

An implied document's root is made inside `delta_apply`, under the writer's `app.user_id`, so
`WITH CHECK` sees it. A temporal table's `current_<table>` view is `security_invoker` (Postgres 15+), so the policy
holds through it.

## Gotchas

- **RLS filters reads, not the channel.** The listener reads the change log with no identity;
  one name several identities open hands each every row written through it. One name per
  owner, checked by `owns` (`ownership.md`). `tests/postgres-rls.test.ts` pins it as a
  `NOSUPERUSER` role.
- **No bare `pool.query` with auth on**: go through `docTypeFromDef({ auth, owns })`, or
  `withAppAuth` / `*_as`, so `app.user_id` is bound.
- `SET LOCAL` cannot bind parameters: use `set_config(name, value, true)`.
- **Who is told does not depend on what the writer may read**: `_delta_holders` is
  `SECURITY DEFINER`, so Bob's card on Alice's list reaches Alice's board. It answers names,
  never rows. It sees past RLS only where the role that applied the framework does.
- **Errors name names, not values.** A bad prefix, root or scope key comes back as a 500 naming
  it, which helps debugging but lets a tenant probe prefixes and columns. Do not put
  tenant-sensitive identifiers in prefixes (`boards:42`, not `tenant-42:`); on a public server
  with sensitive column names, scrub the 500 branch in `createDocListener`.
