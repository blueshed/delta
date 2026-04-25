# examples/kanban

A minimal, runnable delta-doc server with two flavours of client:

- **`serve.ts` + `client.tsx`** — the canonical railroad UX. A real fullstack page (`Bun.serve` + HTML import + JSX), reactive board with click-to-move cards and double-click-to-rename columns. **Open two tabs, see them sync.** This is the reference UX pattern for any `@blueshed/railroad` + `@blueshed/delta` project.
- **`server.ts` + `run.ts`** — the headless demo. Three WebSocket clients in one process, transcript printed to the terminal so you can read exactly which ops fan out where.

Every line in the write path goes through the library — no hand-rolled SQL, no direct `pg_notify`, no custom listener. When one client mutates, every other subscribed client receives the materialised ops as part of the same commit.

## Run the UX (browser, the canonical demo)

```sh
bun run db:up
bun examples/kanban/serve.ts                   # default port 3100
PORT=3199 bun examples/kanban/serve.ts         # override if 3100 is busy
```

Open <http://localhost:3100> in two browser tabs. Click a card — it cycles to the next column in both tabs. Double-click a column title to rename. Click "+ add card" to insert a row. Every action is one delta op (`replace` for moves and renames, `add` for new rows); the server commits to Postgres, fans out via `LISTEN/NOTIFY`, and every open tab updates without rebuilding the DOM (railroad's `list()` keeps per-card identity by id).

What's worth reading in `client.tsx`:

```tsx
provide(WS, connectWs("/ws"));                          // DI: openDoc finds the WS
const doc = openDoc<BoardDoc>("board:1");                // doc.data is a railroad Signal

// list(items$, keyFn, item$ => <Component>) — keyed render with per-row identity
{list<Card>(cards$, (c) => c.id, (c$) => <CardItem card$={c$} />)}

// Inside the row, signal.map() drives reactive text — never .get() in JSX children
<span>{card$.map((c) => c.title)}</span>

// Sending: one verb, one path
await doc.send([{ op: "replace", path: `/kanban_cards/${id}/kanban_columns_id`, value: nextId }]);
```

That's the railroad-with-delta canonical UX. No `useState`, no `applyOpsToCollection` (railroad's keyed `list()` covers it), no fetch.

## Run the headless demo (terminal)

```
bun run db:up
bun run examples/kanban/run.ts
```

The runner:

1. `applyFramework(pool)` → installs 001a–001f delta framework SQL.
2. `applySql(pool, generateSql(schema, docs))` → generates + applies the
   `kanban_boards / kanban_columns / kanban_cards` tables and registers
   them in `_delta_collections` + `_delta_docs`. Plus seed data.
3. **Server** — `createWs()` + `createDocListener(ws, pool)` +
   `registerDocType(docTypeFromDef(def, pool))`, served by `Bun.serve`.
4. **Clients** — two `connectWs()` sessions, alice and bob, each with its
   own reactive `openDoc<BoardDoc>("board:1", wsClient)`. The per-client
   state means two independent `data` signals in one process. Bob attaches
   an `onOps` handler so he can log exactly which ops the broadcast
   delivered — and `data.get()` on his doc reflects the result without
   any extra wiring.
5. **Write** — alice sends `{ action: "delta", doc: "board:1", ops: […] }`.
   Three ops: rename a column, move a card between columns, add a new
   card. The server's `docTypeFromDef` calls `delta_apply` which:
   - applies each op to the right table,
   - merges partial-row `replace` values via JSONB `||` (so a field-level
     update doesn't clobber neighbouring columns),
   - bumps `_delta_versions`, appends to `_delta_ops_log`,
   - fires `pg_notify('delta_changes', {doc, v})`.
6. **Broadcast** — `createDocListener` is already `LISTEN`ing on
   `delta_changes`. It sees the notify, calls `delta_fetch_ops` for the
   new version, and `ws.publish(docName, {doc, ops})` to every subscriber
   of `board:1`. Bob's `on("message")` fires; the script prints the ops
   he received.
7. **Late-joiner** — a third client, charlie, connects *after* the write.
   `openDoc("board:1")` returns the full post-mutation state via one
   fresh `delta_open`. No catch-up logic needed at this layer; the state
   is always the source of truth.

## The pitch

| Approach | Transactions | Relations | Nested shape | Live broadcast |
|---|---|---|---|---|
| ORM + REST / GraphQL | ✅ | ✅ | ❌ (client composes) | ❌ (polling / webhook glue) |
| Document NoSQL (Mongo, Firestore) | ❌ (across docs) | ❌ | ✅ | partial, vendor-locked |
| **delta-doc on Postgres** | ✅ | ✅ | ✅ | ✅ (`LISTEN`/`NOTIFY`) |

Postgres already has all four ingredients:

- `jsonb_build_object` + `jsonb_object_agg` compose arbitrarily nested
  shapes server-side (here `delta_open` does it via
  `_delta_load_collection`, walking the parent chain from
  `kanban_boards` → `kanban_columns` → `kanban_cards`).
- Foreign keys + transactions keep the composition consistent under
  concurrent writes.
- `pg_notify` fires as part of the same commit, so no subscriber sees
  uncommitted state.
- RLS (not used here — see [../todos-vs-rls/](../todos-vs-rls/)) gates
  visibility per identity.

Delta-doc is the thin protocol on top: `openDoc(name)` + `apply(ops)` is
the whole client-facing surface. Shape, storage, scoping, and broadcast
all fall out of the Postgres features that were already there.

## What `open("board:1")` returns

One `delta_open` call. `_delta_load_collection` walks
`kanban_boards → kanban_columns` (direct child, filtered by
`kanban_boards_id = 1`), then
`kanban_columns → kanban_cards` (grandchild — framework recurses parent
ids and filters `kanban_columns_id = ANY($parent_ids)`).

```json
{
  "kanban_boards":  { "id": 1, "title": "Product roadmap", "owner_id": 1 },
  "kanban_columns": {
    "1": { "id": 1, "title": "Todo",        "position": 0, "kanban_boards_id": 1, "owner_id": 1 },
    "2": { "id": 2, "title": "In progress", "position": 1, "kanban_boards_id": 1, "owner_id": 1 },
    "3": { "id": 3, "title": "Done",        "position": 2, "kanban_boards_id": 1, "owner_id": 1 }
  },
  "kanban_cards": {
    "1": { "id": 1, "title": "write the kanban example", "kanban_columns_id": 1, "position": 0, "owner_id": 1 },
    "2": { "id": 2, "title": "sketch 0.4 roadmap",       "kanban_columns_id": 1, "position": 1, "owner_id": 1 },
    "3": { "id": 3, "title": "review RLS policy",        "kanban_columns_id": 2, "position": 0, "owner_id": 1 },
    "4": { "id": 4, "title": "ship v0.3.0",              "kanban_columns_id": 3, "position": 0, "owner_id": 1 },
    "5": { "id": 5, "title": "capture bench results",    "kanban_columns_id": 3, "position": 1, "owner_id": 1 }
  }
}
```

The shape is flat — collections keyed by id — because that's what
`delta_open` emits. A UI that wants cards nested inside columns does
that client-side by grouping on `kanban_columns_id`. See
[dom-ops.ts](../../src/client/dom-ops.ts) and `doc.onOps` for how to
keep the DOM in sync without re-rendering the whole tree on every op.

## What a delta batch looks like on the wire

Client sends (via `connectWs`):

```json
{ "action": "delta", "doc": "board:1", "ops": [
  { "op": "replace", "path": "/kanban_columns/2/title", "value": "In flight" },
  { "op": "replace", "path": "/kanban_cards/1/kanban_columns_id", "value": 2 },
  { "op": "add",     "path": "/kanban_cards/-",
    "value": { "kanban_columns_id": 1, "title": "draft release notes", "position": 2, "owner_id": 1 } }
] }
```

Server calls `delta_apply('board:1', ops)`, and the broadcast that
every *other* subscriber receives is the **materialised** form — full
rows on `replace`, real assigned id on `add`:

```json
{ "doc": "board:1", "ops": [
  { "op": "replace", "path": "/kanban_columns/2",
    "value": { "id": 2, "title": "In flight", "position": 1, "kanban_boards_id": 1, "owner_id": 1 } },
  { "op": "replace", "path": "/kanban_cards/1",
    "value": { "id": 1, "title": "write the kanban example", "kanban_columns_id": 2, "position": 0, "owner_id": 1 } },
  { "op": "add",     "path": "/kanban_cards/6",
    "value": { "id": 6, "title": "draft release notes", "kanban_columns_id": 1, "position": 2, "owner_id": 1 } }
] }
```

Any client with the pre-batch state can apply these ops and end up at
the same post-batch state. The op vocabulary is identical between
writes, broadcasts, and the framework's on-disk `_delta_ops_log`.

## What this example leaves out

- **Auth + RLS.** One user, no identity, no team scoping — see
  [../todos-vs-rls/](../todos-vs-rls/).
- **A browser UI.** All three clients run in-process. In a browser the
  same `openDoc("board:1")` call returns the same reactive `data` signal,
  ready for whatever rendering library you use. Pair with
  `@blueshed/delta/dom-ops` → `applyOpsToCollection` for surgical DOM
  updates.
- **Temporal reads.** `temporal: false` on the schema. Flip it to `true`
  and you get `valid_from`/`valid_to` + `delta_open_at("board:1", at)`
  out of the box.
