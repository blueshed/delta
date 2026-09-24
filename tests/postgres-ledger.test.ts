/**
 * The Postgres ledger (src/sql/001g-delta-ledger.sql): every write with its
 * inverse, in the write's transaction, in the database every process shares.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { clearRegistry, createDocListener, defineDoc, docTypeFromDef, registerDocType } from "../src/server/postgres";
import { createWs } from "../src/server/server";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { applyFramework, applyItemsFixture, mockClient, newPool, resetState, sendAndAwait, waitFor } from "./setup";

setLogLevel("silent");

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await applyItemsFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  clearRegistry();
  await resetState(pool);
  registerDocType(docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool));
});

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.destroy();
});

/** A process: a WsServer with the listener on it. */
async function process(opts: Parameters<typeof createDocListener>[2] = { ledger: true }) {
  const ws = createWs();
  listeners.push(await createDocListener(ws, pool, opts));
  return ws;
}

const names = async () => (await pool.query("SELECT name FROM items ORDER BY name")).rows.map((r) => r.name);
const add = (name: string, cursor?: string) => ({ action: "delta", doc: "items:", ops: [{ op: "add", path: "/items/-", value: { name } }], cursor });

describe("the Postgres ledger", () => {
  test("a write is recorded with its inverse and version, and answers with them; over the socket the cursor is the connection", async () => {
    const ws = await process();
    const alice = mockClient({ clientId: "c-alice" });
    const answer = await sendAndAwait(ws, alice, add("alpha", "ignored"));
    expect(answer.result).toMatchObject({ ack: true, version: 1, entry: 1, ops: [{ op: "add" }], inverse: [{ op: "remove" }] });
    expect(answer.result.inverse[0].path).toBe(answer.result.ops[0].path);
    const { rows } = await pool.query("SELECT doc_name, version, cursor, who FROM _delta_ledger");
    expect(rows).toEqual([{ doc_name: "items:", version: "1", cursor: "c-alice", who: null }]);
  });

  test("undo walks back what its cursor wrote, nobody else's; redo walks it forward; a fresh write ends redo; a fact is passed over", async () => {
    const ws = await process();
    const eta = mockClient({ local: true }); // a caller in this process names its cursor
    await sendAndAwait(ws, eta, add("one", "s1"));
    await sendAndAwait(ws, eta, add("theirs", "s2"));
    await sendAndAwait(ws, eta, { ...add("fact", "s1"), undoable: false });
    await sendAndAwait(ws, eta, add("three", "s1"));

    expect((await sendAndAwait(ws, eta, { action: "undo", cursor: "s1" })).result).toMatchObject({ doc: "items:", ops: [{ op: "remove" }] });
    expect(await names()).toEqual(["fact", "one", "theirs"]);
    await sendAndAwait(ws, eta, { action: "undo", cursor: "s1" });
    expect(await names()).toEqual(["fact", "theirs"]); // passed over the fact
    expect((await sendAndAwait(ws, eta, { action: "undo", cursor: "s1" })).result).toBeNull();

    await sendAndAwait(ws, eta, { action: "redo", cursor: "s1" });
    expect(await names()).toEqual(["fact", "one", "theirs"]);
    await sendAndAwait(ws, eta, add("fresh", "s1"));
    expect((await sendAndAwait(ws, eta, { action: "redo", cursor: "s1" })).result).toBeNull();
  });

  test("a removed row comes back, under its own id, and goes again on redo", async () => {
    const ws = await process();
    const eta = mockClient({ local: true });
    const added = await sendAndAwait(ws, eta, add("keep me", "s1"));
    const path = added.result.ops[0].path;
    await sendAndAwait(ws, eta, { action: "delta", doc: "items:", ops: [{ op: "remove", path }], cursor: "s1" });
    expect(await names()).toEqual([]);
    const undone = await sendAndAwait(ws, eta, { action: "undo", cursor: "s1" });
    expect(undone.error).toBeUndefined();
    expect(undone.result.ops[0].path).toBe(path);
    expect(await names()).toEqual(["keep me"]);
    await sendAndAwait(ws, eta, { action: "redo", cursor: "s1" });
    expect(await names()).toEqual([]);
  });

  test("concurrent writes to one document: each entry's inverse takes back exactly what the entry before it wrote", async () => {
    const ws = await process();
    const eta = mockClient({ local: true });
    const path = (await sendAndAwait(ws, eta, add("contested", "s0"))).result.ops[0].path;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => sendAndAwait(ws, mockClient({ local: true }), { action: "delta", doc: "items:", ops: [{ op: "replace", path: `${path}/value`, value: i + 1 }], cursor: `w${i}` })),
    );
    const { rows } = await pool.query("SELECT ops, inverse FROM _delta_ledger WHERE version > 1 ORDER BY version");
    expect(rows).toHaveLength(20);
    let before = 0;
    for (const { ops, inverse } of rows) {
      expect(inverse[0].value.value).toBe(before); // what was there when this write landed
      before = ops[0].value.value;
    }
  });

  test("a socket client cannot walk another's cursor by naming it", async () => {
    const ws = await process();
    const alice = mockClient({ clientId: "c-alice" });
    const mallory = mockClient({ clientId: "c-mallory" });
    await sendAndAwait(ws, alice, add("alice's"));
    expect((await sendAndAwait(ws, mallory, { action: "undo", cursor: "c-alice" })).result).toBeNull();
    expect(await names()).toEqual(["alice's"]);
    await sendAndAwait(ws, alice, { action: "undo" });
    expect(await names()).toEqual([]);
  });

  test("signed in, the cursor is the person and the connection: another person holding the same connection id cannot walk it", async () => {
    const auth = { gate: (client: any) => client.data.identity ?? { error: "no one" } };
    const ws = await process({ ledger: true, auth });
    // a client chooses its connection id (?clientId=, to keep its cursor across a reconnect): one leaked or guessed
    const alice = mockClient({ clientId: "c-1", identity: "alice" });
    const mallory = mockClient({ clientId: "c-1", identity: "mallory" });
    await sendAndAwait(ws, alice, add("alice's"));
    expect((await sendAndAwait(ws, mallory, { action: "undo" })).result).toBeNull();
    expect(await names()).toEqual(["alice's"]);
    await sendAndAwait(ws, alice, { action: "undo" });
    expect(await names()).toEqual([]);
  });

  test("undo works across processes: a write in one, taken back from another, and both hear it", async () => {
    const a = await process();
    const b = await process();
    const heardOnA: any[] = [];
    a.publish = (_channel: string, data: any) => void heardOnA.push(data); // what process a broadcasts to its sockets
    const watcher = mockClient({ clientId: "watcher" });
    await sendAndAwait(a, watcher, { action: "open", doc: "items:" });
    const inA = mockClient({ local: true });
    const inB = mockClient({ local: true });
    await sendAndAwait(a, inA, add("from a", "session-1"));
    expect(await names()).toEqual(["from a"]);
    const undone = await sendAndAwait(b, inB, { action: "undo", cursor: "session-1" });
    expect(undone.result).toMatchObject({ doc: "items:", ops: [{ op: "remove" }] });
    expect(await names()).toEqual([]);
    // process a broadcasts the undo that process b made, heard over NOTIFY, to the watcher's document
    await waitFor(() => heardOnA.some((m) => m.doc === "items:" && m.ops?.some((o: any) => o.op === "remove")), { timeout: 3000 });
  });

  test("who: the identity as the gate gives it", async () => {
    const auth = { gate: (client: any) => client.data.identity ?? { error: "no one" } };
    const ws = await process({ ledger: true, auth });
    await sendAndAwait(ws, mockClient({ local: true, identity: { id: 7 } }), add("seven", "s1"));
    await sendAndAwait(ws, mockClient({ local: true, identity: "ada" }), add("ada's", "s2"));
    const named = await process({ ledger: true, auth, who: (identity: any) => `user-${identity.id}` });
    await sendAndAwait(named, mockClient({ local: true, identity: { id: 8 } }), add("eight", "s3"));
    const { rows } = await pool.query("SELECT who FROM _delta_ledger ORDER BY id");
    expect(rows.map((r) => r.who)).toEqual(['{"id":7}', "ada", "user-8"]);
    expect((await sendAndAwait(ws, mockClient({}), { action: "undo" })).error?.code).toBe(401);
  });

  test("who, without an auth module: the identity the caller carries (createLocal().as), as the SQLite backend reads it; in-process the cursor is still named", async () => {
    const local = createLocal();
    listeners.push(await createDocListener(local.server, pool, { ledger: true }));
    const ada = local.as("ada");
    const write = (caller: { call: typeof local.call }, name: string, cursor: string) =>
      caller.call("delta", { doc: "items:", ops: [{ op: "add", path: "/items/-", value: { name } }], cursor });
    await write(ada, "ada's", "s1");
    await write(local.as({ id: 7 }), "seven's", "s2");
    await write(local, "no one's", "s3");
    const { rows } = await pool.query("SELECT who, cursor FROM _delta_ledger ORDER BY id");
    expect(rows).toEqual([{ who: "ada", cursor: "s1" }, { who: '{"id":7}', cursor: "s2" }, { who: null, cursor: "s3" }]);
    const undone = await ada.call("undo", { cursor: "s1" });
    expect(undone.result).toMatchObject({ doc: "items:", ops: [{ op: "remove" }] });
    expect(await names()).toEqual(["no one's", "seven's"]);
    expect((await pool.query("SELECT who, cursor FROM _delta_ledger ORDER BY id DESC LIMIT 1")).rows[0]).toEqual({ who: "ada", cursor: "s1" });
  });

  test("history, to whoever may open the document: mine or not, never who, never a cursor", async () => {
    const ws = await process();
    const eta = mockClient({ local: true });
    await sendAndAwait(ws, eta, add("one", "s1"));
    await sendAndAwait(ws, mockClient({ local: true, identity: "bob" }), add("two", "s2"));
    const entries = (await sendAndAwait(ws, eta, { action: "history", doc: "items:", cursor: "s1" })).result;
    expect(entries.map((e: any) => [e.version, e.mine])).toEqual([[2, false], [1, true]]);
    expect(JSON.stringify(entries)).not.toContain("s2");
    expect(JSON.stringify(entries)).not.toContain("bob");
  });

  test("without the ledger, a write is not recorded and there is no undo", async () => {
    const ws = await process({});
    const eta = mockClient({ local: true });
    expect((await sendAndAwait(ws, eta, add("one", "s1"))).result).toEqual({ ack: true, version: 1 });
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM _delta_ledger")).rows[0].n).toBe(0);
    expect((await sendAndAwait(ws, eta, { action: "undo", cursor: "s1" })).error?.message).toContain("Unknown action");
  });
});
