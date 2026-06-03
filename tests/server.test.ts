import { describe, test, expect, afterAll } from "bun:test";
import {
  createWs, registerDoc, registerMethod,
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
