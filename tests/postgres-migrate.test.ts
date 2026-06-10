/**
 * migrateSchema (Postgres) — additive ALTERs toward the TypeScript schema.
 *
 * Pins the three behaviours that matter:
 *   1. a column added to types.ts lands on the live table, with NOT NULL
 *      columns backfilled via the type default;
 *   2. the current_<table> view is RE-CREATED when a temporal table gains a
 *      column — a SELECT * view snapshots its columns at creation, so without
 *      the refresh, reads (delta_open and delta_apply's row merge) would
 *      never see the new column;
 *   3. re-running is a no-op (idempotent).
 *
 * Requires a live Postgres on $DELTA_TEST_PG_URL (see CLAUDE.md).
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Pool } from "pg";
import {
  defineSchema,
  defineDoc,
  generateSql,
  applySql,
  migrateSchema,
} from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework } from "./setup";

setLogLevel("silent");

let pool: Pool;

const docs = [defineDoc("gadgets:", { root: "gadgets", include: [] })];

const v1 = defineSchema({
  gadgets: { columns: { name: "text" } },
});

const v2 = defineSchema({
  gadgets: {
    columns: {
      name: "text",
      count: "integer",          // NOT NULL → backfilled with the type default (0)
      note: "text?",             // nullable → plain add
      due: "timestamptz",        // NOT NULL, no usable default → added nullable + warn
    },
  },
});

async function cleanup(): Promise<void> {
  await pool.query(`
    DROP VIEW IF EXISTS current_gadgets;
    DROP TABLE IF EXISTS gadgets;
    DROP SEQUENCE IF EXISTS seq_gadgets;
    DELETE FROM _delta_docs WHERE prefix = 'gadgets:';
    DELETE FROM _delta_collections WHERE collection_key = 'gadgets';
    DELETE FROM _delta_versions WHERE doc_name LIKE 'gadgets:%';
    DELETE FROM _delta_ops_log WHERE doc_name LIKE 'gadgets:%';
  `);
}

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await pool.end();
});

describe("migrateSchema (Postgres)", () => {
  test("adds new columns to an existing table, backfilling NOT NULL defaults", async () => {
    // v1: create + seed a pre-migration row.
    await applySql(pool, generateSql(v1, docs));
    await pool.query("INSERT INTO gadgets (name) VALUES ('widget')");

    // v2: metadata first (generateSql is CREATE-only), then the ALTERs.
    await applySql(pool, generateSql(v2, docs));
    const applied = await migrateSchema(pool, v2);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.some((s) => s.includes('"count"'))).toBe(true);

    const { rows } = await pool.query("SELECT * FROM gadgets WHERE name = 'widget'");
    expect(rows[0].count).toBe("0");       // BIGINT → string in pg; backfilled
    expect(rows[0].note).toBeNull();
    expect(rows[0].due).toBeNull();        // no usable default → nullable add

    // The pre-existing column was left alone.
    expect(rows[0].name).toBe("widget");
  });

  test("re-creates the current_ view so reads see the new column end-to-end", async () => {
    // The view existed before `count` did — without the refresh this SELECT
    // would fail (column absent from the view's snapshot).
    const { rows } = await pool.query("SELECT count FROM current_gadgets WHERE name = 'widget'");
    expect(rows[0].count).toBe("0");

    // And the full read path returns the migrated field.
    const open = await pool.query("SELECT delta_open('gadgets:') AS doc");
    const gadgets = Object.values<any>(open.rows[0].doc.gadgets ?? {});
    expect(gadgets[0].count).toBe(0);
    expect(gadgets[0]).toHaveProperty("note");
  });

  test("a write through delta_apply round-trips the migrated column", async () => {
    const { rows } = await pool.query(
      `SELECT delta_apply('gadgets:', '[{"op":"add","path":"/gadgets/-","value":{"name":"post-migration","count":7}}]'::jsonb) AS r`,
    );
    const addOp = rows[0].r.ops.find((o: any) => o.op === "add");
    expect(addOp.value.count).toBe(7);

    const open = await pool.query("SELECT delta_open('gadgets:') AS doc");
    const added = Object.values<any>(open.rows[0].doc.gadgets).find(
      (g: any) => g.name === "post-migration",
    );
    expect(added.count).toBe(7);
  });

  test("re-running migrateSchema is a no-op", async () => {
    const applied = await migrateSchema(pool, v2);
    expect(applied).toEqual([]);
  });
});
