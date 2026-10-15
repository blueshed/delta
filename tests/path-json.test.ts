/**
 * The path's first place: a JSON file. The same schema and documents as every
 * other backend (src/cases/path.ts), their rows kept in one readable file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDoc, defineSchema, exportTables, importTables, registerDocs } from "../src/server/json";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import {
  course, pathCases, pathDocs, pathPublicDocs, pathSchema, pathSeed, pathSpec, readAll, sqliteEmails, sqliteGuests, sqliteInbox, sqliteMenuCard, sqliteOpenSeats, write, type PathBackend,
} from "@blueshed/delta/testing";

setLogLevel("silent");

let dir: string;
let file: string;
let backend: PathBackend;

function open(): PathBackend & { persisted(): Promise<void> } {
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  const store = registerDocs(local.server, file, pathSchema, pathDocs, [sqliteInbox, sqliteOpenSeats, sqliteMenuCard, sqliteEmails, sqliteGuests], { ledger: true });
  registerDocs(local.server, file, pathSchema, pathPublicDocs);   // a second registration over the same file
  return {
    process: { call: (action, msg) => local.call(action, msg), heard },
    quiet: async () => {}, // in-process: told before the write answers
    exportTables: async () => { await store.persisted(); return exportTables(file, pathSchema); }, // the file as the last change left it
    persisted: () => store.persisted(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "delta-json-"));
  file = join(dir, "data.json");
  importTables(file, pathSchema, pathSeed);
  backend = open();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("json", () => {
  pathCases(() => backend);

  test("a scope key that is not a column of the root is refused at registration, as on SQLite and Postgres", () => {
    const bad = { prefix: "bad:", root: "courses", include: [], scope: { "courses.id": ":id" } };
    expect(() => registerDocs(createLocal().server, file, pathSchema, [bad])).toThrow('scope key "courses.id" is not a column of "courses"');
  });

  test("a save goes to a temp file renamed over the file, and leaves none behind; a file that is not JSON is refused at start, naming it", async () => {
    await backend.process.call("open", { doc: "fo-board:1" });
    for (let i = 0; i < 3; i++) await write(backend.process, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name: `c${i}` } }]);
    await (backend as ReturnType<typeof open>).persisted();
    expect(readdirSync(dir)).toEqual(["data.json"]);
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.slice(0, text.length / 2));   // a save cut short
    expect(() => open()).toThrow(`${file} is not JSON`);
  });

  test("the file is the truth: a write is in it, readable, and a process started on it reads what the last one left", async () => {
    await backend.process.call("open", { doc: "fo-board:1" });
    await write(backend.process, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name: "Fish" } }], { cursor: "s1" });
    await (backend as ReturnType<typeof open>).persisted();
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.tables.courses).toContainEqual(course(3, "Fish"));
    const before = await readAll(backend.process);
    const again = open();
    expect(await readAll(again.process)).toEqual(before);
    // the next row the new process names follows the last one the old named
    await again.process.call("open", { doc: "fo-board:1" });
    expect((await write(again.process, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name: "Cheese" } }])).ops[0].path).toBe("/courses/4");
  });

  test("a second registration of the file on a server takes its schema: one with a table it lacks, or one defined otherwise, is refused by name, the file left as it was; one with fewer of its tables, defined as it has them, shares its rows", async () => {
    const local = createLocal();
    registerDocs(local.server, file, pathSchema, [defineDoc("fo-board:", { root: "weddings", include: ["courses"] })]);
    const before = readFileSync(file, "utf8");
    const more = defineSchema({ ...pathSpec, rooms: { table: "fo_rooms", columns: { name: "text" }, temporal: false } });
    const other = defineSchema({ ...pathSpec, courses: { table: "fo_courses", parent: "weddings", columns: { name: "text", price: "real?" }, temporal: false } });
    for (const [schema, coll] of [[more, "rooms"], [other, "courses"]] as [typeof more, string][]) {
      expect(() => registerDocs(local.server, file, schema, [defineDoc(`fo-${coll}-x:`, { root: coll, include: [] })])).toThrow(`${file} is registered on this server with a schema whose "${coll}" is not this one's`);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
    // the weddings without what hangs from them would be defined otherwise: a removal through it would not cascade
    expect(() => registerDocs(local.server, file, defineSchema({ weddings: pathSpec.weddings! }), [defineDoc("fo-w:", { root: "weddings", include: [] })])).toThrow(`schema whose "weddings" is not this one's`);
    registerDocs(local.server, file, defineSchema({ tags: pathSpec.tags! }), [defineDoc("fo-few:", { root: "tags", include: [] })]);
    expect((await local.call("open", { doc: "fo-few:" })).result.tags).toEqual({ "1": { id: 1, label: "red" } });
  });

  test("the serials a refused write spent are in the file: a process started on it names the next row past them (review)", async () => {
    await backend.process.call("open", { doc: "fo-board:1" });
    const refused = await backend.process.call("delta", { doc: "fo-board:1", ops: [{ op: "add", path: "/courses/-", value: { name: "Fish" } }, { op: "remove", path: "/courses/99" }] });
    expect(refused.error?.code).toBe(404);
    await (backend as ReturnType<typeof open>).persisted();
    const again = open();
    await again.process.call("open", { doc: "fo-board:1" });
    expect((await write(again.process, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name: "Stew" } }])).ops[0].path).toBe("/courses/4");
  });

  test("a file that is not JSON is refused by name at the start, and left as it was", () => {
    for (const text of ["not json", "{", " "]) {
      writeFileSync(file, text);
      expect(() => open()).toThrow(file);
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  test("a newcomer's first file -- not there, 0 bytes, {} or any JSON with no tables -- opens as empty tables, takes a first write, and then holds it", async () => {
    const files = [["missing", () => rmSync(file)], ["0 bytes", () => writeFileSync(file, "")], ["{}", () => writeFileSync(file, "{}")], ["null", () => writeFileSync(file, "null")], ["[]", () => writeFileSync(file, "[]")]] as const;
    for (const [first, make] of files) {
      make();
      const fresh = open();
      expect({ first, open: (await fresh.process.call("open", { doc: "fo-weddings:" })).result }).toEqual({ first, open: { weddings: {}, courses: {}, _v: 0 } });
      // a course needs its wedding there first (404): a row is never added under a parent that is not
      expect((await fresh.process.call("delta", { doc: "fo-weddings:", ops: [{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Soup" } }] })).error?.code).toBe(404);
      await write(fresh.process, "fo-weddings:", [{ op: "add", path: "/weddings/-", value: { name: "ours" } }, { op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Soup" } }]);
      await fresh.persisted();
      const { weddings, courses } = JSON.parse(readFileSync(file, "utf8")).tables;
      expect({ first, weddings, courses }).toEqual({ first, weddings: [{ id: 1, name: "ours" }], courses: [course(2, "Soup")] });
    }
  });
});
