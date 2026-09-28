/**
 * The path's third place: Postgres in this process (PGlite). The same stored
 * functions as a Postgres server, the same listener, the same cases
 * (tests/helpers/path.ts) -- no database to run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, exportTables, generateSql, importTables, registerDocType, validateOps,
} from "../src/server/postgres";
import { resolveScope } from "../src/server/scope";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import {
  assertCopiesHold, expectTold, household, openAll, pathCases, pathDocs, pathSchema, pathSeed, postgresInbox, postgresOpenSeats, told, write, type PathBackend,
} from "./helpers/path";

setLogLevel("silent");

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];
let backend: PathBackend;
const tables = Object.values(pathSchema.tables).map((t) => t.name);

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, pathDocs));
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  clearRegistry();
  await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
  await importTables(pool, pathSchema, pathSeed);
  for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool));
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  listeners.push(await createDocListener(local.server, pool, { ledger: true, custom: [postgresInbox, postgresOpenSeats] }));
  backend = {
    process: { call: (action, msg) => local.call(action, msg), heard },
    // NOTIFY is heard after the write's commit, and fetched then: a beat.
    quiet: () => new Promise((r) => setTimeout(r, 100)),
    exportTables: () => exportTables(pool, pathSchema),
  };
});

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.destroy();
});

describe("pglite", () => pathCases(() => backend));

/**
 * The exported validateOps says ahead what delta_apply answers (todo #47):
 * each write it refuses, the database refuses as a mistake (400), and each it
 * takes, the database takes -- or refuses for what only the rows can say (a
 * row not there, 404; already there, 409). Each write is asked of fresh rows.
 */
describe("pglite: validateOps answers as delta_apply does", () => {
  const writes: [string, unknown][] = [
    ["fo-household:1", { op: "replace", path: "/households/weddings_id", value: 2 }],
    ["fo-household:1", { op: "replace", path: "/households/weddings_id", value: "2" }],
    ["fo-household:1", { op: "replace", path: "/households", value: { weddings_id: 2, email: "q@x" } }],
    ["fo-household:1", { op: "replace", path: "/households/email", value: "q@x" }],
    ["fo-household:1", { op: "replace", path: "/households/nope", value: "x" }],
    ["fo-household:1", { op: "replace", path: "/households", value: { nope: 1 } }],
    ["fo-household:1", { op: "replace", path: "/households", value: 5 }],
    ["fo-household:1", { op: "replace", path: "/households/weddings_id", value: null }],
    ["fo-household:1", { op: "replace", path: "/households/weddings_id", value: true }],
    ["fo-household:1", { op: "replace", path: "/households", value: { weddings_id: 1.5 } }],
    ["fo-household:1", { op: "replace", path: "/households/email", value: null }],
    ["fo-household:1", { op: "replace", path: "/households/1", value: { email: "q@x" } }],
    ["fo-household:1", { op: "replace", path: "/households/id", value: 9 }],
    ["fo-household:1", { op: "replace", path: "/households", value: { id: 9, email: "q@x" } }],
    ["fo-household:1", { op: "add", path: "/households/email", value: "x" }],
    ["fo-household:1", { op: "remove", path: "/households/email" }],
    ["fo-household:1", { op: "remove", path: "/households" }],
    ["fo-household:1", { op: "add", path: "/households", value: {} }],
    ["fo-board:1", { op: "replace", path: "/households/1/weddings_id", value: 2 }],
    ["fo-board:1", { op: "replace", path: "/households/1/weddings_id", value: "2" }],
    ["fo-board:1", { op: "replace", path: "/households/1/weddings_id", value: null }],
    ["fo-board:1", { op: "replace", path: "/households/1/weddings_id", value: 1.5 }],
    ["fo-board:1", { op: "replace", path: "/households/1/weddings_id", value: "x" }],
    ["fo-board:1", { op: "replace", path: "/households/1", value: { weddings_id: 2 } }],
    ["fo-board:1", { op: "replace", path: "/households/1", value: { weddings_id: null } }],
    ["fo-board:1", { op: "replace", path: "/households/1", value: { nope: 1 } }],
    ["fo-board:1", { op: "replace", path: "/households/1", value: 5 }],
    ["fo-board:1", { op: "replace", path: "/households/1/email", value: null }],
    ["fo-board:1", { op: "replace", path: "/households/1/nope", value: 1 }],
    ["fo-board:1", { op: "replace", path: "/households/1/id", value: 9 }],
    ["fo-board:1", { op: "replace", path: "/households/1", value: { id: 9, email: "q@x" } }],
    ["fo-board:1", { op: "replace", path: "/weddings/name", value: "n" }],
    ["fo-board:1", { op: "replace", path: "/weddings", value: { name: "n" } }],
    ["fo-board:1", { op: "add", path: "/courses/-", value: { name: "Fish" } }],
    ["fo-board:1", { op: "add", path: "/courses/10", value: { name: "Fish" } }],
    ["fo-board:1", { op: "add", path: "/courses/1", value: { name: "Fish" } }],
    ["fo-board:1", { op: "add", path: "/courses/-", value: {} }],
    ["fo-board:1", { op: "add", path: "/courses/-", value: { name: null } }],
    ["fo-board:1", { op: "add", path: "/courses/-", value: { name: "Fish", nope: 1 } }],
    ["fo-board:1", { op: "add", path: "/courses/-", value: 5 }],
    ["fo-board:1", { op: "add", path: "/drinks/-", value: { courses_id: 1, name: "Port" } }],
    ["fo-board:1", { op: "add", path: "/notes/-", value: { text: "n" } }],
    ["fo-board:1", { op: "replace", path: "/notes/1/text", value: "t" }],
    ["fo-board:1", { op: "remove", path: "/courses/1" }],
    ["fo-board:1", { op: "remove", path: "/courses/99" }],
    ["fo-board:1", { op: "remove", path: "/courses/2" }],
    ["fo-board:1", { op: "remove", path: "/courses/abc" }],
    ["fo-board:1", { op: "remove", path: "/courses/9007199254740993" }],
    ["fo-board:1", { op: "replace", path: "/courses/abc/name", value: "x" }],
    ["fo-board:1", { op: "add", path: "/courses", value: {} }],
    ["fo-board:1", { op: "remove", path: "/courses" }],
    ["fo-board:1", { op: "replace", path: "/courses", value: {} }],
    ["fo-board:1", { op: "replace", path: "/courses/1/name/x", value: "x" }],
    ["fo-board:1", { op: "add", path: "/courses/1/name", value: "x" }],
    ["fo-board:1", { op: "remove", path: "/courses/1/name" }],
    ["fo-board:1", { op: "move", path: "/courses/1", from: "/courses/2" }],
    ["fo-board:1", { op: "replace", path: "/", value: {} }],
    ["fo-board:1", { op: "replace", path: "courses", value: {} }],
    ["fo-board:1", { op: "add", path: "/seats/-", value: { table_no: 1, kept: true } }],
    ["fo-seating:1", { op: "add", path: "/seats/-", value: { table_no: 1, kept: true } }],
    ["fo-seating:1", { op: "add", path: "/seats/-", value: { table_no: 1 } }],
    ["fo-seating:1", { op: "replace", path: "/seats/1/wishes", value: { veg: false } }],
    ["fo-seating:1", { op: "replace", path: "/seats/1/wishes", value: null }],
    ["fo-seating:1", { op: "replace", path: "/seats/1/kept", value: null }],
    ["fo-course:1", { op: "replace", path: "/courses/weddings_id", value: 2 }],
    ["fo-course:1", { op: "add", path: "/drinks/-", value: { name: "x" } }],
    ["fo-tags-labelled:blue", { op: "add", path: "/tags/-", value: {} }],
    ["fo-tags-labelled:blue", { op: "add", path: "/tags/-", value: { label: "red" } }],
    ["fo-tags-labelled:red", { op: "replace", path: "/tags/1/label", value: "red" }],
    ["fo-tags-labelled:red", { op: "replace", path: "/tags/label", value: "red" }],
    ["fo-tags-labelled:red", { op: "replace", path: "/tags", value: { label: "red" } }],
    ["fo-all-courses:", { op: "add", path: "/courses/-", value: { weddings_id: 1, name: "x" } }],
    ["fo-all-courses:", { op: "replace", path: "/courses/name", value: "x" }],
    ["fo-seats-kept:1", { op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4 } }],
    ["fo-seats-wished:5", { op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4, kept: false } }],
  ];
  const WIRE: Record<string, number> = { "22023": 400, "22P02": 400, "23502": 400, P0002: 404, "23505": 409 };

  test("each write it refuses the database refuses as a mistake (400); each it takes, the database takes, or answers for its rows", async () => {
    const answers: { doc: string; op: unknown; ahead: string[]; database: number }[] = [];
    for (const [doc, op] of writes) {
      await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log RESTART IDENTITY`);
      await importTables(pool, pathSchema, pathSeed);
      const def = pathDocs.find((d) => doc.startsWith(d.prefix))!;
      const scope = resolveScope(def, doc.slice(def.prefix.length));
      const ahead = validateOps(pathSchema, def, [op as any], { list: scope.mode === "list", values: scope.values }).map((e) => e.message);
      let database = 200;
      try { await pool.query("SELECT delta_apply($1, $2::jsonb)", [doc, JSON.stringify([op])]); }
      catch (err: any) { database = WIRE[err.code] ?? 500; }
      answers.push({ doc, op, ahead, database });
    }
    expect(answers.filter((a) => a.database === 500)).toEqual([]);
    expect(answers.filter((a) => (a.ahead.length > 0) !== (a.database === 400))).toEqual([]);
  }, 30_000);   // many PGlite round trips: past bun's 5s default on a loaded machine
});

/**
 * The log keeps a write's applied ops once, and only where the writer was told
 * otherwise: where they agree, the writer's entry carries none (null), and is
 * heard as told; each other told document's entry carries [] (todo #44).
 * tests/helpers/path.ts asks that a custom document hears each write once
 * either way.
 */
describe("pglite: the log keeps the write as applied only where the writer was told otherwise", () => {
  const entries = async () =>
    (await pool.query("SELECT doc_name, ops, applied FROM _delta_ops_log ORDER BY id")).rows.map((r: any) => [r.doc_name, r.applied]);

  test("told as applied: the writer's entry carries none; the other told document's, []", async () => {
    await openAll(backend.process, ["fo-household:1", "fo-board:1", "fo-inbox:new@x"]);
    await write(backend.process, "fo-household:1", [{ op: "replace", path: "/households/email", value: "new@x" }]);
    await expectTold(backend, "fo-inbox:new@x", [[{ op: "add", path: "/households/1", value: household(1, "new@x") }]]);
    expect(await entries()).toEqual([["fo-household:1", null], ["fo-board:1", []]]);
  });

  test("told otherwise -- the row left the writer -- its entry carries the write as applied", async () => {
    await openAll(backend.process, ["fo-board:1", "fo-inbox:a@x"]);
    const { ops } = await write(backend.process, "fo-board:1", [{ op: "replace", path: "/households/1/weddings_id", value: 2 }]);
    await expectTold(backend, "fo-inbox:a@x", [[{ op: "replace", path: "/households/1", value: household(1, "a@x", 2) }]]);
    expect(await entries()).toEqual([["fo-board:1", ops]]);
    expect(told(backend.process, "fo-board:1")).toEqual([[{ op: "remove", path: "/households/1" }]]);
  });
});

/**
 * A listener newer than the framework SQL it runs on -- vendored with `delta
 * init` and not re-applied -- has no `_delta_fetch_log` to read. It reads
 * `delta_fetch_ops` instead, each entry heard as told, and says once that the
 * SQL is behind: every broadcast still arrives (todo #44's review).
 */
describe("pglite: a listener on framework SQL older than it", () => {
  test("still tells every document, and says once that the SQL is behind", async () => {
    const behind = await openPglite();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await applyFramework(behind);
      await behind.query("DROP FUNCTION _delta_fetch_log(text, bigint)");
      await applySql(behind, generateSql(pathSchema, pathDocs));
      await importTables(behind, pathSchema, pathSeed);
      clearRegistry();
      for (const def of pathDocs) registerDocType(docTypeFromDef(def, behind));
      const local = createLocal();
      const heard: { channel: string; data: any }[] = [];
      local.onPublish((channel, data) => heard.push({ channel, data }));
      setLogLevel("warn");
      listeners.push(await createDocListener(local.server, behind, { ledger: true, custom: [postgresInbox, postgresOpenSeats] }));
      setLogLevel("silent");
      const b: PathBackend = {
        process: { call: (action, msg) => local.call(action, msg), heard },
        quiet: () => new Promise((r) => setTimeout(r, 100)),
        exportTables: () => exportTables(behind, pathSchema),
      };
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-inbox:a@x", "fo-inbox:new@x"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/email", value: "new@x" }]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/2/email", value: "new@x" }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "new@x") }]]);
      await expectTold(b, "fo-board:1", [
        [{ op: "replace", path: "/households/1", value: household(1, "new@x") }],
        [{ op: "replace", path: "/households/2", value: household(2, "new@x") }],
      ]);
      await expectTold(b, "fo-inbox:a@x", [[{ op: "remove", path: "/households/1" }]]);
      await assertCopiesHold(b, copies);
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("older than this listener"))).toHaveLength(1);
    } finally {
      setLogLevel("silent");
      warn.mockRestore();
      for (const l of listeners.splice(0)) await l.destroy();
      await behind.end();
    }
  }, 30_000);   // many PGlite round trips: past bun's 5s default on a loaded machine
});
