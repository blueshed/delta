/**
 * Delta approach — the same feature from delta's own parts, nothing written
 * by hand that touches the table:
 *
 *   1. RESHAPE  — `todos-summary:<me>` is a custom read doc that recomputes
 *                 { todos, counts } as the identity, in one open. Raw RLS
 *                 returns whatever the SELECT returned; any extra shape costs
 *                 a second round-trip and a client merge.
 *
 *   2. INJECT   — `todos-mine:<me>` is scoped by `owner_id: ":id"`, so an add
 *                 through it takes owner_id from the name, never the value,
 *                 and `owns` says the name is the identity's own. Raw RLS can
 *                 only *reject* a forged row; it can't fill in the column.
 *
 *   3. DISPATCH — a lens is a `defineDoc` line: `todos-mine:<id>` and
 *                 `todos-team:<id>` over the one table, each with its `owns`.
 *                 A name its identity may not have is a 404 before it is read.
 *
 * Every read and write runs as the identity (`delta_open_as` /
 * `delta_apply_as` bind app.user_id), so the policy in rls.sql still decides
 * which rows. And every write goes through `delta_apply`, so it is versioned
 * and heard: a raw INSERT would change the table and tell no one.
 */
import type { Pool } from "pg";
import {
  createDocListener, defineCustomDoc, docTypeFromDef, registerDocType, withAppAuth,
} from "../../src/server/postgres";
import { createLocal } from "../../src/server/local";
import { auth, myTodos, teamTodos, type Identity } from "./setup";

/** { todos, counts } for one person, read as them: the policy scopes it. */
const summary = defineCustomDoc<{ id: string }, Identity>("todos-summary:", {
  watch: ["todos"],
  parse: (id) => ({ id }),
  owns: (me, name) => name === `todos-summary:${me.id}`,
  recompute: (pool, _c, me) =>
    withAppAuth(pool, me!.id, async (db) => {
      const { rows } = await db.query(
        `WITH mine AS (SELECT id, owner_id, team_id, text, done FROM example_todos WHERE owner_id = $1)
         SELECT jsonb_build_object(
           'todos',  COALESCE((SELECT jsonb_object_agg(m.id::text, to_jsonb(m)) FROM mine m), '{}'::jsonb),
           'counts', jsonb_build_object(
             'open', (SELECT count(*) FROM mine WHERE NOT done)::int,
             'done', (SELECT count(*) FROM mine WHERE done)::int)
         ) AS doc`,
        [me!.id],
      );
      return rows[0].doc;
    }),
});

/** Delta in this process: the documents, who owns each name, and the listener, on the app role's pool. */
export async function serveTodos(app: Pool) {
  const isMember = async (me: Identity, name: string) => {
    const team = name.slice(teamTodos.prefix.length);
    if (!/^\d+$/.test(team)) return false;
    const { rowCount } = await app.query(
      "SELECT 1 FROM example_team_members WHERE user_id = $1 AND team_id = $2", [me.id, Number(team)]);
    return (rowCount ?? 0) > 0;
  };
  registerDocType(docTypeFromDef<Identity>(myTodos, app, { auth, owns: (me, name) => name === `todos-mine:${me.id}` }));
  registerDocType(docTypeFromDef<Identity>(teamTodos, app, { auth, owns: isMember }));

  const local = createLocal();
  const listener = await createDocListener(local.server, app, { auth, custom: [summary] });
  return { local, listener };
}
