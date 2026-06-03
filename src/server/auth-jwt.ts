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
 *
 * SQL-file helpers (`authJwtSqlFile`, `authJwtSql`, `applyAuthJwtSchema`) live
 * in `./auth-jwt-sql.ts` and are re-exported from here for convenience. They
 * have no jose dependency, so the `delta init` CLI can load them without
 * forcing consumers to install jose just to copy SQL files.
 */
import { SignJWT, jwtVerify } from "jose";
import type { Pool } from "pg";
import { createLogger } from "./logger";
import type { DeltaAuth } from "./auth";
import { dropClientSubscriptions } from "./server";

/** Algorithm this module signs with — pinned on verify to prevent alg-confusion. */
const JWT_ALG = "HS256";

export {
  authJwtSqlFile,
  authJwtSql,
  applyAuthJwtSchema,
} from "./auth-jwt-sql";

const log = createLogger("[auth-jwt]");

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
  /**
   * Optional re-validation hook for `authenticate`. A JWT is stateless: by
   * default a signed, unexpired token grants access even if the user was
   * since deleted or disabled (the documented trade-off of stateless auth).
   * Provide `verifyUser` to re-check the identity against the database on
   * each `authenticate`; return the (possibly refreshed) user to allow, or
   * `null` to reject. Not called on `login` / `register` (those just hit the DB).
   */
  verifyUser?: (user: User, pool: Pool) => Promise<User | null>;
}

/** Set the socket's identity, tearing down a prior *different* identity's
 *  live subscriptions so an identity switch on one socket can't keep
 *  receiving the previous user's scoped docs. */
function switchIdentity(client: any, user: User): void {
  const prev = client.data?.identity as User | undefined;
  if (prev && String(prev.id) !== String(user.id)) {
    dropClientSubscriptions(client);
  }
  if (!client.data) client.data = {};
  client.data.identity = user;
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
      .setProtectedHeader({ alg: JWT_ALG })
      .setIssuedAt()
      .setExpirationTime(expirationTime)
      .sign(secret);
  }

  async function verifyToken(token: string): Promise<User | null> {
    try {
      // Pin the algorithm allowlist — without it, jose accepts any alg the
      // token header claims, opening an alg-confusion vector.
      const { payload } = await jwtVerify(token, secret, { algorithms: [JWT_ALG] });
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
        switchIdentity(client, user);
        const token = await signToken(user);
        log.info(`login user=${user.id}`);
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
          switchIdentity(client, user);
          const token = await signToken(user);
          log.info(`register user=${user.id}`);
          return { result: { ...user, token } };
        } catch (err: any) {
          if (err.code === "23505") return { error: "Email already registered" };
          throw err;
        }
      },

      async authenticate(params, client) {
        const { token } = params ?? {};
        if (!token) return { error: "token required" };
        let user = await verifyToken(token);
        if (!user) return { error: "Invalid token" };
        if (opts.verifyUser) {
          const checked = await opts.verifyUser(user, opts.pool);
          if (!checked) return { error: "Invalid token" };
          user = checked;
        }
        switchIdentity(client, user);
        log.info(`authenticate user=${user.id}`);
        return { result: user };
      },

      async logout(_params, client) {
        const prev = client.data?.identity as User | undefined;
        if (client.data) delete client.data.identity;
        // Tear down the prior identity's live doc subscriptions so its scoped
        // ops stop streaming to this socket immediately.
        dropClientSubscriptions(client);
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
