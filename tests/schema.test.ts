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

  test("unknown field in an add value → error", () => {
    const errs = validateOps(schema, def, [
      { op: "add", path: "/items/-", value: { name: "a", value: 1, meta: {}, bogus: 9 } },
    ]);
    expect(errs.some((e) => /Unknown field: bogus/.test(e.message))).toBe(true);
  });

  test("unknown field in a whole-row replace value → error", () => {
    const errs = validateOps(schema, def, [
      { op: "replace", path: "/items/3", value: { name: "a", bogus: 1 } },
    ]);
    expect(errs.some((e) => /Unknown field: bogus/.test(e.message))).toBe(true);
  });

  test("whole-row replace with only known fields is accepted", () => {
    const errs = validateOps(schema, def, [
      { op: "replace", path: "/items/3", value: { name: "a", value: 1 } },
    ]);
    expect(errs).toEqual([]);
  });

  test("id and parent fk column are allowed keys in whole-row writes", () => {
    const childSchema = defineSchema({
      lists: { columns: { title: "text" } },
      cards: {
        columns: { body: "text" },
        parent: "lists",
      },
    });
    const childDef = defineDoc("list:", { root: "lists", include: ["cards"] });
    // `cards` has parent `lists` → fk column `lists_id`; `id` is implicit.
    const errs = validateOps(childSchema, childDef, [
      { op: "add", path: "/cards/-", value: { id: 7, lists_id: 1, body: "hi" } },
    ]);
    expect(errs).toEqual([]);
  });

  test("handles JSON Pointer escape sequences (~1 and ~0) in paths", () => {
    const customSchema = defineSchema({
      items: {
        columns: {
          name: "text",
          "c/d": "text",
          "e~f": "text",
        },
      },
    });
    const errs = validateOps(customSchema, def, [
      { op: "replace", path: "/items/t~11/c~1d", value: "ok" },
      { op: "replace", path: "/items/t~11/e~0f", value: "ok" },
    ]);
    expect(errs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Identifier validation — illegal names fail fast (defence-in-depth).
// ---------------------------------------------------------------------------

describe("identifier validation", () => {
  test("rejects a schema key with a single quote", () => {
    expect(() =>
      defineSchema({ "bad'name": { columns: { a: "text" } } }),
    ).toThrow(/schema key/);
  });

  test("rejects an explicit table name with a double quote", () => {
    expect(() =>
      defineSchema({ items: { table: 'ev"il', columns: { a: "text" } } }),
    ).toThrow(/table name/);
  });

  test("rejects a column name containing a quote or whitespace", () => {
    expect(() =>
      defineSchema({ items: { columns: { "a'b": "text" } } }),
    ).toThrow(/column name/);
    expect(() =>
      defineSchema({ items: { columns: { "a b": "text" } } }),
    ).toThrow(/column name/);
  });

  test("allows JSON-Pointer-ish column names (slash, tilde)", () => {
    expect(() =>
      defineSchema({ items: { columns: { "c/d": "text", "e~f": "text" } } }),
    ).not.toThrow();
  });

  test("rejects a doc prefix or root with illegal characters", () => {
    expect(() =>
      defineDoc("bad prefix", { root: "items", include: [] }),
    ).toThrow(/doc prefix/);
    expect(() =>
      defineDoc("items:", { root: 'ev"il', include: [] }),
    ).toThrow(/doc root/);
  });

  test("accepts the conventional prefix shapes (items:, venue:)", () => {
    expect(() =>
      defineDoc("items:", { root: "items", include: [] }),
    ).not.toThrow();
    expect(() =>
      defineDoc("venue:", { root: "venues", include: [] }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// InferDoc / InferRow — compile-time row inference from the schema literal.
// These assertions are enforced by `bun run check` (tsc): a drift between the
// runtime schema vocabulary and the type-level inference fails the typecheck.
// ---------------------------------------------------------------------------

import type { InferDoc, InferRow, TableDef } from "../src/server/postgres";

describe("InferDoc / InferRow (compile-time)", () => {
  const s = defineSchema({
    venues: { columns: { name: "text", capacity: "integer?", meta: "json?" } },
    areas: { columns: { label: "text", open: "boolean" }, parent: "venues" },
    slots: { columns: { at: "timestamptz" }, parent: { collection: "areas", fk: "area" } },
  });

  test("single-mode doc: root row + included id-keyed maps", () => {
    type VenueDoc = InferDoc<typeof s, "venues", "areas", "single">;
    const doc: VenueDoc = {
      venues: { id: 1, name: "Hall", capacity: null, meta: { tags: ["a"] } },
      areas: { "10": { id: 10, venues_id: 1, label: "Stage", open: true } },
    };
    expect(doc.venues.name).toBe("Hall");
    expect(doc.areas["10"]!.open).toBe(true);
  });

  test("list-mode doc (the default): root is an id-keyed map", () => {
    type VenuesDoc = InferDoc<typeof s, "venues">;
    const doc: VenuesDoc = {
      venues: { "1": { id: 1, name: "Hall", capacity: 3, meta: null } },
    };
    expect(doc.venues["1"]!.capacity).toBe(3);
  });

  test("explicit parent fk and full ColumnDef objects infer too", () => {
    type Slot = InferRow<{ columns: { at: "timestamptz" }; parent: { collection: "areas"; fk: "area" } }>;
    const slot: Slot = { id: 5, area: 10, at: "2026-06-10T00:00:00Z" };
    expect(slot.area).toBe(10);

    type WithDef = InferRow<{ columns: { score: { type: "real"; nullable: true } } } & TableDef>;
    const row: WithDef = { id: 1, score: null };
    expect(row.score).toBeNull();
  });
});
