/**
 * What every backend answers alike about a write, asked through the wire
 * alone: the error-code table, a row the server names (`add /<coll>/-`), and
 * write scope (a document writes only the rows it reads). Each case stands
 * up a small app of its own -- a schema, its documents, its rows -- through
 * the backend's `CaseBackend`, and checks what a fresh open reads, never the
 * tables, so a backend is asked only what a client could see.
 *
 *   errorCodeCases(standUp);
 *   createRowCases(standUp);
 *   writeScopeCases(standUp);
 *
 * where `standUp({ schema, docs, seed })` makes a fresh store with that
 * schema, those documents registered and those rows imported, and answers a
 * `WsServer` serving them and an `end()`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyOps, splitPath } from "../core";
import { defineDoc, defineSchema, type DocDef, type Schema, type Snapshot } from "../schema";
import type { WsServer } from "../server/server";
import { mockClient, sendAndAwait } from "./support";

/** An app for a case: what a backend stands up on a fresh store. */
export interface CaseApp { schema: Schema; docs: DocDef[]; seed: Snapshot }
/** A backend's stand-up: a server over a fresh store holding the app, and how to take it down. */
export type CaseBackend = (app: CaseApp) => Promise<{ ws: WsServer; end(): Promise<void> }>;

/** A fresh open of `doc`, as another client reads it: the truth a case checks against. */
async function fresh(ws: WsServer, doc: string): Promise<any> {
  const r = await sendAndAwait(ws, mockClient({ clientId: "reader" }), { action: "open", doc });
  return r.result;
}

// ---------------------------------------------------------------------------
// A room and its messages: the error table and a server-named row
// ---------------------------------------------------------------------------

export const roomsApp: CaseApp = {
  schema: defineSchema({
    case_rooms: { columns: { title: "text" }, temporal: false },
    case_messages: { columns: { text: "text" }, parent: { collection: "case_rooms", fk: "case_rooms_id" }, temporal: false },
  }),
  docs: [defineDoc("case-room:", { root: "case_rooms", include: ["case_messages"] })],
  seed: { tables: { case_rooms: [{ id: 1, title: "general" }], case_messages: [{ id: 7, case_rooms_id: 1, text: "hi" }] } },
};

/** The mistakes, each answered with one code on every backend (400 malformed, 404 not there, 409 already there). */
export const mistakes: Record<string, { ops: unknown[]; code: number }> = {
  "a path without a leading slash": { ops: [{ op: "remove", path: "case_messages" }], code: 400 },
  "a row that is not there": { ops: [{ op: "replace", path: "/case_messages/404/text", value: "x" }], code: 404 },
  "a remove of a row that is not there": { ops: [{ op: "remove", path: "/case_messages/404" }], code: 404 },
  "an unknown field": { ops: [{ op: "replace", path: "/case_messages/7/nope", value: "x" }], code: 400 },
  "a field named after Object.prototype": { ops: [{ op: "replace", path: "/case_messages/7/toString", value: "x" }], code: 400 },
  "an add of a row that is already there": { ops: [{ op: "add", path: "/case_messages/7", value: { text: "again" } }], code: 409 },
  "an add that leaves out a required field": { ops: [{ op: "add", path: "/case_messages/-", value: {} }], code: 400 },
  "a remove of a field": { ops: [{ op: "remove", path: "/case_messages/7/text" }], code: 400 },
  "an add of a field": { ops: [{ op: "add", path: "/case_messages/7/text", value: "x" }], code: 400 },
};

/** The same mistake, the same code: every one of `mistakes`, and nothing changed by any. */
export function errorCodeCases(backend: CaseBackend): void {
  describe("the same mistake, the same code", () => {
    let up: Awaited<ReturnType<CaseBackend>>;
    beforeAll(async () => { up = await backend(roomsApp); });
    afterAll(async () => { await up.end(); });

    for (const [name, { ops, code }] of Object.entries(mistakes)) {
      test(`${name}: ${code}`, async () => {
        const c = mockClient();
        await sendAndAwait(up.ws, c, { action: "open", doc: "case-room:1" });
        const r = await sendAndAwait(up.ws, c, { action: "delta", doc: "case-room:1", ops });
        expect(r.error?.code).toBe(code);
        const now = await fresh(up.ws, "case-room:1");
        expect(Object.values(now.case_messages)).toEqual([{ id: 7, case_rooms_id: 1, text: "hi" }]);
      });
    }
  });
}

/** `add /<coll>/-` makes a row the server names: told and stored under its id, the path's id winning over the value's. */
export function createRowCases(backend: CaseBackend): void {
  describe("add /coll/- makes a row the server names", () => {
    let up: Awaited<ReturnType<CaseBackend>>;
    beforeEach(async () => { up = await backend(roomsApp); });
    afterEach(async () => { await up.end(); });

    test("a peer told of two adds holds each under the id it was given", async () => {
      const published: any[] = [];
      up.ws.setServer({ publish: (_ch: string, raw: string) => published.push(JSON.parse(raw)) });
      const peer = mockClient({ clientId: "peer" });
      const ada = mockClient({ clientId: "ada" });
      const view = (await sendAndAwait(up.ws, peer, { action: "open", doc: "case-room:1" })).result;
      delete view._v;
      for (const text of ["hello", "again"]) {
        const r = await sendAndAwait(up.ws, ada, { action: "delta", doc: "case-room:1", ops: [{ op: "add", path: "/case_messages/-", value: { text } }] });
        expect(r.error).toBeUndefined();
      }
      for (let i = 0; i < 50 && published.length < 2; i++) await Bun.sleep(20);
      for (const m of published) {
        expect(splitPath(m.ops[0].path)[1]).not.toBe("-");   // the echo names the row
        applyOps(view, m.ops);
      }
      const rows = Object.entries(view.case_messages as Record<string, any>);
      expect(rows.map(([, r]) => r.text).sort()).toEqual(["again", "hello", "hi"]);
      for (const [key, row] of rows) expect(String(row.id)).toBe(key);   // the row carries its id
      const now = await fresh(up.ws, "case-room:1");
      delete now._v;
      expect(now).toEqual(view);
    });

    test("the path names the row, whatever the value's id says", async () => {
      const ada = mockClient();
      await sendAndAwait(up.ws, ada, { action: "open", doc: "case-room:1" });
      const r = await sendAndAwait(up.ws, ada, {
        action: "delta", doc: "case-room:1", inverse: true,
        ops: [{ op: "add", path: "/case_messages/-", value: { id: 999, text: "forged id" } }],
      });
      expect(r.error).toBeUndefined();
      const now = await fresh(up.ws, "case-room:1");
      expect(now.case_messages["999"]).toBeUndefined();
      expect(Object.values(now.case_messages).map((m: any) => m.text).sort()).toEqual(["forged id", "hi"]);
    });
  });
}

// ---------------------------------------------------------------------------
// Tenants: write scope
// ---------------------------------------------------------------------------

/**
 * tenants → projects (a direct child, its key put in by the server on an add) →
 * notes (a grandchild, its key coming from the client): two tenants side by
 * side, each the other's sibling document of one prefix, and a list holding all.
 */
export const tenantsApp: CaseApp = {
  schema: defineSchema({
    tenants: { table: "case_tenants", columns: { name: "text" } },
    projects: { table: "case_projects", columns: { title: "text" }, parent: { collection: "tenants", fk: "tenant_id" } },
    notes: { table: "case_notes", columns: { body: "text" }, parent: { collection: "projects", fk: "project_id" } },
  }),
  docs: [
    defineDoc("tenant:", { root: "tenants", include: ["projects", "notes"] }),
    defineDoc("all-tenants:", { root: "tenants", include: ["projects", "notes"] }),
  ],
  seed: {
    tables: {
      tenants: [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }],
      projects: [{ id: 10, tenant_id: 1, title: "Alice proj" }, { id: 20, tenant_id: 2, title: "Bob proj" }],
      notes: [{ id: 100, project_id: 10, body: "alice note" }, { id: 200, project_id: 20, body: "BOB SECRET" }],
    },
  },
};

/**
 * memberships hang off teams, and point at users by a key that cascades: a
 * `user:` document includes them but reaches none (cascadeOn is not scope).
 */
export const membershipsApp: CaseApp = {
  schema: defineSchema({
    users: { table: "case_users", columns: { name: "text" } },
    teams: { table: "case_teams", columns: { name: "text" } },
    memberships: { table: "case_memberships", parent: { collection: "teams", fk: "team_id" }, columns: { role: "text", user_id: "integer" }, cascadeOn: ["user_id"] },
  }),
  docs: [
    defineDoc("user:", { root: "users", include: ["memberships"] }),
    defineDoc("team:", { root: "teams", include: ["memberships"] }),
  ],
  seed: {
    tables: {
      users: [{ id: 1, name: "Alice" }],
      teams: [{ id: 1, name: "Eng" }],
      memberships: [{ id: 1, team_id: 1, role: "lead", user_id: 1 }],
    },
  },
};

/** A document writes only the rows it reads: a sibling's row is not there to it, and stays as it was. Each refusal has its positive control. */
export function writeScopeCases(backend: CaseBackend): void {
  describe("a document writes only what it reads", () => {
    let up: Awaited<ReturnType<CaseBackend>>;
    let ada: ReturnType<typeof mockClient>;
    beforeEach(async () => {
      up = await backend(tenantsApp);
      ada = mockClient({ clientId: "ada" });
      await sendAndAwait(up.ws, ada, { action: "open", doc: "tenant:1" });
    });
    afterEach(async () => { await up.end(); });

    const write = (ops: unknown[], doc = "tenant:1") => sendAndAwait(up.ws, ada, { action: "delta", doc, ops });
    const bobs = async () => {
      const b = await fresh(up.ws, "tenant:2");
      return { projects: b.projects, notes: b.notes };
    };
    const bobsAsSeeded = {
      projects: { "20": { id: 20, tenant_id: 2, title: "Bob proj" } },
      notes: { "200": { id: 200, project_id: 20, body: "BOB SECRET" } },
    };

    test("its read really excludes the sibling's rows", async () => {
      const mine = await fresh(up.ws, "tenant:1");
      // the premise of every case below: were scope wider, the refusals would pass and mean nothing
      expect(Object.keys(mine.projects)).toEqual(["10"]);
      expect(Object.keys(mine.notes)).toEqual(["100"]);
    });

    test("a sibling's row is not there to remove: 404, as a row that does not exist", async () => {
      const r = await write([{ op: "remove", path: "/notes/200" }]);
      expect(r.error?.code).toBe(404);
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("nor through its parent, and no cascade runs", async () => {
      const r = await write([{ op: "remove", path: "/projects/20" }]);
      expect(r.error).toBeDefined();
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("a sibling's field is not there to replace", async () => {
      const r = await write([{ op: "replace", path: "/notes/200/body", value: "OWNED" }]);
      expect(r.error).toBeDefined();
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("nor its whole row", async () => {
      const r = await write([{ op: "replace", path: "/notes/200", value: { body: "OWNED", project_id: 20 } }]);
      expect(r.error).toBeDefined();
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("a grandchild is not grafted onto a sibling's parent", async () => {
      const r = await write([{ op: "add", path: "/notes/-", value: { body: "injected", project_id: 20 } }]);
      expect(r.error).toBeDefined();
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("in scope, every write still lands", async () => {
      expect((await write([{ op: "add", path: "/projects/-", value: { title: "new" } }])).error).toBeUndefined();
      expect((await write([{ op: "add", path: "/notes/-", value: { body: "mine", project_id: 10 } }])).error).toBeUndefined();
      expect((await write([{ op: "replace", path: "/notes/100/body", value: "edited" }])).error).toBeUndefined();
      const mine = await fresh(up.ws, "tenant:1");
      // a direct child's parent key is the document's, put in by the server
      expect(Object.values(mine.projects).map((p: any) => [p.tenant_id, p.title]).sort()).toEqual([[1, "Alice proj"], [1, "new"]]);
      expect(Object.values(mine.notes).map((n: any) => n.body).sort()).toEqual(["edited", "mine"]);
      expect((await write([{ op: "remove", path: "/notes/100" }])).error).toBeUndefined();
      expect((await fresh(up.ws, "tenant:1")).notes["100"]).toBeUndefined();
      expect(await bobs()).toEqual(bobsAsSeeded);
    });

    test("a list holding every tenant writes every row it reads", async () => {
      const all = mockClient();
      const opened = await sendAndAwait(up.ws, all, { action: "open", doc: "all-tenants:" });
      expect(Object.keys(opened.result.notes).sort()).toEqual(["100", "200"]);
      const r = await sendAndAwait(up.ws, all, { action: "delta", doc: "all-tenants:", ops: [{ op: "replace", path: "/notes/200/body", value: "edited by the list" }] });
      expect(r.error).toBeUndefined();
      expect((await bobs()).notes["200"].body).toBe("edited by the list");
    });
  });

  describe("cascadeOn is not scope", () => {
    test("a document that reaches no membership writes none; the one that holds it can", async () => {
      const up = await backend(membershipsApp);
      try {
        const u = mockClient();
        expect((await sendAndAwait(up.ws, u, { action: "open", doc: "user:1" })).result.memberships).toEqual({});
        expect((await sendAndAwait(up.ws, u, { action: "delta", doc: "user:1", ops: [{ op: "remove", path: "/memberships/1" }] })).error).toBeDefined();
        expect(Object.keys((await fresh(up.ws, "team:1")).memberships)).toEqual(["1"]);
        const t = mockClient();
        await sendAndAwait(up.ws, t, { action: "open", doc: "team:1" });
        expect((await sendAndAwait(up.ws, t, { action: "delta", doc: "team:1", ops: [{ op: "remove", path: "/memberships/1" }] })).error).toBeUndefined();
        expect((await fresh(up.ws, "team:1")).memberships).toEqual({});
      } finally {
        await up.end();
      }
    });
  });
}
