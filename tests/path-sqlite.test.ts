/**
 * The path's second place: SQLite. The shared cases (src/cases/path.ts)
 * asked of registerDocs over an in-memory database, seeded through the carry
 * tool (`importTables`), with a ledger kept.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as json from "../src/server/json";
import { Database } from "bun:sqlite";
import { createTables, exportTables, importTables, registerDocs } from "../src/server/sqlite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import {
  pathCases, pathDocs, pathPublicDocs, pathSchema, pathSeed, sqliteEmails, sqliteGuests, sqliteInbox, sqliteMenuCard, sqliteOpenSeats, type PathBackend,
} from "@blueshed/delta/testing";

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

/**
 * A store an earlier release wrote keeps a time as the text it was given ("10:00:00+02:00"), in its
 * rows and in its ledger; this one reads rows in UTC. An undo of such a write compares the ledger's
 * time to the row's by the instant each names, and puts it back in UTC: it walks, never a conflict
 * (Postgres keeps a timestamptz as an instant). On SQLite and the JSON file.
 */
test("sqlite and json: an undo of a time an earlier release kept with its offset walks, and puts it back in UTC", async () => {
  const older = [["2021-01-01T08:00:00+00:00", "2021-01-01T10:00:00+02:00"], ["2021-06-01T07:30:00+00:00", "2021-06-01T09:30:00+02:00"]];
  const asOlder = (text: string) => older.reduce((t, [utc, local]) => t.replaceAll(utc!, local!), text);
  const writes = async (local: ReturnType<typeof createLocal>) => {
    await local.call("open", { doc: "fo-slots-of:1" });
    for (const ops of [[{ op: "add", path: "/slots/-", value: { starts: "2021-01-01T10:00:00+02:00", price: 1 } }], [{ op: "replace", path: "/slots/1/starts", value: "2021-06-01T09:30:00+02:00" }]]) {
      expect((await local.call("delta", { doc: "fo-slots-of:1", ops, cursor: "c" })).error).toBeUndefined();
    }
  };
  const undoes = async (local: ReturnType<typeof createLocal>) => {
    await local.call("open", { doc: "fo-slots-of:1" });
    const undone = await local.call("undo", { cursor: "c" });
    expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/slots/1", value: { id: 1, weddings_id: 1, price: 1, starts: "2021-01-01T08:00:00+00:00" } }], conflict: undefined });
    expect((await local.call("undo", { cursor: "c" })).result.ops).toEqual([{ op: "remove", path: "/slots/1" }]);
  };
  const dir = mkdtempSync(join(tmpdir(), "delta-older-"));
  try {
    // SQLite: the rows and the ledger as the earlier release left them
    const db = new Database(join(dir, "data.db"));
    createTables(db, pathSchema);
    importTables(db, pathSchema, pathSeed);
    const before = createLocal();
    registerDocs(before.server, db, pathSchema, pathDocs, [], { ledger: true });
    await writes(before);
    db.run("UPDATE fo_slots SET starts = ?", [asOlder("2021-06-01T07:30:00+00:00")]);
    for (const row of db.query("SELECT id, ops, inverse FROM delta_ledger").all() as any[]) {
      db.run("UPDATE delta_ledger SET ops = ?, inverse = ? WHERE id = ?", [asOlder(row.ops), asOlder(row.inverse), row.id]);
    }
    const after = createLocal();
    registerDocs(after.server, db, pathSchema, pathDocs, [], { ledger: true });
    await undoes(after);
    // the JSON file: the same, in the file
    const file = join(dir, "data.json");
    json.importTables(file, pathSchema, pathSeed);
    const first = createLocal();
    const store = json.registerDocs(first.server, file, pathSchema, pathDocs, [], { ledger: true });
    await writes(first);
    await store.persisted();
    writeFileSync(file, asOlder(readFileSync(file, "utf8")));
    const later = createLocal();
    json.registerDocs(later.server, file, pathSchema, pathDocs, [], { ledger: true });
    await undoes(later);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
