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
 * Calls are synchronous: the SQLite backend's handlers are, and a caller
 * inside its own transaction needs them to be. A handler that answers only
 * after an `await` (the Postgres backend) throws here rather than returning
 * nothing.
 */
import type { ActionHandler, WsServer } from "./server";

export type LocalAnswer = { result?: any; error?: { code: number; message: string } };

type LocalClient = { data: Record<string, unknown>; subscribe(channel: string): void; unsubscribe(channel: string): void };

export interface Caller {
  /** The client its calls come from: subscriptions are recorded on it, as on a socket. */
  client: LocalClient;
  /** Runs `action` with `msg` through the registered handlers and returns the first answer. */
  call(action: string, msg: Record<string, unknown>): LocalAnswer;
}

export interface Local extends Caller {
  /** Hand this to a backend's register function in place of `createWs()`. */
  server: WsServer;
  /** A caller that is `identity`: one client per identity, reused. With no identity, calls are anonymous. */
  as(identity: unknown): Caller;
  /** Hears every broadcast the backend makes, on every channel. Returns the unsubscribe. */
  onPublish(fn: (channel: string, data: any) => void): () => void;
}

export function createLocal(): Local {
  const actions = new Map<string, ActionHandler[]>();
  const listeners = new Set<(channel: string, data: any) => void>();
  const clientFor = (identity?: unknown): LocalClient => ({
    data: identity === undefined ? { local: true } : { local: true, identity },
    subscribe() {},
    unsubscribe() {},
  });
  const client = clientFor();
  const callers = new Map<string, Caller>();

  const server: WsServer = {
    path: "",
    on(action, handler) {
      actions.set(action, [...(actions.get(action) ?? []), handler]);
    },
    publish(channel, data) {
      for (const fn of listeners) fn(channel, data);
    },
    sendTo() {},
    setServer() {},
    upgrade: () => undefined,
    websocket: { idleTimeout: 0, sendPings: false, publishToSelf: true, open() {}, message() {}, close() {} },
  };

  function callAs(from: LocalClient, action: string, msg: Record<string, unknown>): LocalAnswer {
    let answer: LocalAnswer | undefined;
    for (const handler of actions.get(action) ?? []) {
      const pending = handler({ action, ...msg }, from, (response) => (answer ??= response));
      if (answer) return answer;
      if (pending instanceof Promise) throw new Error(`delta local: the ${action} handler is asynchronous; createLocal() calls are synchronous`);
    }
    return { error: { code: -1, message: `No handler matched: ${action}` } };
  }

  function onPublish(fn: (channel: string, data: any) => void) {
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
