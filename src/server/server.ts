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
 *   import { createWs, registerDoc, registerMethod } from "@blueshed/delta/server";
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
import { applyOps, splitPath, joinPath, type DeltaOp } from "../core";

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
  /** The origins a browser may open the socket from besides the server's own, or "*" for any (`createWs({ origins })`). */
  origins?: readonly string[] | "*";
  /**
   * Say that a `call` of `method` changes who the socket is (`wireAuth` says
   * it of every auth action: `authenticate`, `login`, `logout`...). One starts
   * once what the socket sent before it has finished, under the identity it
   * was sent under; what the socket sends after it waits for it, then runs in
   * the order it came, under the identity it left. Every other message runs
   * as it arrives, beside the rest. Optional: `createLocal()` has no socket.
   */
  changesIdentity?(method: string): void;
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
  /**
   * The origins a browser may open the socket from, besides the server's own
   * (`["https://admin.example.com"]`), or `"*"` for any. A browser upgrade
   * from any other origin is refused with 403; a request with no `Origin`
   * (not a browser) is let in.
   */
  origins?: readonly string[] | "*";
  /**
   * How many messages one socket may send while a call that changes who it is
   * is in flight (`WsServer.changesIdentity`): they wait for it. One more
   * closes the socket with 1008 (policy violation), and none of them runs.
   * Default 1000.
   */
  maxHeld?: number;
  /**
   * How many bytes of messages (their size on the wire) one socket may have
   * waiting so, beside `maxHeld`: a message that would take it past this
   * closes the socket with 1008, and none of them runs. So a frame bigger
   * than this, sent before a sign-in has answered, closes its socket: wait
   * for the answer (`onConnect` does). Default 1 MiB.
   */
  maxHeldBytes?: number;
}

/**
 * The Origin check a WebSocket upgrade needs: a socket is not bound by the
 * same-origin policy, so without it any page a signed-in person visits could
 * open one as them, cookies and all. A 403 for a browser (it sends `Origin`)
 * on another origin than the Host it asked, unless `origins` lets it in;
 * undefined to go on. A request with no `Origin` is not a browser's, and goes on.
 * `createWs` and `upgradeWithAuth` ask it before anything else.
 */
export function refuseOrigin(req: Request, origins?: readonly string[] | "*"): Response | undefined {
  const origin = req.headers.get("origin");
  if (origin === null || origins === "*") return undefined;
  let from: URL | undefined;
  try { from = new URL(origin); } catch { /* "null" (a sandboxed frame, a file) or junk: not an origin we know */ }
  if (from) {
    const host = (req.headers.get("host") ?? new URL(req.url).host).toLowerCase();
    if (from.host.toLowerCase() === host) return undefined;   // its own: the scheme is whatever a proxy in front terminates
    if (origins?.includes(from.origin)) return undefined;
  }
  return new Response("Origin not allowed", { status: 403 });
}

/** `origins` as `URL.origin` spells them, so the check compares like with like; a list entry that is not a URL throws. */
function allowedOrigins(origins: WsOptions["origins"]): readonly string[] | "*" | undefined {
  if (origins === undefined || origins === "*") return origins;
  return origins.map((o) => {
    let url: URL;
    try { url = new URL(o); } catch { throw new Error(`createWs: origins: ${JSON.stringify(o)} is not an origin (scheme://host[:port], e.g. "https://app.example.com")`); }
    return url.origin;
  });
}

/** Create a shared WebSocket server with action routing and Bun pub/sub. */
export function createWs(opts?: WsOptions): WsServer {
  const log = createLogger("[ws]");
  const actions = new Map<string, ActionHandler[]>();
  const clients = new Map<string, any>();
  let serverRef: any;

  const path = opts?.path ?? "/ws";
  const origins = allowedOrigins(opts?.origins);
  const maxHeld = opts?.maxHeld ?? 1000;
  const maxHeldBytes = opts?.maxHeldBytes ?? 1024 * 1024;

  // A socket's messages run side by side, as they arrive: Bun does not wait
  // for an async handler. Only a call that changes who the socket is stands
  // between them: it starts once what the socket sent before it has finished,
  // and what the socket sends after it waits until it settles. So an `open`
  // sent straight behind `authenticate` is handled signed in, one sent before
  // `logout` is handled (and subscribed, and let go) before the logout, and a
  // slow method holds nothing up. A socket's `line` is what of it is running,
  // and, while such a call is waiting or in flight, what came after it
  // (`held`, and its size in `bytes`); `gone` has the sockets that have
  // closed. With no such call registered (no `wireAuth`), nothing is kept:
  // each message just runs.
  type Held = { raw: any; size: number; done: () => void };
  type Line = { running: Set<Promise<void>>; held: Held[] | null; bytes: number };
  const identityCalls = new Set<string>();
  const lines = new WeakMap<object, Line>();
  const gone = new WeakSet<object>();

  function lineOf(ws: any): Line {
    let line = lines.get(ws);
    if (!line) lines.set(ws, (line = { running: new Set(), held: null, bytes: 0 }));
    return line;
  }

  /** A frame's size on the wire, as Bun's `maxPayloadLength` counts it. */
  const sizeOf = (raw: any): number =>
    typeof raw === "string" ? Buffer.byteLength(raw) : (raw?.byteLength ?? 0);

  /** Run one message on its socket's line: it is running until it settles. */
  function start(ws: any, raw: any, line: Line): Promise<void> {
    const running = receive(ws, raw, line);
    line.running.add(running);
    void running.then(() => line.running.delete(running));
    return running;
  }

  function upgrade(req: Request, server: any) {
    const refused = refuseOrigin(req, origins);
    if (refused) return refused;
    const clientId = new URL(req.url).searchParams.get("clientId") ?? crypto.randomUUID();
    if (server.upgrade(req, { data: { clientId } })) return undefined;
    return new Response("WebSocket upgrade failed", { status: 400 });
  }

  /** One message, answered on its `id`; never rejects. */
  async function receive(ws: any, raw: any, line?: Line): Promise<void> {
    // Parse INSIDE the try: this is an async handler, so a non-JSON frame
    // used to reject with nothing to catch it — an unhandled rejection any
    // client could trigger at will, and a remote kill for any process that
    // installs a strict `unhandledRejection` handler. There is no `id` to
    // answer on when the parse itself fails, so that case only logs.
    let msg: any;
    let id: any;
    let action: any;
    let holds = false;
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
              error: { code: 403, message: `Private method: ${msg.method}` },
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
              error: { code: 400, message: `Unknown action: ${action}` },
            }),
          );
        return;
      }
      // A call that changes who the socket is: what comes after it waits
      // (set before the first await, so the socket's next message sees it),
      // and it waits for what came before it -- still running under the
      // identity it was sent under -- to finish.
      if (line && action === "call" && identityCalls.has(msg.method)) {
        line.held = [];
        holds = true;
        if (line.running.size) await Promise.all(line.running);
        if (gone.has(ws)) return;   // closed meanwhile: no one to change
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
            // No backend owns this name (or method): not there, as on Postgres.
            error: { code: 404, message: `No handler matched: ${action}` },
          }),
        );
      }
    } catch (err: any) {
      log.error(`error: ${err.message}`);
      // An error that carries its wire code (applyOps: 400 / 404) is
      // answered with it; anything else is the server's own (500).
      if (id)
        ws.send(
          JSON.stringify({ id, error: { code: typeof err?.code === "number" ? err.code : 500, message: err.message } }),
        );
    } finally {
      if (holds) release(ws, line!);
      // The socket closed while this ran: what it registered for the socket
      // meanwhile (a subscriber, a watch) is let go now, as the close would have.
      if (gone.has(ws)) runClientDropHooks(ws);
    }
  }

  /** A call that changes who `ws` is has settled: what waited on it runs, in the order it came. */
  function release(ws: any, line: Line): void {
    const held = line.held;
    line.held = null;
    if (!held) return;
    for (let i = 0; i < held.length; i++) {
      if (gone.has(ws)) {
        for (let j = i; j < held.length; j++) held[j]!.done();
        return;
      }
      const { raw, size, done } = held[i]!;
      line.bytes -= size;   // no longer waiting
      void start(ws, raw, line).then(done);
      // Another call that changes who it is: the rest wait on that one.
      const again = line.held as Held[] | null;   // start() may have set it
      if (again) {
        for (let j = i + 1; j < held.length; j++) again.push(held[j]!);   // still counted in `bytes`
        return;
      }
    }
  }

  /** Past `maxHeld` or `maxHeldBytes`: the socket is closed, and none of what it held runs. */
  function refuseHeld(ws: any, line: Line, over: string): void {
    gone.add(ws);
    for (const { done } of line.held!.splice(0)) done();
    const why = `more than ${over} held behind a call that changes identity`;
    log.warn(`close id=${ws.data?.clientId ?? "?"}: ${why}`);
    try {
      ws.close(1008, why);
    } catch { /* already closing */ }
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
    origins,

    changesIdentity(method: string) {
      identityCalls.add(method);
    },

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
      message(ws: any, raw: any) {
        if (gone.has(ws)) return;   // closed, or closing for holding too many: nothing more of it runs
        if (!identityCalls.size) return receive(ws, raw);   // nothing changes who a socket is: nothing waits
        const line = lineOf(ws);
        const held = line.held;
        if (!held) return start(ws, raw, line);
        if (held.length >= maxHeld) return refuseHeld(ws, line, `${maxHeld} messages`);
        const size = sizeOf(raw);
        if (line.bytes + size > maxHeldBytes) return refuseHeld(ws, line, `${maxHeldBytes} bytes`);
        line.bytes += size;
        return new Promise<void>((done) => held.push({ raw, size, done }));
      },
      close(ws: any) {
        gone.add(ws);
        // What waited on a call that changes who it is never runs: the socket it came from is gone.
        const held = lines.get(ws)?.held;
        if (held) for (const { done } of held.splice(0)) done();
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
    const rowPath = joinPath(segs[0]!, segs[1]!);
    if (rewritten.has(rowPath)) continue;
    const row = (doc as any)?.[segs[0]!]?.[segs[1]!];
    if (row === undefined) continue;
    rewritten.add(rowPath);
    out.push({ op: "replace", path: rowPath, value: row });
  }
  return out;
}

/**
 * `add .../-` onto a map of rows (an object, not an array) is "a new row, the
 * server names it": mint a uuid, put it in the path and in the value's `id`,
 * so the op as applied -- and as broadcast -- names the row, as the SQL
 * backends' echoes do. On an array, `/-` appends, as RFC 6902 says.
 * Shared by the JSON file (`registerDoc`) and memory documents (`kinds.ts`).
 * @internal
 */
export function mintIds(doc: unknown, ops: DeltaOp[]): DeltaOp[] {
  return ops.map((op) => {
    if (op.op !== "add" || !op.path.endsWith("/-")) return op;
    const segs = splitPath(op.path);
    let parent: any = doc;
    for (const seg of segs.slice(0, -1)) parent = parent?.[seg];
    if (parent === null || typeof parent !== "object" || Array.isArray(parent)) return op;
    const id = crypto.randomUUID();
    const v = op.value;
    const value = v !== null && typeof v === "object" && !Array.isArray(v) ? { ...v, id } : v;
    return { op: "add", path: joinPath(...segs.slice(0, -1), id), value };
  });
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

  function applyAndBroadcast(sent: DeltaOp[]) {
    const ops = mintIds(doc, sent);
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
