/**
 * What both servers share: the tables, the world document, and what a
 * bounding box is. Only where the rows are kept differs (server.ts, server-pg.ts).
 */
import { defineSchema, defineDoc } from "../../src/server/sqlite";

export const schema = defineSchema({
  worlds: { columns: { label: "text" }, temporal: false },
  sites: {
    parent: { collection: "worlds", fk: "world_id" },
    columns: { name: "text", lat: "real", lng: "real" },
    temporal: false,
  },
});

/** `world:<id>`: the world and every site in it, to read and write. */
export const worldDoc = defineDoc("world:", { root: "worlds", include: ["sites"] });

export interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }

/** `sites-in-bbox:10,20,30,40` names the box { minLng: 10, minLat: 20, maxLng: 30, maxLat: 40 }. */
export function parse(docId: string): BBox {
  const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
  return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
}

/** Is this site in the box? Asked of every site a write touches. */
export function matches(_coll: string, row: any, c: BBox): boolean {
  return row.lng >= c.minLng && row.lng <= c.maxLng && row.lat >= c.minLat && row.lat <= c.maxLat;
}
