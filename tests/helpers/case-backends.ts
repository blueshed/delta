/**
 * delta's backends as `CaseBackend`s, for the cases in `src/cases/writes.ts`:
 * each stands an app up on a fresh store of its own. (dzql stands up Postgres.)
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CaseBackend } from "@blueshed/delta/testing";
import { createWs } from "../../src/server/server";
import * as sqlite from "../../src/server/sqlite";
import * as json from "../../src/server/json";

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
