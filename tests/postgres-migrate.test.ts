/**
 * Migrations on a Postgres server: two processes starting at once take turns
 * on an advisory lock, so each migration runs once and neither fails. Needs
 * the compose Postgres (`bun run db:up`); the rest of the rules run on PGlite
 * in tests/migrate.test.ts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Pool, PoolClient } from "pg";
import { migrate, type Migration } from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";
import { newPool } from "./setup";

setLogLevel("silent");

let one: Pool;
let two: Pool;
const clean = (pool: Pool) => pool.query("DROP TABLE IF EXISTS delta_migrations, migrate_runs");

beforeAll(async () => {
  one = await newPool();
  two = await newPool();
  await clean(one);
  await one.query("CREATE TABLE migrate_runs (id TEXT NOT NULL)");   // an app table: the database is not new
});
afterAll(async () => {
  await clean(one);
  await one.end();
  await two.end();
});

test("two processes starting at once run each migration once, in order, and both start", async () => {
  const slow = (id: string): Migration<PoolClient> => ({
    id,
    up: async (tx) => {
      await tx.query("SELECT pg_sleep(0.2)");
      await tx.query("INSERT INTO migrate_runs (id) VALUES ($1)", [id]);
    },
  });
  const list = [slow("001-a"), slow("002-b")];
  const [a, b] = await Promise.all([migrate(one, list), migrate(two, list)]);
  expect([...a.ran, ...b.ran].toSorted()).toEqual(["001-a", "002-b"]);
  expect((await one.query("SELECT id FROM migrate_runs ORDER BY ctid")).rows.map((r) => r.id)).toEqual(["001-a", "002-b"]);
  expect((await one.query("SELECT id FROM delta_migrations ORDER BY ran_at")).rows.map((r) => r.id)).toEqual(["001-a", "002-b"]);
});
