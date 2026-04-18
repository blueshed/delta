/**
 * Test setup helpers — spin up a pg Pool against the compose-managed
 * Postgres, apply framework SQL files, and clean up between cases.
 *
 * The compose service listens on localhost:5433 (so it won't fight with any
 * local Postgres on :5432). Override with DELTA_TEST_PG_URL if needed.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export const PG_URL =
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

const SQL_DIR = join(import.meta.dir, "..", "postgres", "sql");
const AUTH_JWT_SQL = join(import.meta.dir, "..", "auth-jwt.sql");
const ITEMS_FIXTURE = join(import.meta.dir, "fixtures", "items.sql");

export async function newPool(): Promise<Pool> {
  return new Pool({ connectionString: PG_URL, max: 8 });
}

async function applyFile(pool: Pool, path: string): Promise<void> {
  const sql = readFileSync(path, "utf8");
  await pool.query(sql);
}

/** Apply the delta framework SQL (001*) in alphabetical order. */
export async function applyFramework(pool: Pool): Promise<void> {
  const files = readdirSync(SQL_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await applyFile(pool, join(SQL_DIR, f));
}

/** Apply the auth-jwt reference schema (users + login/register). */
export async function applyAuthJwt(pool: Pool): Promise<void> {
  await applyFile(pool, AUTH_JWT_SQL);
}

/** Apply the items fixture used by postgres.test.ts. */
export async function applyItemsFixture(pool: Pool): Promise<void> {
  await applyFile(pool, ITEMS_FIXTURE);
}

/**
 * Reset all delta/test state so tests can run independently. Truncates the
 * framework's bookkeeping tables and the test-data tables. Cheap compared
 * to tearing down the container.
 */
export async function resetState(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('items') IS NOT NULL THEN
        EXECUTE 'TRUNCATE items RESTART IDENTITY CASCADE';
      END IF;
      IF to_regclass('users') IS NOT NULL THEN
        EXECUTE 'TRUNCATE users RESTART IDENTITY CASCADE';
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

/** Wait for a predicate to return truthy. Defaults to 2s overall budget. */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 2000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timeout${last ? `: ${String(last)}` : ""}`);
}

// ---------------------------------------------------------------------------
// Mock WS client — fulfils the surface `createWs()` callbacks expect.
// ---------------------------------------------------------------------------

export interface MockClient {
  data: Record<string, unknown>;
  sent: any[];
  subscriptions: Set<string>;
  readyState: number;
  send(msg: string): void;
  subscribe(ch: string): void;
  unsubscribe(ch: string): void;
}

export function mockClient(data: Record<string, unknown> = {}): MockClient {
  return {
    data,
    sent: [],
    subscriptions: new Set<string>(),
    readyState: 1,
    send(msg: string) { this.sent.push(JSON.parse(msg)); },
    subscribe(ch: string) { this.subscriptions.add(ch); },
    unsubscribe(ch: string) { this.subscriptions.delete(ch); },
  };
}

/**
 * Drive a single message through a WsServer's `websocket.message` handler
 * and wait for the matching response on `client.sent`. Identifies the
 * response via `{ id }`; assigns an id if the caller omits one.
 */
export async function sendAndAwait(
  ws: { websocket: { message: (ws: any, raw: any) => any } },
  client: MockClient,
  msg: any,
  { timeout = 3000 }: { timeout?: number } = {},
): Promise<any> {
  const id = msg.id ?? Math.floor(Math.random() * 1e9);
  const before = client.sent.length;
  await ws.websocket.message(client, JSON.stringify({ ...msg, id }));
  return waitFor(
    () => client.sent.slice(before).find((m: any) => m.id === id),
    { timeout },
  );
}
