/**
 * Unit tests for the SQL codegen — pure, no DB.
 *
 * Also drives an integration round-trip in postgres.test.ts where the generated
 * SQL is fed to a real Postgres and used to open/apply a doc.
 */
import { describe, test, expect } from "bun:test";
import { defineSchema, defineDoc, generateSql } from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

describe("generateSql", () => {
  test("emits sequence, table, and metadata inserts for a flat schema", () => {
    const schema = defineSchema({
      todos: {
        columns: {
          owner_id: "integer",
          text: "text",
          done: { type: "boolean", default: false },
        },
        temporal: false,
      },
    });
    const docs = [
      defineDoc("todos:", { root: "todos", include: [], scope: { owner_id: ":id" } }),
    ];

    const sql = generateSql(schema, docs);

    // Table + sequence
    expect(sql).toContain('CREATE SEQUENCE IF NOT EXISTS "seq_todos"');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "todos"');
    expect(sql).toContain("nextval('seq_todos')");
    expect(sql).toContain('"owner_id" BIGINT NOT NULL');
    expect(sql).toContain('"text" TEXT NOT NULL');
    expect(sql).toContain('"done" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sql).toContain("PRIMARY KEY (id)");

    // Non-temporal → no current_* view, no valid_from
    expect(sql).not.toContain("current_todos");
    expect(sql).not.toContain("valid_from");

    // Collection registration
    expect(sql).toContain("INSERT INTO _delta_collections");
    expect(sql).toContain("'todos'");

    // Doc registration
    expect(sql).toContain("INSERT INTO _delta_docs");
    expect(sql).toContain("'todos:'");
    expect(sql).toMatch(/INSERT INTO _delta_docs[\s\S]+?"owner_id":":id"/);
  });

  test("adds current_* view and valid_from/valid_to for temporal tables", () => {
    const schema = defineSchema({
      areas: {
        columns: { name: "text" },
      },
    });
    const sql = generateSql(schema, []);

    expect(sql).toContain("valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(sql).toContain("valid_to TIMESTAMPTZ");
    expect(sql).toContain("PRIMARY KEY (id, valid_from)");
    expect(sql).toContain('CREATE OR REPLACE VIEW "current_areas"');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_areas_id_valid"');
  });

  test("parent relationship adds fk column and index", () => {
    const schema = defineSchema({
      venues: { columns: { name: "text" }, temporal: false },
      sites: {
        columns: { name: "text" },
        parent: "venues",
        temporal: false,
      },
    });
    const sql = generateSql(schema, []);

    expect(sql).toContain('"venues_id" BIGINT NOT NULL');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "idx_sites_venues_id" ON "sites"');
  });

  test("cascadeOn surfaces in the parent collection's cascade_on array", () => {
    const schema = defineSchema({
      users: { columns: { name: "text" }, temporal: false },
      posts: {
        columns: { body: "text", user_id: "integer" },
        cascadeOn: ["user_id"],
        temporal: false,
      },
    });
    const sql = generateSql(schema, []);

    // users.cascade_on contains {"fk":"user_id","collection":"posts"}
    expect(sql).toMatch(
      /INSERT INTO _delta_collections[\s\S]+?'users'[\s\S]+?"fk":"user_id"/,
    );
  });

  test("custom header / regenerate hint are honoured", () => {
    const sql = generateSql(defineSchema({ x: { columns: { a: "text" } } }), [], {
      header: "CUSTOM HEADER",
      regenerate: "make sql",
    });
    expect(sql).toContain("-- CUSTOM HEADER");
    expect(sql).toContain("-- Regenerate: make sql");
  });
});
