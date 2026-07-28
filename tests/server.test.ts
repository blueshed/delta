import { describe, test, expect, afterAll } from "bun:test";
import {
  createWs, registerDoc, registerMethod, normalizeForBroadcast,
  trackSubscribe, trackUnsubscribe, dropClientSubscriptions,
} from "../src/server/server";
import { setLogLevel } from "../src/server/logger";
import { unlinkSync } from "fs";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock ws with send, subscribe, unsubscribe, data, readyState. */
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
// createWs — unit tests
// ---------------------------------------------------------------------------

describe("createWs", () => {
  test("defaults path to /ws", () => {
    const ws = createWs();
    expect(ws.path).toBe("/ws");
  });

  test("custom path", () => {
    const ws = createWs({ path: "/live" });
    expect(ws.path).toBe("/live");
  });

  test("upgrade is a function", () => {
    const ws = createWs();
    expect(typeof ws.upgrade).toBe("function");
  });

  test("websocket config uses defaults", () => {
    const ws = createWs();
    expect(ws.websocket.idleTimeout).toBe(60);
    expect(ws.websocket.sendPings).toBe(true);
    expect(ws.websocket.publishToSelf).toBe(true);
  });

  test("websocket config accepts overrides", () => {
    const ws = createWs({ idleTimeout: 120, sendPings: false });
    expect(ws.websocket.idleTimeout).toBe(120);
    expect(ws.websocket.sendPings).toBe(false);
  });

  test("open tracks client, close removes it", () => {
    const ws = createWs();
    const sock = mockSocket("c1");
    ws.websocket.open(sock);
    // sendTo should reach the client
    ws.sendTo("c1", { hello: true });
    expect(sock.sent).toEqual([{ hello: true }]);

    ws.websocket.close(sock);
    sock.sent.length = 0;
    ws.sendTo("c1", { hello: true });
    expect(sock.sent).toEqual([]);
  });

  test("action routing dispatches to handler", async () => {
    const ws = createWs();
    const received: any[] = [];
    ws.on("greet", (msg, _ws, respond) => {
      received.push(msg);
      respond({ result: "hi" });
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "greet", name: "world" }));
    expect(received).toHaveLength(1);
    expect(received[0].name).toBe("world");
    expect(sock.sent).toEqual([{ id: 1, result: "hi" }]);
  });

  test("unknown action returns error", async () => {
    const ws = createWs();
    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "nope" }));
    expect(sock.sent[0].error.message).toContain("Unknown action: nope");
  });

  test("unknown action without id is silent", async () => {
    const ws = createWs();
    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ action: "nope" }));
    expect(sock.sent).toEqual([]);
  });

  test("message without action dispatches to _raw", async () => {
    const ws = createWs();
    const received: any[] = [];
    ws.on("_raw", (msg) => { received.push(msg); });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ data: 42 }));
    expect(received).toEqual([{ data: 42 }]);
  });

  test("handler error returns error response", async () => {
    const ws = createWs();
    ws.on("boom", () => { throw new Error("kaboom"); });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "boom" }));
    expect(sock.sent[0].error.message).toBe("kaboom");
  });

  test("only first respond() takes effect", async () => {
    const ws = createWs();
    ws.on("multi", (_msg, _ws, respond) => {
      respond({ result: "first" });
      respond({ result: "second" });
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "multi" }));
    expect(sock.sent).toEqual([{ id: 1, result: "first" }]);
  });

  test("unmatched handler returns no-match error", async () => {
    const ws = createWs();
    ws.on("selective", (msg, _ws, _respond) => {
      // doesn't call respond
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "selective" }));
    expect(sock.sent[0].error.message).toContain("No handler matched");
  });
});

// ---------------------------------------------------------------------------
// normalizeForBroadcast — field-level ops become whole-row replaces
// ---------------------------------------------------------------------------

describe("normalizeForBroadcast", () => {
  const doc = {
    cards: {
      "5": { id: 5, title: "edited", done: true },
      "9": { id: 9, title: "other" },
    },
    settings: { theme: "dark" },
  };

  test("depth>=3 field op becomes a whole-row replace read from doc state", () => {
    const ops = normalizeForBroadcast(doc, [
      { op: "replace", path: "/cards/5/title", value: "edited" },
    ]);
    expect(ops).toEqual([
      { op: "replace", path: "/cards/5", value: doc.cards["5"] },
    ]);
  });

  test("depth<=2 ops pass through untouched", () => {
    const ops = [
      { op: "replace", path: "/settings/theme", value: "light" },
      { op: "add", path: "/cards/-", value: { id: 1 } },
      { op: "remove", path: "/cards/9" },
      { op: "replace", path: "", value: doc },
    ] as const;
    expect(normalizeForBroadcast(doc, [...ops])).toEqual([...ops]);
  });

  test("multiple field ops on one row collapse to a single replace", () => {
    const ops = normalizeForBroadcast(doc, [
      { op: "replace", path: "/cards/5/title", value: "edited" },
      { op: "replace", path: "/cards/5/done", value: true },
    ]);
    expect(ops).toEqual([
      { op: "replace", path: "/cards/5", value: doc.cards["5"] },
    ]);
  });

  test("a field op on a row removed later in the same batch is dropped", () => {
    const afterApply = { cards: { "9": { id: 9 } } }; // row 5 already gone
    const ops = normalizeForBroadcast(afterApply, [
      { op: "replace", path: "/cards/5/title", value: "x" },
      { op: "remove", path: "/cards/5" },
    ]);
    expect(ops).toEqual([{ op: "remove", path: "/cards/5" }]);
  });

  test("escaped path segments survive the rewrite", () => {
    const d = { "a/b": { "k~x": { v: 1 } } };
    const ops = normalizeForBroadcast(d, [
      { op: "replace", path: "/a~1b/k~0x/v", value: 1 },
    ]);
    expect(ops).toEqual([
      { op: "replace", path: "/a~1b/k~0x", value: { v: 1 } },
    ]);
  });

  test("registerDoc broadcasts the normalized ops on the wire", async () => {
    const tmpFile = `/tmp/railroad-test-normalize-${Date.now()}.json`;
    const ws = createWs();
    const published: any[] = [];
    ws.setServer({ publish: (_ch: string, data: string) => published.push(JSON.parse(data)) });
    const handle = await registerDoc(ws, "board", {
      file: tmpFile,
      empty: { cards: { "5": { id: 5, title: "before" } } as Record<string, any> },
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({
      id: 1, action: "delta", doc: "board",
      ops: [{ op: "replace", path: "/cards/5/title", value: "after" }],
    }));

    expect(handle.getDoc().cards["5"]!.title).toBe("after");
    expect(published[0].ops).toEqual([
      { op: "replace", path: "/cards/5", value: { id: 5, title: "after" } },
    ]);
    try { unlinkSync(tmpFile); } catch {}
  });
});

// ---------------------------------------------------------------------------
// registerDoc — unit tests with temp file
// ---------------------------------------------------------------------------

describe("registerDoc", () => {
  const tmpFile = `/tmp/railroad-test-doc-${Date.now()}.json`;

  afterAll(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  test("loads empty doc when file missing", async () => {
    const ws = createWs();
    const handle = await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });
    expect(handle.getDoc()).toEqual({ items: [] });
  });

  test("open action returns doc and subscribes", async () => {
    const ws = createWs();
    await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "todo" }));
    expect(sock.sent[0]).toEqual({ id: 1, result: { items: [] } });
    expect(sock.subscriptions.has("todo")).toBe(true);
  });

  test("delta action applies ops and persists", async () => {
    const ws = createWs();
    const handle = await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({
      id: 1,
      action: "delta",
      doc: "todo",
      ops: [{ op: "add", path: "/items/-", value: "buy milk" }],
    }));

    expect(sock.sent[0]).toEqual({ id: 1, result: { ack: true } });
    expect(handle.getDoc()).toEqual({ items: ["buy milk"] });

    // verify persisted to disk
    const persisted = await Bun.file(tmpFile).json();
    expect(persisted.items).toContain("buy milk");
  });

  test("close action unsubscribes", async () => {
    const ws = createWs();
    await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });

    const sock = mockSocket();
    // open first
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "todo" }));
    expect(sock.subscriptions.has("todo")).toBe(true);

    // close
    await ws.websocket.message(sock, JSON.stringify({ id: 2, action: "close", doc: "todo" }));
    expect(sock.subscriptions.has("todo")).toBe(false);
    expect(sock.sent[1]).toEqual({ id: 2, result: { ack: true } });
  });

  test("open for wrong doc name is ignored", async () => {
    const ws = createWs();
    await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "open", doc: "other" }));
    // no handler matched
    expect(sock.sent[0].error.message).toContain("No handler matched");
  });

  test("loads existing file on startup", async () => {
    await Bun.write(tmpFile, JSON.stringify({ items: ["existing"] }));

    const ws = createWs();
    const handle = await registerDoc(ws, "todo", {
      file: tmpFile,
      empty: { items: [] as string[] },
    });
    expect(handle.getDoc()).toEqual({ items: ["existing"] });
  });
});

// ---------------------------------------------------------------------------
// registerMethod — unit tests
// ---------------------------------------------------------------------------

describe("registerMethod", () => {
  test("call dispatches to method handler", async () => {
    const ws = createWs();
    registerMethod(ws, "status", () => ({ version: "1.0" }));

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "status" }));
    expect(sock.sent[0]).toEqual({ id: 1, result: { version: "1.0" } });
  });

  test("call with params", async () => {
    const ws = createWs();
    registerMethod(ws, "add", (params) => params.a + params.b);

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({
      id: 1, action: "call", method: "add", params: { a: 2, b: 3 },
    }));
    expect(sock.sent[0]).toEqual({ id: 1, result: 5 });
  });

  test("call wrong method is not matched", async () => {
    const ws = createWs();
    registerMethod(ws, "status", () => "ok");

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "other" }));
    expect(sock.sent[0].error.message).toContain("No handler matched");
  });

  test("async method handler", async () => {
    const ws = createWs();
    registerMethod(ws, "slow", async () => {
      await Bun.sleep(10);
      return "done";
    });

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "slow" }));
    expect(sock.sent[0]).toEqual({ id: 1, result: "done" });
  });

  test("call to a private (_) method is denied before any handler runs", async () => {
    const ws = createWs();
    // a catch-all call handler that would leak if the gate didn't run first
    ws.on("call", (_msg, _ws, respond) => respond({ result: "leaked!" }));

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "_secret" }));
    expect(sock.sent[0].error.message).toContain("Private method: _secret");
  });

  test("private method call without id is silent", async () => {
    const ws = createWs();
    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ action: "call", method: "_secret" }));
    expect(sock.sent).toEqual([]);
  });

  test("registerMethod refuses to register a private (_) name", () => {
    const ws = createWs();
    expect(() => registerMethod(ws, "_helper", () => 1)).toThrow(/private/);
  });

  test("public methods are unaffected by the private gate", async () => {
    const ws = createWs();
    registerMethod(ws, "ok", () => "fine");

    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "ok" }));
    expect(sock.sent[0]).toEqual({ id: 1, result: "fine" });
  });
});

// ---------------------------------------------------------------------------
// Integration — real Bun.serve + WebSocket
// ---------------------------------------------------------------------------

describe("integration", () => {
  const ws = createWs({ path: "/ws" });
  const tmpFile = `/tmp/railroad-test-int-${Date.now()}.json`;
  let server: ReturnType<typeof Bun.serve>;
  let port: number;

  afterAll(async () => {
    server?.stop(true);
    try { unlinkSync(tmpFile); } catch {}
  });

  test("server starts and accepts WebSocket", async () => {
    await registerDoc(ws, "msg", { file: tmpFile, empty: { text: "" } });
    registerMethod(ws, "ping", () => "pong");

    server = Bun.serve({ port: 0, routes: { [ws.path]: ws.upgrade }, websocket: ws.websocket });
    ws.setServer(server);
    port = server.port!;

    expect(port).toBeGreaterThan(0);
  });

  function connect(clientId?: string): Promise<WebSocket> {
    const query = clientId ? `?clientId=${clientId}` : "";
    const sock = new WebSocket(`ws://localhost:${port}/ws${query}`);
    return new Promise((resolve, reject) => {
      sock.addEventListener("open", () => resolve(sock));
      sock.addEventListener("error", reject);
    });
  }

  function request(sock: WebSocket, msg: any): Promise<any> {
    const id = Math.random();
    return new Promise((resolve) => {
      const handler = (ev: MessageEvent) => {
        const data = JSON.parse(ev.data);
        if (data.id === id) {
          sock.removeEventListener("message", handler);
          resolve(data);
        }
      };
      sock.addEventListener("message", handler);
      sock.send(JSON.stringify({ ...msg, id }));
    });
  }

  test("open doc over WebSocket", async () => {
    const sock = await connect();
    const res = await request(sock, { action: "open", doc: "msg" });
    expect(res.result).toEqual({ text: "" });
    sock.close();
  });

  test("delta op over WebSocket", async () => {
    const sock = await connect();
    await request(sock, { action: "open", doc: "msg" });

    const res = await request(sock, {
      action: "delta",
      doc: "msg",
      ops: [{ op: "replace", path: "/text", value: "hello" }],
    });
    expect(res.result).toEqual({ ack: true });

    // re-open to verify state
    const res2 = await request(sock, { action: "open", doc: "msg" });
    expect(res2.result.text).toBe("hello");
    sock.close();
  });

  test("call method over WebSocket", async () => {
    const sock = await connect();
    const res = await request(sock, { action: "call", method: "ping" });
    expect(res.result).toBe("pong");
    sock.close();
  });

  test("private (_) method call is denied over WebSocket", async () => {
    const sock = await connect();
    const res = await request(sock, { action: "call", method: "_secret" });
    expect(res.error.message).toContain("Private method");
    sock.close();
  });

  test("broadcast reaches other subscribers", async () => {
    const sock1 = await connect("c1");
    const sock2 = await connect("c2");

    // both subscribe
    await request(sock1, { action: "open", doc: "msg" });
    await request(sock2, { action: "open", doc: "msg" });

    // collect notifications on sock2
    const notifications: any[] = [];
    sock2.addEventListener("message", (ev) => {
      const data = JSON.parse(ev.data);
      if (!data.id) notifications.push(data);
    });

    // sock1 sends a delta
    await request(sock1, {
      action: "delta",
      doc: "msg",
      ops: [{ op: "replace", path: "/text", value: "broadcast" }],
    });

    // give pub/sub a tick
    await Bun.sleep(50);
    expect(notifications.some((n) => n.doc === "msg" && n.ops?.length)).toBe(true);

    sock1.close();
    sock2.close();
  });

  test("unknown action returns error", async () => {
    const sock = await connect();
    const res = await request(sock, { action: "nope" });
    expect(res.error.message).toContain("Unknown action");
    sock.close();
  });

  test("clientId from query param is used", async () => {
    const sock = await connect("my-id");
    // sendTo should work with the provided clientId
    ws.sendTo("my-id", { custom: true });
    const msg = await new Promise<any>((resolve) => {
      sock.addEventListener("message", (ev) => resolve(JSON.parse(ev.data)));
    });
    expect(msg).toEqual({ custom: true });
    sock.close();
  });
});

// ---------------------------------------------------------------------------
// Review fixes — subscription teardown (#5) + clientId collision (#24)
// ---------------------------------------------------------------------------

describe("subscription tracking + teardown", () => {
  test("dropClientSubscriptions unsubscribes every tracked channel (logout teardown)", () => {
    const client = mockSocket("c1");
    trackSubscribe(client, "doc:a");
    trackSubscribe(client, "doc:b");
    expect(client.subscriptions.has("doc:a")).toBe(true);
    expect(client.subscriptions.has("doc:b")).toBe(true);
    expect([...(client.data as any).channels]).toEqual(["doc:a", "doc:b"]);

    dropClientSubscriptions(client);
    expect(client.subscriptions.size).toBe(0);
    expect((client.data as any).channels.size).toBe(0);
  });

  test("trackUnsubscribe forgets a single channel", () => {
    const client = mockSocket("c1");
    trackSubscribe(client, "doc:a");
    trackSubscribe(client, "doc:b");
    trackUnsubscribe(client, "doc:a");
    expect(client.subscriptions.has("doc:a")).toBe(false);
    expect(client.subscriptions.has("doc:b")).toBe(true);
    expect((client.data as any).channels.has("doc:a")).toBe(false);
  });
});

describe("clientId collision (#24)", () => {
  test("reconnect with same clientId reclaims sendTo addressing once the old socket is gone", () => {
    const ws = createWs();
    const ws1 = mockSocket("foo");
    ws.websocket.open(ws1);
    ws.sendTo("foo", { n: 1 });
    expect(ws1.sent.at(-1)).toEqual({ n: 1 });

    // ws1 drops (dead). ws2 reconnects reusing "foo" — should reclaim it.
    (ws1 as any).readyState = 3; // CLOSED
    const ws2 = mockSocket("foo");
    ws.websocket.open(ws2);
    expect(ws2.data.clientId).toBe("foo");
    ws.sendTo("foo", { n: 2 });
    expect(ws2.sent.at(-1)).toEqual({ n: 2 });
    expect(ws1.sent.at(-1)).toEqual({ n: 1 }); // dead socket got nothing new

    // ws1's late close must NOT delete ws2's mapping.
    ws.websocket.close(ws1);
    ws.sendTo("foo", { n: 3 });
    expect(ws2.sent.at(-1)).toEqual({ n: 3 });
  });

  test("a different LIVE socket colliding on a clientId is given a fresh id (no hijack)", () => {
    const ws = createWs();
    const a = mockSocket("shared");
    ws.websocket.open(a);
    const b = mockSocket("shared"); // live, collides with live `a`
    ws.websocket.open(b);
    expect(b.data.clientId).not.toBe("shared");
    // `a` still owns "shared".
    ws.sendTo("shared", { to: "a" });
    expect(a.sent.at(-1)).toEqual({ to: "a" });
  });
});

// Local temp-file helper for the blocks below (the older describes each
// declare their own `tmpFile` const inside their scope).
const persistTmpFiles: string[] = [];
function tmpFile(tag: string): string {
  const f = `/tmp/delta-server-test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
  persistTmpFiles.push(f);
  return f;
}
afterAll(() => {
  for (const f of persistTmpFiles) { try { unlinkSync(f); } catch {} }
});

// ---------------------------------------------------------------------------
// Malformed frames (TODO.md #2)
//
// `JSON.parse` used to sit OUTSIDE the try in an async handler, so any
// non-JSON frame rejected with nothing to catch it — an unhandled rejection
// any client could fire at will, and a remote kill for a process running a
// strict `unhandledRejection` handler.
// ---------------------------------------------------------------------------

describe("malformed frames", () => {
  /** Run `fn`, failing if it produces an unhandled rejection. */
  async function withRejectionWatch(fn: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onReject = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onReject);
    try {
      await fn();
      // Unhandled rejections surface on a later turn, so give them one.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onReject);
    }
    return seen;
  }

  test("a non-JSON frame does not produce an unhandled rejection", async () => {
    const ws = createWs();
    const sock = mockSocket();
    const rejections = await withRejectionWatch(async () => {
      await ws.websocket.message(sock, "not json at all");
    });
    expect(rejections).toEqual([]);
    // Nothing to answer on: the id lives inside the frame we couldn't parse.
    expect(sock.sent).toEqual([]);
  });

  test("the socket still serves valid frames afterwards", async () => {
    const ws = createWs();
    registerMethod(ws, "ping", () => "pong");
    const sock = mockSocket();

    await ws.websocket.message(sock, "}{ broken");
    await ws.websocket.message(sock, JSON.stringify({ id: 1, action: "call", method: "ping" }));

    expect(sock.sent.find((m: any) => m.id === 1)?.result).toBe("pong");
  });

  test("a valid frame whose handler throws still answers on its id", async () => {
    // The parse move must not swallow the pre-existing error path.
    const ws = createWs();
    ws.on("boom", () => { throw new Error("kaboom"); });
    const sock = mockSocket();
    await ws.websocket.message(sock, JSON.stringify({ id: 7, action: "boom" }));
    expect(sock.sent.find((m: any) => m.id === 7)?.error?.message).toBe("kaboom");
  });

  test("non-JSON frames are not misrouted to _raw handlers", async () => {
    // `_raw` is for well-formed frames that carry no `action`; a parse failure
    // must not look like one.
    const ws = createWs();
    let rawCalls = 0;
    ws.on("_raw", () => { rawCalls++; });
    const sock = mockSocket();

    await ws.websocket.message(sock, "still not json");
    expect(rawCalls).toBe(0);

    await ws.websocket.message(sock, JSON.stringify({ hello: "world" }));
    expect(rawCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// persist() serialization (TODO.md addendum A2)
//
// `applyAndBroadcast` fired persist() without await, queue or catch: two rapid
// deltas raced whole-file Bun.writes and the file could settle on the OLDER
// snapshot, and an fs failure after a successful ack became an unhandled
// rejection.
// ---------------------------------------------------------------------------

describe("persist queue", () => {
  test("writes never overlap (deterministic — instruments Bun.write)", async () => {
    // Ordering assertions alone are timing-dependent and a poor way to prove a
    // race is gone. Counting concurrent writers is exact: pre-fix, N unawaited
    // deltas started N concurrent Bun.writes.
    const file = tmpFile("persist-overlap");
    const ws = createWs();
    const handle = await registerDoc<{ n: number }>(ws, "po", { file, empty: { n: 0 } });

    const realWrite = Bun.write;
    let inFlight = 0;
    let maxInFlight = 0;
    (Bun as any).write = async (...args: any[]) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try { return await (realWrite as any)(...args); }
      finally { inFlight--; }
    };
    try {
      for (let i = 1; i <= 20; i++) {
        handle.applyAndBroadcast([{ op: "replace", path: "/n", value: i }]);
      }
      await handle.persist();
    } finally {
      (Bun as any).write = realWrite;
    }

    expect(maxInFlight).toBe(1);
    expect(JSON.parse(await Bun.file(file).text()).n).toBe(20);
  });

  test("rapid deltas leave the file on the LATEST state", async () => {
    const file = tmpFile("persist-order");
    const ws = createWs();
    const handle = await registerDoc<{ n: number }>(ws, "p", { file, empty: { n: 0 } });

    // Fire many without awaiting — the pre-fix race.
    for (let i = 1; i <= 25; i++) {
      handle.applyAndBroadcast([{ op: "replace", path: "/n", value: i }]);
    }
    await handle.persist();   // resolves only after the whole queue drains

    expect(JSON.parse(await Bun.file(file).text()).n).toBe(25);
    expect(handle.getDoc().n).toBe(25);
  });

  test("persist() resolves after its own write, in call order", async () => {
    const file = tmpFile("persist-chain");
    const ws = createWs();
    const handle = await registerDoc<{ n: number }>(ws, "pc", { file, empty: { n: 0 } });

    const order: number[] = [];
    const writes = [1, 2, 3].map((i) => {
      handle.applyAndBroadcast([{ op: "replace", path: "/n", value: i }]);
      return handle.persist().then(() => order.push(i));
    });
    await Promise.all(writes);

    expect(order).toEqual([1, 2, 3]);
    expect(JSON.parse(await Bun.file(file).text()).n).toBe(3);
  });

  test("a failing write is logged, not thrown as an unhandled rejection", async () => {
    // A directory path makes Bun.write fail. The delta is already acked and
    // broadcast by then, so the failure must not escape applyAndBroadcast.
    const ws = createWs();
    const handle = await registerDoc<{ n: number }>(ws, "pf", {
      file: "/tmp", empty: { n: 0 },
    });

    const seen: unknown[] = [];
    const onReject = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onReject);
    try {
      handle.applyAndBroadcast([{ op: "replace", path: "/n", value: 1 }]);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onReject);
    }
    expect(seen).toEqual([]);

    // The chain survives the failure: a later persist() still runs rather than
    // inheriting the rejected promise.
    await handle.persist().catch(() => {});
    expect(handle.getDoc().n).toBe(1);
  });
});
