/**
 * With auth, every document says who owns it: the shared cases
 * (tests/helpers/owns.ts) asked of Postgres in process (PGlite).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, createDocListener, docTypeFromDef, generateSql, importTables, type CustomDocDef,
} from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { defineDoc, q } from "../src/schema";
import { pathDocs, pathSchema, pathSeed, postgresInbox, postgresMenuCard } from "./helpers/path";
import { auth, customOwns, everyDoc, mineDoc, ownsCases, whoamiDoc, type Me } from "./helpers/owns";

setLogLevel("silent");

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];
const tables = Object.values(pathSchema.tables).map((t) => q(t.name));

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, pathDocs));
});
afterAll(async () => { await pool.end(); });
afterEach(async () => { for (const l of listeners.splice(0)) await l.destroy(); });
const pathTypes = () => pathDocs.map((def) => docTypeFromDef(def, pool));

const custom = (which?: "owned" | "neither"): CustomDocDef<any, Me>[] => which === "neither" ? [postgresInbox] : [
  { ...postgresInbox, owns: customOwns.inbox },
  everyDoc(async (pool: any) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${pathSchema.tables.households!.name} h`)).rows.map((r: any) => r.row) })),
  { ...postgresMenuCard, owns: customOwns.menuCard },
  whoamiDoc(async (_pool: any, _c: string, me?: Me) => ({ me: me?.id ?? null })),
  mineDoc(async (pool: any, _c: string, me?: Me) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${pathSchema.tables.households!.name} h WHERE weddings_id = $1`, [me?.id ?? null])).rows.map((r: any) => r.row) })),
];

describe("pglite", () => ownsCases(() => ({
  async start(opts) {
    await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
    await importTables(pool, pathSchema, pathSeed);
    const withAuth = opts.noAuth ? undefined : auth;
    const types = pathDocs.map((def) => docTypeFromDef<Me>(def, pool, { auth: withAuth, owns: opts.owns, shared: opts.shared }));
    const local = createLocal();
    const heard: { channel: string; data: any; to?: { identity: unknown } }[] = [];
    local.onPublish((channel, data, to) => heard.push({ channel, data, to }));
    listeners.push(await createDocListener(local.server, pool, { types, auth: withAuth, ledger: true, custom: custom(opts.custom) }));
    return {
      as: (identity?: Me) => (identity ? local.as(identity) : local),
      backend: { process: { call: (action, msg) => local.call(action, msg), heard }, quiet: () => new Promise((r) => setTimeout(r, 100)), exportTables: async () => ({ tables: {} }) },
    };
  },
})));

describe("pglite: one prefix, one document (#76)", () => {
  test("two documents of one prefix are refused, naming it: two custom ones, a custom one of a table document's, two types", async () => {
    const listen = (custom: CustomDocDef<any, Me>[], types = pathTypes()) => createDocListener(createLocal().server, pool, { types, custom });
    await expect(listen([postgresInbox, { ...postgresInbox, matches: () => true }])).rejects.toThrow(/"fo-inbox:" names two documents/);
    await expect(listen([{ ...postgresInbox, prefix: "fo-board:" }])).rejects.toThrow(/"fo-board:" names two documents/);
    await expect(listen([], [...pathTypes(), docTypeFromDef(pathDocs[0]!, pool)])).rejects.toThrow(/"fo-board:" names two documents/);
  });

  test("the longest prefix answers, a custom document's or a table document's: a shorter custom one never answers for a table one", async () => {
    await pool.query(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY`);
    await importTables(pool, pathSchema, pathSeed);
    const local = createLocal();
    listeners.push(await createDocListener(local.server, pool, { types: pathTypes(), custom: [{ ...postgresInbox, prefix: "fo-b" }] }));
    expect((await local.call("open", { doc: "fo-board:1" })).result.weddings).toEqual({ id: 1, name: "ours" });
    expect((await local.call("open", { doc: "fo-bnobody" })).result.households).toEqual({});
  });

  test("a document type registered again (a hot reload) replaces the earlier: the latest answers", async () => {
    const local = createLocal();
    const listener = await createDocListener(local.server, pool, { types: [docTypeFromDef(pathDocs[0]!, pool)] });
    listeners.push(listener);
    listener.register({ ...docTypeFromDef(pathDocs[0]!, pool), open: async () => ({ result: { again: true }, version: 0 }) });
    expect((await local.call("open", { doc: "fo-board:1" })).result).toEqual({ again: true });
  });

  test("two servers in one process each answer for their own types", async () => {
    const one = createLocal();
    const two = createLocal();
    listeners.push(await createDocListener(one.server, pool, { types: [docTypeFromDef(pathDocs[0]!, pool)] }));
    listeners.push(await createDocListener(two.server, pool, { types: [{ ...docTypeFromDef(pathDocs[0]!, pool), open: async () => ({ result: { two: true }, version: 0 }) }] }));
    expect((await one.call("open", { doc: "fo-board:1" })).result.weddings).toEqual({ id: 1, name: "ours" });
    expect((await two.call("open", { doc: "fo-board:1" })).result).toEqual({ two: true });
  });

  test("a document type of the listener's custom document's prefix is refused", async () => {
    const listener = await createDocListener(createLocal().server, pool, { custom: [postgresInbox] });
    listeners.push(listener);
    expect(() => listener.register(docTypeFromDef(defineDoc(postgresInbox.prefix, { root: "households", include: [] }), pool))).toThrow(/"fo-inbox:" names two documents/);
  });
});
