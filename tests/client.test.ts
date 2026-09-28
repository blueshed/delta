/**
 * Tests for `@blueshed/delta/client` — specifically the WS reconnect behaviour
 * that `close()` must suppress. Uses a tiny Bun.serve() loopback so we never
 * touch the network.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { connectWs, openDoc, call, WS, type Doc, type WsClient } from "../src/client/client";
import { provide, clearProviders, signal } from "@blueshed/railroad";
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

  test("a broadcast that does not apply to the copy (a remove of a row it does not hold) re-opens it, and does not advance its version (#4)", async () => {
    const srv = startVersionedServer([
      { result: { items: { "1": { id: 1 } }, _v: 5 } },                  // first open @ v5
      { result: { items: { "1": { id: 1 }, "2": { id: 2 } }, _v: 7 } },  // resync @ v7
    ]);
    const client = connectWs(srv.url);
    const doc = openDoc<{ items: Record<string, { id: number }> }>("items:", client);
    await doc.ready;
    const received: DeltaOp[][] = [];
    doc.onOps((ops) => received.push(ops));

    // Contiguous (v6), but /items/9 is not in the copy: RFC 6902 fails it.
    srv.push({ doc: "items:", ops: [{ op: "replace", path: "/items/1", value: { id: 1, seen: true } }, { op: "remove", path: "/items/9" }], v: 6 });

    const deadline = Date.now() + 5000;
    while (doc.data.peek()?.items["2"] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(srv.openCount()).toBe(2);
    // the copy is the snapshot: nothing of the batch that did not apply is left in it
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "2": { id: 2 } } });
    // onOps saw the batch as it came, then the re-open's root-replace to reconcile against
    expect(received).toEqual([
      [{ op: "replace", path: "/items/1", value: { id: 1, seen: true } }, { op: "remove", path: "/items/9" }],
      [{ op: "replace", path: "", value: { items: { "1": { id: 1 }, "2": { id: 2 } } } }],
    ]);

    client.close();
  });

  test("an unversioned broadcast that does not apply re-opens the doc too (#4)", async () => {
    const srv = startVersionedServer([
      { result: { items: { "1": { id: 1 } } } },
      { result: { items: { "2": { id: 2 } } } },
    ]);
    const client = connectWs(srv.url);
    const doc = openDoc<{ items: Record<string, { id: number }> }>("items:", client);
    await doc.ready;

    srv.push({ doc: "items:", ops: [{ op: "remove", path: "/items/9" }] });

    const deadline = Date.now() + 5000;
    while (doc.data.peek()?.items["2"] === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(srv.openCount()).toBe(2);
    expect(doc.data.peek()).toEqual({ items: { "2": { id: 2 } } });

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

// ---------------------------------------------------------------------------
// Deferred registration guards on the SHARED entry, not one handle
// (v0.5.0 review A1)
//
// openDoc() called before provide(WS, ...) parks the entry and registers it in
// a microtask. That microtask used to bail on the CREATING handle's `closed`
// flag — a per-handle fact used to decide the fate of a shared entry. It is
// now guarded on the entry's refcount.
//
// A1 predicted a live handle could be stranded by its co-handle closing. That
// is NOT reproducible: every pending handle queues its own microtask, so the
// co-handle's registers. These pin the invariant directly, so the guard stays
// correct even if that incidental cover is refactored away.
// ---------------------------------------------------------------------------

describe("deferred registration refcount", () => {
  function fakeClient() {
    const sent: any[] = [];
    const client = {
      connected: signal(true),
      send: async (msg: any) => {
        sent.push(msg);
        return msg.action === "open" ? { seeded: true } : { ack: true };
      },
      on: () => () => {},
      close: () => {},
      _docs: new Map(),
    } as unknown as WsClient;
    return { client, sent };
  }

  test("a co-handle closing does not strand the surviving handle", async () => {
    clearProviders();
    const { client, sent } = fakeClient();

    const a = openDoc<any>("shared");       // parks the entry
    const b = openDoc<any>("shared");       // shares it, refs = 2
    a.close();                              // refs = 1 — b still holds it
    provide(WS, client);
    await Bun.sleep(20);

    expect(client._docs.has("shared")).toBe(true);
    expect(b.data.get()).toEqual({ seeded: true });
    // Exactly one open on the wire — the shared entry registers once.
    expect(sent.filter((m) => m.action === "open")).toHaveLength(1);
  });

  test("a fully released doc does not register", async () => {
    clearProviders();
    const { client, sent } = fakeClient();

    const a = openDoc<any>("released");
    const b = openDoc<any>("released");
    a.close();
    b.close();                              // refs = 0
    provide(WS, client);
    await Bun.sleep(20);

    // Registering here would resurrect a doc nobody holds and re-subscribe the
    // socket to a stream with no reader.
    expect(client._docs.has("released")).toBe(false);
    expect(sent.filter((m) => m.action === "open")).toHaveLength(0);
  });

  test("close() is idempotent and cannot drive refs negative", async () => {
    clearProviders();
    const { client } = fakeClient();

    const a = openDoc<any>("idem");
    const b = openDoc<any>("idem");
    a.close(); a.close(); a.close();        // repeated close of ONE handle
    provide(WS, client);
    await Bun.sleep(20);

    // b's reference survived the repeats, so the doc is still registered.
    expect(client._docs.has("idem")).toBe(true);
    expect(b.data.get()).toEqual({ seeded: true });
  });
});

// ---------------------------------------------------------------------------
// D2: a reconnect re-opens every doc on a socket that has not said who it is
// yet, so an in-band-authenticated client's docs 401'd and froze. onConnect
// runs before the re-opens, on every connect.
// ---------------------------------------------------------------------------

describe("onConnect: saying who you are before the docs re-open", () => {
  // A server that answers `open` only on a socket that authenticated, and
  // takes a moment to authenticate (so a racing open would lose).
  function makeAuthServer(port: number, rows: string[]) {
    return Bun.serve<{ authed: boolean }>({
      port,
      fetch(req, s) { return s.upgrade(req, { data: { authed: false } }) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: {
        open() {},
        close() {},
        async message(ws: any, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.action === "call" && msg.method === "authenticate") {
            await Bun.sleep(30);
            ws.data.authed = true;
            ws.send(JSON.stringify({ id: msg.id, result: { id: 1 } }));
          } else if (msg.action === "open") {
            ws.send(JSON.stringify(ws.data.authed
              ? { id: msg.id, result: { rows } }
              : { id: msg.id, error: { code: 401, message: "Authentication required" } }));
          }
        },
      },
    });
  }

  test("a reconnect re-opens the docs signed in, so they don't freeze", async () => {
    server = makeAuthServer(0, ["before"]);
    const port = server.port;
    let connects = 0;
    const client = connectWs(`ws://localhost:${port}/ws`, {
      onConnect: async (ws) => { connects++; await ws.send({ action: "call", method: "authenticate", params: { token: "t" } }); },
    });
    const doc = openDoc<{ rows: string[] }>("rows:", client);
    await doc.ready;
    expect(doc.data.peek()).toEqual({ rows: ["before"] });

    server.stop(true);
    await Bun.sleep(50);
    server = makeAuthServer(port, ["before", "after the drop"]);
    const deadline = Date.now() + 8000;
    while (doc.data.peek()?.rows.length !== 2 && Date.now() < deadline) await Bun.sleep(25);
    expect(doc.data.peek()).toEqual({ rows: ["before", "after the drop"] });
    expect(connects).toBe(2);
    client.close();
  });

  // A request waits for `ready`; a drop used to swap in a new `ready` even when
  // the old one had never opened, so what waited on the old one hung for ever
  // (connected true, the call never settled).
  test("a request made while onConnect runs survives a drop before it finishes", async () => {
    let first = true;
    server = Bun.serve({
      port: 0,
      fetch(req, s) { return s.upgrade(req) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: {
        open() {}, close() {},
        message(ws: any, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.method === "authenticate" && first) { first = false; ws.close(); return; }   // drop mid-onConnect
          ws.send(JSON.stringify({ id: msg.id, result: msg.method }));
        },
      },
    });
    const client = connectWs(`ws://localhost:${server.port}/ws`, {
      onConnect: (ws) => ws.send({ action: "call", method: "authenticate", params: {} }),
    });
    const answer = client.send({ action: "call", method: "ping" });
    expect(await Promise.race([answer, Bun.sleep(4000).then(() => "hung")])).toBe("ping");
    client.close();
  });

  test("a request made before the first connect survives a failed attempt", async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const port = probe.port;
    probe.stop(true);
    const client = connectWs(`ws://localhost:${port}/ws`);   // nothing listening: the first attempt fails
    const answer = client.send({ action: "call", method: "ping" });
    await Bun.sleep(200);
    server = Bun.serve({
      port,
      fetch(req, s) { return s.upgrade(req) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: { message(ws, raw) { ws.send(JSON.stringify({ id: JSON.parse(String(raw)).id, result: "pong" })); } },
    });
    expect(await Promise.race([answer, Bun.sleep(4000).then(() => "hung")])).toBe("pong");
    client.close();
  });

  test("nothing else goes out before onConnect is done", async () => {
    server = makeAuthServer(0, ["x"]);
    const client = connectWs(`ws://localhost:${server.port}/ws`, {
      onConnect: (ws) => ws.send({ action: "call", method: "authenticate", params: {} }),
    });
    const doc = openDoc<{ rows: string[] }>("rows:", client);   // opened while connecting
    await doc.ready;
    expect(doc.data.peek()).toEqual({ rows: ["x"] });
    client.close();
  });

  // todo #19: only the client onConnect is given skipped `ready`. One that
  // called through DI -- `call("authenticate", params)`, no client, as
  // everywhere else in a page -- sent through inject(WS), which waited for
  // `ready`, which waited for onConnect: it never connected, and said nothing.
  test("an onConnect that calls through DI connects, before an await and after one (#19)", async () => {
    server = makeAuthServer(0, ["x"]);
    const answers: unknown[] = [];
    const client = connectWs(`ws://localhost:${server.port}/ws`, {
      onConnect: async () => {
        answers.push(await call("authenticate", { token: "t" }));   // no client: through DI
        await Bun.sleep(5);                                          // a token refreshed, say
        answers.push(await call("authenticate", { token: "t" }));
      },
    });
    provide(WS, client);
    try {
      const doc = openDoc<{ rows: string[] }>("rows:");   // DI too: it opens once onConnect is done
      expect(await Promise.race([doc.ready.then(() => "opened"), Bun.sleep(3000).then(() => "hung")])).toBe("opened");
      expect(client.connected.peek()).toBe(true);
      expect(answers).toEqual([{ id: 1 }, { id: 1 }]);
      expect(doc.data.peek()).toEqual({ rows: ["x"] });
    } finally {
      client.close();
      clearProviders();
    }
  });

  // What onConnect lets out at once goes to the socket it runs on: once that
  // socket drops, a request waits for the next connect, as before.
  test("a request made after the socket dropped, while onConnect still runs, waits for the next connect", async () => {
    let drops = 1;
    server = Bun.serve({
      port: 0,
      fetch(req, s) { return s.upgrade(req) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: {
        open(ws) { if (drops-- > 0) setTimeout(() => ws.close(), 20); },   // the first socket drops mid-onConnect
        message(ws, raw) { const msg = JSON.parse(String(raw)); ws.send(JSON.stringify({ id: msg.id, result: msg.method })); },
      },
    });
    let hooks = 0;
    let letFirstGo!: () => void;
    const firstMayGo = new Promise<void>((r) => (letFirstGo = r));
    const client = connectWs(`ws://localhost:${server.port}/ws`, {
      onConnect: () => (++hooks === 1 ? firstMayGo : undefined),   // the first waits on something that is not the socket
    });
    await new Promise<void>((r) => client.on("close", () => r()));   // the first socket has dropped; its onConnect still runs
    expect(hooks).toBe(1);
    const answer = client.send({ action: "call", method: "ping" });
    letFirstGo();
    expect(await Promise.race([answer, Bun.sleep(4000).then(() => "hung")])).toBe("ping");
    expect(hooks).toBe(2);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// D8: `await doc.send()` meant "echo applied" on the JSON file and SQLite
// (they broadcast before they answer) and "not yet" on Postgres (it answers,
// then broadcasts through NOTIFY). It now waits for the version its ack names.
// ---------------------------------------------------------------------------

describe("send resolves after its own echo", () => {
  test("an ack that comes before its echo waits for it (the Postgres order)", async () => {
    const subs = new Set<any>();
    server = Bun.serve({
      port: 0,
      fetch(req, s) { return s.upgrade(req) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: {
        open(ws) { subs.add(ws); },
        close(ws) { subs.delete(ws); },
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.action === "open") ws.send(JSON.stringify({ id: msg.id, result: { n: 0, _v: 0 } }));
          if (msg.action === "delta") {
            ws.send(JSON.stringify({ id: msg.id, result: { ack: true, version: 1 } }));     // ack first
            setTimeout(() => { for (const s of subs) s.send(JSON.stringify({ doc: msg.doc, ops: msg.ops, v: 1 })); }, 60);
          }
        },
      },
    });
    const client = connectWs(`ws://localhost:${server.port}/ws`);
    const doc = openDoc<{ n: number }>("n:", client);
    await doc.ready;
    const ack = await doc.send([{ op: "replace", path: "/n", value: 1 }]);
    expect(ack).toEqual({ ack: true, version: 1 });
    expect(doc.data.peek()).toEqual({ n: 1 });   // the echo has landed
    client.close();
  });
});

// ---------------------------------------------------------------------------
// D10: connectWs read `location` unconditionally (a Bun script threw
// "location is not defined") and forced the page's scheme onto an absolute
// URL (wss:// became ws:// from an http page). Run in a fresh process: this
// file shims `location` for every other test.
// ---------------------------------------------------------------------------

describe("doc.data is read-only (#10)", () => {
  test("a write to doc.data is a type error: the echo updates it, never the page (tsc checks this)", () => {
    // Never called: `bun run check` fails if any @ts-expect-error below is not an error.
    const typeOnly = (doc: Doc<{ n: number }>) => {
      // @ts-expect-error -- an optimistic update double-applies when the op echoes back
      doc.data.set({ n: 1 });
      // @ts-expect-error
      doc.data.update((d) => d);
      // @ts-expect-error
      doc.data.patch({ n: 1 });
      // @ts-expect-error
      doc.data.mutate((d) => void d);
      // @ts-expect-error
      doc.data.touch();
      // reading it is what it is for
      const n: number | undefined = doc.data.get()?.n;
      const m = doc.data.peek()?.n;
      return [n, m, doc.data.map((d) => d?.n)];
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("connectWs outside a browser", () => {
  const CLIENT = new URL("../src/client/client.ts", import.meta.url).pathname;
  async function run(prelude: string, body: string): Promise<string> {
    const script = `${prelude}
      const urls = [];
      globalThis.WebSocket = class { static OPEN = 1; readyState = 0; constructor(u) { urls.push(u); } addEventListener() {} send() {} close() {} };
      const { connectWs } = await import(${JSON.stringify(CLIENT)});
      try { ${body} } catch (e) { urls.push("THREW " + e.message); }
      console.log(JSON.stringify(urls));`;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LOG_LEVEL: "silent" } });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  }

  test("an absolute URL needs no location, and wss stays wss", async () => {
    const out = await run("", `connectWs("ws://localhost:1/ws").close(); connectWs("wss://api.example/ws").close(); connectWs("http://localhost:2/ws").close();`);
    expect(JSON.parse(out)).toEqual(["ws://localhost:1/ws", "wss://api.example/ws", "ws://localhost:2/ws"]);
  });

  test("a relative URL without a page says it must be absolute", async () => {
    const out = await run("", `connectWs("/ws");`);
    expect(JSON.parse(out)[0]).toContain("outside a browser the URL must be absolute");
  });

  test("in a page, a relative URL takes the page's scheme; an absolute one keeps its own", async () => {
    const out = await run(`globalThis.location = { href: "http://app.example/x" };`, `connectWs("/ws").close(); connectWs("wss://api.example/ws").close();`);
    expect(JSON.parse(out)).toEqual(["ws://app.example/ws", "wss://api.example/ws"]);
  });
});

// R8: the root barrel loads railroad's JSX and its global `JSX` namespace, which
// clashes with React's in an app that only wants delta's socket. Pin the subpaths.
test("delta's client imports railroad's subpaths, never the root barrel", async () => {
  const src = await Bun.file(new URL("../src/client/client.ts", import.meta.url)).text();
  expect(src).not.toMatch(/from "@blueshed\/railroad"/);
  expect(src).toMatch(/from "@blueshed\/railroad\/signals"/);
});

// ---------------------------------------------------------------------------
// #17: the server lets a socket go of a document it may no longer hear, and
// tells it so -- `{ doc, error: { code, message } }`, no id. Told nothing, the
// copy stayed open and stale (no gap in the versions to show it), and a write
// in flight waited ECHO_WAIT_MS for an echo that never came.
// ---------------------------------------------------------------------------

describe("a document the server lets go (#17)", () => {
  function letGoServer() {
    const subs = new Set<any>();
    const state = { opens: 0, connects: 0, refuse: false as false | number, snapshot: { items: { "1": { id: 1 } }, _v: 1 } as any };
    server = Bun.serve({
      port: 0,
      fetch(req, s) { return s.upgrade(req) ? undefined as any : new Response("no", { status: 400 }); },
      websocket: {
        open(ws) { subs.add(ws); state.connects++; },
        close(ws) { subs.delete(ws); },
        message(ws, raw) {
          const msg = JSON.parse(String(raw));
          if (msg.action === "open") {
            state.opens++;
            ws.send(JSON.stringify(state.refuse
              ? { id: msg.id, error: { code: state.refuse, message: state.refuse === 404 ? "Not found" : "Session expired" } }
              : { id: msg.id, result: structuredClone(state.snapshot) }));
          } else if (msg.action === "delta") {
            ws.send(JSON.stringify({ id: msg.id, result: { ack: true, version: 2 } }));   // acked; its echo never comes
          } else if (msg.id != null) {
            ws.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
          }
        },
      },
    });
    const push = (frame: any) => { for (const ws of subs) ws.send(JSON.stringify(frame)); };
    return { url: `ws://localhost:${server.port}/ws`, state, push };
  }
  const until = async (ok: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await Bun.sleep(20); };

  test("taken off it (404), the client opens it again: refused, its copy is let go -- null, and onOps told so", async () => {
    const srv = letGoServer();
    const client = connectWs(srv.url);
    const doc = openDoc<any>("items:", client);
    await doc.ready;
    const told: DeltaOp[][] = [];
    doc.onOps((ops) => told.push(ops));
    srv.state.refuse = 404;
    srv.push({ doc: "items:", error: { code: 404, message: "Not found" } });
    await until(() => doc.data.peek() === null);
    expect(doc.data.peek()).toBeNull();
    expect(srv.state.opens).toBe(2);
    expect(told).toEqual([[{ op: "replace", path: "", value: null }]]);
    client.close();
  });

  test("put back before it asks, the client's open again is taken: its copy is the server's, and it hears on", async () => {
    const srv = letGoServer();
    const client = connectWs(srv.url);
    const doc = openDoc<any>("items:", client);
    await doc.ready;
    srv.state.snapshot = { items: { "1": { id: 1 }, "2": { id: 2 } }, _v: 3 };
    srv.push({ doc: "items:", error: { code: 404, message: "Not found" } });
    await until(() => doc.data.peek()?.items?.["2"] !== undefined);
    expect(doc.data.peek()).toEqual({ items: { "1": { id: 1 }, "2": { id: 2 } } });
    srv.push({ doc: "items:", ops: [{ op: "add", path: "/items/3", value: { id: 3 } }], v: 4 });
    await until(() => doc.data.peek()?.items?.["3"] !== undefined);
    expect(Object.keys(doc.data.peek().items)).toEqual(["1", "2", "3"]);
    client.close();
  });

  test("a write in flight when its document is let go resolves then, not after waiting for an echo that never comes", async () => {
    const srv = letGoServer();
    const client = connectWs(srv.url);
    const doc = openDoc<any>("items:", client);
    await doc.ready;
    srv.state.refuse = 404;
    const t0 = Date.now();
    const sent = doc.send([{ op: "add", path: "/items/-", value: {} }]);
    await Bun.sleep(50);
    srv.push({ doc: "items:", error: { code: 404, message: "Not found" } });
    expect(await sent).toEqual({ ack: true, version: 2 });
    expect(Date.now() - t0).toBeLessThan(2000);
    client.close();
  });

  test("its session over (401), the client connects again: onConnect signs it in, and its documents re-open", async () => {
    const srv = letGoServer();
    let signIns = 0;
    const client = connectWs(srv.url, { onConnect: async (ws) => { signIns++; await ws.send({ action: "call", method: "authenticate", params: {} }); } });
    const doc = openDoc<any>("items:", client);
    await doc.ready;
    srv.state.snapshot = { items: { "9": { id: 9 } }, _v: 5 };
    srv.push({ doc: "items:", error: { code: 401, message: "Session expired" } });
    await until(() => doc.data.peek()?.items?.["9"] !== undefined, 6000);
    expect({ connects: srv.state.connects, signIns, data: doc.data.peek() }).toEqual({ connects: 2, signIns: 2, data: { items: { "9": { id: 9 } } } });
    client.close();
  });
});
