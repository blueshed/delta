/**
 * One walk rule, two planners: `planWalk` (src/server/ledger.ts, SQLite and the
 * JSON file) and `_delta_walk_plan` (001g, Postgres) asked the same vectors
 * (`walkVectors`, src/walk-vectors.json), as tests/postgres-pointer.test.ts
 * asks the two pointer parsers. Postgres runs in process (PGlite): the same
 * stored functions as a server, no database to start.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Pool } from "pg";
import { joinPath, splitPath } from "../src/core";
import { planWalk } from "../src/server/ledger";
import { applyFramework, applySql, defineDoc, defineSchema, generateSql } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { walkVectors, type WalkVector } from "../src/testing";

const { schema, docs, vectors } = walkVectors;
const children = Object.entries(schema).filter(([, t]) => typeof t.parent === "string");

/** The rows removing `key` would take with it: its children in the document, and theirs. */
const under = (current: any) => (key: string): string[] => {
  const [coll, id] = splitPath(key);
  return children.filter(([, t]) => t.parent === coll).flatMap(([child]) =>
    Object.values<any>(current[child] ?? {}).filter((r) => String(r[`${coll}_id`]) === id).flatMap((r) => {
      const at = joinPath(child, String(r.id));
      return [at, ...under(current)(at)];
    }));
};

/** A collection's rows as the document holds them: a single document's root is one row, else a map. */
const rowsOf = (held: any): any[] => (held == null ? [] : typeof held.id === "number" ? [held] : Object.values(held));

let pool: Pool;

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(defineSchema(schema), Object.entries(docs).map(([prefix, d]) => defineDoc(prefix, d))));
});

afterAll(async () => {
  await pool.end();
});

/** `_delta_walk_plan` of the vector's entry, over tables that hold its `current`. */
async function plpgsql(v: WalkVector) {
  await pool.query(`TRUNCATE ${Object.keys(schema).join(", ")}, _delta_ledger RESTART IDENTITY CASCADE`);
  for (const coll of Object.keys(schema)) {   // parents first: the schema lists them first
    for (const row of rowsOf(v.current[coll])) {
      const cols = Object.keys(row);
      await pool.query(`INSERT INTO ${coll} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((c) => row[c]));
    }
  }
  // the vector's current is the document as Postgres holds it (its version aside)
  const { _version, ...held } = (await pool.query("SELECT _delta_open_held($1) AS doc", [v.doc])).rows[0].doc;
  expect(held).toEqual(v.current);
  const { rows: [{ id }] } = await pool.query(
    "INSERT INTO _delta_ledger (doc_name, version, ops, inverse) VALUES ($1, 1, $2, $3) RETURNING id",
    [v.doc, JSON.stringify(v.entry.ops), JSON.stringify(v.entry.inverse)],
  );
  const { plan } = (await pool.query("SELECT _delta_walk_plan(l) AS plan FROM _delta_ledger l WHERE id = $1", [id])).rows[0];
  return { ops: plan.ops, ...(plan.conflict ? { conflict: plan.conflict } : {}) };
}

const core = (v: WalkVector) => {
  const plan = planWalk(v.entry, v.current, under(v.current));
  return { ops: plan.ops, ...(plan.conflict.length ? { conflict: plan.conflict } : {}) };
};

describe("one walk rule", () => {
  for (const v of vectors) {
    test(`${v.name}: in planWalk and in plpgsql`, async () => {
      expect(core(v)).toEqual(v.expected);
      expect(await plpgsql(v)).toEqual(v.expected);
    });
  }
});
