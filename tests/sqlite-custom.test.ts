import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  defineSchema,
  defineDoc,
  defineCustomDoc,
  createTables,
  registerDocs,
  type CustomDocDef,
} from "../src/server/sqlite";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSocket(clientId = "test-client") {
  const sent: any[] = [];
  const received: any[] = [];
  const subscriptions = new Set<string>();
  return {
    data: { clientId },
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    subscribe: (ch: string) => subscriptions.add(ch),
    unsubscribe: (ch: string) => subscriptions.delete(ch),
    publish: (_ch: string, raw: string) => received.push(JSON.parse(raw)),
    sent,
    received,
    subscriptions,
  };
}

// Tie publish → all subscribed sockets' `received` list.
// createWs uses serverRef.publish; we wire a minimal stand-in.
function wirePublish(ws: WsServer, sockets: any[]) {
  ws.setServer({
    publish: (channel: string, raw: string) => {
      for (const sock of sockets) {
        if (sock.subscriptions.has(channel)) sock.send(raw);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Schema — worlds + sites with lat/lng
// ---------------------------------------------------------------------------

const schema = defineSchema({
  worlds: {
    columns: { label: "text" },
  },
  sites: {
    parent: { collection: "worlds", fk: "world_id" },
    columns: {
      name: "text",
      lat: "real",
      lng: "real",
    },
  },
});

const worldDoc = defineDoc("world:", {
  root: "worlds",
  include: ["sites"],
});

// Custom doc: sites within a bounding box.
// docId format: "minLng,minLat,maxLng,maxLat"
interface BBox { minLng: number; minLat: number; maxLng: number; maxLat: number }

const sitesInBbox: CustomDocDef<BBox> = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse: (docId) => {
    const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
    return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
  },
  query: (db, c) => ({
    sites: db.query(
      "SELECT * FROM sites WHERE lng >= ? AND lng <= ? AND lat >= ? AND lat <= ?",
    ).all(c.minLng, c.maxLng, c.minLat, c.maxLat),
  }),
  matches: (_coll, row, c) =>
    row.lng >= c.minLng && row.lng <= c.maxLng &&
    row.lat >= c.minLat && row.lat <= c.maxLat,
});

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("custom docs — predicate-based membership", () => {
  let db: InstanceType<typeof Database>;
  let ws: WsServer;

  // Seeded rows use a fixed past timestamp; otherwise a same-second
  // close + reinsert during updates collides on the (id, valid_from) PK.
  const PAST = "2020-01-01 00:00:00";

  function setupWorld() {
    db.run("INSERT INTO worlds (id, label, valid_from) VALUES ('earth', 'Earth', ?)", [PAST]);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    createTables(db, schema);
    ws = createWs();
    registerDocs(ws, db, schema, [worldDoc], [sitesInBbox]);
    setupWorld();
  });

  test("initial load returns only rows matching criteria", async () => {
    db.run("INSERT INTO sites (id, world_id, name, lat, lng, valid_from) VALUES ('a', 'earth', 'In', 10, 20, ?)", [PAST]);
    db.run("INSERT INTO sites (id, world_id, name, lat, lng, valid_from) VALUES ('b', 'earth', 'Out', 80, 80, ?)", [PAST]);

    const sock = mockSocket();
    wirePublish(ws, [sock]);
    await ws.websocket.message(sock, JSON.stringify({
      id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50",
    }));

    const res = sock.sent[0].result;
    expect(Object.keys(res.sites)).toEqual(["a"]);
    expect(res.sites.a.name).toBe("In");
  });

  test("add to source doc with matching row fans out to custom doc", async () => {
    const world = mockSocket("world-client");
    const viewer = mockSocket("viewer");
    wirePublish(ws, [world, viewer]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(viewer, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));

    // World-client adds a site inside the bbox.
    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [{ op: "add", path: "/sites/s1", value: { name: "Alpha", lat: 10, lng: 20 } }],
    }));

    // Viewer should have received an add on its own doc channel.
    const viewerBroadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    expect(viewerBroadcasts).toHaveLength(1);
    expect(viewerBroadcasts[0].ops).toEqual([
      { op: "add", path: "/sites/s1", value: expect.objectContaining({ name: "Alpha", lat: 10, lng: 20 }) },
    ]);
  });

  test("add of non-matching row does not fan out", async () => {
    const world = mockSocket("w");
    const viewer = mockSocket("v");
    wirePublish(ws, [world, viewer]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(viewer, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));

    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [{ op: "add", path: "/sites/out", value: { name: "Far", lat: 80, lng: 80 } }],
    }));

    const viewerBroadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    expect(viewerBroadcasts).toHaveLength(0);
  });

  test("update moves row into bbox → add", async () => {
    db.run("INSERT INTO sites (id, world_id, name, lat, lng, valid_from) VALUES ('s1', 'earth', 'Drifter', 80, 80, ?)", [PAST]);

    const world = mockSocket("w");
    const viewer = mockSocket("v");
    wirePublish(ws, [world, viewer]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(viewer, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));
    expect(viewer.sent[0].result.sites).toEqual({});

    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [
        { op: "replace", path: "/sites/s1/lat", value: 10 },
        { op: "replace", path: "/sites/s1/lng", value: 20 },
      ],
    }));

    const viewerBroadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    // Final broadcast should include an "add" (first field move still outside, second brings it in).
    const lastOps = viewerBroadcasts.flatMap((m: any) => m.ops);
    const adds = lastOps.filter((o: any) => o.op === "add" && o.path === "/sites/s1");
    expect(adds).toHaveLength(1);
    expect(adds[0].value).toMatchObject({ lat: 10, lng: 20 });
  });

  test("update moves row out of bbox → remove", async () => {
    db.run("INSERT INTO sites (id, world_id, name, lat, lng, valid_from) VALUES ('s1', 'earth', 'Local', 10, 20, ?)", [PAST]);

    const world = mockSocket("w");
    const viewer = mockSocket("v");
    wirePublish(ws, [world, viewer]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(viewer, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));
    expect(Object.keys(viewer.sent[0].result.sites)).toEqual(["s1"]);

    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [{ op: "replace", path: "/sites/s1/lat", value: 90 }],
    }));

    const viewerBroadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    const lastOps = viewerBroadcasts.flatMap((m: any) => m.ops);
    expect(lastOps).toContainEqual({ op: "remove", path: "/sites/s1" });
  });

  test("remove of matching row fans out as remove", async () => {
    db.run("INSERT INTO sites (id, world_id, name, lat, lng, valid_from) VALUES ('s1', 'earth', 'Local', 10, 20, ?)", [PAST]);

    const world = mockSocket("w");
    const viewer = mockSocket("v");
    wirePublish(ws, [world, viewer]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(viewer, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));

    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [{ op: "remove", path: "/sites/s1" }],
    }));

    const viewerBroadcasts = viewer.sent.filter((m: any) => m.doc === "sites-in-bbox:0,0,50,50");
    const lastOps = viewerBroadcasts.flatMap((m: any) => m.ops);
    expect(lastOps).toContainEqual({ op: "remove", path: "/sites/s1" });
  });

  test("two viewers with different bboxes each see only their own matches", async () => {
    const world = mockSocket("w");
    const nearby = mockSocket("near");
    const faraway = mockSocket("far");
    wirePublish(ws, [world, nearby, faraway]);

    await ws.websocket.message(world, JSON.stringify({ id: 1, action: "open", doc: "world:earth" }));
    await ws.websocket.message(nearby, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));
    await ws.websocket.message(faraway, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:60,60,100,100" }));

    await ws.websocket.message(world, JSON.stringify({
      id: 2, action: "delta", doc: "world:earth",
      ops: [
        { op: "add", path: "/sites/close", value: { name: "C", lat: 10, lng: 20 } },
        { op: "add", path: "/sites/far",   value: { name: "F", lat: 80, lng: 80 } },
      ],
    }));

    const nearOps = nearby.sent.filter((m: any) => m.doc?.startsWith("sites-in-bbox:")).flatMap((m: any) => m.ops);
    const farOps  = faraway.sent.filter((m: any) => m.doc?.startsWith("sites-in-bbox:")).flatMap((m: any) => m.ops);

    expect(nearOps).toContainEqual(expect.objectContaining({ op: "add", path: "/sites/close" }));
    expect(nearOps.find((o: any) => o.path === "/sites/far")).toBeUndefined();

    expect(farOps).toContainEqual(expect.objectContaining({ op: "add", path: "/sites/far" }));
    expect(farOps.find((o: any) => o.path === "/sites/close")).toBeUndefined();
  });

  test("delta against a custom doc is rejected as read-only", async () => {
    const sock = mockSocket();
    wirePublish(ws, [sock]);
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "sites-in-bbox:0,0,50,50" }));
    await ws.websocket.message(sock, JSON.stringify({
      id: 2, action: "delta", doc: "sites-in-bbox:0,0,50,50",
      ops: [{ op: "add", path: "/sites/x", value: { name: "X", lat: 0, lng: 0 } }],
    }));

    expect(sock.sent[1].error).toBeDefined();
    expect(sock.sent[1].error.code).toBe(403);
  });
});
