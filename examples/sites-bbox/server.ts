/**
 * sites-bbox on SQLite (in memory): `world:1` to read and write every site,
 * and `sites-in-bbox:<minLng>,<minLat>,<maxLng>,<maxLat>` for the sites in a box.
 *
 *   PORT=3100 bun examples/sites-bbox/server.ts
 */
import { Database } from "bun:sqlite";
import { createTables, defineCustomDoc, registerDocs } from "../../src/server/sqlite";
import { createWs } from "../../src/server/server";
import { schema, worldDoc, parse, matches, type BBox } from "./schema";

const sitesInBbox = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse,
  // What the box holds when it is opened; after that, `matches` says which sites come and go.
  query: (db, c) => ({
    sites: db.query("SELECT * FROM sites WHERE lng BETWEEN ? AND ? AND lat BETWEEN ? AND ?")
      .all(c.minLng, c.maxLng, c.minLat, c.maxLat),
  }),
  matches,
});

const db = new Database(":memory:");   // a path keeps it
createTables(db, schema);
db.run("INSERT OR IGNORE INTO worlds (id, label) VALUES (1, 'Earth')");

const ws = createWs();
registerDocs(ws, db, schema, [worldDoc], [sitesInBbox]);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 0),   // 0: the OS picks a free port
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);

console.log(`sites-bbox (SQLite) on ws://localhost:${server.port}${ws.path}`);
console.log(`  open "world:1" to read and write every site`);
console.log(`  open "sites-in-bbox:0,0,50,50" for the sites in that box`);
