/**
 * Auth-JWT — reference `DeltaAuth` implementation using JWTs (jose) and
 * Postgres stored functions for credential verification.
 *
 * Ship this as an opt-in subpath: `@blueshed/delta/auth-jwt`. Users who want
 * a different auth scheme (sessions, OAuth, magic links, none) implement
 * their own `DeltaAuth` instead.
 *
 * Contract with Postgres:
 *   - `login(email, password) RETURNS jsonb` — return a user row or NULL.
 *   - `register(name, email, password) RETURNS jsonb` — return a user row,
 *     raise unique_violation (23505) on duplicate email.
 *
 * Both are overridable via the `loginSql` / `registerSql` options.
 *
 *   import { jwtAuth } from "@blueshed/delta/auth-jwt";
 *
 *   const auth = jwtAuth({
 *     pool,
 *     secret: process.env.JWT_SECRET!,
 *   });
 *
 *   wireAuth(ws, auth);
 *   await createDocListener(ws, pool, { auth });
 */
import { SignJWT, jwtVerify } from "jose";
import type { Pool } from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger";
import type { DeltaAuth } from "./auth";

const log = createLogger("[auth-jwt]");

// ---------------------------------------------------------------------------
// Bootstrap — apply the reference users schema + login/register functions.
// ---------------------------------------------------------------------------

const AUTH_JWT_SQL_PATH = join(import.meta.dir, "auth-jwt.sql");

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

export interface User {
  id: number | string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

export interface JwtAuthOpts {
  pool: Pool;
  secret: string | Uint8Array;
  expirationTime?: string;
  loginSql?: string;
  registerSql?: string;
}

export function jwtAuth(opts: JwtAuthOpts): DeltaAuth<User> {
  const secret =
    typeof opts.secret === "string"
      ? new TextEncoder().encode(opts.secret)
      : opts.secret;
  const expirationTime = opts.expirationTime ?? "7d";
  const loginSql = opts.loginSql ?? "SELECT login($1, $2) AS result";
  const registerSql = opts.registerSql ?? "SELECT register($1, $2, $3) AS result";

  async function signToken(user: User): Promise<string> {
    return new SignJWT({
      sub: String(user.id),
      name: user.name,
      email: user.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime(expirationTime)
      .sign(secret);
  }

  async function verifyToken(token: string): Promise<User | null> {
    try {
      const { payload } = await jwtVerify(token, secret);
      const id = payload.sub;
      if (id === undefined) return null;
      return {
        id: /^\d+$/.test(String(id)) ? Number(id) : String(id),
        name: payload.name as string | undefined,
        email: payload.email as string | undefined,
      };
    } catch {
      return null;
    }
  }

  return {
    actions: {
      async login(params, client) {
        const { email, password } = params ?? {};
        if (!email || !password) return { error: "email and password required" };
        const { rows } = await opts.pool.query(loginSql, [email, password]);
        const user = rows[0]?.result as User | null;
        if (!user) return { error: "Invalid credentials" };
        client.data.identity = user;
        const token = await signToken(user);
        log.info(`login user=${user.id} email=${user.email ?? ""}`);
        return { result: { ...user, token } };
      },

      async register(params, client) {
        const { name, email, password } = params ?? {};
        if (!name || !email || !password) {
          return { error: "name, email, and password required" };
        }
        try {
          const { rows } = await opts.pool.query(registerSql, [name, email, password]);
          const user = rows[0]?.result as User;
          client.data.identity = user;
          const token = await signToken(user);
          log.info(`register user=${user.id} email=${user.email ?? ""}`);
          return { result: { ...user, token } };
        } catch (err: any) {
          if (err.code === "23505") return { error: "Email already registered" };
          throw err;
        }
      },

      async authenticate(params, client) {
        const { token } = params ?? {};
        if (!token) return { error: "token required" };
        const user = await verifyToken(token);
        if (!user) return { error: "Invalid token" };
        client.data.identity = user;
        log.info(`authenticate user=${user.id}`);
        return { result: user };
      },

      async logout(_params, client) {
        const prev = client.data?.identity as User | undefined;
        delete client.data.identity;
        if (prev) log.info(`logout user=${prev.id}`);
        return { result: { ack: true } };
      },
    },

    gate(client) {
      const identity = client.data?.identity as User | undefined;
      return identity ?? { error: "Authentication required" };
    },

    asSqlArg(identity) {
      return identity.id;
    },
  };
}
