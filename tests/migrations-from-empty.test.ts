/**
 * Migrations as a history from empty (the Django way, todo #82), on SQLite: each migration a list of
 * changes every backend makes alike, folded into the tables the history leads to; the next one
 * written from what the definitions say beyond them; a new database made by running the history
 * from its first; one made the older way (from the schema at start-up) adopting it; and data moved
 * by an `up` beside a migration's changes.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addColumn, applyChange, createTable, diff, dropColumn, dropTable, renameColumn, renameTable, stateOf, writeMigration } from "../src/server/changes";
import { createTables, defineDoc, defineSchema, migrate, registerDocs, type Migration } from "../src/server/sqlite";
import { fromFolder } from "../src/server/migrate";
import { createLocal } from "../src/server/local";
import { migrationCases } from "../src/testing";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

const columnsOf = (db: Database, table: string) => (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

const v1: Migration<Database>[] = [
  { id: "001-people", changes: [createTable("people", { columns: { name: "text" }, temporal: false })] },
  { id: "002-posts", changes: [createTable("posts", { parent: "people", columns: { title: "text", body: "text?" }, temporal: false })] },
];
const schema = defineSchema({
  people: { columns: { name: "text" }, temporal: false },
  posts: { parent: "people", columns: { title: "text", body: "text?" }, temporal: false },
});

describe("the changes, folded", () => {
  test("are the tables the history leads to, as the definitions say them", () => {
    expect(stateOf(v1)).toEqual({
      people: { table: "people", columns: { name: { type: "text" } }, temporal: false },
      posts: { table: "posts", columns: { title: { type: "text" }, body: { type: "text", nullable: true } }, parent: { collection: "people", fk: "people_id" }, temporal: false },
    });
    expect(diff(stateOf(v1), schema)).toEqual({ changes: [], byHand: [] });
  });

  test("each renames, drops and adds as it says; one that names what is not there is refused", () => {
    let s = stateOf(v1);
    s = applyChange(s, renameColumn("posts", "body", "text"));
    s = applyChange(s, addColumn("people", "email", "text?"));
    s = applyChange(s, renameTable("posts", "notes"));
    expect(Object.keys(s.notes!.columns)).toEqual(["title", "text"]);
    expect(s.notes!.table).toBe("notes");
    s = applyChange(s, dropColumn("people", "email"));
    s = applyChange(s, dropTable("notes"));
    expect(Object.keys(s)).toEqual(["people"]);
    expect(() => applyChange(s, addColumn("nowhere", "x", "text"))).toThrow("has not made: nowhere");
    expect(() => applyChange(s, createTable("people", { columns: {} }))).toThrow("made already");
    expect(() => applyChange(s, dropColumn("people", "nothing"))).toThrow("no column nothing");
  });
});

describe("the next migration, from the definitions", () => {
  test("is what they say beyond the history, a rename said for a person to make, a type change left to them", () => {
    const more = defineSchema({
      people: { columns: { full_name: "text", email: "text?" }, temporal: false },
      posts: { parent: "people", columns: { title: "text", body: "text" }, temporal: false },
      tags: { columns: { label: "text" }, temporal: false },
    });
    const { changes, byHand } = diff(stateOf(v1), more);
    expect(changes).toEqual([
      addColumn("people", "full_name", "text"),
      addColumn("people", "email", "text?"),
      dropColumn("people", "name"),
      createTable("tags", { columns: { label: "text" }, temporal: false }),
    ]);
    expect(byHand).toEqual([
      'people: name gone and full_name, email new: if one is the other renamed, make it renameColumn (a drop loses its values)',
      'posts.body: {"type":"text"}, was {"type":"text","nullable":true}: an up()',
    ]);
  });

  test("written as a file, it loads as the migration it says, and leaves nothing more to make", async () => {
    const dir = mkdtempSync(join(tmpdir(), "make-"));
    try {
      const { changes, byHand } = diff({}, schema);
      writeFileSync(join(dir, "001-start.ts"), writeMigration(changes, byHand, join(import.meta.dir, "../src/server/changes.ts")));
      const list = await fromFolder(dir);
      expect(list.map((m) => m.id)).toEqual(["001-start"]);
      expect(diff(stateOf(list), schema)).toEqual({ changes: [], byHand: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// migrate, as every backend answers it (dzql's Postgres runs the same)
migrationCases("sqlite", {
  open: async () => new Database(":memory:"),
  migrate: (db, list, options) => migrate(db, list as Migration<Database>[], options),
  columns: async (db, table) => columnsOf(db, table),
  query: async (db, sql) => db.query(sql).all() as Record<string, unknown>[],
  makeTables: async (db, s) => createTables(db, s),
  run: async (tx, sql) => void (tx as Database).run(sql),
});

test("a database made from empty takes documents and writes, as one made from the schema", async () => {
  const db = new Database(":memory:");
  await migrate(db, v1, { schema });
  const local = createLocal();
  registerDocs(local.server, db, schema, [defineDoc("people:", { root: "people", include: [] })]);
  await local.call("open", { doc: "people:" });
  const added = await local.call("delta", { doc: "people:", ops: [{ op: "add", path: "/people/-", value: { name: "Ann" } }] });
  expect(added.error).toBeUndefined();
  expect(db.query("SELECT name FROM people").all()).toEqual([{ name: "Ann" }]);
});

test("delta migrations make: writes the next file from a module's schema, then nothing more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-make-"));
  try {
    const mod = join(dir, "schema.ts");
    writeFileSync(mod, `import { defineSchema } from ${JSON.stringify(join(import.meta.dir, "../src/schema.ts"))};\nexport const schema = defineSchema({ people: { columns: { name: "text" }, temporal: false } });\n`);
    const migrations = join(dir, "migrations");
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(["bun", join(import.meta.dir, "../cli.ts"), "migrations", "make", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, DELTA_MIGRATIONS_FROM: join(import.meta.dir, "../src/server/changes.ts") } });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      return { code, out, err };
    };
    const made = await run(mod, "--dir", migrations, "--name", "people");
    expect(made.code).toBe(0);
    expect(readdirSync(migrations)).toEqual(["001-people.ts"]);
    expect(diff(stateOf(await fromFolder(migrations)), defineSchema({ people: { columns: { name: "text" }, temporal: false } })).changes).toEqual([]);
    const again = await run(mod, "--dir", migrations);
    expect([again.code, again.out.trim()]).toEqual([0, "nothing to make: the migrations say what the definitions say"]);
    expect(readdirSync(migrations)).toEqual(["001-people.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
