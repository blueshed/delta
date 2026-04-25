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
  defineSchema, defineDoc, createTables, registerDocs,
} from "../src/server/sqlite";
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
