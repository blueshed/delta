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
import type { DeltaAuth } from "../auth";

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
   *  happens via LISTEN/NOTIFY, but returning them keeps the contract honest. */
  apply(
    ctx: C,
    docName: string,
    ops: DeltaOp[],
    identity?: I,
  ): Promise<{ version: number; ops?: any[] }>;

  /** Optional: snapshot read at a historical timestamp. Not every doc type
   *  supports this (e.g. venue-at: already embeds the timestamp in its name). */
  openAt?(
    ctx: C,
    docName: string,
    at: string,
    identity?: I,
  ): Promise<any | null>;
}

// ---------------------------------------------------------------------------
// Registry — ordered by descending prefix length so longest match wins
// ---------------------------------------------------------------------------

const types: DocType[] = [];

export function registerDocType(t: DocType): void {
  types.push(t);
  types.sort((a, b) => b.prefix.length - a.prefix.length);
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
 */
export function docTypeFromDef<I = unknown>(
  def: DocDef,
  pool: Pool,
  opts?: { auth?: DeltaAuth<I> },
): DocType<{}, I> {
  const auth = opts?.auth;
  const usingAuth = !!auth?.asSqlArg;

  return {
    prefix: def.prefix,

    parse(docName) {
      return docName.startsWith(def.prefix) ? {} : null;
    },

    async open(_ctx, docName, _msg, identity) {
      let result: { doc: any } | undefined;
      if (usingAuth && identity !== undefined) {
        const { rows } = await pool.query(
          "SELECT delta_open_as($1, $2) AS doc",
          [String(auth!.asSqlArg!(identity)), docName],
        );
        result = rows[0];
      } else {
        const { rows } = await pool.query(
          "SELECT delta_open($1) AS doc",
          [docName],
        );
        result = rows[0];
      }
      const doc = result?.doc;
      if (!doc) return null;
      const version = doc._version ?? 0;
      delete doc._version;
      return { result: doc, version };
    },

    async apply(_ctx, docName, ops, identity) {
      let row: { result: any } | undefined;
      if (usingAuth && identity !== undefined) {
        const { rows } = await pool.query(
          "SELECT delta_apply_as($1, $2, $3) AS result",
          [String(auth!.asSqlArg!(identity)), docName, JSON.stringify(ops)],
        );
        row = rows[0];
      } else {
        const { rows } = await pool.query(
          "SELECT delta_apply($1, $2) AS result",
          [docName, JSON.stringify(ops)],
        );
        row = rows[0];
      }
      const result = row?.result;
      if (!result) throw new Error(`delta_apply returned no result for ${docName}`);
      return result;
    },

    async openAt(_ctx, docName, at, identity) {
      let row: { doc: any } | undefined;
      if (usingAuth && identity !== undefined) {
        const { rows } = await pool.query(
          "SELECT delta_open_at_as($1, $2, $3) AS doc",
          [String(auth!.asSqlArg!(identity)), docName, at],
        );
        row = rows[0];
      } else {
        const { rows } = await pool.query(
          "SELECT delta_open_at($1, $2) AS doc",
          [docName, at],
        );
        row = rows[0];
      }
      return row?.doc ?? null;
    },
  };
}
