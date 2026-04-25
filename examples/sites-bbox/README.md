# sites-bbox — custom docs with a predicate-based view (SQLite)

This example shows how to define a **custom doc type** whose contents are
decided by a user-supplied predicate rather than a fixed FK scope.

Two doc types coexist on the same WebSocket server:

| Doc name | Kind | Purpose |
|---|---|---|
| `world:earth` | standard | Read/write every site. |
| `sites-in-bbox:<minLng>,<minLat>,<maxLng>,<maxLat>` | custom | Read-only live view of sites inside a bounding box. |

When a client writes to `world:earth` (adds, moves, or removes a site), the
server evaluates every open bbox doc's `matches(row, criteria)` predicate
and fans out the right op on that doc's own shape:

- row moves **into** the bbox → `add /sites/{id}`
- row moves **within** the bbox → `replace /sites/{id}`
- row moves **out of** the bbox → `remove /sites/{id}`
- row deleted while in the bbox → `remove /sites/{id}`
- row added or changed outside every open bbox → nothing sent

## Run (SQLite)

```sh
PORT=3100 bun examples/sites-bbox/server.ts
```

In-memory SQLite. Single process. The server prints the URL it's listening on.

## Run (Postgres)

Same two doc types, same client code — only the server-side wiring changes.

```sh
docker compose up -d --wait
psql postgres://delta:delta@localhost:5433/delta_test \
  -f tests/fixtures/sites.sql                 # one-time: create worlds/sites
PORT=3100 bun examples/sites-bbox/server-pg.ts
```

Writes via any Bun process that shares the DB will fan out to every open
bbox view on every process running `createDocListener` with the same
`sitesInBbox` registered — that's what the LISTEN/NOTIFY path buys you.

## Try it from the Bun repl

```ts
import { connectWs, openDoc, WS } from "@blueshed/delta/client";

const ws = connectWs("ws://localhost:3000/ws");

// Viewer of a bbox.
const view = openDoc("sites-in-bbox:0,0,50,50", ws);
view.onOps((ops) => console.log("bbox ops:", ops));

// Writer of the whole world.
const world = openDoc("world:earth", ws);
await world.send([
  { op: "add", path: "/sites/s1", value: { name: "Inside",  lat: 10, lng: 20 } },
  { op: "add", path: "/sites/s2", value: { name: "Outside", lat: 80, lng: 80 } },
]);
// viewer prints: bbox ops: [ { op: "add", path: "/sites/s1", value: {...} } ]
// s2 is silently dropped — the bbox predicate rejected it.

// Move s2 into the bbox.
await world.send([
  { op: "replace", path: "/sites/s2/lat", value: 5 },
  { op: "replace", path: "/sites/s2/lng", value: 5 },
]);
// viewer prints: bbox ops: [ { op: "add", path: "/sites/s2", value: {...} } ]
```

## What to read

The custom-doc API has parallel implementations in both backends:

- SQLite: `src/server/sqlite.ts` — `defineCustomDoc`, `registerDocs(..., customDocs)`, `customFanOut`.
- Postgres: `src/server/postgres/listener.ts` — `defineCustomDoc`, `createDocListener(ws, pool, { custom })`, `customFanOut`.

Both share the same `{ prefix, watch, parse, query, matches }` shape. The Postgres
version piggybacks on the existing `NOTIFY delta_changes` + `delta_fetch_ops`
path: after fetching the ops for a source doc, the listener runs the custom
fan-out loop against every open predicate doc on this process.

Tests: `tests/sqlite-custom.test.ts` and `tests/postgres-custom.test.ts`.
