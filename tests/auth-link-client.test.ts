/**
 * Link sign-in in the page (`@blueshed/delta/auth-link/client`) against a real server: a page opened
 * by a link takes it, is signed in, and its address goes where the link opens with the token gone;
 * one used says why; a page opened by no link does nothing; and the development picker and sign out.
 * The page's `location`, `history` and same-origin `fetch` (which a browser sends with the site's
 * Origin) are stood in for.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createWs } from "../src/server/server";
import { upgradeWithAuth, wireAuth } from "../src/server/auth";
import { linkAuth, makeLink, sqliteLinkStore } from "../src/server/auth-link";
import { becomeAs, everyone, signOut, takeLink } from "../src/client/auth-link";

type Person = { id: number; name: string };
const people: Person[] = [{ id: 1, name: "Ann" }, { id: 2, name: "Bob" }];
const store = sqliteLinkStore(new Database(":memory:"));
const auth = linkAuth<Person>({ store, personOf: (id) => people.find((p) => p.id === id) ?? null, people: () => people, dev: true });
const ws = createWs();
wireAuth(ws, auth);
const server = Bun.serve({ port: 0, routes: { ...auth.routes, "/ws": upgradeWithAuth(ws, auth) }, websocket: ws.websocket });
const site = server.url.origin;

// The page, stood in for: where it is, its history, its reloads, and its fetches (from the site, with its cookie)
let reloads = 0;
let cookie = "";
const page = { hash: "", pathname: "/", search: "", reload: () => void reloads++ };
Object.assign(globalThis, {
  location: page,
  history: { replaceState: (_s: unknown, _t: string, url: string) => ([page.pathname, page.hash] = [url.split("#")[0]!, url.includes("#") ? `#${url.split("#")[1]}` : ""]) },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (path: string, init?: RequestInit) => {
  const res = await realFetch(`${site}${path}`, { ...init, headers: { origin: site, ...(cookie ? { cookie } : {}) } });
  const set = res.headers.get("set-cookie");
  if (set) cookie = /Max-Age=0/i.test(set) ? "" : set.split(";")[0]!;
  return res;
}) as typeof fetch;

afterAll(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as any).location;
  delete (globalThis as any).history;
  server.stop(true);
});
beforeEach(() => {
  [page.hash, page.pathname, cookie, reloads] = ["", "/", "", 0];
});

const opened = (url: string) => (page.hash = `#${url.split("#")[1]}`);

test("a page opened by a link takes it: signed in, at where the link opens, the token gone from the address", async () => {
  opened((await makeLink(store, 1, { origin: site, opens: "/people" })).url);
  expect(await takeLink()).toEqual({ person: { id: 1, name: "Ann" } });
  expect(page.hash).toBe("#/people");
  expect(cookie).toStartWith("delta_session=");
});

test("a link that opens at nowhere leaves the page at its start", async () => {
  opened((await makeLink(store, 2, { origin: site })).url);
  expect(await takeLink()).toEqual({ person: { id: 2, name: "Bob" } });
  expect(page.hash).toBe("");
});

test("a link used already says why, and its token leaves the address all the same", async () => {
  const { url } = await makeLink(store, 1, { origin: site });
  opened(url);
  await takeLink();
  opened(url);
  expect(await takeLink()).toEqual({ error: "That link has been used or has run out: ask for a new one." });
  expect(page.hash).toBe("");
});

test("a page opened by no link does nothing", async () => {
  page.hash = "#/people";
  expect(await takeLink()).toBeNull();
  expect(page.hash).toBe("#/people");
});

test("in development: everyone, be anyone, and sign out", async () => {
  expect(await everyone()).toEqual(people);
  await becomeAs(2);
  expect([cookie !== "", reloads]).toEqual([true, 1]);
  await signOut();
  expect([cookie, reloads]).toEqual(["", 2]);
  await expect(becomeAs(9)).rejects.toThrow("Nobody of that id");
});
