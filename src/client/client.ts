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
 *   message.close();   // release — automatic when opened inside a railroad scope
 *
 *   const status = await call<Status>("status");
 *
 * Rendering collections: with railroad in the project, its keyed `list()`
 * over `doc.data` is the idiom — per-row surgical updates come free (all
 * backends broadcast row-level ops). `doc.onOps(handler)` +
 * `applyOpsToCollection` (see `@blueshed/delta/dom-ops`) is the vanilla-DOM
 * equivalent for projects without a keyed reactive list primitive; pick one
 * per project.
 */
import {
  signal, batch, createLogger, key, inject, tryInject,
  hasActiveDisposeScope, trackDispose,
} from "@blueshed/railroad";
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
  /** Live Doc handles sharing this entry — openDoc dedupes by name, close()
   *  only unregisters when the last handle releases. */
  refs: number;
  /** Pending doc.ready resolvers; resolved and cleared on (each) open. */
  readyResolvers: Array<() => void>;
  /** The WsClient this entry is registered with, once known. */
  client: WsClient | null;
  /** Set when deferred registration found the name already registered under a
   *  different entry (mixed explicit-client + DI opens) — handles follow the
   *  chain to the canonical entry. */
  mergedInto?: OpenDocEntry;
  /**
   * Last authoritative server doc version applied — seeded from `_v` on the
   * open snapshot and advanced by `v` on each broadcast. `undefined` means the
   * backend doesn't version this doc (SQLite/JSON today, custom docs), so no
   * gap detection runs and ops apply as-is.
   */
  serverVersion?: number;
  /** True while a gap-triggered re-open is in flight (de-dupes resyncs). */
  resyncing?: boolean;
  /** True once the first open response has landed. Broadcasts arriving before
   *  that are dropped — the open snapshot is the authoritative starting state. */
  opened?: boolean;
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

  // Apply a broadcast's ops: fire onOps subscribers FIRST (so DOM patchers see
  // the op that matches the state change about to land), then patch `data`.
  function applyBroadcast(entry: OpenDocEntry, ops: DeltaOp[]): void {
    for (const handler of entry.opsHandlers) {
      try { handler(ops); }
      catch (err: any) { docLog.error(`onOps handler threw: ${err.message}`); }
    }
    const current = entry.data.peek();
    if (current) {
      // Mutate in place so captured child refs (e.g. a row object bound into a
      // drag-handler closure) stay valid across echoes. `set(sameRef)` is a
      // no-op under Object.is — `touch()` is the escape hatch that fires subs.
      applyOps(current, ops);
      // One consistent flush per broadcast: an effect reading both data and
      // dataVersion runs once, never in a half-updated window between the two.
      batch(() => {
        entry.dataVersion.set(entry.dataVersion.peek() + 1);
        entry.data.touch();
      });
    }
  }

  // A versioned broadcast arrived out of sequence (we missed at least one op).
  // Applying it would corrupt state, so re-open the doc to get an authoritative
  // snapshot; onOpen's synthetic root-replace lets onOps consumers reconcile.
  // De-duped: only one re-open in flight per doc.
  function resyncDoc(name: string, entry: OpenDocEntry): void {
    if (entry.resyncing) return;
    entry.resyncing = true;
    docLog.debug(`version gap on ${name} — resyncing`);
    sendInternal({ action: "open", doc: name })
      .then((state) => { entry.resyncing = false; entry.onOpen(state); })
      .catch((err: any) => { entry.resyncing = false; docLog.error(`resync ${name}: ${err.message}`); });
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
          // Drop broadcasts that arrive before the first open response: the
          // snapshot is the authoritative starting state, and firing onOps
          // against a not-yet-rendered doc (or seeding a version the snapshot
          // then resets) would diverge the onOps DOM from doc.data.
          if (entry && entry.opened) {
            // Coerce defensively — a versioning backend may send the number as
            // a string (e.g. pg BIGINT columns), and strict comparison below
            // must not silently mis-classify a string vs the numeric baseline.
            // A non-numeric/NaN `v` falls into the unversioned path rather than
            // poisoning serverVersion (NaN comparisons are always false).
            const n = Number(msg.v);
            const v: number | undefined = (msg.v == null || Number.isNaN(n)) ? undefined : n;
            const sv = entry.serverVersion;
            if (v != null && sv != null) {
              // Versioned doc — validate the server sequence.
              if (v <= sv) {
                // Duplicate / superseded echo — already applied. Ignore.
              } else if (v > sv + 1) {
                // GAP: at least one op was missed. Don't apply out of order —
                // re-open to resync from an authoritative snapshot.
                resyncDoc(msg.doc, entry);
              } else {
                // Contiguous (v === sv + 1) — apply and advance.
                applyBroadcast(entry, msg.ops);
                entry.serverVersion = v;
              }
            } else {
              // Unversioned backend (or no baseline yet) — apply as-is.
              applyBroadcast(entry, msg.ops);
              if (v != null) entry.serverVersion = v;
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
   * Release this handle. When the last handle for the doc name closes, the
   * doc is unregistered (broadcasts stop dispatching, reconnects stop
   * re-opening it) and a best-effort `close` action tells the server to
   * unsubscribe the socket. Idempotent per handle.
   *
   * Called automatically on scope teardown when the doc was opened inside a
   * railroad dispose scope (a component, a routes() handler, when()/list(),
   * or mount()) — so per-route docs don't accumulate for the life of the
   * page. Module-level opens have no scope and stay open.
   */
  close(): void;
}

const docLog = createLogger("[doc]");

// DI-based opens that run before `provide(WS, ...)` park their entries here,
// keyed by doc name, so duplicate openDoc(name) calls share ONE entry (one
// set of signals) even before the client exists. Entries move into the
// client's _docs map on registration.
const pendingDocs = new Map<string, OpenDocEntry>();

// First open renders from the caller reading `doc.data`; subsequent opens
// are reconnects, where onOps consumers (a DOM built from
// applyOpsToCollection) need a reconciliation signal because state may have
// drifted during the outage. `opened` lives on the entry so the broadcast
// handler can drop ops that arrive before the first open lands.
function createEntry(): OpenDocEntry {
  const data = signal<any>(null);
  const dataVersion = signal(0);
  const entry: OpenDocEntry = {
    data,
    dataVersion,
    opsHandlers: new Set<OpsHandler>(),
    refs: 1,
    readyResolvers: [],
    client: null,
    opened: false,
    onOpen: (state: any) => {
      // (Re)establish the authoritative version SOLELY from this snapshot: seed
      // from `_v` (added by versioning backends) and strip it so it never leaks
      // into `doc.data`; clear it when absent so a stale baseline (possibly set
      // from a broadcast) can't survive a re-open and cause a false gap.
      if (state && typeof state === "object" && "_v" in state) {
        entry.serverVersion = Number((state as any)._v);
        delete (state as any)._v;
      } else {
        entry.serverVersion = undefined;
      }
      // One flush: consumers of data + dataVersion see a single settled pass.
      batch(() => {
        data.set(state);
        dataVersion.set(dataVersion.peek() + 1);
      });
      if (entry.opened) {
        // RECONNECT: emit a synthetic whole-doc replace so onOps consumers can
        // reconcile against the authoritative post-reconnect snapshot. (No
        // emission on the FIRST open — initial render is the caller's job.)
        const reconcileOps: DeltaOp[] = [{ op: "replace", path: "", value: state }];
        for (const handler of entry.opsHandlers) {
          // Mirror the broadcast dispatch: one throwing handler must not break
          // the others.
          try { handler(reconcileOps); }
          catch (err: any) { docLog.error(`onOps reconcile handler threw: ${err.message}`); }
        }
      }
      entry.opened = true;
      const resolvers = entry.readyResolvers;
      entry.readyResolvers = [];
      for (const r of resolvers) r();
    },
  };
  return entry;
}

/**
 * Register `entry` as the canonical entry for `name` on client `c`. If the
 * name is already registered under a DIFFERENT entry (mixed explicit-client +
 * DI opens of the same doc), merge into it: fold refs, ops handlers, and
 * ready resolvers, and leave a `mergedInto` pointer for handles to follow.
 * Idempotent once `entry.client` is set.
 */
function registerEntry(c: WsClient, name: string, entry: OpenDocEntry): void {
  if (entry.client) return;
  if (pendingDocs.get(name) === entry) pendingDocs.delete(name);
  const existing = c._docs.get(name);
  if (existing && existing !== entry) {
    existing.refs += entry.refs;
    for (const h of entry.opsHandlers) existing.opsHandlers.add(h);
    if (existing.opened) {
      for (const r of entry.readyResolvers) r();
    } else {
      existing.readyResolvers.push(...entry.readyResolvers);
    }
    entry.readyResolvers = [];
    entry.mergedInto = existing;
    entry.client = c;
    return;
  }
  entry.client = c;
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

/**
 * Open a persisted doc as a reactive signal. Safe to call at module level —
 * if no `client` is passed, the WsClient is resolved from DI
 * (`provide(WS, connectWs(...))`), eagerly when already provided, else via a
 * deferred registration that also self-heals on first `send()`. For scripts
 * or tests that want multiple independent clients in one process, pass the
 * `client` explicitly.
 *
 * Repeated openDoc(name) calls on the same client share one underlying entry
 * — the same signals — with a refcount; `close()` releases a handle and
 * unregisters the doc when the last one goes. Opened inside a railroad
 * dispose scope, the handle closes automatically on scope teardown.
 */
export function openDoc<T>(name: string, client?: WsClient): Doc<T> {
  let entry: OpenDocEntry;
  let closed = false;

  // Follow merges so every access sees the canonical entry.
  const cur = (): OpenDocEntry => {
    while (entry.mergedInto) entry = entry.mergedInto;
    return entry;
  };

  // Resolve the client as early as possible: an explicit argument, or DI when
  // provide(WS, ...) has already run — the common case, and the one where
  // dedupe is exact. Only otherwise do we park in pendingDocs and defer.
  const eager = client ?? tryInject(WS) ?? null;
  if (eager) {
    const existing = eager._docs.get(name);
    if (existing) {
      existing.refs++;
      entry = existing;
    } else {
      entry = createEntry();
      registerEntry(eager, name, entry);
    }
  } else {
    const pending = pendingDocs.get(name);
    if (pending) {
      pending.refs++;
      entry = pending;
    } else {
      entry = createEntry();
      pendingDocs.set(name, entry);
    }
    // Defer DI resolution so openDoc can be called at module load before
    // `provide(WS, ...)` has run. If WS still isn't provided by then, stay
    // parked — send() retries registration, so a late provide self-heals.
    queueMicrotask(() => {
      if (closed) return;
      const c = tryInject(WS);
      if (c) registerEntry(c, name, cur());
      else docLog.error(`openDoc("${name}"): no WS provided — will register on first send()`);
    });
  }

  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => { readyResolve = r; });
  if (entry.opened) readyResolve();
  else entry.readyResolvers.push(readyResolve);

  const ensureClient = (): WsClient => {
    const e = cur();
    const c = e.client ?? client ?? inject(WS);
    if (!closed) registerEntry(c, name, e);
    return c;
  };

  const doc: Doc<T> = {
    get data() { return cur().data; },
    get dataVersion() { return cur().dataVersion; },
    ready,
    send(ops: DeltaOp[]) {
      return ensureClient().send({ action: "delta", doc: name, ops });
    },
    onOps(handler) {
      cur().opsHandlers.add(handler);
      return () => { cur().opsHandlers.delete(handler); };
    },
    close() {
      if (closed) return;
      closed = true;
      const e = cur();
      e.refs--;
      if (e.refs > 0) return;
      if (pendingDocs.get(name) === e) pendingDocs.delete(name);
      if (e.client) {
        e.client._docs.delete(name);
        // Best-effort server unsubscribe — ignore transport failures.
        e.client.send({ action: "close", doc: name }).catch(() => {});
      }
    },
  };

  // Opened inside a railroad dispose scope (a component, a routes() handler,
  // a when()/list() render, or mount()): release with the scope, so per-route
  // docs don't accumulate subscriptions for the life of the page.
  if (hasActiveDisposeScope()) trackDispose(() => doc.close());

  return doc;
}

/** Call a stateless RPC method. Accepts an explicit client for multi-client scripts. */
export function call<T>(method: string, params?: any, client?: WsClient): Promise<T> {
  const c = client ?? inject(WS);
  return c.send({ action: "call", method, params });
}
