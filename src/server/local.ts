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
 *   const { evict } = registerDocs(local.server, db, schema, docs);
 *   const doc = local.call("open", { doc: "room:general" }).result;
 *   local.call("delta", { doc: "room:general", ops, inverse: true });
 *
 * Calls are synchronous: the SQLite backend's handlers are, and a caller
 * inside its own transaction needs them to be. A handler that answers only
 * after an `await` (the Postgres backend) throws here rather than returning
 * nothing.
 */
import type { ActionHandler, WsServer } from "./server";

export type LocalAnswer = { result?: any; error?: { code: number; message: string } };

export interface Local {
  /** Hand this to a backend's register function in place of `createWs()`. */
  server: WsServer;
  /** The one client every call comes from: subscriptions are recorded on it, as on a socket. */
  client: { data: Record<string, unknown>; subscribe(channel: string): void; unsubscribe(channel: string): void };
  /** Runs `action` with `msg` through the registered handlers and returns the first answer. */
  call(action: string, msg: Record<string, unknown>): LocalAnswer;
  /** Hears every broadcast the backend makes, on every channel. Returns the unsubscribe. */
  onPublish(fn: (channel: string, data: any) => void): () => void;
}

export function createLocal(): Local {
  const actions = new Map<string, ActionHandler[]>();
  const listeners = new Set<(channel: string, data: any) => void>();
  const client = { data: {} as Record<string, unknown>, subscribe() {}, unsubscribe() {} };

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

  function call(action: string, msg: Record<string, unknown>): LocalAnswer {
    let answer: LocalAnswer | undefined;
    for (const handler of actions.get(action) ?? []) {
      const pending = handler({ action, ...msg }, client, (response) => (answer ??= response));
      if (answer) return answer;
      if (pending instanceof Promise) throw new Error(`delta local: the ${action} handler is asynchronous; createLocal() calls are synchronous`);
    }
    return { error: { code: -1, message: `No handler matched: ${action}` } };
  }

  function onPublish(fn: (channel: string, data: any) => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  }

  return { server, client, call, onPublish };
}
