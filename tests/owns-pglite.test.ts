/**
 * With auth, every document says who owns it: the shared cases
 * (tests/helpers/owns.ts) asked of Postgres in process (PGlite).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, generateSql, importTables, registerDocType, type CustomDocDef,
} from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { defineDoc } from "../src/schema";
import { pathDocs, pathSchema, pathSeed, postgresInbox, postgresMenuCard } from "./helpers/path";
import { auth, customOwns, everyDoc, mineDoc, ownsCases, whoamiDoc, type Me } from "./helpers/owns";

setLogLevel("silent");

let pool: Pool;
const listeners: { destroy(): Promise<void> }[] = [];
const tables = Object.values(pathSchema.tables).map((t) => t.name);

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, pathDocs));
});
afterAll(async () => { await pool.end(); });
afterEach(async () => { for (const l of listeners.splice(0)) await l.destroy(); clearRegistry(); });

const custom = (which?: "owned" | "neither"): CustomDocDef<any, Me>[] => which === "neither" ? [postgresInbox] : [
  { ...postgresInbox, owns: customOwns.inbox },
  everyDoc(async (pool: any) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${pathSchema.tables.households!.name} h`)).rows.map((r: any) => r.row) })),
  { ...postgresMenuCard, owns: customOwns.menuCard },
  whoamiDoc(async (_pool: any, _c: string, me?: Me) => ({ me: me?.id ?? null })),
  mineDoc(async (pool: any, _c: string, me?: Me) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${pathSchema.tables.households!.name} h WHERE weddings_id = $1`, [me?.id ?? null])).rows.map((r: any) => r.row) })),
];

describe("pglite", () => ownsCases(() => ({
  async start(opts) {
    clearRegistry();
    await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
    await importTables(pool, pathSchema, pathSeed);
    const withAuth = opts.noAuth ? undefined : auth;
    for (const def of pathDocs) registerDocType(docTypeFromDef<Me>(def, pool, { auth: withAuth, owns: opts.owns, shared: opts.shared }));
    const local = createLocal();
    const heard: { channel: string; data: any; to?: { identity: unknown } }[] = [];
    local.onPublish((channel, data, to) => heard.push({ channel, data, to }));
    listeners.push(await createDocListener(local.server, pool, { auth: withAuth, ledger: true, custom: custom(opts.custom) }));
    return {
      as: (identity?: Me) => (identity ? local.as(identity) : local),
      backend: { process: { call: (action, msg) => local.call(action, msg), heard }, quiet: () => new Promise((r) => setTimeout(r, 100)), exportTables: async () => ({ tables: {} }) },
    };
  },
})));

describe("pglite: one prefix, one document (#76)", () => {
  test("two custom documents of one prefix, or one of a table document's, are refused, naming it", async () => {
    for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool));
    const listen = (custom: CustomDocDef<any, Me>[]) => createDocListener(createLocal().server, pool, { custom });
    await expect(listen([postgresInbox, { ...postgresInbox, matches: () => true }])).rejects.toThrow(/"fo-inbox:" names two documents/);
    await expect(listen([{ ...postgresInbox, prefix: "fo-board:" }])).rejects.toThrow(/"fo-board:" names two documents/);
  });

  test("a document type registered again (a hot reload) replaces the earlier: the latest answers", async () => {
    registerDocType(docTypeFromDef(pathDocs[0]!, pool));
    const again = { ...docTypeFromDef(pathDocs[0]!, pool), open: async () => ({ result: { again: true }, version: 0 }) };
    registerDocType(again);
    const local = createLocal();
    listeners.push(await createDocListener(local.server, pool, {}));
    expect((await local.call("open", { doc: "fo-board:1" })).result).toEqual({ again: true });
  });

  test("a document type of a running listener's custom document's prefix is refused, until it stops", async () => {
    const inbox = defineDoc(postgresInbox.prefix, { root: "households", include: [] });
    const listener = await createDocListener(createLocal().server, pool, { custom: [postgresInbox] });
    expect(() => registerDocType(docTypeFromDef(inbox, pool))).toThrow(/"fo-inbox:" names two documents/);
    await listener.destroy();
    registerDocType(docTypeFromDef(inbox, pool));
  });
});
