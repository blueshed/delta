/**
 * railroad ↔ delta integration — the full loop, end to end:
 *
 *   Bun.serve (createWs + registerDoc, JSON-file backend)
 *     ⇅ real WebSocket
 *   connectWs + openDoc (railroad signals)
 *     ⇅ mount / when / list (railroad real-DOM JSX runtime, happy-dom)
 *
 * Pins the seams that unit tests on either side cannot see:
 *   - a FIELD-LEVEL op edits a keyed list() row (whole-row broadcast
 *     normalization → fresh row reference → default Object.is notifies)
 *   - one flush per broadcast (batch() around data + dataVersion)
 *   - openDoc dedupe/refcount and doc.close() unregistration
 *   - scope-aware auto-close inside a railroad dispose scope
 *   - late provide(WS): register-on-send self-heal
 *
 * happy-dom supplies the DOM; its WebSocket stub is swapped back for Bun's
 * native client so the socket is real.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeWebSocket = globalThis.WebSocket;
GlobalRegistrator.register({ url: "http://localhost/" });
globalThis.WebSocket = NativeWebSocket;

import {
  effect, mount, when, list,
  provide, clearProviders, setLogLevel as railroadLogLevel, hasActiveDisposeScope,
} from "@blueshed/railroad";
import { connectWs, openDoc, WS, type Doc, type WsClient } from "../src/client/client";
import { createWs, registerDoc, type DocHandle } from "../src/server/server";
import { setLogLevel as serverLogLevel } from "../src/server/logger";
import { unlinkSync } from "fs";

railroadLogLevel("silent");
serverLogLevel("silent");

interface Card { id: number; title: string }
interface BoardDoc { cards: Record<string, Card> }

const tmpFiles: string[] = [];
function tmpFile(tag: string): string {
  const f = `/tmp/delta-railroad-it-${tag}-${Date.now()}.json`;
  tmpFiles.push(f);
  return f;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until(): timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// --- one real server + one real client for the whole suite -----------------

const wsrv = createWs();
const handles = new Map<string, DocHandle<BoardDoc>>();
for (const name of ["it:board", "it:dedupe", "it:scope", "it:late", "it:batch"]) {
  handles.set(name, await registerDoc<BoardDoc>(wsrv, name, {
    file: tmpFile(name.replace(":", "-")),
    empty: { cards: {} },
  }));
}

const server = Bun.serve({
  port: 0,
  fetch(req, srv) {
    if (new URL(req.url).pathname === wsrv.path) return wsrv.upgrade(req, srv);
    return new Response("ok");
  },
  websocket: wsrv.websocket,
});
wsrv.setServer(server);

const client: WsClient = connectWs(`http://localhost:${server.port}/ws`);

afterAll(() => {
  client.close();
  server.stop(true);
  clearProviders();
  for (const f of tmpFiles) { try { unlinkSync(f); } catch {} }
  GlobalRegistrator.unregister();
});

// ---------------------------------------------------------------------------

describe("railroad ↔ delta", () => {
  test("full loop: open → render → add / FIELD-LEVEL edit / remove → DOM", async () => {
    const handle = handles.get("it:board")!;
    const doc: Doc<BoardDoc> = openDoc("it:board", client);

    const root = document.createElement("div");
    document.body.appendChild(root);
    const cards$ = doc.data.map((d) => (d ? Object.values(d.cards) : []));
    const dispose = mount(root, () =>
      when(doc.data, () =>
        list(cards$, (c) => c.id, (c$) => {
          const li = document.createElement("li");
          effect(() => { li.textContent = c$.get().title; });
          return li;
        }),
      () => {
        const p = document.createElement("p");
        p.textContent = "loading";
        return p;
      }),
    );

    await doc.ready;
    await until(() => !root.textContent?.includes("loading"));

    // Server-driven add renders a row.
    handle.applyAndBroadcast([{ op: "add", path: "/cards/5", value: { id: 5, title: "first" } }]);
    await until(() => root.textContent === "first");

    // THE headline seam: a field-level op. normalizeForBroadcast turns it into
    // a whole-row replace on the wire, the client's applyOps assigns a fresh
    // row object, and keyed list() sees the new reference under its DEFAULT
    // equality — the row's DOM updates. (Pre-fix this stayed "first".)
    handle.applyAndBroadcast([{ op: "replace", path: "/cards/5/title", value: "edited" }]);
    await until(() => root.textContent === "edited");

    // Client round trip: send an op, the echo broadcast renders it.
    await doc.send([{ op: "add", path: "/cards/9", value: { id: 9, title: "nine" } }]);
    await until(() => root.textContent === "editednine");
    expect(handle.getDoc().cards["9"]!.title).toBe("nine");

    // Removal tears the row out.
    handle.applyAndBroadcast([{ op: "remove", path: "/cards/5" }]);
    await until(() => root.textContent === "nine");

    dispose();
    doc.close();
    root.remove();
  });

  test("one flush per broadcast: an effect reading data + dataVersion runs once", async () => {
    const handle = handles.get("it:batch")!;
    const doc: Doc<BoardDoc> = openDoc("it:batch", client);
    await doc.ready;

    let runs = 0;
    const stop = effect(() => {
      doc.data.get();
      doc.dataVersion.get();
      runs++;
    });
    expect(runs).toBe(1);

    handle.applyAndBroadcast([{ op: "add", path: "/cards/1", value: { id: 1, title: "x" } }]);
    await until(() => runs >= 2);
    // batch() coalesces the dataVersion.set + data.touch pair — without it
    // this effect would run twice per broadcast (runs === 3).
    expect(runs).toBe(2);

    stop();
    doc.close();
  });

  test("openDoc dedupes by name; close() unregisters at refcount zero", async () => {
    const d1: Doc<BoardDoc> = openDoc("it:dedupe", client);
    const d2: Doc<BoardDoc> = openDoc("it:dedupe", client);

    // Same underlying entry — the same signals, not a second dead copy.
    expect(d2.data).toBe(d1.data);
    expect(client._docs.has("it:dedupe")).toBe(true);

    d1.close();
    d1.close(); // per-handle idempotent
    expect(client._docs.has("it:dedupe")).toBe(true); // d2 still live

    d2.close();
    expect(client._docs.has("it:dedupe")).toBe(false);
  });

  test("a doc opened inside a railroad scope closes on scope teardown", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dispose = mount(root, () => {
      openDoc("it:scope", client);
      return document.createElement("span");
    });
    expect(client._docs.has("it:scope")).toBe(true);

    dispose();
    expect(client._docs.has("it:scope")).toBe(false);
    root.remove();
  });

  test("late provide(WS): a parked doc self-heals on first send()", async () => {
    clearProviders();
    const doc: Doc<BoardDoc> = openDoc("it:late"); // no client, WS not provided
    await new Promise((r) => queueMicrotask(() => r(undefined))); // deferred registration finds nothing

    provide(WS, client);
    await doc.send([{ op: "add", path: "/cards/7", value: { id: 7, title: "late" } }]);

    await doc.ready; // register-on-send opened the doc
    await until(() => doc.data.peek()?.cards["7"]?.title === "late");
    doc.close();
    clearProviders();
  });
  // railroad 0.11.0 makes async components a supported shape (resolve to a
  // thunk). There is no dispose scope after an `await` — browser JS has no
  // AsyncContext to carry one across suspension — so an openDoc past the first
  // await never auto-closes, while one inside the thunk does. The skill's
  // reference documents that rule; this pins the mechanism it rests on.
  test("no dispose scope survives an await; the thunk gets a fresh one", async () => {
    const seen: Record<string, boolean> = {};
    const root = document.createElement("div");
    document.body.appendChild(root);

    let settle!: () => void;
    const reached = new Promise<void>((r) => { settle = r; });

    const dispose = mount(root, () => {
      seen.sync = hasActiveDisposeScope();
      void (async () => {
        await Promise.resolve();
        seen.afterAwait = hasActiveDisposeScope();
        settle();
      })();
      return document.createElement("div");
    });

    await reached;
    dispose();
    root.remove();

    expect(seen.sync).toBe(true);        // synchronous body IS owned
    expect(seen.afterAwait).toBe(false); // post-await is NOT — hence the thunk rule
  });
});
