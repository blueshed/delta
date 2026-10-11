/**
 * An add names a new row (D6), on Postgres. A temporal table's key is
 * (id, valid_from), so `add /coll/<live id>` used to insert a second live
 * version of the row; a plain table failed its key as a 500. Both are a 409
 * that names the fix now. A removed row comes back under its id in the write
 * that removed it, or by an undo; after, its id is spent, as any the serial
 * has handed out (#71).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Pool } from "pg";
import {
  applySql, generateSql, defineSchema, defineDoc,
  createDocListener, docTypeFromDef,
} from "../src/server/postgres";
import { createWs } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework } from "./setup";
import { mockClient, sendAndAwait } from "../src/testing";

setLogLevel("silent");

const schema = defineSchema({
  add_notes: { columns: { body: "text" } },                      // temporal by default
  add_tags: { columns: { label: "text" }, temporal: false },
});
const doc = defineDoc("add-board:", { root: "add_notes", include: [] });
const tags = defineDoc("add-tags:", { root: "add_tags", include: [] });

let pool: Pool;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query("DROP TABLE IF EXISTS add_notes, add_tags CASCADE; DROP SEQUENCE IF EXISTS seq_add_notes, seq_add_tags;");
  await applySql(pool, generateSql(schema, [doc, tags]));
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS add_notes, add_tags CASCADE; DROP SEQUENCE IF EXISTS seq_add_notes, seq_add_tags;");
  await pool.query("DELETE FROM _delta_docs WHERE prefix IN ('add-board:', 'add-tags:')");
  await pool.end();
});

let ws: ReturnType<typeof createWs>;
let listener: Awaited<ReturnType<typeof createDocListener>>;

beforeEach(async () => {
  // delta's serials are not owned by their tables (TRUNCATE leaves them): each test names ids anew (#71)
  await pool.query("TRUNCATE add_notes, add_tags; ALTER SEQUENCE seq_add_notes RESTART; ALTER SEQUENCE seq_add_tags RESTART; TRUNCATE _delta_versions;");
  ws = createWs();
  ws.setServer({ publish() {} });
  listener = await createDocListener(ws, pool, { types: [docTypeFromDef(doc, pool), docTypeFromDef(tags, pool)] });
});

afterEach(async () => {
  await listener.destroy();
});

const delta = (name: string, ops: any[]) => sendAndAwait(ws, mockClient(), { action: "delta", doc: name, ops });

describe("an add of a row that is already there (Postgres)", () => {
  test("temporal: a 409 that names the fix, and one live row", async () => {
    const made = await delta("add-board:", [{ op: "add", path: "/add_notes/-", value: { body: "first" } }]);
    const id = made.result ? (await pool.query("SELECT id FROM current_add_notes")).rows[0].id : null;
    const again = await delta("add-board:", [{ op: "add", path: `/add_notes/${id}`, value: { body: "again" } }]);
    expect(again.error).toEqual({ code: 409, message: `id already taken: /add_notes/${id} -- add to /add_notes/- for a new id` });
    expect((await pool.query("SELECT body FROM add_notes WHERE id = $1 AND valid_to IS NULL", [id])).rows).toEqual([{ body: "first" }]);
  });

  test("temporal: a removed row comes back under its own id in the write that removed it; after, its id is spent (#71)", async () => {
    await delta("add-board:", [{ op: "add", path: "/add_notes/-", value: { body: "first" } }]);
    const id = (await pool.query("SELECT id FROM current_add_notes")).rows[0].id;
    expect((await delta("add-board:", [
      { op: "remove", path: `/add_notes/${id}` },
      { op: "add", path: `/add_notes/${id}`, value: { body: "back" } },
    ])).error).toBeUndefined();
    expect((await pool.query("SELECT body FROM current_add_notes")).rows).toEqual([{ body: "back" }]);
    expect((await delta("add-board:", [{ op: "remove", path: `/add_notes/${id}` }])).error).toBeUndefined();
    expect((await delta("add-board:", [{ op: "add", path: `/add_notes/${id}`, value: { body: "later" } }])).error?.code).toBe(409);
    expect((await pool.query("SELECT body FROM current_add_notes")).rows).toEqual([]);
  });

  test("an add that leaves out a required field is a 400, not a row with \"\" in it (A11)", async () => {
    const r = await delta("add-tags:", [{ op: "add", path: "/add_tags/-", value: {} }]);
    expect(r.error).toEqual({ code: 400, message: "Required field missing: label (give it a value, or declare a default or make it nullable in the schema)" });
    expect((await pool.query("SELECT count(*) AS n FROM add_tags")).rows[0].n).toBe("0");
  });

  test("plain table: a 409, not a 500", async () => {
    await delta("add-tags:", [{ op: "add", path: "/add_tags/-", value: { label: "a" } }]);
    const id = (await pool.query("SELECT id FROM add_tags")).rows[0].id;
    const again = await delta("add-tags:", [{ op: "add", path: `/add_tags/${id}`, value: { label: "b" } }]);
    expect(again.error.code).toBe(409);
  });
});
