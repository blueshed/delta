/**
 * Link sign-in: a `DeltaAuth` in which nobody types a password (Can You?'s, made general; Workshop's
 * docs/link-sign-in-plan.md).
 *
 * - A **link** is someone: `<site>/#/in/<token>`, a random token kept only as its hash, used once,
 *   for 7 days. Its token is in the part after `#`, which a browser never sends to a server: it is in
 *   no log, and a chat's preview that fetches the link uses nothing.
 * - **The tap uses it**: the page (`takeLink`, `./auth-link/client`) posts it to `/api/in`, from the
 *   site (its `Origin`), and the answer sets a **session**: an HttpOnly cookie, kept as its hash, for a
 *   year, renewed as it is used.
 * - **The socket is signed in by the cookie**, on upgrade (`onUpgrade`, through `upgradeWithAuth`):
 *   no token rides in its URL or in a message.
 * - **Anyone signed in may make anyone's link** (`call("link", { person })`), unless the app says
 *   otherwise (`mayLink`); the first person's comes from a command on the server (`makeLink`).
 * - **In development** (not `NODE_ENV=production`), `GET /api/dev/people` lists everyone and
 *   `POST /api/dev/as/:id` signs in as them: one click to be anyone. Tests sign in with `signInAs`.
 *   Neither answers in production.
 *
 * Who people are is the app's: `personOf(id)` reads its own collection, and the identity it answers
 * is what `owns` and the ledger see. The links and sessions are kept by a `LinkStore`: SQLite's here
 * (`sqliteLinkStore`), Postgres's in dzql. They are not documents: nobody opens them.
 *
 *   const auth = linkAuth({ store: sqliteLinkStore(db), personOf, people });
 *   wireAuth(ws, auth);
 *   Bun.serve({ routes: { ...auth.routes, "/ws": upgradeWithAuth(ws, auth) }, websocket: ws.websocket });
 *   registerDocs(ws, db, schema, docs, [], { auth, owns: (me, name) => name === `mine:${me.id}` });
 */
import type { Database } from "bun:sqlite";
import { dropClientSubscriptions } from "./server";
import type { AuthError, DeltaAuth } from "./auth";

/** A link as kept: whose it is, what it opens at, when it runs out, and when it was used (null: not yet). */
export type KeptLink = { person: number; opens: string | null; expires: string; used: string | null };
/** A session as kept: whose it is, and when it runs out. */
export type KeptSession = { person: number; expires: string };

/**
 * Where the links and sessions are kept, by the hash of their token: SQLite's (`sqliteLinkStore`) or
 * dzql's Postgres. Times are ISO strings. `useLink` uses a link that can be used, and only one such:
 * two taps at once, one session.
 */
export interface LinkStore {
  addLink(hash: string, link: Omit<KeptLink, "used">): Promise<void>;
  /** Use the link if it is unused and not run out at `now`: whose it is and what it opens at, else null. */
  useLink(hash: string, now: string): Promise<{ person: number; opens: string | null } | null>;
  link(hash: string): Promise<KeptLink | null>;
  addSession(hash: string, session: KeptSession): Promise<void>;
  session(hash: string): Promise<KeptSession | null>;
  renewSession(hash: string, expires: string): Promise<void>;
  endSession(hash: string): Promise<void>;
}

/** The links and sessions in SQLite, in tables of their own (`_auth_links`, `_auth_sessions`), made here. */
export function sqliteLinkStore(db: Database): LinkStore {
  db.run(`CREATE TABLE IF NOT EXISTS _auth_links (hash TEXT PRIMARY KEY, person INTEGER NOT NULL, opens TEXT, expires TEXT NOT NULL, used TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS _auth_sessions (hash TEXT PRIMARY KEY, person INTEGER NOT NULL, expires TEXT NOT NULL)`);
  return {
    async addLink(hash, l) {
      db.query("INSERT INTO _auth_links (hash, person, opens, expires) VALUES (?, ?, ?, ?)").run(hash, l.person, l.opens, l.expires);
    },
    async useLink(hash, now) {
      return db
        .query<{ person: number; opens: string | null }, [string, string, string]>(
          "UPDATE _auth_links SET used = ? WHERE hash = ? AND used IS NULL AND expires > ? RETURNING person, opens",
        )
        .get(now, hash, now);
    },
    async link(hash) {
      return db.query<KeptLink, [string]>("SELECT person, opens, expires, used FROM _auth_links WHERE hash = ?").get(hash);
    },
    async addSession(hash, s) {
      db.query("INSERT INTO _auth_sessions (hash, person, expires) VALUES (?, ?, ?)").run(hash, s.person, s.expires);
    },
    async session(hash) {
      return db.query<KeptSession, [string]>("SELECT person, expires FROM _auth_sessions WHERE hash = ?").get(hash);
    },
    async renewSession(hash, expires) {
      db.query("UPDATE _auth_sessions SET expires = ? WHERE hash = ?").run(expires, hash);
    },
    async endSession(hash) {
      db.query("DELETE FROM _auth_sessions WHERE hash = ?").run(hash);
    },
  };
}

/** The session's cookie. */
export const SESSION_COOKIE = "delta_session";

/** Where a socket's identity keeps its session (its hash, its end) and the site it came from, out of sight of what is shown. */
const SESSION = Symbol("session");
type Kept = { hash: string; expires: number; origin: string };

const DAY = 86_400_000;
const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
/** What is kept of a token: its hash, so the tables alone sign nobody in. */
export const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("base64url");
const daysFrom = (days: number, from = Date.now()) => new Date(from + days * DAY).toISOString();

/** The site's own address: `ORIGIN`, else Railway's `RAILWAY_PUBLIC_DOMAIN`, else the request's. */
export function siteOrigin(req?: Request): string {
  const { ORIGIN, RAILWAY_PUBLIC_DOMAIN } = process.env;
  if (ORIGIN) return new URL(ORIGIN).origin;
  if (RAILWAY_PUBLIC_DOMAIN) return `https://${RAILWAY_PUBLIC_DOMAIN}`;
  if (req) return new URL(req.url).origin;
  throw new Error("Set ORIGIN to the site's address (Railway sets RAILWAY_PUBLIC_DOMAIN): a link names it");
}

/**
 * A new link to be `person`, opening at `opens` (a path in the page, as `#/...` names it), for
 * `days` (7): its URL, `<origin>/#/in/<token>`, and when it runs out. For a command on the server,
 * the first person's link: `makeLink(store, 1, { origin: "https://my.app" })`.
 */
export async function makeLink(store: LinkStore, person: number, opts: { origin?: string; opens?: string; days?: number } = {}) {
  const token = newToken();
  const expires = daysFrom(opts.days ?? 7);
  await store.addLink(hashToken(token), { person, opens: opts.opens ?? null, expires });
  return { url: `${opts.origin ?? siteOrigin()}/#/in/${token}`, expires };
}

export interface LinkAuthOpts<P extends { id: number }> {
  store: LinkStore;
  /** The person `id` is, as `owns` and the ledger will see them; null for nobody (gone, or never). */
  personOf(id: number): P | null | Promise<P | null>;
  /** Everyone, for the development picker ("Who are you?"). */
  people(): P[] | Promise<P[]>;
  /** Who may make `person`'s link: `by` is signed in. Anyone, for anyone, unless said otherwise. */
  mayLink?(by: P, person: number): boolean | Promise<boolean>;
  /** Development: the picker and `signInAs`. Default: `NODE_ENV` is not production. */
  dev?: boolean;
  /** How long a session lasts, renewed as it is used (365 days); a link (7 days). */
  sessionDays?: number;
  linkDays?: number;
}

type Route = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

/** The link sign-in: the `DeltaAuth`, its routes, and what tests and commands sign in with. */
export function linkAuth<P extends { id: number }>(opts: LinkAuthOpts<P>) {
  const { store } = opts;
  const dev = opts.dev ?? process.env.NODE_ENV !== "production";
  const sessionDays = opts.sessionDays ?? 365;

  const refuse = (status: number, message: string) => Response.json({ error: { code: status, message } }, { status });
  const fromSite = (req: Request) => req.headers.get("origin") === siteOrigin(req);
  const cookie = (req: Request, value: string, maxAge: number) =>
    new Bun.Cookie(SESSION_COOKIE, value, { httpOnly: true, sameSite: "lax", path: "/", secure: siteOrigin(req).startsWith("https:"), maxAge }).serialize();

  /** A new session for `person`: its token (the cookie's value). */
  async function begin(person: number) {
    const token = newToken();
    await store.addSession(hashToken(token), { person, expires: daysFrom(sessionDays) });
    return token;
  }
  /** Signed in as `person`: who they are, and the cookie that keeps them. */
  async function welcome(req: Request, person: P) {
    return Response.json(person, { headers: { "Set-Cookie": cookie(req, await begin(person.id), sessionDays * 86_400) } });
  }

  /** The person a session cookie is, renewing it at most once a day; null for none. */
  async function sessionOf(req: Request): Promise<{ person: P; hash: string; expires: number } | null> {
    const token = new Bun.CookieMap(req.headers.get("cookie") ?? "").get(SESSION_COOKIE);
    if (!token) return null;
    const hash = hashToken(token);
    const kept = await store.session(hash);
    if (!kept || kept.expires <= new Date().toISOString()) return null;
    const person = await opts.personOf(kept.person);
    if (!person) return null;
    let expires = Date.parse(kept.expires);
    if (expires < Date.now() + (sessionDays - 1) * DAY) {
      const renewed = daysFrom(sessionDays);
      await store.renewSession(hash, renewed);
      expires = Date.parse(renewed);
    }
    return { person, hash, expires };
  }

  const tap: Route = async (req) => {
    if (!fromSite(req)) return refuse(403, "That came from another site.");
    const used = await store.useLink(hashToken(req.params.token ?? ""), new Date().toISOString());
    if (!used) return refuse(400, "That link has been used or has run out: ask for a new one.");
    const person = await opts.personOf(used.person);
    if (!person) return refuse(400, "That link is to nobody here now.");
    const signedIn = await welcome(req, person);
    return Response.json({ ...person, opens: used.opens }, { headers: signedIn.headers });
  };

  const signOut: Route = async (req) => {
    if (!fromSite(req)) return refuse(403, "That came from another site.");
    const token = new Bun.CookieMap(req.headers.get("cookie") ?? "").get(SESSION_COOKIE);
    if (token) await store.endSession(hashToken(token));
    return Response.json({ ack: true }, { headers: { "Set-Cookie": cookie(req, "", 0) } });
  };

  const people: Route = async () => (dev ? Response.json(await opts.people()) : refuse(404, "Not found"));
  const becomeAs: Route = async (req) => {
    if (!dev) return refuse(404, "Not found");
    if (!fromSite(req)) return refuse(403, "That came from another site.");
    const person = /^\d+$/.test(req.params.id ?? "") ? await opts.personOf(Number(req.params.id)) : null;
    return person ? welcome(req, person) : refuse(404, "Nobody of that id");
  };

  const auth: DeltaAuth<P> = {
    async onUpgrade(req) {
      const found = await sessionOf(req);
      return found ? ({ ...found.person, [SESSION]: { hash: found.hash, expires: found.expires, origin: siteOrigin(req) } satisfies Kept } as P) : null;
    },
    gate(client): P | AuthError {
      const me = client.data?.identity as (P & { [SESSION]?: Kept }) | undefined;
      if (!me) return { error: "Sign in first" };
      if ((me[SESSION]?.expires ?? Infinity) <= Date.now()) {
        delete client.data.identity;
        dropClientSubscriptions(client);
        return { error: "Session expired: sign in again" };
      }
      return me;
    },
    actions: {
      /** Who this socket is, or null. */
      async me(_params, client) {
        const me = client.data?.identity as P | undefined;
        if (!me) return { result: null };
        const { [SESSION]: _, ...person } = me as P & { [SESSION]?: unknown };
        return { result: person };
      },
      /** A new link to be `person`, opening at `opens`: `{ url, expires }`. */
      async link(params, client) {
        const me = client.data?.identity as (P & { [SESSION]?: Kept }) | undefined;
        if (!me) return { error: "Sign in first" };
        const person = Number(params?.person);
        if (!Number.isInteger(person) || !(await opts.personOf(person))) return { error: "Nobody of that id" };
        if (opts.mayLink && !(await opts.mayLink(me, person))) return { error: "Not yours to send" };
        const opens = typeof params?.opens === "string" ? params.opens : undefined;
        return { result: await makeLink(store, person, { origin: me[SESSION]?.origin, opens, days: opts.linkDays }) };
      },
    },
  };

  return Object.assign(auth, {
    /** The HTTP routes, for `Bun.serve`'s `routes`: the tap, sign out, and in development the picker. */
    routes: {
      "/api/in/:token": { POST: tap },
      "/api/out": { POST: signOut },
      "/api/dev/people": { GET: people },
      "/api/dev/as/:id": { POST: becomeAs },
    },
    /** A cookie header that is `person` signed in, for a test's fetch or socket. Development only. */
    async signInAs(person: number) {
      if (!dev) throw new Error("signInAs is for development and tests");
      return `${SESSION_COOKIE}=${await begin(person)}`;
    },
  });
}

