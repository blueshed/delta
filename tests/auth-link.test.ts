/**
 * Link sign-in (`@blueshed/delta/auth-link`) on SQLite, through a real server and real sockets: a
 * link is someone, used once by a tap from the site, and becomes a session cookie the socket is
 * signed in by; a preview uses nothing; a link used, run out, unknown or posted from another site
 * signs nobody in; sign out ends the session; anyone signed in makes anyone's link; and in
 * development the picker makes you anyone, which production refuses.
 */
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { createWs } from "../src/server/server";
import { upgradeWithAuth, wireAuth } from "../src/server/auth";
import { hashToken, linkAuth, makeLink, sqliteLinkStore, SESSION_COOKIE } from "../src/server/auth-link";
import { createTables, defineDoc, defineSchema, importTables, registerDocs } from "../src/server/sqlite";
import { setLogLevel } from "../src/server/logger";
import { linkStoreCases } from "../src/testing";

setLogLevel("silent");

type Person = { id: number; name: string };
const schema = defineSchema({ people: { columns: { name: "text" } } });
const docs = [defineDoc("people:", { root: "people", include: [] }), defineDoc("person:", { root: "people", include: [] })];

/** A server on a fresh database with Ann (1) and Bob (2), signing in by link: `dev` says whether the picker answers. */
function serve(dev: boolean) {
  const db = new Database(":memory:");
  createTables(db, schema);
  importTables(db, schema, { tables: { people: [{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }] }, sequences: { people: 2 } });
  const store = sqliteLinkStore(db);
  const personOf = (id: number) => db.query<Person, [number]>("SELECT id, name FROM people WHERE id = ?").get(id);
  const auth = linkAuth<Person>({ store, personOf, people: () => db.query<Person, []>("SELECT id, name FROM people ORDER BY id").all(), dev });
  const ws = createWs();
  wireAuth(ws, auth);
  registerDocs(ws, db, schema, docs, [], { auth, owns: (me: Person, name: string) => name === "people:" || name === `person:${me.id}` });
  const server = Bun.serve({ port: 0, routes: { ...auth.routes, "/ws": upgradeWithAuth(ws, auth) }, websocket: ws.websocket });
  ws.setServer(server);
  return { db, store, auth, server, origin: server.url.origin };
}

const live = serve(true);
const prod = serve(false);
afterAll(() => {
  live.server.stop(true);
  prod.server.stop(true);
});

/** The tap: the link's token posted from `origin` (the site's, unless said). */
const tap = (url: string, origin = live.origin) =>
  fetch(`${live.origin}/api/in/${url.split("#/in/")[1]}`, { method: "POST", headers: { origin } });
const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;

/** A socket at `at`, with `cookie` if given: what each request answers. */
async function socket(at: { server: Bun.Server<unknown> }, cookie?: string) {
  const sock = new WebSocket(new URL("/ws", at.server.url).href.replace("http", "ws"), { headers: cookie ? { cookie } : {} } as any);
  await new Promise((ok, no) => ((sock.onopen = ok), (sock.onerror = no)));
  let n = 0;
  const waiting = new Map<number, (msg: any) => void>();
  sock.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  };
  const ask = (msg: object) =>
    new Promise<any>((answer) => {
      const id = ++n;
      waiting.set(id, answer);
      sock.send(JSON.stringify({ id, ...msg }));
    });
  return { ask, close: () => sock.close() };
}

describe("a link", () => {
  test("is someone: its tap, from the site, signs them in, and the socket is them", async () => {
    const { url } = await makeLink(live.store, 1, { origin: live.origin, opens: "/people" });
    expect(url).toStartWith(`${live.origin}/#/in/`);
    const res = await tap(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, name: "Ann", opens: "/people" });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${SESSION_COOKIE}=[^;]+; .*HttpOnly`, "i"));

    const ann = await socket(live, cookieOf(res));
    try {
      expect((await ann.ask({ action: "call", method: "me" })).result).toEqual({ id: 1, name: "Ann" });
      expect((await ann.ask({ action: "open", doc: "person:1" })).result.people).toMatchObject({ id: 1, name: "Ann" });
      expect((await ann.ask({ action: "open", doc: "person:2" })).error.code).toBe(404); // Bob's is not hers
    } finally {
      ann.close();
    }
  });

  test("is used once: a second tap, a link run out, an unknown one, and one from another site sign nobody in", async () => {
    const { url } = await makeLink(live.store, 2, { origin: live.origin });
    expect((await tap(url, "https://elsewhere.example")).status).toBe(403); // another site: the link is still Bob's
    expect((await tap(url)).status).toBe(200);
    const again = await tap(url);
    expect(again.status).toBe(400);
    expect(again.headers.get("set-cookie")).toBeNull();

    const old = await makeLink(live.store, 2, { origin: live.origin, days: -1 });
    expect((await tap(old.url)).status).toBe(400);
    expect((await tap(`${live.origin}/#/in/nothing-we-made`)).status).toBe(400);
  });

  test("is kept only as its hash, and a preview that fetches the page uses nothing: only the tap, a POST, does", async () => {
    const { url } = await makeLink(live.store, 1, { origin: live.origin });
    const token = url.split("#/in/")[1]!;
    expect((live.db.query("SELECT count(*) AS n FROM _auth_links WHERE hash = ?").get(token) as { n: number }).n).toBe(0);
    expect(await live.store.link(hashToken(token))).toMatchObject({ person: 1, used: null });
    const fetched = await fetch(`${live.origin}/api/in/${token}`); // a GET, as a preview's
    expect(fetched.status).not.toBe(200);
    expect(fetched.headers.get("set-cookie")).toBeNull();
    expect((await live.store.link(hashToken(token)))!.used).toBeNull();
  });
});

describe("a session", () => {
  test("a socket with none is nobody: it may not open a document", async () => {
    const nobody = await socket(live);
    try {
      expect((await nobody.ask({ action: "call", method: "me" })).result).toBeNull();
      expect((await nobody.ask({ action: "open", doc: "people:" })).error.code).toBe(401);
    } finally {
      nobody.close();
    }
  });

  test("signing out ends it: the cookie is cleared, and a socket with it is nobody", async () => {
    const cookie = await live.auth.signInAs(2);
    const out = await fetch(`${live.origin}/api/out`, { method: "POST", headers: { origin: live.origin, cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    const after = await socket(live, cookie);
    try {
      expect((await after.ask({ action: "call", method: "me" })).result).toBeNull();
    } finally {
      after.close();
    }
    expect((await fetch(`${live.origin}/api/out`, { method: "POST", headers: { origin: "https://elsewhere.example", cookie } })).status).toBe(403);
  });

  test("is renewed as it is used, at most once a day", async () => {
    const cookie = await live.auth.signInAs(1);
    const hash = hashToken(cookie.split("=")[1]!);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString();
    await live.store.renewSession(hash, soon);
    (await socket(live, cookie)).close();
    await Bun.sleep(20);
    expect(Date.parse((await live.store.session(hash))!.expires)).toBeGreaterThan(Date.now() + 360 * 86_400_000);
  });

  test("one run out signs nobody in", async () => {
    const cookie = await live.auth.signInAs(1);
    await live.store.renewSession(hashToken(cookie.split("=")[1]!), new Date(Date.now() - 1000).toISOString());
    const late = await socket(live, cookie);
    try {
      expect((await late.ask({ action: "call", method: "me" })).result).toBeNull();
    } finally {
      late.close();
    }
  });
});

describe("making links", () => {
  test("anyone signed in makes anyone's link, opening where they say; nobody signed in makes none", async () => {
    const ann = await socket(live, await live.auth.signInAs(1));
    const nobody = await socket(live);
    try {
      const made = (await ann.ask({ action: "call", method: "link", params: { person: 2, opens: "/people" } })).result;
      expect(made.url).toStartWith(`${live.origin}/#/in/`);
      expect(await (await tap(made.url)).json()).toMatchObject({ id: 2, name: "Bob", opens: "/people" });
      expect((await ann.ask({ action: "call", method: "link", params: { person: 99 } })).error.code).toBe(401);
      expect((await nobody.ask({ action: "call", method: "link", params: { person: 1 } })).error.code).toBe(401);
    } finally {
      ann.close();
      nobody.close();
    }
  });

  test("an app may narrow who sends whose (mayLink)", async () => {
    const db = new Database(":memory:");
    const store = sqliteLinkStore(db);
    const auth = linkAuth<Person>({ store, personOf: (id) => ({ id, name: `#${id}` }), people: () => [], mayLink: (by, person) => by.id === person });
    const client = { data: { identity: { id: 1, name: "#1" } } };
    process.env.ORIGIN = "https://my.app"; // with no socket's site to name, production's ORIGIN
    try {
      expect(await auth.actions!.link!({ person: 2 }, client)).toEqual({ error: "Not yours to send" });
      expect(await auth.actions!.link!({ person: 1 }, client)).toMatchObject({ result: { url: expect.stringMatching(/^https:\/\/my\.app\/#\/in\//) } });
    } finally {
      delete process.env.ORIGIN;
    }
  });
});

describe("development", () => {
  test("lists everyone, and one click is a session as any of them", async () => {
    expect(await (await fetch(`${live.origin}/api/dev/people`)).json()).toEqual([{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }]);
    const as = await fetch(`${live.origin}/api/dev/as/2`, { method: "POST", headers: { origin: live.origin } });
    expect(await as.json()).toEqual({ id: 2, name: "Bob" });
    const bob = await socket(live, cookieOf(as));
    try {
      expect((await bob.ask({ action: "call", method: "me" })).result).toEqual({ id: 2, name: "Bob" });
    } finally {
      bob.close();
    }
    expect((await fetch(`${live.origin}/api/dev/as/9`, { method: "POST", headers: { origin: live.origin } })).status).toBe(404);
    expect((await fetch(`${live.origin}/api/dev/as/1`, { method: "POST", headers: { origin: "https://elsewhere.example" } })).status).toBe(403);
  });

  test("production answers none of it: no list, no picking, no signInAs", async () => {
    expect((await fetch(`${prod.origin}/api/dev/people`)).status).toBe(404);
    expect((await fetch(`${prod.origin}/api/dev/as/1`, { method: "POST", headers: { origin: prod.origin } })).status).toBe(404);
    expect(prod.auth.signInAs(1)).rejects.toThrow("development");
  });
});

// The store, as every backend's answers it (dzql's Postgres runs the same)
linkStoreCases("sqlite", async () => sqliteLinkStore(new Database(":memory:")));
