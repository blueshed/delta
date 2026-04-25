/**
 * sites-bbox — Postgres twin of server.ts.
 *
 * Same two doc types, same client code. Server-side swap:
 *   createDocListener(ws, pool, { custom: [sitesInBbox] })
 *     └─ LISTENs on delta_changes, fetches ops via delta_fetch_ops,
 *        fans the ops out to direct subscribers AND runs the custom
 *        doc predicate for every open bbox view on this Bun process.
 *
 * Run (assumes compose.yml is up and `sites.sql` fixture is applied):
 *
 *   docker compose up -d --wait
 *   psql $PG_URL -f tests/fixtures/sites.sql          # one-time
 *   PG_URL=... PORT=3100 bun examples/sites-bbox/server-pg.ts
 */
import type { Pool as PoolT } from "pg";
import { Pool } from "pg";
import {
  applyFramework,
  createDocListener,
  defineCustomDoc,
  defineDoc,
  docTypeFromDef,
  registerDocType,
  type CustomDocDef,
} from "../../src/server/postgres";
import { createWs } from "../../src/server/server";

// ---------------------------------------------------------------------------
// Standard doc — read/write the whole world.
// ---------------------------------------------------------------------------

const worldDoc = defineDoc("world:", {
  root: "worlds",
  include: ["sites"],
});

// ---------------------------------------------------------------------------
// Custom doc — sites inside a bounding box.
// ---------------------------------------------------------------------------

interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }

const sitesInBbox: CustomDocDef<BBox> = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse: (docId) => {
    const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
    return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
  },
  query: async (pool: PoolT, c) => {
    const { rows } = await pool.query(
      "SELECT id::text, world_id::text, name, lat, lng FROM sites " +
      "WHERE lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4",
      [c.minLng, c.maxLng, c.minLat, c.maxLat],
    );
    return { sites: rows };
  },
  matches: (_coll, row, c) =>
    row.lng >= c.minLng && row.lng <= c.maxLng &&
    row.lat >= c.minLat && row.lat <= c.maxLat,
});

// ---------------------------------------------------------------------------
// Wire up the server.
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.PG_URL ?? "postgres://delta:delta@localhost:5433/delta_test",
});

// Apply framework SQL (idempotent). The sites fixture must be applied
// separately (see header) because it's consumer schema, not framework.
await applyFramework(pool);

// Seed a world if none exists.
await pool.query("INSERT INTO worlds (label) SELECT 'Earth' WHERE NOT EXISTS (SELECT 1 FROM worlds)");

registerDocType(docTypeFromDef(worldDoc, pool));

const ws = createWs();
const listener = await createDocListener(ws, pool, { custom: [sitesInBbox] });

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);

console.log(`sites-bbox (Postgres) on ws://localhost:${server.port}${ws.path}`);
console.log(`  open "world:<id>" to read/write sites (use the id from the DB)`);
console.log(`  open "sites-in-bbox:0,0,50,50" for a live bbox-filtered view`);

// Clean up on SIGINT.
const shutdown = async () => {
  await listener.destroy();
  await pool.end();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
