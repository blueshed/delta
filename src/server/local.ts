/**
 * Delta without a socket: a `WsServer` whose only client is the caller, in
 * the same process.
 *
 * A backend registers its handlers on it exactly as on `createWs()`; the
 * caller then speaks the same actions (`open`, `delta`, `close`, `call`)
 * as plain function calls, and hears what the backend would have broadcast
 * through `onPublish`. For a server that renders documents itself (HTML on
 * the server, a CLI, a job) and for tests.
 *
 *   const local = createLocal();
 *   const { evict } = registerDocs(local.server, db, schema, docs, [], { ledger: true });
 *   const doc = local.call("open", { doc: "room:general" }).result;
 *   const ada = local.as({ id: 7 });            // who is writing: the auth module's identity
 *   ada.call("delta", { doc: "room:general", ops, cursor: session });
 *   ada.call("undo", { cursor: session });      // walks back what that cursor wrote
 *
 * Identity crosses per call, not per connection: `as(identity)` gives a caller
 * whose client carries it as `client.data.identity`, where an auth module's
 * `gate` and the ledger's `who` read it. A caller here is trusted to name the
 * cursor undo walks; one on the socket is not (its cursor is its connection).
 *
 * Calls are asynchronous, so any backend answers through them: the SQLite
 * backend's handlers answer at once, the Postgres backend's after the
 * database does.
 *
 * Every answer and every broadcast is the caller's own copy, as it is over a
 * socket, which sends each as JSON: a write never changes what an open
 * handed out, and a caller that changes it changes nothing anyone is served.
 */
import { createLogger } from "./logger";
import type { ActionHandler, WsServer } from "./server";

export type LocalAnswer = { result?: any; error?: { code: number; message: string } };

type LocalClient = { data: Record<string, unknown>; subscribe(channel: string): void; unsubscribe(channel: string): void; send(raw: string): void };

export interface Caller {
  /** The client its calls come from: subscriptions are recorded on it, as on a socket. */
  client: LocalClient;
  /** Runs `action` with `msg` through the registered handlers and resolves with the first answer -- at once from a handler that answers at once (SQLite), when it answers from one that awaits (Postgres). */
  call(action: string, msg: Record<string, unknown>): Promise<LocalAnswer>;
}

export interface Local extends Caller {
  /** Hand this to a backend's register function in place of `createWs()`. */
  server: WsServer;
  /** A caller that is `identity`: one client per identity, reused. With no identity, calls are anonymous. */
  as(identity: unknown): Caller;
  /**
   * Hears every broadcast the backend makes, on every channel, as its own copy
   * -- and each message it sends to one caller alone, on its document's
   * channel, with `to`: who it went to (`{ identity }`, undefined for the
   * anonymous caller) -- a membership or recompute document's view, which is
   * that identity's own. A broadcast has no `to`. One that throws is logged,
   * and the rest are told. Returns the unsubscribe.
   */
  onPublish(fn: (channel: string, data: any, to?: { identity: unknown }) => void): () => void;
}

/**
 * A value as the caller's own. A backend answers with, and broadcasts, objects
 * it keeps -- SQLite's cached documents, the JSON file's document, the Postgres
 * listener's custom documents -- and changes them in place when it writes. A
 * socket sends a copy (JSON); here nothing is sent, so the copy is taken, when
 * the backend answers.
 *
 * Documents are plain data, so plain objects and arrays are copied member by
 * member: several times quicker than `structuredClone`, and quicker than the
 * JSON a socket spends on the same answer. Anything else (a Date, a blob) is
 * cloned, and so is a value the member-by-member copy cannot take (a cycle);
 * only what no clone takes (a method's answer holding a function) is handed
 * over as it is.
 */
function own<T>(value: T): T {
  try {
    return copyData(value);
  } catch {
    try {
      return structuredClone(value);   // a cycle: structuredClone keeps it
    } catch {
      return value;                    // what nothing clones
    }
  }
}

function copyData(v: any): any {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = copyData(v[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return structuredClone(v);
  const out: any = {};
  for (const k of Object.keys(v)) {
    // an own "__proto__" (JSON.parse makes one) stays a key, not the copy's prototype
    if (k === "__proto__") Object.defineProperty(out, k, { value: copyData(v[k]), enumerable: true, writable: true, configurable: true });
    else out[k] = copyData(v[k]);
  }
  return out;
}

export function createLocal(): Local {
  const log = createLogger("[local]");
  const actions = new Map<string, ActionHandler[]>();
  const listeners = new Set<(channel: string, data: any, to?: { identity: unknown }) => void>();
  // Each listener its own copy, and its own mistake: a backend publishes (or
  // sends) after its write has committed, so one listener that throws must not
  // stop the others hearing it, nor the backend telling the documents after this one.
  function deliver(channel: string, data: any, to?: { identity: unknown }): void {
    for (const fn of listeners) {
      try {
        if (to) fn(channel, own(data), to);
        else fn(channel, own(data));
      } catch (err: any) {
        log.error(`fan-out failed (write committed): a listener on ${channel} threw: ${err?.message ?? String(err)}`);
      }
    }
  }
  const clientFor = (identity?: unknown): LocalClient => ({
    data: identity === undefined ? { local: true } : { local: true, identity },
    subscribe() {},
    unsubscribe() {},
    // what a socket would be sent alone: heard as the backend's other changes are, with who it went to
    send(raw) {
      const data = JSON.parse(raw);
      deliver(data.doc, data, { identity });
    },
  });
  const client = clientFor();
  const callers = new Map<string, Caller>();

  const server: WsServer = {
    path: "",
    on(action, handler) {
      actions.set(action, [...(actions.get(action) ?? []), handler]);
    },
    publish(channel, data) {
      deliver(channel, data);
    },
    sendTo() {},
    setServer() {},
    upgrade: () => undefined,
    websocket: { idleTimeout: 0, sendPings: false, publishToSelf: true, open() {}, message() {}, close() {} },
  };

  async function callAs(from: LocalClient, action: string, msg: Record<string, unknown>): Promise<LocalAnswer> {
    let answer: LocalAnswer | undefined;
    for (const handler of actions.get(action) ?? []) {
      await handler({ action, ...msg }, from, (response) => (answer ??= own(response)));
      if (answer) return answer;
    }
    return { error: { code: 404, message: `No handler matched: ${action}` } };
  }

  function onPublish(fn: (channel: string, data: any, to?: { identity: unknown }) => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }

  function as(identity: unknown): Caller {
    const key = JSON.stringify(identity) ?? "undefined";
    let caller = callers.get(key);
    if (!caller) {
      const from = clientFor(identity);
      caller = { client: from, call: (action, msg) => callAs(from, action, msg) };
      callers.set(key, caller);
    }
    return caller;
  }

  return { server, client, call: (action, msg) => callAs(client, action, msg), as, onPublish };
}
