/**
 * A document's `owns` as a path: from the document's row to the person who may open it, write
 * through it and hear what is written to it (dzql's path language, moved here: Workshop's
 * docs/postgres-split-plan.md, step 3). Permissions are a document's, never a table's.
 *
 *   defineDoc("venue:", { root: "venues", include: [], owns: "@org_id->members[org_id=$]{active}.person_id" })
 *
 * The grammar, parsed once here for every backend:
 *
 *   rule    := TRUE | FALSE | AUTHENTICATED | @field | chain
 *   chain   := start ('->' hop)+ | table '[' filters ']' conds? '.' field
 *   start   := @field
 *   hop     := table ('[' filters ']')? conds? ('.' field)?
 *   filters := field '=' value (',' field '=' value)*      value: $ | @field | a literal
 *   conds   := '{' cond (',' cond)* '}'                     cond: field | field=literal | field<op>now()
 *
 * Tables are collections, as the schema names them. Each hop after the start joins on the value
 * before it: on its `$` filter if it has brackets, else on its id. A hop's `.field` is passed on;
 * the last is compared with the person. A hop through a table that keeps versions reads its
 * current rows.
 *
 * Where a path starts: a single document's root row (`@owner_id` is the row's); a document with a
 * scope, the row its name points at (`@org_id` is the name's value for that key). A document whose
 * name gives no row (a list with no scope) takes TRUE, FALSE or AUTHENTICATED alone, else nobody.
 *
 * `checkPath` says what is wrong with a path against the schema (thrown at registration, naming
 * the document); `pathSql` lowers it to a boolean SQL expression, the same on SQLite and Postgres
 * but for how the start row, the person and the time are named.
 */
import { q, type DocDef, type ResolvedTable, type Schema } from "./schema";
import type { Scope } from "./server/scope";

export type Filter = { field: string; value: string }; // value: '$', '@field', or a literal as written
export type Condition =
  | { type: "boolean"; field: string }
  | { type: "equality"; field: string; value: string }
  | { type: "temporal"; field: string; op: string; value: string };
export type Hop = { table: string; filters: Filter[]; conditions: Condition[]; field: string };
export type PathLiteral = "TRUE" | "FALSE" | "AUTHENTICATED";

/** A path parsed: a literal, or a start field (absent for a table-first chain) and its hops. */
export type ParsedPath =
  | { path: string; literal: PathLiteral }
  | { path: string; start?: string; hops: Hop[] };

export class PathError extends Error {
  override name = "PathError";
}

const IDENT = "[a-zA-Z_][a-zA-Z0-9_]*";
const IDENT_RE = new RegExp(`^${IDENT}$`);
const FIELD_RE = new RegExp(`^@(${IDENT})$`);
const HOP_RE = new RegExp(`^(${IDENT})(?:\\[([^\\]]*)\\])?(?:\\{([^}]*)\\})?(?:\\.(${IDENT}))?$`);
const LITERAL_RE = /^(-?\d+(\.\d+)?|'(?:[^']|'')*'|NULL|null|true|false|[a-zA-Z_][a-zA-Z0-9_]*)$/;
const NOW_RE = /^(now\(\)|current_date|current_timestamp)$/i;
const TEMPORAL_RE = new RegExp(`^(${IDENT})\\s*(<=|>=|<>|!=|<|>)\\s*(now\\(\\)|current_date|current_timestamp|NULL|-?\\d+(?:\\.\\d+)?|'(?:[^']|'')*')$`, "i");

/** Parse a path; a path that cannot be read throws `PathError`, saying where. */
export function parsePath(text: string): ParsedPath {
  const path = (text ?? "").trim();
  const upper = path.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE" || upper === "AUTHENTICATED") return { path, literal: upper };
  const own = FIELD_RE.exec(path) ?? new RegExp(`^@(${IDENT})\\s*==\\s*@user_id$`).exec(path);
  if (own) return { path, start: own[1]!, hops: [] };
  if (!path.includes("->") && !new RegExp(`^${IDENT}\\[`).test(path)) throw new PathError(`cannot read the path '${path}'`);

  const raw = path.split("->").map((s) => s.trim());
  if (raw.some((s) => s === "")) throw new PathError(`an empty hop in '${path}'`);
  let start: string | undefined;
  const hops: Hop[] = [];
  if (raw[0]!.startsWith("@")) {
    const m = FIELD_RE.exec(raw[0]!);
    if (!m) throw new PathError(`cannot read the start '${raw[0]}'`);
    start = m[1]!;
  } else {
    const first = hop(raw[0]!, raw.length === 1);
    if (!first.filters.length) throw new PathError(`a path that starts at a table needs [filters]: '${raw[0]}'`);
    if (first.filters.some((f) => f.value === "$")) throw new PathError(`$ has nothing to join in the first hop '${raw[0]}'`);
    hops.push(first);
  }
  for (let i = 1; i < raw.length; i++) {
    const h = hop(raw[i]!, i === raw.length - 1);
    const joins = h.filters.filter((f) => f.value === "$").length;
    if (h.filters.length && joins !== 1) throw new PathError(`the hop '${raw[i]}' has [filters], so it joins on one $`);
    hops.push(h);
  }
  return { path, ...(start !== undefined ? { start } : {}), hops };
}

function hop(text: string, last: boolean): Hop {
  const m = HOP_RE.exec(text);
  if (!m) throw new PathError(`cannot read the hop '${text}'`);
  const [, table, filters, conds, field] = m;
  if (last && !field) throw new PathError(`the last hop '${text}' needs a .field to compare with the person`);
  if (!last && !field && (filters !== undefined || conds !== undefined)) throw new PathError(`the hop '${text}' needs a .field to pass on`);
  return {
    table: table!,
    filters: filters !== undefined ? splitTop(filters).map(filter) : [],
    conditions: conds !== undefined ? splitTop(conds).map(condition) : [],
    field: field ?? "id",
  };
}

/** Split on commas outside single quotes. */
function splitTop(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    if (ch === "," && !quoted) (parts.push(cur.trim()), (cur = ""));
    else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function filter(part: string): Filter {
  const m = new RegExp(`^(${IDENT})\\s*=\\s*(.+)$`).exec(part);
  const value = m?.[2]!.trim();
  if (!m || (value !== "$" && !FIELD_RE.test(value!) && !LITERAL_RE.test(value!))) throw new PathError(`cannot read the filter '${part}'`);
  return { field: m[1]!, value: value! };
}

function condition(part: string): Condition {
  if (IDENT_RE.test(part)) return { type: "boolean", field: part };
  const eq = new RegExp(`^(${IDENT})\\s*=\\s*(.+)$`).exec(part);
  if (eq && LITERAL_RE.test(eq[2]!.trim())) return { type: "equality", field: eq[1]!, value: eq[2]!.trim() };
  const cmp = TEMPORAL_RE.exec(part);
  if (cmp) return { type: "temporal", field: cmp[1]!, op: cmp[2]!, value: cmp[3]! };
  throw new PathError(`cannot read the condition '${part}'`);
}

// --- Against the schema ------------------------------------------------------

/** The scope keys a document's name gives a value for by equality: where its path may start. */
export function namedKeys(def: DocDef): string[] {
  return Object.entries(def.scope).filter(([, b]) => /^(=?:)?[A-Za-z_]\w*$/.test(b)).map(([k]) => k);
}

const columnType = (t: ResolvedTable, col: string): string | undefined =>
  col === "id" || col === t.parent?.fkColumn ? "integer" : t.columns[col]?.type;

/**
 * What is wrong with `def`'s path against `schema`: it cannot be read, or names a table that is
 * not a collection, a column a table lacks, or a key that is not an integer; or starts at a field
 * its name does not give. Empty when it can be followed.
 */
export function checkPath(def: DocDef & { owns: string }, schema: Schema): string[] {
  let parsed: ParsedPath;
  try {
    parsed = parsePath(def.owns);
  } catch (err: any) {
    return [err.message];
  }
  if ("literal" in parsed) return [];
  const problems: string[] = [];
  const root = schema.tables[def.root]!;
  const scoped = Object.keys(def.scope).length > 0;
  const named = namedKeys(def);
  const need = (key: string, col: string, integer: boolean) => {
    const t = schema.tables[key]!;
    const type = columnType(t, col);
    if (!type) problems.push(`${key} has no column ${col}`);
    else if (integer && type !== "integer") problems.push(`${key}.${col} is ${type}, not an integer key`);
  };
  const startAt = (field: string) => {
    if (scoped ? !named.includes(field) : !columnType(root, field)) {
      problems.push(scoped ? `it starts at @${field}, which the name does not give (its keys: ${named.join(", ") || "none"})` : `${def.root} has no column ${field}`);
    } else need(def.root, field, true);
  };
  if (parsed.start !== undefined) startAt(parsed.start);
  for (const h of parsed.hops) {
    if (!schema.tables[h.table]) {
      problems.push(`no collection ${h.table}`);
      continue;
    }
    if (!h.filters.length) need(h.table, "id", true);
    for (const f of h.filters) {
      need(h.table, f.field, f.value === "$" || f.value.startsWith("@"));
      if (f.value.startsWith("@")) startAt(f.value.slice(1));
    }
    for (const c of h.conditions) need(h.table, c.field, false);
    need(h.table, h.field, true);
  }
  return problems;
}

/** `checkPath`, thrown: naming the document, the path and each problem. */
export function assertPath(def: DocDef & { owns: string }, schema: Schema): void {
  const problems = checkPath(def, schema);
  if (problems.length) throw new Error(`doc "${def.prefix}": its owns path cannot be followed: ${problems.join("; ")} -- in '${def.owns}'`);
}

// --- To SQL ------------------------------------------------------------------

export interface PathSqlNames {
  /** SQL for a field of the row the path starts from (an @field). */
  start(field: string): string;
  /** SQL for the person. */
  person: string;
  /** SQL for now() in a condition (SQLite has none: a bound time). Default: as written. */
  now?: string;
}

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const literal = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) || v === "true" || v === "false" ? v : v.startsWith("'") ? v : quote(v));

/** A parsed path as a boolean SQL expression: does it reach the person? */
export function pathSql(parsed: ParsedPath, schema: Schema, names: PathSqlNames): string {
  if ("literal" in parsed) return parsed.literal === "AUTHENTICATED" ? `(${names.person} IS NOT NULL)` : parsed.literal;
  if (!parsed.hops.length) return `(${names.start(parsed.start!)} = ${names.person})`;
  const used = new Map<string, number>();
  const alias = (table: string) => {
    const n = (used.get(table) ?? 0) + 1;
    used.set(table, n);
    return `_p_${table}${n > 1 ? `_${n}` : ""}`;
  };
  const value = (v: string, prev: string | null): string =>
    v === "$" ? prev! : v.startsWith("@") ? names.start(v.slice(1)) : literal(v);
  const build = (i: number, prev: string | null): string => {
    const h = parsed.hops[i]!;
    const t = schema.tables[h.table]!;
    const a = alias(h.table);
    const col = (c: string) => `${a}.${q(c)}`;
    const where: string[] = [];
    if (h.filters.length) {
      for (const f of h.filters) where.push(f.value.toUpperCase() === "NULL" ? `${col(f.field)} IS NULL` : `${col(f.field)} = ${value(f.value, prev)}`);
    } else if (prev !== null) where.push(`${col("id")} = ${prev}`);
    for (const c of h.conditions) {
      if (c.type === "boolean") where.push(`${col(c.field)} = TRUE`);
      else if (c.type === "equality") where.push(c.value.toUpperCase() === "NULL" ? `${col(c.field)} IS NULL` : `${col(c.field)} = ${literal(c.value)}`);
      else where.push(c.value.toUpperCase() === "NULL" ? `${col(c.field)} IS ${c.op === "=" ? "" : "NOT "}NULL` : `${col(c.field)} ${c.op} ${NOW_RE.test(c.value) ? (names.now ?? c.value) : c.value}`);
    }
    if (t.temporal) where.push(`${a}.valid_to IS NULL`);
    where.push(i === parsed.hops.length - 1 ? `${col(h.field)} = ${names.person}` : build(i + 1, col(h.field)));
    return `EXISTS (SELECT 1 FROM ${q(t.name)} ${a} WHERE ${where.join(" AND ")})`;
  };
  return build(0, parsed.start !== undefined ? names.start(parsed.start) : null);
}

/**
 * Where an @field of `def`'s path is read for a name, by its scope: the name's own value (a key
 * it gives by equality, or a single document's id), the root row's column, or nothing (a name
 * that gives no row: the path reaches nobody).
 */
export function startOf(def: DocDef, scope: Scope, field: string): { value: string } | { column: string; id: string } | null {
  if (Object.keys(def.scope).length) return scope.values[field] !== undefined && scope.values[field] !== "" ? { value: scope.values[field]! } : null;
  if (scope.mode !== "single") return null;
  return field === "id" ? { value: scope.id! } : { column: field, id: scope.id! };
}
