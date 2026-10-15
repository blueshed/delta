/**
 * What a test of a delta server drives it with: a socket stand-in, a message
 * sent and its answer awaited, and a wait for something to be so. Exported
 * from `@blueshed/delta/testing`.
 */

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
