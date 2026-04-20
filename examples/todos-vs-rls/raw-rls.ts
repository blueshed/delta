/**
 * Raw-RLS approach — plain Pool, explicit queries, RLS enforces visibility.
 *
 * Three entry points. Each caller must:
 *   - open a transaction and `set_config('app.user_id', …, true)`
 *   - issue the queries it needs
 *   - compose any non-row-shape on the client (e.g. counts)
 *   - pass every persisted column on writes (owner_id, team_id)
 *
 * RLS catches forgeries server-side via `WITH CHECK`, but the client still
 * has to *know* what to send. The shape of the response is whatever the SQL
 * returned — no reshape layer, no injection, no dispatch on doc-name.
 */
import type { Pool, PoolClient } from "pg";
import type { Identity } from "./setup";

async function withIdentity<T>(
  pool: Pool,
  identity: Identity,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [String(identity.id)]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* no-op */ }
    throw e;
  } finally {
    client.release();
  }
}

/** List all todos visible to `identity` (own + team) — rows only. */
export async function listVisibleTodos(pool: Pool, identity: Identity) {
  return withIdentity(pool, identity, async (c) => {
    const { rows } = await c.query(
      "SELECT id, owner_id, team_id, text, done, created_at FROM example_todos ORDER BY id",
    );
    return rows;
  });
}

/**
 * List MY todos + counts. Two queries, client merges.
 * Raw RLS can filter, not reshape — counts come from a separate aggregate.
 */
export async function listMyTodosWithCounts(pool: Pool, identity: Identity) {
  return withIdentity(pool, identity, async (c) => {
    const todos = (await c.query(
      "SELECT id, text, done FROM example_todos WHERE owner_id = $1 ORDER BY id",
      [identity.id],
    )).rows;
    const counts = (await c.query(
      `SELECT
         COUNT(*) FILTER (WHERE NOT done)::int AS open,
         COUNT(*) FILTER (WHERE     done)::int AS done
       FROM example_todos WHERE owner_id = $1`,
      [identity.id],
    )).rows[0];
    return { todos, counts };
  });
}

/**
 * Add a todo. Caller must supply owner_id, team_id, text. RLS `WITH CHECK`
 * rejects a row with someone else's owner_id — but the client has to know
 * to send *its own* owner_id in the first place.
 */
export async function addTodo(
  pool: Pool,
  identity: Identity,
  row: { owner_id: number; team_id: number; text: string },
) {
  return withIdentity(pool, identity, async (c) => {
    const { rows } = await c.query(
      "INSERT INTO example_todos (owner_id, team_id, text) VALUES ($1, $2, $3) RETURNING id",
      [row.owner_id, row.team_id, row.text],
    );
    return rows[0] as { id: number };
  });
}
