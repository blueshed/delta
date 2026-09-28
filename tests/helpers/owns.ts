/**
 * With auth, every document says who owns it -- the same on every backend
 * (todo #6). The JSON file and SQLite take `registerDocs(..., { auth, owns |
 * shared })`, Postgres `docTypeFromDef(def, pool, { auth, owns | shared })` and
 * `createDocListener(ws, pool, { auth })`; custom documents say it in
 * `defineCustomDoc(prefix, { owns | shared })` on each. Each backend's file
 * supplies `start` and asks every case below of it.
 */
import { describe, expect, test } from "bun:test";
import type { DeltaAuth } from "../../src/server/auth";
import { expectTold, household, openAll, type PathBackend } from "./path";

export type Me = { id: number; email?: string };

/** Who is signed in is what the caller carries (`createLocal().as(identity)`). */
export const auth: DeltaAuth<Me> = {
  gate: (c: any) => (c.data?.identity as Me | undefined) ?? { error: "Authentication required" },
  asSqlArg: (me) => me.id,
};

/** A path document is its owner's when its name ends in their id: fo-board:1 is ada's. */
export const ownsByName = (me: Me, docName: string) => docName.endsWith(`:${me.id}`);

/** Each custom document's word on who owns it: the inbox of one's own email, the menu card of one's own wedding. */
export const customOwns = {
  inbox: (me: Me, docName: string) => docName === `fo-inbox:${me.email}`,
  menuCard: (me: Me, docName: string) => docName === `fo-menu-card:${me.id}`,
};

/**
 * A membership document read as each identity: the households of one's own
 * wedding, whatever its name -- queried and matched as each, so two
 * identities on one name each hold their own rows. Only the read differs by backend.
 */
export const mineDoc = <Q>(query: Q) => ({
  prefix: "fo-mine:",
  watch: ["households"],
  parse: (id: string) => id,
  query,
  matches: (_coll: string, row: any, _c: string, me?: Me) => row.weddings_id === me?.id,
  shared: true,
});

/** A recompute document read as each subscriber: who it was read as. `whoamiReads` counts its reads. */
export const whoamiReads = { n: 0 };
export const whoamiDoc = <R extends (...args: any[]) => any>(read: R) => ({
  prefix: "fo-whoami:", watch: ["courses"], parse: (id: string) => id, shared: true,
  recompute: ((...args: any[]) => { whoamiReads.n++; return read(...args); }) as R,
});

export interface OwnsProcess {
  as(identity?: Me): { call(action: string, msg: Record<string, unknown>): Promise<any> };
  backend: PathBackend;
}

export interface OwnsBackend {
  /**
   * A process over the path's data with `auth`: the path's documents owned by
   * `owns`, or `shared`, or neither (it throws, as registering does); the
   * custom documents with their own owns ("owned") or none ("neither").
   */
  start(opts: { owns?: (me: Me, docName: string) => boolean | Promise<boolean>; shared?: boolean; custom?: "owned" | "neither"; noAuth?: boolean }): Promise<OwnsProcess>;
}

/** Who each message on `channel` was sent to alone (`createLocal`'s `to`), with its first op's value (or the op). */
const sentTo = (p: OwnsProcess, channel: string) =>
  (p.backend.process.heard as { channel: string; data: any; to?: { identity: any } }[])
    .filter((h) => h.channel === channel)
    .map((h) => [h.to?.identity?.id, h.data.ops[0].path === "" ? h.data.ops[0].value : h.data.ops[0]]);

const ada: Me = { id: 1, email: "a@x" };
const bob: Me = { id: 2, email: "c@x" };

export function ownsCases(backend: () => OwnsBackend): void {
  describe("with auth, every document says who owns it (todo #6)", () => {
    test("a document registered with neither owns nor shared is refused, and so is a custom document; the error says what to add", async () => {
      await expect(backend().start({})).rejects.toThrow(/with auth, say who may open it -- owns: \(identity, docName\) => boolean, or shared: true/);
      await expect(backend().start({ owns: ownsByName, custom: "neither" })).rejects.toThrow(/defineCustomDoc\("fo-inbox:"\): with auth, say who may open it/);
    });

    test("owns or shared given with no auth module is refused, as a custom document's: nothing would ask it, and every socket would open every document", async () => {
      await expect(backend().start({ owns: ownsByName, noAuth: true, custom: "neither" })).rejects.toThrow(/"fo-board:[^"]*"\): owns and shared are asked only with an auth module/);
      await expect(backend().start({ shared: true, noAuth: true, custom: "neither" })).rejects.toThrow(/"fo-board:[^"]*"\): owns and shared are asked only with an auth module/);
      await expect(backend().start({ custom: "owned", noAuth: true })).rejects.toThrow(/defineCustomDoc\("fo-inbox:"\): owns and shared are asked only with an auth module/);
      const open = await backend().start({ noAuth: true, custom: "neither" });   // neither: every socket opens every document, as it says
      expect((await open.as().call("open", { doc: "fo-board:1" })).error).toBeUndefined();
    });

    test("the gate: a caller with no identity is refused (401) opening, writing, reading as it stood, asking the history, walking and closing", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      const anon = p.as();
      for (const [action, msg] of [
        ["open", { doc: "fo-board:1" }],
        ["delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/weddings/name", value: "x" }] }],
        ["open_at", { doc: "fo-board:1", at: new Date().toISOString() }],
        ["history", { doc: "fo-board:1" }],
        ["undo", { cursor: "c1" }],
        ["redo", { cursor: "c1" }],
        ["close", { doc: "fo-board:1" }],
        ["open", { doc: "fo-inbox:a@x" }],
        ["open", { doc: "fo-menu-card:1" }],
      ] as const) {
        expect({ action, msg, code: (await anon.call(action, msg)).error?.code }).toEqual({ action, msg, code: 401 });
      }
    });

    test("owns: an identity opens, writes through, reads as it stood and asks the history of its own document; another's, or one nobody owns, is not there (404)", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      const me = p.as(ada);
      expect((await me.call("open", { doc: "fo-board:1" })).error).toBeUndefined();
      expect((await me.call("delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/weddings/name", value: "ours, still" }] })).error).toBeUndefined();
      expect((await me.call("open_at", { doc: "fo-board:1", at: new Date().toISOString() })).error).toBeUndefined();
      expect((await me.call("history", { doc: "fo-board:1" })).result).toHaveLength(1);
      for (const [action, msg] of [
        ["open", { doc: "fo-board:2" }],
        ["delta", { doc: "fo-board:2", ops: [{ op: "replace", path: "/weddings/name", value: "mine now" }] }],
        ["open_at", { doc: "fo-board:2", at: new Date().toISOString() }],
        ["history", { doc: "fo-board:2" }],
        ["open", { doc: "fo-all-courses:" }],
      ] as const) {
        expect({ action, msg, error: (await me.call(action, msg)).error }).toEqual({ action, msg, error: { code: 404, message: "Not found" } });
      }
      expect((await p.as(bob).call("open", { doc: "fo-board:2" })).result.weddings).toEqual({ id: 2, name: "theirs" });   // untouched
    });

    test("an undo or redo reaches only a document the walker owns: another identity walking a cursor into ada's document is a 404, and walks nothing", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      await p.as(ada).call("open", { doc: "fo-board:1" });
      expect((await p.as(ada).call("delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/weddings/name", value: "renamed" }], cursor: "c1" })).error).toBeUndefined();
      expect((await p.as(bob).call("undo", { cursor: "c1" })).error).toEqual({ code: 404, message: "Not found" });
      const name = async () => (await p.as(ada).call("open", { doc: "fo-board:1" })).result.weddings.name;
      expect(await name()).toBe("renamed");
      expect((await p.as(ada).call("undo", { cursor: "c1" })).error).toBeUndefined();
      expect(await name()).toBe("ours");
      expect((await p.as(bob).call("redo", { cursor: "c1" })).error).toEqual({ code: 404, message: "Not found" });
      expect(await name()).toBe("ours");
      expect((await p.as(ada).call("redo", { cursor: "c1" })).error).toBeUndefined();
      expect(await name()).toBe("renamed");
    });

    test("owns may answer with a promise (a lookup): its answer is awaited, on every action it is asked for", async () => {
      const p = await backend().start({ owns: async (me, name) => { await new Promise((r) => setTimeout(r, 5)); return ownsByName(me, name); }, custom: "owned" });
      const me = p.as(ada);
      expect((await me.call("open", { doc: "fo-board:1" })).error).toBeUndefined();
      expect((await me.call("delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/weddings/name", value: "later" }], cursor: "c2" })).error).toBeUndefined();
      expect((await me.call("open", { doc: "fo-board:2" })).error).toEqual({ code: 404, message: "Not found" });
      expect((await me.call("delta", { doc: "fo-board:2", ops: [{ op: "replace", path: "/weddings/name", value: "x" }] })).error).toEqual({ code: 404, message: "Not found" });
      expect((await p.as(bob).call("undo", { cursor: "c2" })).error).toEqual({ code: 404, message: "Not found" });
      expect((await me.call("undo", { cursor: "c2" })).error).toBeUndefined();
    });

    test("shared: every identity past the gate may have every document; none without one", async () => {
      const p = await backend().start({ shared: true, custom: "owned" });
      expect((await p.as(bob).call("open", { doc: "fo-board:1" })).error).toBeUndefined();
      expect((await p.as(bob).call("open", { doc: "fo-all-courses:" })).error).toBeUndefined();
      expect((await p.as().call("open", { doc: "fo-board:1" })).error?.code).toBe(401);
    });

    test("a custom document says who owns it: one's own inbox and menu card open; another's are not there (404)", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      const me = p.as(ada);
      expect((await me.call("open", { doc: "fo-inbox:a@x" })).error).toBeUndefined();
      expect((await me.call("open", { doc: "fo-menu-card:1" })).error).toBeUndefined();
      expect((await me.call("open", { doc: "fo-inbox:b@x" })).error).toEqual({ code: 404, message: "Not found" });
      expect((await me.call("open", { doc: "fo-menu-card:2" })).error).toEqual({ code: 404, message: "Not found" });
    });

    test("a membership document is queried, held and told as each identity: two on one name each hold and hear their own rows", async () => {
      const p = await backend().start({ owns: (me, name) => ownsByName(me, name) || (me.id === 2 && name === "fo-household:3"), custom: "owned" });
      const rows = async (who: Me) => (await p.as(who).call("open", { doc: "fo-mine:x" })).result.households;
      expect(await rows(ada)).toEqual({ "1": household(1, "a@x"), "2": household(2, "b@x") });
      expect(await rows(bob)).toEqual({ "3": household(3, "c@x", 2) });
      await openAll(p.backend.process, []);   // what the writes tell, from here
      await p.as(ada).call("open", { doc: "fo-board:1" });
      await p.as(bob).call("open", { doc: "fo-board:2" });
      expect((await p.as(ada).call("delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/households/1/email", value: "z@x" }] })).error).toBeUndefined();
      await expectTold(p.backend, "fo-mine:x", [[{ op: "replace", path: "/households/1", value: household(1, "z@x") }]]);
      await p.as(bob).call("open", { doc: "fo-household:3" });
      expect((await p.as(bob).call("delta", { doc: "fo-household:3", ops: [{ op: "replace", path: "/households/weddings_id", value: 1 }] })).error).toBeUndefined();
      await expectTold(p.backend, "fo-mine:x", [
        [{ op: "replace", path: "/households/1", value: household(1, "z@x") }],
        [{ op: "add", path: "/households/3", value: household(3, "c@x") }],   // ada's
        [{ op: "remove", path: "/households/3" }],                                                // bob's
      ]);
      expect(sentTo(p, "fo-mine:x").slice(1)).toEqual([[1, { op: "add", path: "/households/3", value: household(3, "c@x") }], [2, { op: "remove", path: "/households/3" }]]);
      expect(Object.keys(await rows(ada)).sort()).toEqual(["1", "2", "3"]);
      expect(await rows(bob)).toEqual({});
    });

    test("a recompute document is read once per identity after a write, however many of its subscribers are that identity; each is told it", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      const adaHere = p.as(ada), adaThere = p.as({ id: 1 });   // two callers, one identity (auth.asSqlArg: 1)
      for (const who of [adaHere, adaThere, p.as(bob)]) expect((await who.call("open", { doc: "fo-whoami:x" })).error).toBeUndefined();
      await openAll(p.backend.process, []);
      await adaHere.call("open", { doc: "fo-board:1" });
      whoamiReads.n = 0;
      expect((await adaHere.call("delta", { doc: "fo-board:1", ops: [{ op: "add", path: "/courses/-", value: { name: "Fish" } }] })).error).toBeUndefined();
      await expectTold(p.backend, "fo-whoami:x", [[{ op: "replace", path: "", value: { me: 1 } }], [{ op: "replace", path: "", value: { me: 1 } }], [{ op: "replace", path: "", value: { me: 2 } }]]);
      expect(whoamiReads.n).toBe(2);
    });

    test("a recompute document is read as each subscriber, on open and after a write: each is told its own", async () => {
      const p = await backend().start({ owns: ownsByName, custom: "owned" });
      expect((await p.as(ada).call("open", { doc: "fo-whoami:x" })).result).toEqual({ me: 1 });
      expect((await p.as(bob).call("open", { doc: "fo-whoami:x" })).result).toEqual({ me: 2 });
      await openAll(p.backend.process, []);   // what the writes tell, from here
      await p.as(ada).call("open", { doc: "fo-board:1" });
      expect((await p.as(ada).call("delta", { doc: "fo-board:1", ops: [{ op: "add", path: "/courses/-", value: { name: "Fish" } }] })).error).toBeUndefined();
      await expectTold(p.backend, "fo-whoami:x", [[{ op: "replace", path: "", value: { me: 1 } }], [{ op: "replace", path: "", value: { me: 2 } }]]);
      // each sent to the identity it was read as
      expect(sentTo(p, "fo-whoami:x")).toEqual([[1, { me: 1 }], [2, { me: 2 }]]);
    });
  });
}
