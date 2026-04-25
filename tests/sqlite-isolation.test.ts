/**
 * Property tests: per-doc isolation in the SQLite backend.
 *
 * Drives the shared isolation harness against several schemas to prove
 * registerDocs doesn't leak rows between sibling docs of the same prefix.
 * Coverage spans:
 *   - flat parent-child (project: with tasks)
 *   - multi-collection FK (customer: with brands)
 *   - grandchild via FK chain (customer: with artworks under brands)
 *   - all three op verbs (add / replace / remove)
 */
import { describe, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  defineSchema, defineDoc, createTables, registerDocs,
  type Schema, type DocDef,
} from "../src/server/sqlite";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import {
  assertDocIsolation,
  type IsolationHarness,
  type OpenedDoc,
} from "./helpers/isolation";

setLogLevel("silent");

const PAST = "2020-01-01 00:00:00";

// ---------------------------------------------------------------------------
// SQLite-side adapter for the isolation harness.
// ---------------------------------------------------------------------------

function makeSqliteHarness(ws: WsServer): IsolationHarness {
  let nextClientId = 0;
  const clients: any[] = [];

  ws.setServer({
    publish: (channel: string, raw: string) => {
      for (const c of clients) if (c.subscriptions.has(channel)) c.send(raw);
    },
  });

  function mockSocket() {
    const sent: any[] = [];
    const subs = new Set<string>();
    const sock = {
      data: { clientId: `c${nextClientId++}` },
      readyState: 1,
      send: (raw: string) => sent.push(JSON.parse(raw)),
      subscribe: (ch: string) => subs.add(ch),
      unsubscribe: (ch: string) => subs.delete(ch),
      sent,
      subscriptions: subs,
    };
    clients.push(sock);
    return sock;
  }

  return {
    async open(docName: string): Promise<OpenedDoc> {
      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({
        id: 1, action: "open", doc: docName,
      }));
      const openMsg = sock.sent.find((m: any) => m.id === 1);
      if (!openMsg || !openMsg.result) {
        throw new Error(`open ${docName} failed: ${JSON.stringify(openMsg)}`);
      }
      return { sent: sock.sent, snapshot: openMsg.result, client: sock };
    },
    async delta(client: unknown, docName: string, ops: any[]): Promise<void> {
      const sock = client as any;
      await ws.websocket.message(sock, JSON.stringify({
        id: 99, action: "delta", doc: docName, ops,
      }));
      const ack = sock.sent.find((m: any) => m.id === 99);
      if (ack?.error) throw new Error(`delta failed: ${JSON.stringify(ack.error)}`);
    },
  };
}

// ---------------------------------------------------------------------------
// Schemas under test
// ---------------------------------------------------------------------------

const projectSchema: Schema = defineSchema({
  projects: { columns: { name: "text" } },
  tasks: {
    parent: { collection: "projects", fk: "project_id" },
    columns: { title: "text" },
  },
});
const projectDoc: DocDef = defineDoc("project:", { root: "projects", include: ["tasks"] });

const customerSchema: Schema = defineSchema({
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
const customerDoc: DocDef = defineDoc("customer:", {
  root: "customers",
  include: ["brands", "artworks"],
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isolation: project: (single child collection)", () => {
  let ws: WsServer;
  let h: IsolationHarness;

  beforeEach(() => {
    const db = new Database(":memory:");
    createTables(db, projectSchema);
    db.run("INSERT INTO projects (id, name, valid_from) VALUES ('alpha', 'Alpha', ?)", [PAST]);
    db.run("INSERT INTO projects (id, name, valid_from) VALUES ('beta',  'Beta',  ?)", [PAST]);
    ws = createWs();
    registerDocs(ws, db, projectSchema, [projectDoc]);
    h = makeSqliteHarness(ws);
  });

  test("add to writer doesn't leak to bystander", async () => {
    await assertDocIsolation(h, {
      bystander: "project:alpha",
      writer: "project:beta",
      mutateOps: [{
        op: "add", path: "/tasks/leak-1",
        value: { project_id: "beta", title: "leak" },
      }],
      affectedCollection: "tasks",
      leakedId: "leak-1",
    });
  });
});

describe("isolation: customer: (FK chain, multiple collections, all op verbs)", () => {
  let ws: WsServer;
  let h: IsolationHarness;

  beforeEach(() => {
    const db = new Database(":memory:");
    createTables(db, customerSchema);
    db.run("INSERT INTO customers (id, name, valid_from) VALUES ('alice', 'Alice', ?)", [PAST]);
    db.run("INSERT INTO customers (id, name, valid_from) VALUES ('bob',   'Bob',   ?)", [PAST]);
    db.run("INSERT INTO brands (id, customers_id, name, valid_from) VALUES ('b-bob-1', 'bob', 'BobBrand', ?)", [PAST]);
    db.run("INSERT INTO artworks (id, brand_id, title, valid_from) VALUES ('a-bob-1', 'b-bob-1', 'BobArt', ?)", [PAST]);
    ws = createWs();
    registerDocs(ws, db, customerSchema, [customerDoc]);
    h = makeSqliteHarness(ws);
  });

  test("add of bob's child doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: "customer:alice",
      writer: "customer:bob",
      mutateOps: [{
        op: "add", path: "/brands/leak-brand",
        value: { customers_id: "bob", name: "LEAK" },
      }],
      affectedCollection: "brands",
      leakedId: "leak-brand",
    });
  });

  test("add of bob's grandchild doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: "customer:alice",
      writer: "customer:bob",
      mutateOps: [{
        op: "add", path: "/artworks/leak-art",
        value: { brand_id: "b-bob-1", title: "LEAK" },
      }],
      affectedCollection: "artworks",
      leakedId: "leak-art",
    });
  });

  test("replace of bob's child field doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: "customer:alice",
      writer: "customer:bob",
      mutateOps: [{
        op: "replace", path: "/brands/b-bob-1/name", value: "Renamed",
      }],
      affectedCollection: "brands",
      leakedId: "b-bob-1",
    });
  });

  test("remove of bob's child doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: "customer:alice",
      writer: "customer:bob",
      mutateOps: [{ op: "remove", path: "/brands/b-bob-1" }],
      affectedCollection: "brands",
      leakedId: "b-bob-1",
    });
  });
});
