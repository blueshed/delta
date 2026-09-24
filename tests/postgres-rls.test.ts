/**
 * RLS and the broadcast channel, enforced -- run as a NOSUPERUSER role.
 *
 * The suite's `delta` role is a superuser, so it has BYPASSRLS and a policy
 * never blocks it. These tests make their own role, `delta_rls` (no superuser,
 * no BYPASSRLS), and run every document query through it, so a policy here
 * really does filter what `open` reads.
 *
 * What they pin: a document's name is the channel its writes are broadcast on,
 * and RLS filters what `open` reads, not what that channel carries. So with
 * `auth`, `docTypeFromDef` refuses to register until it is told who owns a
 * document (`owns`) or that it is `shared`, and an identity that does not own
 * a name is answered 404 -- on open and on delta -- and never hears its writes.
 * These are the two round-1 repros (`rls-broadcast.ts`, `rls-ownname.ts`).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { Pool } from "pg";
import {
  applySql, generateSql, defineSchema, defineDoc,
  createDocListener, registerDocType, docTypeFromDef, clearRegistry,
} from "../src/server/postgres";
import type { DeltaAuth } from "../src/server/auth";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { PG_URL, newPool, applyFramework, mockClient, sendAndAwait, type MockClient } from "./setup";

setLogLevel("silent");

const ROLE = "delta_rls";

type Id = { id: number };
const auth: DeltaAuth<Id> = {
  gate: (c: any) => (c.data?.identity as Id | undefined) ?? { error: "Authentication required" },
  asSqlArg: (i) => i.id,
};

const schema = defineSchema({
  rls_items: { columns: { owner_id: "integer", name: "text" }, temporal: false },
});
const everyone = defineDoc("rls-all:", { root: "rls_items", include: [] });
const mine = defineDoc("rls-mine:", { root: "rls_items", include: [], scope: { owner_id: ":id" } });

let admin: Pool;
let app: Pool;

beforeAll(async () => {
  admin = await newPool();
  await applyFramework(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ROLE}';
    END IF; END $$;`);
  await admin.query("DROP TABLE IF EXISTS rls_items CASCADE; DROP SEQUENCE IF EXISTS seq_rls_items;");
  await applySql(admin, generateSql(schema, [everyone, mine]));
  await admin.query(`
    ALTER TABLE rls_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_items_owner ON rls_items;
    CREATE POLICY rls_items_owner ON rls_items FOR ALL
      USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
      WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
    GRANT USAGE ON SCHEMA public TO ${ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};
  `);
  const url = new URL(PG_URL);
  url.username = ROLE;
  url.password = ROLE;
  app = new Pool({ connectionString: url.href, max: 4 });
});

afterAll(async () => {
  await app.end();
  await admin.query("DROP TABLE IF EXISTS rls_items CASCADE; DROP SEQUENCE IF EXISTS seq_rls_items;");
  await admin.query("DELETE FROM _delta_docs WHERE prefix IN ('rls-all:', 'rls-mine:')");
  await admin.end();
});

let ws: WsServer;
let clients: MockClient[];
let listener: Awaited<ReturnType<typeof createDocListener>> | undefined;

beforeEach(async () => {
  clearRegistry();
  await admin.query("TRUNCATE rls_items RESTART IDENTITY; TRUNCATE _delta_ops_log RESTART IDENTITY; TRUNCATE _delta_versions;");
  // Bob already owns a row; Alice owns none.
  await admin.query("INSERT INTO rls_items (id, owner_id, name) VALUES (nextval('seq_rls_items'), 2, 'bob private')");
  clients = [];
  ws = createWs();
  ws.setServer({ publish: (ch: string, raw: string) => { for (const c of clients) if (c.subscriptions.has(ch)) c.send(raw); } });
  listener = undefined;
});

afterEach(async () => {
  await listener?.destroy();
});

const person = (id: number) => {
  const c = mockClient({ identity: { id }, clientId: `p${id}` });
  clients.push(c);
  return c;
};
const heard = (c: MockClient, doc: string) => c.sent.filter((m: any) => m.doc === doc && m.ops);
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("RLS and the broadcast channel (NOSUPERUSER role)", () => {
  test("the role really is held by the policy: unbound, it reads nothing", async () => {
    expect(Number((await admin.query("SELECT count(*) AS n FROM rls_items")).rows[0].n)).toBe(1);
    expect(Number((await app.query("SELECT count(*) AS n FROM rls_items")).rows[0].n)).toBe(0);
  });

  test("with auth, a document nobody said is owned or shared does not register", () => {
    expect(() => docTypeFromDef(everyone, app, { auth })).toThrow(/owns: \(identity, docName\) => boolean, or shared: true/);
  });

  test("a name several people may open is refused unless it says shared (rls-broadcast)", async () => {
    // The shape round 1 leaked through: one list doc, every identity opens it,
    // RLS filters each open. It no longer registers as it was written ...
    expect(() => registerDocType(docTypeFromDef(everyone, app, { auth }))).toThrow();
    // ... and a document that owns names per person closes it.
    registerDocType(docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` }));
    listener = await createDocListener(ws, app, { auth });
    const alice = person(1);
    const bob = person(2);
    expect((await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" })).result).toBeDefined();
    expect(Object.values((await sendAndAwait(ws, bob, { action: "open", doc: "rls-mine:2" })).result.rls_items).map((r: any) => r.name)).toEqual(["bob private"]);
    const w = await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice SECRET" } }] });
    expect(w.error).toBeUndefined();
    await settle();
    expect(JSON.stringify(heard(alice, "rls-mine:1"))).toContain("alice SECRET");
    expect(JSON.stringify(bob.sent)).not.toContain("alice SECRET");
  });

  test("Bob cannot open Alice's name, write through it, or hear it (rls-ownname)", async () => {
    registerDocType(docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` }));
    listener = await createDocListener(ws, app, { auth });
    const alice = person(1);
    const bob = person(2);
    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    const opened = await sendAndAwait(ws, bob, { action: "open", doc: "rls-mine:1" });
    expect(opened.error).toEqual({ code: 404, message: "Not found" });
    expect(bob.subscriptions.has("rls-mine:1")).toBe(false);
    const wrote = await sendAndAwait(ws, bob, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "bob forged" } }] });
    expect(wrote.error?.code).toBe(404);

    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice SECRET" } }] });
    await settle();
    expect(heard(alice, "rls-mine:1")).toHaveLength(1);
    expect(JSON.stringify(bob.sent)).not.toContain("alice SECRET");
  });

  test("an add's echo is the row as stored: the owner the scope fills in is the column's integer, so its undo is no conflict with itself", async () => {
    await admin.query("TRUNCATE _delta_ledger RESTART IDENTITY");
    registerDocType(docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` }));
    listener = await createDocListener(ws, app, { auth, ledger: true });
    const alice = person(1);
    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    const w = await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "a" } }] });
    expect(w.result.ops[0].value).toEqual({ id: expect.any(Number), owner_id: 1, name: "a" });   // "1", from the doc name, was told as it was
    const back = await sendAndAwait(ws, alice, { action: "undo" });
    expect(back.result.conflict).toBeUndefined();
    expect(back.result.ops).toHaveLength(1);
  });

  test("shared: true is the author saying every signed-in identity hears every write", async () => {
    registerDocType(docTypeFromDef(everyone, app, { auth, shared: true }));
    listener = await createDocListener(ws, app, { auth });
    const bob = person(2);
    expect((await sendAndAwait(ws, bob, { action: "open", doc: "rls-all:" })).result).toBeDefined();
  });
});
