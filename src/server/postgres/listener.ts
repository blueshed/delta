/**
 * DocListener — one server, one LISTEN, many doc types.
 *
 * All dispatch is delegated to `./registry`. Register doc types before
 * opening WS connections (see server.ts).
 *
 * Auth is pluggable via `opts.auth`. When provided, every doc message passes
 * through `auth.gate(client)` and the resulting identity is threaded into
 * `type.open / apply / openAt` so backends can scope queries (e.g. with
 * `withAppAuth` + RLS). When auth is omitted, no gate runs and identity is
 * undefined — delta itself has no opinion on authentication.
 */
import type { WsServer } from "../server";
import { createLogger } from "../logger";
import type { Pool } from "pg";
import { resolveDoc } from "./registry";
import type { DocType } from "./registry";
import type { DeltaAuth } from "../auth";
import { isAuthError } from "../auth";
import type { DeltaOp } from "../../core";

const log = createLogger("[doc]");

// ---------------------------------------------------------------------------
// Custom doc — predicate-based membership view over watched collections.
// ---------------------------------------------------------------------------

export interface CustomDocDef<C = unknown> {
  /** Doc name prefix (e.g. "sites-in-bbox:"). */
  prefix: string;
  /** Collections the doc watches for row-level fan-out. */
  watch: string[];
  /** Parse the portion of docName after prefix into criteria. */
  parse: (docId: string) => C;
  /**
   * Initial load. Return the rows this doc should expose, keyed by collection.
   * Receives the Pool so callers can use `withAppAuth` when RLS is enabled.
   */
  query: (pool: Pool, criteria: C) => Promise<Record<string, any[]>>;
  /** True when `row` belongs in a doc opened under `criteria`. */
  matches: (collection: string, row: any, criteria: C) => boolean;
}

export function defineCustomDoc<C>(
  prefix: string,
  opts: Omit<CustomDocDef<C>, "prefix">,
): CustomDocDef<C> {
  return { prefix, ...opts };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// State — per-doc subscriber tracking
// ---------------------------------------------------------------------------

interface DocState {
  version: number;
  subscribers: Set<any>;
  notifying: boolean;
}

export async function createDocListener<I = unknown>(
  ws: WsServer,
  pool: Pool,
  opts?: { auth?: DeltaAuth<I>; custom?: CustomDocDef<any>[] },
) {
  const auth = opts?.auth;
  const tracked = new Map<string, DocState>();

  // Custom docs: prefix-keyed defs, per-docName cache + criteria + subscribers.
  const customByPrefix = new Map<string, CustomDocDef<any>>();
  for (const def of opts?.custom ?? []) customByPrefix.set(def.prefix, def);

  const watchedCollections = new Set<string>();
  for (const def of opts?.custom ?? []) for (const c of def.watch) watchedCollections.add(c);

  const customCache = new Map<string, Record<string, Record<string, any>>>();
  const customCriteria = new Map<string, unknown>();
  const customSubs = new Map<string, Set<any>>();

  function findCustom(docName: string): { def: CustomDocDef<any>; docId: string } | null {
    for (const [prefix, def] of customByPrefix) {
      if (docName.startsWith(prefix)) {
        return { def, docId: docName.slice(prefix.length) };
      }
    }
    return null;
  }

  function toMap(rows: any[]): Record<string, any> {
    const m: Record<string, any> = {};
    for (const r of rows) m[r.id] = r;
    return m;
  }

  // Single LISTEN connection with auto-reconnect
  let listener = await pool.connect();
  let destroyed = false;

  let errorHandler: ((err: Error) => void) | null = null;

  async function setupListener(client: any) {
    await client.query("LISTEN delta_changes");
    client.on("notification", onNotification);
    errorHandler = (err: Error) => {
      log.error(`listener error: ${err.message}`);
      if (!destroyed) reconnect();
    };
    client.on("error", errorHandler);
  }

  async function reconnect() {
    log.info("listener reconnecting...");
    try { listener.release(); } catch {}
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let attempt = 1; !destroyed; attempt++) {
      try {
        await delay(Math.min(attempt * 1000, 10000));
        listener = await pool.connect();
        await setupListener(listener);
        log.info("listener reconnected");
        return;
      } catch (err) {
        log.error(`reconnect attempt ${attempt} failed: ${errMsg(err)}`);
      }
    }
  }

  try {
    await setupListener(listener);
  } catch (err) {
    listener.release();
    throw err;
  }

  // Notification handler — fans out LISTEN/NOTIFY to WS subscribers, plus
  // custom-doc cross-pollination when any predicate-based doc is registered.
  async function onNotification(msg: any) {
    if (destroyed) return;
    if (msg.channel !== "delta_changes" || !msg.payload) return;
    try {
      const { doc: docName, v } = JSON.parse(msg.payload);
      let state = tracked.get(docName);

      // Even without direct subscribers, we still process notifications if any
      // custom doc is registered — a watched collection's rows may need fan-out.
      if (!state && customByPrefix.size === 0) return;
      if (!state) {
        // Initialize at v-1 so we fetch only the current notification's row.
        // Custom docs loaded their initial state via `def.query` on open, so
        // pre-existing ops are already reflected — replaying history would
        // duplicate them. Same logic protects close-then-reopen.
        state = { version: Math.max(0, v - 1), subscribers: new Set(), notifying: false };
        tracked.set(docName, state);
      }

      if (v <= state.version) return;
      if (state.notifying) return;

      state.notifying = true;
      try {
        const { rows } = await pool.query(
          "SELECT version, ops FROM delta_fetch_ops($1, $2)",
          [docName, state.version],
        );

        for (const row of rows) {
          if (state.subscribers.size > 0) {
            ws.publish(docName, { doc: docName, ops: row.ops });
          }
          state.version = row.version;
          customFanOut(row.ops as DeltaOp[]);
        }

        pruneDoc(docName);

        log.debug(`notify ${docName} v${state.version}`);
      } finally {
        state.notifying = false;
      }
    } catch (err) {
      log.error(`notify error: ${errMsg(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Custom-doc cross-pollination
  // ---------------------------------------------------------------------------

  function customFanOut(ops: DeltaOp[]) {
    if (customByPrefix.size === 0) return;

    for (const op of ops) {
      const parts = op.path.split("/").filter(Boolean);
      if (parts.length < 2) continue;
      const coll = parts[0]!;
      const id = parts[1]!;
      if (!watchedCollections.has(coll)) continue;

      const row = (op as any).value as any | undefined;

      for (const [prefix, def] of customByPrefix) {
        if (!def.watch.includes(coll)) continue;

        // Memoize membership per distinct criteria for this op.
        const decisionByCriteria = new Map<unknown, boolean>();

        for (const [docName, subs] of customSubs) {
          if (!docName.startsWith(prefix)) continue;
          if (subs.size === 0) continue;
          const criteria = customCriteria.get(docName);
          if (criteria === undefined) continue;
          const cached = customCache.get(docName);
          if (!cached) continue;

          let shouldBeIn = decisionByCriteria.get(criteria);
          if (shouldBeIn === undefined) {
            shouldBeIn = row == null ? false : def.matches(coll, row, criteria);
            decisionByCriteria.set(criteria, shouldBeIn);
          }

          const wasIn = cached[coll]?.[id] != null;
          const emitted: DeltaOp[] = [];

          if (!wasIn && shouldBeIn) {
            cached[coll] ??= {};
            cached[coll]![id] = row;
            emitted.push({ op: "add", path: `/${coll}/${id}`, value: row });
          } else if (wasIn && shouldBeIn) {
            cached[coll]![id] = row;
            emitted.push({ op: "replace", path: `/${coll}/${id}`, value: row });
          } else if (wasIn && !shouldBeIn) {
            delete cached[coll]![id];
            emitted.push({ op: "remove", path: `/${coll}/${id}` });
          }

          if (emitted.length) ws.publish(docName, { doc: docName, ops: emitted });
        }
      }
    }
  }

  function pruneDoc(docName: string) {
    const state = tracked.get(docName);
    if (!state) return;
    for (const sub of state.subscribers) {
      if (sub.readyState !== undefined && sub.readyState !== 1) {
        state.subscribers.delete(sub);
      }
    }
    if (state.subscribers.size === 0) tracked.delete(docName);
  }

  // ---------------------------------------------------------------------------
  // withDoc — authenticate (if configured), validate doc name, resolve handler,
  // wrap errors. Each WS branch supplies only its own body.
  // ---------------------------------------------------------------------------

  type DocCtx = {
    docName: string;
    type: DocType<any, I>;
    ctx: any;
    msg: any;
    client: any;
    respond: (r: any) => void;
    identity: I | undefined;
  };

  function withDoc(label: string, fn: (dc: DocCtx) => Promise<void> | void) {
    return async (msg: any, client: any, respond: (r: any) => void) => {
      let identity: I | undefined;
      if (auth) {
        const gated = auth.gate(client);
        if (isAuthError(gated)) {
          return respond({ error: { code: 401, message: gated.error } });
        }
        identity = gated as I;
      }
      const docName = msg.doc as string;
      if (!docName) {
        return respond({ error: { code: 400, message: "doc is required" } });
      }
      const found = resolveDoc(docName);
      if (!found) {
        return respond({ error: { code: 404, message: `No handler for ${docName}` } });
      }
      try {
        await fn({ docName, type: found.type, ctx: found.ctx, msg, client, respond, identity });
      } catch (err) {
        const m = errMsg(err);
        log.error(`${label} failed: ${m}`);
        respond({ error: { code: 500, message: m } });
      }
    };
  }

  // ---------------------------------------------------------------------------
  // WS branches — custom docs first (short-circuit before standard withDoc)
  // ---------------------------------------------------------------------------

  if (customByPrefix.size > 0) {
    ws.on("open", async (msg: any, client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      const match = findCustom(docName);
      if (!match) return;                                     // fall through to standard

      const { def, docId } = match;
      try {
        let doc = customCache.get(docName);
        if (!doc) {
          const criteria = def.parse(docId);
          const rowsByColl = await def.query(pool, criteria);
          doc = {};
          for (const coll of def.watch) doc[coll] = toMap(rowsByColl[coll] ?? []);
          customCache.set(docName, doc);
          customCriteria.set(docName, criteria);
        }

        if (!customSubs.has(docName)) customSubs.set(docName, new Set());
        customSubs.get(docName)!.add(client);
        client.subscribe(docName);

        respond({ result: doc });
        log.info(`opened ${docName} (custom)`);
      } catch (err) {
        log.error(`open custom ${docName} failed: ${errMsg(err)}`);
        respond({ error: { code: 500, message: errMsg(err) } });
      }
    });

    ws.on("delta", (msg: any, _client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      if (!findCustom(docName)) return;                       // fall through to standard
      respond({ error: { code: 403, message: "Custom docs are read-only; write through the source doc." } });
    });

    ws.on("close", (msg: any, client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      if (!findCustom(docName)) return;                       // fall through to standard

      client.unsubscribe(docName);
      const subs = customSubs.get(docName);
      if (subs) {
        subs.delete(client);
        if (subs.size === 0) {
          customSubs.delete(docName);
          customCache.delete(docName);
          customCriteria.delete(docName);
        }
      }
      respond({ result: { ack: true } });
      log.debug(`closed ${docName} (custom)`);
    });
  }

  ws.on("open", withDoc("open", async ({ docName, type, ctx, msg, client, respond, identity }) => {
    const result = await type.open(ctx, docName, msg, identity);
    if (!result) return respond({ error: { code: 404, message: "Not found" } });

    pruneDoc(docName);
    let state = tracked.get(docName);
    if (!state) {
      state = { version: result.version, subscribers: new Set(), notifying: false };
      tracked.set(docName, state);
    } else {
      state.version = Math.max(state.version, result.version);
    }

    state.subscribers.add(client);
    client.subscribe(docName);
    respond({ result: result.result });
    log.info(`opened ${docName} v${state.version}`);
  }));

  ws.on("delta", withDoc("delta", async ({ docName, type, ctx, msg, respond, identity }) => {
    const result = await type.apply(ctx, docName, msg.ops, identity);
    respond({ result: { ack: true, version: result.version } });
    log.info(`delta ${docName} v${result.version}`);
  }));

  ws.on("open_at", withDoc("open_at", async ({ docName, type, ctx, msg, respond, identity }) => {
    const at = msg.at as string;
    if (!at) return respond({ error: { code: 400, message: "at is required" } });
    if (!type.openAt) {
      return respond({ error: { code: 400, message: `open_at not supported for ${docName}` } });
    }
    const doc = await type.openAt(ctx, docName, at, identity);
    if (!doc) return respond({ error: { code: 404, message: "Not found" } });
    respond({ result: doc });
    log.info(`open_at ${docName} @ ${at}`);
  }));

  ws.on("close", withDoc("close", ({ docName, client, respond }) => {
    client.unsubscribe(docName);
    const state = tracked.get(docName);
    if (state) {
      state.subscribers.delete(client);
      if (state.subscribers.size === 0) tracked.delete(docName);
    }
    respond({ result: { ack: true } });
    log.debug(`closed ${docName}`);
  }));

  return {
    evict(docName: string) {
      tracked.delete(docName);
    },
    async destroy() {
      destroyed = true;
      try {
        await listener.query("UNLISTEN *");
      } catch {}
      // Released connections are recycled by the pool; stale listeners would
      // fire against this closure's state on future pooled connections.
      try { (listener as any).removeListener?.("notification", onNotification); } catch {}
      if (errorHandler) {
        try { (listener as any).removeListener?.("error", errorHandler); } catch {}
      }
      try { listener.release(); } catch {}
    },
  };
}
