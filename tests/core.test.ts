import { describe, test, expect } from "bun:test";
import { applyOps, type DeltaOp } from "../src/core";

describe("applyOps", () => {
  test("replace a top-level field", () => {
    const doc = { name: "alice" };
    applyOps(doc, [{ op: "replace", path: "/name", value: "bob" }]);
    expect(doc.name).toBe("bob");
  });

  test("root replace ('' path) swaps the whole object in place", () => {
    const doc: any = { a: 1, b: 2 };
    applyOps(doc, [{ op: "replace", path: "", value: { x: 9 } }]);
    expect(doc).toEqual({ x: 9 }); // same reference, new contents — the in-place whole-doc refresh
  });

  test("root replace ('/' path) swaps an array doc in place", () => {
    const doc: any[] = [1, 2, 3];
    applyOps(doc, [{ op: "replace", path: "/", value: [9] }]);
    expect(doc).toEqual([9]);
  });

  test("root remove clears the doc in place", () => {
    const doc: any = { a: 1 };
    applyOps(doc, [{ op: "remove", path: "" }]);
    expect(doc).toEqual({});
  });

  test("replace a nested field", () => {
    const doc = { user: { name: "alice", age: 30 } };
    applyOps(doc, [{ op: "replace", path: "/user/name", value: "bob" }]);
    expect(doc.user.name).toBe("bob");
    expect(doc.user.age).toBe(30);
  });

  test("add a new field", () => {
    const doc: any = { name: "alice" };
    applyOps(doc, [{ op: "add", path: "/email", value: "a@b.c" }]);
    expect(doc.email).toBe("a@b.c");
  });

  test("add appends to array with -", () => {
    const doc = { items: [1, 2] };
    applyOps(doc, [{ op: "add", path: "/items/-", value: 3 }]);
    expect(doc.items).toEqual([1, 2, 3]);
  });

  test("add at array index OVERWRITES (not an RFC-6902 insert)", () => {
    const doc = { items: ["a", "b", "c"] };
    applyOps(doc, [{ op: "add", path: "/items/1", value: "x" }]);
    // Assignment semantics: "b" is replaced, length is unchanged (NOT spliced).
    expect(doc.items[1]).toBe("x");
    expect(doc.items).toEqual(["a", "x", "c"]);
    expect(doc.items.length).toBe(3);
  });

  test("remove a field", () => {
    const doc: any = { name: "alice", age: 30 };
    applyOps(doc, [{ op: "remove", path: "/age" }]);
    expect(doc.age).toBeUndefined();
    expect(doc.name).toBe("alice");
  });

  test("remove from array by index", () => {
    const doc = { items: ["a", "b", "c"] };
    applyOps(doc, [{ op: "remove", path: "/items/1" }]);
    expect(doc.items).toEqual(["a", "c"]);
  });

  test("multiple ops applied atomically", () => {
    const doc = { count: 0, items: ["old"] };
    applyOps(doc, [
      { op: "replace", path: "/count", value: 1 },
      { op: "add", path: "/items/-", value: "new" },
      { op: "remove", path: "/items/0" },
    ]);
    expect(doc.count).toBe(1);
    expect(doc.items).toEqual(["new"]);
  });

  test("throws on invalid path", () => {
    const doc = { a: 1 };
    expect(() =>
      applyOps(doc, [{ op: "replace", path: "/no/such/path", value: 1 }]),
    ).toThrow();
  });

  test("unescapes JSON Pointer escape sequences (~1 and ~0)", () => {
    const doc: any = {
      "a/b": { "c~d": "original" },
    };
    applyOps(doc, [{ op: "replace", path: "/a~1b/c~0d", value: "updated" }]);
    expect(doc["a/b"]["c~d"]).toBe("updated");
  });

  test("preserves empty reference tokens (RFC-6901 empty keys)", () => {
    // "/a//b" → ["a", "", "b"]: the empty middle token is a genuine key, not
    // dropped. (Regression for the old `.filter(Boolean)` in splitPath.)
    const doc: any = { a: { "": { b: "original" } } };
    applyOps(doc, [{ op: "replace", path: "/a//b", value: "updated" }]);
    expect(doc.a[""].b).toBe("updated");
  });

  test("preserves a trailing empty reference token", () => {
    // "/a/" → ["a", ""]: trailing empty key is preserved.
    const doc: any = { a: { "": "original" } };
    applyOps(doc, [{ op: "replace", path: "/a/", value: "updated" }]);
    expect(doc.a[""]).toBe("updated");
  });
});
