/**
 * The path's first place: a JSON file. The same schema and documents as every
 * other backend (tests/helpers/path.ts), their rows kept in one readable file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportTables, importTables, registerDocs } from "../src/server/json";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { course, pathCases, pathDocs, pathSchema, pathSeed, readAll, write, type PathBackend } from "./helpers/path";

setLogLevel("silent");

let dir: string;
let file: string;
let backend: PathBackend;

function open(): PathBackend & { persisted(): Promise<void> } {
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  const store = registerDocs(local.server, file, pathSchema, pathDocs, [], { ledger: true });
  return {
    process: { call: (action, msg) => local.call(action, msg), heard },
    quiet: async () => {}, // in-process: told before the write answers
    exportTables: async () => exportTables(file, pathSchema),
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
});
