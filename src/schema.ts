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

// ---------------------------------------------------------------------------
// Identifier validation — defence-in-depth for the SQL codegen, which
// interpolates these names into DDL. Names must be plain SQL identifiers so a
// quote/backslash/space can never reach the generated SQL.
// ---------------------------------------------------------------------------

/** Plain SQL identifier: starts with a letter/underscore, then word chars. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Doc prefix: identifier-ish, also allowing the `:` and `-` used in doc names. */
const DOC_PREFIX = /^[A-Za-z_][A-Za-z0-9_:-]*$/;
/**
 * Column names are also quoted into DDL via `q()`, which escapes embedded
 * double quotes — but to fail fast we still forbid the chars that could break
 * out of a quoted identifier or an array/JSON literal. We deliberately allow
 * `/` and `~` here (JSON Pointer reference tokens unescape to these), so a
 * column named `c/d` or `e~f` is legal; we only reject quotes, backslash,
 * whitespace, and control characters.
 */
const COLUMN_NAME = /^[^"'\\\s\x00-\x1f]+$/;

function assertIdentifier(value: string, role: string): void {
  if (!SQL_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid ${role}: ${JSON.stringify(value)} — must match ${SQL_IDENTIFIER}`,
    );
  }
}

function assertColumnName(value: string): void {
  if (value.length === 0 || !COLUMN_NAME.test(value)) {
    throw new Error(
      `Invalid column name: ${JSON.stringify(value)} — must not contain ` +
        `quotes, backslashes, or whitespace`,
    );
  }
}

/**
 * A `Schema` that also carries its literal table defs at the TYPE level, so
 * `InferDoc` / `InferRow` can derive client-side row shapes from the same
 * definition that generates the SQL. `$defs` is a phantom — never set at
 * runtime; it exists only for the compiler.
 */
export interface TypedSchema<
  D extends Record<string, TableDef> = Record<string, TableDef>,
> extends Schema {
  readonly $defs?: D;
}

export function defineSchema<const D extends Record<string, TableDef>>(
  defs: D,
): TypedSchema<D> {
  const tables: Record<string, ResolvedTable> = {};

  // First pass: resolve columns and basic properties.
  for (const [key, def] of Object.entries(defs)) {
    assertIdentifier(key, "schema key");
    if (def.table !== undefined) assertIdentifier(def.table, "table name");
    for (const col of Object.keys(def.columns)) {
      assertColumnName(col);
    }
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
  if (!DOC_PREFIX.test(prefix)) {
    throw new Error(
      `Invalid doc prefix: ${JSON.stringify(prefix)} — must match ${DOC_PREFIX}`,
    );
  }
  assertIdentifier(opts.root, "doc root");
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

// ---------------------------------------------------------------------------
// Type inference — derive client row/doc shapes from the schema definition.
//
//   const schema = defineSchema({
//     items: { columns: { name: "text", count: "integer?" } },
//   });
//   type ItemsDoc = InferDoc<typeof schema, "items">;
//   // → { items: Record<string, { id: number | string; name: string; count: number | null }> }
//
// One source of truth: the object you hand to defineSchema also types
// `openDoc<ItemsDoc>(...)`. Purely compile-time — nothing here runs.
// ---------------------------------------------------------------------------

type ColumnTs<T extends ColumnType> =
  T extends "text" | "timestamptz" ? string
  : T extends "integer" | "real" ? number
  : T extends "boolean" ? boolean
  : unknown; // json

/** TS type for one column def or shorthand ("text?" → `string | null`). */
export type InferColumn<C extends ColumnDef | ColumnShorthand> =
  C extends `${infer B extends ColumnType}?` ? ColumnTs<B> | null
  : C extends ColumnType ? ColumnTs<C>
  : C extends ColumnDef
    ? C["nullable"] extends true ? ColumnTs<C["type"]> | null : ColumnTs<C["type"]>
  : never;

/** The parent-FK column a `parent` declaration adds to each row. */
type ParentFk<T extends TableDef> =
  T["parent"] extends string ? { [K in `${T["parent"]}_id`]: number | string }
  : T["parent"] extends { fk: infer F extends string } ? { [K in F]: number | string }
  : {};

/** Row shape for one table def: `id` + parent FK + declared columns. */
export type InferRow<T extends TableDef> =
  { id: number | string }
  & ParentFk<T>
  & { [K in keyof T["columns"]]: InferColumn<T["columns"][K]> };

type DefsOf<S> = S extends TypedSchema<infer D> ? D : never;

/**
 * Doc shape for a `defineDoc` lens over a `defineSchema` result.
 *
 *   InferDoc<typeof schema, "items">                                // list doc
 *   InferDoc<typeof schema, "venues", "areas" | "sites", "single">  // scoped single
 *
 * `Mode` mirrors the runtime scope resolution: "list" (the default — `items:`
 * opens every row as an id-keyed map) renders the root as `Record<string, Row>`;
 * "single" (`venue:42`) renders it as one `Row`. Included collections are
 * always id-keyed maps.
 */
export type InferDoc<
  S extends TypedSchema<any>,
  Root extends keyof DefsOf<S> & string,
  Include extends keyof DefsOf<S> & string = never,
  Mode extends "list" | "single" = "list",
> =
  (Mode extends "single"
    ? { [K in Root]: InferRow<DefsOf<S>[K]> }
    : { [K in Root]: Record<string, InferRow<DefsOf<S>[K]>> })
  & { [K in Include]: Record<string, InferRow<DefsOf<S>[K]>> };
