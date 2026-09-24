import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLocal } from "../src/server/local";
import { createTables, defineDoc, defineSchema, inverseOf, registerDocs } from "../src/server/sqlite";

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
  test("opens, writes and hears the broadcast, with no socket", () => {
    const { local, heard } = setup();
    expect(local.call("open", { doc: "room:a" }).result).toEqual({ rooms: { id: "a", topic: null }, messages: {} });
    expect(local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] }).result).toEqual({ ack: true });
    expect(heard).toEqual([{ channel: "room:a", data: { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { id: "m1", rooms_id: "a", text: "hi" } }] } }]);
  });

  test("an unknown action answers with an error", () => {
    expect(setup().local.call("nope", {}).error?.message).toContain("No handler matched");
  });

  test("an asynchronous handler throws rather than answering nothing", () => {
    const local = createLocal();
    local.server.on("slow", async (_m, _c, respond) => { await Bun.sleep(0); respond({ result: 1 }); });
    expect(() => local.call("slow", {})).toThrow("asynchronous");
  });

  test("unsubscribing from publish stops the hearing", () => {
    const local = createLocal();
    const heard: string[] = [];
    const off = local.onPublish((channel) => heard.push(channel));
    local.server.publish("x", {});
    off();
    local.server.publish("y", {});
    expect(heard).toEqual(["x"]);
  });
});

describe("implied docs", () => {
  test("open empty without making a row; the first write makes it", () => {
    const { db, local } = setup();
    local.call("open", { doc: "room:attic" });
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 0 });
    local.call("delta", { doc: "room:attic", ops: [{ op: "add", path: "/messages/m1", value: { text: "up here" } }] });
    expect(db.query("SELECT id FROM rooms").all()).toEqual([{ id: "attic" }]);
    expect(db.query("SELECT rooms_id FROM messages").all()).toEqual([{ rooms_id: "attic" }]);
  });

  test("a failed first write makes no row", () => {
    const { db, local } = setup();
    local.call("open", { doc: "room:attic" });
    const answer = local.call("delta", { doc: "room:attic", ops: [{ op: "replace", path: "/messages/ghost/text", value: "x" }] });
    expect(answer.error).toBeDefined();
    expect(db.query("SELECT COUNT(*) AS n FROM rooms").get()).toEqual({ n: 0 });
  });

  test("an implied doc cannot also declare a scope", () => {
    expect(() => defineDoc("x:", { root: "rooms", include: [], scope: { id: ":docId" }, implied: true })).toThrow("implied");
  });

  test("a doc that is not implied still 404s", () => {
    const local = createLocal();
    const db = new Database(":memory:");
    createTables(db, schema);
    registerDocs(local.server, db, schema, [defineDoc("plain:", { root: "rooms", include: ["messages"] })]);
    expect(local.call("open", { doc: "plain:nowhere" }).error?.code).toBe(404);
  });
});

describe("savepoints", () => {
  test("a write inside the caller's transaction rolls back with it", () => {
    const { db, local, evict } = setup();
    db.exec("BEGIN");
    local.call("open", { doc: "room:a" });
    local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 1 });
    db.exec("ROLLBACK");
    evict("room:a");
    expect(db.query("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });
    expect(local.call("open", { doc: "room:a" }).result.messages).toEqual({});
  });

  test("a failed write inside the caller's transaction leaves the caller's own work alone", () => {
    const { db, local } = setup();
    local.call("open", { doc: "room:a" });
    local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
    db.exec("BEGIN");
    db.run("UPDATE messages SET text = 'mine' WHERE id = 'm1'");
    const answer = local.call("delta", { doc: "room:a", ops: [{ op: "replace", path: "/messages/ghost/text", value: "x" }] });
    expect(answer.error).toBeDefined();
    expect(db.query("SELECT text FROM messages").get()).toEqual({ text: "mine" });
    db.exec("COMMIT");
  });
});

describe("inverse", () => {
  test("asked for, the answer carries what was applied and its inverse", () => {
    const { local } = setup();
    local.call("open", { doc: "room:a" });
    const answer = local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }], inverse: true });
    expect(answer.result.ops).toEqual([{ op: "add", path: "/messages/m1", value: { id: "m1", rooms_id: "a", text: "hi" } }]);
    expect(answer.result.inverse).toEqual([{ op: "remove", path: "/messages/m1" }]);
  });

  test("applying the inverse restores the document, and its own inverse is the write again", () => {
    const { local } = setup();
    const open = () => local.call("open", { doc: "room:a" }).result;
    open();
    local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }, { op: "replace", path: "/rooms/topic", value: "tea" }] });
    const before = structuredClone(open());
    const write = local.call("delta", { doc: "room:a", ops: [{ op: "remove", path: "/messages/m1" }, { op: "replace", path: "/rooms/topic", value: "coffee" }], inverse: true });
    const after = structuredClone(open());
    const undo = local.call("delta", { doc: "room:a", ops: write.result.inverse, inverse: true });
    expect(open()).toEqual(before);
    local.call("delta", { doc: "room:a", ops: undo.result.inverse });
    expect(open()).toEqual(after);
  });

  test("a run of removes comes back parent first; other ops in reverse", () => {
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
});
