/**
 * A document's owns as a path: the shared cases (src/cases/permissions.ts) asked of SQLite and the
 * JSON file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTables, importTables, registerDocs } from "../src/server/sqlite";
import * as json from "../src/server/json";
import { createLocal } from "../src/server/local";
import { createWs } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { permissionAuth, permissionCases, permissionDocs, permissionSchema, permissionSeed, type Person } from "@blueshed/delta/testing";

setLogLevel("silent");

const over = (register: (local: ReturnType<typeof createLocal>, docs: Parameters<typeof registerDocs>[3]) => void) => () => ({
  async start(docs: Parameters<typeof registerDocs>[3]) {
    const local = createLocal();
    register(local, docs);
    return { as: (person: Person) => local.as(person) };
  },
});

describe("sqlite", () => permissionCases("sqlite", over((local, docs) => {
  const db = new Database(":memory:");
  createTables(db, permissionSchema);
  importTables(db, permissionSchema, permissionSeed);
  registerDocs(local.server, db, permissionSchema, docs, [], { ledger: true, auth: permissionAuth });
})));

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("json", () => permissionCases("json", over((local, docs) => {
  const dir = mkdtempSync(join(tmpdir(), "delta-permissions-"));
  dirs.push(dir);
  const file = join(dir, "data.json");
  json.importTables(file, permissionSchema, permissionSeed);
  json.registerDocs(local.server, file, permissionSchema, docs, [], { ledger: true, auth: permissionAuth });
})));

/**
 * Over sockets: one whose path stops reaching them hears no more of the document -- let go at the
 * next change told, and told why, as a document's owns function does (owns-sqlite.test.ts).
 */
describe("sqlite: a path that stops reaching someone lets them go", () => {
  test("Ann's membership made inactive: the next write to the venue is not told to her, and she is told it is not there", async () => {
    const ws = createWs();
    const sockets: any[] = [];
    ws.setServer({ publish: (channel: string, raw: string) => { for (const s of sockets) if (s.subs.has(channel)) s.send(raw); } } as any);
    const db = new Database(":memory:");
    createTables(db, permissionSchema);
    importTables(db, permissionSchema, permissionSeed);
    registerDocs(ws, db, permissionSchema, Object.values(permissionDocs), [], { auth: permissionAuth });
    const socket = (identity: Person) => {
      const s = { data: { identity, clientId: `c${identity.id}` } as any, readyState: 1, subs: new Set<string>(), heard: [] as any[],
        subscribe(ch: string) { this.subs.add(ch); }, unsubscribe(ch: string) { this.subs.delete(ch); }, send(raw: string) { this.heard.push(JSON.parse(raw)); } };
      sockets.push(s);
      return s;
    };
    const ask = async (s: any, msg: Record<string, unknown>) => { await ws.websocket.message(s, JSON.stringify({ id: 1, ...msg })); return s.heard.pop(); };
    const [ann, ben] = [socket({ id: 1, name: "Ann" }), socket({ id: 2, name: "Ben" })];
    for (const s of [ann, ben]) expect((await ask(s, { action: "open", doc: "venue:1" })).error).toBeUndefined();
    expect((await ask(ben, { action: "open", doc: "members:" })).error).toBeUndefined();
    expect((await ask(ben, { action: "delta", doc: "members:", ops: [{ op: "replace", path: "/members/1/active", value: false }] })).error).toBeUndefined();
    expect((await ask(ben, { action: "delta", doc: "venue:1", ops: [{ op: "replace", path: "/venues/name", value: "New hall" }] })).error).toBeUndefined();
    expect(ann.heard).toEqual([{ doc: "venue:1", error: { code: 404, message: "Not found" } }]);
  });
});
