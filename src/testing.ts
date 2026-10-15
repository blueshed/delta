/**
 * @blueshed/delta/testing -- what delta's own tests drive a server with, for
 * an app to test its own: a WS-shaped client, a message sent and its answer
 * awaited, a poll; and two rules delta keeps in two languages, as data for any
 * other implementation to run: the JSON Pointer grammar and the walk planner.
 *
 *   const ws = createWs();
 *   registerDocs(ws, db, schema, docs);
 *   const client = mockClient();
 *   await sendAndAwait(ws, client, { action: "open", doc: "items:" });
 */
import type { DeltaOp } from "./core";
import vectors from "./pointer-vectors.json";
import walks from "./walk-vectors.json";

/**
 * Each pointer, and the segments it splits into (RFC 6901), or null when it is
 * malformed. `splitPath` and `_delta_split_path` answer every one alike; the
 * same file is `src/pointer-vectors.json` in the package.
 */
export const pointerVectors: { pointer: string; segments: string[] | null }[] = vectors;

/** One case of the walk planner: an entry, the document as it is now, and what walking the entry does to it. */
export interface WalkVector {
  name: string;
  /** The document's name: `walk-lists:` (list mode) or `walk-list:1` (a single document, its root a row). */
  doc: string;
  /** The document as it is now, as `open` answers it. */
  current: any;
  /** The ledger entry walked: the ops as applied and their inverse. */
  entry: { ops: DeltaOp[]; inverse: DeltaOp[] };
  /** The walk's ops, or no ops and the conflicting paths. */
  expected: { ops: DeltaOp[]; conflict?: string[] };
}

/**
 * The walk planner's cases: `planWalk` (SQLite, the JSON file) and
 * `_delta_walk_plan` (Postgres, 001g) answer every one alike, over the schema
 * and documents given with them (cards are lists' children, by `lists_id`).
 * The same file is `src/walk-vectors.json` in the package.
 */
export const walkVectors: { schema: Record<string, any>; docs: Record<string, { root: string; include: string[] }>; vectors: WalkVector[] } = walks as any;

export * from "./cases/support";
export * from "./cases/path";
export * from "./cases/owns";
export * from "./cases/isolation";
export * from "./cases/law";
export * from "./cases/writes";
