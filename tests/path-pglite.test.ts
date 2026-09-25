/**
 * The path's third place: Postgres in this process (PGlite). The same stored
 * functions as a Postgres server, the same listener, the same cases
 * (tests/helpers/path.ts) -- no database to run.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, exportTables, generateSql, importTables, registerDocType,
} from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathCases, pathDocs, pathSchema, pathSeed, type PathBackend } from "./helpers/path";

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
  listeners.push(await createDocListener(local.server, pool, { ledger: true }));
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
