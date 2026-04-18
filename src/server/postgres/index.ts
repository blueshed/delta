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
 *     createDocListener, registerDocType, docTypeFromDef,
 *   } from "@blueshed/delta/postgres";
 *
 * SQL stored functions live alongside this module in `./sql/`. Load them
 * into your database with your preferred migration tool (they are plain
 * idempotent SQL files; order is alphabetical).
 */

export {
  defineSchema,
  defineDoc,
  loadDocAt,
  createSnapshot,
  resolveSnapshot,
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

export {
  q,
  columnSqlType,
  sqlDefault,
  findCascadeOn,
  defaultForType,
} from "./sql";

export { generateSql } from "./codegen";
export type { GenerateSqlOptions } from "./codegen";

export {
  applyFramework,
  applySql,
  frameworkSql,
  frameworkSqlFiles,
} from "./bootstrap";

export { createDocListener } from "./listener";

export {
  registerDocType,
  resolveDoc,
  clearRegistry,
  docTypeFromDef,
} from "./registry";
export type { DocType } from "./registry";

export { withAppAuth } from "./auth";
export type { DeltaAuth, AuthError, AuthAction } from "./auth";
export { isAuthError, wireAuth, upgradeWithAuth } from "./auth";
