/**
 * Auth-JWT SQL helpers — pure filesystem access, no jose dependency.
 *
 * These are split out of `auth-jwt.ts` so the `delta init` CLI (which only
 * needs the file path) can run in projects that haven't installed jose.
 * Consumers of the `@blueshed/delta/auth-jwt` subpath still get these via
 * re-export from `auth-jwt.ts`.
 */
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const AUTH_JWT_SQL_PATH = join(import.meta.dir, "..", "sql", "auth-jwt.sql");

/** Absolute path to the reference auth-jwt SQL file (users + register + login). */
export function authJwtSqlFile(): string {
  return AUTH_JWT_SQL_PATH;
}

/** The reference auth-jwt SQL as a string. */
export function authJwtSql(): string {
  return readFileSync(AUTH_JWT_SQL_PATH, "utf8");
}

/**
 * Apply the reference users schema + login/register stored functions to a
 * pool. Idempotent. Call once at boot alongside `applyFramework(pool)`, or
 * use `delta init --with-auth` to copy the file for docker-entrypoint use.
 */
export async function applyAuthJwtSchema(pool: Pool): Promise<void> {
  await pool.query(authJwtSql());
}
