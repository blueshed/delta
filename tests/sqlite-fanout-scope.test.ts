/**
 * Regression test for issue.md — "Cross-doc leak in registerDocs".
 *
 * Two sibling docs of the same prefix (e.g. customer:alice / customer:bob)
 * must NOT receive each other's child-row ops. Before the fix, fanOut()
 * filtered by collection name only, ignoring the parent FK; sibling docs
 * with overlapping `include` collections leaked rows live AND polluted the
 * server-side cache so subsequent `open` requests served cross-scope rows.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  defineSchema, defineDoc, createTables, registerDocs, loadDocAt,
} from "../src/server/sqlite";
import { createLocal } from "../src/server/local";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

function mockSocket(id = "c") {
  const sent: any[] = [];
  const subs = new Set<string>();
  return {
    data: { clientId: id },
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    subscribe: (ch: string) => subs.add(ch),
    unsubscribe: (ch: string) => subs.delete(ch),
    sent,
    subscriptions: subs,
  };
}

function wirePublish(ws: WsServer, sockets: any[]) {
  ws.setServer({
    publish: (channel: string, raw: string) => {
      for (const s of sockets) if (s.subscriptions.has(channel)) s.send(raw);
    },
  });
}

const PAST = "2020-01-01 00:00:00";

const schema = defineSchema({
  customers: { columns: { name: "text" } },
  brands: {
    parent: { collection: "customers", fk: "customers_id" },
    columns: { name: "text" },
  },
  artworks: {
    parent: { collection: "brands", fk: "brand_id" },
    columns: { title: "text" },
  },
});

const customerDoc = defineDoc("customer:", {
  root: "customers",
  include: ["brands", "artworks"],
});

describe("fanOut — parent-FK scope check (issue.md)", () => {
  let db: InstanceType<typeof Database>;
  let ws: WsServer;

  function seed() {
    db.run("INSERT INTO customers (id, name, valid_from) VALUES ('alice', 'Alice', ?)", [PAST]);
    db.run("INSERT INTO customers (id, name, valid_from) VALUES ('bob',   'Bob',   ?)", [PAST]);
    db.run("INSERT INTO brands (id, customers_id, name, valid_from) VALUES ('b-alice-1', 'alice', 'AliceBrand', ?)", [PAST]);
    db.run("INSERT INTO brands (id, customers_id, name, valid_from) VALUES ('b-bob-1',   'bob',   'BobBrand',   ?)", [PAST]);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    createTables(db, schema);
    ws = createWs();
    registerDocs(ws, db, schema, [customerDoc]);
    seed();
  });

  test("open snapshot contains only this customer's brands", async () => {
    const sock = mockSocket("a");
    wirePublish(ws, [sock]);
    await ws.websocket.message(sock, JSON.stringify({
      id: 1, action: "open", doc: "customer:alice",
    }));
    const brands = sock.sent[0].result.brands;
    expect(Object.keys(brands)).toEqual(["b-alice-1"]);
  });

  test("B's child add does NOT leak to A's customer:doc (live)", async () => {
    const A = mockSocket("A");
    const B = mockSocket("B");
    wirePublish(ws, [A, B]);

    await ws.websocket.message(A, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));
    await ws.websocket.message(B, JSON.stringify({ id: 1, action: "open", doc: "customer:bob" }));

    // Reset received to track only post-open broadcasts.
    A.sent.length = 0;

    await ws.websocket.message(B, JSON.stringify({
      id: 2, action: "delta", doc: "customer:bob",
      ops: [{ op: "add", path: "/brands/leak-probe",
              value: { customers_id: "bob", name: "LEAK_PROBE" } }],
    }));

    const broadcastsToA = A.sent.filter((m: any) => m.doc === "customer:alice");
    expect(broadcastsToA).toHaveLength(0);
  });

  test("subsequent open of A's doc is clean (cache not polluted)", async () => {
    const A = mockSocket("A");
    const B = mockSocket("B");
    wirePublish(ws, [A, B]);

    await ws.websocket.message(A, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));
    await ws.websocket.message(B, JSON.stringify({ id: 1, action: "open", doc: "customer:bob" }));

    // B mutates its own doc.
    await ws.websocket.message(B, JSON.stringify({
      id: 2, action: "delta", doc: "customer:bob",
      ops: [{ op: "add", path: "/brands/leak-probe",
              value: { customers_id: "bob", name: "LEAK_PROBE" } }],
    }));

    // Fresh client opens customer:alice — should see no LEAK_PROBE row.
    const C = mockSocket("C");
    wirePublish(ws, [A, B, C]);
    await ws.websocket.message(C, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));

    const brands = C.sent[0].result.brands;
    expect(Object.keys(brands).sort()).toEqual(["b-alice-1"]);
    expect(brands["leak-probe"]).toBeUndefined();
  });

  test("grandchild ops are scope-checked via the parent chain", async () => {
    // Add an artwork to bob's brand. alice's doc must not see it.
    const A = mockSocket("A");
    const B = mockSocket("B");
    wirePublish(ws, [A, B]);

    await ws.websocket.message(A, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));
    await ws.websocket.message(B, JSON.stringify({ id: 1, action: "open", doc: "customer:bob" }));

    A.sent.length = 0;

    await ws.websocket.message(B, JSON.stringify({
      id: 2, action: "delta", doc: "customer:bob",
      ops: [{ op: "add", path: "/artworks/art-bob-1",
              value: { brand_id: "b-bob-1", title: "Bob piece" } }],
    }));

    const broadcastsToA = A.sent.filter((m: any) => m.doc === "customer:alice");
    expect(broadcastsToA).toHaveLength(0);
  });

  test("legitimate same-scope ops still fan out to other open subscribers", async () => {
    // Two clients on the SAME doc (customer:alice). The second add is broadcast
    // by the writer to its own subscribers — the test pins that the scope check
    // didn't break this path.
    const A1 = mockSocket("A1");
    const A2 = mockSocket("A2");
    wirePublish(ws, [A1, A2]);

    await ws.websocket.message(A1, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));
    await ws.websocket.message(A2, JSON.stringify({ id: 1, action: "open", doc: "customer:alice" }));

    A2.sent.length = 0;

    await ws.websocket.message(A1, JSON.stringify({
      id: 2, action: "delta", doc: "customer:alice",
      ops: [{ op: "add", path: "/brands/b-alice-2",
              value: { customers_id: "alice", name: "Second" } }],
    }));

    const broadcastsToA2 = A2.sent.filter((m: any) => m.doc === "customer:alice");
    expect(broadcastsToA2.length).toBeGreaterThanOrEqual(1);
    const ops = broadcastsToA2.flatMap((m: any) => m.ops);
    expect(ops).toContainEqual(expect.objectContaining({
      op: "add", path: "/brands/b-alice-2",
    }));
  });
});

// ---------------------------------------------------------------------------
// An included collection with no parent (todo #2). It has no key to the root,
// so nothing ties a row of it to one document: it is loaded in full, as the
// Postgres backend loads it (`_delta_load_collection`, no parent). Open, the
// fan-out and `loadDocAt` must agree on that.
// ---------------------------------------------------------------------------

describe("an included collection with no parent is loaded in full, on every path", () => {
  const shared = defineSchema({
    lists: { columns: { title: "text?" } },
    tags: { columns: { label: "text" } },          // no parent: shared by every list
  });
  const listDoc = defineDoc("list:", { root: "lists", include: ["tags"] });

  function setup() {
    const db = new Database(":memory:");
    createTables(db, shared);
    db.run(`INSERT INTO lists (id, title, valid_from, valid_to) VALUES ('a', 'A', '${PAST}', NULL), ('b', 'B', '${PAST}', NULL)`);
    db.run(`INSERT INTO tags (id, label, valid_from, valid_to) VALUES ('t1', 'red', '${PAST}', NULL), ('t2', 'blue', '${PAST}', NULL)`);
    const local = createLocal();
    registerDocs(local.server, db, shared, [listDoc]);
    const heard: { channel: string; data: any }[] = [];
    local.onPublish((channel, data) => heard.push({ channel, data }));
    return { db, local, heard };
  }

  test("open holds every row of it, in each document", async () => {
    const { local } = setup();
    expect(Object.keys((await local.call("open", { doc: "list:a" })).result.tags).sort()).toEqual(["t1", "t2"]);
    expect(Object.keys((await local.call("open", { doc: "list:b" })).result.tags).sort()).toEqual(["t1", "t2"]);
  });

  test("a row added through one document is held by the others: heard live, and there when opened afresh", async () => {
    const { local, heard } = setup();
    await local.call("open", { doc: "list:a" });
    await local.call("open", { doc: "list:b" });
    const w = await local.call("delta", { doc: "list:a", ops: [{ op: "add", path: "/tags/t3", value: { label: "green" } }] });
    expect(w.error).toBeUndefined();
    expect(heard.find((h) => h.channel === "list:b")?.data.ops).toEqual([
      { op: "add", path: "/tags/t3", value: expect.objectContaining({ id: "t3", label: "green" }) },
    ]);
    await local.call("close", { doc: "list:b" });
    expect(Object.keys((await local.call("open", { doc: "list:b" })).result.tags).sort()).toEqual(["t1", "t2", "t3"]);
  });

  test("loadDocAt reads it in full too", () => {
    const { db } = setup();
    const doc = loadDocAt(db, shared, listDoc, "a", "2021-01-01 00:00:00");
    expect(Object.keys(doc.tags).sort()).toEqual(["t1", "t2"]);
  });
});
