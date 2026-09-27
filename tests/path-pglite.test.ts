/**
 * The path's third place: Postgres in this process (PGlite). The same stored
 * functions as a Postgres server, the same listener, the same cases
 * (tests/helpers/path.ts) -- no database to run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, exportTables, generateSql, importTables, registerDocType, validateOps,
} from "../src/server/postgres";
import { resolveScope } from "../src/server/scope";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathCases, pathDocs, pathSchema, pathSeed, postgresInbox, type PathBackend } from "./helpers/path";

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
  listeners.push(await createDocListener(local.server, pool, { ledger: true, custom: [postgresInbox] }));
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
  });
});
