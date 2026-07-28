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
bunx delta init init_db --with-auth
bunx delta sql ./types.ts --out init_db/003-tables.sql
```

`init` copies `001a-001f-*.sql` (and optionally `002-users.sql` from auth-jwt) into your directory. `sql` runs the codegen. Everything is idempotent.

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

const server = Bun.serve({
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);   // REQUIRED — without it ws.publish() is a no-op and broadcasts never reach clients
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

> **Postgres-only DSL.** The rich operator DSL below is implemented in the Postgres SQL resolver (`src/sql/001b-delta-scope.sql`). The **SQLite** backend uses a simpler positional scheme — see *SQLite scope behaviour* at the end of this section. Don't copy `":id"`, `"<=:end"`, `"like:prefix"` etc. into a SQLite `defineDoc`; they won't resolve.

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

**SQLite scope behaviour (not the DSL above).** The SQLite backend (`src/server/sqlite.ts`, `resolveScope`) does **not** implement the operator DSL. It is positional and literal:

- **Empty scope** → `WHERE id = <doc-id>` (same default as Postgres single-mode).
- **Otherwise**, the only dynamic placeholder is the literal string `":docId"`. The doc-id is split on `:` into positional parts, and each `":docId"` binding consumes the next part. **Any other binding value is treated as a literal column match** — it is not parsed for operators or param names.

So on SQLite a Postgres-style `scope: { user_id: ":id" }` does **not** read from the doc name — it produces `WHERE user_id = ':id'` (the literal string `:id`). To scope a SQLite doc by the doc-id, use `scope: { user_id: ":docId" }`; to pin a static value, use a plain literal like `scope: { tenant: "acme" }`.

## Doc patterns

**List doc** — prefix matches the whole name; opens every row:

```ts
defineDoc("items:", { root: "items", include: [] });
// open "items:" → { items: { "1": { id: 1, ... }, "2": { ... } } }
```

**Catalog doc** — list-mode root + included child collections loaded in full. Postgres only. The right shape when a small reference table and its children all open together (e.g. a product catalog with parts, faces, face_products).

```ts
defineDoc("catalog:", {
  root: "products",
  include: ["parts", "faces", "face_products"],
});
// open "catalog:" → { products: {...all...}, parts: {...all...},
//                     faces: {...all...}, face_products: {...all...} }
```

List-mode `include` has no FK filter — list mode has no single root id to filter against, so "include" means "load it all" (single-mode `include` still travels `parent_fk`). Writes route through the existing path grammar (`/parts/<id>`, `/parts/-` etc.) and bump the doc version, so ops broadcast as you'd expect. If a custom `DocType` exists only to read each related collection in parallel and assemble the payload by hand, replace it with this.

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

### Custom read docs — `defineCustomDoc`

`defineCustomDoc(prefix, opts)` declares a **read-only** doc whose contents are a *derived view* over one or more watched collections — a bbox query, a tag filter, a joined summary — rather than a plain collection slice. Clients open it like any doc (`openDoc("sites-in-bbox:...")`); writes still travel the underlying collections' normal paths. Register them with `registerDocs(ws, db, schema, docs, customDocs)` (SQLite) or `createDocListener(ws, pool, { custom })` (Postgres). Two modes, selected by which fields you provide:

**Membership — `query` + `matches` (SQLite + Postgres).** A *flat* view: each watched collection becomes a keyed map, and the framework decides **per row** whether a changed row belongs. `query` does the initial load; `matches` is the live fan-out predicate.

```ts
const sitesInBbox = defineCustomDoc<BBox>("sites-in-bbox:", {
  watch: ["sites"],
  parse: (id) => { const [minLng, minLat, maxLng, maxLat] = id.split(",").map(Number); return { minLng, minLat, maxLng, maxLat }; },
  query: async (pool, c) => ({
    sites: (await pool.query(
      "SELECT id::text, name, lat, lng FROM sites WHERE lng BETWEEN $1 AND $2 AND lat BETWEEN $3 AND $4",
      [c.minLng, c.maxLng, c.minLat, c.maxLat])).rows,
  }),
  matches: (_coll, row, c) =>                      // does this changed row still belong?
    row.lng >= c.minLng && row.lng <= c.maxLng && row.lat >= c.minLat && row.lat <= c.maxLat,
});
```

- Doc shape is `{ [collection]: { [id]: row } }` — the framework keys rows by `id`. On a watched write it diffs membership: a row that now matches is `add`/`replace`d into the map, one that no longer matches is `remove`d — single ops, never a whole-doc resend.
- **The `query` result is cached per doc name and shared across all subscribers**, so a membership doc must be *criteria-scoped, not identity-scoped* (`query` isn't even passed an identity). If two clients opening the same name must see different rows, use recompute — not membership.
- **The callback shape differs by backend.** Postgres: `query: async (pool, criteria) => …` — a `Pool`, awaited (the shape above). SQLite: `query: (db, criteria) => …` — a synchronous `bun:sqlite` handle, no `await`. `matches` is identical on both.

**Recompute — `recompute` (Postgres only).** A *whole-doc* view for shapes a per-row predicate can't express — nested, joined, aggregated, or identity-dependent. No `matches`; instead, on open and on **any** write to a watched collection, the framework re-evaluates the entire doc and republishes it.

```ts
import { withAppAuth } from "@blueshed/delta/postgres";

const dashboard = defineCustomDoc<{ userId: string }>("dashboard:", {
  watch: ["orders", "invoices"],
  parse: (id) => ({ userId: id }),
  recompute: async (pool, c, identity) => {         // re-evaluated PER SUBSCRIBER, under their identity
    const me = (identity as { id: number } | undefined)?.id;
    if (me == null || String(me) !== c.userId) return null;  // doc-name id is untrusted — verify it → 404 / skip
    return withAppAuth(pool, me, async (db) => {             // bind app.user_id, so RLS scopes every read below
      const orders   = (await db.query("SELECT * FROM orders   WHERE user_id = $1", [me])).rows;
      const invoices = (await db.query("SELECT * FROM invoices WHERE user_id = $1", [me])).rows;
      return { orders, invoices, total: invoices.reduce((s, i) => s + i.amount, 0) };  // ANY shape
    });
  },
});
```

- Returns the **whole doc** (any JSON shape, object or array). Return `null` for "doesn't exist": a 404 on open, a silent skip on fan-out.
- **Re-evaluated once per subscriber, under that client's gated identity** (the third arg). Bind it yourself — `withAppAuth(pool, id, …)` or a `*_as` stored function (see *Composing doc operations from SQL*) — so RLS scopes each subscriber's view. `identity` is `undefined` on an unauthenticated connection; **guard it** (the example returns `null` rather than dereferencing it — a recompute that throws is caught, logged, and silently drops that subscriber's update).
- **The doc-name id is untrusted.** `parse` reads whatever name the client asked to open, so a raw `WHERE … = c.userId` is a confused-deputy: verify the parsed id against the identity (return `null` → 404) and/or treat RLS as the authoritative tenant guard. Delta is persistence + broadcast, not authorization.
- **No relevance gate.** Unlike membership's `matches`, recompute re-evaluates on *any* write to *any* watched collection, for *every* subscriber of *every* doc under the prefix — there's no per-doc filter. Cost ≈ (subscribers under the prefix) × (writes to any watched collection); it is **not** cached. Keep `watch` tight and `recompute` cheap.
- The recomputed doc reaches each client as a single **root-replace** op — see below.

**Root-replace — the client-side primitive recompute rides on.** `applyOps` treats an empty/root path (`""` or `"/"`) as "swap or clear the whole doc, in place":

```ts
applyOps(doc, [{ op: "replace", path: "", value: next }]);  // object↔object / array↔array
applyOps(doc, [{ op: "remove",  path: "" }]);               // clear to {} or []
```

The container is mutated **in place** (keys cleared then re-assigned; array spliced then refilled) rather than reassigned, because the server's doc tracking and the client's reactive `doc.data` both hold the value by reference — the client bumps `dataVersion` after `applyOps`, so a root-replace re-renders end-to-end. Containers must match kind (object↔object, array↔array) or `applyOps` throws. This is what lets recompute's whole-doc refresh ride the same op channel as every other change; you can also emit it yourself from a custom `DocType`.

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

**Identity switching on a live socket.** `jwtAuth` ships a `logout` action that clears `client.data.identity`. Logout also **unsubscribes the socket from every doc it currently has open** — the previous user's live streams stop immediately, not just on the next open. Client usage:

```ts
await call("logout");              // server-side: delete client.data.identity
                                   // AND tear down all open doc subscriptions —
                                   // the old user's live streams stop at once.
localStorage.removeItem("token");
// Any future open/delta also fails the gate with 401 until the user re-authenticates.
// Re-opening a doc after switching identity re-subscribes under the new user.
```

The same teardown happens on an identity switch (a fresh `authenticate` after a `logout`): the old subscriptions are gone, so you must re-`openDoc` the docs the new user should see — their streams won't silently carry over from the previous identity.

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

const renderer: DomCollection<Todo> = {
  key: (t) => String(t.id),          // MUST equal the id used in /todos/<id>
  create: (t) => { /* build li */ return li; },
  update: (node, t) => { /* patch in place */ },
  remove: (node) => { /* cleanup hook; DOM removal is automatic */ },
};

// ONE render path — initial paint, live ops, and the synthetic whole-doc
// replace that arrives on reconnect all go through it.
const render = (ops: DeltaOp[]) => applyOpsToCollection(list, "todos", ops, renderer);

await doc.ready;
render([{ op: "replace", path: "", value: doc.data.get() }]);
doc.onOps(render);
```

**Don't hand-build the initial DOM.** `applyOpsToCollection` keeps an id → node
map — that map is how `remove` finds its node and how the reconnect reconcile
knows which rows it already has. Nodes you appended yourself aren't in it, so
`remove` becomes a no-op and the first reconnect re-appends the whole
collection. Painting through the same call is what keeps the map and the DOM in
agreement.

The map is held per `(parent, collection)` for you. Pass your own as a 5th
argument only when you need to seed or inspect it — it must then be long-lived
and threaded through *every* call, including the initial paint.

**When `doc.data` is still fine:** the whole doc fits in one card, no keyboard focus to preserve, < ~10 rows.

## Railroad recipe — `list()` over `applyOpsToCollection`

`@blueshed/railroad` is a peer dependency. `delta/client.ts` imports `signal` from it directly — `doc.data` IS a railroad `Signal<T | null>`, not a wrapper. That means railroad's keyed `list()` already gives the per-row surgical update that `applyOpsToCollection` exists to provide for vanilla DOM.

If the project has railroad in deps, the canonical client recipe changes — drop the `applyOpsToCollection` import and render `doc.data` directly via `list()`:

```tsx
import { provide, list, when } from "@blueshed/railroad";
import { connectWs, WS, openDoc } from "@blueshed/delta/client";

interface Message { author: string; text: string; at: string }
interface ChatDoc { messages: Record<string, Message> }

provide(WS, connectWs("/ws"));
const doc = openDoc<ChatDoc>("chat:room");

function Chat() {
  const messages = doc.data.map((d) => d ? Object.values(d.messages) : []);
  return when(doc.data, () => (
    <div id="log">
      {list(messages, (m) => m.at + m.author, (m$) => (
        <div class="msg">
          <span class="author">{m$.map((m) => m.author)}</span>
          <span class="text">{m$.map((m) => m.text)}</span>
        </div>
      ))}
    </div>
  ), () => <div>connecting…</div>);
}
```

Don't import `applyOpsToCollection` in railroad projects — `list(doc.data.map(...), keyFn, render)` covers the same case in one idiom. The railroad skill (installed alongside this one when `@blueshed/railroad` is in deps) has the JSX gotchas to avoid (no `.get()` in children, list keying, dispose scopes).

`openDoc` is **scope-aware**: opened inside a railroad dispose scope (a component, a `routes()` handler, a `when()`/`list()` render, or `mount()`), the handle auto-`close()`s on scope teardown — so a per-route ``openDoc(`board:${id}`)`` releases its subscription when the route changes. Module-level opens have no scope and stay open for the life of the page. Repeated `openDoc(name)` calls on one client share a single entry (the *same* signals) with a refcount; `doc.close()` releases one handle, and the last release unregisters the doc and sends the server a best-effort `close` so the socket unsubscribes.

Worked example: [`examples/kanban/`](../../../examples/kanban/) (boards → columns → cards, real-time sync via Postgres). The `serve.ts` + `client.tsx` files in that directory are the canonical railroad UX — a fullstack page using exactly the pattern above. The sibling `server.ts` + `run.ts` files are a headless three-client demo printing op transcripts to the terminal.

## The write loop — send, don't touch (no optimistic updates, no reloads)

`doc.send(ops)` does **not** update your local view. It ships the ops to the server, which applies them and broadcasts the *same* ops to every connected client — **including the one that sent them**. That broadcast is what updates your UI. In the client (`client.ts`), an incoming op broadcast for an open doc:

1. fires every `doc.onOps(handler)` first (DOM patchers run here), then
2. applies the ops **in place** to `doc.data.peek()` and calls `data.touch()` — with `dataVersion` bumped in the same railroad `batch()`, so consumers see one settled flush per broadcast — and subscribers (railroad `list()`, `effect`, …) re-run.

All three backends broadcast **row-level** ops: SQLite/Postgres rewrite field writes server-side, and the JSON-file backend normalizes at broadcast time (`/cards/5/title` goes out as a whole-row replace of `/cards/5`). A keyed railroad `list()` therefore always sees a fresh row reference when a row changes — its default `Object.is` equality just works. Only a *custom* stream that mutates row objects in place and `touch()`es needs railroad's `list(..., keyFn, render, { equals: () => false })` (railroad ≥ 0.10.1).

The sender is just another subscriber receiving its own op back (the code calls these "echoes"). Two consequences trip up anyone arriving from REST/Firebase/optimistic-UI habits:

**Don't optimistically update.** Do not mutate the DOM or push into your local collection right after `send`. The echo already does it — doing it yourself double-applies: an `add` shows the row twice, a `replace` counter you also bump locally lands at +2, a chat line appears once optimistically and again on echo. The send path and the render path are the same path; keep all rendering on the render path.

```ts
// WRONG — double-applies when the op echoes back
log.append(renderMessage(m));                                  // optimistic
await doc.send([{ op: "add", path: `/messages/${id}`, value: m }]);

// RIGHT — send only; onOps / doc.data render it when it echoes back
await doc.send([{ op: "add", path: `/messages/${id}`, value: m }]);
```

**A brute-force reload is never necessary — not after a write, not ever.** The framework issues exactly two full reads, both automatic, and a developer-issued one is always either redundant or actively harmful (it rebuilds the DOM and throws away the op-level precision the protocol gave you):

- **Initial load** — the `open` resolves with full state into `doc.data` (you render once after `doc.ready`).
- **Reconnect** — on *every* socket `open` event, initial connect and post-outage alike, `connectWs` re-issues `open` for every entry in its `_docs` map. `onOpen` resets `doc.data` to fresh full state **and** emits a synthetic whole-doc replace op — `{ op: "replace", path: "", value: <full doc state> }` — to every `doc.onOps` consumer. `applyOpsToCollection` handles that root-replace by reconciling the keyed collection against the fresh state (adding/replacing/removing nodes to match), so an outage self-heals on **both** render paths — the `doc.data`/railroad path *and* the vanilla-DOM `onOps`/`applyOpsToCollection` path. You do nothing.

Everything between those two arrives as ordered, versioned ops on the live socket. So none of the triggers that make you reach for a reload actually need one:

| Tempting trigger | Why no reload | What actually happens |
|---|---|---|
| "I just wrote — show the result" | the write echoes back as an op | `onOps` / `doc.data` patch in place |
| "I reconnected after dropping" | re-open is automatic | `doc.data` reset to fresh state, and `onOps` gets a root-replace to reconcile, on the `open` event |
| "the tab refocused / became visible" | nothing was missed | the socket stayed subscribed; any ops already applied |
| "I might be out of sync" | you can't silently be | ops carry versions; reconnect re-reads full state |
| "force-refresh to be safe" | there is nothing newer to fetch | `doc.data` *is* the latest |

If you catch yourself calling `openDoc` a second time, `fetch`-ing the doc over HTTP, or rebuilding the collection from `doc.data` "to be safe," stop — it's a category error. There is no staleness to chase: the socket is the live read, and it never stopped being one.

**About latency.** Optimistic updates exist to hide round-trip time. Over delta's WebSocket the echo is typically sub-frame, so the honest default is to render from the echo and leave it. If a specific interaction genuinely needs instant local feedback, give *transient* feedback that isn't the data — disable the button, dim the row, show a spinner — and still let the authoritative collection update from the broadcast. Never fork the collection's source of truth into a local optimistic copy you then have to reconcile.

## Stored functions (read-only contract)

Apply `src/sql/001a-001f-*.sql` alphabetically to every database — idempotent. Key functions:

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

### Composing doc operations from SQL

These functions aren't only for the Bun layer — they're **callable from inside your own `plpgsql`/SQL functions**, so a custom read evaluator can assemble several docs, and a stored write can mutate-and-broadcast, without leaving Postgres. Most are `LANGUAGE plpgsql` (`delta_fetch_ops` and `delta_resolve_snapshot` are `LANGUAGE sql`), all `SECURITY INVOKER`; `delta_apply`/`delta_apply_as` always write `_delta_ops_log` + NOTIFY, so **a write that originates inside Postgres still broadcasts** to every subscriber.

```sql
-- a custom read evaluator composing two docs under the caller's identity
CREATE FUNCTION my_dashboard(p_user_id text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN jsonb_build_object(
    'account', delta_open_as(p_user_id, 'my-account:' || p_user_id),
    'orgs',    delta_open_as(p_user_id, 'org-workspace:')
  );  -- _as binds app.user_id one-shot, so RLS on every table it reads applies
END $$;

-- a stored write that mutates AND broadcasts (not a raw INSERT)
CREATE FUNCTION accept_thing(p_user_id text, p_id bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN delta_apply_as(p_user_id, 'invite:' || p_id,
    jsonb_build_array(jsonb_build_object('op','replace','path','/status','value','"accepted"')));
END $$;
```

- **Read under the caller's identity** with `delta_open_as` (or `set_config('app.user_id', …, true)` then `delta_open`) — *never* a bare `delta_open`/`SELECT` on an RLS table. Unbound, RLS sees `app.user_id = ''` and the row scopes to nothing (and a `::bigint` cast on `''` *throws*). The binding must follow **what the function reads**, not whether `:user_id` appears in the query.
- **Write through `delta_apply`/`delta_apply_as`**, never a direct `INSERT`/`UPDATE` on a delta-managed table — only that path bumps the version, logs the ops, and NOTIFYs, so subscribers stay live.
- **`SECURITY DEFINER` bypasses RLS.** delta is a persistence + broadcast layer, *not* an authorization one — a `DEFINER` function runs as its owner, so RLS won't gate it. If you escalate privilege, the function must enforce its own preconditions/ownership checks (compose `_`-prefixed guard helpers — never wire-callable — for this).

Collections register themselves via `_delta_collections` (`columns_def`, `parent`, `temporal`); docs via `_delta_docs` (`prefix`, `root`, `include`, `scope`). Populated by your generated `003-tables.sql` — never hand-edited.

## CLI

Runtime — talk to a running server:

```bash
bunx delta open  <docName>             # one-shot open + print + exit
bunx delta watch <docName>             # stream broadcast ops live
bunx delta delta <docName> <opsJSON>   # apply ops
bunx delta call  <method>  [paramsJSON]  # invoke RPC
```

URL resolution: `--url` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`.

Build-time — Postgres only:

```bash
bunx delta init init_db --with-auth                      # vendor framework SQL
bunx delta sql ./types.ts --out init_db/003-tables.sql   # codegen tables from schema
```

`init` copies `001a-001f-*.sql` (and optionally `002-users.sql` from auth-jwt) into the target directory. `sql` runs the codegen. Both are idempotent.

Vendor Claude Code skills — copies `.claude/skills/*` from this package and from any sibling package in `node_modules` that ships skills (e.g. `@blueshed/railroad` ships `railroad` and `bun-route`) into the consumer's `.claude/skills/` so Claude Code's project-skill autodiscovery picks them up:

```bash
bunx delta install-skills              # → ./.claude/skills/
bunx delta install-skills --user       # → ~/.claude/skills/
bunx delta install-skills --dry-run    # preview, touch nothing
```

Re-runs are idempotent: byte-identical destinations skip; locally edited copies are overwritten with a `.bak` backup. Re-run after upgrading `@blueshed/delta` (or any sibling that ships a skill) to pull in the latest skill text.

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
