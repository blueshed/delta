/**
 * delta-new — writes via `delta_apply_as` (1-RTT hot path added in 0.3.0).
 *
 * A single `SELECT delta_apply_as(user_id, doc_name, ops)` does both:
 *   - `set_config('app.user_id', <id>, true)` (server-side, scoped to this SELECT)
 *   - `delta_apply(doc_name, ops)`
 *
 * No explicit BEGIN/COMMIT, no client-side set_config → one round-trip.
 */
import { Pool } from "pg";
import type { Adapter } from "../adapter";
import {
  applyBenchSchema,
  seedBenchRows,
  BENCH_DOC_NAME,
  BENCH_USER_ID,
} from "../schema";

export function deltaNewAdapter(connectionString: string): Adapter {
  const pool = new Pool({ connectionString, max: 4 });
  return {
    name: "delta-new (1-RTT)",
    rtt: 1,
    async setup() {
      await applyBenchSchema(pool);
      await seedBenchRows(pool);
    },
    async writeOp(rowId, newValue) {
      const ops = [
        { op: "replace", path: `/bench_items/${rowId}/value`, value: newValue },
      ];
      await pool.query(
        "SELECT delta_apply_as($1, $2, $3) AS result",
        [String(BENCH_USER_ID), BENCH_DOC_NAME, JSON.stringify(ops)],
      );
    },
    async teardown() {
      await pool.end();
    },
  };
}
