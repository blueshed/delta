/**
 * Property tests: per-doc isolation in the Postgres backend.
 *
 * The architecture-level reason isolation holds for Postgres is that
 * `delta_apply` emits NOTIFY tagged with the writer's docName, and the
 * listener publishes only to subscribers of that exact channel. There's
 * no cross-doc fan-out path. This suite pins that down so a future
 * refactor can't reintroduce the leak the SQLite backend hit.
 */
import { describe, test, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import {
  createDocListener,
  defineDoc,
  docTypeFromDef,
  registerDocType,
  clearRegistry,
} from "../src/server/postgres";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework, mockClient, sendAndAwait } from "./setup";
import {
  assertDocIsolation,
  type IsolationHarness,
  type OpenedDoc,
} from "./helpers/isolation";

setLogLevel("silent");

const FIXTURE = join(import.meta.dir, "fixtures", "customers.sql");

let pool: Pool;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query(readFileSync(FIXTURE, "utf8"));
});

afterAll(async () => {
  await pool.end();
});

async function reset(): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('artworks') IS NOT NULL THEN EXECUTE 'TRUNCATE artworks RESTART IDENTITY CASCADE'; END IF;
      IF to_regclass('brands')   IS NOT NULL THEN EXECUTE 'TRUNCATE brands   RESTART IDENTITY CASCADE'; END IF;
      IF to_regclass('customers') IS NOT NULL THEN EXECUTE 'TRUNCATE customers RESTART IDENTITY CASCADE'; END IF;
      IF to_regclass('_delta_versions') IS NOT NULL THEN EXECUTE 'TRUNCATE _delta_versions'; END IF;
      IF to_regclass('_delta_ops_log')  IS NOT NULL THEN EXECUTE 'TRUNCATE _delta_ops_log RESTART IDENTITY'; END IF;
    END $$;
  `);
}

// ---------------------------------------------------------------------------
// Postgres harness for the shared isolation property
// ---------------------------------------------------------------------------

function makePgHarness(ws: WsServer): IsolationHarness {
  const clients: any[] = [];
  ws.setServer({
    publish: (channel: string, raw: string) => {
      for (const c of clients) if (c.subscriptions.has(channel)) c.send(raw);
    },
  });

  return {
    async open(docName: string): Promise<OpenedDoc> {
      const c = mockClient({ clientId: `c${clients.length}` });
      clients.push(c);
      const res = await sendAndAwait(ws, c, { action: "open", doc: docName });
      if (res?.error) throw new Error(`open ${docName} failed: ${JSON.stringify(res.error)}`);
      return { sent: c.sent, snapshot: res.result, client: c };
    },
    async delta(client: unknown, docName: string, ops: any[]): Promise<void> {
      const res = await sendAndAwait(ws, client as any, {
        action: "delta", doc: docName, ops,
      });
      if (res?.error) throw new Error(`delta failed: ${JSON.stringify(res.error)}`);
    },
    async flush(): Promise<void> {
      // LISTEN/NOTIFY round-trip — give it a beat.
      await new Promise((r) => setTimeout(r, 250));
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let ws: WsServer;
let listener: Awaited<ReturnType<typeof createDocListener>>;
let h: IsolationHarness;
// Stable BIGINT ids assigned in beforeEach; postgres path uses numeric ids.
let aliceId: string;
let bobId: string;
let bobBrandId: string;

beforeEach(async () => {
  clearRegistry();
  await reset();
  registerDocType(docTypeFromDef(
    defineDoc("customer:", { root: "customers", include: ["brands", "artworks"] }),
    pool,
  ));
  ws = createWs();
  listener = await createDocListener(ws, pool);
  h = makePgHarness(ws);

  // Seed two customers, one bob-owned brand, one bob-owned artwork.
  const a = await pool.query("INSERT INTO customers (name) VALUES ('Alice') RETURNING id::text");
  const b = await pool.query("INSERT INTO customers (name) VALUES ('Bob')   RETURNING id::text");
  aliceId = a.rows[0].id;
  bobId = b.rows[0].id;

  const br = await pool.query(
    "INSERT INTO brands (customers_id, name) VALUES ($1, 'BobBrand') RETURNING id::text",
    [bobId],
  );
  bobBrandId = br.rows[0].id;
  await pool.query(
    "INSERT INTO artworks (brand_id, title) VALUES ($1, 'BobArt')",
    [bobBrandId],
  );
});

afterEach(async () => {
  await listener.destroy();
});

// ---------------------------------------------------------------------------
// Property checks
// ---------------------------------------------------------------------------

describe("postgres isolation: customer: (FK chain)", () => {
  test("add of bob's child doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: `customer:${aliceId}`,
      writer: `customer:${bobId}`,
      mutateOps: [{
        op: "add", path: "/brands/9001",
        value: { customers_id: bobId, name: "LEAK" },
      }],
      affectedCollection: "brands",
      leakedId: "9001",
    });
  });

  test("add of bob's grandchild doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: `customer:${aliceId}`,
      writer: `customer:${bobId}`,
      mutateOps: [{
        op: "add", path: "/artworks/9002",
        value: { brand_id: bobBrandId, title: "LEAK" },
      }],
      affectedCollection: "artworks",
      leakedId: "9002",
    });
  });

  test("replace of bob's child field doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: `customer:${aliceId}`,
      writer: `customer:${bobId}`,
      mutateOps: [{
        op: "replace", path: `/brands/${bobBrandId}/name`, value: "Renamed",
      }],
      affectedCollection: "brands",
      leakedId: bobBrandId,
    });
  });

  test("remove of bob's child doesn't leak to alice", async () => {
    await assertDocIsolation(h, {
      bystander: `customer:${aliceId}`,
      writer: `customer:${bobId}`,
      mutateOps: [{ op: "remove", path: `/brands/${bobBrandId}` }],
      affectedCollection: "brands",
      leakedId: bobBrandId,
    });
  });
});
