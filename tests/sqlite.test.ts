import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  defineSchema, defineDoc, createTables, registerDocs,
  loadDocAt, createSnapshot, resolveSnapshot,
  migrateSchema, validateOps,
  type Schema, type DocDef,
} from "../sqlite";
import { createWs } from "../server";
import { setLogLevel } from "../logger";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSocket(clientId = "test-client") {
  const sent: any[] = [];
  const subscriptions = new Set<string>();
  return {
    data: { clientId },
    readyState: 1,
    send: (raw: string) => sent.push(JSON.parse(raw)),
    subscribe: (ch: string) => subscriptions.add(ch),
    unsubscribe: (ch: string) => subscriptions.delete(ch),
    sent,
    subscriptions,
  };
}

// ---------------------------------------------------------------------------
// Schema used across tests
// ---------------------------------------------------------------------------

const schema = defineSchema({
  projects: {
    columns: { name: "text", status: "text", meta: "json?" },
  },
  tasks: {
    parent: { collection: "projects", fk: "project_id" },
    columns: {
      title: "text",
      done: "boolean",
      priority: "integer?",
    },
  },
  comments: {
    parent: { collection: "tasks", fk: "task_id" },
    columns: { body: "text", author: "text?" },
  },
});

const projectDoc = defineDoc("project:", {
  root: "projects",
  include: ["tasks", "comments"],
});

// ---------------------------------------------------------------------------
// defineSchema
// ---------------------------------------------------------------------------

describe("defineSchema", () => {
  test("resolves column shorthands", () => {
    const s = defineSchema({
      items: {
        columns: {
          name: "text",
          count: "integer?",
          active: "boolean",
          data: "json",
        },
      },
    });
    const cols = s.tables["items"]!.columns;
    expect(cols["name"]).toEqual({ type: "text", nullable: false });
    expect(cols["count"]).toEqual({ type: "integer", nullable: true });
    expect(cols["active"]).toEqual({ type: "boolean", nullable: false });
    expect(cols["data"]).toEqual({ type: "json", nullable: false });
  });

  test("resolves full ColumnDef objects", () => {
    const s = defineSchema({
      items: {
        columns: {
          score: { type: "real", nullable: true, default: 0.5 },
        },
      },
    });
    expect(s.tables["items"]!.columns["score"]).toEqual({
      type: "real",
      nullable: true,
      default: 0.5,
    });
  });

  test("resolves string parent shorthand", () => {
    const s = defineSchema({
      parents: { columns: { name: "text" } },
      children: { parent: "parents", columns: { label: "text" } },
    });
    expect(s.tables["children"]!.parent).toEqual({
      collection: "parents",
      fkColumn: "parents_id",
    });
    expect(s.tables["parents"]!.children).toEqual(["children"]);
  });

  test("resolves object parent", () => {
    expect(schema.tables["tasks"]!.parent).toEqual({
      collection: "projects",
      fkColumn: "project_id",
    });
    expect(schema.tables["projects"]!.children).toContain("tasks");
  });

  test("computes grandchild relationships", () => {
    expect(schema.tables["comments"]!.parent).toEqual({
      collection: "tasks",
      fkColumn: "task_id",
    });
    expect(schema.tables["tasks"]!.children).toContain("comments");
  });

  test("temporal defaults to true", () => {
    expect(schema.tables["projects"]!.temporal).toBe(true);
    expect(schema.tables["tasks"]!.temporal).toBe(true);
  });

  test("temporal can be disabled", () => {
    const s = defineSchema({
      logs: { temporal: false, columns: { msg: "text" } },
    });
    expect(s.tables["logs"]!.temporal).toBe(false);
  });

  test("custom table name", () => {
    const s = defineSchema({
      items: { table: "my_items", columns: { name: "text" } },
    });
    expect(s.tables["items"]!.name).toBe("my_items");
    expect(s.tables["items"]!.docKey).toBe("items");
  });

  test("cascadeOn with string FK", () => {
    const s = defineSchema({
      users: { columns: { name: "text" } },
      assignments: {
        columns: { role: "text" },
        cascadeOn: ["user_id"],
      },
    });
    expect(s.tables["users"]!.referencedBy).toEqual([
      { collection: "assignments", fkColumn: "user_id" },
    ]);
  });

  test("cascadeOn with explicit object", () => {
    const s = defineSchema({
      teams: { columns: { name: "text" } },
      memberships: {
        columns: { role: "text" },
        cascadeOn: [{ fk: "team_ref", collection: "teams" }],
      },
    });
    expect(s.tables["teams"]!.referencedBy).toEqual([
      { collection: "memberships", fkColumn: "team_ref" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// defineDoc
// ---------------------------------------------------------------------------

describe("defineDoc", () => {
  test("creates doc definition with defaults", () => {
    const doc = defineDoc("item:", { root: "items", include: ["parts"] });
    expect(doc.prefix).toBe("item:");
    expect(doc.root).toBe("items");
    expect(doc.include).toEqual(["parts"]);
    expect(doc.scope).toEqual({});
  });

  test("creates doc definition with scope", () => {
    const doc = defineDoc("user:", {
      root: "users",
      include: [],
      scope: { user_id: ":docId" },
    });
    expect(doc.scope).toEqual({ user_id: ":docId" });
  });
});

// ---------------------------------------------------------------------------
// createTables
// ---------------------------------------------------------------------------

describe("createTables", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    createTables(db, schema);
  });

  test("creates temporal tables with valid_from/valid_to", () => {
    const info = db.query("PRAGMA table_info(projects)").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("name");
    expect(colNames).toContain("status");
    expect(colNames).toContain("valid_from");
    expect(colNames).toContain("valid_to");
  });

  test("creates FK columns from parent", () => {
    const info = db.query("PRAGMA table_info(tasks)").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain("project_id");
    expect(colNames).toContain("title");
    expect(colNames).toContain("done");
    expect(colNames).toContain("priority");
  });

  test("creates current_ views for temporal tables", () => {
    const views = db.query("SELECT name FROM sqlite_master WHERE type = 'view'").all() as any[];
    const viewNames = views.map((v: any) => v.name);
    expect(viewNames).toContain("current_projects");
    expect(viewNames).toContain("current_tasks");
    expect(viewNames).toContain("current_comments");
  });

  test("non-temporal table has no valid_from/valid_to", () => {
    const s = defineSchema({
      logs: { temporal: false, columns: { msg: "text" } },
    });
    createTables(db, s);
    const info = db.query("PRAGMA table_info(logs)").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).not.toContain("valid_from");
    expect(colNames).not.toContain("valid_to");
  });

  test("non-temporal table has no current_ view", () => {
    const s = defineSchema({
      logs: { temporal: false, columns: { msg: "text" } },
    });
    createTables(db, s);
    const views = db.query("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'current_logs'").all();
    expect(views).toHaveLength(0);
  });

  test("column defaults are applied", () => {
    const s = defineSchema({
      items: {
        columns: {
          score: { type: "real", nullable: false, default: 1.5 },
          label: { type: "text", nullable: false, default: "untitled" },
          active: { type: "boolean", nullable: false, default: true },
        },
        temporal: false,
      },
    });
    createTables(db, s);
    db.run("INSERT INTO items (id) VALUES ('x')");
    const row = db.query("SELECT * FROM items WHERE id = 'x'").get() as any;
    expect(row.score).toBe(1.5);
    expect(row.label).toBe("untitled");
    expect(row.active).toBe(1); // boolean stored as integer
  });

  test("nullable columns accept NULL", () => {
    db.run("INSERT INTO projects (id, name, status, meta, valid_from) VALUES ('p1', 'test', 'active', NULL, datetime('now'))");
    const row = db.query("SELECT * FROM current_projects WHERE id = 'p1'").get() as any;
    expect(row.meta).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// registerDocs — integration tests via WebSocket handlers
// ---------------------------------------------------------------------------

describe("registerDocs", () => {
  let db: InstanceType<typeof Database>;
  let ws: ReturnType<typeof createWs>;

  const PAST = "2020-01-01 00:00:00";

  function seedProject(id: string, name: string, status: string) {
    db.run(
      "INSERT INTO projects (id, name, status, valid_from) VALUES (?, ?, ?, ?)",
      [id, name, status, PAST],
    );
  }

  function seedTask(id: string, projectId: string, title: string, done: boolean) {
    db.run(
      "INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES (?, ?, ?, ?, ?)",
      [id, projectId, title, done ? 1 : 0, PAST],
    );
  }

  function seedComment(id: string, taskId: string, body: string, author: string | null) {
    db.run(
      "INSERT INTO comments (id, task_id, body, author, valid_from) VALUES (?, ?, ?, ?, ?)",
      [id, taskId, body, author, PAST],
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    createTables(db, schema);
    ws = createWs();
    registerDocs(ws, db, schema, [projectDoc]);
  });

  // ---------------------------------------------------------------------------
  // Open
  // ---------------------------------------------------------------------------

  describe("open", () => {
    test("loads root and collections", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);
      seedTask("t2", "p1", "Test it", true);
      seedComment("c1", "t1", "Looking good", "alice");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({
        id: 1, action: "open", doc: "project:p1",
      }));

      const res = sock.sent[0];
      expect(res.id).toBe(1);
      expect(res.result.projects.id).toBe("p1");
      expect(res.result.projects.name).toBe("Alpha");
      expect(Object.keys(res.result.tasks)).toHaveLength(2);
      expect(res.result.tasks["t1"].title).toBe("Ship it");
      expect(res.result.tasks["t1"].done).toBe(false); // decoded boolean
      expect(res.result.tasks["t2"].done).toBe(true);
      expect(res.result.comments["c1"].body).toBe("Looking good");
      expect(sock.subscriptions.has("project:p1")).toBe(true);
    });

    test("returns 404 for missing doc", async () => {
      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({
        id: 1, action: "open", doc: "project:missing",
      }));
      expect(sock.sent[0].error.code).toBe(404);
    });

    test("caches doc on second open", async () => {
      seedProject("p1", "Alpha", "active");

      const sock1 = mockSocket("c1");
      const sock2 = mockSocket("c2");

      await ws.websocket.message(sock1, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));
      await ws.websocket.message(sock2, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      expect(sock1.sent[0].result.projects.name).toBe("Alpha");
      expect(sock2.sent[0].result.projects.name).toBe("Alpha");
    });

    test("ignores unmatched doc prefix", async () => {
      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({
        id: 1, action: "open", doc: "unknown:x",
      }));
      // No handler matched — delta-server returns error
      expect(sock.sent[0].error.message).toContain("No handler matched");
    });
  });

  // ---------------------------------------------------------------------------
  // Delta — add
  // ---------------------------------------------------------------------------

  describe("delta add", () => {
    test("adds a task row", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "add", path: "/tasks/t1", value: { title: "New task", done: false } }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });

      // Verify in SQL
      const rows = db.query("SELECT * FROM current_tasks WHERE project_id = 'p1'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("New task");
      expect(rows[0].done).toBe(0);
    });

    test("adds a grandchild row", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "add", path: "/comments/c1", value: { task_id: "t1", body: "Nice", author: null } }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });
      const rows = db.query("SELECT * FROM current_comments WHERE task_id = 't1'").all() as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe("Nice");
    });

    test("applies default values for missing fields", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "add", path: "/tasks/t1", value: { title: "Minimal" } }],
      }));

      // done defaults to false (boolean default), priority defaults to null (nullable)
      const row = db.query("SELECT * FROM current_tasks WHERE id = 't1'").get() as any;
      expect(row.done).toBe(0);
      expect(row.priority).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Delta — replace
  // ---------------------------------------------------------------------------

  describe("delta replace", () => {
    test("replaces a task field", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "replace", path: "/tasks/t1/done", value: true }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });

      // Old row closed, new row inserted (temporal)
      const allRows = db.query("SELECT * FROM tasks WHERE id = 't1'").all() as any[];
      expect(allRows.length).toBeGreaterThanOrEqual(2);

      const current = db.query("SELECT * FROM current_tasks WHERE id = 't1'").get() as any;
      expect(current.done).toBe(1);
    });

    test("batches multiple field updates on same row", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [
          { op: "replace", path: "/tasks/t1/title", value: "Updated" },
          { op: "replace", path: "/tasks/t1/done", value: true },
        ],
      }));

      const current = db.query("SELECT * FROM current_tasks WHERE id = 't1'").get() as any;
      expect(current.title).toBe("Updated");
      expect(current.done).toBe(1);
    });

    test("replaces a root-level field", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "replace", path: "/projects/name", value: "Beta" }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });
      const current = db.query("SELECT * FROM current_projects WHERE id = 'p1'").get() as any;
      expect(current.name).toBe("Beta");
    });
  });

  // ---------------------------------------------------------------------------
  // Delta — remove
  // ---------------------------------------------------------------------------

  describe("delta remove", () => {
    test("removes a task row (temporal close)", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "remove", path: "/tasks/t1" }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });

      // Row still exists but closed
      const all = db.query("SELECT * FROM tasks WHERE id = 't1'").all() as any[];
      expect(all.some((r: any) => r.valid_to !== null)).toBe(true);

      // Not in current view
      const current = db.query("SELECT * FROM current_tasks WHERE id = 't1'").all();
      expect(current).toHaveLength(0);
    });

    test("cascade deletes children", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);
      seedComment("c1", "t1", "Looking good", "alice");
      seedComment("c2", "t1", "Agreed", "bob");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "remove", path: "/tasks/t1" }],
      }));

      // Task and its comments should be closed
      expect(db.query("SELECT * FROM current_tasks WHERE id = 't1'").all()).toHaveLength(0);
      expect(db.query("SELECT * FROM current_comments WHERE task_id = 't1'").all()).toHaveLength(0);
    });

    test("cascade via cascadeOn references", async () => {
      const s = defineSchema({
        users: { columns: { name: "text" } },
        teams: { columns: { name: "text" } },
        memberships: {
          parent: { collection: "teams", fk: "team_id" },
          columns: { role: "text", user_id: "text" },
          cascadeOn: ["user_id"],
        },
      });

      const teamDoc = defineDoc("team:", {
        root: "teams",
        include: ["memberships"],
      });

      const userDoc = defineDoc("user:", {
        root: "users",
        include: ["memberships"],
      });

      const tdb = new Database(":memory:");
      createTables(tdb, s);

      // Seed data
      tdb.run("INSERT INTO users (id, name, valid_from) VALUES ('u1', 'Alice', datetime('now'))");
      tdb.run("INSERT INTO teams (id, name, valid_from) VALUES ('team1', 'Eng', datetime('now'))");
      tdb.run("INSERT INTO memberships (id, team_id, role, user_id, valid_from) VALUES ('m1', 'team1', 'lead', 'u1', datetime('now'))");

      const tws = createWs();
      registerDocs(tws, tdb, s, [userDoc, teamDoc]);

      // Open user doc
      const sock = mockSocket();
      await tws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "user:u1" }));

      // Remove user — should cascade to memberships
      await tws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "user:u1",
        ops: [{ op: "remove", path: "/memberships/m1" }],
      }));

      expect(tdb.query("SELECT * FROM current_memberships WHERE user_id = 'u1'").all()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Delta — errors
  // ---------------------------------------------------------------------------

  describe("delta errors", () => {
    test("unknown collection", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "add", path: "/nonexistent/x", value: {} }],
      }));

      expect(sock.sent[1].error).toBeDefined();
      expect(sock.sent[1].error.code).toBe(500);
    });

    test("delta on unopened doc returns 404", async () => {
      const sock = mockSocket();
      // Don't open first — go straight to delta
      await ws.websocket.message(sock, JSON.stringify({
        id: 1,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "replace", path: "/projects/name", value: "X" }],
      }));

      expect(sock.sent[0].error.code).toBe(404);
    });

    test("replace on missing row returns error", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "replace", path: "/tasks/missing/title", value: "X" }],
      }));

      expect(sock.sent[1].error).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Close and cache eviction
  // ---------------------------------------------------------------------------

  describe("close", () => {
    test("unsubscribes and evicts cache when no subscribers", async () => {
      seedProject("p1", "Alpha", "active");

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));
      expect(sock.subscriptions.has("project:p1")).toBe(true);

      await ws.websocket.message(sock, JSON.stringify({ id: 2, action: "close", doc: "project:p1" }));
      expect(sock.sent[1].result).toEqual({ ack: true });
      expect(sock.subscriptions.has("project:p1")).toBe(false);

      // Re-open should reload from SQL (not stale cache)
      db.run("UPDATE projects SET name = 'Changed' WHERE id = 'p1' AND valid_to IS NULL");
      await ws.websocket.message(sock, JSON.stringify({ id: 3, action: "open", doc: "project:p1" }));
      expect(sock.sent[2].result.projects.name).toBe("Changed");
    });

    test("evict() clears cached doc", async () => {
      // Use a separate ws to avoid duplicate handlers from beforeEach
      const edb = new Database(":memory:");
      createTables(edb, schema);
      edb.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', ?)", [PAST]);

      const ews = createWs();
      const handle = registerDocs(ews, edb, schema, [projectDoc]);

      const sock = mockSocket();
      await ews.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));
      expect(sock.sent[0].result.projects.name).toBe("Alpha");

      handle.evict("project:p1");

      // Mutate SQL directly
      edb.run("UPDATE projects SET name = 'Evicted' WHERE id = 'p1' AND valid_to IS NULL");

      // Re-open reloads from SQL
      await ews.websocket.message(sock, JSON.stringify({ id: 2, action: "open", doc: "project:p1" }));
      expect(sock.sent[1].result.projects.name).toBe("Evicted");
    });
  });

  // ---------------------------------------------------------------------------
  // Field codecs
  // ---------------------------------------------------------------------------

  describe("field codecs", () => {
    test("json fields on root row are decoded", async () => {
      const s = defineSchema({
        items: { columns: { data: "json" } },
      });
      const doc = defineDoc("item:", { root: "items", include: [] });

      const jdb = new Database(":memory:");
      createTables(jdb, s);
      jdb.run("INSERT INTO items (id, data, valid_from) VALUES ('i1', '{\"a\":1}', ?)", [PAST]);

      const jws = createWs();
      registerDocs(jws, jdb, s, [doc]);

      const sock = mockSocket();
      await jws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "item:i1" }));

      expect(sock.sent[0].result.items.data).toEqual({ a: 1 });
    });

    test("boolean fields decode from integer", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Test", true);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      const task = sock.sent[0].result.tasks["t1"];
      expect(task.done).toBe(true);
      expect(typeof task.done).toBe("boolean");
    });

    test("json field in collection decoded from string", async () => {
      const s = defineSchema({
        projects: { columns: { name: "text" } },
        items: {
          parent: { collection: "projects", fk: "project_id" },
          columns: { data: "json" },
        },
      });
      const doc = defineDoc("proj:", { root: "projects", include: ["items"] });

      const jdb = new Database(":memory:");
      createTables(jdb, s);
      jdb.run("INSERT INTO projects (id, name, valid_from) VALUES ('p1', 'Test', datetime('now'))");
      jdb.run("INSERT INTO items (id, project_id, data, valid_from) VALUES ('i1', 'p1', '{\"x\":42}', datetime('now'))");

      const jws = createWs();
      registerDocs(jws, jdb, s, [doc]);

      const sock = mockSocket();
      await jws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "proj:p1" }));

      const item = sock.sent[0].result.items["i1"];
      expect(item.data).toEqual({ x: 42 });
    });

    test("json field round-trips through add op", async () => {
      const s = defineSchema({
        projects: { columns: { name: "text" } },
        items: {
          parent: { collection: "projects", fk: "project_id" },
          columns: { data: "json" },
        },
      });
      const doc = defineDoc("proj:", { root: "projects", include: ["items"] });

      const jdb = new Database(":memory:");
      createTables(jdb, s);
      jdb.run("INSERT INTO projects (id, name, valid_from) VALUES ('p1', 'Test', datetime('now'))");

      const jws = createWs();
      registerDocs(jws, jdb, s, [doc]);

      const sock = mockSocket();
      await jws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "proj:p1" }));

      await jws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "proj:p1",
        ops: [{ op: "add", path: "/items/i1", value: { data: { nested: [1, 2, 3] } } }],
      }));

      // Verify stored as JSON string in SQL
      const row = jdb.query("SELECT data FROM current_items WHERE id = 'i1'").get() as any;
      expect(typeof row.data).toBe("string");
      expect(JSON.parse(row.data)).toEqual({ nested: [1, 2, 3] });
    });
  });

  // ---------------------------------------------------------------------------
  // Temporal versioning
  // ---------------------------------------------------------------------------

  describe("temporal", () => {
    test("replace creates history (old row closed, new row inserted)", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Original", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "replace", path: "/tasks/t1/title", value: "Updated" }],
      }));

      // Should have at least 2 rows: original (closed) + updated (current)
      const allRows = db.query("SELECT * FROM tasks WHERE id = 't1' ORDER BY valid_from").all() as any[];
      expect(allRows.length).toBeGreaterThanOrEqual(2);

      // First row should be closed
      expect(allRows[0].valid_to).not.toBeNull();
      expect(allRows[0].title).toBe("Original");

      // Last row should be current
      const last = allRows[allRows.length - 1]!;
      expect(last.valid_to).toBeNull();
      expect(last.title).toBe("Updated");
    });

    test("non-temporal table uses hard delete", async () => {
      const s = defineSchema({
        items: { temporal: false, columns: { name: "text" } },
      });
      const doc = defineDoc("item:", { root: "items", include: [] });

      const ndb = new Database(":memory:");
      createTables(ndb, s);
      ndb.run("INSERT INTO items (id, name) VALUES ('i1', 'Test')");

      const nws = createWs();
      registerDocs(nws, ndb, s, [doc]);

      const sock = mockSocket();
      await nws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "item:i1" }));

      // Verify it loaded
      expect(sock.sent[0].result.items.id).toBe("i1");
    });

    test("remove on temporal table closes row, not deletes", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Ship it", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [{ op: "remove", path: "/tasks/t1" }],
      }));

      // Row still in table, just closed
      const all = db.query("SELECT * FROM tasks WHERE id = 't1'").all() as any[];
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((r: any) => r.valid_to !== null)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple operations in single delta
  // ---------------------------------------------------------------------------

  describe("batch ops", () => {
    test("add + replace + remove in single delta", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Keep", false);
      seedTask("t2", "p1", "Remove", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2,
        action: "delta",
        doc: "project:p1",
        ops: [
          { op: "add", path: "/tasks/t3", value: { title: "New", done: false } },
          { op: "replace", path: "/tasks/t1/title", value: "Kept" },
          { op: "remove", path: "/tasks/t2" },
        ],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });

      const current = db.query("SELECT * FROM current_tasks WHERE project_id = 'p1' ORDER BY id").all() as any[];
      const ids = current.map((r: any) => r.id);
      expect(ids).toContain("t1");
      expect(ids).toContain("t3");
      expect(ids).not.toContain("t2");
      expect(current.find((r: any) => r.id === "t1").title).toBe("Kept");
      expect(current.find((r: any) => r.id === "t3").title).toBe("New");
    });
  });

  // ---------------------------------------------------------------------------
  // Scoped docs with compound scopes
  // ---------------------------------------------------------------------------

  describe("scoped docs", () => {
    test("scope with :docId resolves to doc ID", async () => {
      const s = defineSchema({
        wishlists: { columns: { title: "text" } },
        items: {
          parent: { collection: "wishlists", fk: "wishlist_id" },
          columns: { name: "text" },
        },
      });
      const doc = defineDoc("wishlist:", {
        root: "wishlists",
        include: ["items"],
        scope: { user_id: ":docId" },
      });

      const sdb = new Database(":memory:");
      createTables(sdb, s);

      // Wishlists table needs a user_id column for scoping
      sdb.run("ALTER TABLE wishlists ADD COLUMN user_id TEXT");
      sdb.run("INSERT INTO wishlists (id, title, user_id, valid_from) VALUES ('w1', 'My List', 'peter', ?)", [PAST]);
      sdb.run("INSERT INTO items (id, wishlist_id, name, valid_from) VALUES ('i1', 'w1', 'Book', ?)", [PAST]);

      // Another user's wishlist — should not appear
      sdb.run("INSERT INTO wishlists (id, title, user_id, valid_from) VALUES ('w2', 'Other', 'alice', ?)", [PAST]);

      const sws = createWs();
      registerDocs(sws, sdb, s, [doc]);

      const sock = mockSocket();
      await sws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "wishlist:peter" }));

      expect(sock.sent[0].result).not.toBeNull();
      expect(sock.sent[0].result.wishlists.title).toBe("My List");
    });

    test("static scope binding", async () => {
      const s = defineSchema({
        settings: { columns: { value: "text" } },
      });
      const doc = defineDoc("global:", {
        root: "settings",
        include: [],
        scope: { category: "app" },
      });

      const sdb = new Database(":memory:");
      createTables(sdb, s);
      sdb.run("ALTER TABLE settings ADD COLUMN category TEXT");
      sdb.run("INSERT INTO settings (id, value, category, valid_from) VALUES ('s1', 'dark', 'app', ?)", [PAST]);
      sdb.run("INSERT INTO settings (id, value, category, valid_from) VALUES ('s2', 'en', 'lang', ?)", [PAST]);

      const sws = createWs();
      registerDocs(sws, sdb, s, [doc]);

      const sock = mockSocket();
      await sws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "global:x" }));

      expect(sock.sent[0].result.settings.category).toBe("app");
    });
  });

  // ---------------------------------------------------------------------------
  // Non-temporal hard delete
  // ---------------------------------------------------------------------------

  describe("non-temporal", () => {
    test("remove uses hard DELETE", async () => {
      const s = defineSchema({
        logs: { temporal: false, columns: { msg: "text" } },
        entries: {
          temporal: false,
          parent: { collection: "logs", fk: "log_id" },
          columns: { line: "text" },
        },
      });
      const doc = defineDoc("log:", { root: "logs", include: ["entries"] });

      const ndb = new Database(":memory:");
      createTables(ndb, s);
      ndb.run("INSERT INTO logs (id, msg) VALUES ('l1', 'test')");
      ndb.run("INSERT INTO entries (id, log_id, line) VALUES ('e1', 'l1', 'line1')");
      ndb.run("INSERT INTO entries (id, log_id, line) VALUES ('e2', 'l1', 'line2')");

      const nws = createWs();
      registerDocs(nws, ndb, s, [doc]);

      const sock = mockSocket();
      await nws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "log:l1" }));
      expect(Object.keys(sock.sent[0].result.entries)).toHaveLength(2);

      // Remove an entry — should hard delete
      await nws.websocket.message(sock, JSON.stringify({
        id: 2, action: "delta", doc: "log:l1",
        ops: [{ op: "remove", path: "/entries/e1" }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });
      // Gone from SQL entirely
      expect(ndb.query("SELECT * FROM entries WHERE id = 'e1'").all()).toHaveLength(0);
      // e2 still there
      expect(ndb.query("SELECT * FROM entries WHERE id = 'e2'").all()).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Invalid op path
  // ---------------------------------------------------------------------------

  describe("invalid ops", () => {
    test("invalid path depth throws error", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Test", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      await ws.websocket.message(sock, JSON.stringify({
        id: 2, action: "delta", doc: "project:p1",
        ops: [{ op: "add", path: "/tasks/t1/done/extra", value: true }],
      }));

      expect(sock.sent[1].error).toBeDefined();
      expect(sock.sent[1].error.code).toBe(500);
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-doc fan-out
  // ---------------------------------------------------------------------------

  describe("cross-doc fan-out", () => {
    test("change in one doc broadcasts to overlapping doc", async () => {
      // Two doc definitions that share the "tasks" table
      const taskListDoc = defineDoc("tasklist:", {
        root: "projects",
        include: ["tasks"],
      });

      const fdb = new Database(":memory:");
      createTables(fdb, schema);
      fdb.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', ?)", [PAST]);
      fdb.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p2', 'Beta', 'active', ?)", [PAST]);
      fdb.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'Task A', 0, ?)", [PAST]);

      const fws = createWs();
      // Set up a mock server for publish
      const published: any[] = [];
      fws.setServer({
        publish: (channel: string, data: string) => published.push({ channel, data: JSON.parse(data) }),
      });

      registerDocs(fws, fdb, schema, [projectDoc, taskListDoc]);

      // Open both docs from different clients
      const sock1 = mockSocket("c1");
      const sock2 = mockSocket("c2");
      await fws.websocket.message(sock1, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));
      await fws.websocket.message(sock2, JSON.stringify({ id: 1, action: "open", doc: "tasklist:p1" }));

      // Delta on project doc
      await fws.websocket.message(sock1, JSON.stringify({
        id: 2, action: "delta", doc: "project:p1",
        ops: [{ op: "add", path: "/tasks/t2", value: { title: "New", done: false } }],
      }));

      // Should have published to both project:p1 and tasklist:p1
      const channels = published.map((p) => p.channel);
      expect(channels).toContain("project:p1");
      expect(channels).toContain("tasklist:p1");
    });
  });

  // ---------------------------------------------------------------------------
  // cascadeOn in removeRow
  // ---------------------------------------------------------------------------

  describe("cascadeOn remove", () => {
    test("removing a row cascades via cascadeOn references", async () => {
      const s = defineSchema({
        teams: { columns: { name: "text" } },
        users: {
          parent: { collection: "teams", fk: "team_id" },
          columns: { name: "text" },
        },
        assignments: {
          parent: { collection: "teams", fk: "team_id" },
          columns: { role: "text", user_id: "text" },
          cascadeOn: [{ fk: "user_id", collection: "users" }],
        },
      });

      const doc = defineDoc("team:", {
        root: "teams",
        include: ["users", "assignments"],
      });

      const cdb = new Database(":memory:");
      createTables(cdb, s);
      cdb.run("INSERT INTO teams (id, name, valid_from) VALUES ('t1', 'Eng', ?)", [PAST]);
      cdb.run("INSERT INTO users (id, team_id, name, valid_from) VALUES ('u1', 't1', 'Alice', ?)", [PAST]);
      cdb.run("INSERT INTO assignments (id, team_id, role, user_id, valid_from) VALUES ('a1', 't1', 'lead', 'u1', ?)", [PAST]);
      cdb.run("INSERT INTO assignments (id, team_id, role, user_id, valid_from) VALUES ('a2', 't1', 'member', 'u1', ?)", [PAST]);

      const cws = createWs();
      registerDocs(cws, cdb, s, [doc]);

      const sock = mockSocket();
      await cws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "team:t1" }));
      expect(Object.keys(sock.sent[0].result.assignments)).toHaveLength(2);

      // Remove user — should cascade to assignments via cascadeOn
      await cws.websocket.message(sock, JSON.stringify({
        id: 2, action: "delta", doc: "team:t1",
        ops: [{ op: "remove", path: "/users/u1" }],
      }));

      expect(sock.sent[1].result).toEqual({ ack: true });
      expect(cdb.query("SELECT * FROM current_users WHERE id = 'u1'").all()).toHaveLength(0);
      expect(cdb.query("SELECT * FROM current_assignments WHERE user_id = 'u1'").all()).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Transaction rollback
  // ---------------------------------------------------------------------------

  describe("transactions", () => {
    test("failed op rolls back SQL and restores cache", async () => {
      seedProject("p1", "Alpha", "active");
      seedTask("t1", "p1", "Keep", false);

      const sock = mockSocket();
      await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "project:p1" }));

      // Send a batch where the second op is invalid — should rollback the first
      await ws.websocket.message(sock, JSON.stringify({
        id: 2, action: "delta", doc: "project:p1",
        ops: [
          { op: "add", path: "/tasks/t2", value: { title: "New", done: false } },
          { op: "add", path: "/nonexistent/x", value: {} },
        ],
      }));

      expect(sock.sent[1].error).toBeDefined();

      // t2 should NOT have been persisted (rolled back)
      expect(db.query("SELECT * FROM current_tasks WHERE id = 't2'").all()).toHaveLength(0);

      // Cache should be restored — re-open should show original state
      await ws.websocket.message(sock, JSON.stringify({ id: 3, action: "open", doc: "project:p1" }));
      expect(Object.keys(sock.sent[2].result.tasks)).toHaveLength(1);
      expect(sock.sent[2].result.tasks["t1"]).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// loadDocAt — time-travel
// ---------------------------------------------------------------------------

describe("loadDocAt", () => {
  const PAST1 = "2020-01-01 00:00:00";
  const PAST2 = "2020-06-01 00:00:00";

  test("loads doc at a specific point in time", () => {
    const db = new Database(":memory:");
    createTables(db, schema);

    // Insert a task at PAST1
    db.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', ?)", [PAST1]);
    db.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'Original', 0, ?)", [PAST1]);

    // Update the task at PAST2 (close old, insert new)
    db.run("UPDATE tasks SET valid_to = ? WHERE id = 't1' AND valid_to IS NULL", [PAST2]);
    db.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'Updated', 1, ?)", [PAST2]);

    // At PAST1 + 1 day — should see "Original"
    const doc1 = loadDocAt(db, schema, projectDoc, "p1", "2020-01-02 00:00:00");
    expect(doc1).not.toBeNull();
    expect(doc1.tasks["t1"].title).toBe("Original");
    expect(doc1.tasks["t1"].done).toBe(false); // decoded boolean

    // At PAST2 + 1 day — should see "Updated"
    const doc2 = loadDocAt(db, schema, projectDoc, "p1", "2020-06-02 00:00:00");
    expect(doc2!.tasks["t1"].title).toBe("Updated");
    expect(doc2!.tasks["t1"].done).toBe(true);
  });

  test("returns null for non-existent doc", () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    expect(loadDocAt(db, schema, projectDoc, "nope", "2020-01-01 00:00:00")).toBeNull();
  });

  test("before doc was created returns null", () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    db.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', '2020-06-01 00:00:00')");

    expect(loadDocAt(db, schema, projectDoc, "p1", "2020-01-01 00:00:00")).toBeNull();
  });

  test("loads grandchild collections at point in time", () => {
    const db = new Database(":memory:");
    createTables(db, schema);

    db.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', ?)", [PAST1]);
    db.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'Task', 0, ?)", [PAST1]);
    db.run("INSERT INTO comments (id, task_id, body, author, valid_from) VALUES ('c1', 't1', 'Hello', 'alice', ?)", [PAST1]);

    // Remove comment at PAST2
    db.run("UPDATE comments SET valid_to = ? WHERE id = 'c1' AND valid_to IS NULL", [PAST2]);

    // Before removal — comment exists
    const doc1 = loadDocAt(db, schema, projectDoc, "p1", "2020-03-01 00:00:00");
    expect(Object.keys(doc1!.comments)).toHaveLength(1);

    // After removal — comment gone
    const doc2 = loadDocAt(db, schema, projectDoc, "p1", "2020-07-01 00:00:00");
    expect(Object.keys(doc2!.comments)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

describe("snapshots", () => {
  test("create and resolve snapshot", () => {
    const db = new Database(":memory:");
    const ts = createSnapshot(db, "release-v1", "2020-06-15 12:00:00");
    expect(ts).toBe("2020-06-15 12:00:00");

    const resolved = resolveSnapshot(db, "release-v1");
    expect(resolved).toBe("2020-06-15 12:00:00");
  });

  test("resolve non-existent snapshot returns null", () => {
    const db = new Database(":memory:");
    expect(resolveSnapshot(db, "nope")).toBeNull();
  });

  test("update existing snapshot", () => {
    const db = new Database(":memory:");
    createSnapshot(db, "latest", "2020-01-01 00:00:00");
    createSnapshot(db, "latest", "2020-06-01 00:00:00");
    expect(resolveSnapshot(db, "latest")).toBe("2020-06-01 00:00:00");
  });

  test("use snapshot with loadDocAt", () => {
    const db = new Database(":memory:");
    createTables(db, schema);

    db.run("INSERT INTO projects (id, name, status, valid_from) VALUES ('p1', 'Alpha', 'active', '2020-01-01 00:00:00')");
    db.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'V1', 0, '2020-01-01 00:00:00')");

    // Snapshot before update
    createSnapshot(db, "v1", "2020-03-01 00:00:00");

    // Update task
    db.run("UPDATE tasks SET valid_to = '2020-06-01 00:00:00' WHERE id = 't1' AND valid_to IS NULL");
    db.run("INSERT INTO tasks (id, project_id, title, done, valid_from) VALUES ('t1', 'p1', 'V2', 1, '2020-06-01 00:00:00')");

    const snapshotTime = resolveSnapshot(db, "v1")!;
    const doc = loadDocAt(db, schema, projectDoc, "p1", snapshotTime);
    expect(doc!.tasks["t1"].title).toBe("V1");
  });
});

// ---------------------------------------------------------------------------
// migrateSchema
// ---------------------------------------------------------------------------

describe("migrateSchema", () => {
  test("adds new columns to existing table", () => {
    const db = new Database(":memory:");

    // Create with original schema (no priority on tasks)
    const original = defineSchema({
      projects: { columns: { name: "text" } },
      tasks: {
        parent: { collection: "projects", fk: "project_id" },
        columns: { title: "text" },
      },
    });
    createTables(db, original);

    // Extended schema with new columns
    const extended = defineSchema({
      projects: { columns: { name: "text", status: "text" } },
      tasks: {
        parent: { collection: "projects", fk: "project_id" },
        columns: { title: "text", done: "boolean", priority: "integer?" },
      },
    });

    const applied = migrateSchema(db, extended);
    expect(applied.length).toBeGreaterThan(0);
    expect(applied.some((s) => s.includes("status"))).toBe(true);
    expect(applied.some((s) => s.includes("done"))).toBe(true);
    expect(applied.some((s) => s.includes("priority"))).toBe(true);

    // Verify columns exist
    const info = db.query("PRAGMA table_info(tasks)").all() as any[];
    const colNames = info.map((c: any) => c.name);
    expect(colNames).toContain("done");
    expect(colNames).toContain("priority");
  });

  test("no-op when schema matches", () => {
    const db = new Database(":memory:");
    createTables(db, schema);
    const applied = migrateSchema(db, schema);
    expect(applied).toHaveLength(0);
  });

  test("skips non-existent tables (defers to createTables)", () => {
    const db = new Database(":memory:");
    // Don't create any tables
    const applied = migrateSchema(db, schema);
    expect(applied).toHaveLength(0);
  });

  test("adds FK column from new parent", () => {
    const db = new Database(":memory:");

    // Create both tables without parent relationship
    const original = defineSchema({
      projects: { columns: { name: "text" } },
      items: { columns: { name: "text" } },
    });
    createTables(db, original);

    // Now declare parent relationship
    const withParent = defineSchema({
      projects: { columns: { name: "text" } },
      items: {
        parent: { collection: "projects", fk: "project_id" },
        columns: { name: "text" },
      },
    });

    const applied = migrateSchema(db, withParent);
    expect(applied.some((s) => s.includes("project_id"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateOps
// ---------------------------------------------------------------------------

describe("validateOps", () => {
  test("valid ops return empty array", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "add", path: "/tasks/t1", value: { title: "Test", done: false } },
      { op: "replace", path: "/tasks/t1/title", value: "Updated" },
      { op: "remove", path: "/tasks/t1" },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("unknown collection", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "add", path: "/nonexistent/x", value: {} },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Unknown collection");
  });

  test("empty path", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/", value: "x" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Empty path");
  });

  test("add missing required field (json type)", () => {
    const s = defineSchema({
      items: { columns: { data: "json", name: "text" } },
    });
    const doc = defineDoc("item:", { root: "items", include: [] });

    const errors = validateOps(s, doc, [
      { op: "add", path: "/items/x", value: { data: { a: 1 } } },
    ]);
    // name is required (non-nullable, no default) and missing, but text has a type default ("")
    expect(errors).toHaveLength(0);
  });

  test("add with wrong field type", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "add", path: "/tasks/t1", value: { title: 123, done: "not-bool" } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.message.includes("must be a string"))).toBe(true);
    expect(errors.some((e) => e.message.includes("must be a boolean"))).toBe(true);
  });

  test("replace with wrong field type", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/tasks/t1/done", value: "yes" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must be a boolean");
  });

  test("replace unknown field", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/tasks/t1/nonexistent", value: "x" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("Unknown field");
  });

  test("null on non-nullable field", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/tasks/t1/title", value: null },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("cannot be null");
  });

  test("null on nullable field is ok", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/tasks/t1/priority", value: null },
    ]);
    expect(errors).toHaveLength(0);
  });

  test("integer type validation", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "replace", path: "/tasks/t1/priority", value: 3.14 },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must be an integer");
  });

  test("real type validation", () => {
    const s = defineSchema({
      items: { columns: { score: "real" } },
    });
    const doc = defineDoc("item:", { root: "items", include: [] });

    const errors = validateOps(s, doc, [
      { op: "replace", path: "/items/x/score", value: "not-a-number" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must be a number");
  });

  test("add value must be an object", () => {
    const errors = validateOps(schema, projectDoc, [
      { op: "add", path: "/tasks/t1", value: "not-an-object" },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("must be an object");
  });
});
