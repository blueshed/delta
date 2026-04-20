/**
 * single-write workload — N single-field updates on random pre-seeded rows.
 *
 * Each iteration measures one `writeOp` call; we do NOT include setup or
 * teardown. A short warm-up phase runs first to stabilise the pool + JIT.
 */
import type { Adapter, Stats } from "../adapter";
import { computeStats } from "../adapter";
import { BENCH_SEED_ROWS } from "../schema";

export interface SingleWriteOptions {
  iterations: number;
  warmup?: number;
}

export async function runSingleWrite(
  adapter: Adapter,
  { iterations, warmup = 200 }: SingleWriteOptions,
): Promise<Stats> {
  // Warm-up — discard timings.
  for (let i = 0; i < warmup; i++) {
    const rowId = (i % BENCH_SEED_ROWS) + 1;
    await adapter.writeOp(rowId, i);
  }

  const samples = new Array<number>(iterations);
  for (let i = 0; i < iterations; i++) {
    const rowId = (i % BENCH_SEED_ROWS) + 1;
    const t0 = performance.now();
    await adapter.writeOp(rowId, i + warmup);
    samples[i] = performance.now() - t0;
  }
  return computeStats(samples);
}
