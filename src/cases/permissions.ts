/**
 * A document's `owns` as a path (`../paths.ts`), the same on every backend: SQLite and the JSON
 * file here, dzql's Postgres compiled. A person opens, writes through and walks a document whose
 * path reaches them; one it does not reach is not there (404); a write that would take the row
 * out of their reach is refused (403), so a row is never handed away; a path through a table that
 * keeps versions reads its current rows; and a path that cannot be followed is refused at
 * registration, naming the document. Each backend's file supplies `start`.
 *
 *   permissionCases("sqlite", () => ({ start: async (docs) => ... }));
 */
import { describe, expect, test } from "bun:test";
import { defineDoc, defineSchema, type DocDef } from "../schema";
import type { DeltaAuth } from "../server/auth";

export type Person = { id: number; name: string };

/** Who is signed in is what the caller carries (`createLocal().as(person)`); the path compares their id. */
export const permissionAuth: DeltaAuth<Person> = {
  gate: (c: any) => (c.data?.identity as Person | undefined) ?? { error: "Authentication required" },
  asSqlArg: (p) => p.id,
};

export const permissionSchema = defineSchema({
  people: { columns: { name: "text" }, temporal: false },
  orgs: { columns: { name: "text" }, temporal: false },
  members: { columns: { org_id: "integer", person_id: "integer", active: "boolean" } },   // keeps versions
  venues: { columns: { org_id: "integer", name: "text" }, temporal: false },
  posts: { columns: { author_id: "integer", title: "text" }, temporal: false },
});

/** Ann and Ben in North, Cy in South, Ben once in South and no longer. */
export const permissionSeed = {
  tables: {
    people: [{ id: 1, name: "Ann" }, { id: 2, name: "Ben" }, { id: 3, name: "Cy" }],
    orgs: [{ id: 1, name: "North" }, { id: 2, name: "South" }],
    members: [
      { id: 1, org_id: 1, person_id: 1, active: true },
      { id: 2, org_id: 1, person_id: 2, active: true },
      { id: 3, org_id: 2, person_id: 3, active: true },
      { id: 4, org_id: 2, person_id: 2, active: false },
    ],
    venues: [{ id: 1, org_id: 1, name: "Hall" }, { id: 2, org_id: 2, name: "Barn" }],
    posts: [{ id: 1, author_id: 1, title: "Ann's" }, { id: 2, author_id: 2, title: "Ben's" }],
  },
};

export const permissionDocs = {
  /** One's own post: the row's author. */
  post: defineDoc("post:", { root: "posts", include: [], owns: "@author_id" }),
  /** A venue, for the active members of its org: two hops, a condition, through a table that keeps versions. */
  venue: defineDoc("venue:", { root: "venues", include: [], owns: "@org_id->members[org_id=$]{active}.person_id" }),
  /** An org's venues, for its active members: the path starts at the name's value. */
  venuesOf: defineDoc("venues-of:", { root: "venues", include: [], scope: { org_id: ":org" }, owns: "members[org_id=@org_id]{active}.person_id" }),
  /** Every membership, for anyone signed in. */
  members: defineDoc("members:", { root: "members", include: [], owns: "AUTHENTICATED" }),
  /** Nobody's. */
  sealed: defineDoc("sealed:", { root: "orgs", include: [], owns: "FALSE" }),
};

const ann: Person = { id: 1, name: "Ann" };
const ben: Person = { id: 2, name: "Ben" };
const cy: Person = { id: 3, name: "Cy" };
const NOT_FOUND = { code: 404, message: "Not found" };

export interface PermissionProcess {
  as(person: Person): { call(action: string, msg: Record<string, unknown>): Promise<any> };
}

export interface PermissionBackend {
  /** A process with `permissionAuth` over `permissionSchema`, holding `permissionSeed`, with `docs` registered (a ledger kept). */
  start(docs: DocDef[]): Promise<PermissionProcess>;
}

export function permissionCases(name: string, backend: () => PermissionBackend): void {
  const all = Object.values(permissionDocs);
  describe(`${name}: owns as a path`, () => {
    test("@field: one's own post opens and takes writes; another's is not there (404)", async () => {
      const p = await backend().start(all);
      expect((await p.as(ann).call("open", { doc: "post:1" })).result.posts.title).toBe("Ann's");
      expect((await p.as(ann).call("delta", { doc: "post:1", ops: [{ op: "replace", path: "/posts/title", value: "Ann's, edited" }] })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "post:2" })).error).toEqual(NOT_FOUND);
      expect((await p.as(ann).call("delta", { doc: "post:2", ops: [{ op: "replace", path: "/posts/title", value: "mine now" }] })).error).toEqual(NOT_FOUND);
      expect((await p.as(ben).call("open", { doc: "post:2" })).result.posts.title).toBe("Ben's");
    });

    test("a chain: a venue opens for its org's active members; to an inactive or a non-member it is not there", async () => {
      const p = await backend().start(all);
      expect((await p.as(ann).call("open", { doc: "venue:1" })).error).toBeUndefined();
      expect((await p.as(ben).call("open", { doc: "venue:1" })).error).toBeUndefined();
      expect((await p.as(cy).call("open", { doc: "venue:1" })).error).toEqual(NOT_FOUND);
      expect((await p.as(ben).call("open", { doc: "venue:2" })).error).toEqual(NOT_FOUND);   // a member of South no longer
      expect((await p.as(cy).call("open", { doc: "venue:2" })).error).toBeUndefined();
    });

    test("a path from the name: an org's venues open for its active members, and a name that gives no org opens for nobody", async () => {
      const p = await backend().start(all);
      expect(Object.values((await p.as(ann).call("open", { doc: "venues-of:1" })).result.venues)).toEqual([{ id: 1, org_id: 1, name: "Hall" }]);
      expect((await p.as(ann).call("open", { doc: "venues-of:2" })).error).toEqual(NOT_FOUND);
      expect((await p.as(cy).call("open", { doc: "venues-of:2" })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "venues-of:" })).error).toEqual(NOT_FOUND);
    });

    test("a membership let go, as the tables keep versions: its old version reaches nobody", async () => {
      const p = await backend().start(all);
      await p.as(cy).call("open", { doc: "members:" });
      expect((await p.as(cy).call("delta", { doc: "members:", ops: [{ op: "replace", path: "/members/1/active", value: false }] })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "venue:1" })).error).toEqual(NOT_FOUND);
      expect((await p.as(ann).call("open", { doc: "venues-of:1" })).error).toEqual(NOT_FOUND);
      expect((await p.as(ben).call("open", { doc: "venue:1" })).error).toBeUndefined();
    });

    test("a row is never handed away: a write that would take it out of the writer's reach is refused (403), and changes nothing", async () => {
      const p = await backend().start(all);
      await p.as(ann).call("open", { doc: "post:1" });
      const given = await p.as(ann).call("delta", { doc: "post:1", ops: [{ op: "replace", path: "/posts/author_id", value: 2 }] });
      expect(given.error?.code).toBe(403);
      expect((await p.as(ann).call("open", { doc: "post:1" })).result.posts.author_id).toBe(1);
      expect((await p.as(ben).call("open", { doc: "post:1" })).error).toEqual(NOT_FOUND);
      await p.as(ann).call("open", { doc: "venue:1" });
      expect((await p.as(ann).call("delta", { doc: "venue:1", ops: [{ op: "replace", path: "/venues/org_id", value: 2 }] })).error?.code).toBe(403);
    });

    test("removing one's own row is no handing away: the post goes", async () => {
      const p = await backend().start(all);
      await p.as(ann).call("open", { doc: "post:1" });
      expect((await p.as(ann).call("delta", { doc: "post:1", ops: [{ op: "remove", path: "/posts/1" }] })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "post:1" })).error).toEqual(NOT_FOUND);   // gone: a path from a row that is not there reaches nobody
    });

    test("an undo walks only a document whose path reaches the walker", async () => {
      const p = await backend().start(all);
      await p.as(ann).call("open", { doc: "post:1" });
      await p.as(ann).call("delta", { doc: "post:1", ops: [{ op: "replace", path: "/posts/title", value: "changed" }], cursor: "c1" });
      expect((await p.as(ben).call("undo", { cursor: "c1" })).error).toEqual(NOT_FOUND);
      expect((await p.as(ann).call("undo", { cursor: "c1" })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "post:1" })).result.posts.title).toBe("Ann's");
    });

    test("TRUE, FALSE and AUTHENTICATED: anyone signed in opens members:; nobody opens sealed:", async () => {
      const p = await backend().start(all);
      expect((await p.as(ben).call("open", { doc: "members:" })).error).toBeUndefined();
      expect((await p.as(ann).call("open", { doc: "sealed:1" })).error).toEqual(NOT_FOUND);
    });

    test("a path that cannot be followed is refused at registration, naming the document, the path and what is wrong", async () => {
      const refused = (owns: string, scope?: Record<string, string>) =>
        backend().start([defineDoc("bad:", { root: "venues", include: [], owns, ...(scope ? { scope } : {}) })]);
      await expect(refused("@org_id->clubs[org_id=$].person_id")).rejects.toThrow(`doc "bad:": its owns path cannot be followed: no collection clubs`);
      await expect(refused("@org_id->members[org_id=$].user_id")).rejects.toThrow("members has no column user_id");
      await expect(refused("@name->members[org_id=$].person_id")).rejects.toThrow("venues.name is text, not an integer key");
      await expect(refused("members[org_id=@id]{active}.person_id", { org_id: ":org" })).rejects.toThrow("it starts at @id, which the name does not give (its keys: org_id)");
      expect(() => defineDoc("worse:", { root: "venues", include: [], owns: "@org_id->" })).toThrow(`doc "worse:": an empty hop`);
    });

    test("a document with a path needs no owns or shared beside it; one without still does", async () => {
      await expect(backend().start([permissionDocs.post, defineDoc("open:", { root: "orgs", include: [] })])).rejects.toThrow(/"open:"/);
    });
  });
}
