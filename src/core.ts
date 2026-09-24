/**
 * Delta — shared types and operations for JSON document patching.
 *
 * Used by every backend (apply + persist) and by the client (apply + render).
 * No dependencies — safe to import anywhere.
 *
 * Delta ops use RFC 6901 JSON Pointer paths:
 *   { op: "replace", path: "/field",    value: "new" }  — set a value at path
 *   { op: "add",     path: "/items/-",  value: item }   — append to an array
 *   { op: "remove",  path: "/items/0" }                  — delete by index
 *
 * The grammar, the same in `splitPath`, `applyOps` and the Postgres
 * `_delta_split_path`:
 *   - `""` is the whole document; every other path starts with `/`.
 *   - A segment escapes `~` as `~0` and `/` as `~1`; any other `~` is an error.
 *   - A segment is a member name, a string, unless its parent is an array:
 *     `/items/007` keys `"007"` in an object, and is an error in an array,
 *     where an index is `0` or `[1-9][0-9]*` and `-` (add only) appends.
 *
 * `applyOps` applies a batch whole or not at all: an op that throws undoes the
 * ops before it, in place, and the error is rethrown. Its errors carry a wire
 * `code`: 400 for a malformed or unsafe path, 404 for one that is not there.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeltaOp =
  | { op: "replace"; path: string; value: unknown }
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string };

/** An Error with the wire code a backend answers it with. */
function fail(code: 400 | 404, message: string): never {
  throw Object.assign(new Error(message), { code });
}

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------

/** The unescaped segments of a JSON Pointer: `""` → `[]`, `"/a~1b/c"` → `["a/b", "c"]`. Throws on a malformed pointer. */
export function splitPath(path: string): string[] {
  if (path === "") return [];
  if (typeof path !== "string" || !path.startsWith("/")) {
    fail(400, `Invalid JSON Pointer ${JSON.stringify(path)}: a path starts with "/" ("" is the whole document)`);
  }
  if (/~(?![01])/.test(path)) {
    fail(400, `Invalid JSON Pointer ${JSON.stringify(path)}: "~" is written "~0" and "/" is written "~1"`);
  }
  // Empty segments are genuine keys ("/a//b" → ["a", "", "b"]); ~1 before ~0.
  return path.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** One segment escaped for a pointer: `~` → `~0`, then `/` → `~1`. */
export function escapeSegment(segment: string | number): string {
  return String(segment).replace(/~/g, "~0").replace(/\//g, "~1");
}

/** A pointer from its segments, each escaped: `joinPath("messages", "a/b")` → `"/messages/a~1b"`. */
export function joinPath(...segments: (string | number)[]): string {
  return segments.map((s) => `/${escapeSegment(s)}`).join("");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Reference tokens that reach an object's prototype rather than its own data.
 *
 * Op paths and values are client-supplied on every backend — the JSON-file
 * backend applies them with no schema validation at all and then echoes them
 * verbatim to every subscriber, so one client could poison the server process
 * AND every other connected browser. The guard lives here, in the one module
 * every backend and the browser client share, so none of them can forget it.
 */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

/** Fill `doc` in place with `value`'s contents (object↔object, array↔array). */
function fillRoot(doc: any, value: unknown): void {
  if (Array.isArray(doc)) {
    doc.length = 0;
    doc.push(...(value as unknown[]));
  } else {
    for (const k of Object.keys(doc)) delete doc[k];
    safeAssign(doc, value as Record<string, unknown>);
  }
}

const INDEX = /^(0|[1-9][0-9]*)$/;

/** The key `seg` names in `parent`: a string member, or an index where the parent is an array. */
function keyIn(parent: any, seg: string, path: string): string | number {
  if (!Array.isArray(parent)) return seg;
  if (!INDEX.test(seg)) fail(400, `Invalid array index "${seg}" in ${path}`);
  return Number(seg);
}

function applyOne(doc: any, op: DeltaOp, undo: (() => void)[]): void {
  const segments = splitPath(op.path);
  for (const seg of segments) {
    if (UNSAFE_KEYS.has(seg)) fail(400, `Unsafe path segment "${seg}" in "${op.path}"`);
  }

  // Root op (""): replace/clear the WHOLE doc IN PLACE. The value reference is
  // fixed — the server's doc tracking and the client both hold `doc` by
  // reference and notify on mutation — so we mutate the container rather than
  // reassign. Enables a whole-doc refresh for evaluator-backed docs (e.g. a
  // recomputed custom read) without a fragile nested diff.
  if (segments.length === 0) {
    const value = op.op === "remove" ? (Array.isArray(doc) ? [] : {}) : op.value;
    const matches = Array.isArray(doc)
      ? Array.isArray(value)
      : !!value && typeof value === "object" && !Array.isArray(value);
    if (!matches) fail(400, "root replace requires a matching container (object↔object / array↔array)");
    const before = Array.isArray(doc) ? [...doc] : { ...doc };
    undo.push(() => fillRoot(doc, before));
    fillRoot(doc, value);
    return;
  }

  let parent = doc;
  for (let i = 0; i < segments.length - 1; i++) {
    parent = parent[keyIn(parent, segments[i]!, op.path)];
    if (parent === null || typeof parent !== "object") {
      fail(404, `Path not found at segment ${segments[i]} in ${op.path}`);
    }
  }
  const last = segments[segments.length - 1]!;

  if (Array.isArray(parent)) {
    const arr = parent;
    if (op.op === "add" && last === "-") {
      arr.push(op.value);
      undo.push(() => void arr.pop());
      return;
    }
    const i = keyIn(arr, last, op.path) as number;
    if (op.op === "remove") {
      if (i >= arr.length) return;                    // nothing there, as for a missing member
      const [was] = arr.splice(i, 1);
      undo.push(() => void arr.splice(i, 0, was));
      return;
    }
    // `add` at an index OVERWRITES (assignment, not an RFC-6902 splice-insert):
    // the framework keys collections by id-maps and appends with "/-". An index
    // past the end would leave holes, so it is refused.
    if (i > arr.length || (op.op === "replace" && i === arr.length)) {
      fail(404, `Path not found: index ${i} is past the end of ${op.path}`);
    }
    const had = i < arr.length;
    const was = arr[i];
    undo.push(() => { if (had) arr[i] = was; else arr.length = i; });
    arr[i] = op.value;
    return;
  }

  const obj = parent;
  const had = Object.prototype.hasOwnProperty.call(obj, last);
  const was = obj[last];
  undo.push(() => { if (had) obj[last] = was; else delete obj[last]; });
  if (op.op === "remove") delete obj[last];
  else obj[last] = op.value;
}

/** Apply delta ops to a document in place: the whole batch, or (when an op throws) none of it. */
export function applyOps(doc: any, ops: DeltaOp[]): void {
  const undo: (() => void)[] = [];
  try {
    for (const op of ops) applyOne(doc, op, undo);
  } catch (err) {
    for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
    throw err;
  }
}
