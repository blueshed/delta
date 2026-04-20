/**
 * Adapter contract + stats helpers for the 0.3.0 single-write bench.
 *
 * Each adapter owns its own pool and exposes three primitives:
 *   - setup()    seed N rows owned by `userId`
 *   - writeOp()  one round-trip's worth of work for a single-field update
 *   - teardown() close the pool
 *
 * The workload drives `writeOp` N times and records per-call wall time.
 * RTT is the declared round-trip count the adapter takes per writeOp — the
 * table prints this next to the measured latency so the reader can reconcile
 * "network-bound" vs "server-bound" when running against a remote DB.
 */

export interface Adapter {
  /** Display name, e.g. "delta-new (1-RTT)". */
  name: string;
  /** Declared round-trips per `writeOp` call. */
  rtt: number;
  /** Seed data + any per-adapter schema prep. Called once before the workload. */
  setup(): Promise<void>;
  /** One single-field update on a pre-existing row. Called N times by the workload. */
  writeOp(rowId: number, newValue: number): Promise<void>;
  /** Close pool(s). */
  teardown(): Promise<void>;
}

export interface Stats {
  iterations: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  totalMs: number;
}

export function computeStats(samples: number[]): Stats {
  if (samples.length === 0) {
    return { iterations: 0, p50: 0, p95: 0, p99: 0, mean: 0, totalMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    iterations: samples.length,
    p50: pct(sorted, 0.5),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    mean: sum / samples.length,
    totalMs: sum,
  };
}

function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i] ?? 0;
}

/** Fixed-width ms formatter for the results table — "  1.234" style. */
export function fmtMs(ms: number): string {
  return `${ms.toFixed(3).padStart(7, " ")} ms`;
}
