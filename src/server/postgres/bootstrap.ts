/**
 * Bootstrap helpers — apply the delta-doc framework SQL to a Postgres
 * database, programmatically. Alternative to copying the files into a
 * consumer's `init_db/` directory.
 *
 *   import { Pool } from "pg";
 *   import { applyFramework } from "@blueshed/delta/postgres";
 *
 *   const pool = new Pool({ connectionString: process.env.PG_URL });
 *   await applyFramework(pool);
 *
 * The framework SQL is idempotent (`CREATE … IF NOT EXISTS`,
 * `ON CONFLICT DO UPDATE`) so it is safe to call on every server boot.
 *
 * For docker-entrypoint-initdb.d workflows, use the `delta init` CLI to
 * copy the same files into a directory the image can mount.
 */
import type { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FRAMEWORK_SQL_DIR = join(import.meta.dir, "..", "..", "sql");

/** Absolute paths to the framework SQL files, in apply-order.
 *  Filters to `001*-*.sql` — siblings like `auth-jwt.sql` are applied
 *  separately (see `@blueshed/delta/auth-jwt` → `applyAuthJwtSchema`). */
export function frameworkSqlFiles(): string[] {
  return readdirSync(FRAMEWORK_SQL_DIR)
    .filter((f) => /^001[a-z]?-.+\.sql$/.test(f))
    .sort()
    .map((f) => join(FRAMEWORK_SQL_DIR, f));
}

/** The full framework SQL as one string (all files concatenated in order). */
export function frameworkSql(): string {
  return frameworkSqlFiles()
    .map((p) => readFileSync(p, "utf8"))
    .join("\n\n");
}

/**
 * Apply the framework SQL to the given pool. Runs every file in
 * `postgres/sql/` alphabetically — 001a through 001e today. Safe to call
 * repeatedly (idempotent statements).
 */
export async function applyFramework(pool: Pool): Promise<void> {
  for (const path of frameworkSqlFiles()) {
    const sql = readFileSync(path, "utf8");
    await pool.query(sql);
  }
}

/**
 * Apply an arbitrary SQL string to the pool (convenience wrapper). Useful
 * for layering `generateSql(schema, docs)` output on top of the framework:
 *
 *   await applyFramework(pool);
 *   await applySql(pool, generateSql(schema, docs));
 */
export async function applySql(pool: Pool, sql: string): Promise<void> {
  if (sql.trim()) await pool.query(sql);
}
