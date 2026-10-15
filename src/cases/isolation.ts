/**
 * Per-doc isolation property — backend-agnostic.
 *
 * Asserts: for any two open docs `p:x` and `p:y` with `x ≠ y`, a write to
 * `p:x` produces ZERO broadcasts on `p:y`'s channel and leaves `p:y`'s
 * cached state clean (a fresh open of `p:y` must not include rows from x).
 *
 * Each suite provides a small adapter (`Harness`) that hides backend
 * specifics — open over WS, send a delta, wait for fan-out, observe
 * broadcasts on a per-client `sent` array — and the helper drives the
 * shared property against it.
 *
 * Why this exists: the cross-doc-leak bug in registerDocs (see git log)
 * went undetected because no test opened two same-prefix sibling docs at
 * once. This helper makes negative isolation a routine check.
 */
import { expect } from "bun:test";

export interface OpenedDoc {
  /** Per-client message buffer — broadcasts on this client's channels land here. */
  sent: any[];
  /** Initial doc state returned by the open response. */
  snapshot: any;
  /** Backend-specific client handle, opaque to the helper. */
  client: unknown;
}

export interface IsolationHarness {
  /** Open `docName` for a freshly-created client. Resolves with the open response and the client. */
  open(docName: string): Promise<OpenedDoc>;
  /** Apply ops to `docName` from a previously-opened client. Should resolve once the write is acked. */
  delta(client: unknown, docName: string, ops: any[]): Promise<void>;
  /**
   * For backends with async fan-out (Postgres LISTEN/NOTIFY), give the runtime
   * a beat to deliver before assertions run. SQLite's in-process pub/sub is
   * synchronous — no-op there. Defaults to ~250ms when implemented.
   */
  flush?(): Promise<void>;
}

export interface IsolationCase {
  /** Doc whose isolation we're checking — sometimes called "the bystander". */
  bystander: string;
  /** Doc that performs the write. */
  writer: string;
  /** Ops applied to `writer` that, before the fix, would have leaked. */
  mutateOps: any[];
  /** Collection the leaked row would land under, in the doc shape. */
  affectedCollection: string;
  /** Id of the row we're proving does NOT leak. */
  leakedId: string;
}

/**
 * Run the isolation property against a harness. Asserts:
 *   1. After the write, the bystander's `sent` buffer contains no
 *      broadcast messages tagged with `doc: bystander`.
 *   2. A fresh open of `bystander` returns a snapshot where the leaked id
 *      is absent from `affectedCollection`.
 */
export async function assertDocIsolation(
  h: IsolationHarness,
  c: IsolationCase,
): Promise<void> {
  const bystander = await h.open(c.bystander);
  const writer = await h.open(c.writer);

  // Discard pre-mutation broadcasts (e.g. open responses delivered via send).
  bystander.sent.length = 0;

  await h.delta(writer.client, c.writer, c.mutateOps);
  await h.flush?.();

  // (1) Live broadcast leak check
  const liveLeaks = bystander.sent.filter((m: any) => m?.doc === c.bystander);
  expect(liveLeaks).toEqual([]);

  // (2) Cache pollution check — a fresh open must not include the row
  const fresh = await h.open(c.bystander);
  const leakedRow = fresh.snapshot?.[c.affectedCollection]?.[c.leakedId];
  expect(leakedRow).toBeUndefined();
}
