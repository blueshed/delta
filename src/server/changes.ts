/**
 * Migrations as a history from empty (the Django way): each
 * migration a list of changes -- a table made, a column added, renamed or dropped -- that every
 * backend knows how to make (SQLite here, Postgres in dzql). Folded in order, the changes are the
 * tables the history leads to (`stateOf`); what the definitions say beyond them (`diff`) is the
 * next migration, written by `delta migrations make` (`writeMigration`), never by hand but for what a
 * diff cannot know: a rename, a change of type, moving data (`up`).
 *
 *   // migrations/001-people.ts, as make writes it
 *   import { createTable } from "@blueshed/delta/migrations";
 *   export const changes = [createTable("people", { columns: { name: { type: "text" } }, temporal: false })];
 *
 * What a table is here is what the database holds of it: its name, its columns, its parent's key,
 * and whether it keeps versions. `cascadeOn` is the definitions' alone (a remove's reach, not a
 * column), and is not part of a migration.
 */
import { defineSchema, type ColumnDef, type ColumnShorthand, type Schema, type TableDef } from "../schema";

/** A table as a migration makes it: its name, columns, parent's key and versions. */
export type TableState = { table: string; columns: Record<string, ColumnDef>; parent?: { collection: string; fk: string }; temporal: boolean };
/** The tables a history leads to, by collection key. */
export type State = Record<string, TableState>;

export type Change =
  | { change: "createTable"; key: string; table: TableState }
  | { change: "dropTable"; key: string }
  | { change: "renameTable"; key: string; to: string }
  | { change: "addColumn"; key: string; column: string; def: ColumnDef }
  | { change: "dropColumn"; key: string; column: string }
  | { change: "renameColumn"; key: string; column: string; to: string };

const column = (def: ColumnDef | ColumnShorthand): ColumnDef => {
  if (typeof def !== "string") return { type: def.type, ...(def.nullable ? { nullable: true } : {}), ...(def.default !== undefined ? { default: def.default } : {}) };
  return def.endsWith("?") ? { type: def.slice(0, -1) as ColumnDef["type"], nullable: true } : { type: def as ColumnDef["type"] };
};

/** A table as a definition gives it (`defineSchema`'s input), as a migration makes it. */
export function tableOf(key: string, def: TableDef): TableState {
  const parent = typeof def.parent === "string" ? { collection: def.parent, fk: `${def.parent}_id` } : def.parent ? { ...def.parent } : undefined;
  return {
    table: def.table ?? key,
    columns: Object.fromEntries(Object.entries(def.columns).map(([c, d]) => [c, column(d)])),
    ...(parent ? { parent } : {}),
    temporal: def.temporal ?? true,
  };
}

/** Make a table: `createTable("people", { columns: { name: "text" }, temporal: false })`. */
export const createTable = (key: string, def: TableDef): Change => ({ change: "createTable", key, table: tableOf(key, def) });
/** Drop a table, and every row of it. */
export const dropTable = (key: string): Change => ({ change: "dropTable", key });
/** Rename a collection, and its table (where its table was named as its key). */
export const renameTable = (key: string, to: string): Change => ({ change: "renameTable", key, to });
/** Add a column: every row takes its default, or null. */
export const addColumn = (key: string, name: string, def: ColumnDef | ColumnShorthand): Change => ({ change: "addColumn", key, column: name, def: column(def) });
/** Drop a column, and its values. */
export const dropColumn = (key: string, name: string): Change => ({ change: "dropColumn", key, column: name });
/** Rename a column, keeping its values. */
export const renameColumn = (key: string, name: string, to: string): Change => ({ change: "renameColumn", key, column: name, to });

/** The tables after one change, from those before it; a change that names what is not there is refused. */
export function applyChange(state: State, c: Change): State {
  const next: State = structuredClone(state);
  const table = (key: string) => {
    const t = next[key];
    if (!t) throw new Error(`[delta-migrate] ${c.change} names a collection the history has not made: ${key}`);
    return t;
  };
  switch (c.change) {
    case "createTable":
      if (next[c.key]) throw new Error(`[delta-migrate] createTable: ${c.key} is made already`);
      next[c.key] = structuredClone(c.table);
      break;
    case "dropTable":
      table(c.key);
      delete next[c.key];
      break;
    case "renameTable": {
      const t = table(c.key);
      if (next[c.to]) throw new Error(`[delta-migrate] renameTable: ${c.to} is there already`);
      delete next[c.key];
      next[c.to] = { ...t, table: t.table === c.key ? c.to : t.table };
      for (const other of Object.values(next)) if (other.parent?.collection === c.key) other.parent.collection = c.to;
      break;
    }
    case "addColumn": {
      const t = table(c.key);
      if (t.columns[c.column]) throw new Error(`[delta-migrate] addColumn: ${c.key}.${c.column} is there already`);
      t.columns[c.column] = { ...c.def };
      break;
    }
    case "dropColumn": {
      const t = table(c.key);
      if (!t.columns[c.column]) throw new Error(`[delta-migrate] dropColumn: ${c.key} has no column ${c.column}`);
      delete t.columns[c.column];
      break;
    }
    case "renameColumn": {
      const t = table(c.key);
      if (!t.columns[c.column]) throw new Error(`[delta-migrate] renameColumn: ${c.key} has no column ${c.column}`);
      if (t.columns[c.to]) throw new Error(`[delta-migrate] renameColumn: ${c.key} has a column ${c.to} already`);
      t.columns = Object.fromEntries(Object.entries(t.columns).map(([k, d]) => [k === c.column ? c.to : k, d]));
      break;
    }
  }
  return next;
}

/** The tables a history leads to: every change of every migration, in order. */
export function stateOf(migrations: { changes?: Change[] }[]): State {
  return migrations.reduce((s, m) => (m.changes ?? []).reduce(applyChange, s), {} as State);
}

/** The definitions' tables, as a migration makes them. */
export function stateOfSchema(schema: Schema): State {
  return Object.fromEntries(Object.entries(schema.tables).map(([key, t]) => [key, {
    table: t.name,
    columns: Object.fromEntries(Object.entries(t.columns).map(([c, d]) => [c, column(d)])),
    ...(t.parent ? { parent: { collection: t.parent.collection, fk: t.parent.fkColumn } } : {}),
    temporal: t.temporal,
  }]));
}

/** The definitions the history's tables are: what a backend makes from them (its `createTables`). */
export const schemaOf = (state: State): Schema =>
  defineSchema(Object.fromEntries(Object.entries(state).map(([key, t]) => [key, { table: t.table, columns: t.columns, parent: t.parent, temporal: t.temporal } satisfies TableDef])));

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What the definitions say beyond the history: the changes that make one into the other, and what a
 * diff cannot make (`byHand`: a column whose type, nullability or default changed; a table's name,
 * parent or versions changed), said for a person to write. A column gone and one new in the same
 * table may be a rename: the diff drops and adds, and says so (`byHand`), for a person to make it
 * `renameColumn` if it is one.
 */
export function diff(state: State, schema: Schema): { changes: Change[]; byHand: string[] } {
  const want = stateOfSchema(schema);
  const changes: Change[] = [];
  const byHand: string[] = [];
  for (const [key, t] of Object.entries(want)) {
    const was = state[key];
    if (!was) {
      changes.push({ change: "createTable", key, table: t });
      continue;
    }
    if (was.table !== t.table) byHand.push(`${key}: its table is ${t.table}, was ${was.table}: renameTable, or an up()`);
    if (!same(was.parent, t.parent)) byHand.push(`${key}: its parent is ${JSON.stringify(t.parent ?? null)}, was ${JSON.stringify(was.parent ?? null)}: an up()`);
    if (was.temporal !== t.temporal) byHand.push(`${key}: temporal is ${t.temporal}, was ${was.temporal}: an up()`);
    const gone = Object.keys(was.columns).filter((c) => !(c in t.columns));
    const added = Object.keys(t.columns).filter((c) => !(c in was.columns));
    for (const c of added) changes.push({ change: "addColumn", key, column: c, def: t.columns[c]! });
    for (const c of gone) changes.push({ change: "dropColumn", key, column: c });
    if (gone.length && added.length) byHand.push(`${key}: ${gone.join(", ")} gone and ${added.join(", ")} new: if one is the other renamed, make it renameColumn (a drop loses its values)`);
    for (const c of Object.keys(t.columns)) {
      if (c in was.columns && !same(was.columns[c], t.columns[c])) byHand.push(`${key}.${c}: ${JSON.stringify(t.columns[c])}, was ${JSON.stringify(was.columns[c])}: an up()`);
    }
  }
  for (const key of Object.keys(state)) if (!(key in want)) changes.push({ change: "dropTable", key });
  return { changes, byHand };
}

/** A value as TypeScript a person would write: `{ name: { type: "text" } }`, keys unquoted where they may be. */
function literal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(literal).join(", ")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return "{}";
    return `{ ${entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${literal(x)}`).join(", ")} }`;
  }
  return JSON.stringify(v);
}

/** A change as TypeScript, as a person would write it. */
function source(c: Change): string {
  const s = literal;
  switch (c.change) {
    case "createTable": {
      const { table, columns, parent, temporal } = c.table;
      const def = { ...(table !== c.key ? { table } : {}), columns, ...(parent ? { parent } : {}), temporal };
      return `createTable(${s(c.key)}, ${s(def)})`;
    }
    case "dropTable": return `dropTable(${s(c.key)})`;
    case "renameTable": return `renameTable(${s(c.key)}, ${s(c.to)})`;
    case "addColumn": return `addColumn(${s(c.key)}, ${s(c.column)}, ${s(c.def)})`;
    case "dropColumn": return `dropColumn(${s(c.key)}, ${s(c.column)})`;
    case "renameColumn": return `renameColumn(${s(c.key)}, ${s(c.column)}, ${s(c.to)})`;
  }
}

/** The next migration's file: its changes, and what is for a person to write, as comments. */
export function writeMigration(changes: Change[], byHand: string[] = [], from = "@blueshed/delta/migrations"): string {
  const used = [...new Set(changes.map((c) => c.change))].sort();
  return [
    "// Made by `delta migrations make` from the definitions: what they say beyond the migrations before it.",
    ...byHand.map((b) => `// By hand: ${b}`),
    used.length ? `import { ${used.join(", ")} } from ${JSON.stringify(from)};` : "",
    "",
    "export const changes = [",
    ...changes.map((c) => `  ${source(c)},`),
    "];",
    "",
  ].join("\n");
}
