/**
 * Shared SQL generation helpers — used by both tasks.ts (build-time)
 * and delta-postgres.ts (runtime validation).
 */
import type { ColumnDef, Schema } from "./schema";

export function q(id: string): string {
  return `"${id}"`;
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
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
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

export function defaultForType(type: ColumnDef["type"]): unknown {
  switch (type) {
    case "text": return "";
    case "integer": return 0;
    case "real": return 0;
    case "boolean": return false;
    case "json": return null;
  }
}
