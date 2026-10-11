/**
 * Each kind registers on the same server: a memory document beside a Postgres
 * one (in process, PGlite), opened the same way. The Postgres listener answers
 * 404 for any name it does not own, so it registers last.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { applyFramework, applySql, clearRegistry, createDocListener, defineDoc, defineSchema, docTypeFromDef, generateSql, registerDocType } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { registerMemory } from "../src/server/kinds";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

const schema = defineSchema({ lists: { columns: { title: "text" }, temporal: false } });
const lists = defineDoc("lists:", { root: "lists", include: [] });

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(schema, [lists]));
});
afterAll(async () => { await pool.end(); });
afterEach(async () => { for (const l of listeners.splice(0)) await l.destroy(); clearRegistry(); });

async function serve(listenerFirst: boolean) {
  const local = createLocal();
  const memory = () => registerMemory(local.server, { prefix: "here:", empty: () => ({ people: {} }) });
  registerDocType(docTypeFromDef(lists, pool));
  if (!listenerFirst) memory();
  listeners.push(await createDocListener(local.server, pool));
  if (listenerFirst) memory();
  return local;
}

describe("a memory document and a Postgres one on one server", () => {
  test("memory registered first, the listener last: both names open", async () => {
    const local = await serve(false);
    expect((await local.call("open", { doc: "here:general" })).result).toEqual({ people: {}, _v: 0 });
    expect((await local.call("delta", { doc: "lists:", ops: [{ op: "add", path: "/lists/-", value: { title: "Shopping" } }] })).error).toBeUndefined();
    expect((await local.call("open", { doc: "lists:" })).result.lists).toEqual({ 1: { id: 1, title: "Shopping" } });
  });

  test("the listener registered first answers 404 for the memory document's name, as documented", async () => {
    const local = await serve(true);
    expect((await local.call("open", { doc: "here:general" })).error?.code).toBe(404);
    expect((await local.call("open", { doc: "lists:" })).error).toBeUndefined();
  });
});
