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

export function splitPath(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parsePath(path: string): (string | number)[] {
  return splitPath(path).map((unescaped) => {
    return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
  });
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
    // Root op (empty path "" or "/"): replace/clear the WHOLE doc IN PLACE. The value
    // reference is fixed — the server's doc tracking and the client both hold `doc` by
    // reference and notify on mutation (the client bumps dataVersion after applyOps) — so
    // we mutate the container rather than reassign. Enables a whole-doc refresh for
    // evaluator-backed docs (e.g. a recomputed custom read) without a fragile nested diff.
    if (segments.length === 0) {
      if (op.op === "remove") {
        if (Array.isArray(doc)) doc.length = 0;
        else for (const k of Object.keys(doc)) delete doc[k];
      } else if (Array.isArray(doc) && Array.isArray(op.value)) {
        doc.length = 0;
        (doc as unknown[]).push(...(op.value as unknown[]));
      } else if (!Array.isArray(doc) && op.value && typeof op.value === "object") {
        for (const k of Object.keys(doc)) delete doc[k];
        Object.assign(doc, op.value as Record<string, unknown>);
      } else {
        throw new Error("root replace requires a matching container (object↔object / array↔array)");
      }
      continue;
    }
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
