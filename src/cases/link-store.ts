/**
 * What every `LinkStore` answers alike (link sign-in, `../server/auth-link.ts`): SQLite's here, and
 * dzql's Postgres. A link is used once, and only while it lasts; two taps at once make one session;
 * an unknown link is nobody's; a session is found, renewed and ended by its hash. Times are ISO
 * strings, a person's id a number.
 *
 *   linkStoreCases("sqlite", async () => sqliteLinkStore(new Database(":memory:")));
 */
import { describe, expect, test } from "bun:test";
import type { LinkStore } from "../server/auth-link";

const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
let n = 0;
/** A hash no other case has used: a store may be one database for every case. */
const fresh = (what: string) => `${what}-${Date.now()}-${++n}`;

export function linkStoreCases(name: string, open: () => Promise<LinkStore>) {
  describe(`${name}: a link store`, () => {
    test("a link is kept as given, and used once while it lasts: who it is and where it opens", async () => {
      const store = await open();
      const hash = fresh("link");
      const until = at(7);
      await store.addLink(hash, { person: 7, opens: "/people", expires: until });
      expect(await store.link(hash)).toEqual({ person: 7, opens: "/people", expires: until, used: null });
      const now = new Date().toISOString();
      expect(await store.useLink(hash, now)).toEqual({ person: 7, opens: "/people" });
      expect(await store.useLink(hash, now)).toBeNull();
      expect((await store.link(hash))!.used).toBe(now);
    });

    test("a link run out, and one never made, are nobody's", async () => {
      const store = await open();
      const old = fresh("old");
      await store.addLink(old, { person: 7, opens: null, expires: at(-1) });
      expect(await store.useLink(old, new Date().toISOString())).toBeNull();
      expect(await store.useLink(fresh("never"), new Date().toISOString())).toBeNull();
      expect(await store.link(fresh("never"))).toBeNull();
    });

    test("two taps of one link at once: one is used, the other is nobody's", async () => {
      const store = await open();
      const hash = fresh("race");
      await store.addLink(hash, { person: 8, opens: null, expires: at(7) });
      const now = new Date().toISOString();
      const both = await Promise.all([store.useLink(hash, now), store.useLink(hash, now)]);
      expect(both.filter(Boolean)).toEqual([{ person: 8, opens: null }]);
    });

    test("a session is found by its hash, renewed, and ended", async () => {
      const store = await open();
      const hash = fresh("session");
      const until = at(365);
      await store.addSession(hash, { person: 9, expires: until });
      expect(await store.session(hash)).toEqual({ person: 9, expires: until });
      const later = at(400);
      await store.renewSession(hash, later);
      expect(await store.session(hash)).toEqual({ person: 9, expires: later });
      await store.endSession(hash);
      expect(await store.session(hash)).toBeNull();
      expect(await store.session(fresh("never"))).toBeNull();
    });
  });
}
