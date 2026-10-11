/**
 * DocListener — one server, one LISTEN, many doc types.
 *
 * A listener answers for the doc types it is given (`types`, and `register`
 * later); two servers in one process each have their own.
 *
 * Auth is pluggable via `opts.auth`. When provided, every doc message passes
 * through `auth.gate(client)` and the resulting identity is threaded into
 * `type.open / apply / openAt` so backends can scope queries (e.g. with
 * `withAppAuth` + RLS), and a type's `owns(identity, docName)` decides whether
 * that identity may have the document at all (404 when not). When auth is
 * omitted, no gate runs and identity is undefined — delta itself has no
 * opinion on authentication.
 */
import type { WsServer } from "../server";
import { trackSubscribe, trackUnsubscribe, onClientDrop } from "../server";
import { createLogger } from "../logger";
import type { Pool, PoolClient } from "pg";
import { callAs, docTypes, showAnswer } from "./registry";
import type { DocType } from "./registry";
import type { DeltaAuth } from "../auth";
import { isAuthError } from "../auth";
import type { DeltaOp } from "../../core";
import { isEntryId, ledgerWho, socketCursor } from "../ledger";
import { assertOwned, createCustomDocs, NOT_FOUND, sendTo, type CustomDoc, type Owns, type Refusal } from "../custom";

const log = createLogger("[doc]");

// ---------------------------------------------------------------------------
// Custom doc — predicate-based membership view over watched collections.
// ---------------------------------------------------------------------------

/**
 * A custom doc on Postgres (`../custom`): its reads take the pool and answer
 * with a promise. A membership `query` runs once per doc name and identity
 * (the gated identity, undefined without auth), and its result is cached and
 * shared by the subscribers of that name who are that identity -- never by
 * another: bind the identity yourself (`withAppAuth(pool, id, …)`) so RLS
 * scopes what it reads, as recompute does. A `recompute` reads the WHOLE doc,
 * on open and on any write to a watched collection, and republishes it to each
 * subscriber as a root-replace op -- for nested/joined reads a per-row
 * `matches` can't express: re-evaluated PER SUBSCRIBER under that client's
 * identity, so RLS applies, hence it binds `app.user_id` itself.
 */
export interface CustomDocDef<C = unknown, I = any> extends CustomDoc<C, I, Pool> {
  query?: (pool: Pool, criteria: C, identity?: I) => Promise<Record<string, any[]>>;
  recompute?: (pool: Pool, criteria: C, identity?: I) => Promise<any>;
}

export function defineCustomDoc<C, I = any>(
  prefix: string,
  opts: Omit<CustomDocDef<C, I>, "prefix">,
): CustomDocDef<C, I> {
  return { prefix, ...opts };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The wire code for an error the database raised -- the same table as the
 * other backends. The framework raises SQLSTATE 22023 for a malformed path or
 * op, 22P02 for a row id it could not mint and 23502 for an add that leaves
 * out a required field (a client's mistake, 400); P0002 for a row that is not
 * there (404); 23505 for an add of a row that is, and 40001 for an undo of an
 * entry that is not the cursor's next (409). And 40P01, a write that met another
 * at once and gave way to it (two adds of temporal ids in opposite orders wait
 * on each other's row locks, todo #16): nothing was written, and the same write
 * sent again goes through, or meets the rows the other made (409). Anything
 * else is the server's (500).
 */
const CODE_OF_SQLSTATE: Record<string, number> = { "22023": 400, "22P02": 400, "23502": 400, "25006": 403, P0002: 404, "23505": 409, "40001": 409, "40P01": 409 };
function wireCode(err: unknown): number {
  const state = (err as { code?: unknown } | null)?.code;
  return (typeof state === "string" && CODE_OF_SQLSTATE[state]) || 500;
}

// ---------------------------------------------------------------------------
// State — per-doc subscriber tracking
// ---------------------------------------------------------------------------

interface DocState {
  version: number;
  /**
   * The last version a notification has announced (or an open read): a drain
   * reads no further (todo #55). A later entry is heard when its own
   * notification comes, so each notification maps to entries not yet heard,
   * and a document let go of and tracked again by a late notification does not
   * read an entry twice. A resync after a reconnect, which missed notifications,
   * reads to the end.
   */
  until: number;
  subscribers: Set<any>;
  notifying: boolean;
  /** A notification arrived while a fetch was in flight — re-drain when it ends. */
  pending: boolean;
}

/** _delta_fetch_log (delta_fetch_ops' rows) caps each call at this many; a full page means there may be more. */
const FETCH_PAGE = 1000;

/**
 * How the listener reads a document's log. `_delta_fetch_log` (001e) gives each
 * entry with the write as applied, for custom documents (todo #44). Framework
 * SQL older than this listener -- vendored with `delta init` into an initdb
 * directory and not re-applied -- has no such function, and every fetch would
 * fail, so no broadcast would reach anyone: there the listener reads
 * `delta_fetch_ops`, each entry heard as told, as before, and says so once.
 */
const FETCH_LOG = "SELECT version, ops, applied FROM _delta_fetch_log($1, $2)";
const FETCH_TOLD = "SELECT version, ops, NULL::jsonb AS applied FROM delta_fetch_ops($1, $2)";
async function fetchQuery(pool: Pool): Promise<string> {
  const { rows } = await pool.query("SELECT to_regprocedure('_delta_fetch_log(text, bigint)') IS NOT NULL AS ok");
  if (rows[0]?.ok) return FETCH_LOG;
  log.warn(
    "the framework SQL is older than this listener (no _delta_fetch_log, 001e): changes are read with delta_fetch_ops, " +
    "and a custom document hears a write once for each document told of it. Re-apply it (applyFramework, or " +
    "bunx @blueshed/delta init) and restart.",
  );
  return FETCH_TOLD;
}

export async function createDocListener<I = unknown>(
  ws: WsServer,
  pool: Pool,
  opts?: {
    /** The documents this listener answers for: `docTypeFromDef(def, pool)`, or a `DocType` written by hand. */
    types?: DocType<any, I>[];
    auth?: DeltaAuth<I>;
    custom?: CustomDocDef<any>[];
    /** Keep the ledger (001g): every write with its inverse, who made it and the cursor undo walks; and `undo`, `redo`, `history`. */
    ledger?: boolean;
    /** How an identity is written in the ledger. Default: a string or number as it is, anything else as JSON. */
    who?: (identity: I) => string;
  },
) {
  const auth = opts?.auth;
  // Default-deny, as docTypeFromDef is: with auth, every document -- a custom
  // one, a registered type -- says who owns it, or that it is shared. Asked
  // before the pool is touched, so a refusal leaves nothing to clean up.
  assertOwned(opts?.custom ?? [], auth);
  const registry = docTypes((opts?.types ?? []) as DocType[], (opts?.custom ?? []).map((d) => d.prefix), !!auth);
  const resolveDoc = registry.resolve;
  const ledger = !!opts?.ledger;
  const whoOf = (identity: I | undefined): string | null => ledgerWho(identity, opts?.who);
  // The cursor undo walks: named by a caller in this process, and over the
  // socket the connection itself -- signed in, the person and the connection
  // together, so another person holding the same connection id (a client may
  // choose it, to keep its cursor across a reconnect) cannot walk it.
  const cursorOf = (msg: any, client: any, identity: I | undefined): string | null =>
    client?.data?.local ? (typeof msg.cursor === "string" ? msg.cursor : null) : socketCursor(whoOf(identity), client);
  // Who is writing, for the ledger: the identity the gate gives when there is
  // an auth module; without one, the identity the client carries
  // (`createLocal().as(identity)`, or one set at upgrade) -- as the SQLite backend reads it.
  const writerOf = (identity: I | undefined, client: any): I | undefined =>
    auth ? identity : (client?.data?.identity as I | undefined);
  /** The gate's identity (undefined without auth), or the 401 for a socket without one. */
  const gate = (client: any): { identity: I | undefined } | { error: Refusal } => {
    if (!auth) return { identity: undefined };
    const gated = auth.gate(client);
    return isAuthError(gated) ? { error: { code: 401, message: gated.error } } : { identity: gated };
  };
  const tracked = new Map<string, DocState>();
  /**
   * The names this listener holds open in the database (`_delta_held`, todo
   * #73), each its hold's query: a write's fan-out asks only the names held
   * somewhere. A name is held from before its first open here reads it, until
   * nobody here has it open or is opening it (`opening`). Its holds and lets
   * go run on the pool in the order asked, one name's beside another's: a hold
   * that waits for a write holds up no other name. The listener's connection
   * keeps the lock that says this holder is alive.
   */
  const holds = new Map<string, Promise<unknown>>();
  const opening = new Map<string, number>();
  const queued = new Map<string, Promise<unknown>>();
  let holder: number | null = null;
  /** `sql` for `docName`, after what was asked for it before. */
  function inOrder(docName: string, sql: string): Promise<unknown> {
    const run = (queued.get(docName) ?? Promise.resolve()).then(() => pool.query(sql, [holder, docName]));
    const done = run.catch(() => {});
    queued.set(docName, done);
    void done.then(() => { if (queued.get(docName) === done) queued.delete(docName); });
    return run;
  }

  // The custom documents (../custom): who holds each, who may hear it, what a
  // write tells it -- and who may still hear any document (todo #17): a change
  // told asks the gate and `owns` again of each socket it is told to (`owns`
  // once per identity per change), so what a change costs is the identities a
  // document has open, not its sockets. Without auth nothing is asked. The
  // longest prefix answers a name: a type's longer than a custom doc's wins.
  const custom = createCustomDocs<I, Pool>({
    defs: opts?.custom ?? [], handle: pool, auth, publish: (channel, data) => ws.publish(channel, data), log,
    answers: (docName, length) => (resolveDoc(docName)?.type.prefix.length ?? 0) <= length,
  });
  const ownsOf = (docName: string): Owns<I> | undefined => {
    const type = resolveDoc(docName)?.type;
    return type?.owns ? (identity, name) => type.owns!(identity, name) : undefined;
  };

  // Single LISTEN connection with auto-reconnect
  const fetchSql = await fetchQuery(pool);
  let listener: PoolClient = await pool.connect();
  let destroyed = false;
  let reconnecting = false;

  let errorHandler: ((err: Error) => void) | null = null;

  // Detach our handlers before releasing a connection — released connections
  // are recycled by the pool, and a stale listener would fire against this
  // closure's state (and spuriously trigger reconnect) on a future checkout.
  function detachListener(client: any) {
    try { client.removeListener?.("notification", onNotification); } catch {}
    if (errorHandler) {
      try { client.removeListener?.("error", errorHandler); } catch {}
    }
  }

  /** LISTEN on `client`, and keep this holder's lock on it. */
  async function setupListener(client: any): Promise<void> {
    await client.query("LISTEN delta_changes");
    client.on("notification", onNotification);
    errorHandler = (err: Error) => {
      log.error(`listener error: ${err.message}`);
      if (!destroyed) reconnect();
    };
    client.on("error", errorHandler);
    holder = (await client.query("SELECT _delta_holder_start($1) AS holder", [holder])).rows[0].holder;
  }

  async function reconnect() {
    if (reconnecting || destroyed) return; // a single error event runs the loop
    reconnecting = true;
    // `reconnecting` stays true for the WHOLE operation, including the resync,
    // so an error fired by the freshly-connected listener during resync can't
    // spawn a second concurrent reconnect that releases the connection resync
    // is using. The finally guarantees the flag is always cleared.
    try {
      log.info("listener reconnecting...");
      detachListener(listener);
      try { listener.release(); } catch {}
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (let attempt = 1; !destroyed; attempt++) {
        try {
          await delay(Math.min(attempt * 1000, 10000));
          listener = await pool.connect();
          await setupListener(listener);
          log.info("listener reconnected");
          await keepHolds();
          // Catch up: ops committed while we were disconnected were NOTIFY'd to
          // nobody, so re-drain every tracked doc from its last seen version.
          await resyncTracked();
          return;
        } catch (err) {
          log.error(`reconnect attempt ${attempt} failed: ${errMsg(err)}`);
        }
      }
    } finally {
      reconnecting = false;
    }
  }

  // Re-drain all tracked docs (used after a reconnect to recover missed ops).
  async function resyncTracked() {
    for (const [docName, state] of tracked) {
      state.until = Number.MAX_SAFE_INTEGER;   // the notifications while away are gone: read to the end
      if (state.notifying) { state.pending = true; continue; }
      state.notifying = true;
      try { await drainDoc(docName, state); }
      catch (err) { log.error(`resync ${docName}: ${errMsg(err)}`); }
      finally { state.notifying = false; }
    }
  }

  try {
    await setupListener(listener);
  } catch (err) {
    detachListener(listener);
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
      if (!state && custom.size === 0) return;
      if (!state) {
        // Initialize at v-1 so we fetch only the current notification's row.
        // Custom docs loaded their initial state via `def.query` on open, so
        // pre-existing ops are already reflected — replaying history would
        // duplicate them. Same logic protects close-then-reopen.
        state = { version: Math.max(0, v - 1), until: v, subscribers: new Set(), notifying: false, pending: false };
        tracked.set(docName, state);
      }

      if (v <= state.version) return;
      state.until = Math.max(state.until, v);
      if (state.notifying) {
        // A fetch is already running for this doc. Coalesce instead of dropping:
        // dropping here lost ops when a concurrent write's NOTIFY landed mid-fetch.
        state.pending = true;
        return;
      }

      state.notifying = true;
      try {
        await drainDoc(docName, state);
      } finally {
        state.notifying = false;
      }
    } catch (err) {
      log.error(`notify error: ${errMsg(err)}`);
    }
  }

  // Drain a doc's ops to its subscribers. Loops while a full page comes back
  // (a backlog larger than the fetch's LIMIT) and re-runs if another
  // notification arrived mid-drain (the coalesced `pending` flag). Caller owns
  // the `notifying` guard.
  async function drainDoc(docName: string, state: DocState) {
    do {
      state.pending = false;
      let more = true;
      while (more && state.version < state.until) {
        const page = (await pool.query(fetchSql, [docName, state.version])).rows;
        // only what a notification has announced (`until`): the rest is heard with its own
        const rows = page.filter((row: any) => Number(row.version) <= state.until);
        more = page.length >= FETCH_PAGE && rows.length === page.length;
        // Told to those who may still hear it (todo #17): the document's own
        // subscribers, and the custom documents' that watch what it changed.
        if (auth && rows.length > 0) {
          await custom.letGo(docName, state.subscribers, ownsOf(docName));
          await custom.letGoWatching(rows.flatMap((row: any) => (row.applied ?? row.ops) as DeltaOp[]));
        }
        for (const row of rows) {
          if (state.subscribers.size > 0) {
            // `v` lets the client validate the per-doc sequence and re-open on
            // a gap. delta_fetch_ops rows are contiguous and ascending per doc.
            // Number(): pg returns a top-level BIGINT column as a string, but
            // the open snapshot's `_v` (from JSONB) is a number — the client
            // compares them strictly, so both must be numbers.
            ws.publish(docName, { doc: docName, ops: row.ops, v: Number(row.version) });
          }
          state.version = Number(row.version);
          // A custom document hears each write once, as it was applied: the
          // writer's entry carries it (`applied`) where the writer was told
          // otherwise, and null where it was told the write as applied; each
          // other told document's entry of the write carries none ([]). Told,
          // a row that left a document is a remove, which is not a delete, and
          // a row told to two documents would be heard twice (todo #44). An
          // entry logged some other way carries null too: heard as told.
          custom.tell((row.applied ?? row.ops) as DeltaOp[]);
        }
      }
    } while (state.pending);
    if (state.until > state.version) state.until = state.version;   // after a resync: from here, as announced

    pruneDoc(docName);
    log.debug(`notify ${docName} v${state.version}`);
  }

  function pruneDoc(docName: string) {
    const state = tracked.get(docName);
    if (!state) return;
    for (const sub of state.subscribers) {
      if (sub.readyState !== undefined && sub.readyState !== 1) {
        state.subscribers.delete(sub);
      }
    }
    if (state.subscribers.size === 0) { tracked.delete(docName); release(docName); }
  }

  function hold(docName: string): Promise<unknown> {
    let held = holds.get(docName);
    if (!held) {
      held = inOrder(docName, "SELECT _delta_hold($1, $2)");
      held.catch(() => { if (holds.get(docName) === held) holds.delete(docName); });
      holds.set(docName, held);
    }
    return held;
  }

  /** Let go of a name nobody here has open or is opening. */
  function release(docName: string): void {
    if (tracked.get(docName)?.subscribers.size || opening.has(docName) || !holds.delete(docName)) return;
    inOrder(docName, "SELECT _delta_let_go($1, $2)")
      .catch((err) => log.error(`let go of ${docName}: ${errMsg(err)}`));
  }

  /**
   * Back from a lost connection: a name cleared while the listener was away
   * (another took it for gone) may have missed a write. Each socket is let go
   * of such a document, and opens it again; an open reading it reads again.
   */
  async function keepHolds(): Promise<void> {
    await Promise.allSettled(holds.values());
    const { rows } = await pool.query("SELECT doc_name FROM _delta_held WHERE holder = $1", [holder]);
    const still = new Set(rows.map((r: any) => r.doc_name as string));
    for (const docName of [...holds.keys()]) {
      if (still.has(docName)) continue;
      holds.delete(docName);
      for (const client of tracked.get(docName)?.subscribers ?? []) {
        try { trackUnsubscribe(client, docName); } catch { /* the socket may be closing */ }
        sendTo(client, { doc: docName, error: { code: 500, message: "the server lost the database for a while: open it again" } });
      }
      tracked.delete(docName);
    }
  }

  // Transport-level teardown (socket drop / logout via dropClientSubscriptions):
  // pruneDoc only runs when a doc drains, so a doc whose subscribers all
  // vanished without further writes stayed tracked, and custom-doc caches
  // (which pruneDoc never touches) lived until an explicit `close` action
  // that a dropped socket never sends. Mirrors the sqlite backend's hook.
  function releaseClient(client: any): void {
    for (const [docName, state] of tracked) {
      if (!state.subscribers.delete(client)) continue;
      if (state.subscribers.size === 0) { tracked.delete(docName); release(docName); }
    }
    custom.leave(client);
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

  // `owned: false` for close alone: letting go of a document never needs the owner's say.
  function withDoc(label: string, fn: (dc: DocCtx) => Promise<void> | void, { owned = true } = {}) {
    return async (msg: any, client: any, respond: (r: any) => void) => {
      const g = gate(client);
      if ("error" in g) return respond(g);
      const { identity } = g;
      const docName = msg.doc as string;
      if (!docName) {
        return respond({ error: { code: 400, message: "doc is required" } });
      }
      const found = resolveDoc(docName);
      if (!found) {
        return respond({ error: { code: 404, message: `No handler for ${docName}` } });
      }
      try {
        // The document's name is its channel: one this identity does not own is
        // not there for it (404, as a missing one), so it never subscribes.
        if (owned && auth && found.type.owns && !(await found.type.owns(identity as I, docName))) {
          return respond({ error: NOT_FOUND });
        }
        await fn({ docName, type: found.type, ctx: found.ctx, msg, client, respond, identity });
      } catch (err) {
        const m = errMsg(err);
        log.error(`${label} failed: ${m}`);
        respond({ error: { code: wireCode(err), message: m } });
      }
    };
  }

  // ---------------------------------------------------------------------------
  // WS branches — custom docs first (short-circuit before standard withDoc)
  // ---------------------------------------------------------------------------

  if (custom.size > 0) {
    ws.on("open", async (msg: any, client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      const match = custom.find(docName);
      if (!match) return;                                     // fall through to standard

      // Gate custom docs exactly like standard docs (withDoc). Without this the
      // custom open handler — which registers before and short-circuits the
      // standard gated handler — let an unauthenticated client read scoped data.
      const g = gate(client);
      if ("error" in g) return respond(g);
      const { identity } = g;

      try {
        // As withDoc asks a type's owns: a name this identity does not own is not there for it.
        if (auth && match.def.owns && !(await match.def.owns(identity as I, docName))) return respond({ error: NOT_FOUND });
        const doc = await custom.open(client, docName, match, identity);
        if (doc == null) return respond({ error: NOT_FOUND });
        trackSubscribe(client, docName);
        onClientDrop(client, releaseClient);
        respond({ result: doc });
        log.info(`opened ${docName} (custom${match.def.recompute ? ", recompute" : ""})`);
      } catch (err) {
        log.error(`open custom ${docName} failed: ${errMsg(err)}`);
        respond({ error: { code: 500, message: errMsg(err) } });
      }
    });

    ws.on("delta", (msg: any, _client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      if (!custom.find(docName)) return;                       // fall through to standard
      respond({ error: { code: 403, message: "Custom docs are read-only; write through the source doc." } });
    });

    ws.on("close", (msg: any, client: any, respond: (r: any) => void) => {
      const docName = msg.doc as string;
      if (!docName) return;
      if (!custom.find(docName)) return;                       // fall through to standard
      trackUnsubscribe(client, docName);
      custom.leave(client, docName);
      respond({ result: { ack: true } });
      log.debug(`closed ${docName} (custom)`);
    });
  }

  ws.on("open", withDoc("open", async ({ docName, type, ctx, msg, client, respond, identity }) => {
    opening.set(docName, (opening.get(docName) ?? 0) + 1);
    try {
      // held before the read: a write from now is told to this name; one lost
      // while it read (keepHolds) is held and read again
      let result;
      for (let held = hold(docName); ; held = hold(docName)) {
        await held;
        result = await type.open(ctx, docName, msg, identity);
        if (holds.get(docName) === held) break;
      }
      if (!result) return respond({ error: NOT_FOUND });

      pruneDoc(docName);
      let state = tracked.get(docName);
      if (!state) {
        state = { version: Number(result.version), until: Number(result.version), subscribers: new Set(), notifying: false, pending: false };
        tracked.set(docName, state);
      } else {
        state.version = Math.max(state.version, Number(result.version));
        state.until = Math.max(state.until, state.version);
      }

      state.subscribers.add(client);
      trackSubscribe(client, docName);
      onClientDrop(client, releaseClient);
      respond({ result: result.result });
      log.info(`opened ${docName} v${state.version}`);
    } finally {
      const left = opening.get(docName)! - 1;
      if (left > 0) opening.set(docName, left); else opening.delete(docName);
      release(docName);
    }
  }));

  ws.on("delta", withDoc("delta", async ({ docName, type, ctx, msg, client, respond, identity }) => {
    const writer = writerOf(identity, client);
    const by = ledger ? { who: whoOf(writer), cursor: cursorOf(msg, client, writer), undoable: msg.undoable !== false } : undefined;
    const result = await type.apply(ctx, docName, msg.ops, identity, by);
    respond({ result: ledger ? { ack: true, version: Number(result.version), ops: result.ops, inverse: result.inverse, entry: result.entry == null ? undefined : Number(result.entry) } : { ack: true, version: Number(result.version) } });
    log.info(`delta ${docName} v${result.version}`);
  }));

  if (ledger) {
    /**
     * Undo or redo: the cursor's next entry, walked in the database (001g
     * `delta_walk`) by its guarded plan and recorded as walking it; a conflict
     * changes nothing, answers `conflict`, and moves the cursor on. `dry: true`
     * answers the plan; `entry: id` walks only that entry. `change: id` walks
     * one change of the cursor's instead (`_delta_change_tip`), and a conflict
     * then records nothing.
     */
    const walk = (way: "undo" | "redo") => async (msg: any, client: any, respond: (r: any) => void) => {
      const change = msg.change ?? null;
      if (change !== null && !isEntryId(change)) return respond({ error: { code: 400, message: "change must be an entry's id: a whole number from 1" } });
      const g = gate(client);
      if ("error" in g) return respond(g);
      const { identity } = g;
      const db = await pool.connect();
      try {
        const writer = writerOf(identity, client);
        const cursor = cursorOf(msg, client, writer);
        await db.query("BEGIN");
        // A walk writes to its entry's document, so it asks owns as delta does:
        // under the cursor's lock (delta_walk takes it again), so the entry
        // asked about is the one walked.
        if (auth && cursor !== null) {
          await db.query("SELECT pg_advisory_xact_lock(hashtext('delta-cursor:' || $1::text))", [cursor]);
          const tip = (change === null
            ? await db.query("SELECT doc_name FROM _delta_ledger_tip($1, $2)", [cursor, way === "undo"])
            : await db.query("SELECT doc_name FROM _delta_change_tip($1, $2, $3)", [cursor, change, way === "undo"])).rows[0]?.doc_name;
          const found = tip ? resolveDoc(tip) : null;
          if (found?.type.owns && !(await found.type.owns(identity as I, tip))) {
            await db.query("ROLLBACK");
            return respond({ error: NOT_FOUND });
          }
        }
        // a change named takes 001g's newer forms; none, the ones a database on 0.10.0's SQL has too
        const args = [cursor, whoOf(writer), way === "undo", msg.dry === true, msg.entry ?? null, ...(change === null ? [] : [change])];
        const walked = (await callAs(db, "delta_walk", args, auth, identity)) ?? null;
        const result = walked?.doc ? await showAnswer(db, walked.doc, walked, resolveDoc(walked.doc)?.type.def) : walked;   // as its document shows them
        await db.query("COMMIT");
        respond({ result: result && { ...result, ...(result.version != null ? { version: Number(result.version) } : {}), entry: result.entry == null ? undefined : Number(result.entry) } });
      } catch (err) {
        try { await db.query("ROLLBACK"); } catch { /* the connection may be gone */ }
        log.error(`${way} failed: ${errMsg(err)}`);
        respond({ error: { code: wireCode(err), message: errMsg(err) } });
      } finally {
        db.release();
      }
    };
    ws.on("undo", walk("undo"));
    ws.on("redo", walk("redo"));
    // A document's recent history, to whoever may open it: each entry says `mine`, never who wrote it.
    ws.on("history", withDoc("history", async ({ docName, type, ctx, msg, client, respond, identity }) => {
      if (!(await type.open(ctx, docName, msg, identity))) return respond({ error: NOT_FOUND });
      const { rows } = await pool.query("SELECT delta_history($1, $2, $3) AS entries", [docName, cursorOf(msg, client, writerOf(identity, client)), msg.limit ?? 50]);
      respond({ result: await Promise.all((rows[0]?.entries ?? []).map((e: any) => showAnswer(pool, docName, e, type.def))) });
    }));
  }

  ws.on("open_at", withDoc("open_at", async ({ docName, type, ctx, msg, respond, identity }) => {
    const at = msg.at as string;
    if (!at) return respond({ error: { code: 400, message: "at is required" } });
    if (!type.openAt) {
      return respond({ error: { code: 400, message: `open_at not supported for ${docName}` } });
    }
    const doc = await type.openAt(ctx, docName, at, identity);
    if (!doc) return respond({ error: NOT_FOUND });
    respond({ result: doc });
    log.info(`open_at ${docName} @ ${at}`);
  }));

  ws.on("close", withDoc("close", ({ docName, client, respond }) => {
    trackUnsubscribe(client, docName);
    const state = tracked.get(docName);
    if (state) {
      state.subscribers.delete(client);
      if (state.subscribers.size === 0) { tracked.delete(docName); release(docName); }
    }
    respond({ result: { ack: true } });
    log.debug(`closed ${docName}`);
  }, { owned: false }));

  return {
    /** Answer for one more type; one of a prefix it answers for already is replaced (`bun --hot`). */
    register: registry.register as (type: DocType<any, I>) => void,
    async destroy() {
      destroyed = true;
      try {
        await listener.query("UNLISTEN *");
        await listener.query("SELECT _delta_holder_stop($1)", [holder]);
      } catch {}
      // Released connections are recycled by the pool; stale listeners would
      // fire against this closure's state on future pooled connections.
      detachListener(listener);
      try { listener.release(); } catch {}
    },
  };
}
