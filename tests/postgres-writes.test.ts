/**
 * The write cases (`src/cases/writes.ts`) on a Postgres server, and what only
 * its framework SQL has to answer. Requires a live database on $DELTA_TEST_PG_URL.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Pool } from "pg";
import { applySql, generateSql, importTables } from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";
import { createRowCases, errorCodeCases, tenantsApp, writeScopeCases } from "@blueshed/delta/testing";
import { onPostgres } from "./helpers/case-backends";
import { applyFramework, newPool } from "./setup";

setLogLevel("silent");

describe("Postgres", () => {
  errorCodeCases(onPostgres);
  createRowCases(onPostgres);
  writeScopeCases(onPostgres);
});

describe("_delta_cascade_remove", () => {
  let pool: Pool;
  const tables = Object.values(tenantsApp.schema.tables).map((t) => t.name);
  const drop = async () => {
    await pool.query(`DROP TABLE IF EXISTS ${tables.join(", ")} CASCADE`);
    await pool.query(`DROP SEQUENCE IF EXISTS ${tables.map((t) => `seq_${t}`).join(", ")}`);
    await pool.query("DELETE FROM _delta_collections WHERE table_name = ANY($1)", [tables]);
    await pool.query("DELETE FROM _delta_docs WHERE prefix = ANY($1)", [tenantsApp.docs.map((d) => d.prefix)]);
  };
  beforeAll(async () => {
    pool = await newPool();
    await applyFramework(pool);
    await drop();
    await applySql(pool, generateSql(tenantsApp.schema, tenantsApp.docs));
    await importTables(pool, tenantsApp.schema, tenantsApp.seed);
  });
  afterAll(async () => { await drop(); await pool.end(); });

  test("reports only rows it actually removed", async () => {
    // Close the row out of band, then ask the cascade to remove it. Nothing is
    // affected, so it must emit NO ops: broadcasting a removal that didn't
    // happen would tell every subscriber to drop a row still in the table.
    // (This is also what an RLS policy filtering the DELETE to zero rows looks
    // like from inside the function.)
    await pool.query("DELETE FROM case_notes WHERE id = 100");
    const { rows } = await pool.query("SELECT _delta_cascade_remove('notes', 100) AS ops");
    expect(rows[0].ops).toEqual([]);
  });
});
