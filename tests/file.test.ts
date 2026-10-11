/**
 * How the free-form document (`registerDoc`) and the JSON file (`./json`)
 * keep their file: a save is whole or not at all, survives a power cut (the
 * temp and its folder are synced), keeps the file's mode, writes through a
 * symlink to the real file, and a temp a crash left behind is cleared at start.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleTemps, writeFileAtomic, writeFileAtomicSync } from "../src/server/file";
import { createLocal } from "../src/server/local";
import { registerDoc } from "../src/server/server";
import { defineSchema, importTables, registerDocs } from "../src/server/json";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "delta-file-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mode = (f: string) => (statSync(f).mode & 0o777).toString(8);
const writers = [
  ["writeFileAtomic", (f: string, t: string) => writeFileAtomic(f, t)],
  ["writeFileAtomicSync", async (f: string, t: string) => writeFileAtomicSync(f, t)],
] as const;

describe("a save", () => {
  for (const [name, save] of writers) {
    test(`${name}: keeps the file's mode, and leaves only the file`, async () => {
      const f = join(dir, "a.json");
      writeFileSync(f, "{}");
      chmodSync(f, 0o600);
      await save(f, '{"x":1}');
      expect(mode(f)).toBe("600");
      expect(readdirSync(dir)).toEqual(["a.json"]);
      expect(readFileSync(f, "utf8")).toBe('{"x":1}');
    });

    test(`${name}: through a symlink writes the real file, and the link stays a link`, async () => {
      const real = join(dir, "real.json");
      const link = join(dir, "link.json");
      writeFileSync(real, "{}");
      symlinkSync(real, link);
      await save(link, '{"x":2}');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf8")).toBe('{"x":2}');
      expect(readdirSync(dir).sort()).toEqual(["link.json", "real.json"]);
    });

    test(`${name}: makes a file that is not there yet, and its folder`, async () => {
      const f = join(dir, "new", "a.json");
      await save(f, "{}");
      expect(readFileSync(f, "utf8")).toBe("{}");
    });
  }

  for (const [name, save] of writers) {
    test(`${name}: a rename that fails (onto a folder) leaves no temp behind`, async () => {
      const f = join(dir, "a.json");
      mkdirSync(f);   // a folder where the file goes: the rename fails
      let failed = false;
      try { await save(f, "{}"); } catch { failed = true; }
      expect(failed).toBe(true);
      expect(readdirSync(dir)).toEqual(["a.json"]);
    });
  }

  test("writeFileAtomic syncs the temp before the rename, and the folder after", async () => {
    const f = join(dir, "a.json");
    const probe = await open(dir, "r");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    const real = proto.sync;
    let syncs = 0;
    proto.sync = function (this: unknown) { syncs++; return real.call(this); };
    try {
      await writeFileAtomic(f, "{}");
    } finally {
      proto.sync = real;
    }
    expect(syncs).toBe(2);
  });

  test("writeFileAtomicSync syncs the temp before the rename, and the folder after", () => {
    const real = fs.fsyncSync;
    let syncs = 0;
    fs.fsyncSync = (fd: number) => { syncs++; return real(fd); };
    try {
      writeFileAtomicSync(join(dir, "a.json"), "{}");
    } finally {
      fs.fsyncSync = real;
    }
    expect(syncs).toBe(2);
  });
});

describe("a temp a crash left", () => {
  test("is cleared at start: the target's, of a process that is gone -- not another file's, nor a live process's", () => {
    const f = join(dir, "a.json");
    writeFileSync(f, "{}");
    const gone = 2 ** 22 + 7;   // past any pid in use
    for (const name of [`a.json.${gone}.1.tmp`, `a.json.${gone}.12.tmp`, `b.json.${gone}.1.tmp`, `a.json.${process.pid}.1.tmp`, "a.json.x.1.tmp"]) writeFileSync(join(dir, name), "{");
    clearStaleTemps(f);
    expect(readdirSync(dir).sort()).toEqual(["a.json", `a.json.${process.pid}.1.tmp`, "a.json.x.1.tmp", `b.json.${gone}.1.tmp`]);
  });

  test("a temp of a process still running (not this one) is kept", async () => {
    const f = join(dir, "a.json");
    writeFileSync(f, "{}");
    const child = Bun.spawn(["bun", "-e", "await Bun.sleep(10_000)"]);
    try {
      writeFileSync(join(dir, `a.json.${child.pid}.1.tmp`), "{");
      clearStaleTemps(f);
      expect(readdirSync(dir).sort()).toEqual(["a.json", `a.json.${child.pid}.1.tmp`]);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("registerDoc and the JSON file clear them when they start", async () => {
    const gone = 2 ** 22 + 7;
    writeFileSync(join(dir, `doc.json.${gone}.1.tmp`), "{");
    writeFileSync(join(dir, `data.json.${gone}.1.tmp`), "{");
    await registerDoc(createLocal().server, "doc", { file: join(dir, "doc.json"), empty: {} });
    registerDocs(createLocal().server, join(dir, "data.json"), defineSchema({}), []);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("the backends save so", () => {
  test("registerDoc keeps a 0600 file 0600, and writes through a symlink", async () => {
    const f = join(dir, "a.json");
    writeFileSync(f, '{"x":{}}');
    chmodSync(f, 0o600);
    const real = join(dir, "real.json");
    const link = join(dir, "link.json");
    writeFileSync(real, '{"x":{}}');
    symlinkSync(real, link);
    const local = createLocal();
    const a = await registerDoc(local.server, "a", { file: f, empty: { x: {} } as any });
    const l = await registerDoc(local.server, "l", { file: link, empty: { x: {} } as any });
    for (const doc of ["a", "l"]) await local.call("delta", { doc, ops: [{ op: "add", path: "/x/k", value: 1 }] });
    await Promise.all([a.persist(), l.persist()]);
    expect(mode(f)).toBe("600");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ x: { k: 1 } });
    expect(readdirSync(dir).sort()).toEqual(["a.json", "link.json", "real.json"]);
  });

  test("the JSON file's importTables saves the same way: mode kept, through a symlink, no temp left", () => {
    const real = join(dir, "real.json");
    const link = join(dir, "data.json");
    writeFileSync(real, "{}");
    chmodSync(real, 0o600);
    symlinkSync(real, link);
    importTables(link, defineSchema({}), { tables: { notes: [{ id: 1 }] }, sequences: { notes: 1 } });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(mode(real)).toBe("600");
    expect(JSON.parse(readFileSync(real, "utf8")).tables).toEqual({ notes: [{ id: 1 }] });
    expect(readdirSync(dir).sort()).toEqual(["data.json", "real.json"]);
  });
});

describe("a save that fails", () => {
  test("the JSON file: logged, never an unhandled rejection, and the next save writes the whole file", async () => {
    const schema = defineSchema({ notes: { columns: { text: "text" }, temporal: false } });
    const file = join(dir, "data.json");
    const local = createLocal();
    const store = registerDocs(local.server, file, schema, [{ prefix: "notes:", root: "notes", include: [], scope: {} }]);
    await local.call("open", { doc: "notes:" });
    const seen: unknown[] = [];
    const onReject = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onReject);
    try {
      chmodSync(dir, 0o500);   // no file may be made in it: the save fails
      await local.call("delta", { doc: "notes:", ops: [{ op: "add", path: "/notes/-", value: { text: "one" } }] });
      expect(store.persisted()).rejects.toThrow();
      await Bun.sleep(20);
      chmodSync(dir, 0o700);
      await local.call("delta", { doc: "notes:", ops: [{ op: "add", path: "/notes/-", value: { text: "two" } }] });
      await store.persisted();
    } finally {
      chmodSync(dir, 0o700);
      process.off("unhandledRejection", onReject);
    }
    expect(seen).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8")).tables.notes.map((n: any) => n.text)).toEqual(["one", "two"]);
  });
});
