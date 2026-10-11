/**
 * Doc-type registry — single source of truth for how doc names are dispatched.
 *
 * Each doc type owns a prefix and the four lifecycle operations:
 *   - parse   — does this name belong to me? return ctx or null.
 *   - open    — load the doc at its current version.
 *   - apply   — apply delta ops and return the new version.
 *   - openAt  — optional snapshot-at-timestamp read.
 *
 * Generic docs (delta-doc framework) register via `docTypeFromDef(def, pool)`.
 * Custom docs (e.g. venue-occasion) export their own `DocType` and register it.
 *
 * doc-listener consults `resolveDoc(name)` for every WS message — no other
 * place in the codebase interprets doc-name prefixes.
 */
import type { Pool } from "pg";
import type { DocDef } from "./schema";
import type { DeltaOp } from "../../core";
import { authless, ownerless, type DeltaAuth } from "../auth";

/** Who is writing, for the ledger: the identity as the ledger has it, and the cursor undo walks. */
export type Writer = { who: string | null; cursor: string | null; undoable?: boolean; undoes?: number | null };

// ---------------------------------------------------------------------------
// DocType — the unified handler contract
// ---------------------------------------------------------------------------

export interface DocType<C = any, I = unknown> {
  /** Unique prefix this type owns (e.g. "venue:", "venue-at:"). */
  prefix: string;

  /** Parse the doc name into a context object, or null if it doesn't match. */
  parse(docName: string): C | null;

  /** Open the doc at its current version. `identity` is the authenticated
   *  identity produced by the `DeltaAuth` gate (undefined if auth disabled). */
  open(
    ctx: C,
    docName: string,
    msg?: any,
    identity?: I,
  ): Promise<{ result: any; version: number } | null>;

  /** Apply delta ops. Returns new version; ops may be omitted since broadcast
   *  happens via LISTEN/NOTIFY, but returning them keeps the contract honest.
   *  Given `by` (the listener keeps a ledger), the write is recorded with its
   *  inverse in the same transaction -- the framework's docs do; a custom type
   *  that ignores `by` is simply not on the ledger. */
  apply(
    ctx: C,
    docName: string,
    ops: DeltaOp[],
    identity?: I,
    by?: Writer,
  ): Promise<{ version: number; ops?: any[]; inverse?: any[]; entry?: number | null }>;

  /** Optional: snapshot read at a historical timestamp. Not every doc type
   *  supports this (e.g. venue-at: already embeds the timestamp in its name). */
  openAt?(
    ctx: C,
    docName: string,
    at: string,
    identity?: I,
  ): Promise<any | null>;

  /**
   * With an `auth` module: may `identity` open `docName`, write through it and
   * hear what is written to it? A document's name is its broadcast channel --
   * whoever has it open hears every write made through it, whatever RLS lets
   * them read -- so this is the check that keeps one identity's writes off
   * another's socket. The listener asks it before open, delta, open_at,
   * history, and an undo or redo of an entry written through the document;
   * false answers 404. It asks it again before it tells a socket of a change,
   * once per identity per change, and lets go of a socket it refuses -- so keep
   * it cheap (a name check, or a membership the app caches). With auth, a type needs it or `shared: true`:
   * `registerDocType` and `createDocListener` refuse one with neither.
   */
  owns?(identity: I, docName: string): boolean | Promise<boolean>;

  /**
   * With an `auth` module: every identity that passes the gate may open every
   * document of this prefix and hear every write to it -- the author's word
   * for a type with no `owns`.
   */
  shared?: boolean;
}

// ---------------------------------------------------------------------------
// Registry — ordered by descending prefix length so longest match wins
// ---------------------------------------------------------------------------

const types: DocType[] = [];

/** The listeners with an `auth` module now running: while there is one, every type must say who owns it. */
const authed = new Set<object>();

export function registerDocType(t: DocType): void {
  if (authed.size > 0 && !t.owns && !t.shared) throw ownerless(t.prefix);
  types.push(t);
  types.sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * For `createDocListener` with `auth`: refuse if a registered type says neither
 * `owns` nor `shared`, and from now until the returned release, refuse to
 * register one.
 */
export function holdAuth(): () => void {
  const unowned = types.find((t) => !t.owns && !t.shared);
  if (unowned) throw ownerless(unowned.prefix);   // named where it was registered: that is where it says
  const token = {};
  authed.add(token);
  return () => void authed.delete(token);
}

export function resolveDoc(docName: string): { type: DocType; ctx: any } | null {
  for (const type of types) {
    const ctx = type.parse(docName);
    if (ctx !== null) return { type, ctx };
  }
  return null;
}

/** For tests — reset between cases. */
export function clearRegistry(): void {
  types.length = 0;
  authed.clear();
}

/**
 * `SELECT fn(args) AS result` on `db`, as `identity` when the auth module
 * says how to name it (`asSqlArg`): `fn_as(user, args)`, which sets
 * `app.user_id` and calls `fn` in one round-trip (001f).
 */
export async function callAs<I>(db: { query(sql: string, params: unknown[]): Promise<{ rows: any[] }> }, fn: string, args: unknown[], auth?: DeltaAuth<I>, identity?: I): Promise<any> {
  const as = auth?.asSqlArg && identity !== undefined ? [String(auth.asSqlArg(identity))] : [];
  const all = [...as, ...args];
  const { rows } = await db.query(`SELECT ${as.length ? `${fn}_as` : fn}(${all.map((_, i) => `$${i + 1}`).join(", ")}) AS result`, all);
  return rows[0]?.result;
}

// ---------------------------------------------------------------------------
// docTypeFromDef — lift a generic DocDef into a DocType
// ---------------------------------------------------------------------------

/**
 * Produce a DocType for a framework-generic doc. One DocType per DocDef —
 * this replaces the former "one big generic handler that loops prefixes"
 * pattern so the registry stays flat and each prefix owns itself.
 *
 * When `opts.auth` is provided with `asSqlArg`, the hot path calls the
 * `delta_*_as(user_id, ...)` stored-function variants (see
 * `src/sql/001f-delta-as.sql`). Each op is ONE round-trip — the wrapper
 * runs `set_config('app.user_id', ..., true)` server-side inside the
 * SELECT's implicit transaction, then calls the base function. Compare
 * to the four RTTs `withAppAuth` takes (BEGIN / set_config / call / COMMIT).
 *
 * When auth is omitted, queries run on the bare pool with the base
 * `delta_*` functions.
 *
 * With `auth`, pass `owns(identity, docName)` -- who may open a document of
 * this prefix -- or `shared: true`; without either it throws. A document's
 * name is the channel its writes are broadcast on, so RLS alone does not keep
 * one identity's writes off another identity's socket.
 */
export function docTypeFromDef<I = unknown>(
  def: DocDef,
  pool: Pool,
  opts?: {
    auth?: DeltaAuth<I>;
    /** Who may open a document of this prefix (see `DocType.owns`). Required with `auth`, unless `shared`. */
    owns?: (identity: I, docName: string) => boolean | Promise<boolean>;
    /** Every identity that passes the gate may open every document of this prefix and hear every write to it. */
    shared?: boolean;
  },
): DocType<{}, I> {
  const auth = opts?.auth;
  // Default-deny: RLS filters what `open` reads, not what the document's
  // channel carries, so a name several identities may open would hand each of
  // them every row written through it. Say who owns it, or that it is shared.
  if (auth && !opts?.owns && !opts?.shared) throw ownerless(def.prefix, "docTypeFromDef");
  // owns or shared with no auth module would guard nothing: the listener asks them only with one
  if (!auth && (opts?.owns || opts?.shared)) throw authless(def.prefix, "docTypeFromDef");

  return {
    prefix: def.prefix,
    ...(opts?.owns ? { owns: opts.owns } : {}),
    ...(opts?.shared ? { shared: true } : {}),

    parse(docName) {
      return docName.startsWith(def.prefix) ? {} : null;
    },

    async open(_ctx, docName, _msg, identity) {
      const doc = await callAs(pool, "delta_open", [docName], auth, identity);
      if (!doc) return null;
      const version = doc._version ?? 0;
      delete doc._version;
      // Forward the version to the client as `_v` so it can detect a missed
      // broadcast (gap) and re-open to resync. The client strips `_v` before
      // it reaches `doc.data`. Number() keeps it consistent with the broadcast
      // `v` (which pg yields as a string from a BIGINT column).
      doc._v = Number(version);
      return { result: doc, version };
    },

    async apply(_ctx, docName, ops, identity, by) {
      // on the ledger: delta_apply with its entry, in one transaction (001g)
      const result = by
        ? await callAs(pool, "delta_apply_logged", [docName, JSON.stringify(ops), by.who, by.cursor, by.undoable !== false, by.undoes ?? null], auth, identity)
        : await callAs(pool, "delta_apply", [docName, JSON.stringify(ops)], auth, identity);
      if (!result) throw new Error(`delta_apply returned no result for ${docName}`);
      return result;
    },

    async openAt(_ctx, docName, at, identity) {
      return (await callAs(pool, "delta_open_at", [docName, at], auth, identity)) ?? null;
    },
  };
}
