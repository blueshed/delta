/**
 * delta-old — writes via `withAppAuth` (the 4-RTT identity-scoping path).
 *
 *   BEGIN                                      ─┐
 *   SELECT set_config('app.user_id', …, true)   │  4 RTTs per op
 *   SELECT delta_apply(doc_name, ops)           │
 *   COMMIT                                     ─┘
 *
 * Still supported as an escape hatch for arbitrary queries under an identity.
 * `docTypeFromDef({ auth })` no longer uses it on the hot path.
 */
import { Pool } from "pg";
import type { Adapter } from "../adapter";
import { withAppAuth } from "../../src/server/postgres";
import {
  applyBenchSchema,
  seedBenchRows,
  BENCH_DOC_NAME,
  BENCH_USER_ID,
} from "../schema";

export function deltaOldAdapter(connectionString: string): Adapter {
  const pool = new Pool({ connectionString, max: 4 });
  return {
    name: "delta-old (4-RTT)",
    rtt: 4,
    async setup() {
      await applyBenchSchema(pool);
      await seedBenchRows(pool);
    },
    async writeOp(rowId, newValue) {
      const ops = [
        { op: "replace", path: `/bench_items/${rowId}/value`, value: newValue },
      ];
      await withAppAuth(pool, BENCH_USER_ID, (c) =>
        c.query("SELECT delta_apply($1, $2) AS result", [
          BENCH_DOC_NAME,
          JSON.stringify(ops),
        ]),
      );
    },
    async teardown() {
      await pool.end();
    },
  };
}
