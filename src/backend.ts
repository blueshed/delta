/**
 * @blueshed/delta/backend -- what a backend of delta's builds on: the pieces
 * every delta backend shares (a document's scope, what it shows, the custom
 * documents, the ledger's cursor and writer, the migration runner, the
 * socket's subscriptions), for a backend kept outside this package (dzql, for
 * Postgres) to answer the wire exactly as delta's own do. An app never needs
 * it; `tests/package-exports.test.ts` lists what it gives.
 */
export {
  defaultForType, holdsField, isIsoTime, isoTime, lastId, q, showDoc, showOps, showRow,
  type ColumnDef, type ColumnShorthand, type ColumnType, type DocDef, type ResolvedTable, type Schema, type Snapshot,
  type TableDef, type ValidationError,
} from "./schema";
export { assertScopeKeys, pastSafeId, resolveScope, type Scope } from "./server/scope";
export { dropClientSubscriptions, onClientDrop, trackSubscribe, trackUnsubscribe, type WsServer } from "./server/server";
export { isEntryId, ledgerWho, socketCursor } from "./server/ledger";
export {
  assertOnePrefix, assertOwned, createCustomDocs, NOT_FOUND, sendTo, type CustomDoc, type Owns, type Refusal,
} from "./server/custom";
export { authless, isAuthError, ownerless, type DeltaAuth } from "./server/auth";
export {
  appOf, fenced, fromFolder, isDeltasOwn, runMigrations, statusOf,
  type MigrateOptions, type MigrateResult, type Migration, type MigrationStatus, type Store,
} from "./server/migrate";
