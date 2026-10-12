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
  applySql, createDocListener, docTypeFromDef, exportTables, generateSql, importTables,
} from "../src/server/postgres";
import * as sqlite from "../src/server/sqlite";
import * as json from "../src/server/json";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { applyFramework, newPool } from "./setup";
import { waitFor } from "../src/testing";
import {
  assertCopiesHold, course, expectTold, field, household, openAll, pathCases, pathDocs, pathPublicDocs, pathSchema, pathSeed, postgresEmails, postgresGuests, postgresInbox, postgresMenuCard, postgresOpenSeats, readAll, told, write,
  type PathBackend, type PathProcess,
} from "./helpers/path";
import { q } from "../src/schema";

setLogLevel("silent");

const tables = Object.values(pathSchema.tables).map((t) => q(t.name));
let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];
let backend: PathBackend;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await applySql(pool, generateSql(pathSchema, [...pathDocs, ...pathPublicDocs]));
});

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
  await pool.query("DELETE FROM _delta_docs WHERE prefix = ANY($1)", [[...pathDocs, ...pathPublicDocs].map((d) => d.prefix)]);
  await pool.query("DELETE FROM _delta_collections WHERE collection_key = ANY($1)", [Object.keys(pathSchema.tables)]);
  await pool.end();
});

/** The version each document open on a process was opened at (`_v`), while it is open. */
const openedAt = new WeakMap<PathProcess, Map<string, number>>();

/** A process on the database: delta in-process over its own listener, and everything it published. */
async function processOn(): Promise<PathProcess> {
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  listeners.push(await createDocListener(local.server, pool, { types: [...pathDocs, ...pathPublicDocs].map((def) => docTypeFromDef(def, pool)), ledger: true, custom: [postgresInbox, postgresOpenSeats, postgresMenuCard, postgresEmails, postgresGuests] }));
  const opened = new Map<string, number>();
  const made: PathProcess = {
    call: async (action, msg) => {
      const r = await local.call(action, msg);
      if (action === "open" && typeof r.result?._v === "number") opened.set(String(msg.doc), r.result._v);
      if (action === "close") opened.delete(String(msg.doc));
      return r;
    },
    heard,
  };
  openedAt.set(made, opened);
  return made;
}

/**
 * Quiet once every document open on `p` has been told up to the version the
 * database is at for it (`_delta_versions`): the listener fetches what a
 * NOTIFY announced after the write answered, so a fixed wait alone could
 * read a copy before its telling under load. Custom documents keep no
 * version: the wait before covers them, as it did.
 */
async function quiet(p: PathProcess): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  const opened = openedAt.get(p) ?? new Map<string, number>();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query("SELECT doc_name, version FROM _delta_versions WHERE doc_name = ANY($1)", [[...opened.keys()]]);
    const behind = rows.filter((r: any) => {
      const told = p.heard.filter((h) => h.channel === r.doc_name).map((h) => Number(h.data.v ?? 0));
      return Math.max(opened.get(r.doc_name)!, ...told) < Number(r.version);
    });
    if (!behind.length) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
  await importTables(pool, pathSchema, pathSeed);
  backend = {
    process: await processOn(),
    // LISTEN/NOTIFY over the wire: the write answers at its commit; what it notified is fetched and published after.
    quiet: () => quiet(backend.process),
    exportTables: () => exportTables(pool, pathSchema),
    storeSetsT: async () => {
      await pool.query("CREATE FUNCTION fo_t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.t := upper(NEW.email); RETURN NEW; END $$");
      await pool.query("CREATE TRIGGER fo_t BEFORE INSERT OR UPDATE ON fo_households FOR EACH ROW EXECUTE FUNCTION fo_t()");
      return async () => void await pool.query("DROP FUNCTION fo_t() CASCADE");
    },
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
    await expectTold(there, "fo-menu:1", [[field("/courses/1/name", "Broth")]]);
    await expectTold(there, "fo-household:1", [[field("/households/email", "new@x")]]);
    await assertCopiesHold(backend, copies);
    await assertCopiesHold(there, theirs);
  });

  test("a reader behind can catch up on a told document from the log", async () => {
    const before = (await backend.process.call("open", { doc: "fo-menu:1" })).result._v as number;
    await openAll(backend.process, ["fo-board:1", "fo-menu:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await expectTold(backend, "fo-menu:1", [[field("/courses/1/name", "Broth")]]);
    const { rows } = await pool.query("SELECT version, ops FROM delta_fetch_ops($1, $2)", ["fo-menu:1", before]);
    expect(rows.map((r: any) => ({ v: Number(r.version), ops: r.ops }))).toEqual([{ v: before + 1, ops: told(backend.process, "fo-menu:1")[0] }]);
  });

  test("two adds of one note id at once, through two documents, make one live note: the second waits for the first, and is refused as already there (todo #16)", async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`SELECT delta_apply('fo-board:1', '[{"op":"add","path":"/notes/5","value":{"text":"one"}}]'::jsonb)`);
      // another document, so another document lock: only the row itself can keep them apart
      const racing = second.query(`SELECT delta_apply('fo-notes:1', '[{"op":"add","path":"/notes/5","value":{"text":"two"}}]'::jsonb)`)
        .then(() => "taken", (err: any) => err.code);
      await new Promise((r) => setTimeout(r, 200));
      await first.query("COMMIT");
      expect(await racing).toBe("23505");
      const { rows } = await pool.query("SELECT text FROM fo_notes WHERE id = 5 AND valid_to IS NULL");
      expect(rows).toEqual([{ text: "one" }]);
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
      second.release();
    }
  });

  test("two adds of two note ids in opposite orders, at once, deadlock: the one refused is told to send again (409), not a 500 (todo #16's review)", async () => {
    const other = await pool.connect();
    try {
      await other.query("BEGIN");
      await other.query(`SELECT delta_apply('fo-notes:1', '[{"op":"add","path":"/notes/10","value":{"text":"b"}}]'::jsonb)`);
      // this write takes note 11's lock, then waits for 10's; the other then waits for 11's
      const answer = backend.process.call("delta", { doc: "fo-board:1", ops: [
        { op: "add", path: "/notes/11", value: { text: "a" } },
        { op: "add", path: "/notes/10", value: { text: "a" } },
      ] });
      await new Promise((r) => setTimeout(r, 200));
      const theirs = other.query(`SELECT delta_apply('fo-notes:1', '[{"op":"add","path":"/notes/11","value":{"text":"b"}}]'::jsonb)`).then(() => "taken", (err: any) => err.code);
      const [mine, done] = await Promise.all([answer, theirs]);
      // the first to wait is the first to find the cycle: this write gives way. It
      // named note 11 but passed no serial (that comes once a write is done), so the
      // other finds 11 new and takes it (#71)
      expect({ mine: mine.error?.code, deadlock: /deadlock/i.test(mine.error?.message), theirs: done }).toEqual({ mine: 409, deadlock: true, theirs: "taken" });
      await other.query("COMMIT");
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      other.release();
    }
  }, 15000);

  test("a document opened in no process is not told, and costs no version", async () => {
    await openAll(backend.process, ["fo-board:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await backend.quiet();
    const { rows } = await pool.query("SELECT doc_name FROM _delta_versions WHERE doc_name LIKE 'fo-%' ORDER BY doc_name");
    expect(rows.map((r: any) => r.doc_name)).toEqual(["fo-board:1"]);
  });
});

/** A write's fan-out asks the names open now, not every name ever opened (todo #73). */
describe("postgres: the documents open now", () => {
  const logged = async (doc: string) => Number((await pool.query("SELECT count(*) FROM _delta_ops_log WHERE doc_name = $1", [doc])).rows[0].count);
  const held = async () => (await pool.query("SELECT doc_name FROM _delta_held WHERE doc_name LIKE 'fo-%' ORDER BY doc_name")).rows.map((r: any) => r.doc_name);
  /** Closed, and let go of: the listener lets go after it answers. */
  const close = async (doc: string) => {
    await backend.process.call("close", { doc });
    await waitFor(async () => !(await held()).includes(doc));
  };

  test("a document opened and closed again is not told: nothing is written to its log", async () => {
    await openAll(backend.process, ["fo-board:1", "fo-menu:1"]);
    await close("fo-menu:1");
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    expect({ held: await held(), menu: await logged("fo-menu:1") }).toEqual({ held: ["fo-board:1"], menu: 0 });
  });

  test("a document opened while a write runs reads what the write did, or is told it: the open waits for the write", async () => {
    const first = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`SELECT delta_apply('fo-board:1', '[{"op":"replace","path":"/courses/1/name","value":"Broth"}]'::jsonb)`);
      // the write has asked who holds course 1 -- not the menu, open nowhere yet
      const opened = backend.process.call("open", { doc: "fo-menu:1" });
      await new Promise((r) => setTimeout(r, 200));
      await first.query("COMMIT");
      expect((await opened).result.courses["1"].name).toBe("Broth");
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
    }
  });

  test("delta_prune_ops lets go of a name nobody holds, with nothing in the log or the ledger: opened again, it starts at 0 and is told from there", async () => {
    await openAll(backend.process, ["fo-board:1", "fo-menu:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await close("fo-menu:1");
    await pool.query("SELECT delta_prune_ops('0 seconds')");
    const { rows } = await pool.query("SELECT doc_name FROM _delta_versions WHERE doc_name LIKE 'fo-%' ORDER BY doc_name");
    expect(rows.map((r: any) => r.doc_name)).toEqual(["fo-board:1"]);   // open, and the ledger names it

    const copies = await openAll(backend.process, ["fo-menu:1"]);
    expect(copies.get("fo-menu:1")._v).toBe(0);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Soup" }]);
    await expectTold(backend, "fo-menu:1", [[{ op: "replace", path: "/courses/1/name", value: "Soup" }]]);
    expect(backend.process.heard.find((h) => h.channel === "fo-menu:1")!.data.v).toBe(1);
    await assertCopiesHold(backend, copies);
  });

  /** The listener's connection ends, and another clears the names of a listener that is gone. */
  const loseTheListener = async () => {
    const { rows: [{ holder }] } = await pool.query("SELECT holder FROM _delta_held WHERE doc_name = 'fo-menu:1'");
    const lock = `FROM pg_locks WHERE locktype = 'advisory' AND classid = hashtext('_delta_held')::oid AND objid = $1::oid`;
    await pool.query(`SELECT pg_terminate_backend(pid) ${lock}`, [holder]);
    await waitFor(async () => (await pool.query(`SELECT 1 ${lock}`, [holder])).rowCount === 0);
    await pool.query("SELECT delta_prune_ops()");
    expect(await held()).toEqual([]);
  };
  const letGo = (doc: string) => backend.process.heard.some((h) => h.channel === doc && h.data.error);

  test("a listener whose names were cleared while it was away lets go of their sockets, which open them again", async () => {
    await openAll(backend.process, ["fo-menu:1"]);
    await loseTheListener();
    await waitFor(() => letGo("fo-menu:1"), { timeout: 5000 });
  }, 10000);

  test("an open while the listener is away does not hide the names cleared: those are let go of, the one opened is kept", async () => {
    await openAll(backend.process, ["fo-menu:1"]);
    await loseTheListener();
    await backend.process.call("open", { doc: "fo-board:1" });   // held again before the listener is back
    await waitFor(() => letGo("fo-menu:1"), { timeout: 5000 });
    expect({ board: letGo("fo-board:1"), held: await held() }).toEqual({ board: false, held: ["fo-board:1"] });
  }, 10000);

  test("an open waiting for a write holds up no open of another prefix", async () => {
    const first = await pool.connect();
    try {
      await first.query("BEGIN");
      await first.query(`SELECT delta_apply('fo-board:1', '[{"op":"replace","path":"/courses/1/name","value":"Broth"}]'::jsonb)`);
      const menu = backend.process.call("open", { doc: "fo-menu:1" });   // waits for the write: the menu holds courses
      await new Promise((r) => setTimeout(r, 50));
      const tagged = await Promise.race([
        backend.process.call("open", { doc: "fo-tagged:1" }).then((r) => r.result ? "opened" : "refused"),
        new Promise((r) => setTimeout(() => r("waiting"), 1000)),
      ]);
      expect(tagged).toBe("opened");
      await first.query("COMMIT");
      expect((await menu).result.courses["1"].name).toBe("Broth");
    } finally {
      await first.query("ROLLBACK").catch(() => {});
      first.release();
    }
  });

  test("delta_prune_ops keeps the version of a name held open, though nothing of it is left in the log: the next change follows on", async () => {
    await openAll(backend.process, ["fo-board:1", "fo-menu:1"]);
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
    await waitFor(() => told(backend.process, "fo-menu:1").length === 1);   // told, and fetched from the log, before the log is pruned
    await pool.query("SELECT delta_prune_ops('0 seconds')");
    await write(backend.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Soup" }]);
    await waitFor(() => told(backend.process, "fo-menu:1").length === 2);
    expect(backend.process.heard.filter((h) => h.channel === "fo-menu:1").map((h) => h.data.v)).toEqual([1, 2]);
  });

  test("a write in a transaction that reads from one snapshot is refused: it would not see a name held after it began", async () => {
    const other = await pool.connect();
    try {
      await other.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const refused = await other.query(`SELECT delta_apply('fo-board:1', '[{"op":"replace","path":"/courses/1/name","value":"RR"}]'::jsonb)`)
        .then(() => null, (err: any) => ({ code: err.code, message: err.message }));
      expect(refused).toEqual({ code: "0A000", message: expect.stringContaining("READ COMMITTED") });
    } finally {
      await other.query("ROLLBACK").catch(() => {});
      other.release();
    }
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
      const onLite = localOf();
      listeners.push(await createDocListener(onLite.local.server, lite, { types: pathDocs.map((def) => docTypeFromDef(def, lite)), ledger: true }));
      expect(await readAll(onLite.process)).toEqual(read2);
      expect(await add(onLite.process, "Pudding")).toBe("/courses/5");
      const read3 = await readAll(onLite.process);

      // 4. a Postgres server
      await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
      await importTables(pool, pathSchema, await exportTables(lite, pathSchema));
      const onServer = localOf();
      listeners.push(await createDocListener(onServer.local.server, pool, { types: pathDocs.map((def) => docTypeFromDef(def, pool)), ledger: true }));
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
