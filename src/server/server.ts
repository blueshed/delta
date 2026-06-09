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
import { applyOps, type DeltaOp } from "../core";

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
  if (!channels) return;
  for (const ch of channels) {
    try { client.unsubscribe(ch); } catch { /* socket may be closing */ }
  }
  channels.clear();
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
        // Parse inside a guard: a non-JSON frame must not become an unhandled
        // rejection (there's no id to respond to, so just drop it).
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          log.error("ignoring malformed frame (invalid JSON)");
          return;
        }
        const { id, action } = msg;

        if (!action) {
          for (const handler of actions.get("_raw") ?? []) {
            await handler(msg, ws, () => {});
          }
          return;
        }

        try {
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
        log.debug(`close id=${clientId ?? "?"}`);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Document registration
// ---------------------------------------------------------------------------

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

  // Persist writes are serialized through a chain so two rapid deltas can't
  // interleave Bun.write calls. A prior failure doesn't poison the chain (the
  // catch resets it); callers decide whether to await or log-and-continue.
  let persistChain: Promise<unknown> = Promise.resolve();
  function persist(): Promise<void> {
    const next = persistChain
      .catch(() => { /* prior failure already surfaced to its caller */ })
      .then(() => Bun.write(dataFile, JSON.stringify(doc, null, 2)))
      .then(() => {});
    persistChain = next;
    return next;
  }

  function applyAndBroadcast(ops: DeltaOp[]) {
    applyOps(doc, ops);
    log.info(`delta [${ops.map((o) => `${o.op} ${o.path}`).join(", ")}]`);
    ws.publish(name, { doc: name, ops });
    // The ack already went out — the doc is in-memory-first by design — so a
    // disk failure here is logged rather than becoming an unhandled rejection.
    persist().catch((err: any) => log.error(`persist failed: ${err?.message ?? err}`));
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
