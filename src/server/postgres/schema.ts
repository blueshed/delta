/**
 * Delta Postgres — schema definition and utilities.
 *
 * Tables are generated at build time: bunx invt sql
 * Generic doc dispatch lives in ./doc-registry (docTypeFromDef).
 */
import type { Pool } from "pg";
import { defaultForType } from "./sql";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface ColumnDef {
  type: "text" | "integer" | "real" | "boolean" | "json" | "timestamptz";
  nullable?: boolean;
  default?: unknown;
}

type ColumnShorthand = "text" | "integer" | "real" | "boolean" | "json" | "timestamptz"
  | "text?" | "integer?" | "real?" | "boolean?" | "json?" | "timestamptz?";

export interface TableDef {
  table?: string;
  columns: Record<string, ColumnDef | ColumnShorthand>;
  parent?: string | { collection: string; fk: string };
  cascadeOn?: (string | { fk: string; collection: string })[];
  temporal?: boolean;
}

export interface Schema {
  tables: Record<string, ResolvedTable>;
}

export interface ResolvedTable {
  name: string;
  docKey: string;
  columns: Record<string, ColumnDef>;
  parent?: { collection: string; fkColumn: string };
  temporal: boolean;
  children: string[];
  referencedBy: { collection: string; fkColumn: string }[];
}

export interface DocDef {
  prefix: string;
  root: string;
  include: string[];
  scope: Record<string, string>;
}

// ---------------------------------------------------------------------------
// defineSchema
// ---------------------------------------------------------------------------

export function defineSchema(defs: Record<string, TableDef>): Schema {
  const tables: Record<string, ResolvedTable> = {};

  for (const [key, def] of Object.entries(defs)) {
    const columns: Record<string, ColumnDef> = {};
    for (const [col, shorthand] of Object.entries(def.columns)) {
      if (typeof shorthand === "string") {
        const nullable = shorthand.endsWith("?");
        const type = (nullable ? shorthand.slice(0, -1) : shorthand) as ColumnDef["type"];
        columns[col] = { type, nullable };
      } else {
        columns[col] = shorthand;
      }
    }

    let parent: ResolvedTable["parent"];
    if (def.parent) {
      if (typeof def.parent === "string") {
        parent = { collection: def.parent, fkColumn: `${def.parent}_id` };
      } else {
        parent = { collection: def.parent.collection, fkColumn: def.parent.fk };
      }
    }

    tables[key] = {
      name: def.table ?? key,
      docKey: key,
      columns,
      parent,
      temporal: def.temporal !== false,
      children: [],
      referencedBy: [],
    };
  }

  for (const [key, table] of Object.entries(tables)) {
    if (table.parent) {
      const parentTable = tables[table.parent.collection];
      if (parentTable) parentTable.children.push(key);
    }
    for (const cascade of defs[key]?.cascadeOn ?? []) {
      let fkCol: string;
      let targetKey: string | undefined;
      if (typeof cascade === "string") {
        fkCol = cascade;
        const stem = fkCol.replace(/_id$/, "");
        targetKey = Object.keys(tables).find(
          (k) => k === stem || k === stem + "s" || tables[k]!.name === stem || tables[k]!.name === stem + "s",
        );
      } else {
        fkCol = cascade.fk;
        targetKey = cascade.collection;
      }
      const target = targetKey ? tables[targetKey] : undefined;
      if (target) {
        target.referencedBy.push({ collection: key, fkColumn: fkCol });
      }
    }
  }

  return { tables };
}

// ---------------------------------------------------------------------------
// defineDoc
// ---------------------------------------------------------------------------

export function defineDoc(
  prefix: string,
  opts: { root: string; include: string[]; scope?: Record<string, string> },
): DocDef {
  return { prefix, root: opts.root, include: opts.include, scope: opts.scope ?? {} };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export async function loadDocAt(pool: Pool, docName: string, at: string | Date): Promise<any | null> {
  const ts = at instanceof Date ? at.toISOString() : at;
  const { rows } = await pool.query("SELECT delta_open_at($1, $2) AS doc", [docName, ts]);
  return rows[0]?.doc ?? null;
}

export async function createSnapshot(pool: Pool, name: string, at?: string): Promise<string> {
  const { rows } = await pool.query("SELECT delta_snapshot($1, $2) AS ts", [name, at ?? new Date().toISOString()]);
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
// Validation
// ---------------------------------------------------------------------------

export interface ValidationError { path: string; message: string; }

export function validateOps(schema: Schema, def: DocDef, ops: import("../../core").DeltaOp[]): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const op of ops) {
    const parts = op.path.split("/").filter(Boolean);
    const collKey = parts[0];
    if (!collKey) { errors.push({ path: op.path, message: "Empty path" }); continue; }
    if (collKey !== def.root && !def.include.includes(collKey)) {
      errors.push({ path: op.path, message: `Unknown collection: ${collKey}` }); continue;
    }
    const table = schema.tables[collKey];
    if (!table) { errors.push({ path: op.path, message: `No table for collection: ${collKey}` }); continue; }
    if (op.op === "add" && parts.length === 2) {
      const value = (op as any).value as Record<string, unknown> | undefined;
      if (!value || typeof value !== "object") {
        errors.push({ path: op.path, message: "Add value must be an object" }); continue;
      }
      for (const [col, colDef] of Object.entries(table.columns)) {
        if (!colDef.nullable && colDef.default === undefined && value[col] === undefined) {
          if (defaultForType(colDef.type) === null) {
            errors.push({ path: op.path, message: `Required field missing: ${col}` });
          }
        }
      }
    }
    if (op.op === "replace" && parts.length === 3) {
      const field = parts[2]!;
      if (!table.columns[field]) {
        errors.push({ path: op.path, message: `Unknown field: ${field}` }); continue;
      }
    }
  }
  return errors;
}
