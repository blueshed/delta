/**
 * Codegen — turn a TypeScript schema (`defineSchema`) and a set of doc
 * definitions (`defineDoc`) into the SQL that registers both with the
 * delta-doc framework.
 *
 * Output includes:
 *   - CREATE SEQUENCE / CREATE TABLE (+ current_* view for temporal tables)
 *   - Helper indexes
 *   - INSERT INTO _delta_collections (columns_def, parent, temporal, cascade_on)
 *   - INSERT INTO _delta_docs       (prefix, root_collection, include, scope)
 *
 * Everything is idempotent (CREATE … IF NOT EXISTS, ON CONFLICT DO UPDATE),
 * so the same file can be re-applied to a live database after a schema change.
 *
 * Drive it from your project's `types.ts`:
 *
 *   import { generateSql } from "@blueshed/delta/postgres";
 *   import { schema, docs } from "./types";
 *   await Bun.write("init_db/002-tables.sql", generateSql(schema, docs));
 *
 * Or from the bundled CLI:
 *
 *   bunx @blueshed/delta sql ./types.ts --out init_db/002-tables.sql
 */
import type { Schema, DocDef } from "./schema";
import { q, columnSqlType, sqlDefault, findCascadeOn } from "./sql";

export interface GenerateSqlOptions {
  /** Header comment included at the top of the file. */
  header?: string;
  /** Override the regenerate-command hint printed in the header. */
  regenerate?: string;
}

export function generateSql(
  schema: Schema,
  docs: DocDef[],
  opts: GenerateSqlOptions = {},
): string {
  const today = new Date().toISOString().slice(0, 10);
  const header =
    opts.header ?? "GENERATED FROM types.ts — DO NOT EDIT";
  const regen = opts.regenerate ?? "bunx @blueshed/delta sql ./types.ts";

  const lines: string[] = [
    "-- =========================================================================",
    `-- ${header}`,
    `-- Generated: ${today}`,
    `-- Regenerate: ${regen}`,
    "-- =========================================================================",
    "",
  ];

  for (const [key, table] of Object.entries(schema.tables)) {
    const seqName = `seq_${table.name}`;
    lines.push(`-- ${key}`);
    lines.push(`CREATE SEQUENCE IF NOT EXISTS ${q(seqName)};`);
    lines.push("");

    const cols: string[] = [
      `id BIGINT NOT NULL DEFAULT nextval('${seqName}')`,
    ];
    if (table.parent) {
      cols.push(`${q(table.parent.fkColumn)} BIGINT NOT NULL`);
    }

    for (const [col, def] of Object.entries(table.columns)) {
      const sqlType = columnSqlType(def);
      const notNull = def.nullable ? "" : " NOT NULL";
      const defaultVal =
        def.default !== undefined ? ` DEFAULT ${sqlDefault(def.default)}` : "";
      cols.push(`${q(col)} ${sqlType}${notNull}${defaultVal}`);
    }

    if (table.temporal) {
      cols.push("valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW()");
      cols.push("valid_to TIMESTAMPTZ");
      cols.push("PRIMARY KEY (id, valid_from)");
    } else {
      cols.push("PRIMARY KEY (id)");
    }

    lines.push(`CREATE TABLE IF NOT EXISTS ${q(table.name)} (`);
    lines.push(cols.map((c) => `  ${c}`).join(",\n"));
    lines.push(");");

    if (table.temporal) {
      lines.push(
        `CREATE OR REPLACE VIEW ${q("current_" + table.name)} AS SELECT * FROM ${q(table.name)} WHERE valid_to IS NULL;`,
      );
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${q("idx_" + table.name + "_id_valid")} ON ${q(table.name)} (id, valid_to);`,
      );
    }
    if (table.parent) {
      lines.push(
        `CREATE INDEX IF NOT EXISTS ${q("idx_" + table.name + "_" + table.parent.fkColumn)} ON ${q(table.name)} (${q(table.parent.fkColumn)});`,
      );
    }
    lines.push("");
  }

  // Collection metadata
  lines.push("-- Collection metadata");
  for (const [key, table] of Object.entries(schema.tables)) {
    const cascadeOn = JSON.stringify(findCascadeOn(key, schema));
    const colsDef = JSON.stringify(table.columns).replace(/'/g, "''");
    const parent = table.parent ? `'${table.parent.collection}'` : "NULL";
    const parentFk = table.parent ? `'${table.parent.fkColumn}'` : "NULL";
    lines.push(
      `INSERT INTO _delta_collections (collection_key, table_name, columns_def, parent_collection, parent_fk, temporal, cascade_on)`,
    );
    lines.push(
      `  VALUES ('${key}', '${table.name}', '${colsDef}', ${parent}, ${parentFk}, ${table.temporal}, '${cascadeOn}')`,
    );
    lines.push(
      `  ON CONFLICT (collection_key) DO UPDATE SET table_name = EXCLUDED.table_name, columns_def = EXCLUDED.columns_def,`,
    );
    lines.push(
      `    parent_collection = EXCLUDED.parent_collection, parent_fk = EXCLUDED.parent_fk, temporal = EXCLUDED.temporal, cascade_on = EXCLUDED.cascade_on;`,
    );
  }
  lines.push("");

  // Doc definitions
  lines.push("-- Doc definitions");
  for (const doc of docs) {
    const include = doc.include.length
      ? `'{${doc.include.join(",")}}'`
      : "'{}'";
    const scope = JSON.stringify(doc.scope).replace(/'/g, "''");
    lines.push(
      `INSERT INTO _delta_docs (prefix, root_collection, include, scope)`,
    );
    lines.push(
      `  VALUES ('${doc.prefix}', '${doc.root}', ${include}, '${scope}')`,
    );
    lines.push(
      `  ON CONFLICT (prefix) DO UPDATE SET root_collection = EXCLUDED.root_collection, include = EXCLUDED.include, scope = EXCLUDED.scope;`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
