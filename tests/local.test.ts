import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLocal } from "../src/server/local";
import { createTables, defineDoc, defineSchema, inverseOf, registerDocs } from "../src/server/sqlite";
import { registerDoc } from "../src/server/server";
import { registerMemory } from "../src/server/kinds";
import { applyOps, type DeltaOp } from "../src/core";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

const schema = defineSchema({
  rooms: { columns: { topic: "text?" }, temporal: false },
  messages: { parent: "rooms", columns: { text: "text" }, temporal: false },
});
const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });

function setup() {
  const db = new Database(":memory:");
  createTables(db, schema);
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  const { evict } = registerDocs(local.server, db, schema, [room]);
  return { db, local, heard, evict };
}

describe("createLocal", () => {
  test("opens, writes and hears the broadcast, with no socket", async () => {
    const { local, heard } = setup();
    expect((await local.call("open", { doc: "room:a" })).result).toEqual({ rooms: { id: "a", topic: null }, messages: {} });
    expect((await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] })).result).toEqual({ ack: true });
    expect(heard).toEqual([{ channel: "room:a", data: { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { id: "m1", rooms_id: "a", text: "hi" } }] } }]);
  });

  test("an unknown action answers with an error", async () => {
    expect((await setup().local.call("nope", {})).error?.message).toContain("No handler matched");
  });

  test("a handler that answers after an await is waited for", async () => {
    const local = createLocal();
    local.server.on("slow", async (_m, _c, respond) => { await Bun.sleep(1); respond({ result: 1 }); });
    expect((await local.call("slow", {})).result).toBe(1);
  });

  test("unsubscribing from publish stops the hearing", async () => {
    const local = createLocal();
    const heard: string[] = [];
    const off = local.onPublish((channel) => heard.push(channel));
    local.server.publish("x", {});
    off();
    local.server.publish("y", {});
    expect(heard).toEqual(["x"]);
  });
});

describe("in process, an answer is the caller's own, as over the socket", () => {
  /** Open, keep the answer, write: it is unchanged. Change it, reopen: the change is not served. */
  async function ownAnswer(local: ReturnType<typeof createLocal>, doc: string, ops: DeltaOp[], mutate: (kept: any) => void) {
    const kept = (await local.call("open", { doc })).result;
    const was = structuredClone(kept);
    expect((await local.call("delta", { doc, ops })).error).toBeUndefined();
    expect(kept).toEqual(was);
    mutate(kept);
    expect(JSON.stringify((await local.call("open", { doc })).result)).not.toContain("MUTATED");
  }

  test("the JSON file (registerDoc)", async () => {
    const file = `/tmp/delta-local-own-${Date.now()}.json`;
    const local = createLocal();
    await registerDoc(local.server, "chat:room", { file, empty: { messages: { m1: { text: "hi" }, m2: { text: "yo" } } as Record<string, any>, title: "t" } });
    await ownAnswer(local, "chat:room", [{ op: "replace", path: "/messages/m1/text", value: "edited" }, { op: "remove", path: "/messages/m2" }],
      (kept) => { kept.messages.m1.text = "MUTATED"; kept.title = "MUTATED"; });
    try { (await import("node:fs")).unlinkSync(file); } catch {}
  });

  test("a memory document, and what peek gives", async () => {
    const local = createLocal();
    const here = registerMemory(local.server, { prefix: "here:", empty: () => ({ people: { p1: { name: "Ada" } } as Record<string, any> }) });
    await ownAnswer(local, "here:a", [{ op: "add", path: "/people/p2", value: { name: "Bo" } }], (kept) => { kept.people.p1.name = "MUTATED"; });
    here.peek("here:a")!.people.p1.name = "MUTATED";
    expect(JSON.stringify((await local.call("open", { doc: "here:a" })).result)).not.toContain("MUTATED");
  });

  test("SQLite, the cached copy", async () => {
    const { local } = setup();
    await local.call("open", { doc: "room:a" });
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }, { op: "add", path: "/messages/m2", value: { text: "yo" } }] });
    await ownAnswer(local, "room:a", [{ op: "replace", path: "/messages/m1/text", value: "edited" }, { op: "remove", path: "/messages/m2" }],
      (kept) => { kept.messages.m1.text = "MUTATED"; kept.rooms.topic = "MUTATED"; });
  });

  test("the copy keeps what is not plain data as it is: an own __proto__ stays a key, a Date a Date, a function handed over", async () => {
    const local = createLocal();
    const fn = () => 1;
    const value = { row: JSON.parse('{"__proto__":{"polluted":true},"a":1}'), at: new Date(0), fn, list: [{ b: 2 }] };
    local.server.on("probe", (_m, _c, respond) => respond({ result: value }));
    const { result } = await local.call("probe", {});
    expect(result).not.toBe(value);
    expect(Object.getPrototypeOf(result.row)).toBe(Object.prototype);
    expect(Object.keys(result.row)).toEqual(["__proto__", "a"]);
    expect(result.row.polluted).toBeUndefined();
    expect(result.at).toEqual(new Date(0));
    expect(result.at).not.toBe(value.at);
    expect(result.list).toEqual([{ b: 2 }]);
    expect(result.list[0]).not.toBe(value.list[0]);
    expect(result.fn).toBe(fn);
  });

  test("a copy kept eta's way -- the open spread, each told change applied to a clone -- takes a remove (#4)", async () => {
    // eta's documents.ts: `const { _v, ...value } = answer.result`, then applyOps(structuredClone(held), data.ops)
    const db = new Database(":memory:");
    createTables(db, schema);
    const local = createLocal();
    registerDocs(local.server, db, schema, [room, defineDoc("all-messages:", { root: "messages", include: [] })], [], { ledger: true });
    await local.call("open", { doc: "room:a" });
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
    const held = new Map<string, any>();
    const failed: string[] = [];
    local.onPublish((doc, data) => {
      if (!held.has(doc)) return;
      try { const next = structuredClone(held.get(doc)); applyOps(next, data.ops); held.set(doc, next); }
      catch (err: any) { failed.push(`${doc}: ${err.message}`); }
    });
    for (const doc of ["room:a", "all-messages:"]) {
      const { _v, ...value } = (await local.call("open", { doc })).result;
      held.set(doc, value);
    }
    await local.call("delta", { doc: "room:a", ops: [{ op: "remove", path: "/messages/m1" }] });
    expect(failed).toEqual([]);
    for (const [doc, value] of held) {
      const { _v, ...fresh } = (await local.call("open", { doc })).result;
      expect({ doc, value }).toEqual({ doc, value: fresh });
    }
    expect(held.get("all-messages:").messages).toEqual({});
  });
});

describe("implied docs", () => {
  test("open empty without making a row; the first write makes it", async () => {
    const { db, local } = setup();
    await local.call("open", { doc: "room:attic" });
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 0 });
    await local.call("delta", { doc: "room:attic", ops: [{ op: "add", path: "/messages/m1", value: { text: "up here" } }] });
    expect(db.query("SELECT id FROM rooms").all()).toEqual([{ id: "attic" }]);
    expect(db.query("SELECT rooms_id FROM messages").all()).toEqual([{ rooms_id: "attic" }]);
  });

  test("a failed first write makes no row", async () => {
    const { db, local } = setup();
    await local.call("open", { doc: "room:attic" });
    const answer = await local.call("delta", { doc: "room:attic", ops: [{ op: "replace", path: "/messages/ghost/text", value: "x" }] });
    expect(answer.error).toBeDefined();
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 0 });
  });

  test("an implied doc cannot also declare a scope", async () => {
    expect(() => defineDoc("x:", { root: "rooms", include: [], scope: { id: ":docId" }, implied: true })).toThrow("implied");
  });

  test("a doc that is not implied still 404s", async () => {
    const local = createLocal();
    const db = new Database(":memory:");
    createTables(db, schema);
    registerDocs(local.server, db, schema, [defineDoc("plain:", { root: "rooms", include: ["messages"] })]);
    expect((await local.call("open", { doc: "plain:nowhere" })).error?.code).toBe(404);
  });
});

describe("savepoints", () => {
  test("a write inside the caller's transaction rolls back with it", async () => {
    const { db, local, evict } = setup();
    db.exec("BEGIN");
    await local.call("open", { doc: "room:a" });
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
    db.exec("ROLLBACK");
    evict("room:a");
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect((await local.call("open", { doc: "room:a" })).result.messages).toEqual({});
  });

  test("a failed write inside the caller's transaction leaves the caller's own work alone", async () => {
    const { db, local } = setup();
    await local.call("open", { doc: "room:a" });
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
    db.exec("BEGIN");
    db.run("UPDATE messages SET text = 'mine' WHERE id = 'm1'");
    const answer = await local.call("delta", { doc: "room:a", ops: [{ op: "replace", path: "/messages/ghost/text", value: "x" }] });
    expect(answer.error).toBeDefined();
    expect(db.query("SELECT text FROM messages").get()).toEqual({ text: "mine" });
    db.exec("COMMIT");
  });
});

describe("inverse", () => {
  test("asked for, the answer carries what was applied and its inverse", async () => {
    const { local } = setup();
    await local.call("open", { doc: "room:a" });
    const answer = await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }], inverse: true });
    expect(answer.result.ops).toEqual([{ op: "add", path: "/messages/m1", value: { id: "m1", rooms_id: "a", text: "hi" } }]);
    expect(answer.result.inverse).toEqual([{ op: "remove", path: "/messages/m1" }]);
  });

  test("applying the inverse restores the document, and its own inverse is the write again", async () => {
    const { local } = setup();
    const open = async () => (await local.call("open", { doc: "room:a" })).result;
    await open();
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }, { op: "replace", path: "/rooms/topic", value: "tea" }] });
    const before = structuredClone(await open());
    const write = await local.call("delta", { doc: "room:a", ops: [{ op: "remove", path: "/messages/m1" }, { op: "replace", path: "/rooms/topic", value: "coffee" }], inverse: true });
    const after = structuredClone(await open());
    const undo = await local.call("delta", { doc: "room:a", ops: write.result.inverse, inverse: true });
    expect(await open()).toEqual(before);
    await local.call("delta", { doc: "room:a", ops: undo.result.inverse });
    expect(await open()).toEqual(after);
  });

  test("a run of removes comes back parent first; other ops in reverse", async () => {
    const before = { p: { 1: { id: "1" } }, c: { 2: { id: "2", p_id: "1" } }, r: { id: "r", x: 1 } };
    expect(inverseOf(before, [
      { op: "replace", path: "/r", value: { id: "r", x: 2 } },
      { op: "remove", path: "/p/1" },
      { op: "remove", path: "/c/2" },
      { op: "add", path: "/c/3", value: { id: "3" } },
    ])).toEqual([
      { op: "remove", path: "/c/3" },
      { op: "add", path: "/p/1", value: { id: "1" } },
      { op: "add", path: "/c/2", value: { id: "2", p_id: "1" } },
      { op: "replace", path: "/r", value: { id: "r", x: 1 } },
    ]);
  });

  test("told what was asked, each remove asked for starts its own run: an undo's removes, children first, come back parent first", async () => {
    const before = { p: { 1: { id: 1 } }, c: { 2: { id: 2, p_id: 1 }, 3: { id: 3, p_id: 1 } } };
    const back = [
      { op: "add", path: "/p/1", value: { id: 1 } },
      { op: "add", path: "/c/2", value: { id: 2, p_id: 1 } },
      { op: "add", path: "/c/3", value: { id: 3, p_id: 1 } },
    ] as const;
    const undo = [{ op: "remove", path: "/c/3" }, { op: "remove", path: "/c/2" }, { op: "remove", path: "/p/1" }] as const;
    expect(inverseOf(before, [...undo], [...undo])).toEqual([...back]);
    // the parent asked for (as /p/01, told at /p/1), its children cascaded: one run
    const cascade = [{ op: "remove", path: "/p/1" }, { op: "remove", path: "/c/2" }, { op: "remove", path: "/c/3" }] as const;
    expect(inverseOf(before, [...cascade], [{ op: "remove", path: "/p/01" }])).toEqual([...back]);
  });
});

describe("fan-out onto a document whose root is the row", () => {
  // One table seen two ways: a map of rows in the wedding's document, the root of a household's own.
  const s = defineSchema({
    weddings: { columns: { name: "text" }, temporal: false },
    households: { parent: "weddings", columns: { email: "text" }, temporal: false },
  });
  const board = defineDoc("board:", { root: "weddings", include: ["households"] });
  const household = defineDoc("household:", { root: "households", include: [] });

  function setupBoth() {
    const db = new Database(":memory:");
    createTables(db, s);
    db.run("INSERT INTO weddings (id, name) VALUES ('w1', 'ours')");
    db.run("INSERT INTO households (id, weddings_id, email) VALUES ('h1', 'w1', 'a@x'), ('h2', 'w1', 'b@x')");
    const local = createLocal();
    const heard: { channel: string; data: any }[] = [];
    local.onPublish((channel, data) => heard.push({ channel, data }));
    registerDocs(local.server, db, s, [board, household]);
    return { local, heard };
  }

  test("a row written in the map arrives as the household's root, replaced whole", async () => {
    const { local, heard } = setupBoth();
    await local.call("open", { doc: "board:w1" });
    await local.call("open", { doc: "household:h1" });
    await local.call("delta", { doc: "board:w1", ops: [{ op: "replace", path: "/households/h1/email", value: "new@x" }, { op: "replace", path: "/households/h2/email", value: "other@x" }] });
    expect(heard.filter((h) => h.channel === "household:h1").map((h) => h.data.ops)).toEqual([[{ op: "replace", path: "/households", value: { id: "h1", weddings_id: "w1", email: "new@x" } }]]);
    expect((await local.call("open", { doc: "household:h1" })).result).toEqual({ households: { id: "h1", weddings_id: "w1", email: "new@x" } });
  });

  test("the row taken out of the map takes the household's root with it", async () => {
    const { local, heard } = setupBoth();
    await local.call("open", { doc: "board:w1" });
    await local.call("open", { doc: "household:h1" });
    await local.call("delta", { doc: "board:w1", ops: [{ op: "remove", path: "/households/h1" }] });
    expect(heard.filter((h) => h.channel === "household:h1").map((h) => h.data.ops)).toEqual([[{ op: "replace", path: "/households", value: null }]]);
  });
});

describe("fan-out of rows whose parent comes in the same write", () => {
  const s = defineSchema({
    weddings: { columns: { name: "text" }, temporal: false },
    courses: { parent: "weddings", columns: { name: "text" }, temporal: false },
    drinks: { parent: "courses", columns: { name: "text" }, temporal: false },
  });

  test("a course and its drinks, added in one write, reach the other document that holds them", async () => {
    const db = new Database(":memory:");
    createTables(db, s);
    db.run("INSERT INTO weddings (id, name) VALUES ('w1', 'ours')");
    const local = createLocal();
    const heard: { channel: string; data: any }[] = [];
    local.onPublish((channel, data) => heard.push({ channel, data }));
    registerDocs(local.server, db, s, [defineDoc("board:", { root: "weddings", include: ["courses", "drinks"] }), defineDoc("menu:", { root: "weddings", include: ["courses", "drinks"] })]);
    await local.call("open", { doc: "board:w1" });
    await local.call("open", { doc: "menu:w1" });
    await local.call("delta", { doc: "board:w1", ops: [{ op: "add", path: "/courses/c1", value: { name: "The toast" } }, { op: "add", path: "/drinks/d1", value: { courses_id: "c1", name: "Champagne" } }] });
    expect(heard.filter((h) => h.channel === "menu:w1").flatMap((h) => h.data.ops.map((o: any) => o.path))).toEqual(["/courses/c1", "/drinks/d1"]);
  });
});

