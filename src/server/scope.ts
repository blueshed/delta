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
 * A condition compares its value as the column takes it (`Keep`), as Postgres
 * casts the text: a boolean's "yes" is true, a time the instant it names; one
 * the column cannot take is a 400.
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

/**
 * How the root's columns keep a value, which the conditions compare: a
 * condition's text from the name, cast as its column takes it -- the value an
 * add through the document is given, so the document reads what is added
 * through it; a value its column cannot take is refused (400), as Postgres
 * refuses the cast -- and a row's value, as its column stores it. The backend
 * gives it (SQLite: a boolean's "yes" and true are both 1).
 */
export interface Keep {
  /** A condition's text, as the column keeps it. */
  text(col: string, text: string): unknown;
  /** A row's value, as the column keeps it: null when it holds none a condition can compare (a row with it meets none). */
  value(col: string, value: unknown): unknown;
  /** The SQL every condition compares for the column, as `value` reads a row's (a time as its instant); the column itself when not given. */
  column?(col: string): string;
  /**
   * Bounds on the column as stored that every row meeting `op text` lies
   * within, asked ahead of the comparison: a range an index on the bare column
   * can search where `column` wraps it (a time's instant, read from its text).
   */
  within?(col: string, op: Op, text: string): { from?: string; below?: string } | undefined;
}

/** The conditions as SQL, for a query on the root's table: each value as its column keeps it (`like` a pattern of the text), inside its bounds. */
export function whereOf(scope: Scope, keep: Keep): { sql: string; params: unknown[] } {
  if (scope.conds.length === 0) return { sql: "1 = 1", params: [] };
  const sql: string[] = [];
  const params: unknown[] = [];
  for (const { col, op, value } of scope.conds) {
    const bounds = op === "like" ? undefined : keep.within?.(col, op, value);
    if (bounds?.from !== undefined) { sql.push(`${col} >= ?`); params.push(bounds.from); }
    if (bounds?.below !== undefined) { sql.push(`${col} < ?`); params.push(bounds.below); }
    sql.push(`${keep.column?.(col) ?? col} ${op === "like" ? "LIKE" : op} ?`);
    params.push(op === "like" ? `${value}%` : keep.text(col, value));
  }
  return { sql: sql.join(" AND "), params };
}

/** Two values as a column keeps them, in SQLite's order: numbers by value, text as text, a number before any text. */
function compare(a: unknown, b: unknown): number {
  const na = typeof a === "number";
  const nb = typeof b === "number";
  if (na && nb) return (a as number) - (b as number);
  if (na !== nb) return na ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** Does a root row meet the scope's conditions? Judged on its values as its columns keep them, as the SQL would. */
export function meets(scope: Scope, row: Record<string, unknown>, keep: Keep): boolean {
  return scope.conds.every(({ col, op, value }) => {
    if (row[col] === null || row[col] === undefined) return false;
    const bounds = op === "like" ? undefined : keep.within?.(col, op, value);   // as the SQL asks them, of the value as stored
    if (bounds?.from !== undefined && compare(row[col], bounds.from) < 0) return false;
    if (bounds?.below !== undefined && compare(row[col], bounds.below) >= 0) return false;
    const v = keep.value(col, row[col]);
    if (v === null || v === undefined) return false;   // as the SQL's NULL: a stored time SQLite cannot read
    if (op === "like") return String(v).toLowerCase().startsWith(value.toLowerCase());
    const c = compare(v, keep.text(col, value));
    switch (op) {
      case "=": return c === 0;
      case "!=": return c !== 0;
      case "<": return c < 0;
      case ">": return c > 0;
      case "<=": return c <= 0;
      case ">=": return c >= 0;
    }
  });
}

/** Two ids the same, whichever is text and whichever a number. */
export const sameId = (a: unknown, b: unknown): boolean => a != null && b != null && String(a) === String(b);

/**
 * An id as it is kept: digits as the number they name (a serial, "007" as 7), up
 * to 2^53 - 1; anything else as it was given (a session's token). Digits past
 * that stay as given, since no number holds them exactly; a path naming one is
 * refused (`pastSafeId`), as Postgres's `_delta_row_id` refuses it.
 */
export const rowId = (id: string | number): string | number => (typeof id === "string" && /^[0-9]+$/.test(id) && Number.isSafeInteger(Number(id)) ? Number(id) : id);

/** Digits naming a number past 2^53 - 1: kept as a number, the id would be another row's. */
export const pastSafeId = (id: string): boolean => /^[0-9]+$/.test(id) && !Number.isSafeInteger(Number(id));
