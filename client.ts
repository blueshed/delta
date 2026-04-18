/**
 * Delta Client — WebSocket client + reactive document sync for the browser.
 *
 * Provides the client half of the delta-doc system:
 *   - connectWs()  — reconnecting WebSocket with request/response and notifications
 *   - openDoc()    — open a persisted document as a reactive signal
 *   - call()       — invoke a stateless RPC method
 *
 * Usage:
 *   import { connectWs, openDoc, call, WS } from "@blueshed/railroad/delta-client";
 *   import { provide } from "@blueshed/railroad/shared";
 *
 *   provide(WS, connectWs("/ws"));
 *
 *   const message = openDoc<Message>("message");
 *   effect(() => console.log(message.data.get()));
 *   message.send([{ op: "replace", path: "/message", value: "hello" }]);
 *
 *   const status = await call<Status>("status");
 */
import { signal, createLogger, key, inject } from "@blueshed/railroad";
import { applyOps, type DeltaOp } from "./core";

export type { DeltaOp } from "./core";

/**
 * Rejection shape of `call()` and `doc.send()` — returned by the server when
 * an action errors. `code` is numeric (401 for auth, 400 for bad input, etc).
 * `DeltaError.isDeltaError(e)` narrows a caught unknown to this shape.
 */
export interface DeltaError {
  code: number;
  message: string;
}

export const DeltaError = {
  isDeltaError(e: unknown): e is DeltaError {
    return (
      !!e && typeof e === "object"
      && typeof (e as any).code === "number"
      && typeof (e as any).message === "string"
    );
  },
};

// ---------------------------------------------------------------------------
// Reconnecting WebSocket
// ---------------------------------------------------------------------------

function reconnectingWebSocket(url: string): WebSocket {
  let ws!: WebSocket;
  const proxy = new EventTarget();
  let backoff = 500;

  function connect() {
    ws = new WebSocket(url);
    ws.addEventListener("open", () => {
      backoff = 500;
      proxy.dispatchEvent(new Event("open"));
    });
    ws.addEventListener("message", (e: MessageEvent) => {
      proxy.dispatchEvent(new MessageEvent("message", { data: e.data }));
    });
    ws.addEventListener("close", () => {
      proxy.dispatchEvent(new Event("close"));
      setTimeout(connect, (backoff = Math.min(backoff * 2, 30_000)));
    });
    ws.addEventListener("error", () => {
      proxy.dispatchEvent(new Event("error"));
    });
  }

  (proxy as any).send = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  Object.defineProperty(proxy, "readyState", {
    get: () => ws.readyState,
  });

  connect();
  return proxy as unknown as WebSocket;
}

// ---------------------------------------------------------------------------
// WebSocket client
// ---------------------------------------------------------------------------

export type NotifyHandler = (msg: any) => void;

export interface WsClient {
  connected: ReturnType<typeof signal<boolean>>;
  send(msg: any): Promise<any>;
  on(event: string, handler: NotifyHandler): () => void;
}

export const WS = key<WsClient>("ws");

/** Connect to a delta-server WebSocket endpoint. */
export function connectWs(
  wsPath: string = "/ws",
  opts?: { clientId?: string },
): WsClient {
  const log = createLogger("[ws]");
  const url = new URL(wsPath, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  if (opts?.clientId) url.searchParams.set("clientId", opts.clientId);
  const connected = signal(false);
  const ws = reconnectingWebSocket(url.href);
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  const listeners = new Map<string, Set<NotifyHandler>>();
  let nextId = 1;
  let readyResolve: () => void;
  let ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  ws.addEventListener("open", () => {
    log.info("connected");
    connected.set(true);
    readyResolve();
    listeners.get("open")?.forEach((fn) => fn({}));
  });

  ws.addEventListener("close", () => {
    log.info("disconnected");
    connected.set(false);
    ready = new Promise<void>((r) => {
      readyResolve = r;
    });
    listeners.get("close")?.forEach((fn) => fn({}));
  });

  ws.addEventListener(
    "message",
    ((ev: MessageEvent) => {
      const msg = JSON.parse(ev.data);
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          log.error(`#${msg.id} error: ${msg.error.message}`);
          reject(msg.error);
        } else {
          log.debug(`#${msg.id} ack`);
          resolve(msg.result);
        }
      } else {
        log.debug(`notify ${JSON.stringify(msg).slice(0, 80)}`);
        listeners.get("message")?.forEach((fn) => fn(msg));
      }
    }) as EventListener,
  );

  return {
    connected,
    async send(msg: any): Promise<any> {
      await ready;
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        log.debug(`#${id} ${msg.action} ${msg.doc ?? msg.method ?? ""}`);
        ws.send(JSON.stringify({ ...msg, id }));
      });
    },
    on(event: string, handler: NotifyHandler): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)!.delete(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Document — reactive signal backed by a server-side delta-doc
// ---------------------------------------------------------------------------

export interface Doc<T> {
  data: ReturnType<typeof signal<T | null>>;
  dataVersion: ReturnType<typeof signal<number>>;
  ready: Promise<void>;
  send(ops: DeltaOp[]): Promise<any>;
}

const log = createLogger("[doc]");
const openDocs = new Map<
  string,
  { data: ReturnType<typeof signal<any>>; dataVersion: ReturnType<typeof signal<number>> }
>();

/** Lazily resolve the WS client — deferred so openDoc can be called at module level. */
let _ws: WsClient | null = null;
function ws(): WsClient {
  if (!_ws) {
    _ws = inject(WS);

    _ws.on("open", () => {
      for (const [name, entry] of openDocs) {
        _ws!.send({ action: "open", doc: name }).then((state) => {
          entry.data.set(state);
          entry.dataVersion.set(entry.dataVersion.peek() + 1);
        });
      }
    });

    _ws.on("message", (msg) => {
      if (msg.doc && msg.ops) {
        const entry = openDocs.get(msg.doc);
        if (entry) {
          const current = entry.data.peek();
          if (current) {
            const updated = structuredClone(current);
            applyOps(updated, msg.ops);
            entry.data.set(updated);
            entry.dataVersion.set(entry.dataVersion.peek() + 1);
          }
        }
      }
    });
  }
  return _ws;
}

/** Open a persisted doc as a reactive signal. Safe to call at module level. */
export function openDoc<T>(name: string): Doc<T> {
  const data = signal<T | null>(null);
  const dataVersion = signal(0);
  openDocs.set(name, { data, dataVersion });

  let readyResolve: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  queueMicrotask(() => {
    try {
      ws()
        .send({ action: "open", doc: name })
        .then((state) => {
          data.set(state as T);
          readyResolve();
        });
    } catch (err: any) {
      log.error(`openDoc("${name}"): ${err.message}`);
    }
  });

  return {
    data,
    dataVersion,
    ready,
    send(ops: DeltaOp[]) {
      return ws().send({ action: "delta", doc: name, ops });
    },
  };
}

/** Call a stateless RPC method. */
export function call<T>(method: string, params?: any): Promise<T> {
  return ws().send({ action: "call", method, params });
}
