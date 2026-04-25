/**
 * sites-bbox — SQLite example of a custom doc with a predicate-based view.
 *
 * Two doc types registered on one server:
 *   world:earth                        — standard doc, read/write every site
 *   sites-in-bbox:minLng,minLat,maxLng,maxLat
 *                                       — custom doc, read-only view of sites
 *                                         whose lat/lng fall inside the bbox
 *
 * Any write to the `sites` collection via `world:earth` is evaluated against
 * each open bbox subscription. Matching rows fan out as add/replace/remove
 * ops on the bbox doc's own shape — no JSON diffing, just membership.
 *
 * Run:
 *   bun examples/sites-bbox/server.ts
 */
import { Database } from "bun:sqlite";
import {
  defineSchema,
  defineDoc,
  defineCustomDoc,
  createTables,
  registerDocs,
} from "../../src/server/sqlite";
import { createWs } from "../../src/server/server";

// ---------------------------------------------------------------------------
// Schema — one world, many sites with coordinates.
// ---------------------------------------------------------------------------

const schema = defineSchema({
  worlds: { columns: { label: "text" } },
  sites: {
    parent: { collection: "worlds", fk: "world_id" },
    columns: { name: "text", lat: "real", lng: "real" },
  },
});

// ---------------------------------------------------------------------------
// Standard doc — read/write the whole world.
// ---------------------------------------------------------------------------

const worldDoc = defineDoc("world:", {
  root: "worlds",
  include: ["sites"],
});

// ---------------------------------------------------------------------------
// Custom doc — sites inside a bounding box, indexed by the docId.
// ---------------------------------------------------------------------------

interface BBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const sitesInBbox = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],

  // docId "10,20,30,40" → { minLng: 10, minLat: 20, maxLng: 30, maxLat: 40 }
  parse: (docId) => {
    const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
    return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
  },

  // Initial load: SQL filter.
  query: (db, c) => ({
    sites: db.query(
      "SELECT * FROM current_sites WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?",
    ).all(c.minLng, c.maxLng, c.minLat, c.maxLat),
  }),

  // Per-row membership predicate. The framework calls this on every write
  // touching `sites`; the in-memory cache tracks which ids are currently
  // in the view so transitions (out→in, in→out) emit the right op.
  matches: (_coll, row, c) =>
    row.lng >= c.minLng && row.lng <= c.maxLng &&
    row.lat >= c.minLat && row.lat <= c.maxLat,
});

// ---------------------------------------------------------------------------
// Wire up the server.
// ---------------------------------------------------------------------------

// In-memory for demo; swap for a path to persist.
const db = new Database(":memory:");
createTables(db, schema);
db.run(
  "INSERT OR IGNORE INTO worlds (id, label, valid_from) VALUES ('earth', 'Earth', '2020-01-01 00:00:00')",
);

const ws = createWs();
registerDocs(ws, db, schema, [worldDoc], [sitesInBbox]);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),   // 0 lets the OS pick a free port
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);

console.log(`sites-bbox server on ws://localhost:${server.port}${ws.path}`);
console.log(`  open "world:earth" to read/write every site`);
console.log(`  open "sites-in-bbox:0,0,50,50" for a live bbox-filtered view`);
