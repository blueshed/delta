/**
 * Shared setup — both raw-rls.ts and delta.ts hit the same database with
 * the same schema + seed. Applies `schema.sql` to whatever `PG_URL` points
 * at (defaults to the dev compose on :5433).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export const PG_URL =
  process.env.EXAMPLE_PG_URL ??
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

export function newPool(): Pool {
  return new Pool({ connectionString: PG_URL, max: 4 });
}

export async function applySchema(pool: Pool): Promise<void> {
  const sql = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
  await pool.query(sql);
}

export interface Identity {
  id: number;
  name: string;
}

export const ALICE: Identity = { id: 1, name: "Alice" };
export const BOB:   Identity = { id: 2, name: "Bob"   };
export const CAROL: Identity = { id: 3, name: "Carol" };
