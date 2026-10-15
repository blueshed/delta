/**
 * The law over generated writes (todo #27), run on SQLite, the JSON file and
 * PGlite at once: the driver is `src/cases/law.ts`, published in
 * `@blueshed/delta/testing`; PGlite's place is here.
 *
 *   DELTA_LAW_SEEDS=20 DELTA_LAW_STEPS=1000 bun test tests/law-driver.test.ts
 */
import { describe, test } from "bun:test";
import type { Pool } from "pg";
import { applyFramework, applySql, createDocListener, docTypeFromDef, generateSql, importTables } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import {
  auth, drive, hearing, lawSeeds, lawSteps, onJson, onSqlite, pathDocs, pathPublicDocs, pathSchema, pathSeed, people, pubOwns,
  type Me, type Place,
} from "@blueshed/delta/testing";
import { postgresInbox, postgresMenuCard } from "./helpers/postgres-reads";

setLogLevel("silent");

/** A PGlite of its own for each seed: a long run on one wears it out ("regular expression is too complex", a WASM heap's limit). */
async function onPglite(): Promise<Place> {
  const pool: Pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, [...pathDocs, ...pathPublicDocs]));
  await importTables(pool, pathSchema, pathSeed);
  const types = () => [
    ...pathDocs.map((def) => docTypeFromDef<Me>(def, pool, { auth, shared: true })),
    ...pathPublicDocs.map((def) => docTypeFromDef<Me>(def, pool, { auth, owns: pubOwns })),
  ];
  const custom = [{ ...postgresInbox, shared: true }, { ...postgresMenuCard, shared: true }];
  const { local: l, heard } = hearing();
  const listener = await createDocListener(l.server, pool, { types: types(), ledger: true, auth, custom });
  const reading = createLocal();
  const readerListener = await createDocListener(reading.server, pool, { types: types(), ledger: true, auth, custom });
  // NOTIFY is heard after the commit, and fetched then, by queries queued behind it on the one
  // PGlite: quiet once a round trip through it, and a turn after, brings nothing more
  const quiet = async () => {
    let seen = -1;
    while (seen !== heard.length) {
      seen = heard.length;
      for (let i = 0; i < 3; i++) {
        await pool.query("SELECT 1");
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };
  const reader = { call: (a: string, m: Record<string, unknown>) => reading.as(people[0]!.me).call(a, m), done: async () => {} };
  return {
    name: "pglite", as: (me) => l.as(me), heard, reader: async () => reader, quiet,
    end: async () => { await listener.destroy(); await readerListener.destroy(); await pool.end(); },
  };
}

describe("the law over generated writes (todo #27)", () => {
  for (const seed of lawSeeds) {
    test(`seed ${seed}: ${lawSteps} steps, the same on SQLite, the JSON file and PGlite`, async () => {
      const places = [onSqlite(), onJson(), await onPglite()];
      try { await drive(seed, places); }
      finally { for (const p of places) await p.end(); }
    }, 600_000);
  }
});
