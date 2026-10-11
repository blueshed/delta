/**
 * The runtime CLI as an agent runs it (todo #11): a subprocess against a
 * server started here (SQLite in memory, a free-form document, the same
 * behind an auth module, and Postgres in process), read back as one JSON line
 * per event.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { defineSchema, defineDoc, createTables, registerDocs } from "../src/server/sqlite";
import { createWs, registerDoc } from "../src/server/server";
import { wireAuth, type DeltaAuth } from "../src/server/auth";
import { applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, generateSql, registerDocType } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

const CLI = resolve(import.meta.dir, "..", "cli.ts");
const schema = defineSchema({ items: { columns: { name: "text" } } });
const items = defineDoc("items:", { root: "items", include: [] });

const auth: DeltaAuth<{ id: number }> = {
  actions: {
    authenticate: async ({ token }, client) => {
      if (token !== "s3cret") return { error: "Bad token" };
      client.data.identity = { id: 1 };
      return { result: { id: 1 } };
    },
  },
  gate: (c: any) => c.data?.identity ?? { error: "Authentication required" },
};

function serve(withAuth: boolean, dir?: string) {
  const db = new Database(":memory:");
  createTables(db, schema);
  const ws = createWs();
  if (withAuth) wireAuth(ws, auth);
  registerDocs(ws, db, schema, [items], [], withAuth ? { auth, shared: true } : {});
  if (dir) void registerDoc(ws, "notes", { file: join(dir, "notes.json"), empty: { lines: {} } });
  const server = Bun.serve({ port: 0, routes: { [ws.path]: ws.upgrade }, websocket: ws.websocket });
  ws.setServer(server);
  return { server, url: `ws://localhost:${server.port}/ws` };
}

let dir: string;
let open: ReturnType<typeof serve>;
let guarded: ReturnType<typeof serve>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "delta-cli-"));
  open = serve(false, dir);
  guarded = serve(true);
});

afterAll(() => {
  open.server.stop(true);
  guarded.server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

/** Start the CLI with only the env it is given (no DELTA_TOKEN or DELTA_WS_URL from outside). */
function spawn(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", CLI, ...args], {
    cwd: dir, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
}

async function run(args: string[], env?: Record<string, string>) {
  const proc = spawn(args, env);
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const lines = args.includes("--json") ? stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code, stdout, stderr, lines };
}

/** A watch that has printed its state line: the rest of its output, read after. */
async function watching(args: string[]) {
  const proc = spawn(["watch", ...args]);
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  return {
    proc,
    async end() {
      const code = await proc.exited;
      for (let r = await reader.read(); !r.done; r = await reader.read()) text += new TextDecoder().decode(r.value);
      return { code, lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)), stderr: await new Response(proc.stderr).text() };
    },
  };
}

describe("delta open / delta / call --json: one JSON line, stderr empty", () => {
  test("open prints the doc's state as one line", async () => {
    const { code, stdout, stderr, lines } = await run(["open", "items:", "--url", open.url, "--json"]);
    expect([code, stderr]).toEqual([0, ""]);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(lines[0]).toEqual({ items: {} });
  });

  test("without --json, a person's output is as it was: pretty JSON", async () => {
    const { code, stdout } = await run(["open", "items:", "--url", open.url]);
    expect(code).toBe(0);
    expect(stdout).toBe(JSON.stringify({ items: {} }, null, 2) + "\n");
  });

  test("delta on SQLite with no ledger answers the ops as applied, the row the server named", async () => {
    const { code, lines } = await run(["delta", "items:", '[{"op":"add","path":"/items/-","value":{"name":"a"}}]', "--url", open.url, "--json"]);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ ack: true, ops: [{ op: "add", path: expect.stringMatching(/^\/items\/\d+$/), value: { name: "a" } }] });
  });

  test("delta on a document that answers { ack } alone prints the ops from its broadcast", async () => {
    const { code, lines } = await run(["delta", "notes", '[{"op":"add","path":"/lines/l1","value":"hi"}]', "--url", open.url, "--json"]);
    expect(code).toBe(0);
    expect(lines).toEqual([{ ack: true, ops: [{ op: "add", path: "/lines/l1", value: "hi" }] }]);
  });

  test("delta prints its own ops, not another writer's that lands between its open and its write", async () => {
    const ws = createWs();
    let handle: Awaited<ReturnType<typeof registerDoc>>;
    let n = 0;
    ws.on("open", (msg) => { if (msg.doc === "busy") setImmediate(() => handle.applyAndBroadcast([{ op: "add", path: `/lines/theirs${n++}`, value: "theirs" }])); });
    handle = await registerDoc(ws, "busy", { file: join(dir, "busy.json"), empty: { lines: {} } });
    const server = Bun.serve({ port: 0, routes: { [ws.path]: ws.upgrade }, websocket: ws.websocket });
    ws.setServer(server);
    try {
      const { code, lines } = await run(["delta", "busy", '[{"op":"add","path":"/lines/mine","value":"mine"}]', "--url", `ws://localhost:${server.port}/ws`, "--json"]);
      expect(code).toBe(0);
      expect(lines).toEqual([{ ack: true, ops: [{ op: "add", path: "/lines/mine", value: "mine" }] }]);
    } finally {
      server.stop(true);
    }
  });

  test("an error is one {error} line on stderr, nothing on stdout, exit 1", async () => {
    const { code, stdout, stderr } = await run(["open", "nobody:", "--url", open.url, "--json"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr.trim())).toMatchObject({ error: { code: 404 } });
  });

  test("a server that is not there: exit 1, the reason on stderr", async () => {
    const { code, stderr } = await run(["open", "items:", "--url", "ws://localhost:1/ws", "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr.trim()).error.message).toContain("WebSocket");
  });
});

describe("delta watch ends when told to", () => {
  const add = (name: string) => run(["delta", "items:", JSON.stringify([{ op: "add", path: "/items/-", value: { name } }]), "--url", open.url, "--json"]);

  test("--count 1: the state, one broadcast, exit 0", async () => {
    const w = await watching(["items:", "--url", open.url, "--json", "--count", "1"]);
    await add("b");
    const { code, lines, stderr } = await w.end();
    expect([code, stderr]).toEqual([0, ""]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ doc: "items:", state: { items: expect.any(Object) } });
    expect(lines[1]).toMatchObject({ doc: "items:", ops: [{ op: "add", value: { name: "b" } }] });
  });

  test("--for 200: the state alone when nothing is written, exit 0", async () => {
    const started = Date.now();
    const { code, lines } = await run(["watch", "items:", "--url", open.url, "--json", "--for", "200"]);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  test('--until "add /items": ends at the first add of an item, exit 0', async () => {
    const w = await watching(["items:", "--url", open.url, "--json", "--until", "add /items"]);
    await add("c");
    const { code, lines } = await w.end();
    expect(code).toBe(0);
    expect(lines.at(-1)).toMatchObject({ ops: [{ op: "add", value: { name: "c" } }] });
  });

  test("--until that is not an op and a path: exit 2", async () => {
    const { code, stderr } = await run(["watch", "items:", "--url", open.url, "--until", "move /items"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--until");
  });

  test("the server going away ends a watch with exit 1", async () => {
    const gone = serve(false);
    const w = await watching(["items:", "--url", gone.url, "--json"]);
    gone.server.stop(true);
    const { code, stderr } = await w.end();
    expect(code).toBe(1);
    expect(JSON.parse(stderr.trim()).error.message).toBe("socket closed");
  });
});

describe("an auth-enabled server, the token in band", () => {
  test("without a token: 401 on stderr, exit 1", async () => {
    const { code, stderr } = await run(["open", "items:", "--url", guarded.url, "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr.trim())).toMatchObject({ error: { code: 401 } });
  });

  test("--token signs in first, then opens", async () => {
    const { code, lines } = await run(["open", "items:", "--url", guarded.url, "--json", "--token", "s3cret"]);
    expect(code).toBe(0);
    expect(lines).toEqual([{ items: {} }]);
  });

  test("DELTA_TOKEN does the same, for a watch too", async () => {
    const { code, lines } = await run(["watch", "items:", "--url", guarded.url, "--json", "--count", "0"], { DELTA_TOKEN: "s3cret" });
    expect(code).toBe(0);
    expect(lines).toEqual([{ doc: "items:", state: { items: {} } }]);
  });

  test("a wrong token: the sign-in's 401, exit 1", async () => {
    const { code, stderr } = await run(["open", "items:", "--url", guarded.url, "--json", "--token", "nope"]);
    expect(code).toBe(1);
    expect(JSON.parse(stderr.trim())).toEqual({ error: { code: 401, message: "Bad token" } });
  });
});

describe("Postgres with no ledger (in process, PGlite)", () => {
  test("delta answers { ack, version }; the ops as applied come from the write's broadcast", async () => {
    const pool = await openPglite();
    await applyFramework(pool);
    await applySql(pool, generateSql(schema, [items]));
    const ws = createWs();
    registerDocType(docTypeFromDef(items, pool));
    const listener = await createDocListener(ws, pool);
    const server = Bun.serve({ port: 0, routes: { [ws.path]: ws.upgrade }, websocket: ws.websocket });
    ws.setServer(server);
    try {
      const { code, lines } = await run(["delta", "items:", '[{"op":"add","path":"/items/-","value":{"name":"pg"}}]', "--url", `ws://localhost:${server.port}/ws`, "--json"]);
      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ ack: true, ops: [{ op: "add", path: "/items/1", value: { id: 1, name: "pg" } }] });
    } finally {
      server.stop(true);
      await listener.destroy();
      clearRegistry();
      await pool.end();
    }
  });
});
