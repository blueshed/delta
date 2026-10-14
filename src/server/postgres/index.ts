/**
 * @blueshed/delta/postgres — Postgres backend for delta-doc.
 *
 * Schema + stored functions + LISTEN dispatch. Tables are generated from
 * a TypeScript schema definition; all mutations go through stored functions
 * that apply JSON-Patch ops and emit NOTIFY events. The doc-listener fans
 * those events out to WebSocket subscribers.
 *
 *   import {
 *     defineSchema, defineDoc,
 *     createDocListener, docTypeFromDef,
 *   } from "@blueshed/delta/postgres";
 *
 * The stored functions are `src/sql/001*.sql`: `applyFramework(pool)` applies
 * them, or `bunx @blueshed/delta init <dir>` copies them for a migration tool
 * (plain idempotent SQL; order is alphabetical).
 */

export {
  defineSchema,
  defineDoc,
  loadDocAt,
  pruneOpsLog,
  validateOps,
} from "./schema";
export type {
  ColumnDef,
  TableDef,
  Schema,
  ResolvedTable,
  DocDef,
  ValidationError,
} from "./schema";

export { generateSql } from "./codegen";

export { exportTables, importTables } from "./carry";
export type { Snapshot } from "../../schema";
export type { GenerateSqlOptions } from "./codegen";

export {
  applyFramework,
  applySql,
  frameworkSqlFiles,
} from "./bootstrap";

export { migrate, migrationStatus, renameColumn, dropColumn, renameTable, fromFolder } from "./migrate";
export type { Migration, MigrateOptions, MigrateResult, MigrationStatus } from "./migrate";

export { createDocListener, defineCustomDoc } from "./listener";
export type { CustomDocDef } from "./listener";

export { docTypeFromDef } from "./registry";
export type { DocType, Writer } from "./registry";

export { withAppAuth } from "./auth";
export type { DeltaAuth, AuthError, AuthAction } from "./auth";
export { isAuthError, wireAuth, upgradeWithAuth } from "./auth";
