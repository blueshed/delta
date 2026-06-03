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

describe("version gap detection + resync", () => {
  // A server that versions its open snapshots (via `_v`) and lets the test push
  // raw broadcasts (with `v`). `opens[i]` is returned for the i-th open; the
  // last entry repeats.
  function startVersionedServer(opens: Array<{ result: any }>): { url: string; push: (frame: any) => void; openCount: () => number } {
    const subs = new Set<any>();
    let openIdx = 0;
    server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return undefined as any;
        return new Response("no ws", { status: 400 });
      },
      websocket: {
        open(ws) { subs.add(ws); },
        close(ws) { subs.delete(ws); },
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.action === "open") {
            const resp = opens[Math.min(openIdx, opens.length - 1)]!;
            openIdx++;
            ws.send(JSON.stringify({ id: msg.id, result: resp.result }));
          }
        },
      },
    });
    return {
      url: `ws://localhost:${server.port}/ws`,
      push: (frame: any) => { for (const ws of subs) ws.send(JSON.stringify(frame)); },
      openCount: () => openIdx,
    };
  }

  test("a version gap re-opens to resync; the gapped op is NOT applied directly", async () => {
    const srv = startVersionedServer([
      { result: { items: { "1": { id: 1 } }, _v: 5 } },                       // first open @ v5
      { result: { items: { "1": { id: 1 }, "2": { id: 2 } }, _v: 7 } },        // resync open @ v7
    ]);
    const client = connectWs(srv.url);
    const doc = openDoc<{ items: Record<string, { id: number }> }>("items:", client);
    await doc.ready;
    // `_v` is stripped before it reaches doc.data.
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 } } });

    const received: DeltaOp[][] = [];
    doc.onOps((ops) => received.push(ops));

    // serverVersion is 5, so the next contiguous op is v6. Push v7 → GAP.
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/9", value: { id: 9 } }], v: 7 });

    // Client should re-open and reconcile to the authoritative v7 snapshot.
    const deadline = Date.now() + 5000;
    while (doc.data.peek()?.items["2"] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // Resynced to v7 state — and the gapped op's /items/9 was never applied.
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "2": { id: 2 } } });
    // onOps saw ONLY the synthetic root-replace from the re-open, never the gapped op.
    expect(received).toEqual([
      [{ op: "replace", path: "", value: { items: { "1": { id: 1 }, "2": { id: 2 } } } }],
    ]);

    client.close();
  });

  test("applies a contiguous broadcast and ignores a stale/duplicate version", async () => {
    const srv = startVersionedServer([{ result: { items: { "1": { id: 1 } }, _v: 5 } }]);
    const client = connectWs(srv.url);
    const doc = openDoc<{ items: Record<string, { id: number }> }>("items:", client);
    await doc.ready;

    // Contiguous: serverVersion 5, v6 → applies.
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/2", value: { id: 2 } }], v: 6 });
    // Stale/duplicate: v6 again (<= current serverVersion) → ignored.
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/3", value: { id: 3 } }], v: 6 });

    const deadline = Date.now() + 5000;
    while (doc.data.peek()?.items["2"] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50)); // let the duplicate (if mis-handled) land

    // v6's op applied once; the duplicate-v6 op was dropped.
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "2": { id: 2 } } });

    client.close();
  });

  test("a burst of gapped broadcasts collapses to a single re-open", async () => {
    const srv = startVersionedServer([
      { result: { items: { "1": { id: 1 } }, _v: 5 } },              // first open @ v5
      { result: { items: { "1": { id: 1 }, "z": { id: "z" } }, _v: 10 } }, // resync @ v10
    ]);
    const client = connectWs(srv.url);
    const doc = openDoc<{ items: Record<string, { id: any }> }>("items:", client);
    await doc.ready;
    expect(srv.openCount()).toBe(1);

    // serverVersion 5; push a synchronous backlog all gapped (next would be 6).
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/8", value: { id: 8 } }], v: 8 });
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/9", value: { id: 9 } }], v: 9 });
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/10", value: { id: 10 } }], v: 10 });

    const deadline = Date.now() + 5000;
    while (doc.data.peek()?.items["z"] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 50));

    // Exactly ONE re-open (the dedup absorbed the backlog), and we're resynced.
    expect(srv.openCount()).toBe(2);
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "z": { id: "z" } } });

    client.close();
  });

  test("drops a broadcast that arrives before the first open response", async () => {
    // Server pushes a broadcast BEFORE answering the open (simulates a write's
    // broadcast overtaking the open response on the same socket).
    const subs = new Set<any>();
    server = Bun.serve({
      port: 0,
      fetch(req, s) {
        if (s.upgrade(req)) return undefined as any;
        return new Response("no ws", { status: 400 });
      },
      websocket: {
        open(ws) { subs.add(ws); },
        close(ws) { subs.delete(ws); },
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.action === "open") {
            ws.send(JSON.stringify({ doc: "items:", ops: [{ op: "add", path: "/items/early", value: { id: "early" } }], v: 6 }));
            ws.send(JSON.stringify({ id: msg.id, result: { items: { "1": { id: 1 } }, _v: 5 } }));
          }
        },
      },
    });
    const client = connectWs(`ws://localhost:${server.port}/ws`);
    const received: DeltaOp[][] = [];
    const doc = openDoc<{ items: Record<string, { id: any }> }>("items:", client);
    doc.onOps((ops) => received.push(ops));
    await doc.ready;
    await new Promise((r) => setTimeout(r, 30));

    // The pre-open broadcast was dropped: doc.data is the snapshot (no "early"),
    // and onOps never fired against the not-yet-rendered doc.
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 } } });
    expect(received).toEqual([]);

    client.close();
  });
});
