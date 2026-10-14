/**
 * Migrations (reference/migrations.md): the changes a schema cannot say, run
 * once each, in order, at start-up, before the schema adds what it declares.
 * The same story on SQLite and on Postgres in process (PGlite).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Pool, PoolClient } from "pg";
import * as sqlite from "../src/server/sqlite";
import * as pg from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import type { DocDef, Schema } from "../src/schema";
import type { MigrateOptions, MigrateResult, Migration } from "../src/server/migrate";

setLogLevel("silent");

/** PGlite starts a Postgres per database: a few of them in a test, under a loaded suite. */
const SLOW = 30_000;

const team = sqlite.defineDoc("team:", { root: "teams", include: ["people"], implied: true });
const before = sqlite.defineSchema({
  teams: { columns: {}, temporal: false },
  people: { parent: "teams", columns: { name: "text", phone: "text?", fax: "text?" } },   // temporal, by default
});
const after = sqlite.defineSchema({
  teams: { columns: {}, temporal: false },
  people: { parent: "teams", columns: { full_name: "text", phone: "text?", email: "text?" } },
});

const dirs: string[] = [];
const pools: Pool[] = [];
const listeners: { destroy(): Promise<void> }[] = [];
afterAll(async () => {
  for (const l of listeners) await l.destroy();
  for (const p of pools) await p.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "delta-migrate-")); dirs.push(d); return d; };

/** A database, started as an app starts: migrate, then what the schema declares; served with the ledger. */
interface Backend<H> {
  open(): Promise<H>;
  start(h: H, schema: Schema, list: Migration[]): Promise<MigrateResult>;
  serve(h: H, schema: Schema): Promise<ReturnType<typeof createLocal>>;
  status(h: H, list: Migration[], options?: MigrateOptions): ReturnType<typeof sqlite.migrationStatus>;
  /** Only the migrations, for an app. */
  migrate(h: H, list: Migration[], options?: MigrateOptions): Promise<MigrateResult>;
  columns(h: H, table: string): Promise<string[]>;
  views(h: H): Promise<string[]>;
  rows(h: H, sql: string): Promise<any[]>;
  /** The story's migrations, each saying it ran into `ran`. */
  story(ran: string[]): Migration[];
  /** A migration that fails part way, after a change. */
  failing(): Migration;
}

const sqliteBackend: Backend<string> = {
  async open() { return join(tempDir(), "app.db"); },
  async start(file, schema, list) {
    const db = new Database(file);
    const result = await sqlite.migrate(db, list);
    sqlite.createTables(db, schema);
    sqlite.migrateSchema(db, schema);
    return result;
  },
  async serve(file, schema) {
    const local = createLocal();
    sqlite.registerDocs(local.server, new Database(file), schema, [team], [], { ledger: true });
    return local;
  },
  status: (file, list, options) => sqlite.migrationStatus(new Database(file), list, options),
  migrate: (file, list, options) => sqlite.migrate(new Database(file), list, options),
  async columns(file, table) {
    return (new Database(file).query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => `${c.name}:${c.type}`).toSorted();
  },
  async views(file) { return (new Database(file).query("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as any[]).map((v) => v.name); },
  async rows(file, sql) { return new Database(file).query(sql).all(); },
  story: (ran) => [
    { id: "001-name-is-full-name", up: (db: Database) => { ran.push("001"); sqlite.renameColumn(db, "people", "name", "full_name"); } },
    { id: "002-fax-into-phone", up: (db: Database) => { ran.push("002"); db.run("UPDATE people SET phone = fax WHERE phone IS NULL"); } },
    { id: "003-no-fax", up: async (db: Database) => { ran.push("003"); sqlite.dropColumn(db, "people", "fax"); } },
  ],
  failing: () => ({ id: "004-breaks", up: (db: Database) => { db.run("UPDATE people SET phone = 'lost'"); db.run("SELECT * FROM no_such_table"); } }),
};

const pgBackend: Backend<Pool> = {
  async open() { const pool = await openPglite(); pools.push(pool); return pool; },
  async start(pool, schema, list) {
    const result = await pg.migrate(pool, list);
    await pg.applyFramework(pool);
    await pg.applySql(pool, pg.generateSql(schema, [team]));
    return result;
  },
  async serve(pool) {
    const local = createLocal();
    listeners.push(await pg.createDocListener(local.server, pool, { types: [pg.docTypeFromDef(team, pool)], ledger: true }));
    return local;
  },
  status: (pool, list, options) => pg.migrationStatus(pool, list, options),
  migrate: (pool, list, options) => pg.migrate(pool, list, options),
  async columns(pool, table) {
    return (await pool.query("SELECT column_name || ':' || data_type AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])).rows.map((r) => r.c).toSorted();
  },
  async views(pool) {
    return (await pool.query("SELECT table_name AS v FROM information_schema.views WHERE table_schema = current_schema() ORDER BY 1")).rows.map((r) => r.v);
  },
  async rows(pool, sql) { return (await pool.query(sql)).rows; },
  story: (ran) => [
    { id: "001-name-is-full-name", up: async (tx: PoolClient) => { ran.push("001"); await pg.renameColumn(tx, "people", "name", "full_name"); } },
    { id: "002-fax-into-phone", up: async (tx: PoolClient) => { ran.push("002"); await tx.query("UPDATE people SET phone = fax WHERE phone IS NULL"); } },
    { id: "003-no-fax", up: async (tx: PoolClient) => { ran.push("003"); await pg.dropColumn(tx, "people", "fax"); } },
  ],
  failing: () => ({ id: "004-breaks", up: async (tx: PoolClient) => { await tx.query("UPDATE people SET phone = 'lost'"); await tx.query("SELECT * FROM no_such_table"); } }),
};

const people = async (local: ReturnType<typeof createLocal>) =>
  Object.values((await local.call("open", { doc: "team:1" })).result.people as Record<string, any>)
    .map(({ id: _id, teams_id: _t, ...row }) => row)
    .toSorted((a: any, b: any) => String(a.full_name ?? a.name).localeCompare(String(b.full_name ?? b.name)));

/** The app before: two people, written through the ledger, Ada's name changed after. */
async function lived<H>(b: Backend<H>, h: H) {
  await b.start(h, before, []);
  const v1 = await b.serve(h, before);
  await v1.call("open", { doc: "team:1" });
  const ada = await v1.call("delta", { doc: "team:1", ops: [{ op: "add", path: "/people/-", value: { name: "Ada", fax: "123" } }], cursor: "ada" });
  await v1.call("delta", { doc: "team:1", ops: [{ op: "add", path: "/people/-", value: { name: "Bob", phone: "555", fax: "999" } }], cursor: "bob" });
  await v1.call("delta", { doc: "team:1", ops: [{ op: "replace", path: `${ada.result.ops[0].path}/name`, value: "Ada L" }], cursor: "ada" });
  return { adaPath: ada.result.ops[0].path as string };
}

for (const [name, b] of [["sqlite", sqliteBackend], ["pglite", pgBackend]] as [string, Backend<any>][]) {
  describe(name, () => {
    test("an app's data survives an upgrade that adds a field, renames one, drops one and moves data from one to another; it runs once, in order, and a second start does nothing", async () => {
      const h = await b.open();
      await lived(b, h);
      const ran: string[] = [];
      const list = b.story(ran);
      expect((await b.status(h, list)).pending).toEqual(["001-name-is-full-name", "002-fax-into-phone", "003-no-fax"]);

      expect(await b.start(h, after, list)).toEqual({ ran: ["001-name-is-full-name", "002-fax-into-phone", "003-no-fax"], fresh: false, unknown: [] });
      expect(ran).toEqual(["001", "002", "003"]);
      expect(await people(await b.serve(h, after))).toEqual([
        { full_name: "Ada L", phone: "123", email: null },
        { full_name: "Bob", phone: "555", email: null },
      ]);
      // every version of a row was carried, not only the live one
      expect((await b.rows(h, "SELECT full_name FROM people ORDER BY valid_from")).map((r) => r.full_name)).toEqual(["Ada", "Bob", "Ada L"]);

      expect(await b.start(h, after, list)).toEqual({ ran: [], fresh: false, unknown: [] });
      expect(ran).toEqual(["001", "002", "003"]);
      const status = await b.status(h, list);
      expect(status.ran.map((r) => r.id)).toEqual(["001-name-is-full-name", "002-fax-into-phone", "003-no-fax"]);
      expect(status.pending).toEqual([]);
    }, SLOW);

    test("a fresh database and an upgraded one end with the same tables and columns: a new one records every migration and runs none", async () => {
      const upgraded = await b.open();
      await lived(b, upgraded);
      await b.start(upgraded, after, b.story([]));

      const fresh = await b.open();
      const ran: string[] = [];
      expect((await b.status(fresh, b.story(ran))).fresh).toBe(true);
      expect(await b.start(fresh, after, b.story(ran))).toEqual({ ran: [], fresh: true, unknown: [] });
      expect(ran).toEqual([]);
      expect((await b.status(fresh, b.story(ran))).pending).toEqual([]);

      for (const table of ["teams", "people"]) expect(await b.columns(fresh, table)).toEqual(await b.columns(upgraded, table));
      expect(await b.columns(fresh, "people")).toContain(name === "sqlite" ? "full_name:TEXT" : "full_name:text");
      expect(await b.views(fresh)).toEqual(await b.views(upgraded));
    }, SLOW);

    test("a migration that fails is rolled back, stops the start and is named; the ones before it stay, and the next start goes on from it", async () => {
      const h = await b.open();
      await lived(b, h);
      const list = [...b.story([]), b.failing()];
      await expect(b.start(h, after, list)).rejects.toThrow(/migration 004-breaks failed, and was rolled back/);
      expect((await b.status(h, list)).pending).toEqual(["004-breaks"]);
      expect((await b.rows(h, "SELECT phone FROM people WHERE valid_to IS NULL ORDER BY id")).map((r) => r.phone)).toEqual(["123", "555"]);
      expect(await b.start(h, after, b.story([]))).toEqual({ ran: [], fresh: false, unknown: [] });
    }, SLOW);

    test("an id recorded that the list no longer has is a warning, not an error", async () => {
      const h = await b.open();
      await lived(b, h);
      await b.start(h, after, b.story([]));
      expect(await b.start(h, after, b.story([]).slice(1))).toEqual({ ran: [], fresh: false, unknown: ["001-name-is-full-name"] });
      expect((await b.status(h, b.story([]).slice(1))).unknown).toEqual(["001-name-is-full-name"]);
    }, SLOW);

    test("undo never walks back across an upgrade: what was written before it answers nothing to undo, history still shows it, and a write after it undoes", async () => {
      const h = await b.open();
      const { adaPath } = await lived(b, h);
      await b.start(h, after, b.story([]));
      const v2 = await b.serve(h, after);
      await v2.call("open", { doc: "team:1" });

      const undo = await v2.call("undo", { cursor: "ada" });
      expect(undo.error).toBeUndefined();
      expect(undo.result).toBeNull();
      expect((await v2.call("redo", { cursor: "ada" })).result).toBeNull();
      const history = (await v2.call("history", { doc: "team:1" })).result;
      expect(history.length).toBe(3);
      expect(history.every((e: any) => e.undoable === false)).toBe(true);

      await v2.call("delta", { doc: "team:1", ops: [{ op: "replace", path: `${adaPath}/full_name`, value: "Ada Lovelace" }], cursor: "ada" });
      expect((await v2.call("undo", { cursor: "ada" })).error).toBeUndefined();
      expect((await people(v2))[0]).toMatchObject({ full_name: "Ada L" });
      expect((await v2.call("undo", { cursor: "ada" })).result).toBeNull();   // the fence
    }, SLOW);

    test("a table renamed keeps its rows, its history, its current view and its serial", async () => {
      const h = await b.open();
      await lived(b, h);
      const renamed = sqlite.defineSchema({
        teams: { columns: {}, temporal: false },
        members: { parent: "teams", columns: { name: "text", phone: "text?", fax: "text?" } },
      });
      const list: Migration[] = name === "sqlite"
        ? [{ id: "001-people-are-members", up: (db: Database) => sqlite.renameTable(db, "people", "members") }]
        : [{ id: "001-people-are-members", up: (tx: PoolClient) => pg.renameTable(tx, "people", "members") }];
      if (name === "sqlite") await b.start(h, renamed, list);
      else {
        await pg.migrate(h, list);
        await pg.applySql(h, pg.generateSql(renamed, [sqlite.defineDoc("team:", { root: "teams", include: ["members"], implied: true })]));
      }
      expect((await b.rows(h, "SELECT name FROM current_members ORDER BY id")).map((r) => r.name)).toEqual(["Ada L", "Bob"]);
      expect((await b.rows(h, "SELECT count(*) AS n FROM members")).map((r) => Number(r.n))).toEqual([3]);
      expect(await b.views(h)).toEqual(["current_members"]);
      // the next row follows on from the last, not from one
      const local = createLocal();
      const members = sqlite.defineDoc("team:", { root: "teams", include: ["members"], implied: true });
      if (name === "sqlite") sqlite.registerDocs(local.server, new Database(h), renamed, [members], []);
      else listeners.push(await pg.createDocListener(local.server, h, { types: [pg.docTypeFromDef(members, h)] }));
      await local.call("open", { doc: "team:1" });
      const added = await local.call("delta", { doc: "team:1", ops: [{ op: "add", path: "/members/-", value: { name: "Cy" } }] });
      expect(added.result.ack).toBe(true);
      expect((await b.rows(h, "SELECT name FROM current_members WHERE id = 3")).map((r) => r.name)).toEqual(["Cy"]);
    }, SLOW);

    test("two apps share a database: each has its own list, an id is one app's, and an app new to it runs none of its own", async () => {
      const h = await b.open();
      const chat = sqlite.defineSchema({ rooms: { table: "chat_rooms", columns: { title: "text" }, temporal: false } });
      const leave = sqlite.defineSchema({ requests: { table: "leave_requests", columns: { days: "integer" }, temporal: false } });
      await b.rows(h, "CREATE TABLE chat_rooms (id INT PRIMARY KEY, name TEXT)");
      const ran: string[] = [];
      const step = (app: string, id: string, sql: string): Migration => ({
        id,
        up: async (tx: any) => { ran.push(`${app} ${id}`); await (name === "sqlite" ? tx.run(sql) : tx.query(sql)); },
      });
      const chats = [step("chat", "001-x", "ALTER TABLE chat_rooms RENAME COLUMN name TO title")];
      const leaves = [step("leave", "001-x", "ALTER TABLE leave_requests RENAME COLUMN length TO days")];

      expect(await b.migrate(h, chats, { app: "chat", schema: chat })).toEqual({ ran: ["001-x"], fresh: false, unknown: [] });
      // leave is new here, though chat's tables are not: by its own schema, none of its tables are here
      expect((await b.status(h, leaves, { app: "leave" })).fresh).toBe(false);   // asked of the whole database, it would run, and fail
      expect(await b.migrate(h, leaves, { app: "leave", schema: leave })).toEqual({ ran: [], fresh: true, unknown: [] });
      expect(ran).toEqual(["chat 001-x"]);
      await b.rows(h, "CREATE TABLE leave_requests (id INT PRIMARY KEY, days INT)");

      // later, each app's next migration runs once, and neither app's list is the other's
      const more = [...leaves, step("leave", "002-y", "ALTER TABLE leave_requests ADD COLUMN reason TEXT")];
      expect(await b.migrate(h, more, { app: "leave", schema: leave })).toEqual({ ran: ["002-y"], fresh: false, unknown: [] });
      expect(await b.migrate(h, chats, { app: "chat", schema: chat })).toEqual({ ran: [], fresh: false, unknown: [] });
      expect((await b.status(h, more, { app: "leave", schema: leave })).ran.map((r) => r.id)).toEqual(["001-x", "002-y"]);
      expect((await b.status(h, chats, { app: "chat", schema: chat })).ran.map((r) => r.id)).toEqual(["001-x"]);
      expect((await b.status(h, [], { app: "nobody" })).ran).toEqual([]);
      expect(ran).toEqual(["chat 001-x", "leave 002-y"]);
    }, SLOW);

    test("tables made from the schema before the first start (init_db at first boot) are new: every migration recorded, none run; with rows, or another shape, they are lived in", async () => {
      const made = async (h: any) => {
        if (name === "sqlite") sqlite.createTables(new Database(h), after);
        else { await pg.applyFramework(h); await pg.applySql(h, pg.generateSql(after, [team])); }
      };
      const ran: string[] = [];
      const fresh = await b.open();
      await made(fresh);
      expect((await b.status(fresh, b.story(ran), { app: "team", schema: after })).fresh).toBe(true);
      expect(await b.migrate(fresh, b.story(ran), { app: "team", schema: after })).toEqual({ ran: [], fresh: true, unknown: [] });
      expect(ran).toEqual([]);

      // a row in them is data to keep: not new, so the list runs (and here, against tables already at its end, fails)
      const seeded = await b.open();
      await made(seeded);
      await b.rows(seeded, "INSERT INTO teams (id) VALUES (1)");
      expect((await b.status(seeded, b.story([]), { app: "team", schema: after })).fresh).toBe(false);
      await expect(b.migrate(seeded, b.story([]), { app: "team", schema: after })).rejects.toThrow(/001-name-is-full-name failed/);

      // an earlier version's tables, empty, are another shape: not new, and the list brings them to this one
      const older = await b.open();
      await b.start(older, before, []);
      await b.rows(older, "DELETE FROM delta_migrations");
      expect(await b.migrate(older, b.story(ran), { app: "team", schema: after })).toEqual({ ran: ["001-name-is-full-name", "002-fax-into-phone", "003-no-fax"], fresh: false, unknown: [] });
    }, SLOW);

    test("the fence is the migrating app's: another app on the database undoes on across it", async () => {
      const h = await b.open();
      await lived(b, h);   // the team app, on the ledger
      const notes = sqlite.defineSchema({ notes: { table: "other_notes", columns: { text: "text" }, temporal: false } });
      const note = sqlite.defineDoc("notes:", { root: "notes", include: [] });
      const other = createLocal();
      if (name === "sqlite") {
        const db = new Database(h);
        sqlite.createTables(db, notes);
        sqlite.registerDocs(other.server, db, notes, [note], [], { ledger: true });
      } else {
        await pg.applySql(h, pg.generateSql(notes, [note]));
        listeners.push(await pg.createDocListener(other.server, h, { types: [pg.docTypeFromDef(note, h)], ledger: true, schema: notes }));
      }
      await other.call("open", { doc: "notes:" });
      expect((await other.call("delta", { doc: "notes:", ops: [{ op: "add", path: "/notes/-", value: { text: "kept" } }], cursor: "cy" })).error).toBeUndefined();

      await b.migrate(h, b.story([]), { app: "team", schema: after });
      if (name === "sqlite") sqlite.migrateSchema(new Database(h), after);
      else await pg.applySql(h, pg.generateSql(after, [team]));
      const v2 = await b.serve(h, after);
      await v2.call("open", { doc: "team:1" });
      expect((await v2.call("undo", { cursor: "ada" })).result).toBeNull();   // the team's own: fenced
      const undone = await other.call("undo", { cursor: "cy" });             // the notes app's: not
      expect(undone.error).toBeUndefined();
      expect(undone.result.ops).toEqual([{ op: "remove", path: "/notes/1" }]);
    }, SLOW);

    test("migrations from a folder: each file's up, named by the file, in the files' order", async () => {
      const dir = tempDir();
      writeFileSync(join(dir, "002-second.ts"), `export const up = (tx) => { globalThis.__order.push("002"); };\n`);
      writeFileSync(join(dir, "001-first.ts"), `export async function up(tx) { globalThis.__order.push("001"); }\n`);
      writeFileSync(join(dir, "README.md"), "not a migration\n");
      const list = await (name === "sqlite" ? sqlite.fromFolder(dir) : pg.fromFolder(dir));
      expect(list.map((m) => m.id)).toEqual(["001-first", "002-second"]);
      (globalThis as any).__order = [];
      const h = await b.open();
      await lived(b, h);
      await b.start(h, before, list);
      expect((globalThis as any).__order).toEqual(["001", "002"]);
    }, SLOW);
  });
}

describe("the list", () => {
  test("is refused, before anything runs, when a migration has no id, no up, or a name twice", async () => {
    const db = new Database(":memory:");
    const up = () => {};
    await expect(sqlite.migrate(db, [{ id: "", up }])).rejects.toThrow(/has no id/);
    await expect(sqlite.migrate(db, [{ id: "001-x" } as any])).rejects.toThrow(/001-x has no up/);
    await expect(sqlite.migrate(db, [{ id: "001-x", up }, { id: "001-x", up }])).rejects.toThrow(/two migrations are named 001-x/);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'delta_migrations'").get()).toBeNull();
  });

  test("a file in the folder with no up is refused, by name", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "001-nothing.ts"), "export const down = () => {};\n");
    await expect(sqlite.fromFolder(dir)).rejects.toThrow(/001-nothing.ts exports no up/);
  });

  test("migrate runs outside a transaction (SQLite): each migration is its own", async () => {
    const db = new Database(":memory:");
    db.run("BEGIN");
    await expect(sqlite.migrate(db, [])).rejects.toThrow(/outside a transaction/);
    db.run("ROLLBACK");
  });
});

describe("the CLI: delta migrate", () => {
  const CLI = resolve(import.meta.dir, "..", "cli.ts");
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", CLI, "migrate", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out, err };
  };

  for (const kind of ["sqlite", "pglite"]) {
    test(`--status says what ran and what is pending; without it, runs what is pending (${kind})`, async () => {
      const dir = tempDir();
      const migrations = join(dir, "migrations");
      mkdirSync(migrations);
      writeFileSync(join(migrations, "001-add-notes.ts"), kind === "sqlite"
        ? `export const up = (db) => db.run("ALTER TABLE things ADD COLUMN notes TEXT");\n`
        : `export const up = async (tx) => { await tx.query("ALTER TABLE things ADD COLUMN notes TEXT"); };\n`);
      let target: string;
      if (kind === "sqlite") {
        target = join(dir, "app.db");
        new Database(target).run("CREATE TABLE things (id INT PRIMARY KEY)");
      } else {
        target = join(dir, "pgdata");
        const pool = await openPglite(target);
        await pool.query("CREATE TABLE things (id INT PRIMARY KEY)");
        await pool.end();
      }
      const status = await run(target, "--dir", migrations, "--status", "--json");
      expect([status.code, status.err]).toEqual([0, ""]);
      expect(JSON.parse(status.out)).toEqual({ fresh: false, ran: [], pending: ["001-add-notes"], unknown: [] });

      const migrated = await run(target, "--dir", migrations, "--json");
      expect([migrated.code, migrated.err]).toEqual([0, ""]);
      expect(JSON.parse(migrated.out)).toEqual({ ran: ["001-add-notes"], fresh: false, unknown: [] });

      const again = await run(target, "--dir", migrations, "--status");
      expect(again.code).toBe(0);
      expect(again.out).toContain("ran      001-add-notes");
      expect(again.out).not.toContain("pending");
      // another app's list, on the same database: its own records
      const other = await run(target, "--dir", migrations, "--app", "other", "--status", "--json");
      expect(JSON.parse(other.out)).toMatchObject({ ran: [], pending: ["001-add-notes"] });
    }, 30_000);
  }

  test("a database that is not there, or no database named, is a bad argument", async () => {
    expect((await run(join(tempDir(), "nope.db"))).code).toBe(2);
    expect((await run()).code).toBe(2);
  });
});
