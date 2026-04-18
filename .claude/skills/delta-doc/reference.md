# Delta-doc reference

Full API, patterns, and recipes. The companion `SKILL.md` is the router; start there if you haven't.

## First-time bootstrap

Before anything else your database needs the delta framework tables + stored functions. Two equivalent paths:

**Programmatic** (server owns migrations):

```ts
import { Pool } from "pg";
import {
  applyFramework, applySql, generateSql,
  defineSchema, defineDoc,
} from "@blueshed/delta/postgres";
import { applyAuthJwtSchema } from "@blueshed/delta/auth-jwt";
import { schema, docs } from "./types";

const pool = new Pool({ connectionString: process.env.PG_URL });
await applyFramework(pool);
await applyAuthJwtSchema(pool);                    // if using jwtAuth
await applySql(pool, generateSql(schema, docs));   // your tables
```

**CLI** (docker-entrypoint-initdb.d or a migration tool owns the DB):

```bash
bunx @blueshed/delta init init_db --with-auth
bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql
```

`init` copies `001a-001e-*.sql` (and optionally `002-users.sql` from auth-jwt) into your directory. `sql` runs the codegen. Everything is idempotent.

## Quick start (Postgres backend)

```ts
// server.ts
import { Pool } from "pg";
import { createWs } from "@blueshed/delta/server";
import {
  defineSchema, defineDoc,
  createDocListener, registerDocType, docTypeFromDef,
} from "@blueshed/delta/postgres";
import { wireAuth } from "@blueshed/delta/auth";
import { jwtAuth } from "@blueshed/delta/auth-jwt";

const pool = new Pool({ connectionString: process.env.PG_URL });
const ws = createWs();

const auth = jwtAuth({ pool, secret: process.env.JWT_SECRET! });
wireAuth(ws, auth);

registerDocType(
  docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool, { auth })
);

await createDocListener(ws, pool, { auth });

Bun.serve({
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
```

```tsx
// client.tsx
import { provide, effect } from "@blueshed/railroad";
import { connectWs, WS, openDoc, call } from "@blueshed/delta/client";

provide(WS, connectWs("/ws"));

await call("authenticate", { token: localStorage.token });
const items = openDoc<{ items: Record<string, Item> }>("items:");

effect(() => console.log(items.data.get()));

items.send([
  { op: "add", path: "/items/-", value: { name: "hello", value: 1 } },
]);
```

## Contracts

```ts
// DocType — dispatch unit. Each doc-name prefix owns one.
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

// DocDef — used by docTypeFromDef for generic docs.
interface DocDef {
  prefix: string;
  root: string;                      // main collection key
  include: string[];                 // additional collections in the lens
  scope: Record<string, string>;     // filter map: "<coll>.<col>" → "id" | literal
}

// DeltaAuth — pluggable authentication; identity is yours.
interface DeltaAuth<Identity = unknown> {
  onUpgrade?(req: Request): Promise<Identity | null> | Identity | null;
  actions?: Record<string, (params: any, client: any) =>
    Promise<{ result: any } | { error: string }>>;
  gate(client: any): Identity | { error: string };
  asSqlArg?(identity: Identity): string | number;
}
```

## Schema generation

```ts
import { defineSchema, defineDoc, validateOps } from "@blueshed/delta/postgres";

const schema = defineSchema({
  items: {
    columns: { name: "text", value: "integer", meta: "json?" },
  },
  comments: {
    columns: { body: "text" },
    parent: "items",          // shorthand: fk = items_id
    temporal: true,           // default; adds valid_from/valid_to
  },
  posts: {
    columns: { body: "text", user_id: "integer" },
    cascadeOn: ["user_id"],   // posts.user_id references users
  },
});

// Shorthand types: "text" | "integer" | "real" | "boolean" | "json" | "timestamptz"
// Append "?" for nullable: "text?", "integer?"

const itemsDoc = defineDoc("items:", { root: "items", include: [] });

// Pre-flight op validation (unknown collections/fields, missing required, etc.)
const errors = validateOps(schema, itemsDoc, [
  { op: "add", path: "/items/-", value: { name: "a", value: 1, meta: {} } },
]);
if (errors.length) throw new Error(errors.map(e => e.message).join("\n"));
```

## Doc patterns

**List doc** — prefix matches the whole name; opens every row:

```ts
defineDoc("items:", { root: "items", include: [] });
// open "items:" → { items: { "1": { id: 1, ... }, "2": { ... } } }
```

**Scoped single doc** — prefix + id; scope filters included collections:

```ts
defineDoc("venue:", {
  root: "venues",
  include: ["areas", "sites"],
  scope: {
    "venues.id": "id",          // use the {id} from the doc name
    "areas.venue_id": "id",
    "sites.venue_id": "id",
  },
});
// open "venue:42" → { venues: {...}, areas: [...], sites: [...] } for venue 42 only
```

**Custom DocType** — when the lens isn't expressible as `DocDef`:

```ts
import { registerDocType, type DocType } from "@blueshed/delta/postgres";

const venueAt: DocType<{ venueId: number; at: string }> = {
  prefix: "venue-at:",
  parse(name) {
    const m = name.match(/^venue-at:(\d+):(.+)$/);
    return m ? { venueId: Number(m[1]), at: m[2]! } : null;
  },
  async open(ctx, _name) {
    const { rows } = await pool.query(
      "SELECT venue_snapshot_at($1, $2::timestamptz) AS doc",
      [ctx.venueId, ctx.at],
    );
    return rows[0]?.doc ? { result: rows[0].doc, version: 0 } : null;
  },
  async apply(ctx, _name, ops) {
    const { rows } = await pool.query(
      "SELECT venue_apply_at($1, $2::timestamptz, $3::jsonb) AS r",
      [ctx.venueId, ctx.at, JSON.stringify(ops)],
    );
    return rows[0].r;
  },
};
registerDocType(venueAt);
```

## Authentication

The extension surface is `DeltaAuth<Identity>`. Delta itself reads no credentials — JWT is just the reference.

```ts
// Use the reference JWT impl (requires auth-jwt.sql applied)
import { jwtAuth } from "@blueshed/delta/auth-jwt";
const auth = jwtAuth({ pool, secret: process.env.JWT_SECRET! });

// Or write your own — implement DeltaAuth directly.
const sessionAuth: DeltaAuth<{ id: number }> = {
  onUpgrade(req) {
    const sid = req.headers.get("cookie")?.match(/sid=(\w+)/)?.[1];
    return sid ? lookupSession(sid) : null;
  },
  gate: (c) => c.data.identity ?? { error: "Authentication required" },
  asSqlArg: (i) => i.id,
};
```

**Wire four places:**

```ts
wireAuth(ws, auth);                            // auth.actions → WS "call" handlers
ws.upgrade = upgradeWithAuth(ws, auth);        // auth.onUpgrade → HTTP handshake
docTypeFromDef(def, pool, { auth });           // queries → withAppAuth (RLS session)
createDocListener(ws, pool, { auth });         // gate every open / delta
```

**Token flow — never in the URL.** Two routes:

1. **Upgrade-time** — cookie / `Authorization` header via `onUpgrade`.
2. **In-message** — send `{ action: "call", method: "authenticate", params: { token } }` after connecting unauthenticated.

## RLS with `app.user_id`

With `auth.asSqlArg` set, every `docTypeFromDef` query runs inside `withAppAuth(pool, id, fn)`:

```sql
BEGIN;
SELECT set_config('app.user_id', '<id>', true);  -- SET LOCAL equivalent
-- your query runs here
COMMIT;
```

Postgres policies read it back:

```sql
CREATE POLICY items_owner ON items
  FOR ALL
  USING      (owner_id = current_setting('app.user_id', true)::bigint)
  WITH CHECK (owner_id = current_setting('app.user_id', true)::bigint);

-- Enable + force so even the table owner obeys the policy.
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;
```

**Gotcha:** superusers (including the default `postgres` role) bypass RLS even with FORCE. Create a non-super role and connect as it for RLS-enforced paths.

## Stored functions (read-only contract)

Apply `postgres/sql/001a-001e-*.sql` alphabetically to every database — idempotent. Key functions:

| Function | Purpose |
|---|---|
| `delta_open(doc_name)` | returns `{ ...collections, _version }` |
| `delta_open_at(doc_name, timestamptz)` | same, at a historical instant (temporal docs only) |
| `delta_apply(doc_name, ops jsonb)` | applies ops, writes `_delta_ops_log`, NOTIFYs `delta_changes` |
| `delta_fetch_ops(doc_name, since_version)` | returns (version, ops) rows after a base version |
| `delta_snapshot(name, at)` | pins a timestamp to a label |
| `delta_resolve_snapshot(name)` | looks up a pinned timestamp |
| `delta_prune_ops(keep_interval interval)` | trims `_delta_ops_log` older than interval |

Collections register themselves via `_delta_collections` (`columns_def`, `parent`, `temporal`); docs via `_delta_docs` (`prefix`, `root`, `include`, `scope`). Populated by your generated `002-tables.sql` — never hand-edited.

## Testing

```ts
// tests/setup.ts exports:
newPool()                      // → Pool from DELTA_TEST_PG_URL (defaults to localhost:5433)
applyFramework(pool)           // runs 001*-delta-*.sql in order
applyAuthJwt(pool)             // runs auth-jwt.sql (users + login/register)
applyItemsFixture(pool)        // runs tests/fixtures/items.sql
resetState(pool)               // truncates items, users, _delta_versions, _delta_ops_log
mockClient(data?)              // a WS-shaped test client
sendAndAwait(ws, client, msg)  // drives ws.websocket.message, waits for response
waitFor(predicate, opts?)      // async poll until truthy
```

```ts
// pattern: integration test
beforeAll(async () => {
  pool = await newPool();
  await applyFramework(pool);
  await applyItemsFixture(pool);
});
beforeEach(async () => {
  clearRegistry();
  await resetState(pool);
  registerDocType(docTypeFromDef(defineDoc("items:", { root: "items", include: [] }), pool));
});
```

Run: `bun run db:up` (compose) → `bun run test:all` → `bun run db:down`. Or `bun run ci` (up + check + test + down).

## Wire-level protocol

All WebSocket messages have shape `{ id?: number, action: string, ...rest }`. Responses mirror the id.

| Client → Server | Payload | Server → Client |
|---|---|---|
| `{ action: "open", doc }` | | `{ id, result: <docContents> }` |
| `{ action: "delta", doc, ops }` | | `{ id, result: { ack: true, version } }` |
| `{ action: "open_at", doc, at }` | | `{ id, result: <snapshot> }` |
| `{ action: "close", doc }` | | `{ id, result: { ack: true } }` |
| `{ action: "call", method, params }` | | `{ id, result }` — e.g. `login`, `register`, `authenticate` |

Server-initiated broadcasts (no id):

| Server → Client | Shape |
|---|---|
| Op broadcast | `{ doc, ops: DeltaOp[] }` |

Every message is JSON. Clients use `doc.send(ops)` internally; the protocol is only relevant when writing a custom action handler.
