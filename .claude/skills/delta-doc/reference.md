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

**`docker-entrypoint-initdb.d`** — the cleanest setup for a fresh volume: mount your `init_db/` into the Postgres image and let it apply the SQL on first start. No boot-time application code.

```yaml
# compose.yml
services:
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_DB: myapp
      POSTGRES_USER: myapp
      POSTGRES_PASSWORD: myapp
    volumes:
      - ./init_db:/docker-entrypoint-initdb.d:ro
      - myapp_pgdata:/var/lib/postgresql/data
    ports: ["5432:5432"]
volumes:
  myapp_pgdata:
```

Postgres applies `.sql` files in the mounted dir alphabetically on the first boot against an empty data volume. Subsequent boots skip. Re-run `docker compose down -v` to start fresh.

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
import { connectWs, WS, openDoc, call, DeltaError } from "@blueshed/delta/client";

provide(WS, connectWs("/ws"));

// Await authenticate BEFORE openDoc — an open sent on an unauthenticated
// connection races ahead of auth and is rejected with 401.
await call("authenticate", { token: localStorage.token });

const items = openDoc<{ items: Record<string, Item> }>("items:");
effect(() => console.log(items.data.get()));

try {
  await items.send([
    { op: "add", path: "/items/-", value: { name: "hello", value: 1 } },
  ]);
} catch (err) {
  if (DeltaError.isDeltaError(err)) console.warn(`${err.code}: ${err.message}`);
  else throw err;
}

// Sign out: clear identity on the socket (stays connected).
await call("logout");
```

**Session restore** — the client above assumes `localStorage.token` is set. For the full restore-on-load flow (present everywhere a real app ships), wrap bootstrap in a check:

```ts
async function bootstrap() {
  const token = localStorage.getItem("token");
  if (!token) return showLogin();
  try {
    const user = await call<User>("authenticate", { token });
    showApp(user);
  } catch {
    localStorage.removeItem("token");  // stale or revoked
    showLogin();
  }
}

async function login(email: string, password: string) {
  const user = await call<User & { token: string }>("login", { email, password });
  localStorage.setItem("token", user.token);
  showApp(user);
}
```

Token never goes in the WS URL — it's always in-band via `call("authenticate", ...)`.

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

## `scope` syntax

`defineDoc`'s `scope` map uses a compact DSL. Values with a leading colon read **from the doc-name context** (positional params extracted after the prefix). Plain strings are literal captures (normally just `"id"` — the first positional param from the doc name). **The leading `:` matters.**

| Value | Meaning |
|---|---|
| `":id"` | `col = <id-from-doc-name>` — positional param named `id` |
| `":name"` | `col = <name-from-doc-name>` — positional param named `name` |
| `"id"` | literal capture — equivalent to `":id"` but older form used in scoped-single docs |
| `"=:name"` | explicit equality |
| `"<=:end"` | `col <= <end-param>` |
| `">=:start"` | `col >= <start-param>` |
| `"like:prefix"` | `col ILIKE <prefix-param>%` |
| `"at:when"` | temporal snapshot (not a WHERE) |

Named params are resolved positionally from the colon-separated doc id. `id` always takes position 1; other names are alphabetical. `todos:5` has one param; `venue-at:42:2026-06-16` has two (`id=42`, second positional).

**Scope keys must be real columns of the root collection.** `scope: { id: ":id" }` works; `scope: { "items.id": ":id" }` raises at open time with `scope key "items.id" is not a column of "items" (valid keys: id, …)`. For a scoped-single doc, you can omit `scope` entirely — the framework defaults to `WHERE id = <doc-id>`.

## Doc patterns

**List doc** — prefix matches the whole name; opens every row:

```ts
defineDoc("items:", { root: "items", include: [] });
// open "items:" → { items: { "1": { id: 1, ... }, "2": { ... } } }
```

**Scoped single doc** — prefix + id; the `scope` filters the *root* collection, and `include` collections travel along their declared `parent_fk` relationships (from `defineSchema`).

```ts
const schema = defineSchema({
  venues: { columns: { name: "text" } },
  areas:  { columns: { name: "text" }, parent: "venues" },   // → venues_id
  sites:  { columns: { name: "text" }, parent: "venues" },   // → venues_id
});

defineDoc("venue:", {
  root: "venues",
  include: ["areas", "sites"],
  scope: { id: ":id" },          // scope keys must be bare columns of `venues`
});
// open "venue:42" → { venues: {...}, areas: {...}, sites: {...} } for venue 42 only.
// The includes are filtered by their parent_fk (venues_id = 42) via _delta_load_collection.
// You can omit `scope` entirely — an empty scope on a single-mode open defaults to
// `WHERE id = <doc-id>` which is the same thing.
```

**Per-user list isolation** — each user sees only their own rows. The most common multi-tenant shape.

Two parts: (1) scope the generic doc by a user-id carried in the doc name, (2) wrap `docTypeFromDef` with an identity check that the doc-name id matches the authenticated identity. The wrap also injects the owner id on `add` so the user can't forge other users' rows.

```ts
// types.ts
export const schema = defineSchema({
  todos: {
    columns: { owner_id: "integer", text: "text", done: { type: "boolean", default: false } },
    temporal: false,
  },
});

export const docs = [
  defineDoc("todos:", {
    root: "todos",
    include: [],
    scope: { owner_id: ":id" },   // read  /<id> from the doc name
  }),
];
```

```ts
// server.ts — register a scoped-per-user DocType
import { defineDoc, docTypeFromDef, registerDocType, type DocType } from "@blueshed/delta/postgres";
import type { User } from "@blueshed/delta/auth-jwt";
import type { DeltaOp } from "@blueshed/delta/core";

const generic = docTypeFromDef(
  defineDoc("todos:", { root: "todos", include: [], scope: { owner_id: ":id" } }),
  pool,
  { auth },
);

const myTodos: DocType<{ userId: number }, User> = {
  prefix: "todos:",
  parse(name) {
    const m = name.match(/^todos:(\d+)$/);
    return m ? { userId: Number(m[1]) } : null;
  },
  async open(ctx, name, msg, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) return null; // 404, not 403
    return generic.open({}, name, msg, identity);
  },
  async apply(ctx, name, ops, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) {
      throw Object.assign(new Error("Forbidden"), { code: 403 });
    }
    // Inject owner_id on adds so the user can't forge rows for someone else.
    const safeOps: DeltaOp[] = ops.map((op) =>
      op.op === "add" && op.path === "/todos/-"
        ? { ...op, value: { ...(op.value as object), owner_id: ctx.userId } }
        : op,
    );
    return generic.apply({}, name, safeOps, identity);
  },
};
registerDocType(myTodos);
```

```tsx
// client — each user opens their own stream, channel isolation is automatic
const me = (await call<User>("authenticate", { token })).id;
const myTodos = openDoc<{ todos: Record<string, Todo> }>(`todos:${me}`);
```

*Why inject `owner_id` AND have RLS `WITH CHECK`?* Two layers, each catches different failures cheaply. The policy is the authoritative guarantee — even a buggy server can't leak across users because the database refuses. The injection is an ergonomic wrapper: clients don't need to send `owner_id`, and a forged payload fails locally with a clear `Forbidden` rather than a round-trip to Postgres with a cryptic RLS error. Defence in depth, plus cleaner error surface.

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

**Identity switching on a live socket.** `jwtAuth` ships a `logout` action that clears `client.data.identity`. Client usage:

```ts
await call("logout");              // server-side: delete client.data.identity
localStorage.removeItem("token");
// Next open/delta will fail the gate with 401 until the user re-authenticates.
```

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

**Gotcha:** superusers (including the default `postgres` role) bypass RLS even with FORCE. Use **two pools** — an admin role for schema + auth (login/register mutate `users` unscoped), a non-super role for all doc queries.

```sql
-- One-time setup, as the admin role:
CREATE ROLE app LOGIN PASSWORD 'app-secret';
GRANT CONNECT ON DATABASE mydb TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
-- `app` has no BYPASSRLS, so FORCE ROW LEVEL SECURITY policies apply.
```

```ts
// server.ts — two pools
import { Pool } from "pg";

const adminPool = new Pool({ connectionString: process.env.PG_ADMIN_URL });  // postgres user
const appPool   = new Pool({ connectionString: process.env.PG_APP_URL });    // app user

// Auth uses the admin pool (writes to `users`, which the app role can't modify).
const auth = jwtAuth({ pool: adminPool, secret: process.env.JWT_SECRET! });

// Doc queries use the app pool so RLS policies bind.
registerDocType(docTypeFromDef(def, appPool, { auth }));
await createDocListener(ws, appPool, { auth });
```

Under this setup `withAppAuth(appPool, ...)` sets `app.user_id` as the `app` role, and the policy `USING (owner_id = current_setting('app.user_id')::bigint)` filters without the role bypassing it.

**Error surfaces leak names, not values.** `_delta_resolve_scope`'s fail-fast raises (unknown doc prefix, unknown root collection, invalid scope key) include the offending identifier in the error message, and `createDocListener` propagates those messages back to the client as `{error: {code: 500, message: ...}}`. That's deliberate — it's what makes delta easy to debug from a Claude session reading the error. The side-effect is a tenant with direct WS access can enumerate registered doc prefixes / collection columns by probing bad inputs. Two rules to stay clean: (1) don't encode tenant-sensitive identifiers in doc-name prefixes (`tenant-42:` bad; `boards:42` fine — the id is already per-identity-gated); (2) if your WS server is public-facing and column names are sensitive, scrub the `500` branch in `createDocListener` before sending to the wire.

## Bun HTML route + WebSocket on the same server

`ws.upgrade` is a function that Bun's router recognises as a WebSocket upgrade handler. HTML route handlers are just imported `.html` files. Register both on the same `Bun.serve`:

```ts
import indexHtml from "./client/index.html";

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/": indexHtml,                 // Bun bundles the HTML + referenced TSX/CSS
    [ws.path]: ws.upgrade,          // WebSocket upgrade (default ws.path = "/ws")
  },
  websocket: ws.websocket,
  development: { hmr: true },
});
ws.setServer(server);               // let ws.publish() reach the server
```

Order doesn't matter — the WebSocket upgrade is a distinct HTTP request (`Upgrade: websocket` header), so it doesn't conflict with the HTML route at `/`.

## Rendering collections with op-level precision

The `doc.data` signal is great for read-only views and small docs. For a list of N rows where a single op changes one field on one row, re-rendering from `doc.data` on every change throws away N-1 rows' worth of DOM state (focus, scroll, inputs in flight, CSS transitions). Delta already knows exactly which row changed — `doc.onOps(handler)` delivers the raw ops.

The canonical pattern:

```tsx
import { openDoc } from "@blueshed/delta/client";
import { applyOpsToCollection, type DomCollection } from "@blueshed/delta/dom-ops";

interface Todo { id: number; text: string; done: boolean; }

const doc = openDoc<{ todos: Record<string, Todo> }>("todos:5");
const list = document.getElementById("todo-list")!;
const nodes = new Map<string, Node>();

const renderer: DomCollection<Todo> = {
  key: (t) => String(t.id),
  create: (t) => { /* build li */ return li; },
  update: (node, t) => { /* patch in place */ },
  remove: (node) => { /* cleanup hook; DOM removal is automatic */ },
};

// Initial render from the full state (once).
await doc.ready;
for (const todo of Object.values(doc.data.get()?.todos ?? {})) {
  const node = renderer.create(todo);
  nodes.set(renderer.key(todo), node);
  list.appendChild(node);
}

// Subsequent updates via ops — patches DOM surgically, never rebuilds.
doc.onOps((ops) => applyOpsToCollection(list, "todos", ops, renderer, nodes));
```

**When `doc.data` is still fine:** the whole doc fits in one card, no keyboard focus to preserve, < ~10 rows.

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
| `delta_open_as(user_id, doc_name)` | 1-RTT variant — `set_config('app.user_id', …, true)` + `delta_open` in one SELECT |
| `delta_open_at_as(user_id, doc_name, timestamptz)` | 1-RTT variant of `delta_open_at` |
| `delta_apply_as(user_id, doc_name, ops jsonb)` | 1-RTT variant of `delta_apply` |

The `*_as` variants collapse the four identity-scoping round-trips (`BEGIN` → `set_config` → call → `COMMIT`) into one `SELECT`. The implicit transaction around the SELECT scopes `set_config(..., true)` to that statement, and RLS policies read it back exactly the same way. `docTypeFromDef({ auth })` uses them automatically — there's no opt-in. For arbitrary queries under an identity (escape hatch), `withAppAuth(pool, sqlArg, fn)` still exists and pays the extra RTTs.

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

### Client-side tests and one-shot scripts

Two things to know when driving `@blueshed/delta/client` from a Bun test or script instead of a browser:

- **`openDoc(name, ws?)` accepts an explicit client for multi-client scripts.** Each `connectWs()` instance owns its own per-client map of reactive entries, so two clients in one process get independent `data` signals + `onOps` handlers. Browser code keeps the DI ergonomic — `openDoc("foo")` resolves the client from `inject(WS)`. Tests / Bun scripts that simulate multiple devices pass the client explicitly:

  ```ts
  const alice = connectWs(url);
  const bob   = connectWs(url);
  const aliceDoc = openDoc<Board>("board:1", alice);
  const bobDoc   = openDoc<Board>("board:1", bob);
  ```

- **`wsClient.close()` suppresses the reconnect loop.** `connectWs` returns a reconnecting socket; without `close()`, it tries to come back forever after the server stops, keeping the process alive. Always call `close()` (it's idempotent) before tearing a server down.

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
