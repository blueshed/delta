/**
 * Delta — shared types and operations for JSON document patching.
 *
 * Used by both delta-server (apply + persist) and delta-client (apply + render).
 * No dependencies — safe to import anywhere.
 *
 * Delta ops use JSON Pointer paths (`/`-separated, numeric for array index, `-` for append):
 *   { op: "replace", path: "/field",    value: "new" }  — set a value at path
 *   { op: "add",     path: "/items/-",  value: item }   — append to array
 *   { op: "remove",  path: "/items/0" }                  — delete by index
 *
 * Multiple ops applied via applyOps() are atomic in memory.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeltaOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function parsePath(path: string): (string | number)[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

function walk(
  obj: any,
  segments: (string | number)[],
): { parent: any; key: string | number } {
  let current = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    current = current[segments[i]!];
    if (current == null)
      throw new Error(`Path not found at segment ${segments[i]}`);
  }
  return { parent: current, key: segments[segments.length - 1]! };
}

/** Apply delta ops to a document in place. */
export function applyOps(doc: any, ops: DeltaOp[]): void {
  for (const op of ops) {
    const segments = parsePath(op.path);
    const { parent, key } = walk(doc, segments);
    switch (op.op) {
      case "replace":
      case "add":
        if (Array.isArray(parent) && key === "-") parent.push(op.value);
        else parent[key] = op.value;
        break;
      case "remove":
        if (Array.isArray(parent) && typeof key === "number")
          parent.splice(key, 1);
        else delete parent[key];
        break;
    }
  }
}
