/**
 * Delta Server — WebSocket protocol layer + document/method registration for Bun.
 *
 * Provides the server half of the delta-doc system:
 *   - createWs()       — shared WebSocket infrastructure (action routing, pub/sub, upgrade)
 *   - registerDoc()    — persist a typed JSON document, sync via delta ops
 *   - registerMethod() — expose a stateless RPC handler
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
import { applyOps, type DeltaOp } from "./core";

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
        const clientId = ws.data?.clientId;
        if (clientId) clients.set(clientId, ws);
        for (const ch of ws.data?.channels ?? []) ws.subscribe(ch);
        log.debug(`open id=${clientId ?? "?"}`);
      },
      async message(ws: any, raw: any) {
        const msg = JSON.parse(String(raw));
        const { id, action } = msg;

        if (!action) {
          for (const handler of actions.get("_raw") ?? []) {
            await handler(msg, ws, () => {});
          }
          return;
        }

        try {
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
        if (clientId) clients.delete(clientId);
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

  async function persist() {
    await Bun.write(dataFile, JSON.stringify(doc, null, 2));
  }

  function applyAndBroadcast(ops: DeltaOp[]) {
    applyOps(doc, ops);
    log.info(`delta [${ops.map((o) => `${o.op} ${o.path}`).join(", ")}]`);
    ws.publish(name, { doc: name, ops });
    persist();
  }

  ws.on("open", (msg, client, respond) => {
    if (msg.doc !== name) return;
    client.subscribe(name);
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
    client.unsubscribe(name);
    respond({ result: { ack: true } });
    log.debug("closed");
  });

  return { getDoc: () => doc, setDoc: (d: T) => { doc = d; }, persist, applyAndBroadcast };
}

// ---------------------------------------------------------------------------
// Method registration
// ---------------------------------------------------------------------------

/** Register a stateless RPC method with the WebSocket server. */
export function registerMethod(
  ws: Pick<WsServer, "on">,
  name: string,
  handler: (params: any, client: any) => any | Promise<any>,
) {
  ws.on("call", async (msg, client, respond) => {
    if (msg.method !== name) return;
    const log = createLogger(`[${name}]`);
    log.debug("called");
    respond({ result: await handler(msg.params, client) });
  });
}
