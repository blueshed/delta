/**
 * Tests for `@blueshed/delta/client` — specifically the WS reconnect behaviour
 * that `close()` must suppress. Uses a tiny Bun.serve() loopback so we never
 * touch the network.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connectWs, openDoc } from "../src/client/client";
import type { DeltaOp } from "../src/core";

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

describe("echoed ops preserve reference identity", () => {
  test("captured child refs see updates without re-reading doc.data", async () => {
    const url = startFakeDeltaServer({ shapes: { s1: { x: 0, y: 0 } } });
    const client = connectWs(url);
    const doc = openDoc<{ shapes: Record<string, { x: number; y: number }> }>(
      "shapes:",
      client,
    );
    await doc.ready;

    const rootBefore   = doc.data.peek()!;
    const shapesBefore = doc.data.peek()!.shapes;
    const shapeBefore  = doc.data.peek()!.shapes.s1;
    expect(shapeBefore.x).toBe(0);

    await doc.send([{ op: "replace", path: "/shapes/s1/x", value: 42 }]);
    await new Promise((r) => setTimeout(r, 50));

    // Mutation lands on the SAME refs — the whole raison d'être of the fix.
    expect(doc.data.peek()).toBe(rootBefore);
    expect(doc.data.peek()!.shapes).toBe(shapesBefore);
    expect(doc.data.peek()!.shapes.s1).toBe(shapeBefore);
    expect(shapeBefore.x).toBe(42);

    client.close();
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

describe("in-flight requests on transport drop", () => {
  test("a request in flight when the socket drops is rejected, not hung", async () => {
    // Server that never replies to `ping` — so the request stays in `pending`
    // until the socket drops out from under it.
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
        message() { /* deliberately never reply */ },
      },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const client = connectWs(url);

    // Wait for the socket to open so `ready` resolves and the request actually
    // goes into `pending` (rather than awaiting `ready`).
    await new Promise<void>((resolve) => {
      const stop = client.on("open", () => { stop(); resolve(); });
    });

    const inflight = client.send({ action: "ping" });

    // Drop the transport without an explicit close() — simulates an
    // unexpected server crash / network blip that WILL try to reconnect.
    server!.stop(true);
    server = null;

    // The in-flight promise must reject (with the retryable "disconnected"
    // message), NOT hang forever.
    await expect(inflight).rejects.toMatchObject({ code: 0, message: "disconnected" });

    client.close();
  });
});

describe("onOps reconciliation on reconnect", () => {
  test("onOps receives a root-replace on reconnect; applyOpsToCollection reconciles", async () => {
    // A delta server we can restart on the SAME port to force a reconnect.
    function makeServer(port: number, state: any) {
      return Bun.serve({
        port,
        fetch(req, s) {
          if (s.upgrade(req)) return undefined as any;
          return new Response("no ws", { status: 400 });
        },
        websocket: {
          open() { /* noop */ },
          close() { /* noop */ },
          message(ws, raw) {
            const msg = JSON.parse(String(raw));
            if (msg.action === "open") {
              ws.send(JSON.stringify({ id: msg.id, result: state }));
            }
          },
        },
      });
    }

    // First boot: doc has items {1, 2}.
    server = makeServer(0, { items: { "1": { id: 1 }, "2": { id: 2 } } });
    const port = server.port;
    const url = `ws://localhost:${port}/ws`;
    const client = connectWs(url);
    const doc = openDoc<{ items: Record<string, { id: number }> }>("items:", client);
    await doc.ready;

    const received: DeltaOp[][] = [];
    doc.onOps((ops) => received.push(ops));

    // No reconcile op on the FIRST open.
    expect(received.length).toBe(0);

    // Drop the server, then bring it back on the SAME port with DRIFTED state
    // (item 2 removed, item 3 added) so reconnect must reconcile.
    server.stop(true);
    server = null;
    await new Promise((r) => setTimeout(r, 50));
    server = makeServer(port, { items: { "1": { id: 1 }, "3": { id: 3 } } });

    // Wait for the reconnect + re-open snapshot to land. Poll rather than a
    // fixed sleep — the reconnect backoff (~1s) leaves a thin margin under
    // full-suite load, which made a fixed wait flaky.
    const deadline = Date.now() + 8000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    // Exactly one synthetic root-replace emitted on reconnect.
    expect(received.length).toBe(1);
    expect(received[0]).toEqual([
      { op: "replace", path: "", value: { items: { "1": { id: 1 }, "3": { id: 3 } } } },
    ]);
    // doc.data reflects the drifted snapshot too.
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "3": { id: 3 } } });

    client.close();
  });
});
