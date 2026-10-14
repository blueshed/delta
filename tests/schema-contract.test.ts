/**
 * The schema is the contract (reference/migrations.md). delta sees only what
 * the schema declares: reads, writes, inverses and undo use the declared
 * columns (and the id, the parent key, a temporal row's validity). A database
 * may hold more -- a migration ahead of this version -- never less: at start-up
 * `migrate`, then `createTables` / `migrateSchema` (Postgres: `generateSql`),
 * make what is declared. So an upgrade can expand and contract with two
 * versions of the app on one database. On SQLite and Postgres in process.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Pool, PoolClient } from "pg";
import * as sqlite from "../src/server/sqlite";
import * as pg from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import type { Schema } from "../src/schema";
import type { Migration } from "../src/server/migrate";

setLogLevel("silent");
const SLOW = 30_000;

const team = sqlite.defineDoc("team:", { root: "teams", include: ["people"], implied: true });
const teams = { columns: {}, temporal: false } as const;
// the app, version by version: v2 adds an email beside the phone, v3 has only the email
const v1 = sqlite.defineSchema({ teams, people: { parent: "teams", columns: { name: "text", phone: "text?" } } });
const v2 = sqlite.defineSchema({ teams, people: { parent: "teams", columns: { name: "text", phone: "text?", email: { type: "text", default: "" } } } });
const v3 = sqlite.defineSchema({ teams, people: { parent: "teams", columns: { name: "text", email: { type: "text", default: "" } } } });

type Local = ReturnType<typeof createLocal>;
interface Backend<H> {
  open(): Promise<H>;
  /** A version's start-up: migrate, then make what its schema declares. */
  start(h: H, schema: Schema, list?: Migration[]): Promise<void>;
  /** Only the migrations, as `delta migrate` runs them, with the app still running. */
  migrate(h: H, list: Migration[]): Promise<void>;
  /** A process of a version, serving the team with the ledger. */
  serve(h: H, schema: Schema): Promise<Local>;
  sql(h: H, sql: string): Promise<any[]>;
  columns(h: H, table: string): Promise<string[]>;
  /** The expand: email, a NOT NULL column with a default, copied from the phone; the contract: the phone dropped. */
  expand: Migration;
  contract: Migration;
}

const dirs: string[] = [];
const pools: Pool[] = [];
const listeners: { destroy(): Promise<void> }[] = [];
afterAll(async () => {
  for (const l of listeners) await l.destroy();
  for (const p of pools) await p.end();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const onSqlite: Backend<string> = {
  async open() { const d = mkdtempSync(join(tmpdir(), "delta-contract-")); dirs.push(d); return join(d, "app.db"); },
  async start(file, schema, list = []) {
    const db = new Database(file);
    await sqlite.migrate(db, list);
    sqlite.createTables(db, schema);
    sqlite.migrateSchema(db, schema);
  },
  async migrate(file, list) { await sqlite.migrate(new Database(file), list); },
  async serve(file, schema) {
    const local = createLocal();
    sqlite.registerDocs(local.server, new Database(file), schema, [team], [], { ledger: true });
    return local;
  },
  async sql(file, sql) { return new Database(file).query(sql).all(); },
  async columns(file, table) { return (new Database(file).query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name).toSorted(); },
  expand: { id: "001-email", up: (db: Database) => { db.run("ALTER TABLE people ADD COLUMN email TEXT NOT NULL DEFAULT ''"); db.run("UPDATE people SET email = phone || '@sms' WHERE phone IS NOT NULL"); } },
  contract: { id: "002-no-phone", up: (db: Database) => sqlite.dropColumn(db, "people", "phone") },
};

const onPglite: Backend<Pool> = {
  async open() { const pool = await openPglite(); pools.push(pool); return pool; },
  async start(pool, schema, list = []) {
    await pg.migrate(pool, list);
    await pg.applyFramework(pool);
    await pg.applySql(pool, pg.generateSql(schema, [team]));
  },
  async migrate(pool, list) { await pg.migrate(pool, list); },
  async serve(pool, schema) {
    const local = createLocal();
    listeners.push(await pg.createDocListener(local.server, pool, { types: [pg.docTypeFromDef(team, pool)], ledger: true, schema }));
    return local;
  },
  async sql(pool, sql) { return (await pool.query(sql)).rows; },
  async columns(pool, table) {
    return (await pool.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1", [table])).rows.map((r) => r.c).toSorted();
  },
  expand: { id: "001-email", up: async (tx: PoolClient) => { await tx.query("ALTER TABLE people ADD COLUMN email TEXT NOT NULL DEFAULT ''"); await tx.query("UPDATE people SET email = phone || '@sms' WHERE phone IS NOT NULL"); } },
  contract: { id: "002-no-phone", up: (tx: PoolClient) => pg.dropColumn(tx, "people", "phone") },
};

/** The path of the newest row. */
const last3 = async (local: Local) => {
  const { result } = await local.call("open", { doc: "team:1" });
  return `/people/${Math.max(...Object.values(result.people as Record<string, any>).map((r) => r.id))}`;
};
const rows = async (local: Local) => {
  const { result } = await local.call("open", { doc: "team:1" });
  return Object.values(result.people as Record<string, any>).toSorted((a, b) => a.id - b.id).map(({ id: _i, teams_id: _t, ...row }) => row);
};
const write = async (local: Local, cursor: string, ops: any[]) => {
  const answer = await local.call("delta", { doc: "team:1", ops, cursor });
  expect(answer.error).toBeUndefined();
  return answer.result;
};

for (const [name, b] of [["sqlite", onSqlite], ["pglite", onPglite]] as [string, Backend<any>][]) {
  describe(name, () => {
    test("a column the schema does not declare is not seen: not read, not written, and a row removed and undone comes back", async () => {
      const h = await b.open();
      await b.start(h, v1);
      await b.sql(h, "ALTER TABLE people ADD COLUMN reason TEXT NOT NULL DEFAULT 'later'");   // a later version's, ahead of this one
      const app = await b.serve(h, v1);
      await app.call("open", { doc: "team:1" });
      const made = await write(app, "ada", [{ op: "add", path: "/people/-", value: { name: "Ada" } }]);
      expect(made.ops[0].value).not.toHaveProperty("reason");
      const path = made.ops[0].path;
      await write(app, "ada", [{ op: "replace", path: `${path}/name`, value: "Ada L" }]);
      const removed = await write(app, "ada", [{ op: "remove", path }]);
      expect(removed.inverse[0].value).not.toHaveProperty("reason");

      const undone = await app.call("undo", { cursor: "ada" });
      expect(undone.error).toBeUndefined();
      expect(await rows(app)).toEqual([{ name: "Ada L", phone: null }]);
      // never read, never written: the column took its own default, row and version alike
      expect((await b.sql(h, "SELECT reason FROM people")).map((r) => r.reason)).toEqual(["later", "later", "later"]);
    }, SLOW);

    test("a column the schema declares that the database does not have is added at start-up", async () => {
      const h = await b.open();
      await b.start(h, v1);
      const app = await b.serve(h, v1);
      await app.call("open", { doc: "team:1" });
      await write(app, "ada", [{ op: "add", path: "/people/-", value: { name: "Ada", phone: "555" } }]);

      await b.start(h, v2);   // v2 declares the email; no migration says so
      expect(await b.columns(h, "people")).toContain("email");
      const next = await b.serve(h, v2);
      expect(await rows(next)).toEqual([{ name: "Ada", phone: "555", email: "" }]);
      await next.call("open", { doc: "team:1" });
      await write(next, "ada", [{ op: "add", path: "/people/-", value: { name: "Bob", email: "bob@x" } }]);
      expect((await rows(next))[1]).toEqual({ name: "Bob", phone: null, email: "bob@x" });
    }, SLOW);

    test("expand, then contract: two versions on one database, every step keeps the data and each version's writes and undo work", async () => {
      const h = await b.open();
      await b.start(h, v1);
      const old = await b.serve(h, v1);
      await old.call("open", { doc: "team:1" });
      const ada = (await write(old, "ada", [{ op: "add", path: "/people/-", value: { name: "Ada", phone: "555" } }])).ops[0].path;

      // 1. expand: a migration adds the email while v1 runs, blind to it
      await b.migrate(h, [b.expand]);
      const bob = (await write(old, "bob", [{ op: "add", path: "/people/-", value: { name: "Bob" } }])).ops[0].path;   // NOT NULL: its default
      await write(old, "ada", [{ op: "replace", path: `${ada}/name`, value: "Ada L" }]);
      expect(await rows(old)).toEqual([{ name: "Ada L", phone: "555" }, { name: "Bob", phone: null }]);
      expect((await b.sql(h, "SELECT email FROM people WHERE valid_to IS NULL ORDER BY id")).map((r) => r.email)).toEqual(["555@sms", ""]);

      // 2. v2 starts beside v1 and uses the email; v1 writes on, and keeps what v2 wrote
      await b.start(h, v2, [b.expand]);
      const next = await b.serve(h, v2);
      await next.call("open", { doc: "team:1" });
      await write(next, "bob", [{ op: "replace", path: `${bob}/email`, value: "bob@x" }]);
      await write(old, "bob", [{ op: "replace", path: `${bob}/name`, value: "Robert" }]);
      expect(await rows(next)).toEqual([{ name: "Ada L", phone: "555", email: "555@sms" }, { name: "Robert", phone: null, email: "bob@x" }]);
      expect((await old.call("undo", { cursor: "bob" })).error).toBeUndefined();   // v1 undoes its own write; v2's email stays
      expect((await rows(next))[1]).toEqual({ name: "Bob", phone: null, email: "bob@x" });
      // v1 removes Bob and undoes it: the row comes back as it was stored, v2's email and all
      await write(old, "bob", [{ op: "remove", path: bob }]);
      const back = await old.call("undo", { cursor: "bob" });
      expect(back.error).toBeUndefined();
      expect(back.result.ops[0].value).not.toHaveProperty("email");   // what v1 is told is what v1 declares
      expect((await rows(next))[1]).toEqual({ name: "Bob", phone: null, email: "bob@x" });
      // v1 replaces Ada whole: the row is what v1 declares, and v2's email is not v1's to blank
      await write(old, "ada", [{ op: "replace", path: ada, value: { name: "Ada L", phone: "556" } }]);
      expect((await rows(next))[0]).toEqual({ name: "Ada L", phone: "556", email: "555@sms" });
      expect(await rows(old)).toEqual([{ name: "Ada L", phone: "556" }, { name: "Bob", phone: null }]);   // v1 never sees the email
      // v1 starts again beside v2 (a rollback begun): it makes what it declares, and v2 writes on, email and all
      await b.start(h, v1, [b.expand]);
      await write(next, "ada", [{ op: "replace", path: `${ada}/email`, value: "ada@x" }]);
      await write(next, "ada", [{ op: "add", path: "/people/-", value: { name: "Cy", email: "cy@x" } }]);
      expect((await rows(next)).slice(-1)).toEqual([{ name: "Cy", phone: null, email: "cy@x" }]);
      expect((await rows(old)).slice(-1)).toEqual([{ name: "Cy", phone: null }]);
      await write(next, "ada", [{ op: "remove", path: (await last3(next)) }]);

      // 3. contract: v1 is stopped, and with no running version declaring the phone, a migration drops it; v3 starts
      await b.start(h, v3, [b.expand, b.contract]);
      expect(await b.columns(h, "people")).not.toContain("phone");
      const last = await b.serve(h, v3);
      expect(await rows(last)).toEqual([{ name: "Ada L", email: "ada@x" }, { name: "Bob", email: "bob@x" }]);
      await last.call("open", { doc: "team:1" });
      expect((await last.call("undo", { cursor: "bob" })).result).toBeNull();   // nothing walks back across the contract
      await write(last, "ada", [{ op: "replace", path: `${ada}/email`, value: "ada@lovelace" }]);
      expect((await last.call("undo", { cursor: "ada" })).error).toBeUndefined();
      expect((await rows(last))[0]).toEqual({ name: "Ada L", email: "ada@x" });
    }, SLOW);
  });
}
