/**
 * With auth, every document says who owns it: the shared cases
 * (tests/helpers/owns.ts) asked of SQLite and the JSON file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables, importTables, registerDocs, type CustomDocDef } from "../src/server/sqlite";
import * as json from "../src/server/json";
import { createWs } from "../src/server/server";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathDocs, pathSchema, pathSeed, sqliteInbox, sqliteMenuCard } from "./helpers/path";
import { auth, customOwns, mineDoc, ownsCases, whoamiDoc, type Me, type OwnsBackend } from "./helpers/owns";

setLogLevel("silent");

const custom = (which?: "owned" | "neither"): CustomDocDef<any, Me>[] => which === "neither" ? [sqliteInbox] : [
  { ...sqliteInbox, owns: customOwns.inbox },
  { ...sqliteMenuCard, owns: customOwns.menuCard },
  whoamiDoc((_db: any, _c: string, me?: Me) => ({ me: me?.id ?? null })),
  mineDoc((db: any, _c: string, me?: Me) => ({ households: db.query(`SELECT * FROM ${pathSchema.tables.households!.name} WHERE weddings_id = ?`).all(me?.id ?? null) })),
];

function over(register: (local: ReturnType<typeof createLocal>, opts: Parameters<OwnsBackend["start"]>[0]) => void): () => OwnsBackend {
  return () => ({
    async start(opts) {
      const local = createLocal();
      const heard: { channel: string; data: any }[] = [];
      local.onPublish((channel, data) => heard.push({ channel, data }));
      register(local, opts);
      return {
        as: (identity?: Me) => (identity ? local.as(identity) : local),
        backend: { process: { call: (action, msg) => local.call(action, msg), heard }, quiet: async () => {}, exportTables: async () => ({ tables: {} }) },
      };
    },
  });
}

describe("sqlite", () => ownsCases(over((local, opts) => {
  const db = new Database(":memory:");
  createTables(db, pathSchema);
  importTables(db, pathSchema, pathSeed);
  registerDocs(local.server, db, pathSchema, pathDocs, custom(opts.custom), { ledger: true, auth: opts.noAuth ? undefined : auth, owns: opts.owns, shared: opts.shared });
})));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("json", () => ownsCases(over((local, opts) => {
  const dir = mkdtempSync(join(tmpdir(), "delta-owns-"));
  dirs.push(dir);
  const file = join(dir, "data.json");
  json.importTables(file, pathSchema, pathSeed);
  json.registerDocs(local.server, file, pathSchema, pathDocs, custom(opts.custom), { ledger: true, auth: opts.noAuth ? undefined : auth, owns: opts.owns, shared: opts.shared });
})));

/**
 * Over sockets, where a broadcast reaches every socket subscribed to the name:
 * two identities on one membership name each hear only their own view's
 * changes -- one view's rows never reach the other's socket.
 */
describe("sqlite: two identities on one membership name, over sockets", () => {
  test("each socket hears its own view's change, and not the other's", async () => {
    const db = new Database(":memory:");
    createTables(db, pathSchema);
    importTables(db, pathSchema, pathSeed);
    const ws = createWs();
    const sockets: any[] = [];
    ws.setServer({ publish: (channel: string, raw: string) => { for (const s of sockets) if (s.subs.has(channel)) s.send(raw); } });
    registerDocs(ws, db, pathSchema, pathDocs, custom("owned"), { ledger: true, auth, owns: (me: Me, name: string) => name.endsWith(`:${me.id}`) || (me.id === 2 && name === "fo-household:3") });
    const socket = (identity: Me) => {
      const s = { data: { identity, clientId: `c${identity.id}` }, readyState: 1, subs: new Set<string>(), heard: [] as any[],
        subscribe(ch: string) { this.subs.add(ch); }, unsubscribe(ch: string) { this.subs.delete(ch); }, send(raw: string) { this.heard.push(JSON.parse(raw)); } };
      sockets.push(s);
      return s;
    };
    const ask = async (s: any, msg: Record<string, unknown>) => { await ws.websocket.message(s, JSON.stringify({ id: 1, ...msg })); return s.heard.pop(); };
    const adaSock = socket({ id: 1 });
    const bobSock = socket({ id: 2 });
    expect(Object.keys((await ask(adaSock, { action: "open", doc: "fo-mine:x" })).result.households)).toEqual(["1", "2"]);
    expect(Object.keys((await ask(bobSock, { action: "open", doc: "fo-mine:x" })).result.households)).toEqual(["3"]);
    expect((await ask(bobSock, { action: "open", doc: "fo-household:3" })).error).toBeUndefined();
    expect((await ask(bobSock, { action: "delta", doc: "fo-household:3", ops: [{ op: "replace", path: "/households/weddings_id", value: 1 }] })).error).toBeUndefined();
    const mine = (s: any) => s.heard.filter((m: any) => m.doc === "fo-mine:x").map((m: any) => m.ops);
    expect(mine(adaSock)).toEqual([[{ op: "add", path: "/households/3", value: { id: 3, weddings_id: 1, email: "c@x" } }]]);
    expect(mine(bobSock)).toEqual([[{ op: "remove", path: "/households/3" }]]);
  });
});
