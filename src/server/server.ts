/**
 * Delta Server — WebSocket protocol layer + document/method registration for Bun.
 *
 * Provides the server half of the delta-doc system:
 *   - createWs()       — shared WebSocket infrastructure (action routing, pub/sub, upgrade)
 *   - registerDoc()    — persist a typed JSON document, sync via delta ops
 *   - registerMethod() — expose a stateless RPC handler (public; names
 *                        starting with `_` are private and never wire-callable)
 *
 * Usage:
 *   import { createWs, registerDoc, registerMethod } from "@blueshed/railroad/delta-server";
 *
 *   const ws = createWs();
 *   await registerDoc<Message>(ws, "message", { file: "./message.json", empty: { message: "" } });
 *   registerMethod(ws, "status", () => ({ bun: Bun.version }));
 *
 *   const server = Bun.serve({
 *     routes: { [ws.path]: ws.upgrade, ...myRoutes },
 *     websocket: ws.websocket,
 *   });
 *   ws.setServer(server);
 */
import { createLogger } from "./logger";
import { applyOps, splitPath, type DeltaOp } from "../core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActionHandler = (
  msg: any,
  ws: any,
  respond: (result: any) => void,
) => any | Promise<any>;

export interface WsServer {
  path: string;
  on(action: string, handler: ActionHandler): void;
  publish(channel: string, data: any): void;
  sendTo(clientId: string, data: any): void;
  setServer(s: any): void;
  upgrade: (req: Request, server: any) => Response | undefined;
  websocket: {
    idleTimeout: number;
    sendPings: boolean;
    publishToSelf: boolean;
    open(ws: any): void;
    message(ws: any, raw: any): void;
    close(ws: any): void;
  };
}

export interface DocHandle<T> {
  getDoc(): T;
  setDoc(d: T): void;
  persist(): Promise<void>;
  applyAndBroadcast(ops: DeltaOp[]): void;
}

export interface DocOptions<T> {
  file: string;
  empty: T;
}

// ---------------------------------------------------------------------------
// Subscription tracking
// ---------------------------------------------------------------------------
//
// Bun's pub/sub gives us `ws.subscribe`/`ws.unsubscribe` but no way to list a
// socket's current subscriptions. Backends therefore route every subscribe
// through `trackSubscribe`, which records the channel on `ws.data.channels`.
// That lets `dropClientSubscriptions` tear them all down on logout / identity
// switch (otherwise a socket keeps receiving a prior user's scoped doc ops
// until it physically disconnects).

/** Subscribe a socket to a channel and record it for later teardown. */
export function trackSubscribe(client: any, channel: string): void {
  if (!client.data) client.data = {};
  (client.data.channels ??= new Set<string>()).add(channel);
  client.subscribe(channel);
}

/** Unsubscribe a socket from a channel and forget it. */
export function trackUnsubscribe(client: any, channel: string): void {
  client.data?.channels?.delete(channel);
  client.unsubscribe(channel);
}

/**
 * Unsubscribe a socket from every channel it joined via `trackSubscribe`.
 * Called on logout / identity switch so the previous identity's live doc
 * streams stop immediately rather than leaking until disconnect.
 */
export function dropClientSubscriptions(client: any): void {
  const channels = client.data?.channels as Set<string> | undefined;
  if (channels) {
    for (const ch of channels) {
      try { client.unsubscribe(ch); } catch { /* socket may be closing */ }
    }
    channels.clear();
  }
  runClientDropHooks(client);
}

/**
 * Register a callback to run when this socket's subscriptions are torn down —
 * transport-level close (tab closed, network drop) or an identity drop via
 * `dropClientSubscriptions` (logout / switch). Backends use it to release
 * per-socket subscriber state: the polite `close` ACTION only arrives when a
 * client sends one, and a dropped socket never does. Hooks live in a Set keyed
 * by function identity, so re-registering the same closure on every open is a
 * cheap no-op; the set clears after running (a re-open after logout
 * re-registers).
 */
export function onClientDrop(client: any, fn: (client: any) => void): void {
  if (!client.data) client.data = {};
  (client.data.dropHooks ??= new Set<(c: any) => void>()).add(fn);
}

function runClientDropHooks(client: any): void {
  const hooks = client.data?.dropHooks as Set<(c: any) => void> | undefined;
  if (!hooks?.size) return;
  const fns = [...hooks];
  hooks.clear();
  for (const fn of fns) {
    try { fn(client); } catch { /* teardown must not throw into transport close */ }
  }
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

export interface WsOptions {
  path?: string;
  idleTimeout?: number;
  sendPings?: boolean;
}

/** Create a shared WebSocket server with action routing and Bun pub/sub. */
export function createWs(opts?: WsOptions): WsServer {
  const log = createLogger("[ws]");
  const actions = new Map<string, ActionHandler[]>();
  const clients = new Map<string, any>();
  let serverRef: any;

  const path = opts?.path ?? "/ws";

  function upgrade(req: Request, server: any) {
    const clientId = new URL(req.url).searchParams.get("clientId") ?? crypto.randomUUID();
    if (server.upgrade(req, { data: { clientId } })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  return {
    path,

    on(action: string, handler: ActionHandler) {
      if (!actions.has(action)) actions.set(action, []);
      actions.get(action)!.push(handler);
    },

    publish(channel: string, data: any) {
      serverRef?.publish(channel, JSON.stringify(data));
    },

    sendTo(clientId: string, data: any) {
      const ws = clients.get(clientId);
      if (ws?.readyState === 1) ws.send(JSON.stringify(data));
    },

    setServer(s: any) {
      serverRef = s;
    },

    upgrade,

    websocket: {
      idleTimeout: opts?.idleTimeout ?? 60,
      sendPings: opts?.sendPings ?? true,
      publishToSelf: true,
      open(ws: any) {
        if (!ws.data) ws.data = {};
        // The clientId arrives from the upgrade query string and is therefore
        // client-controlled. Mint a fresh id ONLY when a DIFFERENT, still-open
        // socket already holds it (a genuine live collision — never let one
        // client clobber/hijack another's `sendTo` mapping). A socket
        // reconnecting with its own stable clientId reclaims the id once the
        // old connection is gone/closing, preserving sendTo across reconnects.
        let clientId = ws.data.clientId;
        const existing = clientId ? clients.get(clientId) : undefined;
        if (!clientId || (existing && existing !== ws && existing.readyState === 1)) {
          clientId = crypto.randomUUID();
        }
        ws.data.clientId = clientId;
        clients.set(clientId, ws);
        for (const ch of ws.data?.channels ?? []) ws.subscribe(ch);
        log.debug(`open id=${clientId}`);
      },
      async message(ws: any, raw: any) {
        // Parse INSIDE the try: this is an async handler, so a non-JSON frame
        // used to reject with nothing to catch it — an unhandled rejection any
        // client could trigger at will, and a remote kill for any process that
        // installs a strict `unhandledRejection` handler. There is no `id` to
        // answer on when the parse itself fails, so that case only logs.
        let msg: any;
        let id: any;
        let action: any;
        try {
          msg = JSON.parse(String(raw));
          ({ id, action } = msg);

          if (!action) {
            for (const handler of actions.get("_raw") ?? []) {
              await handler(msg, ws, () => {});
            }
            return;
          }

          // Private methods (leading `_`) are internal helpers: composable
          // within other handlers' bodies, never reachable from the wire.
          // Reject before any handler runs, so the gate can't be bypassed and
          // covers unregistered `_` names too.
          if (
            action === "call" &&
            typeof msg.method === "string" &&
            msg.method.startsWith("_")
          ) {
            if (id)
              ws.send(
                JSON.stringify({
                  id,
                  error: { code: -1, message: `Private method: ${msg.method}` },
                }),
              );
            return;
          }

          const handlers = actions.get(action);
          if (!handlers?.length) {
            if (id)
              ws.send(
                JSON.stringify({
                  id,
                  error: { code: -1, message: `Unknown action: ${action}` },
                }),
              );
            return;
          }
          let responded = false;
          const respond = (response: any) => {
            if (!responded && id) {
              responded = true;
              ws.send(JSON.stringify({ id, ...response }));
            }
          };
          for (const handler of handlers) {
            await handler(msg, ws, respond);
            if (responded) break;
          }
          if (!responded && id) {
            ws.send(
              JSON.stringify({
                id,
                error: { code: -1, message: `No handler matched: ${action}` },
              }),
            );
          }
        } catch (err: any) {
          log.error(`error: ${err.message}`);
          if (id)
            ws.send(
              JSON.stringify({ id, error: { code: -1, message: err.message } }),
            );
        }
      },
      close(ws: any) {
        const clientId = ws.data?.clientId;
        // Only delete our own mapping — a collision-replaced socket may now
        // own this id.
        if (clientId && clients.get(clientId) === ws) clients.delete(clientId);
        runClientDropHooks(ws);
        log.debug(`close id=${clientId ?? "?"}`);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Document registration
// ---------------------------------------------------------------------------

// JSON-Pointer re-escape (inverse of splitPath's unescape): ~ first, then /.
const escapeSegment = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Normalize a delta batch for broadcast: rewrite field-level ops (depth >= 3,
 * e.g. `/cards/5/title`) into whole-row replaces of their depth-2 ancestor
 * (`/cards/5`), with the row value read from the just-applied doc state.
 *
 * The SQLite and Postgres backends already broadcast whole-row ops; without
 * this, the JSON-file backend was the one path emitting field-level ops on the
 * wire — which keyed reactive consumers (railroad's `list()`) cannot see: the
 * client applies them by mutating the row object in place, so the row's
 * identity never changes and its DOM goes stale. Whole-row replaces give every
 * consumer a fresh row reference.
 *
 * Depth <= 2 ops pass through untouched. Multiple field ops on one row
 * collapse to a single replace (the doc already reflects the whole batch). A
 * rewrite whose row no longer exists (removed later in the same batch) is
 * dropped — the removal op itself broadcasts the disappearance.
 *
 * Exported for custom DocType authors who assemble their own broadcasts.
 */
export function normalizeForBroadcast(doc: unknown, ops: DeltaOp[]): DeltaOp[] {
  const out: DeltaOp[] = [];
  const rewritten = new Set<string>();
  for (const op of ops) {
    const segs = splitPath(op.path);
    if (segs.length < 3) {
      out.push(op);
      continue;
    }
    const rowPath = `/${escapeSegment(segs[0]!)}/${escapeSegment(segs[1]!)}`;
    if (rewritten.has(rowPath)) continue;
    const row = (doc as any)?.[segs[0]!]?.[segs[1]!];
    if (row === undefined) continue;
    rewritten.add(rowPath);
    out.push({ op: "replace", path: rowPath, value: row });
  }
  return out;
}

/** Register a persisted JSON document with the WebSocket server. */
export async function registerDoc<T>(
  ws: Pick<WsServer, "on" | "publish">,
  name: string,
  opts: DocOptions<T>,
): Promise<DocHandle<T>> {
  const log = createLogger(`[${name}]`);
  const dataFile = Bun.file(opts.file);
  let doc: T = (await dataFile.exists())
    ? { ...structuredClone(opts.empty), ...((await dataFile.json()) as T) }
    : structuredClone(opts.empty);

  log.info(`loaded from ${opts.file}`);

  // Whole-file writes are serialized through a promise chain. Two rapid deltas
  // previously raced `Bun.write`, so the file could settle on the OLDER
  // snapshot when the writes completed out of order.
  let persisting: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const done = persisting
      .then(() => Bun.write(dataFile, JSON.stringify(doc, null, 2)))
      .then(() => {});
    // The chain must survive a failed write, so it continues from a swallowed
    // copy — but the promise handed back still rejects, so an explicit
    // `await handle.persist()` can observe the error.
    persisting = done.catch(() => {});
    return done;
  }

  function applyAndBroadcast(ops: DeltaOp[]) {
    applyOps(doc, ops);
    log.info(`delta [${ops.map((o) => `${o.op} ${o.path}`).join(", ")}]`);
    ws.publish(name, { doc: name, ops: normalizeForBroadcast(doc, ops) });
    // Fire-and-forget by design (the delta is already acked and broadcast), so
    // an fs failure is logged rather than left as an unhandled rejection.
    persist().catch((err: any) => log.error(`persist failed: ${err.message}`));
  }

  ws.on("open", (msg, client, respond) => {
    if (msg.doc !== name) return;
    trackSubscribe(client, name);
    respond({ result: doc });
    log.debug("opened");
  });

  ws.on("delta", (msg, _client, respond) => {
    if (msg.doc !== name) return;
    applyAndBroadcast(msg.ops);
    respond({ result: { ack: true } });
  });

  ws.on("close", (msg, client, respond) => {
    if (msg.doc !== name) return;
    trackUnsubscribe(client, name);
    respond({ result: { ack: true } });
    log.debug("closed");
  });

  return { getDoc: () => doc, setDoc: (d: T) => { doc = d; }, persist, applyAndBroadcast };
}

// ---------------------------------------------------------------------------
// Method registration
// ---------------------------------------------------------------------------

/**
 * Register a stateless RPC method with the WebSocket server.
 *
 * Method names starting with `_` are reserved for private helpers and are
 * rejected by the dispatcher (never callable from the wire), so registering
 * one here is a programming error and throws.
 */
export function registerMethod(
  ws: Pick<WsServer, "on">,
  name: string,
  handler: (params: any, client: any) => any | Promise<any>,
) {
  if (name.startsWith("_"))
    throw new Error(
      `registerMethod: "${name}" is private (leading "_") and can never be called from the WebSocket`,
    );
  ws.on("call", async (msg, client, respond) => {
    if (msg.method !== name) return;
    const log = createLogger(`[${name}]`);
    log.debug("called");
    respond({ result: await handler(msg.params, client) });
  });
}
