/**
 * The path's last place: a Postgres server. The shared cases
 * (tests/helpers/path.ts); what only a database shared by processes has --
 * another process on it, a told document's catch-up from the log; what the
 * writer's own channel carries; and the whole path: the same data carried
 * from a JSON file to SQLite to Postgres in process to this server, reading
 * the same at every step, the next serial following on.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Pool } from "pg";
import {
  applySql, clearRegistry, createDocListener, docTypeFromDef, exportTables, generateSql, importTables, registerDocType,
} from "../src/server/postgres";
import * as sqlite from "../src/server/sqlite";
import * as json from "../src/server/json";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { applyFramework, newPool } from "./setup";
import {
  assertCopiesHold, course, expectTold, openAll, pathCases, pathDocs, pathSchema, pathSeed, readAll, told, write,
  type PathBackend, type PathProcess,
} from "./helpers/path";

setLogLevel("silent");

const tables = Object.values(pathSchema.tables).map((t) => t.name);
let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];
let backend: PathBackend;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await applySql(pool, generateSql(pathSchema, pathDocs));
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await pool.query("DELETE FROM _delta_docs WHERE prefix = ANY($1)", [pathDocs.map((d) => d.prefix)]);
  await pool.query("DELETE FROM _delta_collections WHERE collection_key = ANY($1)", [Object.keys(pathSchema.tables)]);
  await pool.end();
});

/** A process on the database: delta in-process over its own listener, and everything it published. */
async function processOn(): Promise<PathProcess> {
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  listeners.push(await createDocListener(local.server, pool, { ledger: true }));
  return { call: (action, msg) => local.call(action, msg), heard };
}

beforeEach(async () => {
  clearRegistry();
  await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
  await importTables(pool, pathSchema, pathSeed);
  for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool));
  backend = {
    process: await processOn(),
    // LISTEN/NOTIFY over the wire: the write answers at its commit; what it notified is fetched and published after.
    quiet: () => new Promise((r) => setTimeout(r, 300)),
    exportTables: () => exportTables(pool, pathSchema),
  };
});

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.destroy();
});

describe("postgres", () => pathCases(() => backend));

describe("postgres: what only a database shared by processes has", () => {
  test("a write through one process reaches another document open in another process", async () => {
    const other = await processOn();
    const there: PathBackend = { ...backend, process: other };
    const copies = await openAll(backend.process, ["fo-board:1"]);
    const theirs = await openAll(other, ["fo-menu:1", "fo-household:1"]);
    await write(backend.process, "fo-board:1", [
      { op: "replace", path: "/courses/1/name", value: "Broth" },
      { op: "replace", path: "/households/1/email", value: "new@x" },
    ]);
    await expectTold(there, "fo-menu:1", [[{ op: "replace", path: "/courses/1", value: course(1, "Broth") }]]);
    await expectTold(there, "fo-household:1", [[{ op: "replace", path: "/households", value: { id: 1, weddings_id: 1, email: "new@x" } }]]);
    await assertCopiesHold(backend, copies);
    await assertCopiesHold(there, theirs);
  });

  test("a reader behind can catch up on a told document from the log", async () => {
    const before = (await backend.process.call("open", { doc: "fo-menu:1" })).result._v as number;
    await openAll(backend.process, ["fo-board:1", "fo-menu:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await expectTold(backend, "fo-menu:1", [[{ op: "replace", path: "/courses/1", value: course(1, "Broth") }]]);
    const { rows } = await pool.query("SELECT version, ops FROM delta_fetch_ops($1, $2)", ["fo-menu:1", before]);
    expect(rows.map((r: any) => ({ v: Number(r.version), ops: r.ops }))).toEqual([{ v: before + 1, ops: told(backend.process, "fo-menu:1")[0] }]);
  });

  test("a document opened in no process is not told, and costs no version", async () => {
    await openAll(backend.process, ["fo-board:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await backend.quiet();
    const { rows } = await pool.query("SELECT doc_name FROM _delta_versions WHERE doc_name LIKE 'fo-%' ORDER BY doc_name");
    expect(rows.map((r: any) => r.doc_name)).toEqual(["fo-board:1"]);
  });
});

describe("postgres: the writer's own channel", () => {
  test("a row taken out through the board no longer opens as a household", async () => {
    await openAll(backend.process, ["fo-board:1"]);
    await write(backend.process, "fo-board:1", [{ op: "remove", path: "/households/1" }]);
    expect((await backend.process.call("open", { doc: "fo-household:1" })).error?.code).toBe(404);
  });

  test("an undo puts a dropped course back with its drink, and they join in the tables", async () => {
    await openAll(backend.process, ["fo-board:1"]);
    await write(backend.process, "fo-board:1", [
      { op: "add", path: "/courses/10", value: { name: "Fish" } },
      { op: "add", path: "/drinks/10", value: { courses_id: 10, name: "Chablis" } },
    ], { cursor: "s1" });
    await write(backend.process, "fo-board:1", [{ op: "remove", path: "/courses/10" }], { cursor: "s1" });
    expect((await backend.process.call("undo", { cursor: "s1" })).error).toBeUndefined();
    const { rows } = await pool.query("SELECT d.name FROM fo_drinks d JOIN fo_courses c ON c.id = d.courses_id WHERE c.id = 10");
    expect(rows).toEqual([{ name: "Chablis" }]);
  });
});

describe("the whole path: one app's data, carried from a JSON file to a Postgres server", () => {
  test("at every step the documents read the same, and the next row named follows the last", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delta-path-"));
    const lite = await openPglite();
    try {
      const add = async (p: PathProcess, name: string) => {
        await p.call("open", { doc: "fo-board:1" });
        return (await write(p, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name } }])).ops[0].path;
      };
      const localOf = () => {
        const local = createLocal();
        const heard: { channel: string; data: any }[] = [];
        local.onPublish((channel, data) => heard.push({ channel, data }));
        return { local, process: { call: (a: string, m: Record<string, unknown>) => local.call(a, m), heard } as PathProcess };
      };

      // 1. a JSON file
      const file = join(dir, "data.json");
      json.importTables(file, pathSchema, pathSeed);
      const onJson = localOf();
      const store = json.registerDocs(onJson.local.server, file, pathSchema, pathDocs, [], { ledger: true });
      expect(await add(onJson.process, "Fish")).toBe("/courses/3");
      await write(onJson.process, "fo-board:1", [{ op: "replace", path: "/notes/1/text", value: "bring tables" }]);
      await store.persisted();
      const read = await readAll(onJson.process);

      // 2. SQLite
      const db = new Database(":memory:");
      sqlite.createTables(db, pathSchema);
      sqlite.importTables(db, pathSchema, json.exportTables(file, pathSchema));
      const onSqlite = localOf();
      sqlite.registerDocs(onSqlite.local.server, db, pathSchema, pathDocs, [], { ledger: true });
      expect(await readAll(onSqlite.process)).toEqual(read);
      expect(await add(onSqlite.process, "Cheese")).toBe("/courses/4");
      const read2 = await readAll(onSqlite.process);

      // 3. Postgres in this process
      await applyFramework(lite);
      await applySql(lite, generateSql(pathSchema, pathDocs));
      await importTables(lite, pathSchema, sqlite.exportTables(db, pathSchema));
      clearRegistry();
      for (const def of pathDocs) registerDocType(docTypeFromDef(def, lite));
      const onLite = localOf();
      listeners.push(await createDocListener(onLite.local.server, lite, { ledger: true }));
      expect(await readAll(onLite.process)).toEqual(read2);
      expect(await add(onLite.process, "Pudding")).toBe("/courses/5");
      const read3 = await readAll(onLite.process);

      // 4. a Postgres server
      await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
      await importTables(pool, pathSchema, await exportTables(lite, pathSchema));
      clearRegistry();
      for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool));
      const onServer = localOf();
      listeners.push(await createDocListener(onServer.local.server, pool, { ledger: true }));
      expect(await readAll(onServer.process)).toEqual(read3);
      expect(await add(onServer.process, "Coffee")).toBe("/courses/6");

      // the history of a temporal row carries too: the note as it stood before it changed
      const then = await onServer.process.call("open_at", { doc: "fo-notes:1", at: "2021-01-01T00:00:00.000Z" });
      expect(then.result.notes).toEqual({ "1": { id: 1, weddings_id: 1, text: "bring chairs" } });
    } finally {
      await lite.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
