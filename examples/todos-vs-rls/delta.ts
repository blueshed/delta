/**
 * Delta approach — one `DocType` spanning three capabilities that raw RLS
 * alone can't give you:
 *
 *   1. RESHAPE  — open() returns a composed object (rows + counts) in one
 *                 call. Raw RLS returns whatever the SELECT returned; any
 *                 extra shape costs a second round-trip + client merge.
 *
 *   2. INJECT   — apply() rewrites write ops to stamp owner_id / team_id
 *                 from the identity and URL. Raw RLS can only *reject*
 *                 forged rows; it can't fill in missing columns.
 *
 *   3. DISPATCH — the same prefix `todos:` handles two shapes:
 *                 `todos:me`        — caller's own todos
 *                 `todos:team:42`   — everything in team 42
 *                 Raw RLS would need separate functions or parameterised
 *                 WHERE branches at every call site.
 *
 * All three layer cleanly *on top of* the RLS policy from schema.sql.
 * The DocType is the lens; RLS is still the authoritative gate at the DB.
 */
import type { Pool, PoolClient } from "pg";
import type { DocType } from "../../src/server/postgres";
import type { DeltaOp } from "../../src/core";
import type { Identity } from "./setup";

type Ctx = { mode: "me" } | { mode: "team"; teamId: number };

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

export function todosDocType(pool: Pool): DocType<Ctx, Identity> {
  return {
    prefix: "todos:",

    parse(name) {
      if (name === "todos:me") return { mode: "me" };
      const m = name.match(/^todos:team:(\d+)$/);
      if (m) return { mode: "team", teamId: Number(m[1]) };
      return null;
    },

    /**
     * RESHAPE. One call → one composed doc: rows keyed by id, plus counts,
     * plus the scope context as a human-readable `scope` field. RLS still
     * runs — if you're not in the team, you get empty rows back.
     */
    async open(ctx, _name, _msg, identity) {
      if (!identity) return null;

      // Scope filter — same policy, different positional predicate. The
      // RLS policy in schema.sql is the authoritative gate; this predicate
      // just narrows the result to the doc's intent.
      const filter =
        ctx.mode === "me"
          ? { sql: "owner_id = $1", params: [identity.id] as unknown[] }
          : { sql: "team_id  = $1", params: [ctx.teamId] as unknown[] };

      return withIdentity(pool, identity, async (c) => {
        const { rows } = await c.query(
          `WITH scoped AS (
             SELECT id, owner_id, team_id, text, done, created_at
               FROM example_todos
              WHERE ${filter.sql}
           )
           SELECT jsonb_build_object(
             'todos',
               COALESCE(
                 (SELECT jsonb_object_agg(s.id::text, to_jsonb(s)) FROM scoped s),
                 '{}'::jsonb
               ),
             'counts',
               jsonb_build_object(
                 'open', (SELECT COUNT(*) FROM scoped WHERE NOT done)::int,
                 'done', (SELECT COUNT(*) FROM scoped WHERE     done)::int
               ),
             'scope',
               $2::text
           ) AS doc`,
          [...filter.params, ctx.mode === "me" ? "me" : `team:${ctx.teamId}`],
        );
        return { result: rows[0].doc, version: 0 };
      });
    },

    /**
     * INJECT. The client sends `{op: "add", path: "/todos/-", value: {text: "x"}}`.
     * We stamp owner_id + team_id + (DB stamps created_at). A forged owner_id
     * in the client's value is dropped — injection overwrites, not merges.
     * Replace / remove flow through unchanged (RLS still guards them).
     */
    async apply(ctx, _name, ops, identity) {
      if (!identity) throw new Error("Forbidden");

      return withIdentity(pool, identity, async (c) => {
        for (const op of ops) {
          if (op.op === "add" && op.path === "/todos/-") {
            const v = (op.value as { text: string }) ?? { text: "" };
            const teamId = ctx.mode === "team"
              ? ctx.teamId
              : (op.value as { team_id?: number })?.team_id;
            if (!teamId) throw new Error("team_id required when adding to todos:me");
            await c.query(
              "INSERT INTO example_todos (owner_id, team_id, text) VALUES ($1, $2, $3)",
              [identity.id, teamId, v.text],  // owner_id from identity, ignoring any client value
            );
          } else if (op.op === "replace") {
            const m = op.path.match(/^\/todos\/(\d+)\/(\w+)$/);
            if (!m) throw new Error(`unsupported replace path: ${op.path}`);
            const [, idStr, field] = m;
            if (!["text", "done"].includes(field!)) {
              throw new Error(`field ${field} is not writable`);
            }
            await c.query(
              `UPDATE example_todos SET ${field} = $1 WHERE id = $2`,
              [op.value, Number(idStr)],
            );
          } else if (op.op === "remove") {
            const m = op.path.match(/^\/todos\/(\d+)$/);
            if (!m) throw new Error(`unsupported remove path: ${op.path}`);
            await c.query("DELETE FROM example_todos WHERE id = $1", [Number(m[1])]);
          } else {
            throw new Error(`unsupported op: ${op.op} ${op.path}`);
          }
        }
        return { version: 0 };
      });
    },
  };
}

/** Convenience wrappers so `run.ts` can call open/apply without ceremony. */
export function openTodos(
  dt: DocType<Ctx, Identity>,
  docName: string,
  identity: Identity,
) {
  const ctx = dt.parse(docName);
  if (!ctx) throw new Error(`bad doc name: ${docName}`);
  return dt.open(ctx, docName, undefined, identity);
}

export function applyTodos(
  dt: DocType<Ctx, Identity>,
  docName: string,
  ops: DeltaOp[],
  identity: Identity,
) {
  const ctx = dt.parse(docName);
  if (!ctx) throw new Error(`bad doc name: ${docName}`);
  return dt.apply(ctx, docName, ops, identity);
}
