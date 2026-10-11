/** SQL helpers for codegen.ts (the schema's DDL) and carry.ts (export and import). */
import type { ColumnDef, Schema } from "./schema";

export function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/**
 * Emit a single-quoted SQL string literal with embedded quotes escaped.
 * Use for ANY value interpolated into a `'…'` literal position so an
 * apostrophe in a name can't terminate the literal or inject SQL.
 */
export function lit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function columnSqlType(def: ColumnDef): string {
  switch (def.type) {
    case "text": return "TEXT";
    case "json": return "JSONB";
    case "integer": return "BIGINT";
    case "boolean": return "BOOLEAN";
    case "real": return "DOUBLE PRECISION";
    case "timestamptz": return "TIMESTAMPTZ";
  }
}

export function sqlDefault(value: unknown): string {
  if (typeof value === "string") return lit(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return "NULL";
}

export function findCascadeOn(collKey: string, schema: Schema): { fk: string; collection: string }[] {
  const result: { fk: string; collection: string }[] = [];
  for (const [otherKey, otherTable] of Object.entries(schema.tables)) {
    if (otherKey === collKey) continue;
    for (const ref of otherTable.referencedBy) {
      if (ref.collection === collKey) {
        result.push({ fk: ref.fkColumn, collection: otherKey });
      }
    }
  }
  return result;
}
