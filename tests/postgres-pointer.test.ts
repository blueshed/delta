/**
 * One pointer grammar, two parsers: `splitPath` (src/core.ts, which
 * applyOps and dom-ops use) and `_delta_split_path` (001a, which delta_apply
 * uses) are run against the same vectors, so they cannot drift apart again.
 * Round 1 found the plpgsql one unescaped nothing, took slashless paths and
 * collapsed `//x`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import type { Pool } from "pg";
import { splitPath, joinPath } from "../src/core";
import { createDocListener, registerDocType, docTypeFromDef, defineDoc, clearRegistry } from "../src/server/postgres";
import { createWs } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework, applyItemsFixture, resetState, mockClient, sendAndAwait } from "./setup";

setLogLevel("silent");

/** pointer → its segments, or null when it is malformed. */
const VECTORS: [string, string[] | null][] = [
  ["", []],
  ["/", [""]],
  ["/items", ["items"]],
  ["/items/42/name", ["items", "42", "name"]],
  ["/items/007", ["items", "007"]],
  ["/a~1b/c~0d", ["a/b", "c~d"]],
  ["/~01", ["~1"]],
  ["/a//b", ["a", "", "b"]],
  ["/a/", ["a", ""]],
  ["//items", ["", "items"]],
  ["items", null],
  ["items/1", null],
  ["/a~2b", null],
  ["/a~", null],
];

let pool: Pool;

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await applyItemsFixture(pool);
});

afterAll(async () => {
  await pool.end();
});

const plpgsql = async (path: string): Promise<string[] | null> => {
  try {
    return (await pool.query("SELECT _delta_split_path($1) AS parts", [path])).rows[0].parts;
  } catch (err: any) {
    expect(err.code).toBe("22023");
    return null;
  }
};
const core = (path: string): string[] | null => {
  try { return splitPath(path); } catch { return null; }
};

describe("one pointer grammar", () => {
  for (const [path, segments] of VECTORS) {
    test(`${JSON.stringify(path)} → ${JSON.stringify(segments)} in core and in plpgsql`, async () => {
      expect(core(path)).toEqual(segments);
      expect(await plpgsql(path)).toEqual(segments);
    });
  }

  test("_delta_build_path escapes as joinPath does", async () => {
    const { rows } = await pool.query("SELECT _delta_build_path('a/b', 'c~d') AS p, _delta_build_path('x~y') AS q");
    expect(rows[0].p).toBe(joinPath("a/b", "c~d"));
    expect(rows[0].q).toBe(joinPath("x~y"));
  });
});

describe("delta_apply on the wire", () => {
  let ws: ReturnType<typeof createWs>;
  let listener: Awaited<ReturnType<typeof createDocListener>>;

  beforeEach(async () => {
    clearRegistry();
    await resetState(pool);
    registerDocType(docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool));
    ws = createWs();
    ws.setServer({ publish() {} });
    listener = await createDocListener(ws, pool);
  });

  const delta = async (ops: any[]) => {
    const r = await sendAndAwait(ws, mockClient(), { action: "delta", doc: "items:", ops });
    await listener.destroy();
    return r;
  };

  test("a path without a leading slash is a 400 that says so", async () => {
    const r = await delta([{ op: "remove", path: "items" }]);
    expect(r.error.code).toBe(400);
    expect(r.error.message).toContain('Invalid JSON Pointer "items"');
  });

  test("a row id that is not a number is a 400 that says to add to /coll/-", async () => {
    const r = await delta([{ op: "add", path: "/items/6f1c-uuid", value: { name: "x" } }]);
    expect(r.error.code).toBe(400);
    expect(r.error.message).toContain("add to /items/- and read the id from the echo");
  });

  test("//items is not /items: the empty first segment is a collection nobody has", async () => {
    const r = await delta([{ op: "add", path: "//items/-", value: { name: "x" } }]);
    expect(r.error.message).toContain("unknown collection");
    expect(Number((await pool.query("SELECT count(*) AS n FROM items")).rows[0].n)).toBe(0);
  });
});
