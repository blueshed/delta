/**
 * A document's scope, read from its name -- the same rule on every backend.
 *
 * The TypeScript twin of the Postgres resolver (`_delta_resolve_scope`,
 * src/sql/001b-delta-scope.sql), for the backends that are not Postgres: the
 * SQLite file and the JSON file. A document with an id in its scope is one
 * root row and its children (single mode); one without is every root row its
 * conditions admit (list mode), with its included collections in full.
 *
 * `scope` maps a root column to a binding:
 *   ":name" or "=:name"  column = the name's value     (equality)
 *   "<=:name" ">=:name" "<:name" ">:name" "!=:name"     (range)
 *   "like:name"          column starts with the value, any case
 *   "at:name"            the time the document is read at (no condition)
 *   "name"               the same as ":name"
 * The values come from the document's id, split on ":", in order: a param
 * named "id" first, the rest alphabetically. An empty value sets no condition.
 * With no scope, the id is the root row's id -- or, empty, every root row.
 */
import type { DocDef } from "../schema";

export type Op = "=" | "!=" | "<" | ">" | "<=" | ">=" | "like";
export type Cond = { col: string; op: Op; value: string };

export interface Scope {
  mode: "single" | "list";
  /** Single mode: the root row's id. */
  id?: string;
  /** The conditions on the root's rows (single mode: the id's among them). */
  conds: Cond[];
  /** Equality bindings: what an add of a root row in list mode is given. */
  values: Record<string, string>;
  /** The time the document is read at, when its name says one. */
  at?: string;
}

const OPS = new Set<Op>(["=", "!=", "<", ">", "<=", ">="]);

export function resolveScope(def: DocDef, docId: string): Scope {
  const entries = Object.entries(def.scope);
  if (entries.length === 0) {
    return docId === ""
      ? { mode: "list", conds: [], values: {} }
      : { mode: "single", id: docId, conds: [{ col: "id", op: "=", value: docId }], values: { id: docId } };
  }
  const parsed = entries.map(([col, binding]) => {
    let m: RegExpExecArray | null;
    if ((m = /^at:(.+)$/.exec(binding))) return { col, op: "at" as const, param: m[1]! };
    if ((m = /^like:(.+)$/.exec(binding))) return { col, op: "like" as const, param: m[1]! };
    if ((m = /^([<>=!]+):(.+)$/.exec(binding))) {
      if (!OPS.has(m[1] as Op)) throw new Error(`invalid scope operator "${m[1]}" (valid: =, >=, <=, >, <, !=, like, at)`);
      return { col, op: m[1] as Op, param: m[2]! };
    }
    return { col, op: "=" as const, param: binding.replace(/^:+/, "") };
  });
  // positions: a param named "id" first, the rest in alphabetical order
  const params = [...new Set(parsed.map((p) => p.param))].sort((a, b) => (a === "id" ? -1 : b === "id" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  const parts = docId.split(":");
  const valueOf = (param: string) => parts[params.indexOf(param)] ?? "";

  const scope: Scope = { mode: "list", conds: [], values: {} };
  for (const { col, op, param } of parsed) {
    const value = valueOf(param);
    if (value === "") continue;
    if (op === "at") { scope.at = value; continue; }
    scope.conds.push({ col, op, value });
    if (op === "=") scope.values[col] = value;
  }
  if (scope.values.id !== undefined) {
    scope.mode = "single";
    scope.id = scope.values.id;
  }
  return scope;
}

/** The conditions as SQL, for a query on the root's table. */
export function whereOf(scope: Scope): { sql: string; params: unknown[] } {
  if (scope.conds.length === 0) return { sql: "1 = 1", params: [] };
  return {
    sql: scope.conds.map(({ col, op }) => (op === "like" ? `${col} LIKE ?` : `${col} ${op} ?`)).join(" AND "),
    params: scope.conds.map(({ op, value }) => (op === "like" ? `${value}%` : value)),
  };
}

/** Numbers compared as numbers, the rest as text -- as a column holding either does. */
function compare(a: unknown, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (a !== null && a !== "" && b !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  const sa = String(a ?? "");
  return sa < b ? -1 : sa > b ? 1 : 0;
}

/** Does a root row meet the scope's conditions? Judged on its values, as the SQL would. */
export function meets(scope: Scope, row: Record<string, unknown>): boolean {
  return scope.conds.every(({ col, op, value }) => {
    const v = row[col];
    if (v === null || v === undefined) return false;
    switch (op) {
      case "like": return String(v).toLowerCase().startsWith(value.toLowerCase());
      case "=": return compare(v, value) === 0;
      case "!=": return compare(v, value) !== 0;
      case "<": return compare(v, value) < 0;
      case ">": return compare(v, value) > 0;
      case "<=": return compare(v, value) <= 0;
      case ">=": return compare(v, value) >= 0;
    }
  });
}

/** Two ids the same, whichever is text and whichever a number. */
export const sameId = (a: unknown, b: unknown): boolean => a != null && b != null && String(a) === String(b);

/** An id as it is kept: a serial as a number, anything else as it was given. */
export const rowId = (id: string | number): string | number => (typeof id === "string" && /^[0-9]{1,15}$/.test(id) ? Number(id) : id);
