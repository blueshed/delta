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
  applySql, generateSql, defineSchema, defineDoc, defineCustomDoc, withAppAuth,
  createDocListener, docTypeFromDef, type DocType,
} from "../src/server/postgres";
import type { DeltaAuth } from "../src/server/auth";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { applyOps } from "../src/core";
import { readFileSync } from "node:fs";
import { frameworkSqlFiles } from "../src/server/postgres";
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
  rls_notes: { columns: { owner_id: "integer", text: "text" }, temporal: true },
  // a board, its lists, and the cards on them: anyone may put a card on a list, which its board's owner then reads
  rls_boards: { columns: { owner_id: "integer" }, temporal: false },
  rls_lists: { parent: "rls_boards", columns: { owner_id: "integer" }, temporal: false },
  rls_cards: { parent: "rls_lists", columns: { author_id: "integer", text: "text" }, temporal: false },
});
const everyone = defineDoc("rls-all:", { root: "rls_items", include: [] });
const mine = defineDoc("rls-mine:", { root: "rls_items", include: [], scope: { owner_id: ":id" } });
const notes = defineDoc("rls-notes:", { root: "rls_notes", include: [] });
const board = defineDoc("rls-board:", { root: "rls_boards", include: ["rls_lists", "rls_cards"] });
const cardsBy = defineDoc("rls-cards-by:", { root: "rls_cards", include: [], scope: { author_id: ":id" } });
// one item, one note: there before their rows are, which a first write makes
const item = defineDoc("rls-item:", { root: "rls_items", include: [], implied: true });
const note = defineDoc("rls-note:", { root: "rls_notes", include: [], implied: true });

const TABLES = "rls_items, rls_notes, rls_boards, rls_lists, rls_cards";
const SEQUENCES = "seq_rls_items, seq_rls_notes, seq_rls_boards, seq_rls_lists, seq_rls_cards";

let admin: Pool;
let app: Pool;

beforeAll(async () => {
  admin = await newPool();
  await applyFramework(admin);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${ROLE}') THEN
      CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${ROLE}';
    END IF; END $$;`);
  await admin.query(`DROP TABLE IF EXISTS ${TABLES} CASCADE; DROP SEQUENCE IF EXISTS ${SEQUENCES};`);
  await applySql(admin, generateSql(schema, [everyone, mine, notes, board, cardsBy, item, note]));
  await admin.query(`
    ALTER TABLE rls_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_items FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_items_owner ON rls_items;
    CREATE POLICY rls_items_owner ON rls_items FOR ALL
      USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
      WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
    ALTER TABLE rls_notes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_notes FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_notes_owner ON rls_notes;
    CREATE POLICY rls_notes_owner ON rls_notes FOR ALL
      USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint)
      WITH CHECK (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
    ALTER TABLE rls_boards ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_boards FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_boards_owner ON rls_boards;
    CREATE POLICY rls_boards_owner ON rls_boards FOR ALL
      USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
    ALTER TABLE rls_lists ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_lists FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_lists_owner ON rls_lists;
    CREATE POLICY rls_lists_owner ON rls_lists FOR ALL
      USING (owner_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
    ALTER TABLE rls_cards ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_cards FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS rls_cards_seen ON rls_cards;
    CREATE POLICY rls_cards_seen ON rls_cards FOR ALL
      USING (author_id = NULLIF(current_setting('app.user_id', true), '')::bigint
             OR EXISTS (SELECT 1 FROM rls_lists l WHERE l.id = rls_lists_id))
      WITH CHECK (author_id = NULLIF(current_setting('app.user_id', true), '')::bigint);
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
  await admin.query(`DROP TABLE IF EXISTS ${TABLES} CASCADE; DROP SEQUENCE IF EXISTS ${SEQUENCES};`);
  await admin.query("DELETE FROM _delta_docs WHERE prefix IN ('rls-all:', 'rls-mine:', 'rls-notes:', 'rls-board:', 'rls-cards-by:', 'rls-item:', 'rls-note:')");
  await admin.end();
});

let ws: WsServer;
let clients: MockClient[];
let listener: Awaited<ReturnType<typeof createDocListener>> | undefined;

beforeEach(async () => {
  // delta's serials are not owned by their tables (RESTART IDENTITY leaves them): each test names ids anew (#71)
  await admin.query("TRUNCATE rls_items RESTART IDENTITY; ALTER SEQUENCE seq_rls_items RESTART; ALTER SEQUENCE seq_rls_notes RESTART; TRUNCATE _delta_ops_log RESTART IDENTITY; TRUNCATE _delta_versions;");
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

  test("a temporal table's rows are held by the policy too: its current_ view reads as the caller, not as its owner", async () => {
    await admin.query("TRUNCATE rls_notes; INSERT INTO rls_notes (id, owner_id, text) VALUES (nextval('seq_rls_notes'), 1, 'alice'), (nextval('seq_rls_notes'), 2, 'bob')");
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(notes, app, { auth, shared: true })], auth });
    const opened = await sendAndAwait(ws, person(1), { action: "open", doc: "rls-notes:" });
    expect(Object.values(opened.result.rls_notes).map((r: any) => r.text)).toEqual(["alice"]);
  });

  test("with auth, a document nobody said is owned or shared does not register", () => {
    expect(() => docTypeFromDef(everyone, app, { auth })).toThrow(/owns: \(identity, docName\) => boolean, or shared: true/);
  });

  test("a name several people may open is refused unless it says shared (rls-broadcast)", async () => {
    // The shape round 1 leaked through: one list doc, every identity opens it,
    // RLS filters each open. It no longer registers as it was written ...
    expect(() => docTypeFromDef(everyone, app, { auth })).toThrow();
    // ... and a document that owns names per person closes it.
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth });
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
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth });
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
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth, ledger: true });
    const alice = person(1);
    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    const w = await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "a" } }] });
    expect(w.result.ops[0].value).toEqual({ id: expect.any(Number), owner_id: 1, name: "a" });   // "1", from the doc name, was told as it was
    const back = await sendAndAwait(ws, alice, { action: "undo" });
    expect(back.result.conflict).toBeUndefined();
    expect(back.result.ops).toHaveLength(1);
  });

  test("an add that names an id moves the serial past it, with the documented grants (USAGE, SELECT on sequences) (#63)", async () => {
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth });
    const alice = person(1);
    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    expect((await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/7", value: { name: "named" } }] })).error).toBeUndefined();
    expect((await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "minted" } }] })).error).toBeUndefined();
    expect((await admin.query("SELECT id::int, name FROM rls_items WHERE owner_id = 1 ORDER BY id")).rows).toEqual([{ id: 7, name: "named" }, { id: 8, name: "minted" }]);
  });

  test("a writer cannot tell an id whose row RLS hides from one no row holds: an add of either is refused alike (409), told nothing, its version kept (#71)", async () => {
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(everyone, app, { auth, shared: true }), docTypeFromDef(notes, app, { auth, shared: true })], auth });
    const id = async (sql: string) => Number((await admin.query(sql)).rows[0].id);
    await admin.query("TRUNCATE rls_notes; INSERT INTO rls_notes (id, owner_id, text) VALUES (nextval('seq_rls_notes'), 2, 'bob')");
    const hidden = { rls_items: await id("SELECT id FROM rls_items WHERE owner_id = 2"), rls_notes: await id("SELECT id FROM rls_notes WHERE owner_id = 2") };
    // handed out by the serial, and no row holds it
    const spent = { rls_items: await id("SELECT nextval('seq_rls_items') AS id"), rls_notes: await id("SELECT nextval('seq_rls_notes') AS id") };
    const alice = person(1);
    const opened = { "rls-all:": (await sendAndAwait(ws, alice, { action: "open", doc: "rls-all:" })).result._v, "rls-notes:": (await sendAndAwait(ws, alice, { action: "open", doc: "rls-notes:" })).result._v };
    const add = async (doc: string, coll: "rls_items" | "rls_notes", n: number) => {
      const value = coll === "rls_items" ? { owner_id: 1, name: "mine" } : { owner_id: 1, text: "mine" };
      const res = await sendAndAwait(ws, alice, { action: "delta", doc, ops: [{ op: "add", path: `/${coll}/${n}`, value }] });
      return { code: res.error?.code, message: String(res.error?.message).replace(`/${coll}/${n}`, `/${coll}/<id>`) };
    };
    for (const [doc, coll] of [["rls-all:", "rls_items"], ["rls-notes:", "rls_notes"]] as const) {
      const refused = await add(doc, coll, hidden[coll]);
      expect(refused.code).toBe(409);
      expect(await add(doc, coll, spent[coll])).toEqual(refused);
    }
    await settle();
    expect([...heard(alice, "rls-all:"), ...heard(alice, "rls-notes:")]).toEqual([]);
    for (const doc of ["rls-all:", "rls-notes:"] as const) expect((await sendAndAwait(ws, alice, { action: "open", doc })).result._v).toBe(opened[doc]);
    // bob's rows as they were: no second live note under his id
    expect((await admin.query("SELECT owner_id::int FROM rls_notes WHERE valid_to IS NULL")).rows).toEqual([{ owner_id: 2 }]);
    // past the serial, an id is new
    expect((await sendAndAwait(ws, alice, { action: "delta", doc: "rls-all:", ops: [{ op: "add", path: `/rls_items/${spent.rls_items + 1}`, value: { owner_id: 1, name: "mine" } }] })).error).toBeUndefined();
  });

  test("an implied document named for a row RLS hides answers its first write as one named for an id no row holds (409), and makes no second live note (#71)", async () => {
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(item, app, { auth, shared: true }), docTypeFromDef(note, app, { auth, shared: true })], auth });
    const id = async (sql: string) => Number((await admin.query(sql)).rows[0].id);
    await admin.query("TRUNCATE rls_notes; INSERT INTO rls_notes (id, owner_id, text) VALUES (nextval('seq_rls_notes'), 2, 'bob')");
    const hidden = { "rls-item:": await id("SELECT id FROM rls_items WHERE owner_id = 2"), "rls-note:": await id("SELECT id FROM rls_notes WHERE owner_id = 2") };
    const spent = { "rls-item:": await id("SELECT nextval('seq_rls_items') AS id"), "rls-note:": await id("SELECT nextval('seq_rls_notes') AS id") };
    const alice = person(1);
    const first = async (prefix: "rls-item:" | "rls-note:", n: number) => {
      const doc = `${prefix}${n}`;
      await sendAndAwait(ws, alice, { action: "open", doc });
      const field = prefix === "rls-item:" ? "/rls_items/name" : "/rls_notes/text";
      const res = await sendAndAwait(ws, alice, { action: "delta", doc, ops: [{ op: "replace", path: field, value: "mine" }] });
      return { code: res.error?.code, message: String(res.error?.message).replace(`/${n} `, "/<id> ") };
    };
    for (const prefix of ["rls-item:", "rls-note:"] as const) {
      const refused = await first(prefix, hidden[prefix]);
      expect(refused.code).toBe(409);
      expect(await first(prefix, spent[prefix])).toEqual(refused);
    }
    expect((await admin.query("SELECT owner_id::int FROM rls_notes WHERE valid_to IS NULL")).rows).toEqual([{ owner_id: 2 }]);
    // (one past the serial is made, and the serial follows it: tests/helpers/path.ts; here the policy's
    // WITH CHECK refuses an empty root, whose owner is 0)
  });

  test("the serial helpers answer only a caller that may use the table: to a role with no privileges every id is taken, and the serial does not move (#71)", async () => {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'delta_rls_none') THEN CREATE ROLE delta_rls_none NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    const c = await admin.connect();
    const as = async (role: string, sql: string) => {
      await c.query("BEGIN");
      try {
        await c.query(`SET LOCAL ROLE ${role}`);
        return (await c.query(sql)).rows[0];
      } finally { await c.query("ROLLBACK"); }
    };
    try {
      const last = async () => Number((await admin.query("SELECT last_value FROM seq_rls_items")).rows[0].last_value);
      const was = await last();
      expect(await as(ROLE, "SELECT _delta_serial_new('rls_items', 1000) AS new")).toEqual({ new: true });
      expect(await as("delta_rls_none", "SELECT _delta_serial_new('rls_items', 1000) AS new")).toEqual({ new: false });
      await as("delta_rls_none", "SELECT _delta_serial_past('rls_items', 9007199254740991)");
      expect(await last()).toBe(was);
    } finally {
      c.release();
    }
  });

  test("a caller's temporary tables never stand in for delta's: one planted as _delta_collections and as a table the role cannot read reveals nothing of its serial, nor moves it", async () => {
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'delta_rls_none') THEN CREATE ROLE delta_rls_none NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    await admin.query("DROP TABLE IF EXISTS rls_secret; DROP SEQUENCE IF EXISTS seq_rls_secret; CREATE TABLE rls_secret (id BIGINT); CREATE SEQUENCE seq_rls_secret; SELECT setval('seq_rls_secret', 41)");
    const c = await admin.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE delta_rls_none");
      await c.query("CREATE TEMP TABLE _delta_collections (table_name TEXT); INSERT INTO _delta_collections VALUES ('rls_secret'); CREATE TEMP TABLE rls_secret (id BIGINT)");
      // as the owner, the real serial is past 41: a planted table must not make the role a reader of it
      expect((await c.query("SELECT _delta_serial_new('rls_secret', 42) AS new")).rows[0]).toEqual({ new: false });
      await c.query("SELECT _delta_serial_past('rls_secret', 9007199254740991)");
      await c.query("ROLLBACK");
      expect(Number((await admin.query("SELECT last_value FROM seq_rls_secret")).rows[0].last_value)).toBe(41);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
      await admin.query("DROP TABLE IF EXISTS rls_secret; DROP SEQUENCE IF EXISTS seq_rls_secret");
    }
  });

  test("every framework function that runs as its owner looks names up with pg_temp last", async () => {
    const { rows } = await admin.query(`SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND proname ~ '^_?delta_' ORDER BY proname`);
    expect(rows.map((r: any) => r.proname)).toEqual(expect.arrayContaining(["_delta_serial_new", "_delta_serial_past"]));
    for (const r of rows) {
      const path = (r.proconfig ?? []).find((c: string) => c.startsWith("search_path="));
      expect({ fn: r.proname, endsWithTemp: /, pg_temp$/.test(path ?? "") }).toEqual({ fn: r.proname, endsWithTemp: true });
    }
  });

  test("an undo is a write: once the identity no longer owns the document, its undo is a 404 too", async () => {
    await admin.query("TRUNCATE _delta_ledger RESTART IDENTITY");
    const members = new Set([1]);
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => members.has(who.id) && name === `rls-mine:${who.id}` })], auth, ledger: true });
    const alice = person(1);
    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice's" } }] });
    members.delete(1);   // taken off the document
    expect((await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [] })).error?.code).toBe(404);
    expect((await sendAndAwait(ws, alice, { action: "undo" })).error).toEqual({ code: 404, message: "Not found" });
    expect((await sendAndAwait(ws, alice, { action: "undo", dry: true })).error?.code).toBe(404);
    expect((await admin.query("SELECT name FROM rls_items WHERE owner_id = 1")).rows).toEqual([{ name: "alice's" }]);
    members.add(1);
    expect((await sendAndAwait(ws, alice, { action: "undo" })).result.ops).toEqual([{ op: "remove", path: expect.stringMatching(/^\/rls_items\/\d+$/) }]);
    expect((await admin.query("SELECT name FROM rls_items WHERE owner_id = 1")).rows).toEqual([]);
  });

  test("shared: true is the author saying every signed-in identity hears every write", async () => {
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(everyone, app, { auth, shared: true })], auth });
    const bob = person(2);
    expect((await sendAndAwait(ws, bob, { action: "open", doc: "rls-all:" })).result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Todo #18: the default-deny reaches every document the listener serves --
// custom documents (`defineCustomDoc`) and DocTypes written by hand, not only
// the ones `docTypeFromDef` makes -- and a membership document is queried,
// cached and fanned out per identity.
// ---------------------------------------------------------------------------

const rows = async (pool: typeof app, who: Id) =>
  withAppAuth(pool, who.id, async (db) => (await db.query("SELECT id::text, owner_id, name FROM rls_items ORDER BY id")).rows);

/** Every row the identity may read (RLS), and live, the rows written that are theirs. */
const bag = (owns: { owns: (who: Id, name: string) => boolean } | { shared: true }) =>
  defineCustomDoc<{ tag: string }, Id>("rls-bag:", {
    watch: ["rls_items"],
    parse: (tag) => ({ tag }),
    query: async (pool, _c, who) => ({ rls_items: await rows(pool, who!) }),
    matches: (_coll, row, _c, who) => row.owner_id === who?.id,
    ...owns,
  });

/** A whole-document view, recomputed as each identity. */
const tally = defineCustomDoc<{ tag: string }, Id>("rls-tally:", {
  watch: ["rls_items"],
  parse: (tag) => ({ tag }),
  recompute: async (pool, _c, who) => ({ n: (await rows(pool, who!)).length }),
  owns: (who, name) => name === `rls-tally:${who.id}`,
});

/** A DocType written by hand that says nothing about who owns it. */
const handWritten = (extra: Partial<DocType> = {}): DocType => ({
  prefix: "rls-raw:",
  parse: (name) => (name.startsWith("rls-raw:") ? {} : null),
  open: async () => ({ result: {}, version: 0 }),
  apply: async () => ({ version: 0 }),
  ...extra,
});

describe("with auth, every document says who owns it (todo #18)", () => {
  test("a custom document with neither owns nor shared is refused when the listener starts", async () => {
    const unowned = defineCustomDoc<{ tag: string }>("rls-bag:", { watch: ["rls_items"], parse: (tag) => ({ tag }), query: async () => ({}), matches: () => true });
    await expect(createDocListener(ws, app, { auth, custom: [unowned] })).rejects.toThrow(/rls-bag:.*owns.*shared: true/);
    const unownedRecompute = defineCustomDoc<{ tag: string }>("rls-tally:", { watch: ["rls_items"], parse: (tag) => ({ tag }), recompute: async () => ({}) });
    await expect(createDocListener(ws, app, { auth, custom: [unownedRecompute] })).rejects.toThrow(/rls-tally:/);
  });

  test("a DocType with neither owns nor shared is refused: given to the listener, or registered with it after", async () => {
    await expect(createDocListener(ws, app, { types: [handWritten()], auth })).rejects.toThrow(/rls-raw:.*owns.*shared: true/);
    // docTypeFromDef given no auth makes no owns either: the listener's auth is what counts
    await expect(createDocListener(ws, app, { types: [docTypeFromDef(mine, app)], auth })).rejects.toThrow(/rls-mine:/);
    const running = await createDocListener(ws, app, { auth });
    listener = running;
    expect(() => running.register(handWritten())).toThrow(/rls-raw:.*owns.*shared: true/);
    running.register(handWritten({ shared: true }));
    running.register(docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` }));
  });

  test("a listener without auth takes a DocType with no owner, beside one with auth in the same process", async () => {
    listener = await createDocListener(ws, app, { auth });
    const open = await createDocListener(createWs(), app, { types: [handWritten()] });
    await open.destroy();
  });

  test("a custom document's owns is asked on open: a name the identity does not own is a 404, and never subscribed", async () => {
    listener = await createDocListener(ws, app, { auth, custom: [bag({ owns: (who, name) => name === `rls-bag:${who.id}` }), tally] });
    const alice = person(1);
    const bob = person(2);
    for (const doc of ["rls-bag:1", "rls-tally:1"]) {
      expect((await sendAndAwait(ws, bob, { action: "open", doc })).error).toEqual({ code: 404, message: "Not found" });
      expect(bob.subscriptions.has(doc)).toBe(false);
      expect((await sendAndAwait(ws, alice, { action: "open", doc })).result).toBeDefined();
    }
    expect((await sendAndAwait(ws, bob, { action: "open", doc: "rls-tally:2" })).result).toEqual({ n: 1 });
    // the one identity on the name hears its rows on the name's channel
    listener.register(docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` }));
    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice SECRET" } }] });
    await settle();
    expect(heard(alice, "rls-bag:1")).toEqual([{ doc: "rls-bag:1", ops: [{ op: "add", path: expect.stringMatching(/^\/rls_items\/\d+$/), value: expect.objectContaining({ name: "alice SECRET" }) }] }]);
    expect(heard(alice, "rls-tally:1").at(-1).ops).toEqual([{ op: "replace", path: "", value: { n: 1 } }]);
    expect(JSON.stringify(bob.sent)).not.toContain("alice SECRET");
  });

  test("a membership document is queried as each identity: one identity's rows are never served to another from the cache, nor fanned out to it", async () => {
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth, custom: [bag({ shared: true })] });
    const alice = person(1);
    const bob = person(2);
    // Bob first: his view of the name must not become Alice's
    const bobs = await sendAndAwait(ws, bob, { action: "open", doc: "rls-bag:all" });
    expect(Object.values(bobs.result.rls_items).map((r: any) => r.name)).toEqual(["bob private"]);
    const alices = await sendAndAwait(ws, alice, { action: "open", doc: "rls-bag:all" });
    expect(alices.result.rls_items).toEqual({});

    await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:1" });
    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice SECRET" } }] });
    await settle();
    expect(JSON.stringify(heard(alice, "rls-bag:all"))).toContain("alice SECRET");
    expect(JSON.stringify(bob.sent)).not.toContain("alice SECRET");
    expect(heard(alice, "rls-bag:all")).toHaveLength(1);   // once, not once per view
  });
});

// ---------------------------------------------------------------------------
// Todo #17: a socket hears a document while it may open it. `owns` and the
// gate are asked at open and at every request, and again before a change is
// told: one taken off a document, or whose session ran out, hears no more of
// it, though it asks for nothing.
// ---------------------------------------------------------------------------

describe("a socket hears a document while it may open it (todo #17)", () => {
  test("taken off a document it has open, it hears no more of it, and is let go of it: its next open is a 404", async () => {
    const members = new Map([["rls-mine:2", new Set([1, 2])]]);
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => members.get(name)?.has(who.id) ?? false })], auth });
    const alice = person(1);
    const bob = person(2);
    for (const c of [alice, bob]) expect((await sendAndAwait(ws, c, { action: "open", doc: "rls-mine:2" })).result).toBeDefined();
    members.get("rls-mine:2")!.delete(1);   // Alice is taken off Bob's document
    const w = await sendAndAwait(ws, bob, { action: "delta", doc: "rls-mine:2", ops: [{ op: "add", path: "/rls_items/-", value: { name: "bob after" } }] });
    expect(w.error).toBeUndefined();
    await settle();
    expect(heard(bob, "rls-mine:2")).toHaveLength(1);
    expect(JSON.stringify(alice.sent)).not.toContain("bob after");
    expect(alice.subscriptions.has("rls-mine:2")).toBe(false);
    // and she is told so, for the client to open it again (and find it not there) or let it go
    expect(alice.sent.filter((m: any) => m.doc === "rls-mine:2" && m.error)).toEqual([{ doc: "rls-mine:2", error: { code: 404, message: "Not found" } }]);
    expect((await sendAndAwait(ws, alice, { action: "open", doc: "rls-mine:2" })).error).toEqual({ code: 404, message: "Not found" });
  });

  test("a socket whose session ran out hears nothing more, though it asks for nothing; the same person's other socket still hears", async () => {
    const expiring: DeltaAuth<Id> = {
      gate: (c: any) => {
        const who = c.data?.identity as Id | undefined;
        if (!who) return { error: "Authentication required" };
        return c.data.until !== undefined && Date.now() >= c.data.until ? { error: "Session expired" } : who;
      },
      asSqlArg: (i) => i.id,
    };
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth: expiring, owns: (who, name) => name === `rls-mine:${who.id}` })], auth: expiring });
    const stale = person(1);
    const fresh = person(1);
    for (const c of [stale, fresh]) await sendAndAwait(ws, c, { action: "open", doc: "rls-mine:1" });
    stale.data.until = Date.now() - 1;   // its token ran out
    await sendAndAwait(ws, fresh, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "alice later" } }] });
    await settle();
    expect(heard(fresh, "rls-mine:1")).toHaveLength(1);
    expect(heard(stale, "rls-mine:1")).toEqual([]);
    expect(stale.subscriptions.has("rls-mine:1")).toBe(false);
    // told why: a 401, for the client to sign in again (its connection runs onConnect afresh)
    expect(stale.sent.filter((m: any) => m.error)).toEqual([{ doc: "rls-mine:1", error: { code: 401, message: "Session expired" } }]);
  });

  test("a gate that throws for one socket refuses that socket alone: the others still hear every write", async () => {
    const fragile: DeltaAuth<Id> = {
      gate: (c: any) => {
        if (c.data?.explode) throw new Error("gate exploded");
        return (c.data?.identity as Id | undefined) ?? { error: "Authentication required" };
      },
      asSqlArg: (i) => i.id,
    };
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth: fragile, owns: (who, name) => name === `rls-mine:${who.id}` })], auth: fragile });
    const tab = person(1);
    const broken = person(1);
    for (const c of [tab, broken]) await sendAndAwait(ws, c, { action: "open", doc: "rls-mine:1" });
    broken.data.explode = true;
    for (const name of ["one", "two"]) {
      await sendAndAwait(ws, tab, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name } }] });
      await settle();
    }
    expect(heard(tab, "rls-mine:1")).toHaveLength(2);
    expect(heard(broken, "rls-mine:1")).toEqual([]);
    expect(broken.subscriptions.has("rls-mine:1")).toBe(false);
    expect(broken.sent.filter((m: any) => m.error)).toEqual([{ doc: "rls-mine:1", error: { code: 401, message: "Authentication failed" } }]);
  });

  test("a custom document too: taken off a membership view or a recompute one, a socket hears no more of it", async () => {
    const members = new Map([["rls-bag:team", new Set([1])], ["rls-tally:team", new Set([1])]]);
    const owns = (who: Id, name: string) => members.get(name)?.has(who.id) ?? false;
    const teamTally = defineCustomDoc<{ tag: string }, Id>("rls-tally:", {
      watch: ["rls_items"],
      parse: (tag) => ({ tag }),
      recompute: async (pool, _c, who) => ({ n: (await rows(pool, who!)).length }),
      owns,
    });
    listener = await createDocListener(ws, app, { types: [docTypeFromDef(mine, app, { auth, owns: (who, name) => name === `rls-mine:${who.id}` })], auth, custom: [bag({ owns }), teamTally] });
    const alice = person(1);
    for (const doc of ["rls-bag:team", "rls-tally:team", "rls-mine:1"]) expect((await sendAndAwait(ws, alice, { action: "open", doc })).result).toBeDefined();
    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "while on" } }] });
    await settle();
    expect(heard(alice, "rls-bag:team")).toHaveLength(1);
    expect(heard(alice, "rls-tally:team")).toHaveLength(1);
    members.get("rls-bag:team")!.delete(1);
    members.get("rls-tally:team")!.delete(1);
    await sendAndAwait(ws, alice, { action: "delta", doc: "rls-mine:1", ops: [{ op: "add", path: "/rls_items/-", value: { name: "once off" } }] });
    await settle();
    expect(heard(alice, "rls-mine:1")).toHaveLength(2);
    expect(heard(alice, "rls-bag:team")).toHaveLength(1);
    expect(heard(alice, "rls-tally:team")).toHaveLength(1);
    expect(alice.subscriptions.has("rls-bag:team")).toBe(false);
    expect(alice.subscriptions.has("rls-tally:team")).toBe(false);
    expect(alice.sent.filter((m: any) => m.error).map((m: any) => [m.doc, m.error.code]).sort()).toEqual([["rls-bag:team", 404], ["rls-tally:team", 404]]);
  });
});

describe("who is told is worked out whatever the writer may read (todo #33)", () => {
  test("bob's card on alice's list is told to alice's board, though bob cannot see the list; his card on his own list is not", async () => {
    await admin.query(`TRUNCATE rls_boards, rls_lists, rls_cards RESTART IDENTITY;
      INSERT INTO rls_boards (id, owner_id) VALUES (1, 1), (2, 2);
      INSERT INTO rls_lists (id, rls_boards_id, owner_id) VALUES (1, 1, 1), (2, 2, 2);`);
    listener = await createDocListener(ws, app, { auth, types: [
      docTypeFromDef(board, app, { auth, owns: (who, name) => name === `rls-board:${who.id}` }),
      docTypeFromDef(cardsBy, app, { auth, owns: (who, name) => name === `rls-cards-by:${who.id}` }),
    ] });
    const alice = person(1);
    const bob = person(2);
    const open = async () => {
      const { _v, ...doc } = (await sendAndAwait(ws, alice, { action: "open", doc: "rls-board:1" })).result;
      return doc;
    };
    const copy = await open();
    for (const [list, text] of [[1, "for alice"], [2, "bob's own"]] as const) {
      const w = await sendAndAwait(ws, bob, { action: "delta", doc: "rls-cards-by:2", ops: [{ op: "add", path: "/rls_cards/-", value: { rls_lists_id: list, text } }] });
      expect(w.error).toBeUndefined();
    }
    await settle();
    // her copy, with what she was told, is what she reads afresh: bob's card on her list, and nothing she cannot read
    for (const m of heard(alice, "rls-board:1")) applyOps(copy, m.ops);
    const fresh = await open();
    expect(copy).toEqual(fresh);
    expect(Object.values(fresh.rls_cards).map((c: any) => c.text)).toEqual(["for alice"]);
    expect(JSON.stringify(alice.sent)).not.toContain("bob's own");
  });
});

describe("the framework's SECURITY DEFINER functions cannot be led astray", () => {
  test("each searches the path it was applied with, and pg_temp last", async () => {
    // the functions the framework SQL makes, as the database has them
    const made = frameworkSqlFiles().flatMap((f) => [...readFileSync(f, "utf8").matchAll(/CREATE (?:OR REPLACE )?FUNCTION (\w+)/g)].map((m) => m[1]!));
    const { rows } = await admin.query(`SELECT DISTINCT proname, proconfig FROM pg_proc
      WHERE prosecdef AND pronamespace = current_schema()::regnamespace AND proname = ANY($1) ORDER BY proname`, [made]);
    expect(rows.map((r: any) => r.proname)).toEqual(["_delta_holders", "_delta_serial_past"]);
    for (const { proname, proconfig } of rows) {
      const path = (proconfig ?? []).find((c: string) => c.startsWith("search_path="));
      expect({ proname, last: path?.split(",").at(-1)?.trim() }).toEqual({ proname, last: "pg_temp" });
    }
  });

  test("a role's own temporary tables do not stand in for delta's: _delta_holders reads no secret through them", async () => {
    await admin.query(`CREATE TABLE IF NOT EXISTS rls_secrets (id bigint PRIMARY KEY, secret text);
      INSERT INTO rls_secrets VALUES (1, 'hunter2') ON CONFLICT DO NOTHING;
      ALTER TABLE rls_secrets ENABLE ROW LEVEL SECURITY; ALTER TABLE rls_secrets FORCE ROW LEVEL SECURITY;
      GRANT SELECT ON rls_secrets TO ${ROLE};`);
    const evil = await app.connect();
    try {
      expect((await evil.query("SELECT * FROM rls_secrets")).rows).toEqual([]);   // the policy holds: nothing to read
      await evil.query(`
        CREATE TEMP TABLE _delta_collections (collection_key TEXT PRIMARY KEY, table_name TEXT NOT NULL, columns_def JSONB NOT NULL DEFAULT '{}',
          parent_collection TEXT, parent_fk TEXT, temporal BOOLEAN NOT NULL DEFAULT TRUE, cascade_on JSONB NOT NULL DEFAULT '[]');
        CREATE TEMP TABLE _delta_docs (prefix TEXT PRIMARY KEY, root_collection TEXT NOT NULL, include TEXT[] NOT NULL DEFAULT '{}',
          scope JSONB NOT NULL DEFAULT '{}', implied BOOLEAN NOT NULL DEFAULT FALSE);
        INSERT INTO _delta_collections VALUES ('c', 'c', '{}', 'p', 'pid', false, '[]'), ('p', 'rls_secrets', '{}', 'root', 'secret', false, '[]'), ('root', 'root', '{}', NULL, NULL, false, '[]');
        INSERT INTO _delta_docs VALUES ('x:', 'root', '{c}', '{}', false);`);
      const answer = await evil.query(`SELECT _delta_holders('c', '{"id":1,"pid":1}', NULL) AS names`)
        .then((r) => r.rows[0].names, (err: any) => err.message);
      expect(answer).toEqual([]);
    } finally {
      await evil.query("DISCARD TEMP").catch(() => {});
      evil.release();
      await admin.query("DROP TABLE IF EXISTS rls_secrets");
    }
  });
});
