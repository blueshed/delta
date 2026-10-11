/**
 * @blueshed/delta/testing -- what delta's own tests drive a server with, for
 * an app to test its own: a WS-shaped client, a message sent and its answer
 * awaited, a poll, and the pointer vectors (one JSON Pointer grammar, as data,
 * for any parser to run).
 *
 *   const ws = createWs();
 *   registerDocs(ws, db, schema, docs);
 *   const client = mockClient();
 *   await sendAndAwait(ws, client, { action: "open", doc: "items:" });
 */
import vectors from "./pointer-vectors.json";

/**
 * Each pointer, and the segments it splits into (RFC 6901), or null when it is
 * malformed. `splitPath` and `_delta_split_path` answer every one alike; the
 * same file is `src/pointer-vectors.json` in the package.
 */
export const pointerVectors: { pointer: string; segments: string[] | null }[] = vectors;

/** Wait for `fn` to return something truthy, and return it. Throws after `timeout` ms (2s). */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 2000, interval = 25 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timeout${last ? `: ${String(last)}` : ""}`);
}

/** A socket as `createWs()`'s handlers see it: what it was sent, parsed, and what it subscribes to. */
export interface MockClient {
  data: Record<string, unknown>;
  sent: any[];
  subscriptions: Set<string>;
  readyState: number;
  send(msg: string): void;
  subscribe(ch: string): void;
  unsubscribe(ch: string): void;
}

/** A WS-shaped test client; `data` is its `ws.data` (`{ identity }` signed in, `{ local: true }` an in-process caller). */
export function mockClient(data: Record<string, unknown> = {}): MockClient {
  return {
    data,
    sent: [],
    subscriptions: new Set<string>(),
    readyState: 1,
    send(msg: string) { this.sent.push(JSON.parse(msg)); },
    subscribe(ch: string) { this.subscriptions.add(ch); },
    unsubscribe(ch: string) { this.subscriptions.delete(ch); },
  };
}

/**
 * Drive one message through a WsServer's `websocket.message` and wait for the
 * answer with its `id` on `client.sent` (an id is given when `msg` has none).
 */
export async function sendAndAwait(
  ws: { websocket: { message: (ws: any, raw: any) => any } },
  client: MockClient,
  msg: any,
  { timeout = 3000 }: { timeout?: number } = {},
): Promise<any> {
  const id = msg.id ?? Math.floor(Math.random() * 1e9);
  const before = client.sent.length;
  await ws.websocket.message(client, JSON.stringify({ ...msg, id }));
  return waitFor(
    () => client.sent.slice(before).find((m: any) => m.id === id),
    { timeout },
  );
}
