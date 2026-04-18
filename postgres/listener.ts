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

const log = createLogger("[doc]");

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
  opts?: { auth?: DeltaAuth<I> },
) {
  const auth = opts?.auth;
  const tracked = new Map<string, DocState>();

  // Single LISTEN connection with auto-reconnect
  let listener = await pool.connect();
  let destroyed = false;

  async function setupListener(client: any) {
    await client.query("LISTEN delta_changes");
    client.on("notification", onNotification);
    client.on("error", (err: Error) => {
      log.error(`listener error: ${err.message}`);
      if (!destroyed) reconnect();
    });
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

  // Notification handler — fans out LISTEN/NOTIFY to WS subscribers
  async function onNotification(msg: any) {
    if (msg.channel !== "delta_changes" || !msg.payload) return;
    try {
      const { doc: docName, v } = JSON.parse(msg.payload);
      const state = tracked.get(docName);
      if (!state) return;
      if (v <= state.version) return;
      if (state.notifying) return;

      state.notifying = true;
      try {
        const { rows } = await pool.query(
          "SELECT version, ops FROM delta_fetch_ops($1, $2)",
          [docName, state.version],
        );

        for (const row of rows) {
          ws.publish(docName, { doc: docName, ops: row.ops });
          state.version = row.version;
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
  // WS branches
  // ---------------------------------------------------------------------------

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
        listener.release();
      } catch {}
    },
  };
}
