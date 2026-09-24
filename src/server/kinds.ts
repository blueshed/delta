/**
 * Document kinds that are not stored in a database — Workshop/docs/eta-on-delta.md.
 *
 * A document is divided by where its truth lives. Written documents and facts
 * live in a database (the SQLite and Postgres backends). These three do not:
 *
 * - **memory** — live: the truth is this process (who is online). Held in
 *   memory, gone on restart, never on a ledger. Written by a caller in this
 *   process (the server that knows who is connected), not over the socket.
 * - **static** — the truth is the repository (SI units, countries). A value
 *   fixed for the release; a change is a deploy. Every write refused.
 * - **source** — the truth is outside (a thermometer, an API). One reading,
 *   shared by every watcher, taken when the first opens it and then polled
 *   (`every`) or pushed (`subscribe`) while anyone watches. A reading carries
 *   when it was taken (`at`), and the document says itself `stale` when no
 *   reading has come within `stale` ms — so a page can say so, instead of
 *   showing an old number as if it were now. Every write refused.
 *
 * Each registers on a `WsServer` for a prefix (`here:`, `units:`,
 * `reactor:`), and speaks the same `open` / `delta` / `close` as the other
 * backends; a change is published on the document's channel as
 * `{ doc, ops, v }`, the one stream of changes.
 */
import { applyOps, type DeltaOp } from "../core";
import { onClientDrop, trackSubscribe, trackUnsubscribe, type WsServer } from "./server";

type Respond = (response: any) => void;

/** The shared bookkeeping: who has a document open, and a version per document. */
function family(ws: WsServer, prefix: string) {
  const subscribers = new Map<string, Set<any>>();
  const owns = (msg: any): string | undefined => (typeof msg.doc === "string" && msg.doc.startsWith(prefix) ? msg.doc : undefined);
  const subscribe = (client: any, doc: string): boolean => {
    const first = !subscribers.has(doc);
    if (first) subscribers.set(doc, new Set());
    subscribers.get(doc)!.add(client);
    trackSubscribe(client, doc);
    return first;
  };
  /** Takes `client` off `doc`; true when it was the last. */
  const unsubscribe = (client: any, doc: string): boolean => {
    const subs = subscribers.get(doc);
    if (!subs?.delete(client)) return false;
    trackUnsubscribe(client, doc);
    if (subs.size > 0) return false;
    subscribers.delete(doc);
    return true;
  };
  return { subscribers, owns, subscribe, unsubscribe, id: (doc: string) => doc.slice(prefix.length) };
}

const refuse = (respond: Respond, why: string) => respond({ error: { code: 403, message: why } });

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------

export interface MemoryOptions<T> {
  /** The prefix the documents are named by, e.g. `here:`. */
  prefix: string;
  /** A document's value before anything has been written to it. */
  empty: (id: string) => T;
  /** Who may write: a caller in this process only (default), or anyone who has it open. */
  writable?: "local" | "any";
}

/** Live documents: held in memory, gone on restart, never on a ledger. */
export function registerMemory<T>(ws: WsServer, options: MemoryOptions<T>) {
  const docs = new Map<string, { value: T; v: number }>();
  const f = family(ws, options.prefix);
  const doc = (name: string) => {
    if (!docs.has(name)) docs.set(name, { value: options.empty(f.id(name)), v: 0 });
    return docs.get(name)!;
  };

  ws.on("open", (msg, client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    f.subscribe(client, name);
    onClientDrop(client, (c) => f.unsubscribe(c, name));
    const d = doc(name);
    respond({ result: { ...(d.value as object), _v: d.v } });
  });

  ws.on("delta", (msg, client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    if (options.writable !== "any" && !client?.data?.local) return refuse(respond, "a live document is written by the server, not over the socket");
    const d = doc(name);
    const next = structuredClone(d.value);
    try {
      applyOps(next, msg.ops as DeltaOp[]);
    } catch (err: any) {
      return respond({ error: { code: 400, message: err.message } });
    }
    d.value = next;
    d.v += 1;
    ws.publish(name, { doc: name, ops: msg.ops, v: d.v });
    respond({ result: { ack: true, version: d.v, ops: msg.ops } });
  });

  ws.on("close", (msg, client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    f.unsubscribe(client, name);
    respond({ result: { ack: true } });
  });

  return {
    /** The document as it is now, or undefined if nothing has made it. */
    peek: (name: string): T | undefined => docs.get(name)?.value,
    /** Forgets a document: it starts again from `empty`. */
    forget: (name: string) => void docs.delete(name),
  };
}

// ---------------------------------------------------------------------------
// static
// ---------------------------------------------------------------------------

export interface StaticOptions<T> {
  prefix: string;
  /** The document of this id, loaded when the process starts; undefined when there is none. */
  value: (id: string) => T | undefined;
}

/** Documents fixed for the release: read, never written; a change is a deploy. */
export function registerStatic<T>(ws: WsServer, options: StaticOptions<T>) {
  const f = family(ws, options.prefix);
  const values = new Map<string, T | undefined>();
  const valueOf = (name: string): T | undefined => {
    if (!values.has(name)) values.set(name, options.value(f.id(name)));
    return values.get(name);
  };

  ws.on("open", (msg, _client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    const value = valueOf(name);
    if (value === undefined) return respond({ error: { code: 404, message: "Not found" } });
    respond({ result: { ...(value as object), _v: 1 } });
  });
  ws.on("delta", (msg, _client, respond) => {
    if (f.owns(msg)) refuse(respond, "a static document changes with a release, not a write");
  });
  ws.on("close", (msg, _client, respond) => {
    if (f.owns(msg)) respond({ result: { ack: true } });
  });
}

// ---------------------------------------------------------------------------
// source
// ---------------------------------------------------------------------------

/** A sourced document: the latest reading, when it was taken, and whether it is too old to trust. */
export type Sourced<T> = { reading: T | null; at: number | null; stale: boolean };

export interface SourceOptions<T> {
  prefix: string;
  /** Asks the source for a reading. */
  read: (id: string) => T | Promise<T>;
  /** Poll the source this often (ms) while anyone watches. */
  every?: number;
  /** Or let the source push: called when the first watcher opens, returns how to stop. */
  subscribe?: (id: string, push: (reading: T) => void) => () => void;
  /** A reading older than this (ms) is stale: the document says so. */
  stale?: number;
  /** The clock (for tests). */
  now?: () => number;
}

/** Documents whose truth is outside: one shared reading, taken while anyone watches, stamped with its time. */
export function registerSource<T>(ws: WsServer, options: SourceOptions<T>) {
  const f = family(ws, options.prefix);
  const now = options.now ?? Date.now;
  type Watched = { value: Sourced<T>; v: number; stop: (() => void)[] };
  const watched = new Map<string, Watched>();
  const starting = new Map<string, Promise<Watched>>(); // two watchers opening at once share one start

  const publish = (name: string, w: Watched, ops: DeltaOp[]) => {
    applyOps(w.value, ops);
    w.v += 1;
    ws.publish(name, { doc: name, ops, v: w.v });
  };

  const take = (name: string, w: Watched, reading: T) => {
    const ops: DeltaOp[] = [];
    if (JSON.stringify(reading) !== JSON.stringify(w.value.reading)) ops.push({ op: "replace", path: "/reading", value: reading });
    ops.push({ op: "replace", path: "/at", value: now() });
    if (w.value.stale) ops.push({ op: "replace", path: "/stale", value: false });
    publish(name, w, ops);
  };

  const ask = async (name: string, w: Watched) => {
    try {
      take(name, w, await options.read(f.id(name)));
    } catch {
      // a source that does not answer gives no reading: the last one ages, and goes stale
    }
  };

  async function start(name: string): Promise<Watched> {
    const w: Watched = { value: { reading: null, at: null, stale: false }, v: 0, stop: [] };
    try {
      const reading = await options.read(f.id(name));
      w.value = { reading, at: now(), stale: false };
    } catch {
      w.value = { reading: null, at: null, stale: true };
    }
    watched.set(name, w); // watched once it has its first reading: an opener meanwhile waits on `starting`
    if (options.every) {
      const timer = setInterval(() => void ask(name, w), options.every);
      w.stop.push(() => clearInterval(timer));
    }
    if (options.subscribe) w.stop.push(options.subscribe(f.id(name), (reading) => take(name, w, reading)));
    if (options.stale) {
      const limit = options.stale;
      const timer = setInterval(() => {
        const age = w.value.at === null ? Infinity : now() - w.value.at;
        if (age > limit && !w.value.stale) publish(name, w, [{ op: "replace", path: "/stale", value: true }]);
      }, Math.max(10, Math.floor(limit / 4)));
      w.stop.push(() => clearInterval(timer));
    }
    return w;
  }

  const stop = (name: string) => {
    const w = watched.get(name);
    if (!w) return;
    for (const s of w.stop) s();
    watched.delete(name);
  };

  ws.on("open", async (msg, client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    f.subscribe(client, name);
    onClientDrop(client, (c) => {
      if (f.unsubscribe(c, name)) stop(name);
    });
    let w = watched.get(name);
    if (!w) {
      if (!starting.has(name)) starting.set(name, start(name).finally(() => starting.delete(name)));
      w = await starting.get(name)!;
    }
    respond({ result: { ...w.value, _v: w.v } });
  });
  ws.on("delta", (msg, _client, respond) => {
    if (f.owns(msg)) refuse(respond, "a sourced document's truth is outside: it is read, never written");
  });
  ws.on("close", (msg, client, respond) => {
    const name = f.owns(msg);
    if (!name) return;
    if (f.unsubscribe(client, name)) stop(name);
    respond({ result: { ack: true } });
  });

  return {
    /** Stops every watched source (for shutdown and tests). */
    stopAll: () => [...watched.keys()].forEach(stop),
  };
}
