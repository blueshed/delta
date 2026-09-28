/**
 * Two processes on one SQLite file (todo #1). Each serves the path's documents
 * over the same file; a write in one waits for the other's lock rather than
 * failing, and neither serves a copy of a document read before the other
 * wrote -- nor writes from one, overwriting the other's change.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables, importTables, registerDocs } from "../src/server/sqlite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { course, pathDocs, pathSchema, pathSeed, seat } from "./helpers/path";

setLogLevel("silent");

/** The other process, answering one command at a time. */
function otherProcess(file: string) {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/sqlite-process.ts"), file], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buffered = "";
  const next = async (): Promise<any> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error("the other process ended");
      buffered += new TextDecoder().decode(value);
    }
    const at = buffered.indexOf("\n");
    const line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return JSON.parse(line);
  };
  const send = (cmd: unknown) => { proc.stdin.write(`${JSON.stringify(cmd)}\n`); proc.stdin.flush(); return next(); };
  return {
    ready: next(),
    call: (action: string, msg: Record<string, unknown>) => send({ do: "call", action, msg }),
    hold: (ms: number, sql: string) => send({ do: "hold", ms, sql }),
    end: () => { proc.stdin.end(); proc.kill(); },
  };
}

let dir: string;
let file: string;
let db: Database;
let local: ReturnType<typeof createLocal>;
let other: ReturnType<typeof otherProcess>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "delta-processes-"));
  file = join(dir, "app.db");
  db = new Database(file);
  createTables(db, pathSchema);
  importTables(db, pathSchema, pathSeed);
  local = createLocal();
  registerDocs(local.server, db, pathSchema, pathDocs, [], { ledger: true });
  other = otherProcess(file);
  expect(await other.ready).toBe("ready");
});

afterEach(() => {
  other.end();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("two processes on one SQLite file", () => {
  test("a write waits while the other process holds the write lock, then lands over what the other wrote meanwhile: not a 500, and not over its copy", async () => {
    await local.call("open", { doc: "fo-seating:1" });
    expect(await other.hold(300, `UPDATE ${pathSchema.tables.seats!.name} SET table_no = 9 WHERE id = 1`)).toBe("held");
    const started = Date.now();
    const res = await local.call("delta", { doc: "fo-seating:1", ops: [{ op: "replace", path: "/seats/1/kept", value: false }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
    expect(res.error).toBeUndefined();
    expect(res.result.ops).toEqual([{ op: "replace", path: "/seats/1", value: seat(1, 9, false, { veg: true }) }]);
  });

  test("an undo waits for the lock and plans over what the other wrote meanwhile: a field it changed since is a conflict, not set back", async () => {
    await local.call("open", { doc: "fo-board:1" });
    expect((await local.call("delta", { doc: "fo-board:1", ops: [{ op: "replace", path: "/courses/1/name", value: "Broth" }], cursor: "s1" })).error).toBeUndefined();
    expect(await other.hold(300, `UPDATE ${pathSchema.tables.courses!.name} SET name = 'Bisque' WHERE id = 1`)).toBe("held");
    const undone = await local.call("undo", { cursor: "s1" });
    expect(undone.result.conflict).toEqual(["/courses/1"]);
    expect((await local.call("open", { doc: "fo-board:1" })).result.courses["1"]).toEqual(course(1, "Bisque"));
  });

  test("a document open here reads what the other process wrote, opened again or written through", async () => {
    await local.call("open", { doc: "fo-seating:1" });
    await local.call("open", { doc: "fo-all-courses:" });
    expect((await other.call("open", { doc: "fo-seating:1" })).error).toBeUndefined();
    expect((await other.call("delta", { doc: "fo-seating:1", ops: [{ op: "replace", path: "/seats/1/table_no", value: 5 }] })).error).toBeUndefined();
    expect((await other.call("open", { doc: "fo-all-courses:" })).error).toBeUndefined();
    expect((await other.call("delta", { doc: "fo-all-courses:", ops: [{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Fish" } }] })).error).toBeUndefined();
    // opened again here: the rows as the other left them, not the copy read before
    expect((await local.as("reader").call("open", { doc: "fo-all-courses:" })).result.courses).toEqual({ "1": course(1, "Soup"), "2": course(2, "Salad", 2), "3": course(3, "Fish") });
    // written through here: another field of the same row, and the other's change stays
    const kept = await local.call("delta", { doc: "fo-seating:1", ops: [{ op: "replace", path: "/seats/1/kept", value: false }] });
    expect(kept.result.ops).toEqual([{ op: "replace", path: "/seats/1", value: seat(1, 5, false, { veg: true }) }]);
    // the next serial follows the other's
    const added = await local.call("delta", { doc: "fo-all-courses:", ops: [{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Cheese" } }] });
    expect(added.result.ops[0].path).toBe("/courses/4");
    // and the other reads this one's
    expect((await other.call("open", { doc: "fo-seating:1" })).result.seats["1"]).toEqual(seat(1, 5, false, { veg: true }));
  });
});
