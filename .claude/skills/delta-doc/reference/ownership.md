# Who may have a document: `owns` and `shared`

From `examples/todos-vs-rls/delta.ts`: a document per person, one per team, each saying who
may have its names.

```ts
const types = [
  docTypeFromDef<Identity>(myTodos, app, { auth, owns: (me, name) => name === `todos-mine:${me.id}` }),
  docTypeFromDef<Identity>(teamTodos, app, { auth, owns: isMember }),   // a membership query
];
const listener = await createDocListener(local.server, app, { types, auth, custom: [summary] });
```

```ts
// client: each person opens their own name; another's is a 404
const me = (await call<User>("authenticate", { token })).id;
const mine = openDoc<{ todos: Record<string, Todo> }>(`todos-mine:${me}`);
```

**A document's name is the channel its writes are broadcast on.** Whoever has it open hears
every write through it, whatever RLS lets them read. So the name, checked by `owns`, is what
keeps one person's rows off another's socket: one name per owner. The add through
`todos-mine:<me>` takes `owner_id` from the name, so nobody can forge a row for someone else;
RLS `WITH CHECK` is the second layer (`rls.md`).

## Default-deny, with `auth`, on every backend

Every document says `owns: (identity, docName) => boolean | Promise<boolean>` or `shared: true`:

- SQLite / JSON file: in `registerDocs`' options, for every document of the call.
- `docTypeFromDef`: in its options; with `auth` it throws without one.
- A hand-written `DocType`: an `owns` method or `shared: true`; `createDocListener` and its
  `register` refuse one with neither.
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

- **Keep `owns` cheap**: a name check, or a membership the app caches.
- **`shared: true`** (a team board, a public room) means every signed-in identity hears every
  write. Never on a table whose rows RLS hides from some readers: they would see them arrive.
- `owns` decides the name; it does not filter rows. On SQLite there is no RLS, so scope a
  per-person document by its owner column and have `owns` match it.
