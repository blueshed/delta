/**
 * Integration tests for Postgres custom docs (predicate-based membership).
 *
 * Requires a live Postgres on $DELTA_TEST_PG_URL. Run with:
 *
 *   docker compose up -d --wait
 *   bun test tests/postgres-custom.test.ts
 *   docker compose down -v
 *
 * Mirrors tests/sqlite-custom.test.ts. Verifies that writes via a standard
 * `world:` doc fan out to open `sites-in-bbox:...` viewers as the right
 * transition ops (add / replace / remove) on the custom doc's own shape.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  createDocListener,
  defineCustomDoc,
  defineDoc,
  docTypeFromDef,
  registerDocType,
  clearRegistry,
  type CustomDocDef,
} from "../src/server/postgres";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import {
  newPool,
  applyFramework,
  mockClient,
  sendAndAwait,
  waitFor,
} from "./setup";

setLogLevel("silent");

let pool: Pool;

const SITES_FIXTURE = join(import.meta.dir, "fixtures", "sites.sql");

async function applySitesFixture(pool: Pool): Promise<void> {
  await pool.query(readFileSync(SITES_FIXTURE, "utf8"));
}

async function resetSites(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('sites') IS NOT NULL THEN
        EXECUTE 'TRUNCATE sites RESTART IDENTITY CASCADE';
      END IF;
      IF to_regclass('worlds') IS NOT NULL THEN
        EXECUTE 'TRUNCATE worlds RESTART IDENTITY CASCADE';
      END IF;
      IF to_regclass('_delta_versions') IS NOT NULL THEN
        EXECUTE 'TRUNCATE _delta_versions';
      END IF;
      IF to_regclass('_delta_ops_log') IS NOT NULL THEN
        EXECUTE 'TRUNCATE _delta_ops_log RESTART IDENTITY';
      END IF;
    END $$;
  `);
}

// ---------------------------------------------------------------------------
// Custom doc — sites inside a bounding box
// ---------------------------------------------------------------------------

interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }

const sitesInBbox: CustomDocDef<BBox> = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse: (docId) => {
    const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
    return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
  },
  query: async (pool, c) => {
    const { rows } = await pool.query(
      "SELECT id::text, world_id::text, name, lat, lng FROM sites WHERE lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4",
      [c.minLng, c.maxLng, c.minLat, c.maxLat],
    );
    return { sites: rows };
  },
  matches: (_coll, row, c) =>
    row.lng >= c.minLng && row.lng <= c.maxLng &&
    row.lat >= c.minLat && row.lat <= c.maxLat,
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await applySitesFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

let ws: WsServer;
let listener: Awaited<ReturnType<typeof createDocListener>>;
let worldId: string;

async function seedWorld(): Promise<string> {
  const { rows } = await pool.query("INSERT INTO worlds (label) VALUES ('Earth') RETURNING id::text");
  return rows[0].id as string;
}

beforeEach(async () => {
  clearRegistry();
  await resetSites(pool);

  // Register the standard world: doc on this pool.
  registerDocType(
    docTypeFromDef(
      defineDoc("world:", { root: "worlds", include: ["sites"] }),
      pool,
    ),
  );

  ws = createWs();
  // Mock the Bun server's publish so we can observe fan-out on mockClients.
  ws.setServer({
    publish: (channel: string, raw: string) => {
      for (const c of clients) {
        if (c.subscriptions.has(channel)) c.send(raw);
      }
    },
  });

  listener = await createDocListener(ws, pool, { custom: [sitesInBbox] });
  worldId = await seedWorld();
  clients.length = 0;
});

// Track clients so the mock publish above can route.
const clients: any[] = [];
function makeClient(id: string) {
  const c = mockClient({ clientId: id });
  clients.push(c);
  return c;
}

afterEach(async () => {
  await listener?.destroy();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("postgres custom docs — predicate-based membership", () => {
  test("initial load returns only rows matching criteria", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [
        { op: "add", path: "/sites/1", value: { name: "In",  lat: 10, lng: 20 } },
        { op: "add", path: "/sites/2", value: { name: "Out", lat: 80, lng: 80 } },
      ],
    });

    const viewer = makeClient("v");
    const openRes = await sendAndAwait(ws, viewer, {
      action: "open", doc: "sites-in-bbox:0,0,50,50",
    });

    const siteIds = Object.keys(openRes.result.sites);
    expect(siteIds).toEqual(["1"]);
    expect(openRes.result.sites["1"].name).toBe("In");
  });

  test("add of matching row fans out to custom doc subscribers", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });

    const viewer = makeClient("v");
    await sendAndAwait(ws, viewer, { action: "open", doc: "sites-in-bbox:0,0,50,50" });

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "add", path: "/sites/1", value: { name: "Alpha", lat: 10, lng: 20 } }],
    });

    // Wait for the LISTEN notification to propagate.
    const matched = await waitFor(
      () => viewer.sent.find(
        (m: any) => m.doc === "sites-in-bbox:0,0,50,50" &&
                    m.ops?.some((o: any) => o.op === "add" && o.path === "/sites/1"),
      ),
    );
    expect(matched).toBeDefined();
    const addOp = matched.ops.find((o: any) => o.path === "/sites/1");
    expect(addOp.value).toMatchObject({ name: "Alpha", lat: 10, lng: 20 });
  });

  test("add of non-matching row does not fan out", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });

    const viewer = makeClient("v");
    await sendAndAwait(ws, viewer, { action: "open", doc: "sites-in-bbox:0,0,50,50" });

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "add", path: "/sites/1", value: { name: "Far", lat: 80, lng: 80 } }],
    });

    // Give LISTEN time; viewer should not receive a bbox message.
    await new Promise((r) => setTimeout(r, 300));
    const forViewer = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    expect(forViewer).toHaveLength(0);
  });

  test("update moves row into bbox → add", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });
    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "add", path: "/sites/1", value: { name: "Drifter", lat: 80, lng: 80 } }],
    });

    const viewer = makeClient("v");
    const openRes = await sendAndAwait(ws, viewer, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    expect(openRes.result.sites).toEqual({});

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [
        { op: "replace", path: "/sites/1/lat", value: 10 },
        { op: "replace", path: "/sites/1/lng", value: 20 },
      ],
    });

    const matched = await waitFor(
      () => viewer.sent.find(
        (m: any) => m.doc === "sites-in-bbox:0,0,50,50" &&
                    m.ops?.some((o: any) => o.op === "add" && o.path === "/sites/1"),
      ),
    );
    expect(matched).toBeDefined();
  });

  test("update moves row out of bbox → remove", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });
    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "add", path: "/sites/1", value: { name: "Local", lat: 10, lng: 20 } }],
    });

    const viewer = makeClient("v");
    const openRes = await sendAndAwait(ws, viewer, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    expect(Object.keys(openRes.result.sites)).toEqual(["1"]);

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "replace", path: "/sites/1/lat", value: 90 }],
    });

    const matched = await waitFor(
      () => viewer.sent.find(
        (m: any) => m.doc === "sites-in-bbox:0,0,50,50" &&
                    m.ops?.some((o: any) => o.op === "remove" && o.path === "/sites/1"),
      ),
    );
    expect(matched).toBeDefined();
  });

  test("remove of matching row fans out as remove", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });
    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "add", path: "/sites/1", value: { name: "Local", lat: 10, lng: 20 } }],
    });

    const viewer = makeClient("v");
    await sendAndAwait(ws, viewer, { action: "open", doc: "sites-in-bbox:0,0,50,50" });

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [{ op: "remove", path: "/sites/1" }],
    });

    const matched = await waitFor(
      () => viewer.sent.find(
        (m: any) => m.doc === "sites-in-bbox:0,0,50,50" &&
                    m.ops?.some((o: any) => o.op === "remove" && o.path === "/sites/1"),
      ),
    );
    expect(matched).toBeDefined();
  });

  test("two viewers with different bboxes see only their own matches", async () => {
    const world = makeClient("w");
    await sendAndAwait(ws, world, { action: "open", doc: `world:${worldId}` });

    const near = makeClient("near");
    const far = makeClient("far");
    await sendAndAwait(ws, near, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    await sendAndAwait(ws, far,  { action: "open", doc: "sites-in-bbox:60,60,100,100" });

    await sendAndAwait(ws, world, {
      action: "delta", doc: `world:${worldId}`,
      ops: [
        { op: "add", path: "/sites/1", value: { name: "C", lat: 10, lng: 20 } },
        { op: "add", path: "/sites/2", value: { name: "F", lat: 80, lng: 80 } },
      ],
    });

    const nearMatched = await waitFor(
      () => near.sent.find(
        (m: any) => m.doc === "sites-in-bbox:0,0,50,50" &&
                    m.ops?.some((o: any) => o.path === "/sites/1"),
      ),
    );
    expect(nearMatched).toBeDefined();
    expect(near.sent.find((m: any) => m.ops?.some((o: any) => o.path === "/sites/2"))).toBeUndefined();

    const farMatched = await waitFor(
      () => far.sent.find(
        (m: any) => m.doc === "sites-in-bbox:60,60,100,100" &&
                    m.ops?.some((o: any) => o.path === "/sites/2"),
      ),
    );
    expect(farMatched).toBeDefined();
    expect(far.sent.find((m: any) => m.ops?.some((o: any) => o.path === "/sites/1"))).toBeUndefined();
  });

  test("lazy-tracked source doc does NOT replay history to custom subscribers", async () => {
    // The bug: when a NOTIFY arrives for a docName with no eager `tracked`
    // entry (no direct WS subscriber), the listener used to create a lazy
    // entry at version=0 and re-fetch every historical op, replaying each
    // through customFanOut. With the v-1 fix, only the current notification's
    // ops are processed.
    //
    // To exercise the lazy path deterministically — without timing assumptions
    // about WS open vs NOTIFY ordering — we drive delta_apply via pool.query
    // directly. No socket ever opens the source doc, so no eager tracked
    // entry can be created.
    const sourceDoc = `world:${worldId}`;

    async function applyOps(ops: any[]): Promise<void> {
      await pool.query("SELECT delta_apply($1, $2::jsonb)", [sourceDoc, JSON.stringify(ops)]);
    }

    // 1) Two historical writes happen while no custom subscriber exists.
    //    Each NOTIFY lazy-creates a tracked entry, processes its row, and
    //    pruneDoc deletes the entry (no subscribers).
    await applyOps([{ op: "add", path: "/sites/501", value: { name: "S501", lat: 10, lng: 20 } }]);
    await applyOps([{ op: "add", path: "/sites/502", value: { name: "S502", lat: 11, lng: 21 } }]);
    await new Promise((r) => setTimeout(r, 200));

    // 2) Custom-doc subscriber arrives. Initial query loads both historical sites.
    const viewer = makeClient("viewer");
    const open = await sendAndAwait(ws, viewer, {
      action: "open", doc: "sites-in-bbox:0,0,50,50",
    });
    expect(Object.keys(open.result.sites).sort()).toEqual(["501", "502"]);
    viewer.sent.length = 0;

    // 3) A new write — the source still has no direct subscriber, so the
    //    lazy path runs again. With the fix: fetch since=v-1=2, return v=3,
    //    emit a single `add /sites/503`. Without the fix: fetch since=0,
    //    return v=1+v=2+v=3, emit `replace 501, replace 502, add 503`.
    await applyOps([{ op: "add", path: "/sites/503", value: { name: "S503", lat: 12, lng: 22 } }]);
    await new Promise((r) => setTimeout(r, 300));

    const broadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    const allOps = broadcasts.flatMap((m: any) => m.ops);
    const paths = allOps.map((o: any) => `${o.op} ${o.path}`).sort();

    // Equality, not contains — historical ops must not replay at all.
    expect(paths).toEqual(["add /sites/503"]);
  });

  test("delta against a custom doc is rejected as read-only", async () => {
    const sock = makeClient("c");
    await sendAndAwait(ws, sock, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    const res = await sendAndAwait(ws, sock, {
      action: "delta", doc: "sites-in-bbox:0,0,50,50",
      ops: [{ op: "add", path: "/sites/x", value: { name: "X", lat: 0, lng: 0 } }],
    });

    expect(res.error).toBeDefined();
    expect(res.error.code).toBe(403);
  });
});
