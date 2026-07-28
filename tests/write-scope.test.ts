/**
 * Write scoping — a doc may only write the rows it can read.
 *
 * Reads were always scoped (`_delta_load_collection` / `loadCollection` filter
 * children down the parent-FK chain), but writes addressed rows by BARE ID:
 *
 *   - `remove /<coll>/<id>` went straight to the cascade/delete by id.
 *   - `replace /<coll>/<id>[/field]` read the row by id.
 *   - `add /<coll>/<id>` on a GRANDCHILD trusted the parent FK in the payload
 *     (a direct child's FK is injected server-side, so it was always safe).
 *
 * So a client holding `tenant:1` could name a row id belonging to `tenant:2`
 * and delete it, overwrite it, or graft a new child onto it. These tests pin
 * the gate that closes that, on BOTH backends, and pair every refusal with a
 * positive control so a blanket "reject everything" regression can't pass.
 *
 * Postgres half requires a live DB on $DELTA_TEST_PG_URL.
 */
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { Pool } from "pg";
import {
  defineSchema, defineDoc, createTables, registerDocs,
} from "../src/server/sqlite";
import {
  createDocListener, docTypeFromDef, registerDocType, clearRegistry,
  defineDoc as pgDefineDoc,
} from "../src/server/postgres";
import { createWs, type WsServer } from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { newPool, applyFramework, resetState, mockClient, sendAndAwait } from "./setup";
import { readFileSync } from "node:fs";
import { join } from "node:path";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------

describe("write scoping (sqlite)", () => {
  // tenants → projects (direct child) → notes (grandchild)
  // FK columns named explicitly so this mirrors the Postgres fixture exactly
  // (the `parent: "tenants"` shorthand would derive `tenants_id`). Tables are
  // temporal — the framework default — so `current_*` views apply.
  const schema = defineSchema({
    tenants:  { columns: { name: "text" } },
    projects: { columns: { title: "text" }, parent: { collection: "tenants", fk: "tenant_id" } },
    notes:    { columns: { body: "text" }, parent: { collection: "projects", fk: "project_id" } },
  });
  const docs = [defineDoc("tenant:", { root: "tenants", include: ["projects", "notes"] })];

  let db: any;
  let ws: WsServer;

  function socket() {
    const sock: any = {
      data: { clientId: "c" }, readyState: 1, sent: [],
      send: (raw: string) => sock.sent.push(JSON.parse(raw)),
      subscribe() {}, unsubscribe() {},
    };
    return sock;
  }

  let nextId = 1;
  async function send(sock: any, body: any) {
    const id = nextId++;
    await ws.websocket.message(sock, JSON.stringify({ id, ...body }));
    return sock.sent.find((m: any) => m.id === id);
  }

  beforeEach(async () => {
    db = new Database(":memory:");
    createTables(db, schema);
    // Two tenants, each with a project and a note. Tenant ids match the doc
    // names (`tenant:1` / `tenant:2`) since an unscoped def resolves to
    // `WHERE id = <doc-id>`.
    db.run("INSERT INTO tenants (id, name, valid_from) VALUES ('1', 'Alice', datetime('now')), ('2', 'Bob', datetime('now'))");
    db.run("INSERT INTO projects (id, tenant_id, title, valid_from) VALUES ('p1', '1', 'Alice proj', datetime('now')), ('p2', '2', 'Bob proj', datetime('now'))");
    db.run("INSERT INTO notes (id, project_id, body, valid_from) VALUES ('n1', 'p1', 'alice note', datetime('now')), ('n2', 'p2', 'BOB SECRET', datetime('now'))");
    ws = createWs();
    ws.setServer({ publish() {} });
    registerDocs(ws, db, schema, docs);
  });

  test("a doc's read view really does exclude the sibling's rows", async () => {
    const sock = socket();
    const opened = await send(sock, { action: "open", doc: "tenant:1" });
    // Guards the premise of every test below: if scoping ever widened, the
    // refusals would still pass while meaning nothing.
    expect(Object.keys(opened.result.projects)).toEqual(["p1"]);
    expect(Object.keys(opened.result.notes)).toEqual(["n1"]);
  });

  test("cannot remove a sibling doc's row", async () => {
    const sock = socket();
    await send(sock, { action: "open", doc: "tenant:1" });

    const res = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "remove", path: "/notes/n2" }],
    });

    expect(res.error).toBeDefined();
    expect(res.result).toBeUndefined();
    // The refusal must be indistinguishable from "no such row" — a distinct
    // "forbidden" would confirm the id exists to someone probing.
    expect(res.error.message).toContain("Row not found");
    expect(db.query("SELECT * FROM current_notes WHERE id = 'n2'").all()).toHaveLength(1);
  });

  test("cannot remove a sibling doc's row via its parent either", async () => {
    const sock = socket();
    await send(sock, { action: "open", doc: "tenant:1" });

    const res = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "remove", path: "/projects/p2" }],
    });

    expect(res.error).toBeDefined();
    // Crucially the CASCADE must not have run: p2's note is still there.
    expect(db.query("SELECT * FROM current_projects WHERE id = 'p2'").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM current_notes WHERE id = 'n2'").all()).toHaveLength(1);
  });

  test("cannot overwrite a sibling doc's row field", async () => {
    const sock = socket();
    await send(sock, { action: "open", doc: "tenant:1" });

    const res = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "replace", path: "/notes/n2/body", value: "OWNED" }],
    });

    expect(res.error).toBeDefined();
    expect(db.query("SELECT body FROM current_notes WHERE id = 'n2'").get()).toEqual({ body: "BOB SECRET" });
  });

  test("cannot graft a new grandchild onto a sibling doc's parent", async () => {
    const sock = socket();
    await send(sock, { action: "open", doc: "tenant:1" });

    // `notes` is a grandchild, so its project_id is taken from the payload
    // rather than injected — this is the forged-FK path.
    const res = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/notes/injected", value: { body: "injected", project_id: "p2" } }],
    });

    expect(res.error).toBeDefined();
    expect(db.query("SELECT * FROM current_notes WHERE id = 'injected'").all()).toHaveLength(0);
  });

  test("a doc cannot write rows its read view omits (cascadeOn is not scope)", async () => {
    // `memberships` hangs off `teams`, so a `user:` doc — which declares
    // include: ["memberships"] but reaches them only via a cascadeOn ref —
    // opens with an EMPTY memberships map. It must not be able to write them.
    const s = defineSchema({
      users: { columns: { name: "text" } },
      teams: { columns: { name: "text" } },
      memberships: {
        parent: { collection: "teams", fk: "team_id" },
        columns: { role: "text", user_id: "text" },
        cascadeOn: ["user_id"],
      },
    });
    const tdb = new Database(":memory:");
    createTables(tdb, s);
    tdb.run("INSERT INTO users (id, name, valid_from) VALUES ('u1', 'Alice', datetime('now'))");
    tdb.run("INSERT INTO teams (id, name, valid_from) VALUES ('team1', 'Eng', datetime('now'))");
    tdb.run("INSERT INTO memberships (id, team_id, role, user_id, valid_from) VALUES ('m1', 'team1', 'lead', 'u1', datetime('now'))");

    const tws = createWs();
    tws.setServer({ publish() {} });
    registerDocs(tws, tdb, s, [
      defineDoc("user:", { root: "users", include: ["memberships"] }),
      defineDoc("team:", { root: "teams", include: ["memberships"] }),
    ]);

    const sock = socket();
    await tws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "user:u1" }));
    expect(sock.sent.find((m: any) => m.id === 1).result.memberships).toEqual({});

    await tws.websocket.message(sock, JSON.stringify({
      id: 2, action: "delta", doc: "user:u1",
      ops: [{ op: "remove", path: "/memberships/m1" }],
    }));
    expect(sock.sent.find((m: any) => m.id === 2).error).toBeDefined();
    expect(tdb.query("SELECT * FROM current_memberships WHERE id = 'm1'").all()).toHaveLength(1);

    // Positive control: the doc that CAN read it can still remove it.
    const sock2 = socket();
    await tws.websocket.message(sock2, JSON.stringify({ id: 3, action: "open", doc: "team:team1" }));
    await tws.websocket.message(sock2, JSON.stringify({
      id: 4, action: "delta", doc: "team:team1",
      ops: [{ op: "remove", path: "/memberships/m1" }],
    }));
    expect(sock2.sent.find((m: any) => m.id === 4).result).toEqual({ ack: true });
    expect(tdb.query("SELECT * FROM current_memberships WHERE id = 'm1'").all()).toHaveLength(0);
  });

  test("positive control — in-scope writes all still work", async () => {
    const sock = socket();
    await send(sock, { action: "open", doc: "tenant:1" });

    const remove = await send(sock, {
      action: "delta", doc: "tenant:1", ops: [{ op: "remove", path: "/notes/n1" }],
    });
    expect(remove.result).toEqual({ ack: true });

    const addChild = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/projects/p9", value: { title: "new" } }],
    });
    expect(addChild.result).toEqual({ ack: true });
    // Direct child: FK injected server-side from the doc id.
    expect(db.query("SELECT tenant_id FROM current_projects WHERE id = 'p9'").get()).toEqual({ tenant_id: "1" });

    const addGrandchild = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/notes/n9", value: { body: "mine", project_id: "p1" } }],
    });
    expect(addGrandchild.result).toEqual({ ack: true });

    const replace = await send(sock, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "replace", path: "/projects/p1/title", value: "renamed" }],
    });
    expect(replace.result).toEqual({ ack: true });
    expect(db.query("SELECT title FROM current_projects WHERE id = 'p1'").get()).toEqual({ title: "renamed" });
  });
});

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

describe("write scoping (postgres)", () => {
  let pool: Pool;
  let ws: WsServer;
  let listener: Awaited<ReturnType<typeof createDocListener>>;

  beforeAll(async () => {
    pool = await newPool();
    await applyFramework(pool);
    await pool.query(readFileSync(join(import.meta.dir, "fixtures", "tenants.sql"), "utf8"));
  });

  afterAll(async () => {
    await pool.query(`
      DROP TABLE IF EXISTS notes, projects, tenants CASCADE;
      DROP SEQUENCE IF EXISTS seq_notes, seq_projects, seq_tenants;
      DELETE FROM _delta_collections WHERE collection_key IN ('tenants','projects','notes');
      DELETE FROM _delta_docs WHERE prefix = 'tenant:';
    `);
    await pool.end();
  });

  beforeEach(async () => {
    clearRegistry();
    await resetState(pool);
    await pool.query(`
      TRUNCATE notes, projects, tenants RESTART IDENTITY CASCADE;
      INSERT INTO tenants (id, name) VALUES (1, 'Alice'), (2, 'Bob');
      INSERT INTO projects (id, tenant_id, title) VALUES (10, 1, 'Alice proj'), (20, 2, 'Bob proj');
      INSERT INTO notes (id, project_id, body) VALUES (100, 10, 'alice note'), (200, 20, 'BOB SECRET');
    `);
    registerDocType(docTypeFromDef(
      pgDefineDoc("tenant:", { root: "tenants", include: ["projects", "notes"] }),
      pool,
    ));
    ws = createWs();
    ws.setServer({ publish() {} });
    listener = await createDocListener(ws, pool);
  });

  afterEach(async () => {
    await listener.destroy();
  });

  const rowCount = async (sql: string) =>
    Number((await pool.query(sql)).rows[0].n);

  test("a doc's read view really does exclude the sibling's rows", async () => {
    const client = mockClient();
    const opened = await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });
    expect(Object.keys(opened.result.projects)).toEqual(["10"]);
    expect(Object.keys(opened.result.notes)).toEqual(["100"]);
  });

  test("cannot remove a sibling doc's row", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1", ops: [{ op: "remove", path: "/notes/200" }],
    });

    expect(res.error).toBeDefined();
    expect(res.result).toBeUndefined();
    expect(res.error.message).toContain("row not found");
    expect(await rowCount("SELECT count(*) AS n FROM notes WHERE id = 200")).toBe(1);
  });

  test("cannot remove a sibling doc's row via its parent (no cascade either)", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1", ops: [{ op: "remove", path: "/projects/20" }],
    });

    expect(res.error).toBeDefined();
    expect(await rowCount("SELECT count(*) AS n FROM projects WHERE id = 20")).toBe(1);
    expect(await rowCount("SELECT count(*) AS n FROM notes WHERE id = 200")).toBe(1);
  });

  test("cannot overwrite a sibling doc's row field", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "replace", path: "/notes/200/body", value: "OWNED BY ALICE" }],
    });

    expect(res.error).toBeDefined();
    expect((await pool.query("SELECT body FROM notes WHERE id = 200")).rows[0].body)
      .toBe("BOB SECRET");
  });

  test("cannot overwrite a sibling doc's whole row", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "replace", path: "/notes/200", value: { body: "OWNED BY ALICE" } }],
    });

    expect(res.error).toBeDefined();
    expect((await pool.query("SELECT body FROM notes WHERE id = 200")).rows[0].body)
      .toBe("BOB SECRET");
  });

  test("cannot graft a new grandchild onto a sibling doc's parent", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/notes/-", value: { body: "injected", project_id: 20 } }],
    });

    expect(res.error).toBeDefined();
    expect(await rowCount("SELECT count(*) AS n FROM notes WHERE body = 'injected'")).toBe(0);
  });

  test("_delta_cascade_remove reports only rows it actually removed", async () => {
    // Close the row out of band, then ask the cascade to remove it. Nothing is
    // affected, so it must emit NO ops — broadcasting a removal that didn't
    // happen would tell every subscriber to drop a row still in the table.
    // (This is also what an RLS policy filtering the DELETE to zero rows looks
    // like from inside the function.)
    await pool.query("DELETE FROM notes WHERE id = 100");
    const { rows } = await pool.query(
      "SELECT _delta_cascade_remove('notes', 100, ARRAY['projects','notes']) AS ops",
    );
    expect(rows[0].ops).toEqual([]);
  });

  test("positive control — in-scope writes all still work", async () => {
    const client = mockClient();
    await sendAndAwait(ws, client, { action: "open", doc: "tenant:1" });

    const addChild = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/projects/-", value: { title: "new" } }],
    });
    expect(addChild.result.ack).toBe(true);
    // Direct child: FK injected from the doc id, not the payload.
    expect(await rowCount("SELECT count(*) AS n FROM projects WHERE tenant_id = 1")).toBe(2);

    const addGrandchild = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "add", path: "/notes/-", value: { body: "mine", project_id: 10 } }],
    });
    expect(addGrandchild.result.ack).toBe(true);

    const replace = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1",
      ops: [{ op: "replace", path: "/notes/100/body", value: "edited" }],
    });
    expect(replace.result.ack).toBe(true);
    expect((await pool.query("SELECT body FROM notes WHERE id = 100")).rows[0].body).toBe("edited");

    const remove = await sendAndAwait(ws, client, {
      action: "delta", doc: "tenant:1", ops: [{ op: "remove", path: "/notes/100" }],
    });
    expect(remove.result.ack).toBe(true);
    expect(await rowCount("SELECT count(*) AS n FROM notes WHERE id = 100")).toBe(0);
  });

  test("a list-mode doc can still write every row it can read", async () => {
    // List mode loads `include`d collections in FULL, so the gate must NOT
    // narrow writes there — otherwise catalog-shaped docs break.
    clearRegistry();
    await pool.query(`
      INSERT INTO _delta_docs (prefix, root_collection, include, scope)
      VALUES ('all-tenants:', 'tenants', '{"projects","notes"}', '{}'::jsonb)
      ON CONFLICT (prefix) DO UPDATE SET include = EXCLUDED.include
    `);
    registerDocType(docTypeFromDef(
      pgDefineDoc("all-tenants:", { root: "tenants", include: ["projects", "notes"] }),
      pool,
    ));

    const client = mockClient();
    const opened = await sendAndAwait(ws, client, { action: "open", doc: "all-tenants:" });
    expect(Object.keys(opened.result.notes).sort()).toEqual(["100", "200"]);

    const res = await sendAndAwait(ws, client, {
      action: "delta", doc: "all-tenants:",
      ops: [{ op: "replace", path: "/notes/200/body", value: "edited by list doc" }],
    });
    expect(res.result.ack).toBe(true);

    await pool.query("DELETE FROM _delta_docs WHERE prefix = 'all-tenants:'");
  });
});
