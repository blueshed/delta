/**
 * Postgres auth helpers — RLS session context for delta-doc queries.
 *
 * `withAppAuth(pool, sqlArg, fn)` checks out a client, opens a transaction,
 * sets `app.user_id` for the duration of the transaction, runs `fn` with the
 * client, then commits and releases. Row-Level Security policies that read
 * `current_setting('app.user_id', true)` then filter automatically.
 *
 *   CREATE POLICY venues_owner ON venues
 *     FOR ALL USING (owner_id = current_setting('app.user_id', true)::int);
 *
 *   await withAppAuth(pool, user.id, c =>
 *     c.query("SELECT delta_open($1) AS doc", [docName]),
 *   );
 *
 * The session variable is set via `SET LOCAL` so it reverts on transaction
 * end — safe against pool reuse.
 *
 * Re-exports the `DeltaAuth` contract from `../auth` for convenience.
 */
import type { Pool, PoolClient } from "pg";

export type { DeltaAuth, AuthError, AuthAction } from "../auth";
export { isAuthError, wireAuth, upgradeWithAuth } from "../auth";

/**
 * Run `fn` inside a transaction with `SET LOCAL app.user_id = <sqlArg>`. All
 * queries issued on the passed client observe RLS policies scoped to that
 * identity.
 */
export async function withAppAuth<T>(
  pool: Pool,
  sqlArg: string | number,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL cannot be parameterised — use set_config(..., is_local=true).
    await client.query("SELECT set_config('app.user_id', $1, true)", [String(sqlArg)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* pool may already be closed */ }
    throw err;
  } finally {
    client.release();
  }
}
