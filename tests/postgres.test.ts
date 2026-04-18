/**
 * Integration tests for the Postgres backend.
 *
 * Requires a live Postgres on $DELTA_TEST_PG_URL (defaults to the compose
 * service on localhost:5433). Run with:
 *
 *   docker compose up -d --wait
 *   bun test tests/postgres.test.ts
 *   docker compose down -v
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  createDocListener,
  docTypeFromDef,
  defineDoc,
  registerDocType,
  clearRegistry,
  loadDocAt,
  createSnapshot,
  resolveSnapshot,
  pruneOpsLog,
} from "../postgres";
import { createWs } from "../server";
import { setLogLevel } from "../logger";
import {
  PG_URL,
  newPool,
  applyFramework,
  applyItemsFixture,
  resetState,
  waitFor,
  mockClient,
  sendAndAwait,
} from "./setup";

setLogLevel("silent");

let pool: Pool;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await applyItemsFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  clearRegistry();
  await resetState(pool);
  registerDocType(docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool));
});

// ---------------------------------------------------------------------------
// Smoke test — can we reach the database at all?
// ---------------------------------------------------------------------------

describe("postgres connectivity", () => {
  test("pool can query", async () => {
    const { rows } = await pool.query("SELECT 1 AS ok");
    expect(rows[0].ok).toBe(1);
  });

  test("framework tables exist", async () => {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n
      FROM information_schema.tables
      WHERE table_name IN ('_delta_collections', '_delta_docs', '_delta_versions', '_delta_ops_log')
    `);
    expect(rows[0].n).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// docTypeFromDef — open, apply, openAt via the generic handler.
// ---------------------------------------------------------------------------

describe("docTypeFromDef", () => {
  test("open returns empty collection when no rows exist", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    const result = await type.open({}, "items:");
    expect(result).not.toBeNull();
    expect(result!.result).toHaveProperty("items");
    // delta_open returns collections keyed by id: { "1": {...}, "2": {...} }
    expect(typeof result!.result.items).toBe("object");
    expect(Object.keys(result!.result.items).length).toBe(0);
    expect(result!.version).toBe(0);
  });

  test("apply add → open returns the row", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    const applied = await type.apply({}, "items:", [
      { op: "add", path: "/items/-", value: { name: "alpha", value: 1 } },
    ]);
    expect(applied.version).toBeGreaterThan(0);

    const result = await type.open({}, "items:");
    const rows = Object.values(result!.result.items) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("alpha");
    expect(rows[0].value).toBe(1);
  });

  test("apply replace updates the row", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    await type.apply({}, "items:", [
      { op: "add", path: "/items/-", value: { name: "a", value: 1 } },
    ]);
    const { rows } = await pool.query("SELECT id FROM items ORDER BY id DESC LIMIT 1");
    const id = rows[0].id;

    await type.apply({}, "items:", [
      { op: "replace", path: `/items/${id}`, value: { value: 99 } },
    ]);

    const result = await type.open({}, "items:");
    const updated = result!.result.items[String(id)] as any;
    expect(updated.value).toBe(99);
    expect(updated.name).toBe("a");
  });

  test("apply remove deletes the row", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    await type.apply({}, "items:", [
      { op: "add", path: "/items/-", value: { name: "doomed" } },
    ]);
    const { rows } = await pool.query("SELECT id FROM items LIMIT 1");
    const id = rows[0].id;

    await type.apply({}, "items:", [{ op: "remove", path: `/items/${id}` }]);

    const result = await type.open({}, "items:");
    expect(Object.keys(result!.result.items).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createDocListener — end-to-end WS flow: open tracks doc, delta triggers
// NOTIFY, listener fans out via ws.publish.
// ---------------------------------------------------------------------------

describe("createDocListener (end-to-end WS flow)", () => {
  test("open → delta → LISTEN/NOTIFY → ws.publish", async () => {
    const ws = createWs();
    const published: { channel: string; data: any }[] = [];
    ws.publish = (channel: string, data: any) => { published.push({ channel, data }); };

    const listener = await createDocListener(ws, pool);
    try {
      // Open the doc so the listener starts tracking it.
      const reader = mockClient();
      const openRes = await sendAndAwait(ws, reader, { action: "open", doc: "items:" });
      expect(openRes.result).toBeDefined();
      expect(openRes.result).toHaveProperty("items");

      // Apply an op via another client.
      const writer = mockClient();
      const delta = await sendAndAwait(ws, writer, {
        action: "delta",
        doc: "items:",
        ops: [{ op: "add", path: "/items/-", value: { name: "ws-hello" } }],
      });
      expect(delta.result?.ack).toBe(true);
      expect(delta.result?.version).toBeGreaterThan(0);

      // NOTIFY fires asynchronously from Postgres — poll for the publish.
      await waitFor(() => published.length > 0, { timeout: 3000 });
      expect(published[0]!.channel).toBe("items:");
      expect(published[0]!.data.doc).toBe("items:");
      expect(published[0]!.data.ops).toBeDefined();
      expect(Array.isArray(published[0]!.data.ops)).toBe(true);
    } finally {
      await listener.destroy();
    }
  });

  test("delta without doc returns 400", async () => {
    const ws = createWs();
    ws.publish = () => {};
    const listener = await createDocListener(ws, pool);
    try {
      const client = mockClient();
      const res = await sendAndAwait(ws, client, { action: "open" });
      expect(res.error?.code).toBe(400);
      expect(res.error?.message).toMatch(/doc is required/);
    } finally {
      await listener.destroy();
    }
  });

  test("open on unknown prefix returns 404", async () => {
    const ws = createWs();
    ws.publish = () => {};
    const listener = await createDocListener(ws, pool);
    try {
      const client = mockClient();
      const res = await sendAndAwait(ws, client, { action: "open", doc: "ghost:" });
      expect(res.error?.code).toBe(404);
    } finally {
      await listener.destroy();
    }
  });

  test("close → unsubscribes and removes from tracked set", async () => {
    const ws = createWs();
    ws.publish = () => {};
    const listener = await createDocListener(ws, pool);
    try {
      const client = mockClient();
      await sendAndAwait(ws, client, { action: "open", doc: "items:" });
      expect(client.subscriptions.has("items:")).toBe(true);
      const closed = await sendAndAwait(ws, client, { action: "close", doc: "items:" });
      expect(closed.result?.ack).toBe(true);
      expect(client.subscriptions.has("items:")).toBe(false);
    } finally {
      await listener.destroy();
    }
  });

  test("auth gate rejects with 401 when auth is configured and gate returns error", async () => {
    const ws = createWs();
    ws.publish = () => {};
    const listener = await createDocListener(ws, pool, {
      auth: {
        gate: () => ({ error: "no" }),
      },
    });
    try {
      const client = mockClient();
      const res = await sendAndAwait(ws, client, { action: "open", doc: "items:" });
      expect(res.error?.code).toBe(401);
      expect(res.error?.message).toBe("no");
    } finally {
      await listener.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// Snapshots and ops-log maintenance
// ---------------------------------------------------------------------------

describe("snapshots + pruneOpsLog", () => {
  test("loadDocAt accepts a Date and queries the framework", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    await type.apply({}, "items:", [
      { op: "add", path: "/items/-", value: { name: "t1" } },
    ]);
    // `items` is non-temporal, so delta_open_at returns null by contract —
    // we assert the wrapper runs without throwing and returns null cleanly.
    const doc = await loadDocAt(pool, "items:", new Date());
    expect(doc).toBeNull();
  });

  test("createSnapshot + resolveSnapshot round-trip", async () => {
    const ts = await createSnapshot(pool, "pre-op");
    expect(ts).toBeDefined();
    const resolved = await resolveSnapshot(pool, "pre-op");
    expect(resolved).not.toBeNull();
    // Both come back as Date values from pg — compare structurally.
    expect(resolved).toEqual(ts);
  });

  test("resolveSnapshot returns null for an unknown name", async () => {
    const resolved = await resolveSnapshot(pool, "never-saved");
    expect(resolved).toBeNull();
  });

  test("pruneOpsLog returns a non-negative count", async () => {
    const type = docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool);
    await type.apply({}, "items:", [
      { op: "add", path: "/items/-", value: { name: "old" } },
    ]);
    const pruned = await pruneOpsLog(pool, "0 seconds");
    expect(pruned).toBeGreaterThanOrEqual(0);
  });
});
