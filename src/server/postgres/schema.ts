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
import type { DeltaOp } from "../../core";
import {
  type ColumnDef,
  type Schema,
  type DocDef,
  type ValidationError,
} from "../../schema";
import { defaultForType } from "./sql";

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
// validateOps — pre-flight check that ops reference known collections and
// fields, with required-field detection via the Postgres `defaultForType`.
// ---------------------------------------------------------------------------

export function validateOps(schema: Schema, def: DocDef, ops: DeltaOp[]): ValidationError[] {
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
          if (defaultForType((colDef as ColumnDef).type) === null) {
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
