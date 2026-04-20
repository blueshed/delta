/**
 * Bench runner — applies framework SQL, then walks each adapter through the
 * single-write workload and prints a comparison table.
 *
 * Usage (requires `bun run db:up` on the default compose):
 *
 *   bun run bench/run.ts
 *   BENCH_ITERATIONS=5000 bun run bench/run.ts
 *   BENCH_PG_URL=postgres://... bun run bench/run.ts
 */
import { Pool } from "pg";
import { applyFramework } from "../src/server/postgres";
import type { Adapter, Stats } from "./adapter";
import { fmtMs } from "./adapter";
import { deltaNewAdapter } from "./adapters/delta-new";
import { deltaOldAdapter } from "./adapters/delta-old";
import { rawPostgresAdapter } from "./adapters/raw-postgres";
import { runSingleWrite } from "./workloads/single-write";

const PG_URL =
  process.env.BENCH_PG_URL ??
  process.env.DELTA_TEST_PG_URL ??
  "postgres://delta:delta@localhost:5433/delta_test";

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 10_000);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 200);

async function applyFrameworkOnce(): Promise<void> {
  const pool = new Pool({ connectionString: PG_URL, max: 1 });
  try {
    await applyFramework(pool);
  } finally {
    await pool.end();
  }
}

interface Result {
  adapter: Adapter;
  stats: Stats;
}

async function runOne(factory: () => Adapter): Promise<Result> {
  const adapter = factory();
  await adapter.setup();
  try {
    const stats = await runSingleWrite(adapter, {
      iterations: ITERATIONS,
      warmup: WARMUP,
    });
    return { adapter, stats };
  } finally {
    await adapter.teardown();
  }
}

function printHeader(): void {
  console.log(
    `\ndelta bench — single-field write, ${ITERATIONS.toLocaleString()} iterations (${WARMUP} warm-up)\n` +
      `target: ${PG_URL}\n`,
  );
  console.log(
    "                        p50         p95         p99        mean       total    RTT",
  );
  console.log(
    "                     --------    --------    --------    --------    --------   ---",
  );
}

function printRow(r: Result): void {
  const { adapter, stats } = r;
  const cols = [
    adapter.name.padEnd(18, " "),
    fmtMs(stats.p50),
    fmtMs(stats.p95),
    fmtMs(stats.p99),
    fmtMs(stats.mean),
    `${(stats.totalMs / 1000).toFixed(2).padStart(7, " ")} s`,
    String(adapter.rtt).padStart(3, " "),
  ];
  console.log(cols.join("   "));
}

async function main(): Promise<void> {
  await applyFrameworkOnce();

  // Run all three adapters sequentially — we want them to share the same
  // hardware state. Order: raw first (baseline), delta-new, delta-old.
  const results: Result[] = [];
  results.push(await runOne(() => rawPostgresAdapter(PG_URL)));
  results.push(await runOne(() => deltaNewAdapter(PG_URL)));
  results.push(await runOne(() => deltaOldAdapter(PG_URL)));

  printHeader();
  for (const r of results) printRow(r);

  const newS = results.find((r) => r.adapter.name.startsWith("delta-new"))!.stats;
  const oldS = results.find((r) => r.adapter.name.startsWith("delta-old"))!.stats;
  const rawS = results.find((r) => r.adapter.name.startsWith("raw-postgres"))!.stats;
  console.log(
    `\ndelta-old / delta-new p50 ratio: ${(oldS.p50 / newS.p50).toFixed(2)}x   (expect ≈ 4x)` +
      `\ndelta-new / raw-postgres p50 ratio: ${(newS.p50 / rawS.p50).toFixed(2)}x   (expect ≈ 1-2x — extra server work in delta_apply)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
