/**
 * Tests for `@blueshed/delta/client` — specifically the WS reconnect behaviour
 * that `close()` must suppress. Uses a tiny Bun.serve() loopback so we never
 * touch the network.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connectWs, openDoc } from "../src/client/client";

// `connectWs` resolves URLs against `location` — shim it for Bun.
(globalThis as any).location = { href: "http://localhost/", protocol: "http:" };

let server: any = null;

afterEach(() => {
  try { server?.stop(true); } catch { /* noop */ }
  server = null;
});

function startEchoServer(): string {
  server = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return undefined as any;
      return new Response("no ws", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        if (msg.id != null) ws.send(JSON.stringify({ id: msg.id, result: "ok" }));
      },
      open() { /* noop */ },
      close() { /* noop */ },
    },
  });
  return `ws://localhost:${server.port}/ws`;
}

function startFakeDeltaServer(initialState: any): string {
  const subscribers = new Set<any>();
  server = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return undefined as any;
      return new Response("no ws", { status: 400 });
    },
    websocket: {
      open(ws) { subscribers.add(ws); },
      close(ws) { subscribers.delete(ws); },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
        if (msg.action === "open") {
          ws.send(JSON.stringify({ id: msg.id, result: initialState }));
        } else if (msg.action === "delta") {
          ws.send(JSON.stringify({ id: msg.id, result: { ack: true, version: 1 } }));
          // Broadcast to everyone (including the sender) — mimics the real
          // server's `publishToSelf: true`.
          for (const sub of subscribers) {
            sub.send(JSON.stringify({ doc: msg.doc, ops: msg.ops }));
          }
        }
      },
    },
  });
  return `ws://localhost:${server.port}/ws`;
}

describe("openDoc per-client state", () => {
  test("two connectWs instances hold independent openDoc state", async () => {
    const url = startFakeDeltaServer({ items: {} });
    const alice = connectWs(url);
    const bob   = connectWs(url);

    const aliceDoc = openDoc<{ items: Record<string, any> }>("items:", alice);
    const bobDoc   = openDoc<{ items: Record<string, any> }>("items:", bob);

    await Promise.all([aliceDoc.ready, bobDoc.ready]);

    // Independent signals — same initial state, but they're separate objects.
    expect(aliceDoc.data.get()).toEqual({ items: {} });
    expect(bobDoc.data.get()).toEqual({ items: {} });
    expect(aliceDoc.data).not.toBe(bobDoc.data);

    // Subscribe both to the broadcast.
    const aliceOps: any[] = [];
    const bobOps: any[] = [];
    aliceDoc.onOps((ops) => aliceOps.push(ops));
    bobDoc.onOps((ops)   => bobOps.push(ops));

    await aliceDoc.send([
      { op: "add", path: "/items/1", value: { id: 1, name: "foo" } },
    ]);

    // Wait for the broadcast to fan out.
    await new Promise((r) => setTimeout(r, 50));

    expect(aliceOps.length).toBe(1);
    expect(bobOps.length).toBe(1);
    // Both doc signals updated from their OWN applyOps pass — same result,
    // independent state.
    expect(aliceDoc.data.get()).toEqual({ items: { "1": { id: 1, name: "foo" } } });
    expect(bobDoc.data.get())  .toEqual({ items: { "1": { id: 1, name: "foo" } } });

    alice.close();
    bob.close();
  });
});

describe("connectWs.close()", () => {
  test("suppresses reconnect after the server stops", async () => {
    const url = startEchoServer();
    const client = connectWs(url);

    // Round-trip once to confirm the socket is alive.
    const result = await client.send({ action: "ping" });
    expect(result).toBe("ok");

    client.close();
    server!.stop(true);
    server = null;

    // Give the reconnect loop a chance to misbehave. If close() is broken,
    // the setTimeout(connect) in reconnectingWebSocket fires after ~1s and
    // we'd see a failed connection attempt in the logs / hang. If close()
    // is working, nothing happens.
    await new Promise((r) => setTimeout(r, 1200));

    // `send` must reject promptly now that the socket is closed.
    await expect(client.send({ action: "ping" })).rejects.toMatchObject({
      code: expect.anything(),
    });
  });

  test("close() is idempotent", () => {
    const url = startEchoServer();
    const client = connectWs(url);
    client.close();
    expect(() => client.close()).not.toThrow();
  });
});
