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

  test("root replace ('' path) reconciles the keyed nodes against the snapshot", () => {
    const parent = new MockNode();
    const updates: string[] = [];
    const removes: string[] = [];
    const col = makeCollection(updates, removes);

    // Build an initial set: rows 1, 2, 3.
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [
        { op: "add", path: "/todos/-", value: { id: 1, name: "one" } },
        { op: "add", path: "/todos/-", value: { id: 2, name: "two" } },
        { op: "add", path: "/todos/-", value: { id: 3, name: "three" } },
      ],
      col,
    );
    expect(parent.children.length).toBe(3);
    const node2 = nodes.get("2");

    // Reconnect snapshot: row 1 dropped, row 2 unchanged-shape (updated in
    // place), row 3 changed, row 4 new.
    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [
        {
          op: "replace",
          path: "",
          value: {
            todos: {
              "2": { id: 2, name: "two" },
              "3": { id: 3, name: "three-edited" },
              "4": { id: 4, name: "four" },
            },
          },
        },
      ],
      col,
      nodes,
    );

    // Row 1 removed; 2,3,4 present.
    expect(removes).toContain("1");
    expect(nodes.has("1")).toBe(false);
    expect(nodes.has("2")).toBe(true);
    expect(nodes.has("3")).toBe(true);
    expect(nodes.has("4")).toBe(true);
    expect(parent.children.length).toBe(3);

    // Existing node 2 preserved (not churned) — updated in place via col.update.
    expect(nodes.get("2")).toBe(node2);
    expect((nodes.get("3") as unknown as MockNode).payload.name).toBe("three-edited");
    expect((nodes.get("4") as unknown as MockNode).payload.name).toBe("four");
  });

  test("root replace with missing collection key clears all nodes", () => {
    const parent = new MockNode();
    const removes: string[] = [];
    const col = makeCollection([], removes);
    const nodes = applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "add", path: "/todos/-", value: { id: 1, name: "one" } }],
      col,
    );
    expect(parent.children.length).toBe(1);

    // Snapshot has no `todos` key → treat as empty set → remove everything.
    applyOpsToCollection<Row>(
      parent as unknown as Node,
      "todos",
      [{ op: "replace", path: "", value: { other: {} } }],
      col,
      nodes,
    );
    expect(parent.children.length).toBe(0);
    expect(nodes.size).toBe(0);
    expect(removes).toEqual(["1"]);
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

// ---------------------------------------------------------------------------
// The default `nodes` map must PERSIST across calls.
//
// It used to default to a fresh `new Map()` per call, which silently broke
// every 4-argument caller — including the canonical recipe in SKILL.md,
// README.md and examples/shared-state. With an empty map each time, `remove`
// found no node to detach, and the reconnect root-replace missed every row and
// re-created + re-appended the whole collection. A chat log duplicated itself
// on every reconnect. These tests drive the 4-arg form the docs actually show.
// ---------------------------------------------------------------------------

describe("default node map persistence", () => {
  const rows = (...ids: number[]) =>
    Object.fromEntries(ids.map((id) => [String(id), { id, name: `r${id}` }]));
  const rootReplace = (value: any): DeltaOp[] => [{ op: "replace", path: "", value }];

  test("4-arg form: repeated reconnect reconciles do not duplicate nodes", () => {
    const parent = new MockNode();
    const col = makeCollection();
    const snapshot = { todos: rows(1, 2, 3) };

    // Initial paint through the same path the recipe now uses.
    applyOpsToCollection<Row>(parent as unknown as Node, "todos", rootReplace(snapshot), col);
    expect(parent.children.length).toBe(3);

    // Two reconnects. Each emits a synthetic whole-doc replace.
    applyOpsToCollection<Row>(parent as unknown as Node, "todos", rootReplace(snapshot), col);
    applyOpsToCollection<Row>(parent as unknown as Node, "todos", rootReplace(snapshot), col);
    expect(parent.children.length).toBe(3);
  });

  test("4-arg form: remove detaches the node added by an earlier call", () => {
    const parent = new MockNode();
    const removes: string[] = [];
    const col = makeCollection([], removes);

    applyOpsToCollection<Row>(parent as unknown as Node, "todos",
      [{ op: "add", path: "/todos/-", value: { id: 7, name: "seven" } }], col);
    expect(parent.children.length).toBe(1);

    applyOpsToCollection<Row>(parent as unknown as Node, "todos",
      [{ op: "remove", path: "/todos/7" }], col);
    expect(parent.children.length).toBe(0);
    expect(removes).toEqual(["7"]);
  });

  test("4-arg form: a reconnect after live ops keeps the true set", () => {
    const parent = new MockNode();
    const col = makeCollection();

    applyOpsToCollection<Row>(parent as unknown as Node, "todos",
      rootReplace({ todos: rows(1, 2) }), col);
    applyOpsToCollection<Row>(parent as unknown as Node, "todos",
      [{ op: "add", path: "/todos/3", value: { id: 3, name: "r3" } }], col);
    expect(parent.children.length).toBe(3);

    // Server dropped 1 while we were offline; reconnect snapshot is {2,3}.
    applyOpsToCollection<Row>(parent as unknown as Node, "todos",
      rootReplace({ todos: rows(2, 3) }), col);
    expect(parent.children.length).toBe(2);
    expect(parent.children.map((c) => c.payload.id).sort()).toEqual([2, 3]);
  });

  test("default maps are isolated per parent and per collection", () => {
    const a = new MockNode();
    const b = new MockNode();
    const col = makeCollection();

    applyOpsToCollection<Row>(a as unknown as Node, "todos", rootReplace({ todos: rows(1) }), col);
    applyOpsToCollection<Row>(b as unknown as Node, "todos", rootReplace({ todos: rows(1) }), col);
    // Same id, different parents — each keeps its own node.
    expect(a.children.length).toBe(1);
    expect(b.children.length).toBe(1);

    // A second collection under the SAME parent must not clobber the first.
    applyOpsToCollection<Row>(a as unknown as Node, "notes", rootReplace({ notes: rows(1) }), col);
    expect(a.children.length).toBe(2);
    applyOpsToCollection<Row>(a as unknown as Node, "notes", rootReplace({ notes: rows(1) }), col);
    expect(a.children.length).toBe(2);
  });

  test("an explicitly passed map is used and returned (reference.md form)", () => {
    const parent = new MockNode();
    const col = makeCollection();
    const mine = new Map<string, Node>();

    const returned = applyOpsToCollection<Row>(
      parent as unknown as Node, "todos", rootReplace({ todos: rows(1, 2) }), col, mine,
    );
    expect(returned).toBe(mine);
    expect([...mine.keys()].sort()).toEqual(["1", "2"]);

    // Threading the same map through every call is equally stable — this is the
    // long-hand the manual documents, for callers that need to seed or inspect it.
    applyOpsToCollection<Row>(parent as unknown as Node, "todos", rootReplace({ todos: rows(1, 2) }), col, mine);
    expect(parent.children.length).toBe(2);
  });
});
