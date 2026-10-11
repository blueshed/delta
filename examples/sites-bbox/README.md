# sites-bbox

Someone looking at a map needs the sites in front of them, not every site in the world. So
there are two documents over the same rows:

| Document | What it holds |
|---|---|
| `world:1` | the world and every site in it, to read and write |
| `sites-in-bbox:<minLng>,<minLat>,<maxLng>,<maxLat>` | the sites inside that box, to read |

Open a box and you hold it: when anyone writes a site through the world, the box is told what
changed for it, in its own shape. A site that moves into the box is added, one that moves within
it is told the fields that changed, one that moves out or is deleted is removed, and a site
outside every open box is sent to no one.

The box is a custom document (`defineCustomDoc`): `query` reads what is in it when it is opened,
`matches` says whether a site belongs. `schema.ts` holds what both servers share; only where the
rows are kept differs.

## Run on SQLite

```sh
PORT=3100 bun examples/sites-bbox/server.ts
```

In memory, in one process.

## Run on Postgres

```sh
bun run db:up
PORT=3100 bun examples/sites-bbox/server-pg.ts
```

It makes its tables and a world, and prints the world's name (`world:1` in a fresh database).
Run it twice on the same database, on two ports, and a box open on one is told of sites written
through the other.

## Try it

```ts
import { connectWs, openDoc } from "@blueshed/delta/client";

const ws = connectWs("ws://localhost:3100/ws");
const box = openDoc("sites-in-bbox:0,0,50,50", ws);
box.onOps((ops) => console.log("box:", ops));
const world = openDoc("world:1", ws);
await world.ready;

await world.send([
  { op: "add", path: "/sites/-", value: { name: "Inside", lat: 10, lng: 20 } },
  { op: "add", path: "/sites/-", value: { name: "Outside", lat: 80, lng: 80 } },
]);
// box: [ { op: "add", path: "/sites/1", ... } ]   Outside is not sent

const outside = Object.values(world.data.get().sites).find((s) => s.name === "Outside");
await world.send([
  { op: "replace", path: `/sites/${outside.id}/lat`, value: 5 },
  { op: "replace", path: `/sites/${outside.id}/lng`, value: 5 },
]);
// box: [ { op: "add", path: "/sites/2", ... } ]   it moved in
```

`tests/examples.test.ts` and `tests/postgres-examples.test.ts` run these steps against both
servers.
