/**
 * "Ada adds a message; everyone sees it arrive under its own id" -- the same
 * op on every rung of the ladder (D3).
 *
 * `add /<coll>/-` on a collection of rows is a new row whose id the server
 * mints: a uuid on the JSON file and SQLite, the table's sequence on
 * Postgres. The broadcast names it (`/<coll>/<id>`) and the row carries it
 * (`value.id`), so a client applying the echo -- `applyOps`, keyed `list()`,
 * `applyOpsToCollection` -- lands on the same row as the server. Before, the
 * JSON file and SQLite stored the row under the key `"-"`.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import type { Pool } from "pg";
import { applyOps, splitPath } from "../src/core";
import { createWs, registerDoc } from "../src/server/server";
import { defineSchema, defineDoc, createTables, registerDocs } from "../src/server/sqlite";
import {
  applySql, generateSql, createDocListener, registerDocType, docTypeFromDef, clearRegistry,
} from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework, mockClient, sendAndAwait } from "./setup";
import { unlinkSync } from "node:fs";

setLogLevel("silent");

const schema = defineSchema({
  cr_rooms: { columns: { title: "text" }, temporal: false },
  cr_messages: { columns: { text: "text" }, parent: { collection: "cr_rooms", fk: "cr_rooms_id" }, temporal: false },
});
const roomDoc = defineDoc("cr-room:", { root: "cr_rooms", include: ["cr_messages"] });

/** Opens the room as a peer, sends two `/-` adds as Ada, and hands back what the peer saw. */
async function story(ws: ReturnType<typeof createWs>, name: string) {
  const published: any[] = [];
  ws.setServer({ publish: (_ch: string, raw: string) => published.push(JSON.parse(raw)) });
  const peer = mockClient({ clientId: "peer" });
  const ada = mockClient({ clientId: "ada" });
  const view = (await sendAndAwait(ws, peer, { action: "open", doc: name })).result;
  delete view._v;
  for (const text of ["hello", "again"]) {
    const r = await sendAndAwait(ws, ada, { action: "delta", doc: name, ops: [{ op: "add", path: "/cr_messages/-", value: { text } }] });
    expect(r.error).toBeUndefined();
  }
  return { view, published };
}

async function heard(published: any[], view: any, count: number) {
  for (let i = 0; i < 50 && published.length < count; i++) await Bun.sleep(20);
  for (const m of published) applyOps(view, m.ops);
  const rows = Object.entries(view.cr_messages as Record<string, any>);
  expect(rows.map(([, r]) => r.text).sort()).toEqual(["again", "hello"]);
  for (const [key, row] of rows) expect(String(row.id)).toBe(key);   // the row carries its id
  for (const m of published) {
    const [coll, id] = splitPath(m.ops[0].path);
    expect(coll).toBe("cr_messages");
    expect(id).not.toBe("-");                                          // the echo names the row
  }
}

describe("add /coll/- makes a row the server names, on every backend", () => {
  test("JSON file", async () => {
    const file = `/tmp/delta-create-row-${Date.now()}.json`;
    const ws = createWs();
    await registerDoc(ws, "cr-room:1", { file, empty: { cr_rooms: { id: "1", title: "" }, cr_messages: {} } as any });
    const { view, published } = await story(ws, "cr-room:1");
    await heard(published, view, 2);
    try { unlinkSync(file); } catch {}
  });

  test("JSON file: /- on an array still appends", async () => {
    const file = `/tmp/delta-create-row-arr-${Date.now()}.json`;
    const ws = createWs();
    const h = await registerDoc(ws, "list", { file, empty: { items: [] as string[] } });
    h.applyAndBroadcast([{ op: "add", path: "/items/-", value: "a" }]);
    expect(h.getDoc()).toEqual({ items: ["a"] });
    try { unlinkSync(file); } catch {}
  });

  test("SQLite", async () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    db.run("INSERT INTO cr_rooms (id, title) VALUES ('1', 'general')");
    const ws = createWs();
    registerDocs(ws, db, schema, [roomDoc]);
    const { view, published } = await story(ws, "cr-room:1");
    await heard(published, view, 2);
    expect(db.query("SELECT count(*) AS n FROM cr_messages WHERE id = '-'").get()).toEqual({ n: 0 });
  });

  test("SQLite: the path names the row, whatever the value's id says", async () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    db.run("INSERT INTO cr_rooms (id, title) VALUES ('1', 'general')");
    const ws = createWs();
    registerDocs(ws, db, schema, [roomDoc]);
    const ada = mockClient();
    await sendAndAwait(ws, ada, { action: "open", doc: "cr-room:1" });
    await sendAndAwait(ws, ada, { action: "delta", doc: "cr-room:1", ops: [{ op: "add", path: "/cr_messages/m1", value: { id: "other", text: "x" } }] });
    expect(db.query("SELECT id FROM cr_messages").all()).toEqual([{ id: "m1" }]);
  });

  describe("Postgres", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = await newPool();
      await applyFramework(pool);
      await pool.query("DROP TABLE IF EXISTS cr_messages, cr_rooms CASCADE; DROP SEQUENCE IF EXISTS seq_cr_messages, seq_cr_rooms;");
      await applySql(pool, generateSql(schema, [roomDoc]));
      await pool.query("INSERT INTO cr_rooms (id, title) VALUES (1, 'general')");
    });
    afterAll(async () => {
      await pool.query("DROP TABLE IF EXISTS cr_messages, cr_rooms CASCADE; DROP SEQUENCE IF EXISTS seq_cr_messages, seq_cr_rooms;");
      await pool.query("DELETE FROM _delta_docs WHERE prefix = 'cr-room:'");
      await pool.end();
    });

    test("Postgres", async () => {
      clearRegistry();
      registerDocType(docTypeFromDef(roomDoc, pool));
      const ws = createWs();
      const listener = await createDocListener(ws, pool);
      try {
        const { view, published } = await story(ws, "cr-room:1");
        await heard(published, view, 2);
        // the path names the row, whatever the value's id says
        await sendAndAwait(ws, mockClient(), { action: "delta", doc: "cr-room:1", ops: [{ op: "add", path: "/cr_messages/-", value: { id: 999, text: "forged id" } }] });
        expect((await pool.query("SELECT count(*) AS n FROM cr_messages WHERE id = 999")).rows[0].n).toBe("0");
      } finally {
        await listener.destroy();
      }
    });
  });
});
