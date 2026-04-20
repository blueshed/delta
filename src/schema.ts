/**
 * Shared schema primitives — identical across Postgres and SQLite backends.
 *
 * Both backends declare their tables via the same `defineSchema` + `defineDoc`
 * vocabulary, and the resolved shape (`Schema`, `ResolvedTable`, `DocDef`)
 * travels between `generateSql`, `registerDocs`, the doc registry, and the
 * validation helpers. Keeping these definitions in one place prevents the
 * two backends from silently drifting apart on column shorthand, parent-fk
 * resolution, or cascade wiring.
 *
 * Column type union: the superset of what both backends accept. SQLite maps
 * `timestamptz` to `TEXT` (ISO-8601); Postgres uses the native type. Each
 * backend's codegen / default / validation helpers own the per-type
 * mappings — this module is the vocabulary only.
 */

export type ColumnType =
  | "text" | "integer" | "real" | "boolean" | "json" | "timestamptz";

export interface ColumnDef {
  type: ColumnType;
  nullable?: boolean;
  default?: unknown;
}

/** Compact shorthand: `"text"` or `"text?"` (nullable). */
export type ColumnShorthand =
  | "text" | "integer" | "real" | "boolean" | "json" | "timestamptz"
  | "text?" | "integer?" | "real?" | "boolean?" | "json?" | "timestamptz?";

export interface TableDef {
  /** SQL table name (defaults to the schema key). */
  table?: string;
  /** Column definitions. */
  columns: Record<string, ColumnDef | ColumnShorthand>;
  /** Parent collection. String = collection key (FK auto-derived as `<key>_id`);
   *  object = explicit FK column. */
  parent?: string | { collection: string; fk: string };
  /** FK columns that trigger cascade deletes when the referenced row is removed.
   *  String = FK column name (collection derived by convention);
   *  object = explicit FK column + collection. */
  cascadeOn?: (string | { fk: string; collection: string })[];
  /** Set to `false` to disable temporal versioning (valid_from/valid_to). Default: `true`. */
  temporal?: boolean;
}

export interface Schema {
  tables: Record<string, ResolvedTable>;
}

export interface ResolvedTable {
  /** SQL table name. */
  name: string;
  /** Schema key. */
  docKey: string;
  columns: Record<string, ColumnDef>;
  parent?: { collection: string; fkColumn: string };
  temporal: boolean;
  /** Computed: collections that have this table as parent. */
  children: string[];
  /** Computed: collections that reference this table via `cascadeOn`. */
  referencedBy: { collection: string; fkColumn: string }[];
}

export interface DocDef {
  prefix: string;
  root: string;
  include: string[];
  scope: Record<string, string>;
}

// ---------------------------------------------------------------------------
// defineSchema — build a resolved Schema from a table-def record.
// ---------------------------------------------------------------------------

export function defineSchema(defs: Record<string, TableDef>): Schema {
  const tables: Record<string, ResolvedTable> = {};

  // First pass: resolve columns and basic properties.
  for (const [key, def] of Object.entries(defs)) {
    const columns: Record<string, ColumnDef> = {};
    for (const [col, shorthand] of Object.entries(def.columns)) {
      if (typeof shorthand === "string") {
        const nullable = shorthand.endsWith("?");
        const type = (nullable ? shorthand.slice(0, -1) : shorthand) as ColumnType;
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

  // Second pass: compute children and referencedBy across the resolved table set.
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
          (k) => k === stem || k === stem + "s"
              || tables[k]!.name === stem || tables[k]!.name === stem + "s",
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
// defineDoc — a document lens into the schema. Prefix + root + includes + scope.
// ---------------------------------------------------------------------------

export function defineDoc(
  prefix: string,
  opts: { root: string; include: string[]; scope?: Record<string, string> },
): DocDef {
  return {
    prefix,
    root: opts.root,
    include: opts.include,
    scope: opts.scope ?? {},
  };
}

// ---------------------------------------------------------------------------
// ValidationError — shared by both backends' `validateOps` helpers.
// ---------------------------------------------------------------------------

export interface ValidationError {
  path: string;
  message: string;
}
