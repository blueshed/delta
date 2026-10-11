/**
 * The path's second place: SQLite. The shared cases (tests/helpers/path.ts)
 * asked of registerDocs over an in-memory database, seeded through the carry
 * tool (`importTables`), with a ledger kept.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as json from "../src/server/json";
import { Database } from "bun:sqlite";
import { createTables, exportTables, importTables, registerDocs } from "../src/server/sqlite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathCases, pathDocs, pathPublicDocs, pathSchema, pathSeed, sqliteEmails, sqliteGuests, sqliteInbox, sqliteMenuCard, sqliteOpenSeats, type PathBackend } from "./helpers/path";

setLogLevel("silent");

let backend: PathBackend;

beforeEach(() => {
  const db = new Database(":memory:");
  createTables(db, pathSchema);
  importTables(db, pathSchema, pathSeed);
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  registerDocs(local.server, db, pathSchema, pathDocs, [sqliteInbox, sqliteOpenSeats, sqliteMenuCard, sqliteEmails, sqliteGuests], { ledger: true });
  registerDocs(local.server, db, pathSchema, pathPublicDocs);   // a second registration over the same rows
  backend = {
    process: { call: (action, msg) => local.call(action, msg), heard },
    quiet: async () => {}, // in-process: told before the write answers
    exportTables: async () => exportTables(db, pathSchema),
    storeSetsT: async () => {
      db.run("CREATE TRIGGER fo_t AFTER UPDATE ON fo_households BEGIN UPDATE fo_households SET t = upper(NEW.email) WHERE id = NEW.id; END");
      return async () => void db.run("DROP TRIGGER fo_t");
    },
  };
});

describe("sqlite", () => pathCases(() => backend));

/**
 * A database that has minted nothing yet holds no sequence rows (Postgres's sequences are there from
 * the start): an id a write named still moves the next past it once its row is gone, as setval does
 * (review). A refused write names none, on every backend (#71).
 */
test("sqlite and json: a fresh store keeps an id a write named once its row is gone: the next is past it, as on Postgres", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-fresh-"));
  try {
    const db = new Database(":memory:");
    createTables(db, pathSchema);
    for (const register of [(l: ReturnType<typeof createLocal>) => registerDocs(l.server, db, pathSchema, pathDocs), (l: ReturnType<typeof createLocal>) => json.registerDocs(l.server, join(dir, "data.json"), pathSchema, pathDocs)]) {
      const local = createLocal();
      register(local);
      await local.call("open", { doc: "fo-weddings:" });
      for (const op of [{ op: "add", path: "/weddings/50", value: { name: "x" } }, { op: "remove", path: "/weddings/50" }]) {
        expect((await local.call("delta", { doc: "fo-weddings:", ops: [op] })).error).toBeUndefined();
      }
      expect((await local.call("delta", { doc: "fo-weddings:", ops: [{ op: "add", path: "/weddings/-", value: { name: "y" } }], inverse: true })).result.ops[0].path).toBe("/weddings/51");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
