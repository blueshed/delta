/**
 * Regression tests for findings from the 0.4.12 deep review.
 *
 * Requires a live Postgres on $DELTA_TEST_PG_URL (see CLAUDE.md for the
 * Docker-free local setup). Each test below pins a specific reviewed
 * behaviour so a future change is forced to acknowledge it:
 *
 *   Finding #2 (security) — custom docs bypass `auth.gate()`. Expressed as
 *     a `test.failing` asserting the DESIRED secure behaviour: it stays green
 *     while the bypass exists, and flips to a hard failure the moment the
 *     gate is enforced — at which point the marker should be removed.
 *
 *   Finding #1 (consistency) — concurrent writes to the same field are
 *     last-writer-wins with no conflict signal. This is the protocol's
 *     actual concurrency model, so it's a plain characterization test
 *     documenting that neither writer is told its edit was overwritten.
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
import type { DeltaAuth } from "../src/server/auth";
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

// Shared per-test wiring — reassigned in each describe's beforeEach.
let ws: WsServer;
let listener: Awaited<ReturnType<typeof createDocListener>>;
const clients: any[] = [];

function makeClient(id: string, identity?: unknown) {
  const data = identity === undefined ? { clientId: id } : { clientId: id, identity };
  const c = mockClient(data);
  clients.push(c);
  return c;
}

/** Stand up a fresh WsServer + listener whose publish routes to `clients`. */
async function startListener(opts: Parameters<typeof createDocListener>[2]) {
  ws = createWs();
  ws.setServer({
    // The real server JSON-stringifies before publish (server.ts:97-98),
    // so `raw` here is already a JSON string — mirror that.
    publish: (channel: string, raw: any) => {
      for (const c of clients) if (c.subscriptions.has(channel)) c.send(raw);
    },
  });
  listener = await createDocListener(ws, pool, opts);
}

async function resetSites(): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('sites') IS NOT NULL THEN EXECUTE 'TRUNCATE sites RESTART IDENTITY CASCADE'; END IF;
      IF to_regclass('worlds') IS NOT NULL THEN EXECUTE 'TRUNCATE worlds RESTART IDENTITY CASCADE'; END IF;
      IF to_regclass('_delta_versions') IS NOT NULL THEN EXECUTE 'TRUNCATE _delta_versions'; END IF;
      IF to_regclass('_delta_ops_log') IS NOT NULL THEN EXECUTE 'TRUNCATE _delta_ops_log RESTART IDENTITY'; END IF;
    END $$;
  `);
}

async function seedWorld(): Promise<string> {
  const { rows } = await pool.query("INSERT INTO worlds (label) VALUES ('Earth') RETURNING id::text");
  return rows[0].id as string;
}

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query(readFileSync(SITES_FIXTURE, "utf8"));
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  await listener?.destroy();
  clients.length = 0;
});

// A bounding-box custom doc identical in spirit to the sites-bbox example.
const sitesInBbox: CustomDocDef<{ minLng: number; minLat: number; maxLng: number; maxLat: number }> =
  defineCustomDoc("sites-in-bbox:", {
    watch: ["sites"],
    parse: (docId) => {
      const [minLng, minLat, maxLng, maxLat] = docId.split(",").map(Number);
      return { minLng: minLng!, minLat: minLat!, maxLng: maxLng!, maxLat: maxLat! };
    },
    query: async (p, c) => {
      const { rows } = await p.query(
        "SELECT id::text, world_id::text, name, lat, lng FROM sites WHERE lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4",
        [c.minLng, c.maxLng, c.minLat, c.maxLat],
      );
      return { sites: rows };
    },
    matches: (_coll, row, c) =>
      row.lng >= c.minLng && row.lng <= c.maxLng && row.lat >= c.minLat && row.lat <= c.maxLat,
  });

// ===========================================================================
// Finding #2 — custom docs bypass auth.gate() (listener.ts:305-333)
// ===========================================================================

describe("Finding #2: custom docs and auth.gate()", () => {
  // An auth module that rejects any connection without an identity on it.
  const requireIdentity: DeltaAuth<{ id: number }> = {
    gate(client) {
      return (client.data?.identity as { id: number } | undefined) ?? { error: "Authentication required" };
    },
    asSqlArg: (i) => i.id,
  };

  beforeEach(async () => {
    clearRegistry();
    await resetSites();
    registerDocType(
      docTypeFromDef(defineDoc("world:", { root: "worlds", include: ["sites"] }), pool, { auth: requireIdentity }),
    );
    await startListener({ auth: requireIdentity, custom: [sitesInBbox] });
    await seedWorld();
  });

  test("control: the STANDARD doc path enforces the gate (401 unauthenticated)", async () => {
    const anon = makeClient("anon");
    const res = await sendAndAwait(ws, anon, { action: "open", doc: "world:1" });
    expect(res.error?.code).toBe(401);
    expect(res.result).toBeUndefined();
  });

  // DESIRED behaviour, marked `.failing` because the bypass still exists.
  // An unauthenticated open of a custom-doc prefix SHOULD be rejected the
  // same way the standard path is. Today the custom handler responds before
  // ever calling auth.gate() and runs def.query on the bare pool, so the
  // open succeeds and this assertion fails — which keeps the suite green.
  // When the gate is added to the custom path, this starts passing and Bun
  // reports it as "expected to fail but passed": remove `.failing` then.
  test.failing("custom-doc open should ALSO enforce the gate (currently bypassed)", async () => {
    const anon = makeClient("anon");
    const res = await sendAndAwait(ws, anon, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    expect(res.error?.code).toBe(401);
  });

  // Green companion that nails down exactly what happens today, so the gap
  // is visible in a passing test and not only in a `.failing` marker.
  test("documents the gap: unauthenticated custom-doc open returns data", async () => {
    const anon = makeClient("anon");
    const res = await sendAndAwait(ws, anon, { action: "open", doc: "sites-in-bbox:0,0,50,50" });
    expect(res.error).toBeUndefined();
    expect(res.result).toBeDefined();
    expect(res.result.sites).toEqual({}); // no rows yet, but a payload was served
  });
});

// ===========================================================================
// Finding #1 — concurrent writes are last-writer-wins, no conflict signal
// ===========================================================================

describe("Finding #1: concurrent writes to the same field", () => {
  let worldId: string;

  beforeEach(async () => {
    clearRegistry();
    await resetSites();
    registerDocType(
      docTypeFromDef(defineDoc("world:", { root: "worlds", include: ["sites"] }), pool),
    );
    await startListener({});
    worldId = await seedWorld();
  });

  test("two clients overwriting one field: both ack, the loser is silently dropped", async () => {
    const doc = `world:${worldId}`;

    // Seed a site both clients will fight over.
    const setup = makeClient("setup");
    await sendAndAwait(ws, setup, { action: "open", doc });
    await sendAndAwait(ws, setup, {
      action: "delta", doc,
      ops: [{ op: "add", path: "/sites/700", value: { name: "original", lat: 10, lng: 20 } }],
    });

    // Two clients both loaded the same base state and write the same field.
    const a = makeClient("a");
    const b = makeClient("b");
    await sendAndAwait(ws, a, { action: "open", doc });
    await sendAndAwait(ws, b, { action: "open", doc });

    // Fire concurrently — there is no base-version / If-Match token in the
    // protocol, so neither write can be rejected on the basis of the other.
    const [ra, rb] = await Promise.all([
      sendAndAwait(ws, a, { action: "delta", doc, ops: [{ op: "replace", path: "/sites/700/name", value: "A-wins" }] }),
      sendAndAwait(ws, b, { action: "delta", doc, ops: [{ op: "replace", path: "/sites/700/name", value: "B-wins" }] }),
    ]);

    // Both writers are told they succeeded — neither learns it was overwritten.
    expect(ra.error).toBeUndefined();
    expect(rb.error).toBeUndefined();
    expect(ra.result.ack).toBe(true);
    expect(rb.result.ack).toBe(true);

    // The stored value is exactly one writer's — last-writer-wins, not a
    // merge and not a conflict. The other edit is silently lost.
    const reader = makeClient("reader");
    const open = await sendAndAwait(ws, reader, { action: "open", doc });
    const finalName = open.result.sites["700"].name;
    expect(["A-wins", "B-wins"]).toContain(finalName);
  });

  test("a stale-base overwrite still succeeds (no optimistic-concurrency check)", async () => {
    const doc = `world:${worldId}`;
    const writer = makeClient("writer");
    await sendAndAwait(ws, writer, { action: "open", doc });
    await sendAndAwait(ws, writer, {
      action: "delta", doc,
      ops: [{ op: "add", path: "/sites/800", value: { name: "v1", lat: 1, lng: 2 } }],
    });

    // Someone else advances the row to v2.
    await sendAndAwait(ws, writer, {
      action: "delta", doc, ops: [{ op: "replace", path: "/sites/800/name", value: "v2" }],
    });

    // A client that only ever saw v1 writes again. With no version guard the
    // server cannot tell this edit was made against stale state — it applies.
    const stale = makeClient("stale");
    const res = await sendAndAwait(ws, stale, {
      action: "delta", doc, ops: [{ op: "replace", path: "/sites/800/name", value: "v3-from-stale-base" }],
    });
    expect(res.error).toBeUndefined();
    expect(res.result.ack).toBe(true);

    const reader = makeClient("reader");
    const open = await sendAndAwait(ws, reader, { action: "open", doc });
    expect(open.result.sites["800"].name).toBe("v3-from-stale-base");
  });
});
