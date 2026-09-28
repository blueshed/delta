/**
 * With auth, every document says who owns it: the shared cases
 * (tests/helpers/owns.ts) asked of Postgres in process (PGlite).
 */
import { afterAll, afterEach, beforeAll, describe } from "bun:test";
import type { Pool } from "pg";
import {
  applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, generateSql, importTables, registerDocType, type CustomDocDef,
} from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathDocs, pathSchema, pathSeed, postgresInbox, postgresMenuCard } from "./helpers/path";
import { auth, customOwns, mineDoc, ownsCases, whoamiDoc, type Me } from "./helpers/owns";

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

const custom = (which?: "owned" | "neither"): CustomDocDef<any, Me>[] => [
  which === "neither" ? postgresInbox : { ...postgresInbox, owns: customOwns.inbox },
  { ...postgresMenuCard, owns: customOwns.menuCard },
  whoamiDoc(async (_pool: any, _c: string, me?: Me) => ({ me: me?.id ?? null })),
  mineDoc(async (pool: any, _c: string, me?: Me) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${pathSchema.tables.households!.name} h WHERE weddings_id = $1`, [me?.id ?? null])).rows.map((r: any) => r.row) })),
];

describe("pglite", () => ownsCases(() => ({
  async start(opts) {
    clearRegistry();
    await pool.query(`TRUNCATE ${tables.join(", ")}, _delta_versions, _delta_ops_log, _delta_ledger RESTART IDENTITY`);
    await importTables(pool, pathSchema, pathSeed);
    for (const def of pathDocs) registerDocType(docTypeFromDef<Me>(def, pool, { auth, owns: opts.owns, shared: opts.shared }));
    const local = createLocal();
    const heard: { channel: string; data: any }[] = [];
    local.onPublish((channel, data) => heard.push({ channel, data }));
    listeners.push(await createDocListener(local.server, pool, { auth, ledger: true, custom: custom(opts.custom) }));
    return {
      as: (identity?: Me) => (identity ? local.as(identity) : local),
      backend: { process: { call: (action, msg) => local.call(action, msg), heard }, quiet: () => new Promise((r) => setTimeout(r, 100)), exportTables: async () => ({ tables: {} }) },
    };
  },
})));
