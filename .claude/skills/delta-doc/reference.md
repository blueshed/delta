# Delta-doc reference

Contracts and rare patterns. The skill's runbook (`SKILL.md`) handles the
common scenarios via templates in `templates/`. Read this file only when a
template doesn't cover the case.

## The primitive

```ts
type DeltaOp =
  | { op: "replace"; path: string; value: unknown }  // set at path
  | { op: "add";     path: string; value: unknown }  // set, or append with /-
  | { op: "remove";  path: string };                 // delete by path
```

Paths: `/collection` (list), `/collection/id` (row), `/collection/id/field` (field), `/collection/-` (append).

## Contracts

```ts
// DocType — one per doc-name prefix. Registered via registerDocType.
interface DocType<C = any, I = unknown> {
  prefix: string;
  parse(docName: string): C | null;
  open(ctx: C, docName: string, msg?: any, identity?: I):
    Promise<{ result: any; version: number } | null>;
  apply(ctx: C, docName: string, ops: DeltaOp[], identity?: I):
    Promise<{ version: number; ops?: any[] }>;
  openAt?(ctx: C, docName: string, at: string, identity?: I):
    Promise<any | null>;
}

// DocDef — input to docTypeFromDef for framework-generic docs.
interface DocDef {
  prefix: string;
  root: string;                      // main collection key
  include: string[];                 // additional collections in the lens
  scope: Record<string, string>;     // filter map
}

// DeltaAuth — pluggable authentication; identity type is yours.
interface DeltaAuth<Identity = unknown> {
  onUpgrade?(req: Request): Promise<Identity | null> | Identity | null;
  actions?: Record<string, (params: any, client: any) =>
    Promise<{ result: any } | { error: string }>>;
  gate(client: any): Identity | { error: string };
  asSqlArg?(identity: Identity): string | number;
}

// DeltaError — shape of call()/send() rejections. Narrow with isDeltaError.
interface DeltaError { code: number; message: string; }
```

## Scope syntax (DocDef.scope)

| Syntax | Meaning |
|---|---|
| `"col": ":id"` | equality: `col = <id-from-doc-name>` (shorthand for `"=:id"`) |
| `"col": "=:name"` | equality: `col = <named-param>` |
| `"col": "<=:end"` | range: `col <= <named-param>` |
| `"col": ">=:start"` | range: `col >= <named-param>` |
| `"col": "like:prefix"` | `col ILIKE <named-param>%` |
| `"col": "at:when"` | temporal snapshot (not a WHERE) |

Named params are resolved positionally from the colon-separated doc id. `id` always takes position 1; others are alphabetical.

## Stored function contract (read-only)

Applied via `delta init` → `init_db/001a-001e-*.sql`. Do not edit.

| Function | Purpose |
|---|---|
| `delta_open(doc_name)` | returns `{ ...collections, _version }` |
| `delta_open_at(doc_name, timestamptz)` | temporal snapshot (temporal docs only) |
| `delta_apply(doc_name, ops jsonb)` | applies ops, writes `_delta_ops_log`, NOTIFYs `delta_changes` |
| `delta_fetch_ops(doc_name, since_version)` | ops after a base version |
| `delta_snapshot(name, at)` | pin a timestamp to a label |
| `delta_resolve_snapshot(name)` | look up a pinned timestamp |
| `delta_prune_ops(keep_interval)` | trim `_delta_ops_log` older than interval |

Collections register via `_delta_collections`; docs via `_delta_docs`. These are populated by `init_db/003-tables.sql` from `generateSql(schema, docs)` — never hand-written.

## Wire-level protocol

All WebSocket messages: `{ id?: number, action: string, ...rest }`. Responses mirror the id.

| Client → Server | Server → Client |
|---|---|
| `{ action: "open", doc }` | `{ id, result: <docContents> }` |
| `{ action: "delta", doc, ops }` | `{ id, result: { ack: true, version } }` |
| `{ action: "open_at", doc, at }` | `{ id, result: <snapshot> }` |
| `{ action: "close", doc }` | `{ id, result: { ack: true } }` |
| `{ action: "call", method, params }` | `{ id, result }` or `{ id, error: { code, message } }` |

Server-initiated (no id): op broadcast `{ doc, ops: DeltaOp[] }`.

## `withAppAuth` and RLS

```sql
-- Framework transaction (inside withAppAuth):
BEGIN;
SELECT set_config('app.user_id', '<id>', true);  -- SET LOCAL can't bind params
-- your query runs here
COMMIT;
```

Policies read it back with `current_setting('app.user_id', true)::bigint`. FORCE ROW LEVEL SECURITY is required so table owners obey the policy. Superusers still bypass — always use a non-super role for doc queries (see `templates/per-user/app.sql`).

## When to read source

Prefer the files at the top of each module (each has a JSDoc header):

`core.ts` · `client.ts` · `server.ts` · `sqlite.ts` · `logger.ts` · `auth.ts` · `auth-jwt.ts` · `cli.ts`
`postgres/index.ts` · `postgres/schema.ts` · `postgres/codegen.ts` · `postgres/bootstrap.ts` · `postgres/listener.ts` · `postgres/registry.ts` · `postgres/auth.ts`
