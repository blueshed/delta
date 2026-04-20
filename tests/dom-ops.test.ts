/**
 * Unit tests for applyOpsToCollection — mock-DOM, no browser needed.
 *
 * The helper only touches `Node.appendChild`, `Node.removeChild`, `Node.parentNode`
 * (via `node.parentNode.removeChild(node)`), so we can exercise it with a tiny
 * fake. Real DOM behaviour is covered end-to-end in consumer apps.
 */
import { describe, test, expect } from "bun:test";
import { applyOpsToCollection, type DomCollection } from "../src/client/dom-ops";
import type { DeltaOp } from "../src/core";

interface Row { id: number; name: string; done?: boolean; }

class MockNode {
  children: MockNode[] = [];
  parentNode: MockNode | null = null;
  payload: any = null;  // for assertions

  appendChild(n: MockNode) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  removeChild(n: MockNode) {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  replaceChild(newN: MockNode, oldN: MockNode) {
    const i = this.children.indexOf(oldN);
    if (i >= 0) this.children[i] = newN;
    newN.parentNode = this;
    oldN.parentNode = null;
    return oldN;
  }
}

function makeCollection(updates: string[] = [], removes: string[] = []): DomCollection<Row> {
  return {
    key: (r) => String(r.id),
    create: (r) => {
      const n = new MockNode();
      n.payload = { ...r };
      return n as unknown as Node;
    },
    update: (node, r) => {
      (node as unknown as MockNode).payload = { ...r };
      updates.push(String(r.id));
    },
    remove: (node) => {
      removes.push(String((node as unknown as MockNode).payload?.id));
    },
  };
}

describe("applyOpsToCollection", () => {
  test("add /coll/- appends a node keyed by value.id", () => {
    const parent = new MockNode();
    const col = makeCollection();
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/-", value: { id: 7, name: "write tests" } }],
      col,
    );
    expect(parent.children.length).toBe(1);
    expect((parent.children[0] as MockNode).payload.name).toBe("write tests");
    expect(nodes.has("7")).toBe(true);
  });

  test("replace /coll/id updates in place via col.update", () => {
    const parent = new MockNode();
    const updates: string[] = [];
    const col = makeCollection(updates);
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/-", value: { id: 1, name: "first" } }],
      col,
    );
    const originalNode = nodes.get("1");

    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "replace", path: "/todos/1", value: { id: 1, name: "updated" } }],
      col,
      nodes,
    );

    expect(parent.children.length).toBe(1);
    expect(nodes.get("1")).toBe(originalNode); // same instance, patched
    expect((originalNode as unknown as MockNode).payload.name).toBe("updated");
    expect(updates).toEqual(["1"]);
  });

  test("replace /coll/id with no update hook rebuilds the node", () => {
    const parent = new MockNode();
    const col: DomCollection<Row> = {
      key: (r) => String(r.id),
      create: (r) => {
        const n = new MockNode();
        n.payload = { ...r };
        return n as unknown as Node;
      },
      // no update
    };
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/-", value: { id: 2, name: "old" } }],
      col,
    );
    const firstNode = nodes.get("2");

    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "replace", path: "/todos/2", value: { id: 2, name: "new" } }],
      col,
      nodes,
    );

    expect(parent.children.length).toBe(1);
    expect(nodes.get("2")).not.toBe(firstNode);
    expect((nodes.get("2") as unknown as MockNode).payload.name).toBe("new");
  });

  test("remove /coll/id calls col.remove and drops the node", () => {
    const parent = new MockNode();
    const removes: string[] = [];
    const col = makeCollection([], removes);
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [
        { op: "add", path: "/todos/-", value: { id: 5, name: "doomed" } },
        { op: "add", path: "/todos/-", value: { id: 6, name: "survivor" } },
      ],
      col,
    );
    expect(parent.children.length).toBe(2);

    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "remove", path: "/todos/5" }],
      col,
      nodes,
    );

    expect(parent.children.length).toBe(1);
    expect((parent.children[0] as MockNode).payload.id).toBe(6);
    expect(nodes.has("5")).toBe(false);
    expect(removes).toEqual(["5"]);
  });

  test("ignores ops for other collections", () => {
    const parent = new MockNode();
    const col = makeCollection();
    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [
        { op: "add", path: "/comments/-", value: { id: 1, body: "noise" } },
        { op: "replace", path: "/users/3/name", value: "x" },
      ],
      col,
    );
    expect(parent.children.length).toBe(0);
  });

  test("add /coll/id upserts idempotently (no duplicate on replay)", () => {
    const parent = new MockNode();
    const col = makeCollection();
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/-", value: { id: 9, name: "once" } }],
      col,
    );
    // Replay the same op explicitly as /todos/9
    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/9", value: { id: 9, name: "again" } }],
      col,
      nodes,
    );
    expect(parent.children.length).toBe(1);
  });
});
