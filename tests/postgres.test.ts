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
} from "../src/server/postgres";
import { createWs } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
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

// ---------------------------------------------------------------------------
// Fail-fast — config errors must raise, not silently return NULL
// ---------------------------------------------------------------------------

describe("fail-fast on config errors", () => {
  test("delta_open raises when the doc prefix is not registered", async () => {
    await expect(
      pool.query("SELECT delta_open($1) AS doc", ["bogus:42"]),
    ).rejects.toThrow(/no doc def for: bogus:42/);
  });

  test("delta_open raises when the doc's root_collection is unknown", async () => {
    // Hand-insert a bad doc def so the "unknown root collection" branch fires.
    await pool.query(`
      INSERT INTO _delta_docs (prefix, root_collection, include, scope)
      VALUES ('ghost:', 'no_such_collection', '{}', '{}')
      ON CONFLICT (prefix) DO UPDATE SET root_collection = EXCLUDED.root_collection
    `);
    try {
      await expect(
        pool.query("SELECT delta_open($1) AS doc", ["ghost:1"]),
      ).rejects.toThrow(/unknown root collection: no_such_collection/);
    } finally {
      await pool.query("DELETE FROM _delta_docs WHERE prefix = 'ghost:'");
    }
  });

  test("_delta_resolve_scope raises when a scope key isn't a real column", async () => {
    // "items.id" is the dotted-key footgun — not a column of the items table.
    await pool.query(`
      INSERT INTO _delta_docs (prefix, root_collection, include, scope)
      VALUES ('bad:', 'items', '{}', '{"items.id":":id"}')
      ON CONFLICT (prefix) DO UPDATE SET scope = EXCLUDED.scope
    `);
    try {
      await expect(
        pool.query("SELECT delta_open($1) AS doc", ["bad:1"]),
      ).rejects.toThrow(/scope key "items\.id" is not a column of "items"/);
    } finally {
      await pool.query("DELETE FROM _delta_docs WHERE prefix = 'bad:'");
    }
  });
});

// ---------------------------------------------------------------------------
// Scope DSL — each operator produces the right WHERE / mode
// ---------------------------------------------------------------------------

describe("scope DSL operators", () => {
  async function registerScope(prefix: string, scope: Record<string, string>) {
    await pool.query(
      `INSERT INTO _delta_docs (prefix, root_collection, include, scope)
       VALUES ($1, 'items', '{}', $2::jsonb)
       ON CONFLICT (prefix) DO UPDATE SET scope = EXCLUDED.scope`,
      [prefix, JSON.stringify(scope)],
    );
  }
  async function cleanup(prefix: string) {
    await pool.query("DELETE FROM _delta_docs WHERE prefix = $1", [prefix]);
  }
  async function resolve(prefix: string, docName: string) {
    const { rows } = await pool.query(
      `SELECT _delta_resolve_scope(d, $1) AS r FROM _delta_docs d WHERE prefix = $2`,
      [docName, prefix],
    );
    return rows[0].r as { where: string; mode: string; values: Record<string, unknown>; at: string | null };
  }

  // Identifiers come out unquoted when they don't require quoting ("id", "name"
  // are safe bare); %L always single-quotes the literal.

  test("':id' shorthand → col = <id>, single mode", async () => {
    await registerScope("s1:", { id: ":id" });
    try {
      const r = await resolve("s1:", "s1:42");
      expect(r.where).toBe("id = '42'");
      expect(r.mode).toBe("single");
      expect(r.values.id).toBe("42");
    } finally { await cleanup("s1:"); }
  });

  test("'=:name' → col = <name>, list mode if key isn't 'id'", async () => {
    await registerScope("s2:", { name: "=:name" });
    try {
      const r = await resolve("s2:", "s2:hello");
      expect(r.where).toBe("name = 'hello'");
      expect(r.mode).toBe("list");
    } finally { await cleanup("s2:"); }
  });

  test("'>=:start' → col >= <param>", async () => {
    await registerScope("s3:", { value: ">=:start" });
    try {
      const r = await resolve("s3:", "s3:5");
      expect(r.where).toBe("value >= '5'");
      expect(r.mode).toBe("list");
    } finally { await cleanup("s3:"); }
  });

  test("'<=:end' → col <= <param>", async () => {
    await registerScope("s4:", { value: "<=:end" });
    try {
      const r = await resolve("s4:", "s4:10");
      expect(r.where).toBe("value <= '10'");
      expect(r.mode).toBe("list");
    } finally { await cleanup("s4:"); }
  });

  test("'like:prefix' → col ILIKE '<param>%'", async () => {
    await registerScope("s5:", { name: "like:prefix" });
    try {
      const r = await resolve("s5:", "s5:foo");
      expect(r.where).toBe("name ILIKE 'foo%'");
      expect(r.mode).toBe("list");
    } finally { await cleanup("s5:"); }
  });

  test("multiple scope keys are AND'd", async () => {
    await registerScope("s6:", { id: ":id", name: "=:name" });
    try {
      const r = await resolve("s6:", "s6:7:hello");
      expect(r.where).toContain("id = '7'");
      expect(r.where).toContain("name = 'hello'");
      expect(r.where).toContain(" AND ");
      expect(r.mode).toBe("single");  // 'id' equality → single mode
    } finally { await cleanup("s6:"); }
  });

  test("empty scope with an id in the doc name → defaults to WHERE id = <id>", async () => {
    await registerScope("s7:", {});
    try {
      const r = await resolve("s7:", "s7:99");
      expect(r.where).toMatch(/id = '99'/);
      expect(r.mode).toBe("single");
    } finally { await cleanup("s7:"); }
  });

  test("junk operators (e.g. '<<<:x') raise rather than silently producing bad SQL", async () => {
    await registerScope("bad-op:", { name: "<<<:foo" });
    try {
      await expect(resolve("bad-op:", "bad-op:hello")).rejects.toThrow(
        /invalid scope operator/,
      );
    } finally { await cleanup("bad-op:"); }
  });

  test("'at:when' → populates r.at, not WHERE (temporal snapshot marker)", async () => {
    // `at:` is a sentinel that feeds delta_open_at's `at` parameter rather
    // than adding to the WHERE — scope resolution just pulls it out.
    await registerScope("at-op:", { valid_from: "at:when" });
    try {
      const r = await resolve("at-op:", "at-op:2026-06-01");
      expect(r.at).toBe("2026-06-01");
      // No WHERE contribution — the 'at' op short-circuits the filter branch.
      expect(r.where).not.toContain("valid_from");
    } finally { await cleanup("at-op:"); }
  });

  test("empty scope with no id in the doc name → list mode, WHERE TRUE", async () => {
    await registerScope("s8:", {});
    try {
      const r = await resolve("s8:", "s8:");
      expect(r.where).toBe("TRUE");
      expect(r.mode).toBe("list");
    } finally { await cleanup("s8:"); }
  });

  test("delta_open_at returns historical state before the replace landed", async () => {
    // Register a temporal collection + a scoped-single doc. Can't piggyback
    // on the `items` fixture — that one is non-temporal.
    await pool.query(`
      CREATE SEQUENCE IF NOT EXISTS seq_items_t;
      CREATE TABLE IF NOT EXISTS items_t (
        id         BIGINT NOT NULL DEFAULT nextval('seq_items_t'),
        name       TEXT NOT NULL,
        value      INTEGER NOT NULL DEFAULT 0,
        valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        valid_to   TIMESTAMPTZ,
        PRIMARY KEY (id, valid_from)
      );
      CREATE OR REPLACE VIEW current_items_t AS
        SELECT * FROM items_t WHERE valid_to IS NULL;
      INSERT INTO _delta_collections (collection_key, table_name, columns_def, temporal)
      VALUES ('items_t', 'items_t',
              '{"name":{"type":"text","nullable":false},
                "value":{"type":"integer","nullable":false,"default":0}}'::jsonb,
              TRUE)
      ON CONFLICT (collection_key) DO UPDATE SET temporal = EXCLUDED.temporal;
      INSERT INTO _delta_docs (prefix, root_collection, include, scope)
      VALUES ('t:', 'items_t', '{}', '{}')
      ON CONFLICT (prefix) DO UPDATE SET scope = EXCLUDED.scope;
    `);

    try {
      const type = docTypeFromDef(
        defineDoc("t:", { root: "items_t", include: [] }),
        pool,
      );

      // Add a row.
      await type.apply({}, "t:", [
        { op: "add", path: "/items_t/-", value: { name: "original", value: 1 } },
      ]);
      const { rows } = await pool.query(
        "SELECT id FROM current_items_t WHERE name = 'original'",
      );
      const id = rows[0].id as string;

      // Capture a timestamp BETWEEN the add and the replace.
      await new Promise((r) => setTimeout(r, 10));
      const snapshotAt = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));

      // Update the row — temporal tables will retain the old version.
      await type.apply({}, "t:", [
        { op: "replace", path: `/items_t/${id}/name`, value: "updated" },
      ]);

      // Current state sees the update; snapshotAt sees the original.
      const current = await loadDocAt(pool, `t:${id}`, new Date().toISOString());
      expect(current?.items_t?.name).toBe("updated");

      const historical = await loadDocAt(pool, `t:${id}`, snapshotAt);
      expect(historical?.items_t?.name).toBe("original");
    } finally {
      await pool.query(`
        DELETE FROM _delta_docs WHERE prefix = 't:';
        DELETE FROM _delta_collections WHERE collection_key = 'items_t';
        DROP VIEW IF EXISTS current_items_t;
        DROP TABLE IF EXISTS items_t;
        DROP SEQUENCE IF EXISTS seq_items_t;
      `);
    }
  });

  test("':id' end-to-end — delta_open('p:N') returns only rows where id=N", async () => {
    await registerScope("endto:", { id: ":id" });
    try {
      // Seed a couple of rows, then open by id.
      await pool.query("INSERT INTO items (name, value) VALUES ('a', 1), ('b', 2), ('c', 3)");
      const { rows: ids } = await pool.query("SELECT id FROM items ORDER BY id");
      const target = ids[1].id;   // middle row

      const { rows } = await pool.query(
        "SELECT delta_open($1) AS doc",
        [`endto:${target}`],
      );
      const doc = rows[0].doc;
      expect(doc).not.toBeNull();
      // Single mode puts the row under the root_collection key.
      expect(doc.items).toBeDefined();
      expect(Number(doc.items.id)).toBe(Number(target));
      expect(doc.items.name).toBe("b");
    } finally { await cleanup("endto:"); }
  });
});
