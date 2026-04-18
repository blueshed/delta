/**
 * Unit tests for the delta-postgres schema utilities (pure — no DB needed).
 *   - defineSchema: resolves columns, parents, children, referencedBy.
 *   - defineDoc:    returns a normalised DocDef.
 *   - validateOps:  catches path/field/collection errors pre-database.
 */
import { describe, test, expect } from "bun:test";
import {
  defineSchema,
  defineDoc,
  validateOps,
} from "../src/server/postgres";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");

// ---------------------------------------------------------------------------
// defineSchema
// ---------------------------------------------------------------------------

describe("defineSchema", () => {
  test("resolves shorthand column types", () => {
    const schema = defineSchema({
      items: {
        columns: { name: "text", count: "integer", note: "text?" },
      },
    });
    const cols = schema.tables.items!.columns;
    expect(cols.name).toEqual({ type: "text", nullable: false });
    expect(cols.count).toEqual({ type: "integer", nullable: false });
    expect(cols.note).toEqual({ type: "text", nullable: true });
  });

  test("passes through object column defs", () => {
    const schema = defineSchema({
      items: {
        columns: { kind: { type: "text", nullable: true, default: "plain" } },
      },
    });
    expect(schema.tables.items!.columns.kind).toEqual({
      type: "text",
      nullable: true,
      default: "plain",
    });
  });

  test("resolves parent relationships (string form)", () => {
    const schema = defineSchema({
      items: { columns: { name: "text" } },
      comments: { columns: { body: "text" }, parent: "items" },
    });
    expect(schema.tables.comments!.parent).toEqual({
      collection: "items",
      fkColumn: "items_id",
    });
    expect(schema.tables.items!.children).toEqual(["comments"]);
  });

  test("resolves parent relationships (object form with custom fk)", () => {
    const schema = defineSchema({
      venues: { columns: { name: "text" } },
      sites: {
        columns: { name: "text", venue_id: "integer" },
        parent: { collection: "venues", fk: "venue_id" },
      },
    });
    expect(schema.tables.sites!.parent).toEqual({
      collection: "venues",
      fkColumn: "venue_id",
    });
  });

  test("cascadeOn populates referencedBy on the target", () => {
    const schema = defineSchema({
      users: { columns: { name: "text" } },
      posts: {
        columns: { body: "text", user_id: "integer" },
        cascadeOn: ["user_id"],
      },
    });
    expect(schema.tables.users!.referencedBy).toEqual([
      { collection: "posts", fkColumn: "user_id" },
    ]);
  });

  test("temporal defaults to true unless explicitly false", () => {
    const schema = defineSchema({
      a: { columns: { x: "text" } },
      b: { columns: { x: "text" }, temporal: false },
    });
    expect(schema.tables.a!.temporal).toBe(true);
    expect(schema.tables.b!.temporal).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// defineDoc
// ---------------------------------------------------------------------------

describe("defineDoc", () => {
  test("returns prefix, root, include, scope with defaults", () => {
    const def = defineDoc("items:", { root: "items", include: [] });
    expect(def.prefix).toBe("items:");
    expect(def.root).toBe("items");
    expect(def.include).toEqual([]);
    expect(def.scope).toEqual({});
  });

  test("retains supplied scope map", () => {
    const def = defineDoc("post:", {
      root: "posts",
      include: ["comments"],
      scope: { "posts.id": "id", "comments.post_id": "id" },
    });
    expect(def.scope).toEqual({
      "posts.id": "id",
      "comments.post_id": "id",
    });
  });
});

// ---------------------------------------------------------------------------
// validateOps — catches structural issues before they reach the database.
// ---------------------------------------------------------------------------

describe("validateOps", () => {
  const schema = defineSchema({
    items: {
      columns: {
        name: "text",
        value: "integer",
        note: "text?",
        meta: "json",
      },
    },
  });
  const def = defineDoc("items:", { root: "items", include: [] });

  test("valid add returns no errors", () => {
    const errs = validateOps(schema, def, [
      { op: "add", path: "/items/-", value: { name: "a", value: 1, meta: {} } },
    ]);
    expect(errs).toEqual([]);
  });

  test("empty path is an error", () => {
    const errs = validateOps(schema, def, [
      { op: "replace", path: "/", value: {} },
    ]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toMatch(/Empty path/);
  });

  test("unknown collection is an error", () => {
    const errs = validateOps(schema, def, [
      { op: "add", path: "/ghosts/-", value: { name: "boo" } },
    ]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toMatch(/Unknown collection/);
  });

  test("add missing required json field → error", () => {
    // `meta` is json (defaultForType → null), non-nullable, no default → required.
    // `name` (text → "") and `value` (integer → 0) have type defaults so aren't required.
    const errs = validateOps(schema, def, [
      { op: "add", path: "/items/-", value: { name: "a", value: 1 } },
    ]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]!.message).toMatch(/Required field missing: meta/);
  });

  test("add with non-object value is an error", () => {
    const errs = validateOps(schema, def, [
      { op: "add", path: "/items/-", value: 42 as any },
    ]);
    expect(errs[0]!.message).toMatch(/Add value must be an object/);
  });

  test("replace of an unknown field → error", () => {
    const errs = validateOps(schema, def, [
      { op: "replace", path: "/items/3/nope", value: 1 },
    ]);
    expect(errs[0]!.message).toMatch(/Unknown field: nope/);
  });

  test("replace of a known field is accepted", () => {
    const errs = validateOps(schema, def, [
      { op: "replace", path: "/items/3/name", value: "new" },
    ]);
    expect(errs).toEqual([]);
  });
});
