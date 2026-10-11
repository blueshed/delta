/**
 * Test setup helpers — spin up a pg Pool against the compose-managed
 * Postgres, apply framework SQL files, and clean up between cases. The helpers
 * that need no Postgres (mockClient, sendAndAwait, waitFor) are the package's
 * own `@blueshed/delta/testing` (src/testing.ts).
 *
 * The compose service listens on localhost:5433 (so it won't fight with any
 * local Postgres on :5432). Override with DELTA_TEST_PG_URL if needed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { applyFramework as applyFrameworkFromPkg } from "../src/server/postgres";
import { applyAuthJwtSchema } from "../src/server/auth-jwt";

export const PG_URL =
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

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
  await applyFrameworkFromPkg(pool);
}

/** Apply the auth-jwt reference schema (users + login/register). */
export async function applyAuthJwt(pool: Pool): Promise<void> {
  await applyAuthJwtSchema(pool);
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
        -- delta's serial is not owned by the table (RESTART IDENTITY leaves it): each test names ids anew (#71)
        EXECUTE 'ALTER SEQUENCE seq_items RESTART';
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
      IF to_regclass('_delta_ledger') IS NOT NULL THEN
        EXECUTE 'TRUNCATE _delta_ledger RESTART IDENTITY';
      END IF;
    END $$;
  `);
}
