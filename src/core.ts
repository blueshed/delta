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
  // Root op: "" and "/" both address the whole document → no reference tokens.
  if (path === "" || path === "/") return [];
  // RFC-6901: a JSON Pointer is "/" + each reference token. Empty middle or
  // trailing tokens are GENUINE keys ("/a//b" → ["a", "", "b"], "/a/" →
  // ["a", ""]), so we must NOT drop them with `.filter(Boolean)`. We slice off
  // the leading "" produced by the first "/" and unescape (~1→/, ~0→~).
  return path
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parsePath(path: string): (string | number)[] {
  return splitPath(path).map((unescaped) => {
    return /^\d+$/.test(unescaped) ? Number(unescaped) : unescaped;
  });
}

/**
 * Reference tokens that reach an object's prototype rather than its own data.
 *
 * Op paths and values are client-supplied on every backend — the JSON-file
 * backend applies them with no schema validation at all and then echoes them
 * verbatim to every subscriber, so one client could poison the server process
 * AND every other connected browser. The guard lives here, in the one module
 * all three backends and the browser client share, so none of them can forget
 * it. (SQLite/Postgres also reject `/__proto__/…` incidentally, as an unknown
 * collection — that is a side effect of their schema check, not a defence.)
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafePath(segments: (string | number)[], path: string): void {
  for (const seg of segments) {
    if (typeof seg === "string" && UNSAFE_KEYS.has(seg)) {
      throw new Error(`Unsafe path segment "${seg}" in "${path}"`);
    }
  }
}

/**
 * `Object.assign` honours an own `__proto__` key by invoking the prototype
 * setter, so a root replace whose value carried one re-pointed the document's
 * prototype. Copy own keys explicitly and skip the dangerous ones. Nested
 * values are assigned wholesale rather than merged, so they stay inert data.
 */
function safeAssign(target: any, source: Record<string, unknown>): void {
  for (const k of Object.keys(source)) {
    if (UNSAFE_KEYS.has(k)) continue;
    target[k] = source[k];
  }
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
    assertSafePath(segments, op.path);
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
        safeAssign(doc, op.value as Record<string, unknown>);
      } else {
        throw new Error("root replace requires a matching container (object↔object / array↔array)");
      }
      continue;
    }
    const { parent, key } = walk(doc, segments);
    switch (op.op) {
      case "replace":
      case "add":
        // NOTE: `add` to an array INDEX (e.g. "/items/1") is an OVERWRITE
        // (plain assignment), NOT an RFC-6902 splice-insert. The framework
        // keys collections by id-maps, so insert-by-index is rarely hit;
        // changing this to splice could regress those callers. Array append
        // uses "/-" (handled below); RFC-6902 index insertion is intentionally
        // unsupported.
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
