/**
 * Auth — pluggable authentication contract for delta-doc.
 *
 * Delta does not ship an authentication scheme. Instead it exposes a single
 * extension point — the `DeltaAuth<Identity>` interface — and a wiring helper
 * (`wireAuth`) that plugs an implementation into the WebSocket action router.
 *
 * Why not a token in the WebSocket URL: query strings are written to proxy
 * logs, browser history, and referrer headers. The contract below never reads
 * the URL — auth happens either on upgrade (cookies / Authorization header)
 * or via a dedicated in-band WS message (deferred auth). That structure makes
 * the URL-token flaw impossible to introduce.
 *
 * A reference JWT implementation ships at `@blueshed/delta/auth-jwt`.
 *
 *   import { wireAuth, type DeltaAuth } from "@blueshed/delta/auth";
 *   import { jwtAuth } from "@blueshed/delta/auth-jwt";
 *
 *   const auth = jwtAuth({ pool, secret: process.env.JWT_SECRET! });
 *   wireAuth(ws, auth);
 *   await createDocListener(ws, pool, { auth });
 */
import type { WsServer } from "./server";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** An error result from auth hooks — `{ error: string }` is always a failure. */
export interface AuthError { error: string; }

export function isAuthError(v: unknown): v is AuthError {
  return !!v && typeof v === "object" && "error" in v;
}

/**
 * Extension point for authentication. Implementations define where identity
 * comes from (headers, in-band tokens, etc.) and how it maps to SQL session
 * variables for RLS. Delta never assumes a specific shape — `Identity` is
 * whatever the implementation says it is.
 */
export interface DeltaAuth<Identity = unknown> {
  /**
   * Optional synchronous check on the HTTP upgrade request — read cookies or
   * the `Authorization` header here. Return an identity to authenticate the
   * connection immediately, or `null` to accept unauthenticated and defer to
   * an in-band `authenticate` action.
   */
  onUpgrade?(req: Request): Identity | null | Promise<Identity | null>;

  /**
   * WS actions this module handles (e.g. `login`, `register`, `authenticate`).
   * Each action receives the raw params plus the client; it should set
   * `client.data.identity` on success and return `{ result }` or `{ error }`.
   */
  actions?: Record<string, AuthAction<Identity>>;

  /**
   * Called before every authenticated message (open, delta). Return the
   * identity to continue, or `{ error }` to reject with a 401.
   */
  gate(client: any): Identity | AuthError;

  /**
   * Convert an identity to the value passed to `SET LOCAL app.user_id` when
   * wrapping queries for RLS. Omit to skip RLS session setup.
   */
  asSqlArg?(identity: Identity): string | number;
}

export type AuthAction<Identity> = (
  params: any,
  client: any,
) => Promise<{ result: any } | AuthError>;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * Register an auth module's actions with a WebSocket server. Each declared
 * action becomes a `call` handler that delegates to the implementation.
 *
 * Call this once at server startup, before `createDocListener`.
 */
export function wireAuth<I>(ws: WsServer, auth: DeltaAuth<I>): void {
  if (!auth.actions) return;
  const actions = auth.actions;

  ws.on("call", async (msg, client, respond) => {
    const fn = actions[msg.method];
    if (!fn) return;
    const outcome = await fn(msg.params ?? {}, client);
    if (isAuthError(outcome)) {
      respond({ error: { code: 401, message: outcome.error } });
    } else {
      respond({ result: outcome.result });
    }
  });
}

// ---------------------------------------------------------------------------
// Upgrade helper
// ---------------------------------------------------------------------------

/**
 * Wrap the WsServer upgrade handler with an `onUpgrade` auth check. Returns a
 * new upgrade function that calls `auth.onUpgrade` (if defined) and stashes
 * the resulting identity on `client.data.identity`.
 *
 *   server = Bun.serve({
 *     routes: { [ws.path]: upgradeWithAuth(ws, auth), ...otherRoutes },
 *     websocket: ws.websocket,
 *   });
 */
export function upgradeWithAuth<I>(
  ws: WsServer,
  auth: DeltaAuth<I>,
): (req: Request, server: any) => Response | undefined | Promise<Response | undefined> {
  return async (req, server) => {
    let identity: I | null = null;
    if (auth.onUpgrade) {
      try {
        identity = await auth.onUpgrade(req);
      } catch {
        identity = null;
      }
    }
    const clientId =
      new URL(req.url).searchParams.get("clientId") ?? crypto.randomUUID();
    if (server.upgrade(req, { data: { clientId, identity } })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  };
}
