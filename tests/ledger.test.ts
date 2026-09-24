import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLocal } from "../src/server/local";
import type { ActionHandler, WsServer } from "../src/server/server";
import { createTables, defineDoc, defineSchema, registerDocs } from "../src/server/sqlite";

const schema = defineSchema({
  rooms: { columns: {}, temporal: false },
  messages: { parent: "rooms", columns: { text: "text" }, temporal: false },
  boards: { columns: { title: "text?" } }, // temporal, by default
  cards: { parent: "boards", columns: { title: "text" } },
});
const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });
const board = defineDoc("board:", { root: "boards", include: ["cards"], implied: true });

function setup(options: Parameters<typeof registerDocs>[5] = { ledger: true }) {
  const db = new Database(":memory:");
  createTables(db, schema);
  const local = createLocal();
  const heard: any[] = [];
  local.onPublish((_channel, data) => heard.push(data));
  registerDocs(local.server, db, schema, [room, board], [], options);
  const say = async (caller: { call: typeof local.call }, cursor: string, id: string, text: string, doc = "room:a") => {
    await caller.call("open", { doc });
    return await caller.call("delta", { doc, ops: [{ op: "add", path: `/messages/${id}`, value: { text } }], cursor });
  };
  const texts = async (doc = "room:a") => Object.values((await local.call("open", { doc })).result.messages).map((m: any) => m.text).sort();
  return { db, local, heard, say, texts };
}

describe("the ledger", () => {
  test("every write is recorded with its inverse and the document's version, and the answer and the broadcast say the version", async () => {
    const { db, local, heard, say } = setup();
    const first = await say(local, "s1", "m1", "hi");
    expect(first.result).toEqual({ ack: true, ops: [{ op: "add", path: "/messages/m1", value: { id: "m1", rooms_id: "a", text: "hi" } }], inverse: [{ op: "remove", path: "/messages/m1" }], version: 1, entry: 1 });
    expect((await say(local, "s1", "m2", "there")).result.version).toBe(2);
    expect((await say(local, "s1", "m3", "elsewhere", "room:b")).result.version).toBe(1); // versions are per document
    expect(heard.at(-1)).toMatchObject({ doc: "room:b", v: 1 });
    expect(db.query("SELECT doc, version, cursor FROM delta_ledger ORDER BY id").all()).toEqual([
      { doc: "room:a", version: 1, cursor: "s1" },
      { doc: "room:a", version: 2, cursor: "s1" },
      { doc: "room:b", version: 1, cursor: "s1" },
    ]);
  });

  test("who: the identity a caller is, written as the auth module has it", async () => {
    const { db, local, say } = setup();
    await say(local.as({ id: 7 }), "s1", "m1", "a");
    await say(local.as("ada"), "s2", "m2", "b");
    await say(local, "s3", "m3", "c");
    expect(db.query("SELECT who FROM delta_ledger ORDER BY id").all()).toEqual([{ who: '{"id":7}' }, { who: "ada" }, { who: null }]);
    const named = setup({ ledger: true, who: (identity) => `user-${(identity as { id: number }).id}` });
    await named.say(named.local.as({ id: 7 }), "s1", "m1", "a");
    expect(named.db.query("SELECT who FROM delta_ledger").get()).toEqual({ who: "user-7" });
    expect(local.as({ id: 7 })).toBe(local.as({ id: 7 })); // one client per identity
  });

  test("undo walks back what its cursor wrote, newest first, and nobody else's; redo walks it forward; a fresh write ends redo", async () => {
    const { local, say, texts } = setup();
    await say(local, "s1", "m1", "one");
    await say(local, "s2", "m2", "theirs");
    await say(local, "s1", "m3", "three");

    expect((await local.call("undo", { cursor: "s1" })).result).toMatchObject({ doc: "room:a", ops: [{ op: "remove", path: "/messages/m3" }], version: 4 });
    expect(await texts()).toEqual(["one", "theirs"]);
    await local.call("undo", { cursor: "s1" });
    expect(await texts()).toEqual(["theirs"]);
    expect((await local.call("undo", { cursor: "s1" })).result).toBeNull(); // nothing left of s1's

    await local.call("redo", { cursor: "s1" });
    expect(await texts()).toEqual(["one", "theirs"]);
    await say(local, "s1", "m4", "fresh");
    expect((await local.call("redo", { cursor: "s1" })).result).toBeNull(); // the fresh write ended what could be redone
    expect((await local.call("undo", {})).result).toBeNull(); // no cursor, nothing to walk
  });

  test("a fact is recorded and never undone: undo passes over it, and it ends no redo", async () => {
    const { local, say, texts } = setup();
    await say(local, "s1", "m1", "mine");
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/f1", value: { text: "fact" } }], cursor: "s1", undoable: false });
    await local.call("undo", { cursor: "s1" });
    expect(await texts()).toEqual(["fact"]);
    await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/f2", value: { text: "fact 2" } }], cursor: "s1", undoable: false });
    await local.call("redo", { cursor: "s1" });
    expect(await texts()).toEqual(["fact", "fact 2", "mine"]);
  });

  test("undo reaches a document nobody has open, and leaves it closed", async () => {
    const { local, say, texts } = setup();
    await say(local, "s1", "m1", "one");
    await local.call("close", { doc: "room:a" });
    await local.call("undo", { cursor: "s1" });
    expect(await texts()).toEqual([]);
  });

  test("a temporal row comes back through undo: its storage columns are not written back", async () => {
    const { local } = setup();
    await local.call("open", { doc: "board:x" });
    await local.call("delta", { doc: "board:x", ops: [{ op: "add", path: "/cards/c1", value: { title: "card" } }], cursor: "s1" });
    await local.call("delta", { doc: "board:x", ops: [{ op: "remove", path: "/cards/c1" }], cursor: "s1" });
    const undone = await local.call("undo", { cursor: "s1" });
    expect(undone.error).toBeUndefined();
    expect(Object.values((await local.call("open", { doc: "board:x" })).result.cards).map((c: any) => c.title)).toEqual(["card"]);
  });

  test("history says, per entry, whether the asker wrote it -- never who did, never a cursor", async () => {
    const { local, say } = setup();
    await say(local, "s1", "m1", "one");
    await say(local.as("bob"), "s2", "m2", "two");
    const entries = (await local.call("history", { doc: "room:a", cursor: "s1" })).result;
    expect(entries.map((e: any) => [e.version, e.mine])).toEqual([[2, false], [1, true]]);
    expect(JSON.stringify(entries)).not.toContain("bob");
    expect(JSON.stringify(entries)).not.toContain("s2");
    expect((await local.call("history", { doc: "elsewhere:1" })).error).toBeDefined(); // not a document this backend has
  });

  test("without the ledger, nothing is recorded and the actions are not there", async () => {
    const { db, local, say } = setup({});
    expect((await say(local, "s1", "m1", "one")).result).toEqual({ ack: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'delta_ledger'").get()).toBeNull();
    expect((await local.call("undo", { cursor: "s1" })).error?.message).toContain("No handler matched");
  });
});

describe("the cursor, over a socket", () => {
  test("is the connection itself: a socket client cannot name another's", async () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    const handlers = new Map<string, ActionHandler[]>();
    const server = { on: (a: string, h: ActionHandler) => handlers.set(a, [...(handlers.get(a) ?? []), h]), publish() {} } as unknown as WsServer;
    registerDocs(server, db, schema, [room], [], { ledger: true });
    const send = (client: any, action: string, msg: any) => {
      let answer: any;
      for (const h of handlers.get(action) ?? []) h({ action, ...msg }, client, (r) => (answer ??= r));
      return answer;
    };
    const mallory = { data: { clientId: "c-mallory" }, subscribe() {}, unsubscribe() {} };
    const alice = { data: { clientId: "c-alice" }, subscribe() {}, unsubscribe() {} };
    send(alice, "open", { doc: "room:a" });
    send(alice, "delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "alice" } }], cursor: "ignored" });
    expect(db.query("SELECT cursor FROM delta_ledger").get()).toEqual({ cursor: "c-alice" });
    expect(send(mallory, "undo", { cursor: "c-alice" }).result).toBeNull(); // named, and not honoured
    expect(send(alice, "undo", {}).result).toMatchObject({ ops: [{ op: "remove", path: "/messages/m1" }] });
  });
});
