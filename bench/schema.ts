/**
 * Bench schema — a single table owned by a single user, with RLS enabled.
 *
 * Uses `generateSql(schema, docs)` from the framework so we stay in sync
 * with whatever metadata shape the main library emits. The only handwritten
 * SQL is the RLS policy (policies are app-level, not framework-level).
 */
import type { Pool } from "pg";
import { defineSchema, defineDoc, generateSql } from "../src/server/postgres";

export const BENCH_USER_ID = 1;
export const BENCH_DOC_NAME = `bench:${BENCH_USER_ID}`;
export const BENCH_SEED_ROWS = 100;

export const benchSchema = defineSchema({
  bench_items: {
    columns: {
      owner_id: "integer",
      name: "text",
      value: "integer",
    },
    temporal: false,
  },
});

export const benchDocs = [
  defineDoc("bench:", {
    root: "bench_items",
    include: [],
    scope: { owner_id: ":id" },
  }),
];

/**
 * Apply table + framework metadata + RLS policy. Idempotent.
 */
export async function applyBenchSchema(pool: Pool): Promise<void> {
  await pool.query(generateSql(benchSchema, benchDocs));
  await pool.query(`
    ALTER TABLE bench_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE bench_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS bench_items_owner ON bench_items;
    CREATE POLICY bench_items_owner ON bench_items
      FOR ALL
      USING      (owner_id = current_setting('app.user_id', true)::int)
      WITH CHECK (owner_id = current_setting('app.user_id', true)::int);
  `);
}

/**
 * Wipe and re-seed the bench table, returning seeded row ids.
 * Bypass RLS by using `set_config` in a transaction.
 */
export async function seedBenchRows(pool: Pool): Promise<number[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [String(BENCH_USER_ID)]);
    await client.query("TRUNCATE bench_items RESTART IDENTITY CASCADE");
    // seq_bench_items isn't owned by the table, so TRUNCATE doesn't touch it.
    await client.query("ALTER SEQUENCE seq_bench_items RESTART WITH 1");
    const ids: number[] = [];
    for (let i = 0; i < BENCH_SEED_ROWS; i++) {
      const { rows } = await client.query(
        "INSERT INTO bench_items (id, owner_id, name, value) VALUES (nextval('seq_bench_items'), $1, $2, $3) RETURNING id",
        [BENCH_USER_ID, `row-${i}`, 0],
      );
      ids.push(Number(rows[0].id));
    }
    await client.query("COMMIT");
    return ids;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* no-op */ }
    throw e;
  } finally {
    client.release();
  }
}
