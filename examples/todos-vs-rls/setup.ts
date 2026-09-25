/**
 * Shared setup — both raw-rls.ts and delta.ts hit the same database, the same
 * tables and the same RLS policy, as the same NOSUPERUSER role.
 *
 * The todos table is delta's: declared here with `defineSchema`, made by
 * `generateSql`, so every write to it goes through `delta_apply` (the version,
 * the ops log, the NOTIFY). Users and teams are plain tables (schema.sql); the
 * policy goes on once the table is there (rls.sql).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { applyFramework, applySql, defineDoc, defineSchema, generateSql } from "../../src/server/postgres";
import type { DeltaAuth } from "../../src/server/auth";

export const PG_URL =
  process.env.EXAMPLE_PG_URL ??
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

export const schema = defineSchema({
  todos: {
    table: "example_todos",
    columns: { owner_id: "integer", team_id: "integer", text: "text", done: { type: "boolean", default: false } },
    temporal: false,
  },
});

/** Two lenses on one table: a name each, scoped by the id in it. */
export const myTodos = defineDoc("todos-mine:", { root: "todos", include: [], scope: { owner_id: ":id" } });
export const teamTodos = defineDoc("todos-team:", { root: "todos", include: [], scope: { team_id: ":id" } });

export interface Identity {
  id: number;
  name: string;
}

export const ALICE: Identity = { id: 1, name: "Alice" };
export const BOB:   Identity = { id: 2, name: "Bob"   };
export const CAROL: Identity = { id: 3, name: "Carol" };

/** Who is asking: here the caller names it (`createLocal().as(identity)`); a server's comes from a token. */
export const auth: DeltaAuth<Identity> = {
  gate: (client) => (client.data?.identity as Identity | undefined) ?? { error: "Sign in" },
  asSqlArg: (identity) => identity.id,   // → app.user_id, which the policy reads
};

/** Drop and re-seed the example's tables; answer an admin pool (setup only) and the app role's pool. */
export async function setup(): Promise<{ admin: Pool; app: Pool }> {
  const admin = new Pool({ connectionString: PG_URL, max: 2 });
  await applyFramework(admin);
  await admin.query(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  await applySql(admin, generateSql(schema, [myTodos, teamTodos]));
  await admin.query(readFileSync(join(import.meta.dir, "rls.sql"), "utf8"));
  const url = new URL(PG_URL);
  url.username = url.password = "example_app";
  return { admin, app: new Pool({ connectionString: url.href, max: 4 }) };
}
