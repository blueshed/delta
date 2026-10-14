# Custom documents: derived, read-only views

From `examples/sites-bbox/server.ts`: the sites inside a box, kept live as sites move.

```ts
const sitesInBbox = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse,                                    // "0,0,50,50" → { minLng, minLat, maxLng, maxLat }
  query: (db, c) => ({
    sites: db.query("SELECT * FROM sites WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?")
      .all(c.minLng, c.maxLng, c.minLat, c.maxLat),
  }),
  matches,                                  // (collection, row, criteria) → still in the box?
});
registerDocs(ws, db, schema, [worldDoc], [sitesInBbox]);
// Postgres: createDocListener(ws, pool, { custom: [sitesInBbox] }), query async over a Pool
```

`CustomDoc` in `src/server/custom.ts` is the contract. Clients open it like any document; writes
go through the documents over the watched collections. Pick by shape, and never mix the two:

- **Membership** (`query` + `matches`): a flat view, `{ [collection]: { [id]: row } }`. `query`
  loads; `matches` decides per changed row whether it belongs. Told as single ops.
- **Recompute** (`recompute`): any shape, nested, joined, aggregated or per person. Read again
  whole on every write to a watched collection and sent as a root replace (`replace ""`).
  Return `null` for not found (404 on open; on a write, subscribers are let go with 404).

## Gotchas

- **The callback shape differs by backend**: Postgres's `query` and `recompute` take a `Pool`
  and are awaited; SQLite's and the JSON file's take a synchronous `bun:sqlite` handle.
- **With `auth`, say who owns it**: `owns` or `shared: true`; with neither, registration
  throws, and with either but no `auth` it throws too (`ownership.md`).
- **The name is untrusted.** `parse` reads whatever the client asked for. Check it with `owns`,
  check the parsed id against the identity (return null), and let RLS be the tenant guard.
- `query`, `matches` and `recompute` are given the identity; bind it (`withAppAuth(pool, id, …)`
  or a `*_as` function) so RLS scopes what they read. `matches` sees the written row, which RLS
  does not filter: check it against the identity. On SQLite there is no RLS: check every row.
- `identity` is `undefined` without sign-in: guard it. A recompute that throws is logged and
  that subscriber's update is dropped.
- Membership results are cached per name and identity. Recompute is **not** cached and has no
  relevance gate: cost is identities subscribed × writes to any watched collection. Keep
  `watch` tight and `recompute` cheap.
- A recompute view is sent to each subscriber alone, with no `v`; in-process, `onPublish` hears
  it with `to` naming the identity (`local.md`).
- A name goes to the longest prefix it starts with, a table document's or a custom one's.

## Root replace

`applyOps(doc, [{ op: "replace", path: "", value: next }])` swaps the whole document **in place**
(same kind, object or array, else it throws); `remove ""` clears it. Both sides hold the value by
reference, so in place is what keeps `doc.data` live. A hand-written `DocType` may send it too.

## A hand-written `DocType` (Postgres)

`DocType` in `src/server/postgres/registry.ts`: `prefix`, `parse`, `open`, `apply`, optional
`openAt`, and `owns` or `shared`. Use it only when no `defineDoc` can express the lens.

- It is told **only its own writes**: the database cannot know what its `open` reads. Its
  `apply` logs with `_delta_bump_and_notify(docName, ops)`. To hear other writes, use
  `docTypeFromDef` or a `defineCustomDoc` watching the collections.
- It parses its own prefix: keep prefix logic out of the rest of the app.
- Register it in `createDocListener`'s `types`, or `listener.register(type)` later (which
  replaces an earlier type of that prefix; a prefix a custom document holds is refused).
- With `ledger: true` its `apply` is given a `Writer`; one that ignores it is not on the ledger.
