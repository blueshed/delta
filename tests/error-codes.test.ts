/**
 * One error-code table on every backend (D11): the same mistake is answered
 * with the same `DeltaError.code`, so a client can switch on it.
 *
 *   400  the op is malformed: a bad path, an unknown field, a missing required one
 *   404  what it names is not there: the row, the path
 *   409  an add of a row that is already there
 *
 * Before, the JSON file answered -1 for everything, SQLite 500 for a missing
 * row, and Postgres 500 for most things.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import type { Pool } from "pg";
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
  ec_rooms: { columns: { title: "text" }, temporal: false },
  ec_messages: { columns: { text: "text" }, parent: { collection: "ec_rooms", fk: "ec_rooms_id" }, temporal: false },
});
const roomDoc = defineDoc("ec-room:", { root: "ec_rooms", include: ["ec_messages"] });

type Ws = ReturnType<typeof createWs>;
const codeOf = async (ws: Ws, ops: any[]) => {
  const c = mockClient();
  await sendAndAwait(ws, c, { action: "open", doc: "ec-room:1" });
  return (await sendAndAwait(ws, c, { action: "delta", doc: "ec-room:1", ops })).error?.code;
};

/** The mistakes, with the row id each backend has seeded as "there". */
function mistakes(there: string) {
  return {
    "a path without a leading slash": { ops: [{ op: "remove", path: "ec_messages" }], code: 400 },
    "a row that is not there": { ops: [{ op: "replace", path: "/ec_messages/404/text", value: "x" }], code: 404 },
    "an unknown field": { ops: [{ op: "replace", path: `/ec_messages/${there}/nope`, value: "x" }], code: 400 },
    "a field named after Object.prototype": { ops: [{ op: "replace", path: `/ec_messages/${there}/toString`, value: "x" }], code: 400 },
    "an add of a row that is already there": { ops: [{ op: "add", path: `/ec_messages/${there}`, value: { text: "again" } }], code: 409 },
    "an add that leaves out a required field": { ops: [{ op: "add", path: "/ec_messages/-", value: {} }], code: 400 },
  } as Record<string, { ops: any[]; code: number }>;
}

describe("the same mistake, the same code", () => {
  test("JSON file: a malformed path is 400, a missing row 404", async () => {
    const file = `/tmp/delta-error-codes-${Date.now()}.json`;
    const ws = createWs();
    await registerDoc(ws, "ec-room:1", { file, empty: { ec_rooms: { id: "1", title: "" }, ec_messages: { m1: { id: "m1", text: "hi" } } } as any });
    const m = mistakes("m1");
    for (const name of ["a path without a leading slash", "a row that is not there"]) {
      expect([name, await codeOf(ws, m[name]!.ops)]).toEqual([name, m[name]!.code]);
    }
    try { unlinkSync(file); } catch {}
  });

  test("SQLite", async () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    db.run("INSERT INTO ec_rooms (id, title) VALUES ('1', 'general')");
    db.run("INSERT INTO ec_messages (id, ec_rooms_id, text) VALUES ('m1', '1', 'hi')");
    const ws = createWs();
    registerDocs(ws, db, schema, [roomDoc]);
    for (const [name, { ops, code }] of Object.entries(mistakes("m1"))) {
      expect([name, await codeOf(ws, ops)]).toEqual([name, code]);
    }
  });

  describe("Postgres", () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = await newPool();
      await applyFramework(pool);
      await pool.query("DROP TABLE IF EXISTS ec_messages, ec_rooms CASCADE; DROP SEQUENCE IF EXISTS seq_ec_messages, seq_ec_rooms;");
      await applySql(pool, generateSql(schema, [roomDoc]));
      await pool.query("INSERT INTO ec_rooms (id, title) VALUES (1, 'general'); INSERT INTO ec_messages (id, ec_rooms_id, text) VALUES (7, 1, 'hi');");
    });
    afterAll(async () => {
      await pool.query("DROP TABLE IF EXISTS ec_messages, ec_rooms CASCADE; DROP SEQUENCE IF EXISTS seq_ec_messages, seq_ec_rooms;");
      await pool.query("DELETE FROM _delta_docs WHERE prefix = 'ec-room:'");
      await pool.end();
    });

    test("Postgres", async () => {
      clearRegistry();
      registerDocType(docTypeFromDef(roomDoc, pool));
      const ws = createWs();
      ws.setServer({ publish() {} });
      const listener = await createDocListener(ws, pool);
      try {
        for (const [name, { ops, code }] of Object.entries(mistakes("7"))) {
          expect([name, await codeOf(ws, ops)]).toEqual([name, code]);
        }
      } finally {
        await listener.destroy();
      }
    });
  });
});
