/**
 * The law over generated writes (todo #27), run on SQLite and the JSON file at
 * once: the driver is `src/cases/law.ts`, published in `@blueshed/delta/testing`
 * (dzql runs it with its Postgres place beside SQLite's).
 *
 *   DELTA_LAW_SEEDS=20 DELTA_LAW_STEPS=1000 bun test tests/law-driver.test.ts
 */
import { describe, test } from "bun:test";
import { setLogLevel } from "../src/server/logger";
import { drive, lawSeeds, lawSteps, onJson, onSqlite } from "@blueshed/delta/testing";

setLogLevel("silent");

describe("the law over generated writes (todo #27)", () => {
  for (const seed of lawSeeds) {
    test(`seed ${seed}: ${lawSteps} steps, the same on SQLite and the JSON file`, async () => {
      const places = [onSqlite(), onJson()];
      try { await drive(seed, places); }
      finally { for (const p of places) await p.end(); }
    }, 600_000);
  }
});
