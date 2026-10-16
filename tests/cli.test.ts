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
import { createWs, registerDoc, registerMethod } from "../src/server/server";
import { wireAuth, type DeltaAuth } from "../src/server/auth";
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
  registerMethod(ws, "nothing", () => undefined);
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
    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe(0);
    expect(error.message).toContain("WebSocket");
  });
});

describe("answers and arguments", () => {
  test("a method that returns nothing prints null, not undefined", async () => {
    const { code, stdout } = await run(["call", "nothing", "--url", open.url, "--json"]);
    expect([code, stdout]).toEqual([0, "null\n"]);
  });

  const refused: [string, string[]][] = [
    ["a command with no doc name", ["open"]],
    ["no command", []],
    ["an unknown command", ["frobnicate"]],
    ["an unknown flag", ["open", "items:", "--frobnicate"]],
    ["ops that are not JSON", ["delta", "items:", "[nope"]],
    ["a --count that is not a whole number", ["watch", "items:", "--count", "-1"]],
  ];
  for (const [what, args] of refused) {
    test(`${what}: exit 2, one {error: {code: 0, message}} line on stderr`, async () => {
      const { code, stdout, stderr } = await run([...args, "--url", open.url, "--json"]);
      expect([code, stdout]).toEqual([2, ""]);
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(stderr)).toEqual({ error: { code: 0, message: expect.any(String) } });
    });
  }

  test("a person is shown the usage with a bad argument", async () => {
    const { code, stderr } = await run(["open"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Usage:");
    expect(stderr).toContain("delta: open takes a <docName>");
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
    expect(JSON.parse(stderr.trim())).toEqual({ error: { code: 0, message: "socket closed" } });
  });
});

describe("a server that never answers: --timeout, and --for from before connecting", () => {
  // a port that accepts and says nothing (no upgrade), and a socket that upgrades and never answers
  const mute = Bun.listen({ hostname: "localhost", port: 0, socket: { data() {} } });
  const deaf = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response(null, { status: 400 })), websocket: { message() {} } });
  afterAll(() => { mute.stop(true); deaf.stop(true); });

  const timedOut = async (args: string[], within: number) => {
    const started = Date.now();
    const { code, stdout, stderr } = await run([...args, "--json"]);
    expect([code, stdout]).toEqual([1, ""]);
    expect(JSON.parse(stderr)).toEqual({ error: { code: 0, message: expect.stringContaining("no answer") } });
    expect(Date.now() - started).toBeLessThan(within);
  };

  test("connecting to a port that never upgrades: exit 1 at --timeout", () =>
    timedOut(["open", "items:", "--url", `ws://localhost:${mute.port}/ws`, "--timeout", "300"], 3000));

  test("an open that is never answered: exit 1 at --timeout", () =>
    timedOut(["open", "items:", "--url", `ws://localhost:${deaf.port}/ws`, "--timeout", "300"], 3000));

  test("a sign-in that is never answered: exit 1 at --timeout", () =>
    timedOut(["call", "x", "--url", `ws://localhost:${deaf.port}/ws`, "--token", "t", "--timeout", "300"], 3000));

  test("watch --for counts from before connecting: never open, exit 1 when it runs out", () =>
    timedOut(["watch", "items:", "--url", `ws://localhost:${mute.port}/ws`, "--for", "300"], 3000));
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

describe("delta link: the first person's link, made in the app's SQLite file", () => {
  test("prints a link that signs them in once, at the site given; refuses without one, and points Postgres at dzql", async () => {
    const { Database } = await import("bun:sqlite");
    const { hashToken, sqliteLinkStore } = await import("../src/server/auth-link");
    const file = join(dir, "link.db");
    new Database(file).close();
    const made = await run(["link", file, "1", "--origin", "https://my.app", "--opens", "/people", "--json"]);
    expect(made.code).toBe(0);
    expect(made.lines[0].url).toMatch(/^https:\/\/my\.app\/#\/in\/[\w-]{43}$/);
    const db = new Database(file);
    try {
      const token = made.lines[0].url.split("#/in/")[1];
      expect(await sqliteLinkStore(db).link(hashToken(token))).toMatchObject({ person: 1, opens: "/people", used: null });
    } finally {
      db.close();
    }
    expect((await run(["link", file, "1"])).stderr).toContain("pass --origin");
    expect((await run(["link", file, "Ann"])).code).toBe(2);
    expect((await run(["link", "postgres://db/app", "1"])).stderr).toContain("dzql link");
  });
});
