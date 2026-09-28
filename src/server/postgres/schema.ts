/**
 * Delta Postgres — schema wrappers + Postgres-specific utilities.
 *
 * The shared schema vocabulary (ColumnDef, TableDef, Schema, ResolvedTable,
 * DocDef, defineSchema, defineDoc) lives in `../../schema` and is identical
 * across the Postgres and SQLite backends. This module re-exports those
 * types and adds the Postgres helpers that hit the live database
 * (time-travel, snapshots, ops-log pruning, op validation).
 */
import type { Pool } from "pg";
import { type DeltaOp, joinPath, splitPath } from "../../core";
import {
  type Schema,
  type DocDef,
  type ValidationError,
} from "../../schema";
import { resolveScope } from "../scope";

export type {
  ColumnType,
  ColumnDef,
  ColumnShorthand,
  TableDef,
  Schema,
  ResolvedTable,
  DocDef,
  ValidationError,
} from "../../schema";
export { defineSchema, defineDoc } from "../../schema";

// ---------------------------------------------------------------------------
// Postgres-specific doc helpers — all thin wrappers over stored functions.
// ---------------------------------------------------------------------------

export async function loadDocAt(pool: Pool, docName: string, at: string | Date): Promise<any | null> {
  const ts = at instanceof Date ? at.toISOString() : at;
  const { rows } = await pool.query("SELECT delta_open_at($1, $2) AS doc", [docName, ts]);
  return rows[0]?.doc ?? null;
}

export async function createSnapshot(pool: Pool, name: string, at?: string): Promise<string> {
  const { rows } = await pool.query(
    "SELECT delta_snapshot($1, $2) AS ts",
    [name, at ?? new Date().toISOString()],
  );
  return rows[0]?.ts;
}

export async function resolveSnapshot(pool: Pool, name: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT delta_resolve_snapshot($1) AS ts", [name]);
  return rows[0]?.ts ?? null;
}

export async function pruneOpsLog(pool: Pool, keepInterval = "1 hour"): Promise<number> {
  const { rows } = await pool.query("SELECT delta_prune_ops($1::interval) AS count", [keepInterval]);
  return Number(rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// validateOps — what delta_apply refuses as a mistake (400), said ahead.
// ---------------------------------------------------------------------------

/** 2^53 - 1: a path's id past it is refused, as `_delta_row_id` refuses it. */
const MAX_ID = 9007199254740991;

/**
 * Validate delta ops against the schema, as `delta_apply` (001d) reads them,
 * before they reach the database: it refuses each write this does (a 400), and
 * takes each this takes -- but for what only the rows can say (a row not there,
 * 404; already there, 409) and a value its column cannot cast (text into an
 * integer), which are the database's. Returns an array of errors (empty = valid).
 *
 * `doc`: the document's name, which says its mode and its scope's values, as
 * `delta_apply` reads them (`_delta_resolve_scope`; `resolveScope` is its
 * twin) -- the definition alone cannot: `all-courses:` is every course, and
 * `all-courses:1` course 1 (todo #57). Or say them: `list`, the document is in
 * list mode; `values`, its scope's equality bindings, which a list-mode add of
 * a root row is given, so they count as given -- the options SQLite's
 * validateOps takes, and they win over the name's. Given neither, a document
 * is read as single: `replace /<root>` and `replace /<root>/<field>` write its
 * root row.
 */
export function validateOps(schema: Schema, def: DocDef, ops: DeltaOp[], opts: { doc?: string; list?: boolean; values?: Record<string, string> } = {}): ValidationError[] {
  if (opts.doc !== undefined) {
    if (!opts.doc.startsWith(def.prefix)) throw new Error(`validateOps: ${opts.doc} is not a document of ${def.prefix}`);
    const scope = resolveScope(def, opts.doc.slice(def.prefix.length));
    opts = { list: opts.list ?? scope.mode === "list", values: opts.values ?? scope.values };
  }
  const errors: ValidationError[] = [];
  for (const op of ops) {
    const fail = (message: string, path = op.path) => errors.push({ path: String(path), message });
    let parts: string[];
    try { parts = splitPath(op.path); }
    catch (err: any) { fail(err.message); continue; }
    const collKey = parts[0];
    if (!collKey) { fail("Empty path"); continue; }
    if (collKey !== def.root && !def.include.includes(collKey)) { fail(`Unknown collection: ${collKey}`); continue; }
    const table = schema.tables[collKey];
    if (!table) { fail(`No table for collection: ${collKey}`); continue; }

    const fk = table.parent?.fkColumn;
    const value = (op as any).value;
    const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
    // A value's keys (_delta_assert_fields): its columns, the row's id (the path's wins) and parent key, a temporal row's validity.
    const known = (k: string) => Object.hasOwn(table.columns, k) || k === "id" || k === fk || k === "valid_from" || k === "valid_to";
    // What a written field may hold, beyond its column's cast: a column that is
    // not nullable is never null (the table's NOT NULL); a parent key is an id.
    const fieldErr = (field: string, v: unknown): string | null => {
      if (field === fk) {
        if (v === null || v === undefined) return `${field} cannot be null`;
        return Number.isInteger(v) || (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) ? null : `${field} must be an id: an integer`;
      }
      const col = Object.hasOwn(table.columns, field) ? table.columns[field]! : undefined;
      return col && !col.nullable && v === null ? `${field} cannot be null` : null;
    };
    // A whole-row value: an object of known keys, each field as it may be written.
    const rowErrs = (row: Record<string, unknown>, verb: "add" | "replace") => {
      for (const k of Object.keys(row)) if (!known(k)) fail(`Unknown field: ${k}`);
      for (const [k, v] of Object.entries(row)) {
        const err = verb === "add" && k === fk ? null : fieldErr(k, v);   // an add's parent key is its document's, or found in scope
        if (err) fail(err);
      }
    };
    // A row's id, as the path names it: the number its digits name, up to 2^53 - 1 (_delta_row_id).
    const idErr = (seg: string): string | null =>
      !/^[0-9]+$/.test(seg) ? `Row id "${seg}" in ${op.path} is not a number: Postgres mints row ids -- add to ${joinPath(collKey, "-")} and read the id from the echo`
      : Number(seg) > MAX_ID ? `Row id ${seg} in ${op.path} is past 2^53 - 1, which no number holds exactly -- add to ${joinPath(collKey, "-")} and read the id from the echo`
      : null;

    // A single document's root: `replace /<root>` merges into it, and
    // `replace /<root>/<field>` (a segment that is not an id) writes one field
    // -- a column, or the parent key: the row moves (#37).
    if (collKey === def.root && !opts.list && op.op === "replace" && (parts.length === 1 || (parts.length === 2 && !/^\d+$/.test(parts[1]!)))) {
      if (parts[1] === "id") fail("Unknown field: id (a row keeps the id its path names)");
      else if (parts.length === 2) rowErrs({ [parts[1]!]: value }, "replace");
      else if (!isObject) fail("Replace value must be an object");
      else rowErrs(value, "replace");
      continue;
    }

    // A row: add /<coll>/<id or ->, remove /<coll>/<id>, replace /<coll>/<id>[/<field>].
    const rowOp = (op.op === "add" || op.op === "remove") ? parts.length === 2 : op.op === "replace" && (parts.length === 2 || parts.length === 3);
    if (!rowOp) { fail(`Invalid op: ${op.op} ${op.path}`); continue; }
    const idError = op.op === "add" && parts[1] === "-" ? null : idErr(parts[1]!);
    if (idError) { fail(idError); continue; }
    if (op.op === "remove") continue;
    if (parts.length === 3) {
      const field = parts[2]!;
      if (!known(field) || field === "id") { fail(`Unknown field: ${field}`); continue; }   // a row keeps the id its path names
      const err = fieldErr(field, value);
      if (err) fail(err);
      continue;
    }
    if (!isObject) { fail(`${op.op === "add" ? "Add" : "Replace"} value must be an object`); continue; }
    rowErrs(value, op.op as "add" | "replace");
    // A column that is neither nullable nor has a default must be given -- by
    // the value, or, for a list-mode root row, by the scope, as delta_apply
    // checks after it stamps them (#39).
    if (op.op === "add") {
      const given = opts.list && collKey === def.root ? (opts.values ?? {}) : {};
      for (const [col, colDef] of Object.entries(table.columns)) {
        if (!colDef.nullable && colDef.default === undefined && !Object.hasOwn(value, col) && !Object.hasOwn(given, col)) {
          fail(`Required field missing: ${col} (give it a value, or declare a default or make it nullable in the schema)`);
        }
      }
    }
  }
  return errors;
}
