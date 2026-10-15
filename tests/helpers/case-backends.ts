/**
 * delta's four backends as `CaseBackend`s, for the cases in `src/cases/writes.ts`:
 * each stands an app up on a fresh store of its own (an app's tables named
 * `case_*`, so a shared Postgres server's other tests are left alone).
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import type { CaseApp, CaseBackend } from "@blueshed/delta/testing";
import { createWs } from "../../src/server/server";
import * as sqlite from "../../src/server/sqlite";
import * as json from "../../src/server/json";
import { applySql, createDocListener, docTypeFromDef, generateSql, importTables } from "../../src/server/postgres";
import { openPglite } from "../../src/server/pglite";
import { applyFramework, newPool } from "../setup";

export const onSqlite: CaseBackend = async ({ schema, docs, seed }) => {
  const db = new Database(":memory:");
  sqlite.createTables(db, schema);
  sqlite.importTables(db, schema, seed);
  const ws = createWs();
  ws.setServer({ publish() {} });
  sqlite.registerDocs(ws, db, schema, docs);
  return { ws, end: async () => db.close() };
};

export const onJson: CaseBackend = async ({ schema, docs, seed }) => {
  const dir = mkdtempSync(join(tmpdir(), "delta-cases-"));
  const file = join(dir, "data.json");
  json.importTables(file, schema, seed);
  const ws = createWs();
  ws.setServer({ publish() {} });
  const store = json.registerDocs(ws, file, schema, docs);
  return { ws, end: async () => { await store.persisted(); rmSync(dir, { recursive: true, force: true }); } };
};

/** The app on a Postgres pool made ready for it: the framework, its tables and its rows. */
async function onPool(pool: Pool, { schema, docs, seed }: CaseApp, drop: () => Promise<void>) {
  await applyFramework(pool);
  await drop();
  await applySql(pool, generateSql(schema, docs));
  await importTables(pool, schema, seed);
  const ws = createWs();
  ws.setServer({ publish() {} });
  const listener = await createDocListener(ws, pool, { types: docs.map((def) => docTypeFromDef(def, pool)) });
  return { ws, listener };
}

export const onPglite: CaseBackend = async (app) => {
  const pool = await openPglite();
  const { ws, listener } = await onPool(pool, app, async () => {});
  return { ws, end: async () => { await listener.destroy(); await pool.end(); } };
};

/** A Postgres server ($DELTA_TEST_PG_URL): its `case_*` tables and their documents dropped before and after. */
export const onPostgres: CaseBackend = async (app) => {
  const pool = await newPool();
  const tables = Object.values(app.schema.tables).map((t) => t.name);
  const drop = async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
    await pool.query(`DROP SEQUENCE IF EXISTS ${tables.map((t) => `seq_${t}`).join(", ")}`);
    await pool.query("DELETE FROM _delta_collections WHERE table_name = ANY($1)", [tables]);
    await pool.query("DELETE FROM _delta_docs WHERE prefix = ANY($1)", [app.docs.map((d) => d.prefix)]);
  };
  const { ws, listener } = await onPool(pool, app, drop);
  return { ws, end: async () => { await listener.destroy(); await drop(); await pool.end(); } };
};
