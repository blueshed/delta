/**
 * migrateSchema — evolve live Postgres tables toward the TypeScript schema.
 *
 * `generateSql` is CREATE-only: re-applying it against a live database
 * updates the `_delta_collections` METADATA (ON CONFLICT DO UPDATE) but never
 * alters existing tables — so a column added to `types.ts` would be accepted
 * by `delta_apply` (which trusts the metadata) and silently dropped by
 * `jsonb_populate_record`. This is the Postgres counterpart of the SQLite
 * backend's `migrateSchema`: additive, idempotent ALTERs only.
 *
 * Recommended boot order (each step idempotent):
 *
 *   await applyFramework(pool);                       // 001a–001f
 *   await applySql(pool, generateSql(schema, docs));  // new tables + metadata
 *   await migrateSchema(pool, schema);                // ALTER existing tables
 *
 * What it does per existing table:
 *   - adds missing user columns (NOT NULL columns get the type's default so
 *     existing rows backfill; a NOT NULL column with no usable default is
 *     added NULLABLE with a warning — backfill, then SET NOT NULL yourself)
 *   - adds a missing parent-FK column (+ its index)
 *   - retrofits valid_from / valid_to + the current_ view when a table gained
 *     `temporal: true` (warns that the composite (id, valid_from) PK needs a
 *     manual table rebuild, mirroring the SQLite caveat)
 *   - re-creates the current_<table> view whenever a temporal table gained a
 *     column — a Postgres view created from SELECT * snapshots its column
 *     list at creation, so without this every read through the view would
 *     simply never see the new column
 *   - warns (never alters) on column type drift
 *
 * Destructive changes (drops, renames, type changes) are out of scope — use
 * a real migration tool for those.
 */
import type { Pool } from "pg";
import type { ColumnDef, Schema } from "../../schema";
import { q, columnSqlType, sqlDefault, defaultForType } from "./sql";

/** information_schema/udt name for each schema type, for drift detection. */
function expectedUdt(def: ColumnDef): string {
  switch (def.type) {
    case "text": return "text";
    case "integer": return "int8";
    case "real": return "float8";
    case "boolean": return "bool";
    case "json": return "jsonb";
    case "timestamptz": return "timestamptz";
  }
}

/**
 * Apply additive ALTERs so existing tables match `schema`. Returns the SQL
 * statements applied (empty array = nothing to do). Tables that don't exist
 * yet are skipped — `applySql(generateSql(...))` owns creation.
 */
export async function migrateSchema(pool: Pool, schema: Schema): Promise<string[]> {
  const applied: string[] = [];

  async function run(sql: string): Promise<void> {
    await pool.query(sql);
    applied.push(sql);
  }

  for (const table of Object.values(schema.tables)) {
    const { rows: cols } = await pool.query(
      `SELECT column_name, udt_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1`,
      [table.name],
    );
    if (cols.length === 0) continue; // table not created yet — generateSql's job

    const existing = new Map<string, string>(
      cols.map((c: any) => [c.column_name as string, c.udt_name as string]),
    );
    let addedColumns = false;

    // User-defined columns: warn on drift, add what's missing.
    for (const [col, def] of Object.entries(table.columns)) {
      const udt = existing.get(col);
      if (udt !== undefined) {
        const want = expectedUdt(def);
        if (udt !== want) {
          console.warn(
            `[delta-postgres] Type mismatch for ${table.name}.${col}: schema expects ${columnSqlType(def)} (${want}), database has ${udt}`,
          );
        }
        continue;
      }
      const sqlType = columnSqlType(def);
      let clause: string;
      if (def.nullable) {
        clause = `${q(col)} ${sqlType}`;
      } else {
        const dflt =
          def.default !== undefined
            ? sqlDefault(def.default)
            : sqlDefault(defaultForType(def.type));
        if (dflt === "NULL") {
          // timestamptz/json have no sensible empty default — a NOT NULL add
          // would fail on any existing row, so add nullable and tell the user.
          clause = `${q(col)} ${sqlType}`;
          console.warn(
            `[delta-postgres] ${table.name}.${col} is NOT NULL with no usable default; ` +
              `added NULLABLE — backfill it, then ALTER TABLE ... SET NOT NULL.`,
          );
        } else {
          clause = `${q(col)} ${sqlType} NOT NULL DEFAULT ${dflt}`;
        }
      }
      await run(`ALTER TABLE ${q(table.name)} ADD COLUMN IF NOT EXISTS ${clause}`);
      addedColumns = true;
    }

    // Parent-FK column (a table that gained a `parent` after creation).
    if (table.parent && !existing.has(table.parent.fkColumn)) {
      await run(
        `ALTER TABLE ${q(table.name)} ADD COLUMN IF NOT EXISTS ${q(table.parent.fkColumn)} BIGINT`,
      );
      await run(
        `CREATE INDEX IF NOT EXISTS ${q("idx_" + table.name + "_" + table.parent.fkColumn)} ON ${q(table.name)} (${q(table.parent.fkColumn)})`,
      );
      addedColumns = true;
    }

    // Temporal retrofit (non-temporal → temporal flag flip).
    if (table.temporal && !existing.has("valid_from")) {
      await run(
        `ALTER TABLE ${q(table.name)} ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
      );
      await run(
        `ALTER TABLE ${q(table.name)} ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ`,
      );
      await run(
        `CREATE INDEX IF NOT EXISTS ${q("idx_" + table.name + "_id_valid")} ON ${q(table.name)} (id, valid_to)`,
      );
      addedColumns = true;
      console.warn(
        `[delta-postgres] table "${table.name}" became temporal: added valid_from/valid_to + current_ view, ` +
          `but the composite (id, valid_from) PRIMARY KEY cannot be added by ALTER. ` +
          `Rebuild the table to fully enable temporal versioning.`,
      );
    }

    // A temporal table that gained ANY column needs its current_ view
    // re-created: SELECT * views snapshot columns at creation, so reads
    // through a stale view never see the new column (and delta_apply's
    // view-based row read would then silently drop its value on merge).
    if (table.temporal && addedColumns) {
      await run(
        `CREATE OR REPLACE VIEW ${q("current_" + table.name)} AS SELECT * FROM ${q(table.name)} WHERE valid_to IS NULL`,
      );
    }
  }

  return applied;
}
