/**
 * The path's second place: SQLite. The shared cases (tests/helpers/path.ts)
 * asked of registerDocs over an in-memory database, seeded through the carry
 * tool (`importTables`), with a ledger kept.
 */
import { beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { createTables, exportTables, importTables, registerDocs } from "../src/server/sqlite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathCases, pathDocs, pathSchema, pathSeed, type PathBackend } from "./helpers/path";

setLogLevel("silent");

let backend: PathBackend;

beforeEach(() => {
  const db = new Database(":memory:");
  createTables(db, pathSchema);
  importTables(db, pathSchema, pathSeed);
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  registerDocs(local.server, db, pathSchema, pathDocs, [], { ledger: true });
  backend = {
    process: { call: (action, msg) => local.call(action, msg), heard },
    quiet: async () => {}, // in-process: told before the write answers
    exportTables: async () => exportTables(db, pathSchema),
  };
});

describe("sqlite", () => pathCases(() => backend));
