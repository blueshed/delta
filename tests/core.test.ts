import { describe, test, expect } from "bun:test";
import { applyOps, type DeltaOp } from "../src/core";

describe("applyOps", () => {
  test("replace a top-level field", () => {
    const doc = { name: "alice" };
    applyOps(doc, [{ op: "replace", path: "/name", value: "bob" }]);
    expect(doc.name).toBe("bob");
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

  test("add at array index", () => {
    const doc = { items: ["a", "b", "c"] };
    applyOps(doc, [{ op: "add", path: "/items/1", value: "x" }]);
    expect(doc.items[1]).toBe("x");
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
});
