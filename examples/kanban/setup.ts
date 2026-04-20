/**
 * Setup — apply framework SQL + the generated kanban SQL + seed one board.
 *
 * Zero hand-written DDL: `generateSql(schema, docs)` emits everything the
 * framework needs to know about the three collections and the `board:` doc.
 */
import { Pool } from "pg";
import {
  applyFramework,
  applySql,
  generateSql,
} from "../../src/server/postgres";
import { schema, docs } from "./schema";

export const PG_URL =
  process.env.EXAMPLE_PG_URL ??
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

export function newPool(): Pool {
  return new Pool({ connectionString: PG_URL, max: 4 });
}

/**
 * Idempotent full setup. Order: framework (001a–001f) → generated tables
 * (`kanban_*` + metadata) → reset per-run state → seed one board.
 */
export async function applyAll(pool: Pool): Promise<void> {
  await applyFramework(pool);

  // generateSql uses CREATE TABLE IF NOT EXISTS — drop first so that
  // running the example after a schema change actually picks up the new
  // shape instead of silently reusing the stale one.
  await pool.query(`
    DROP TABLE IF EXISTS kanban_cards, kanban_columns, kanban_boards CASCADE;
    DELETE FROM _delta_collections WHERE collection_key LIKE 'kanban_%';
    DELETE FROM _delta_docs        WHERE prefix = 'board:';
  `);

  await applySql(pool, generateSql(schema, docs));

  // Reset per-run so the demo starts at v0 with the seeded data.
  await pool.query(`
    DELETE FROM _delta_versions WHERE doc_name LIKE 'board:%';
    DELETE FROM _delta_ops_log  WHERE doc_name LIKE 'board:%';
  `);

  // Seed. Pin explicit ids so the demo always opens `board:1`.
  // DROP TABLE …  CASCADE earlier also drops the DEFAULT nextval() binding,
  // but `CREATE SEQUENCE IF NOT EXISTS` won't reset the counter. Pin it.
  await pool.query(`
    ALTER SEQUENCE seq_kanban_boards  RESTART WITH 1;
    ALTER SEQUENCE seq_kanban_columns RESTART WITH 1;
    ALTER SEQUENCE seq_kanban_cards   RESTART WITH 1;

    INSERT INTO kanban_boards (id, owner_id, title) VALUES
      (1, 1, 'Product roadmap');

    INSERT INTO kanban_columns (id, kanban_boards_id, owner_id, title, position) VALUES
      (1, 1, 1, 'Todo',        0),
      (2, 1, 1, 'In progress', 1),
      (3, 1, 1, 'Done',        2);

    INSERT INTO kanban_cards (id, kanban_columns_id, owner_id, title, position) VALUES
      (1, 1, 1, 'write the kanban example', 0),
      (2, 1, 1, 'sketch 0.4 roadmap',       1),
      (3, 2, 1, 'review RLS policy',        0),
      (4, 3, 1, 'ship v0.3.0',              0),
      (5, 3, 1, 'capture bench results',    1);

    -- Advance sequences past the seeded ids so subsequent INSERTs don't collide.
    SELECT setval('seq_kanban_boards',  (SELECT MAX(id) FROM kanban_boards));
    SELECT setval('seq_kanban_columns', (SELECT MAX(id) FROM kanban_columns));
    SELECT setval('seq_kanban_cards',   (SELECT MAX(id) FROM kanban_cards));
  `);
}
