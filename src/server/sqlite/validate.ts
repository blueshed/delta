/** What a write may say (`validateOps`): its paths, collections, fields and values, against the schema. */
import { joinPath, splitPath, type DeltaOp } from "../../core";
import type { ColumnDef, DocDef, ResolvedTable, Schema, ValidationError } from "../../schema";
import { pastSafeId, rowId, sameId } from "../scope";

/**
 * Validate delta ops against the schema. Returns an array of errors (empty = valid).
 * `list`: the document is in list mode; `values`: its scope's equality bindings,
 * which a list-mode add of a root row is given (`applyOps`), so they count as given.
 */
export function validateOps(schema: Schema, def: DocDef, ops: DeltaOp[], opts: { list?: boolean; values?: Record<string, string>; walk?: boolean } = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  // A list-mode document's root is a map of rows, like an included collection.
  const single = (collKey: string) => collKey === def.root && !opts.list;

  for (const op of ops) {
    let parts: string[];
    try { parts = splitPath(op.path); }
    catch (err: any) { errors.push({ path: String(op.path), message: err.message }); continue; }
    const collKey = parts[0];
    if (!collKey) {
      errors.push({ path: op.path, message: "Empty path" });
      continue;
    }

    // Check collection exists -- or, in a walk (`walk`), is one outside the document that its entry's cascade reached: a row put back, or taken again
    if (collKey !== def.root && !def.include.includes(collKey) && !(opts.walk && parts.length === 2 && op.op !== "replace")) {
      errors.push({ path: op.path, message: `Unknown collection: ${collKey}` });
      continue;
    }

    const table = schema.tables[collKey];
    if (!table) {
      errors.push({ path: op.path, message: `No table for collection: ${collKey}` });
      continue;
    }

    const fkCol = table.parent?.fkColumn;
    // Own columns only: `table.columns.toString` is Object.prototype's, not a column.
    const columnOf = (k: string): ColumnDef | undefined => (Object.hasOwn(table.columns, k) ? table.columns[k] : undefined);
    const isKnownKey = (k: string) => k === "id" || k === fkCol || columnOf(k) !== undefined;
    // A field's value: a column's by its type; the parent key's as a key (the row moves).
    const fieldErr = (field: string, value: unknown): string | null => {
      if (field === fkCol) return validateParentKey(field, value);
      const colDef = columnOf(field);
      return colDef ? validateFieldType(colDef, field, value) : null;
    };

    // One-segment paths: /<root> is a whole-root partial merge (replace only);
    // /<coll> on an included collection has no meaning for a client op — reject
    // it here so it 400s instead of reaching the executor's throw (500).
    if (parts.length === 1) {
      if (!single(collKey)) {
        errors.push({ path: op.path, message: `Whole-collection ops are not supported: ${op.op} ${op.path}` });
        continue;
      }
      if (op.op !== "replace") {
        errors.push({ path: op.path, message: "Root supports replace only" });
        continue;
      }
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (value == null || typeof value !== "object" || Array.isArray(value)) {
        errors.push({ path: op.path, message: "Replace value must be an object" });
        continue;
      }
      for (const key of Object.keys(value)) {
        if (!isKnownKey(key)) errors.push({ path: op.path, message: `Unknown field: ${key}` });
      }
      for (const [field, fieldValue] of Object.entries(value)) {
        const typeErr = fieldErr(field, fieldValue);
        if (typeErr) errors.push({ path: `${op.path}/${field}`, message: typeErr });
      }
      continue;
    }

    // A single-mode root: /<root>/<field> is a FIELD replace
    // (not /<root>/<id> row), so validate parts[1] as a column name -- or the
    // parent key (the root row moves, as the whole-root merge moves it, and as on Postgres).
    // An add or a remove of /<root>/<id> is the root row itself, checked as a
    // row below, and so is a replace of it named by its id (`namesRootRow`, as
    // Postgres reads the segment); applyOps holds it to the one the document is named for.
    const rootId = opts.values?.id === undefined ? undefined : rowId(opts.values.id);
    if (single(collKey) && parts.length === 2 && op.op !== "add" && op.op !== "remove" && !namesRootRow(table, parts[1]!, rootId)) {
      if (op.op !== "replace") {
        errors.push({ path: (op as DeltaOp).path, message: `Root fields support replace only (add and remove take /${collKey}/<id>, the root row)` });
        continue;
      }
      const field = parts[1]!;
      if (field !== fkCol && !columnOf(field)) {
        errors.push({ path: op.path, message: `Unknown field: ${field}` });
        continue;
      }
      const typeErr = fieldErr(field, (op as any).value);
      if (typeErr) errors.push({ path: op.path, message: typeErr });
      continue;
    }

    // A row: add /<coll>/<id or ->, remove /<coll>/<id>, replace /<coll>/<id>[/<field>].
    const rowOp = op.op === "add" || op.op === "remove" ? parts.length === 2 : op.op === "replace" && parts.length <= 3;
    if (!rowOp) {
      errors.push({ path: op.path, message: `Invalid op: ${op.op} ${op.path}` });
      continue;
    }

    // A row's id, as the path names it: digits past 2^53 - 1 are refused, as on
    // Postgres (_delta_row_id). No number holds them exactly, so the row would be
    // kept, read and told under another id.
    if (pastSafeId(parts[1]!)) {
      errors.push({ path: op.path, message: `Row id ${parts[1]} is past 2^53 - 1, which no number holds exactly -- add to ${joinPath(collKey, "-")} and read the id from the echo` });
      continue;
    }

    // Whole-row add / replace on an included collection: /<coll>/<id> (or /<coll>/- for add).
    if ((op.op === "add" || op.op === "replace") && parts.length === 2) {
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (value == null || typeof value !== "object" || Array.isArray(value)) {
        // Rejecting a bad REPLACE matters as much as a bad add now that the
        // executor implements whole-row replace — before, a non-object value
        // was silently dropped along with the rest of the op.
        errors.push({
          path: op.path,
          message: `${op.op === "add" ? "Add" : "Replace"} value must be an object`,
        });
        continue;
      }

      // Unknown fields are rejected: otherwise the op acks, rides the broadcast
      // and cache, but is dropped by the DB write — diverging clients from disk.
      for (const key of Object.keys(value)) {
        if (!isKnownKey(key)) errors.push({ path: op.path, message: `Unknown field: ${key}` });
      }

      // Required-field check applies to adds only: a column that is neither
      // nullable nor has a default must be given (it used to be stored as "",
      // 0 or false, acked and broadcast) -- by the value, or, for a list-mode
      // root row, by the scope, as Postgres checks after it stamps them.
      if (op.op === "add") {
        const given = opts.list && collKey === def.root ? (opts.values ?? {}) : {};
        for (const [col, colDef] of Object.entries(table.columns)) {
          if (!colDef.nullable && colDef.default === undefined && value[col] === undefined && given[col] === undefined) {
            errors.push({ path: op.path, message: `Required field missing: ${col} (give it a value, or declare a default or make it nullable in the schema)` });
          }
        }
      }

      // Type-check the fields that map to declared columns, and a replace's
      // parent key (an add's is its document's root, or found in scope).
      for (const [field, fieldValue] of Object.entries(value)) {
        const typeErr = op.op === "add" && field === fkCol ? null : fieldErr(field, fieldValue);
        if (typeErr) errors.push({ path: `${op.path}/${field}`, message: typeErr });
      }
    }

    // Field-level replace: /<coll>/<id>/field -- a column, or the parent key (the row moves, as on Postgres)
    if (op.op === "replace" && parts.length === 3) {
      const field = parts[2]!;
      if (field !== fkCol && !columnOf(field)) {
        errors.push({ path: op.path, message: `Unknown field: ${field}` });
        continue;
      }
      const typeErr = fieldErr(field, (op as any).value);
      if (typeErr) errors.push({ path: op.path, message: typeErr });
    }
  }

  return errors;
}

/**
 * Does `/<root>/<segment>` name a single document's root row, not a field of
 * it? Its id: digits, as Postgres reads the segment (`/courses/1`, `/courses/01`),
 * or the root's own id as SQLite keeps a text one (`/rooms/attic`) -- where no
 * column, nor the parent key, has that name.
 */
export function namesRootRow(table: ResolvedTable, segment: string, rootId: unknown): boolean {
  if (segment === table.parent?.fkColumn || Object.hasOwn(table.columns, segment)) return false;
  return /^\d+$/.test(segment) || sameId(rowId(segment), rootId);
}

/**
 * A parent key written: never null (its column is NOT NULL, as on Postgres),
 * and an id -- an integer, or text, as SQLite keeps a text id (a session's token).
 */
function validateParentKey(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return `${field} cannot be null`;
  return typeof value === "string" || Number.isInteger(value) ? null : `${field} must be an id: an integer, or text`;
}

function validateFieldType(def: ColumnDef, field: string, value: unknown): string | null {
  if (value === null || value === undefined) {
    return def.nullable ? null : `${field} cannot be null`;
  }
  switch (def.type) {
    case "text":
      if (typeof value !== "string") return `${field} must be a string`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${field} must be an integer`;
      break;
    case "real":
      if (typeof value !== "number") return `${field} must be a number`;
      break;
    case "boolean":
      if (typeof value !== "boolean") return `${field} must be a boolean`;
      break;
    case "json":
      break; // any type is valid for json
    case "timestamptz":
      // SQLite stores as TEXT (ISO-8601). Accept strings or Date instances.
      if (typeof value !== "string" && !(value instanceof Date)) {
        return `${field} must be an ISO-8601 string or Date`;
      }
      break;
  }
  return null;
}
