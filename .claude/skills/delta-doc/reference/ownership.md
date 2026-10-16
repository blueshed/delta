# Who may have a document: `owns` and `shared`

From `src/cases/owns.ts`, as `tests/owns-sqlite.test.ts` registers it: a document is its
owner's when its name ends in their id, so `fo-board:1` is ada's.

```ts
const ownsByName = (me: Me, docName: string) => docName.endsWith(`:${me.id}`);
registerDocs(local.server, db, pathSchema, pathDocs, custom, { ledger: true, auth, owns: ownsByName });
```

```ts
// client: each person opens their own name; another's is a 404
const me = (await call<User>("authenticate", { token })).id;
const mine = openDoc(`fo-board:${me}`);
```

**A document's name is the channel its writes are broadcast on.** Whoever has it open hears
every write through it. So the name, checked by `owns`, is what keeps one person's rows off
another's socket: one name per owner. A document scoped by its owner (`scope: { owner_id: ":id" }`)
gives an add through it `owner_id` from the name, so nobody can forge a row for someone else
(`scope.md`).

## `owns` as a path

A document can say who may have it as a path from its row to the person, in its definition (from
`src/cases/permissions.ts`, which SQLite, the JSON file and dzql all answer):

```ts
defineDoc("post:", { root: "posts", include: [], owns: "@author_id" });
defineDoc("venue:", { root: "venues", include: [], owns: "@org_id->members[org_id=$]{active}.person_id" });
defineDoc("venues-of:", { root: "venues", include: [], scope: { org_id: ":org" }, owns: "members[org_id=@org_id]{active}.person_id" });
```

- **The grammar** (`src/paths.ts`, `@blueshed/delta/paths`): `TRUE`, `FALSE`, `AUTHENTICATED`,
  `@field` (the row's column is the person), or a chain of hops `collection[filters]{conditions}.field`.
  A hop joins the value before it on its `$` filter, else on its id; the last `.field` is
  compared with the person (`auth.asSqlArg`, else the identity's `id`). A table that keeps
  versions is read at its current rows.
- **Where it starts**: a single document's root row; a document with a scope, the name's values
  (`@org_id` is the name's). A name that gives no row reaches nobody but `TRUE` and
  `AUTHENTICATED`; so does a single document whose row is not there (an implied one included).
- **Checked at registration** against the schema: a collection, a column or an integer key it
  cannot follow throws, naming the document and the path.
- **A row is never handed away**: a write through it that would leave the path not reaching the
  writer (`author_id` replaced with another's) is refused, **403**, and changes nothing. Removing
  the row is not handing it away.
- With a path, the document needs no `owns` function or `shared` beside it.

## Default-deny, with `auth`, on every backend

Every document says `owns` (a path in its definition, or `owns: (identity, docName) => boolean | Promise<boolean>`) or `shared: true`:

- SQLite / JSON file: in `registerDocs`' options, for every document of the call.
- `defineCustomDoc`: in its definition; registration refuses one with neither.

The error names the prefix and says what to add. Without `auth`, `owns` or `shared` is refused
too: it would claim a guard nothing asks.

## When it is asked

Before open, delta, open_at and history, and before an undo or redo writes to the entry's
document: a no is **404**. Then again, with the gate, **before each change is told**, once per
identity per change. A socket refused then is let go and told
`{ doc, error: { code, message } }`: on 404 the client re-opens and, refused, lets its copy go
(`doc.data` null, `onOps` told `replace ""` null); on 401 it reconnects so `onConnect` signs in.
A write of its own waiting for an echo resolves then.

## Gotchas

- **Keep `owns` cheap**: a name check, a path (one indexed query), or a membership the app caches.
- **`shared: true`** (a team board, a public room) means every signed-in identity hears every
  write. Never on rows some readers should not see: they would see them arrive.
- `owns` decides the name; it does not filter rows. Nothing else filters what a document reads,
  so scope a per-person document by its owner column and have `owns` match it.
