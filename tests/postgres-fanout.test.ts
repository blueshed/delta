/**
 * Fan-out on the Postgres backend: the two cases the SQLite backend got wrong
 * (tests/local.test.ts, "fan-out onto a document whose root is the row" and
 * "fan-out of rows whose parent comes in the same write"), asked of Postgres.
 *
 * Neither bug can arise here, because Postgres has no cross-document fan-out
 * for defined docs: delta_apply logs its broadcast ops against the document
 * written through, NOTIFY carries that name, and the listener publishes them on
 * that channel only. Another open document over the same rows is not told; it
 * reads the tables afresh on its next open (and on every reconnect). These
 * tests pin both halves: what the writer's channel carries, and that the other
 * document is silent live and right when read.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Pool } from "pg";
import {
  applySql,
  clearRegistry,
  createDocListener,
  defineDoc,
  defineSchema,
  docTypeFromDef,
  generateSql,
  registerDocType,
} from "../src/server/postgres";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { applyFramework, newPool, resetState, waitFor } from "./setup";

setLogLevel("silent");

const schema = defineSchema({
  weddings: { columns: { name: "text" }, temporal: false },
  households: { parent: "weddings", columns: { email: "text" }, temporal: false },
  courses: { parent: "weddings", columns: { name: "text" }, temporal: false },
  drinks: { parent: "courses", columns: { name: "text" }, temporal: false },
});
// One table seen two ways: a map of rows in the board, the root of a household's own document.
const board = defineDoc("board:", { root: "weddings", include: ["households", "courses", "drinks"] });
const household = defineDoc("household:", { root: "households", include: [] });
const menu = defineDoc("menu:", { root: "weddings", include: ["courses", "drinks"] });

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];

beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await pool.query("DROP TABLE IF EXISTS drinks, courses, households, weddings CASCADE");
  await applySql(pool, generateSql(schema, [board, household, menu]));
});

afterAll(async () => {
  await pool.query("DROP TABLE IF EXISTS drinks, courses, households, weddings CASCADE");
  await pool.query("DELETE FROM _delta_docs WHERE prefix IN ('board:', 'household:', 'menu:')");
  await pool.query("DELETE FROM _delta_collections WHERE collection_key IN ('weddings', 'households', 'courses', 'drinks')");
  await pool.end();
});

beforeEach(async () => {
  clearRegistry();
  await resetState(pool);
  await pool.query("TRUNCATE drinks, courses, households, weddings RESTART IDENTITY CASCADE");
  await pool.query("INSERT INTO weddings (id, name) VALUES (1, 'ours')");
  await pool.query("INSERT INTO households (id, weddings_id, email) VALUES (1, 1, 'a@x'), (2, 1, 'b@x')");
  for (const def of [board, household, menu]) registerDocType(docTypeFromDef(def, pool));
});

afterEach(async () => {
  for (const l of listeners.splice(0)) await l.destroy();
});

/** A process with the listener on it, and every broadcast it makes, by channel. */
async function setup(opts: Parameters<typeof createDocListener>[2] = {}) {
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  listeners.push(await createDocListener(local.server, pool, opts));
  const on = (channel: string) => heard.filter((h) => h.channel === channel).map((h) => h.data.ops);
  // The listener publishes after NOTIFY, so a channel's silence is only worth
  // checking once the writer's own channel has had its broadcast.
  const settled = (channel: string, count: number) => waitFor(() => on(channel).length >= count, { timeout: 3000 });
  return { local, on, settled };
}

describe("postgres: a row whose table is a map in one document and the root of another", () => {
  test("a row written through the board goes out on the board as the keyed row; the household is not told, and reads it as its root", async () => {
    const { local, on, settled } = await setup();
    await local.call("open", { doc: "board:1" });
    await local.call("open", { doc: "household:1" });
    const answer = await local.call("delta", {
      doc: "board:1",
      ops: [
        { op: "replace", path: "/households/1/email", value: "new@x" },
        { op: "replace", path: "/households/2/email", value: "other@x" },
      ],
    });
    expect(answer.error).toBeUndefined();
    await settled("board:1", 1);
    expect(on("board:1")).toEqual([[
      { op: "replace", path: "/households/1", value: { id: 1, weddings_id: 1, email: "new@x" } },
      { op: "replace", path: "/households/2", value: { id: 2, weddings_id: 1, email: "other@x" } },
    ]]);
    expect(on("household:1")).toEqual([]);
    const { result } = await local.call("open", { doc: "household:1" });
    expect(result.households).toEqual({ id: 1, weddings_id: 1, email: "new@x" });
  });

  test("the row taken out through the board: the household is not told, and no longer opens", async () => {
    const { local, on, settled } = await setup();
    await local.call("open", { doc: "board:1" });
    await local.call("open", { doc: "household:1" });
    await local.call("delta", { doc: "board:1", ops: [{ op: "remove", path: "/households/1" }] });
    await settled("board:1", 1);
    expect(on("board:1")).toEqual([[{ op: "remove", path: "/households/1" }]]);
    expect(on("household:1")).toEqual([]);
    expect((await local.call("open", { doc: "household:1" })).error?.code).toBe(404);
  });

  test("written through the household's own document, the row goes out there as its root, replaced whole", async () => {
    const { local, on, settled } = await setup();
    await local.call("open", { doc: "household:1" });
    await local.call("delta", { doc: "household:1", ops: [{ op: "replace", path: "/households/email", value: "mine@x" }] });
    await settled("household:1", 1);
    expect(on("household:1")).toEqual([[{ op: "replace", path: "/households", value: { id: 1, weddings_id: 1, email: "mine@x" } }]]);
  });
});

describe("postgres: rows whose parent comes in the same write", () => {
  const courseAndDrink = [
    { op: "add", path: "/courses/1", value: { name: "The toast" } },
    { op: "add", path: "/drinks/1", value: { courses_id: 1, name: "Champagne" } },
  ];

  test("a course and its drink, added in one write: the drink finds its course, both go out on the board; the menu is not told, and reads both", async () => {
    const { local, on, settled } = await setup();
    await local.call("open", { doc: "board:1" });
    await local.call("open", { doc: "menu:1" });
    const answer = await local.call("delta", { doc: "board:1", ops: courseAndDrink });
    expect(answer.error).toBeUndefined();
    await settled("board:1", 1);
    expect(on("board:1").flat().map((o: any) => o.path)).toEqual(["/courses/1", "/drinks/1"]);
    expect(on("menu:1")).toEqual([]);
    const { result } = await local.call("open", { doc: "menu:1" });
    expect(Object.keys(result.courses)).toEqual(["1"]);
    expect(result.drinks["1"]).toMatchObject({ courses_id: 1, name: "Champagne" });
  });

  test("an undo puts a dropped course back with its drink, course first", async () => {
    const { local, on, settled } = await setup({ ledger: true });
    await local.call("open", { doc: "board:1" });
    await local.call("delta", { doc: "board:1", ops: courseAndDrink, cursor: "s1" });
    await local.call("delta", { doc: "board:1", ops: [{ op: "remove", path: "/courses/1" }], cursor: "s1" });
    await settled("board:1", 2);
    expect(on("board:1")[1]!.map((o: any) => o.path)).toEqual(["/courses/1", "/drinks/1"]); // the cascade

    const undone = await local.call("undo", { cursor: "s1" });
    expect(undone.error).toBeUndefined();
    expect(undone.result.ops.map((o: any) => [o.op, o.path])).toEqual([["add", "/courses/1"], ["add", "/drinks/1"]]);
    await settled("board:1", 3);
    expect(on("board:1")[2]!.map((o: any) => [o.op, o.path])).toEqual([["add", "/courses/1"], ["add", "/drinks/1"]]);
    const { rows } = await pool.query("SELECT d.name FROM drinks d JOIN courses c ON c.id = d.courses_id");
    expect(rows).toEqual([{ name: "Champagne" }]);
  });
});
