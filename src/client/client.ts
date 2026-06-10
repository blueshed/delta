/**
 * Delta Client — WebSocket client + reactive document sync for the browser.
 *
 * Provides the client half of the delta-doc system:
 *   - connectWs()  — reconnecting WebSocket with request/response and notifications
 *   - openDoc()    — open a persisted document as a reactive signal
 *   - call()       — invoke a stateless RPC method
 *
 * Usage:
 *   import { connectWs, openDoc, call, WS } from "@blueshed/delta/client";
 *   import { provide } from "@blueshed/railroad";
 *
 *   provide(WS, connectWs("/ws"));
 *
 *   const message = openDoc<Message>("message");
 *   effect(() => console.log(message.data.get()));
 *   message.send([{ op: "replace", path: "/message", value: "hello" }]);
 *
 *   const status = await call<Status>("status");
 *
 * For large collections, prefer `doc.onOps(handler)` over `doc.data` — it
 * delivers the raw JSON-Patch ops so a renderer can mutate DOM atomically
 * (see `@blueshed/delta/dom-ops` → `applyOpsToCollection`) instead of
 * rebuilding subtrees on every change.
 */
import { signal, batch, createLogger, key, inject } from "@blueshed/railroad";
import { applyOps, type DeltaOp } from "../core";

export type { DeltaOp } from "../core";

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
  let closed = false;

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
      // Suppress reconnect when close() was called explicitly — otherwise
      // every server restart (tests, demos, HMR) loops forever.
      if (closed) return;
      setTimeout(connect, (backoff = Math.min(backoff * 2, 30_000)));
    });
    ws.addEventListener("error", () => {
      proxy.dispatchEvent(new Event("error"));
    });
  }

  (proxy as any).send = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  (proxy as any).close = () => {
    closed = true;
    try { ws.close(); } catch { /* already closed */ }
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
  /**
   * Close the socket and suppress reconnection. Any in-flight `send` promises
   * are rejected: explicit close() rejects with `{code:0, message:"closed"}`,
   * and an unexpected transport drop (which may reconnect) rejects with
   * `{code:0, message:"disconnected"}`. Idempotent.
   */
  close(): void;
  /**
   * Internal — per-client map of `openDoc` subscribers. Each `connectWs`
   * instance has its own, so multiple clients in one process don't share
   * state. Consumers shouldn't read this directly; use `openDoc(name, ws)`.
   */
  _docs: Map<string, OpenDocEntry>;
}

export type OpsHandler = (ops: DeltaOp[]) => void;

export interface OpenDocEntry {
  data: ReturnType<typeof signal<any>>;
  dataVersion: ReturnType<typeof signal<number>>;
  opsHandlers: Set<OpsHandler>;
  /** Called with the full doc state on open and every reconnect. */
  onOpen: (state: any) => void;
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
  // Per-client doc subscriptions. Moved off module scope so two connectWs()
  // instances in the same process don't share reactive state.
  const docs = new Map<string, OpenDocEntry>();
  const docLog = createLogger("[doc]");
  let nextId = 1;
  let isClosed = false;
  let readyResolve: () => void;
  let ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  async function sendInternal(msg: any): Promise<any> {
    if (isClosed) throw { code: 0, message: "closed" };
    await ready;
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      log.debug(`#${id} ${msg.action} ${msg.doc ?? msg.method ?? ""}`);
      ws.send(JSON.stringify({ ...msg, id }));
    });
  }

  ws.addEventListener("open", () => {
    log.info("connected");
    connected.set(true);
    readyResolve();
    listeners.get("open")?.forEach((fn) => fn({}));

    // Re-open every tracked doc. Fires on initial connect AND on reconnect,
    // so a doc opened before the socket came up or during an outage catches
    // up as soon as the socket is ready.
    for (const [name, entry] of docs) {
      sendInternal({ action: "open", doc: name })
        .then((state) => entry.onOpen(state))
        .catch((err: any) => docLog.error(`re-open ${name}: ${err.message}`));
    }
  });

  ws.addEventListener("close", () => {
    log.info("disconnected");
    connected.set(false);
    ready = new Promise<void>((r) => {
      readyResolve = r;
    });
    // Drain in-flight requests on EVERY socket drop (including those that will
    // reconnect) so outstanding `send`/`call` awaits fail fast instead of
    // hanging forever. Use a DISTINCT message ("disconnected") so callers can
    // tell a retryable transport drop from an explicit close() ("closed").
    pending.forEach(({ reject }) => reject({ code: 0, message: "disconnected" }));
    pending.clear();
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

        // Doc op broadcast — dispatch to the matching entry if any.
        if (msg.doc && msg.ops) {
          const entry = docs.get(msg.doc);
          if (entry) {
            // Fire op subscribers FIRST, so DOM patchers see the op that
            // matches the state change about to land on `data`.
            for (const handler of entry.opsHandlers) {
              try { handler(msg.ops); }
              catch (err: any) { docLog.error(`onOps handler threw: ${err.message}`); }
            }
            const current = entry.data.peek();
            if (current) {
              // Mutate in place so captured child refs (e.g. a row object
              // bound into a drag-handler closure) stay valid across echoes.
              // `set(sameRef)` is a no-op under Object.is — `touch()` is the
              // escape hatch that fires subscribers. The two notifications
              // are batched so an effect reading both `data` and
              // `dataVersion` re-runs once per delta, not twice.
              applyOps(current, msg.ops);
              batch(() => {
                entry.dataVersion.set(entry.dataVersion.peek() + 1);
                entry.data.touch();
              });
            }
          }
        }

        listeners.get("message")?.forEach((fn) => fn(msg));
      }
    }) as EventListener,
  );

  return {
    connected,
    send: sendInternal,
    on(event: string, handler: NotifyHandler): () => void {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => listeners.get(event)!.delete(handler);
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      (ws as any).close?.();
      listeners.clear();
      docs.clear();
      pending.forEach(({ reject }) => reject({ code: 0, message: "closed" }));
      pending.clear();
    },
    _docs: docs,
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
  /**
   * Subscribe to the raw JSON-Patch ops as they arrive — BEFORE they are
   * applied to `doc.data`. Use this to route `add` / `replace` / `remove`
   * straight to DOM nodes via `applyOpsToCollection` (see `dom-ops.ts`)
   * instead of re-rendering from the full state signal. Returns an
   * unsubscribe function.
   */
  onOps(handler: OpsHandler): () => void;
  /**
   * Stop receiving this doc. Removes the local subscription (no broadcasts,
   * no re-open on reconnect), drops all `onOps` handlers, sends the wire
   * `close` so the server can release the channel (and, on SQLite, evict the
   * doc cache when this was the last subscriber), and rejects any later
   * `send`. `doc.data` keeps its last value for teardown reads. Idempotent.
   * Call it when a view navigates away — an unclosed doc stays live (and
   * re-subscribes on every reconnect) for the life of the socket.
   */
  close(): Promise<void>;
}

const docLog = createLogger("[doc]");

/**
 * Open a persisted doc as a reactive signal. Safe to call at module level —
 * if no `client` is passed, the WsClient is resolved lazily from DI
 * (`provide(WS, connectWs(...))`). For scripts or tests that want multiple
 * independent clients in one process, pass the `client` explicitly.
 */
export function openDoc<T>(name: string, client?: WsClient): Doc<T> {
  const data = signal<T | null>(null);
  const dataVersion = signal(0);
  const opsHandlers = new Set<OpsHandler>();

  let readyResolve: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  // First open renders from the caller reading `doc.data`; subsequent opens
  // are reconnects, where onOps consumers (a DOM built from
  // applyOpsToCollection) need a reconciliation signal because state may have
  // drifted during the outage.
  let opened = false;
  const entry: OpenDocEntry = {
    data,
    dataVersion,
    opsHandlers,
    onOpen: (state: any) => {
      // Batched for the same reason as the broadcast path: one settled pass
      // for subscribers that read both signals.
      batch(() => {
        data.set(state as T);
        dataVersion.set(dataVersion.peek() + 1);
      });
      if (opened) {
        // RECONNECT: emit a synthetic whole-doc replace so onOps consumers can
        // reconcile against the authoritative post-reconnect snapshot. (No
        // emission on the FIRST open — initial render is the caller's job.)
        const reconcileOps: DeltaOp[] = [{ op: "replace", path: "", value: state }];
        for (const handler of opsHandlers) {
          // Mirror the broadcast dispatch: one throwing handler must not break
          // the others.
          try { handler(reconcileOps); }
          catch (err: any) { docLog.error(`onOps reconcile handler threw: ${err.message}`); }
        }
      }
      opened = true;
      readyResolve();
    },
  };

  let wsc: WsClient | null = client ?? null;
  let closed = false;

  function register(c: WsClient): void {
    if (closed) return;
    wsc = c;
    c._docs.set(name, entry);
    // If the socket is already open when we register, kick off the initial
    // open now. Otherwise the `open`-event handler inside connectWs will
    // fire the open for every tracked doc once the socket is up.
    if (c.connected.peek()) {
      c.send({ action: "open", doc: name })
        .then(entry.onOpen)
        .catch((err: any) => docLog.error(`openDoc("${name}"): ${err.message}`));
    }
  }

  if (client) {
    register(client);
  } else {
    // Defer DI resolution so openDoc can be called at module load before
    // `provide(WS, ...)` has run.
    queueMicrotask(() => {
      try { register(inject(WS)); }
      catch (err: any) { docLog.error(`openDoc("${name}"): ${err.message}`); }
    });
  }

  return {
    data,
    dataVersion,
    ready,
    send(ops: DeltaOp[]) {
      if (closed) return Promise.reject({ code: 0, message: "doc closed" });
      const c = wsc ?? (wsc = client ?? inject(WS));
      return c.send({ action: "delta", doc: name, ops });
    },
    onOps(handler) {
      opsHandlers.add(handler);
      return () => { opsHandlers.delete(handler); };
    },
    async close() {
      if (closed) return;
      closed = true;
      opsHandlers.clear();
      // Resolve `ready` so an awaiter of a never-opened doc isn't stranded.
      readyResolve();
      const c = wsc;
      // Only delete our own entry — a later openDoc(name) on the same client
      // owns the slot now.
      if (c && c._docs.get(name) === entry) c._docs.delete(name);
      if (c && c.connected.peek()) {
        // Best-effort: the local teardown above is what matters; the socket
        // may be down or the server may 401 a post-logout close.
        try { await c.send({ action: "close", doc: name }); } catch { /* ignore */ }
      }
    },
  };
}

/** Call a stateless RPC method. Accepts an explicit client for multi-client scripts. */
export function call<T>(method: string, params?: any, client?: WsClient): Promise<T> {
  const c = client ?? inject(WS);
  return c.send({ action: "call", method, params });
}
