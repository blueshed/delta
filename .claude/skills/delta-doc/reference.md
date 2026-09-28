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

`init` copies `001a-001g-*.sql` (and optionally `002-users.sql` from auth-jwt) into your directory. `sql` runs the codegen. Everything is idempotent.

**Vendor-first.** The framework SQL is copied into your `init_db/`, not read from `node_modules` at runtime — shadcn/ui for database schemas. The files are explicit, tracked in git and yours to read; `bunx @blueshed/delta init <dir> --upgrade` replaces them with `.bak` backups and tells you what changed (run it after upgrading delta: 0.6.0 added `001g-delta-ledger.sql`); your own `setup.ts` or `docker-entrypoint-initdb.d` walks `init_db/` in alphabetical order, with no hidden imports. Only the SQL is vendored; the TypeScript is imported as usual. `applyFramework(pool)` applies the same files programmatically.

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

## Quick start (SQLite backend)

For list-of-typed-records data in one process: a schema, validation (400s for unknown fields,
wrong types and missing required ones), temporal history and the ledger, with no database server.

```ts
// server.ts
import { Database } from "bun:sqlite";
import index from "./index.html";
import { createWs } from "@blueshed/delta/server";
import { defineSchema, defineDoc, createTables, registerDocs } from "@blueshed/delta/sqlite";

export const schema = defineSchema({
  lists: { columns: { title: "text?" } },
  todos: {
    parent: "lists",                               // → the key column lists_id
    columns: { text: "text", done: { type: "boolean", default: false } },
  },
});
export const listDoc = defineDoc("list:", { root: "lists", include: ["todos"], implied: true });

const db = new Database("app.db");
createTables(db, schema);                          // before the first open: CREATE TABLE IF NOT EXISTS
const ws = createWs();
registerDocs(ws, db, schema, [listDoc]);           // , customDocs?, { ledger: true } for undo

const server = Bun.serve({ routes: { "/": index, [ws.path]: ws.upgrade }, websocket: ws.websocket });
ws.setServer(server);
```

```ts
// client — the same client as every backend
const doc = openDoc<{ lists: List; todos: Record<string, Todo> }>("list:groceries");
// open → { lists: { id: "groceries", title: null }, todos: {} }
await doc.send([{ op: "add", path: "/todos/-", value: { text: "milk" } }]);   // echo: add /todos/1
```

What is different from Postgres (the full list is SKILL.md → *Backends side by side*):

- **A document is single or list, as on Postgres** (*`scope` syntax* → *Single or list*). `defineDoc("list:", { root: "lists", … })` opened as `list:groceries` is the `lists` row `groceries`, its `todos`, and their children; `defineDoc("todos:", { root: "todos", include: [] })` opened as `todos:` is every todo.
- **A single document's root row** must exist before the document opens — seed it with SQL, or declare the document `implied: true` and its first write makes it (*Implied documents*, below).
- **`createTables(db, schema)` before the first open.** A missing table's error says so. `migrateSchema(db, schema)` adds columns a later schema declares.
- **Ids are serial numbers, as on Postgres.** `add /todos/-` takes the next serial, and the echo carries it (`/todos/1`). A client-chosen id (`/todos/<id>`) works too, and may be text, as `groceries` is; on Postgres it must be a number. Digits name their number (`/todos/007` is `/todos/7`), up to 2^53 - 1; a path with an id past that is a 400 on every backend, since no JavaScript number holds it exactly (a client minting ids from `Date.now() * 1000` stays under it until the year 2255). `add` of an id that exists is a 409.
- **Auth, as on Postgres, without RLS.** `registerDocs(ws, db, schema, docs, customDocs, { auth, owns })` (or `shared: true`) takes the same `DeltaAuth` (`wireAuth(ws, auth)` for its actions): every open, delta, open_at, history, undo, redo and close passes `auth.gate` (401 without an identity), and `owns(identity, docName)` says who may have each document (404 otherwise); with `auth`, `registerDocs` throws without `owns` or `shared`, and so for a custom doc with neither. One `owns` answers for every document of the call -- switch on the name's prefix -- where Postgres takes one per `docTypeFromDef`. Or register a public set and a private set in two calls on one database (`shared` on one, `owns` on the other): they share the ledger, and an undo or redo is walked by the registration whose document its entry was written through. Each call tells only its own open documents of a write, so keep the two sets over different rows. **There is no RLS**: nothing under `owns` filters what a document reads, so a name its owner may open holds every row its scope admits. The name is the whole check: scope a per-user document by its owner (`scope: { owner_id: ":id" }`) and have `owns` say that id is the caller's; a custom doc's `query`, `matches` and `recompute` are given the identity and must check rows against it themselves. *Per-user list isolation*, below.
- **Several processes may share the file.** A write takes the write lock first (`BEGIN IMMEDIATE`) and waits up to 5s for another process's (`PRAGMA busy_timeout`, set by `createTables` and `registerDocs` unless the app set its own), so it lands rather than failing `SQLITE_BUSY`; an undo plans and walks under that lock. A copy the backend read before another process wrote (`PRAGMA data_version` moved) is read again before it is served or written from, so an open answers what the other wrote and a write never merges over a stale row. **A document open in one process is not told of a write made in another**: it reads it when it is next opened, or written through. For live fan-out across processes, Postgres.
- **Fan-out**: a write reaches every open document that holds the row (*Fan-out*, below).
- **An included collection with no `parent` is shared**: nothing ties its rows to one document, so every document of the prefix holds all of them (open, `loadDocAt` and the fan-out agree), as on Postgres. Give it a `parent` to make it per document.

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

// With auth, say who owns each document: its name is the channel its writes go out on.
registerDocType(
  docTypeFromDef(defineDoc("items:", { root: "items", include: [], scope: { owner_id: ":id" } }), pool, {
    auth,
    owns: (user, docName) => docName === `items:${user.id}`,   // anyone else: 404
  })
);

const listener = await createDocListener(ws, pool, { auth });

const server = Bun.serve({
  routes: { [ws.path]: ws.upgrade },
  websocket: ws.websocket,
});
ws.setServer(server);   // REQUIRED — without it ws.publish() is a no-op and broadcasts never reach clients

// Shutdown (a test's afterAll, a script's end): the listener holds a pool
// client for LISTEN, so pool.end() waits on it until it is destroyed.
await listener.destroy();
await pool.end();
```

`bun add pg` and, to type-check, `bun add -d @types/pg` — delta ships TypeScript source, so `skipLibCheck` does not cover its `pg` imports. Ids on Postgres are BIGINTs from `seq_<table>`: create rows with `add /<coll>/-` (a client-chosen id that is not a number, or is past 2^53 - 1, is a 400 that says so), and expect ids back as numbers.

```tsx
// client.tsx
import { provide, effect } from "@blueshed/railroad";
import { connectWs, WS, openDoc, call, DeltaError } from "@blueshed/delta/client";

// Sign in on EVERY connect -- the first and each reconnect -- before any doc
// opens or re-opens. `onConnect` runs first and everything else waits for it.
// (An `await call("authenticate")` made once is not enough: a reconnect
// re-opens every doc on a new, unauthenticated socket, they 401 and stop.)
let signedIn!: (user: User) => void;
const me = new Promise<User>((resolve) => (signedIn = resolve));
provide(WS, connectWs("/ws", {
  onConnect: async (ws) => signedIn(await call<User>("authenticate", { token: localStorage.token }, ws)),
}));

const items = openDoc<{ items: Record<string, Item> }>(`items:${(await me).id}`);
effect(() => console.log(items.data.get()));

try {
  await items.send([
    { op: "add", path: "/items/-", value: { name: "hello", value: 1 } },   // the id comes back in the echo
  ]);
} catch (err) {
  if (DeltaError.isDeltaError(err)) console.warn(`${err.code}: ${err.message}`);
  else throw err;
}

// Sign out: clear identity on the socket (stays connected).
await call("logout");
```

**Session restore** — the client above assumes `localStorage.token` is set. For the full restore-on-load flow (present everywhere a real app ships), read the token in the hook, so every connect signs in with the one stored now:

```ts
provide(WS, connectWs("/ws", {
  onConnect: async (ws) => {
    const token = localStorage.getItem("token");
    if (!token) return showLogin();
    try { showApp(await call<User>("authenticate", { token }, ws)); }   // on every connect: showApp must be idempotent
    catch { localStorage.removeItem("token"); showLogin(); }           // stale or revoked
  },
}));

async function login(email: string, password: string) {
  const user = await call<User & { token: string }>("login", { email, password });
  localStorage.setItem("token", user.token);   // the next reconnect signs in with it
  showApp(user);
}
```

Token never goes in the WS URL — it's always in-band via `call("authenticate", ...)`. Cookie / `Authorization` auth at upgrade (`onUpgrade`) needs no hook: every new socket arrives signed in.

## Contracts

```ts
// DocType — dispatch unit. Each doc-name prefix owns one.
interface DocType<C = any, I = unknown> {
  prefix: string;
  parse(docName: string): C | null;
  open(ctx: C, docName: string, msg?: any, identity?: I):
    Promise<{ result: any; version: number } | null>;
  apply(ctx: C, docName: string, ops: DeltaOp[], identity?: I, by?: Writer):
    Promise<{ version: number; ops?: any[]; inverse?: any[]; entry?: number | null }>;
  openAt?(ctx: C, docName: string, at: string, identity?: I):
    Promise<any | null>;
  // With auth: may this identity open, write through and hear docName? False → 404.
  owns?(identity: I, docName: string): boolean | Promise<boolean>;
  // With auth: every identity past the gate may have every name of the prefix.
  // With auth, a type says one or the other: registerDocType / createDocListener refuse it otherwise.
  shared?: boolean;
}

// Writer — given to apply() when the listener keeps a ledger (`ledger: true`).
// docTypeFromDef writes through delta_apply_logged with it; a custom DocType
// that ignores it is simply not on the ledger.
type Writer = { who: string | null; cursor: string | null; undoable?: boolean; undoes?: number | null };

// DocDef — used by docTypeFromDef for generic docs.
interface DocDef {
  prefix: string;
  root: string;                      // main collection key
  include: string[];                 // additional collections in the lens
  scope: Record<string, string>;     // root column → a binding read from the doc name, one rule on every
                                     // backend (`scope` syntax): ":id", "<=:end", "like:prefix"; a plain "name" is ":name", not a literal
  implied?: boolean;                 // opens empty until its first write makes the root row (Postgres: by number)
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
// A column that is neither nullable nor has a default is REQUIRED: an add that
// leaves it out is a 400 "Required field missing" (SQLite and Postgres). Give it
// a default ({ type: "boolean", default: false }) or make it nullable. A root row
// added to a list-mode document is given its scope's equality values from the
// name, so those it need not repeat -- each as the document's condition reads it
// (a json column's as the JSON the name's text is: "seats-wished:5" gives 5).

const itemsDoc = defineDoc("items:", { root: "items", include: [] });

// Pre-flight op validation (unknown collections/fields, missing required, etc.).
// Each backend's takes { list, values } for a list-mode document: its scope's values count as given.
// Postgres's refuses what delta_apply refuses as a mistake (400), and takes what it takes; a row
// not there (404), one already there (409) and a value its column cannot cast are the database's.
const errors = validateOps(schema, itemsDoc, [
  { op: "add", path: "/items/-", value: { name: "a", value: 1, meta: {} } },
]);
if (errors.length) throw new Error(errors.map(e => e.message).join("\n"));
```

## `scope` syntax

One rule on every backend: the Postgres resolver (`_delta_resolve_scope`, `src/sql/001b-delta-scope.sql`) and its TypeScript twin for SQLite and the JSON file (`src/server/scope.ts`) read a document's name the same way.

`defineDoc`'s `scope` map binds a root column to a value read **from the doc name** (positional params after the prefix). **The leading `:` is optional**: a plain value names a param, as on Postgres -- it is not a literal.

| Value | Meaning |
|---|---|
| `":id"` | `col = <id-from-doc-name>` — positional param named `id` |
| `":name"` | `col = <name-from-doc-name>` — positional param named `name` |
| `"name"` | the same as `":name"` |
| `"=:name"` | explicit equality |
| `"<=:end"` | `col <= <end-param>` (also `>=`, `<`, `>`, `!=`) |
| `"like:prefix"` | `col` starts with the value, any case (`ILIKE <prefix>%`) |
| `"at:when"` | temporal snapshot (not a WHERE) |

Named params are resolved positionally from the colon-separated doc id. `id` always takes position 1; other names are alphabetical. `todos:5` has one param; `venue-at:42:2026-06-16` has two (`id=42`, second positional). An empty value sets no condition.

**A value is read as its column takes it**, on every backend, as Postgres casts the text: a `boolean`'s `true`, `yes`, `on`, `t` or `1` (any case, or an unambiguous prefix) is true and `false`, `no`, `off`, `f` or `0` false; an `integer`'s `05` is 5 (digits, signed, up to 2^53 - 1: not `1_000` or `0x10`, which Postgres's own cast would take); a `real`'s a finite decimal number a double holds (`1.5`, `.5`, `1e0`; not `Infinity`, `NaN`, `0x10` or `1e400`); a `json` column's value is the JSON it names (`[1, 2]` is `[1,2]`); a `text` column's `007` stays `007`; an id's or a parent key's is a whole number (`+5`, `007` and ` 5 ` are 5), up to 2^53 - 1, and any other text an id kept as text -- SQLite's, a session's token -- which no row has on Postgres, where every id is a number: `=` reads no rows, and a range orders it after every number, as SQLite does (`slots-of:abc` is empty on every backend); a number that is not whole (`1.5`, `1e0`) is no id; a `timestamptz` column's is a date, `YYYY-MM-DD` -- a name's `:` separates its values, so it holds no time of day -- the instant midnight UTC begins it, whatever the session's `TimeZone`, and each row's time is compared as the instant it names, whatever its form (`2026-01-01T01:00:00+01:00` is `slots-on:2026-01-01`'s; not `20260101`, `today` or `now`, which Postgres's own cast would take). SQLite keeps a time as the text it is given and compares it to the millisecond; an index on the column serves the condition there as long as times are written as ISO 8601, which begins with a date within a day of the instant's. A stored time with no zone is UTC on SQLite and in the session's `TimeZone` on Postgres: write times with a zone. The condition (`=`, and the ranges) and the values an add through a list document is given read the name by that one rule, so `seats-kept:yes` reads the rows an add through `seats-kept:true` made, and hears each one written elsewhere. A name its column cannot take (`seats-kept:maybe`, `seats-at:abc`) is refused as a mistake (400), opened or written through. `like:` compares the text.

**Single or list.** A scope that binds `id` (or no scope and a non-empty doc id) is **single mode**: one root row and its children. Anything else is **list mode**: every root row the conditions admit, keyed by id, with each included collection **in full**. `items:` (no scope, empty id) is every item; `by-status:active` with `scope: { status: ":id" }` is every row whose status is `active` -- `:id` names the param, not the row.

**Scope keys must be real columns of the root collection.** `scope: { id: ":id" }` works; `scope: { "items.id": ":id" }` raises at open time with `scope key "items.id" is not a column of "items" (valid keys: id, …)`. For a scoped-single doc, you can omit `scope` entirely — the framework defaults to `WHERE id = <doc-id>`.

## Doc patterns

**List doc** (every backend) — prefix matches the whole name; opens every row:

```ts
defineDoc("items:", { root: "items", include: [] });
// open "items:" → { items: { "1": { id: 1, ... }, "2": { ... } } }
```

**Catalog doc** — list-mode root + included child collections loaded in full, on every backend. The right shape when a small reference table and its children all open together (e.g. a product catalog with parts, faces, face_products).

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
// An included collection with no parent has no key to filter by: it is loaded in
// full, in every venue, on both backends (a shared reference table).
// You can omit `scope` entirely — an empty scope on a single-mode open defaults to
// `WHERE id = <doc-id>` which is the same thing.
```

**An included collection travels its parent chain**, whether or not the document includes the parents on the way, on every backend: a `wedding:` document with `include: ["drinks"]` (drinks under courses, courses under the wedding) holds the drinks of its wedding's courses, is told of them and may add one to its own courses (another wedding's course is a 404). A chain that meets a collection with no `parent` on the way up never reaches the root, so nothing under it is in a single document, included or not: a `course:` document with `include: ["households"]` (households under the wedding) holds none of them, and may neither write nor add one (404). Open, the write gate and the fan-out read it by the one rule; to hold such rows, root the document where their chain ends, or list them (list mode holds each included collection in full).

**Moving a row** -- writing its parent key -- puts it only under a parent the document holds, as an add names one, on every backend: through `wedding:1`, `replace /households/7/weddings_id 2` (or a drink moved to wedding 2's course) is a 404, and nobody is told, since the row would arrive in a document the writer may not have. Move it through a document that holds both parents (a list: every course, say), or through the row's own document (a single document's root is not under its parent: its value names it -- give that document an `owns` that says so).

**Removing a row** takes the row and, through `parent` and `cascadeOn`, the rows under it in the collections the document includes, and theirs in turn. A document writes what it may read, so it removes only rows it holds: through `venues:` (`root: "venues", include: []`), `remove /venues/42` takes the venue and leaves its areas and sites, their `venues_id` naming a row that is gone. The same on every backend. To take them with it, remove the venue through a document that holds them: `venue:42` itself (below), or a list with `include: ["areas", "sites"]`, which holds every area and site.

A single document may remove the root it is named for, on every backend: `remove /venues/42` through `venue:42` takes the venue and the rows the document holds under it (its areas and sites), and answers their removes, the venue's first. The copy open on `venue:42` is told its root is null (`replace /venues` null, as when the root is removed through another document) and each of those rows removed; every other document that held them is told they left. The document is then not found (404, as for any missing root row) -- an implied one opens empty again, as before its first write. Undo puts the venue back, then its rows, parent first; redo takes them again, children first. `/venues/<id>` names the document's own root: another id is a 404 to remove on every backend; to add, a 400 on the JSON file and SQLite, where Postgres adds that row, which the document then does not hold. (`replace /venues/<field>` is still a field of the root.)

**Per-user list isolation** — each user sees only their own rows. The most common multi-tenant shape.

Two parts: (1) scope the generic doc by a user-id carried in the doc name, (2) tell `docTypeFromDef` who owns each name. A document's name is the channel its writes are broadcast on — whoever has it open hears every write made through it, **whatever RLS lets them read** — so the name, not RLS, is what keeps one user's rows off another user's socket. `owns` is that check: the listener asks it before `open`, `delta`, `open_at` and `history`, and before an `undo` or `redo` writes to the entry's document, and answers 404 when it says no. With `auth`, `docTypeFromDef` throws unless it is given `owns` or `shared: true`, and the listener holds every other document to the same: see *Every document says who owns it*, below.

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
// server.ts
import { docTypeFromDef, registerDocType } from "@blueshed/delta/postgres";
import type { User } from "@blueshed/delta/auth-jwt";

registerDocType(docTypeFromDef<User>(docs[0], pool, {
  auth,
  owns: (user, docName) => docName === `todos:${user.id}`,
}));

// SQLite or the JSON file: the same auth and owns, for the documents of the call
registerDocs<User>(ws, db, schema, docs, [], { auth, owns: (user, docName) => docName === `todos:${user.id}` });
```

```tsx
// client — each user opens their own name; another user's is a 404
const me = (await call<User>("authenticate", { token })).id;
const myTodos = openDoc<{ todos: Record<string, Todo> }>(`todos:${me}`);
```

An `add /todos/-` on this list-mode doc takes `owner_id` from the scope (the doc name), not from the value, so a user cannot forge a row for someone else. RLS (`WITH CHECK`, below) is the second layer: even a buggy server cannot write across users, because the database refuses.

**`shared: true`** says every identity that passes the gate may open every document of the prefix and hear every write to it — a team board, a public room. Never put `shared` on a table whose rows RLS hides from some of its readers: they would see those rows arrive on the channel.

**Every document says who owns it.** With `auth` on the listener it is default-deny, whoever made the document:

- **SQLite and the JSON file** — `owns` or `shared: true` in `registerDocs`' options beside `auth`, for every document of the call; it throws without one, and for a custom doc with neither.

- **`docTypeFromDef`** — `owns` or `shared: true` in its options; with `auth` it throws without one. Given no `auth` it makes a type with neither, which the listener then refuses.
- **A `DocType` written by hand** — an `owns(identity, docName)` method, or `shared: true` on it. `createDocListener(ws, pool, { auth })` refuses to start while a registered type has neither, and while such a listener runs, `registerDocType` refuses one.
- **A custom doc** — `owns` or `shared: true` in `defineCustomDoc`; `createDocListener` (or `registerDocs`) refuses one with neither. `owns` is asked on open (a 404, and no subscription, when it says no).

The error names the prefix and says what to add. Without `auth` nothing is asked -- so `owns` or `shared` given without it (to `registerDocs`, `docTypeFromDef`, or a custom doc on a listener or `registerDocs` with no `auth`) is refused too, on every backend: it would say a document is guarded when every socket may open it.

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
  shared: true,                                    // with auth: every signed-in identity may open every bbox (without auth, leave it out)
});
```

- Doc shape is `{ [collection]: { [id]: row } }` — the framework keys rows by `id`. On a watched write it diffs membership: a row that now matches is `add`/`replace`d into the map, one that no longer matches is `remove`d — single ops, never a whole-doc resend.
- **The `query` result is cached per doc name and identity** (on every backend; without `auth`, per name) and shared only by the subscribers who are that identity. `query(pool, criteria, identity)` runs once for each: bind the identity yourself (`withAppAuth(pool, id, …)`) so RLS scopes what it reads, as recompute does. `matches(collection, row, criteria, identity)` decides live membership per identity too; the row comes from the change log, which RLS does not filter, so check it against the identity there when the name is `shared` or several identities `own` it. On SQLite, with no RLS, `query(db, criteria, identity)` must check its rows against the identity too.
- **With auth, say who owns it** — `owns: (identity, docName) => …` or `shared: true` (*Every document says who owns it*, above).
- **The callback shape differs by backend.** Postgres: `query: async (pool, criteria) => …` — a `Pool`, awaited (the shape above). SQLite and the JSON file: `query: (db, criteria) => …` — a synchronous `bun:sqlite` handle, no `await`. `matches` is identical on both. So is `recompute`'s: `async (pool, criteria, identity)` on Postgres, `(db, criteria, identity)` on SQLite.

**Recompute — `recompute` (SQLite + Postgres).** A *whole-doc* view for shapes a per-row predicate can't express — nested, joined, aggregated, or identity-dependent. No `matches`; instead, on open and on **any** write to a watched collection, the framework re-evaluates the entire doc and republishes it.

```ts
import { withAppAuth } from "@blueshed/delta/postgres";

const dashboard = defineCustomDoc<{ userId: string }, { id: number }>("dashboard:", {
  watch: ["orders", "invoices"],
  parse: (id) => ({ userId: id }),
  owns: (me, docName) => docName === `dashboard:${me.id}`,   // with auth: whose name it is (anyone else: 404)
  recompute: async (pool, c, identity) => {         // re-evaluated PER IDENTITY subscribed, as it
    const me = identity?.id;
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
- **Re-evaluated once per identity among the subscribers, under that gated identity** (the third arg): a write reads it once for each identity, however many of the name's subscribers are that identity (keyed as a membership view is, by `auth.asSqlArg`), and sends each subscriber its identity's. Bind it yourself — `withAppAuth(pool, id, …)` or a `*_as` stored function (see *Composing doc operations from SQL*) — so RLS scopes each subscriber's view. `identity` is `undefined` on an unauthenticated connection; **guard it** (the example returns `null` rather than dereferencing it — a recompute that throws is caught, logged, and silently drops that subscriber's update).
- **The doc-name id is untrusted.** `parse` reads whatever name the client asked to open, so a raw `WHERE … = c.userId` is a confused-deputy: say whose name it is with `owns` (asked before `recompute`), verify the parsed id against the identity (return `null` → 404), and/or treat RLS as the authoritative tenant guard. Delta is persistence + broadcast, not authorization.
- **No relevance gate.** Unlike membership's `matches`, recompute re-evaluates on *any* write to *any* watched collection, for *every* identity subscribed to *every* doc under the prefix — there's no per-doc filter. Cost ≈ (identities subscribed under the prefix) × (writes to any watched collection); it is **not** cached. Keep `watch` tight and `recompute` cheap.
- The recomputed doc reaches each client as a single **root-replace** op — see below — sent to that client alone (no `v`); in-process, `createLocal().onPublish` hears it on the document's channel, with `to` naming the identity.
- **On SQLite** (and the JSON file), `recompute(db, criteria, identity)` is synchronous and reads the database handle, as `query` does; it is read again in the write's own turn, so each subscriber is told the document as that write left it. On Postgres it is read when the listener hears the write, as the tables then stand. Without `auth` the identity is `undefined` on both.

**Root-replace — the client-side primitive recompute rides on.** `applyOps` treats the empty path `""` as "swap or clear the whole doc, in place" (`"/"` is the member named `""`, per RFC 6901):

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
  shared: true,   // with auth: say who owns it -- owns(identity, docName), or shared
};
registerDocType(venueAt);
```

## Implied documents

`defineDoc(prefix, { root, include, implied: true })` declares a document that is there before its root row is. Opening a name whose root row does not exist answers an empty document — the root `{ id: <doc id>, ...column defaults }` and an empty map per included collection — and makes no row. The first write makes the root row, in the same transaction as the write; a failed first write makes none. Its root removed through it (`remove /rooms/attic`), the row and the rows under it go and it opens empty again -- an open copy is told that empty root (`replace /rooms`), not null; an undo makes them again. The same on every backend: the JSON file, SQLite and Postgres (in process or a server). A chat room, a user's settings, a board: anything a name can mean before anyone has written to it.

```ts
const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });
// open "room:attic" → { rooms: { id: "attic", topic: null }, messages: {} }, no row yet
// delta "room:attic" add /messages/m1 → the rooms row "attic" is made, then the message
// on Postgres, and on every backend for an app that will move: by number
// open "room:7" → { rooms: { id: 7, topic: null }, messages: {} }, no row yet
```

An implied document is keyed by its root id, so it cannot also declare a `scope` (`defineDoc` throws). A document that is not implied still answers 404 for a missing root row. **A name is a number on Postgres**: its ids are serials, so `room:attic` is refused there as a mistake (400), as any text id is. An app that will move along the path names its implied documents by number (`room:7`); keep a name-keyed one (`session:<token>`) to documents that never move. On Postgres the root row is made by `delta_apply` in the write's transaction (`_delta_make_implied`), under the writer's `app.user_id`, so RLS's `WITH CHECK` sees it.

## Fan-out — which open documents hear a write

**A write is told to every document that holds a row it changed**, on every backend: the one written through, and every other open document over the same rows. Each is told what changed **for it**, worked out from who held each row before the write and who holds it after (judged on the row's values, by the same rule a document is read by):

- a row that **arrives** (added, or moved into the document's scope) is an `add /<coll>/<id>`;
- a row that **stays** is a `replace /<coll>/<id>` with the row whole;
- a row that **leaves** (removed, or moved out: a parent key rewritten, a list's condition no longer met) is a `remove /<coll>/<id>`;
- where the row is the document's **root** (`household:1` over a `households` row), a `replace /<root>` with the row -- or `null` when it leaves (an implied document, the empty root it then opens with). Code rendering such a document should allow its root to be `null`.

A parent and a child added in one write arrive parent first; a removal's cascade arrives with it. The writer's own document is told first, once; its answer (and its ledger entry) keep the ops as written, so an undo walks back exactly what was done. With a version (`v`, below), each told document advances its own.

**Where it is worked out.** On Postgres, in the database: `delta_apply` asks `_delta_holders` for each changed row before and after, and `_delta_tell` logs each document's ops and NOTIFYs its name -- so every process's listener, and a reader catching up from `delta_fetch_ops`, hears it. The documents considered are those ever opened (a name in `_delta_versions`) and the writer's. On SQLite and the JSON file, in the process, over the documents open there; each told document's copy is then read again from the tables.

**Custom read docs** hear writes to the collections they `watch`, on every backend: a membership doc row by row, a recompute doc read again whole. A membership doc hears each write once, as the writer applied it, however many documents it was told to: a row whichever document it was written through, a single document's root (`replace /<root>`) included, and its undo. Each row the write changed is tested as it now is -- it matches: an `add`, or a `replace` if the doc holds it; it no longer matches, or is gone: a `remove` -- so a row that leaves a document (its parent key rewritten) is not taken for removed while it still matches. On Postgres the writer's entry in `_delta_ops_log` carries the write as applied where the writer was told otherwise (`applied`; null where they agree, heard as told; each other told document's entry, `[]`), so every process's listener tests it once. `tests/helpers/path.ts` asks every backend, a custom doc's copy held against one opened afresh.

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
ws.upgrade = upgradeWithAuth(ws, auth);        // auth.onUpgrade → HTTP handshake (after the Origin check: *Origins*)
docTypeFromDef(def, pool, { auth, owns });     // queries → *_as (RLS session); owns → who may have the doc
createDocListener(ws, pool, { auth });         // gate every open / delta
// SQLite or the JSON file, in place of the last two: registerDocs(ws, db, schema, docs, customDocs, { auth, owns })
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

**A token that runs out.** `jwtAuth` keeps the token's `exp` with the identity. At the socket's first request after it, the gate answers 401 `Session expired: authenticate again` and drops the socket's subscriptions, as `logout` does. The socket stays connected, so `onConnect` does not run again: on that 401, `authenticate` with a fresh token and re-open the documents. Until that request the socket still hears the documents it has open (nothing checks the clock between requests).

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
registerDocType(docTypeFromDef(def, appPool, { auth, owns }));
await createDocListener(ws, appPool, { auth });
```

Under this setup `withAppAuth(appPool, ...)` sets `app.user_id` as the `app` role, and the policy `USING (owner_id = current_setting('app.user_id')::bigint)` filters without the role bypassing it.

**RLS filters reads, not the channel.** A write is broadcast on the channel named after the document it went through, to every socket that opened that name. The listener reads the change log with no identity, so a policy never sees the broadcast. One name that several identities open, on a table whose rows RLS hides from some of them, hands each of them every row written through it. So: one name per owner, and `owns` to check it (*Per-user list isolation*, above). `tests/postgres-rls.test.ts` pins this under a `NOSUPERUSER` role.

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

### Origins

A WebSocket is not bound by the same-origin policy: without a check, any page a signed-in person visits could open a socket to your server and speak the protocol as them, with their cookies. So `ws.upgrade` (and `upgradeWithAuth`, before `onUpgrade` runs) answers **403** to a browser whose `Origin` is not the server's own. Its own is the host and port the request came to (`Host`), whatever scheme a proxy in front terminates. A request with no `Origin` is not a browser's (the CLI, a test, another server) and is let in.

```ts
createWs();                                                      // its own origin only
createWs({ origins: ["https://admin.example.com", "http://localhost:5173"] });   // and these
createWs({ origins: "*" });                                      // every origin: the explicit opt-out
```

List a page served from another origin (a dev server on another port, an admin app on another host), and the public origin when a proxy in front rewrites `Host`. An entry is `scheme://host[:port]`; one that is not a URL throws at `createWs`. `refuseOrigin(req, origins)` (from `@blueshed/delta/server`) is the same check for an upgrade handler of your own: a `Response` to return, or `undefined` to go on.

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

`@blueshed/railroad` is a peer dependency. `delta/client.ts` imports `signal` from it directly — `doc.data` IS a railroad signal, not a wrapper, typed `ReadonlySignal<T | null>`: `get`, `peek` and `map`, and no `set` (the echo writes it; see *The write loop*). That means railroad's keyed `list()` already gives the per-row surgical update that `applyOpsToCollection` exists to provide for vanilla DOM.

If the project has railroad in deps, the canonical client recipe changes — drop the `applyOpsToCollection` import and render `doc.data` directly via `list()`:

```tsx
import { provide, list, when } from "@blueshed/railroad";
import { connectWs, WS, openDoc } from "@blueshed/delta/client";

interface Message { id: string; author: string; text: string; at: string }
interface ChatDoc { messages: Record<string, Message> }

provide(WS, connectWs("/ws"));
const doc = openDoc<ChatDoc>("chat:room");

const say = (text: string) =>
  doc.send([{ op: "add", path: "/messages/-", value: { author: "me", text, at: new Date().toISOString() } }]);

function onSubmit(e: SubmitEvent) {
  e.preventDefault();
  const input = (e.currentTarget as HTMLFormElement).elements.namedItem("text") as HTMLInputElement;
  if (input.value) say(input.value);   // send only: the echo renders it
  input.value = "";
}

function Chat() {
  const messages = doc.data.map((d) => d ? Object.values(d.messages) : []);
  return when(doc.data, () => (
    <div>
      <div id="log">
        {list(messages, (m) => String(m.id), (m$) => (
          <div class="msg">
            <span class="author">{m$.map((m) => m.author)}</span>
            <span class="text">{m$.map((m) => m.text)}</span>
          </div>
        ))}
      </div>
      <form onsubmit={onSubmit}><input name="text" autocomplete="off" /> <button>Send</button></form>
    </div>
  ), () => <div>connecting…</div>);
}
```

Don't import `applyOpsToCollection` in railroad projects — `list(doc.data.map(...), keyFn, render)` covers the same case in one idiom. The railroad skill (installed alongside this one when `@blueshed/railroad` is in deps) has the JSX gotchas to avoid (no `.get()` in children, list keying, dispose scopes).

`openDoc` is **scope-aware**: opened inside a railroad dispose scope (a component, a `routes()` handler, a `when()`/`list()` render, `mount()`, or -- from railroad 0.12 -- one run of an `effect()` or `computed()`), the handle auto-`close()`s on scope teardown — so a per-route ``openDoc(`board:${id}`)`` releases its subscription when the route changes. Module-level opens have no scope and stay open for the life of the page. **Don't open inside an `effect()` body** (railroad ≥ 0.12): each run is its own scope, so the doc is closed and re-opened every time the effect re-runs -- open it in the component or at module level, and read `doc.data` inside the effect. Repeated `openDoc(name)` calls on one client share a single entry (the *same* signals) with a refcount; `doc.close()` releases one handle, and the last release unregisters the doc and sends the server a best-effort `close` so the socket unsubscribes.

**In an async component or async route handler, open inside the thunk** (railroad ≥ 0.11.0). There is no active dispose scope after an `await` — browser JS has no AsyncContext to carry one across suspension, which is exactly why railroad asks async components to resolve to `() => <Node>`. It runs that thunk under a scope it owns, so an `openDoc` *inside* the thunk is scope-aware as usual; one in the async body **after** the first `await` has no owner and never auto-closes:

```tsx
async function Board({ id }: { id: string }) {
  const meta = await fetchMeta(id);
  const bad = openDoc(`board:${meta.id}`);       // ❌ post-await: no scope, leaks
  return () => {
    const doc = openDoc(`board:${meta.id}`);     // ✅ inside the thunk: auto-closes
    return <div>{doc.data.map(d => d.title)}</div>;
  };
}
```

Awaiting *before* any `openDoc` and opening synchronously in the thunk is the whole rule. If you must open post-await, keep the handle and `close()` it yourself.

Worked example: `examples/kanban/` in the repository (github.com/blueshed/delta; not in the npm package) — boards → columns → cards, real-time sync via Postgres. The `serve.ts` + `client.tsx` files in that directory are the canonical railroad UX — a fullstack page using exactly the pattern above. The sibling `server.ts` + `run.ts` files are a headless three-client demo printing op transcripts to the terminal.

## The write loop — send, don't touch (no optimistic updates, no reloads)

`doc.send(ops)` does **not** update your local view. It ships the ops to the server, which applies them and broadcasts the *same* ops to every connected client — **including the one that sent them**. That broadcast is what updates your UI. In the client (`client.ts`), an incoming op broadcast for an open doc:

1. fires every `doc.onOps(handler)` first (DOM patchers run here), then
2. applies the ops **in place** to `doc.data.peek()` and calls `data.touch()` — with `dataVersion` bumped in the same railroad `batch()`, so consumers see one settled flush per broadcast — and subscribers (railroad `list()`, `effect`, …) re-run.

All three backends broadcast **row-level** ops: SQLite/Postgres rewrite field writes server-side, and the JSON-file backend normalizes at broadcast time (`/cards/5/title` goes out as a whole-row replace of `/cards/5`). A keyed railroad `list()` therefore always sees a fresh row reference when a row changes — its default `Object.is` equality just works. Only a *custom* stream that mutates row objects in place and `touch()`es needs railroad's `list(..., keyFn, render, { equals: () => false })` (railroad ≥ 0.10.1).

The sender is just another subscriber receiving its own op back (the code calls these "echoes"). **`await doc.send(ops)` resolves once that echo has been applied to `doc.data`**, on every backend: the JSON file and SQLite broadcast before they answer, and Postgres answers first, so the client waits for the version its ack names. Two consequences trip up anyone arriving from REST/Firebase/optimistic-UI habits:

**Don't optimistically update.** Do not mutate the DOM or push into your local collection right after `send`. The echo already does it — doing it yourself double-applies: an `add` shows the row twice, a `replace` counter you also bump locally lands at +2, a chat line appears once optimistically and again on echo. The send path and the render path are the same path; keep all rendering on the render path.

```ts
// WRONG — double-applies when the op echoes back
log.append(renderMessage(m));                                  // optimistic
await doc.send([{ op: "add", path: "/messages/-", value: m }]);

// RIGHT — send only; onOps / doc.data render it when it echoes back
await doc.send([{ op: "add", path: "/messages/-", value: m }]);
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

## In-process — `createLocal()`

`createLocal()` (`@blueshed/delta/local`) is a `WsServer` with no socket, whose only client is the caller in the same process. A backend registers on `local.server` exactly as on `createWs()`; the caller then speaks the same actions as function calls and hears what the backend would have broadcast. For a server that renders its own pages, a CLI, a job, and tests.

```ts
import { Database } from "bun:sqlite";
import { createLocal } from "@blueshed/delta/local";
import { createTables, registerDocs } from "@blueshed/delta/sqlite";

const local = createLocal();
const { evict } = registerDocs(local.server, db, schema, docs, [], { ledger: true });

const doc = (await local.call("open", { doc: "room:general" })).result;
const ada = local.as({ id: 7 });                       // who is writing
await ada.call("delta", { doc: "room:general", ops, cursor: session });
await ada.call("undo", { cursor: session });           // walks back what that cursor wrote
local.onPublish((channel, change) => redraw(channel, change));   // { doc, ops, v? }
```

- **`local.call(action, msg)`** runs `open`, `delta`, `close`, `call`, `undo`, `redo`, `history` (whatever is registered) and resolves with the first answer, `{ result }` or `{ error: { code, message } }`. Calls are **async** for every backend: the SQLite backend answers at once, the Postgres backend after the database does. An action nothing handles answers `No handler matched`.
- **`local.as(identity)`** gives a caller that is `identity`: one client per identity (keyed by its JSON), carrying it as `client.data.identity`, where an auth module's `gate` and the ledger's `who` read it. Identity crosses per call, not per connection. `local.call` itself is anonymous.
- **`local.onPublish(fn)`** hears every broadcast on every channel — the one stream of changes — and each message sent to one caller alone (a membership or recompute document's view, which is that identity's own), on its document's channel, with a third argument `to`: `{ identity }`, who it went to (a broadcast has none). It returns the unsubscribe. A listener that throws is logged (`fan-out failed (write committed)`), and every other listener and document is still told.
- **The cursor is yours to name.** An in-process client carries `data.local = true`, so the ledger takes `cursor` from the message (a session id: undo takes back what this session did). A socket client cannot.
- **Any backend** registers on it: `registerDocs`, `createDocListener`, `registerDoc`, the kinds.
- **Every answer and every broadcast is the caller's own copy**, as over a socket (which sends JSON): a later write never changes what an `open` handed out, and changing it, or a row you were told, changes nothing the backend serves. Keep what you open and apply what you are told to it, in place or on a clone. The copy costs about what the socket's JSON does (an open of a 50,000-row document, some 15 ms).

**Savepoints (SQLite).** The SQLite backend writes with `db.transaction(…).immediate()`, so a write made inside your own transaction becomes a savepoint: it rolls back alone when it fails, and with yours when you roll back. Three things stay outside your transaction: the backend's cache, its broadcasts, and the version numbers it has handed out.

So a rollback after delta has written means **subscribers have already heard a change that did not happen**, and the backend's cache still holds it. Evicting is not enough: `evict(docName)` makes the backend read the document again from the tables the next time it needs it, but its subscribers still hold what they heard, and with a ledger the version is taken again from what is left in the ledger, so the rolled-back version number is reused — a browser already at that `v` drops the real change as one it has. What to do:

- **Close every document the rolled-back write touched, and have every subscriber re-open it.** A re-open reads the tables and resets the subscriber's version from the snapshot's `_v`. In-process that is `close` then `open`; a browser re-opens every document when its socket reconnects, so dropping its connection does it. This is what eta's story harness does between cases.
- Better still, keep writes that may roll back away from documents anyone is watching.

```ts
db.exec("BEGIN");
await local.call("delta", { doc: "room:a", ops });
db.exec("ROLLBACK");
await local.call("close", { doc: "room:a" });   // with every other subscriber of room:a
await local.call("open", { doc: "room:a" });    // reads the tables: the write is gone, _v as it was
```

## The ledger — undo, redo, history

Pass `{ ledger: true }` and every write is recorded in the same transaction as the write: its ops, its inverse, the document's version, **who** made it and the **cursor** undo walks.

```ts
registerDocs(ws, db, schema, docs, customDocs, { ledger: true, who: (identity) => String((identity as { id: number }).id) });   // SQLite: identity is unknown
await createDocListener(ws, pool, { auth, ledger: true, who: (identity) => String(identity.id) });      // Postgres (needs 001g)
```

- **SQLite** keeps it in a `delta_ledger` table the backend creates (`src/server/ledger.ts`). **Postgres** keeps it in `_delta_ledger` (`src/sql/001g-delta-ledger.sql`), in the database every process shares, so a write made in one process can be undone from another and every process broadcasts the undo over `NOTIFY`. `_delta_ops_log` stays a catch-up buffer pruned within the hour; the ledger is the history, kept. A lock per document holds from the read the inverse is taken from until the write commits, so concurrent writers each record the inverse of what they replaced.
- **`who`** is the writer's identity: `client.data.identity` (what `createLocal().as(identity)` or an auth module's upgrade sets), or, with an `auth` module (on either backend), what `auth.gate(client)` gives. A string or number as it is, anything else as JSON, or what your `who(identity)` returns. It is for the audit.
- **The cursor** is what undo walks, opaque to delta. In-process (`createLocal`, or any client with `data.local`) the caller names it with `cursor` on the message. Over the socket it is the connection's `clientId`, and a `cursor` on the message is ignored; for a signed-in connection (an `auth` gate gave an identity) it is the person and the `clientId` together, so another person holding the same id cannot walk it. The `clientId` is random unless the browser passed `connectWs(url, { clientId })`; a client that chooses its `clientId` keeps its cursor across reconnects. Without sign-in, anyone who learns a chosen id could walk its cursor, so treat a chosen id as a secret there.
- **A write answers** `{ ack: true, version, entry, ops, inverse }` (`ops` as applied: whole rows) and its broadcast carries `v`. An empty write records nothing.
- **Facts.** A write sent with `undoable: false` (a price tick, a sensor reading) is recorded but never walked back by undo, and ends no redo.

**The actions.**

```ts
{ action: "undo",    cursor?, dry?, entry? }  // → { doc, ops, inverse, version, entry } | { doc, ops: [], conflict, … } | null when there is nothing to undo
{ action: "redo",    cursor?, dry?, entry? }  // → the same
{ action: "history", doc, cursor?, limit? }  // → [{ id, doc, version, ops, inverse, at, undoable, mine }], newest first, limit 50
```

Undo walks back what the cursor wrote, newest first, across documents; redo walks it forward; a fresh write by the cursor ends what could be redone. Each walk is itself a write through the same path — validated, recorded (linked to the entry it walked), broadcast — so every subscriber sees an undo as an ordinary change.

**A walk sets back only what its entry changed, and only where the document still holds what the entry left.** A field someone else has written since is a **conflict**: the walk changes nothing and answers `conflict: [paths]` (a row it made and someone has edited is not removed; a row it removed and someone has put back is not added). Each row is walked once, by the entry's net change: a row one batch made and then changed is removed, one it removed and made again gets its fields back. The walk is recorded all the same — an entry with no ops that is never redone — so the next undo goes on to the entry before it; a walk the document refuses (the row's parent is gone) is recorded the same way. `null` still means nothing to walk.

**Asking first.** `dry: true` answers what the walk would do — `{ doc, entry, ops, conflict? }` — and walks nothing, so a caller can ask whoever owns the document (a deadline, a permission) before it walks. `entry: <id>` then walks only if that is still the cursor's next entry, and answers 409 if it is not. A removed row comes back under its own id, a cascaded remove comes back parent first (and so does a redo of an undo that took a row and its children), and an undo reaches a document nobody has open (SQLite loads it for the walk and leaves it closed). `history` goes to whoever may open the document (each backend asks the gate, `owns`, and that it opens); each entry says `mine` — whether the asker's cursor wrote it — never who did, never a cursor. With `auth`, `undo` and `redo` pass the gate first (401 without an identity) and walk only into a document the walker `owns` (404); on Postgres they use the `_as` forms so RLS applies.

**The inverse without a ledger (SQLite).** A `delta` message with `inverse: true` is answered `{ ack: true, ops, inverse }`: the ops as applied and what would take them back, read from the document as it was. For a writer that keeps its own history. `inverseOf(before, applied, asked?)` is exported from `@blueshed/delta/sqlite`: an add is removed, a remove added back, a replace replaced by its old self, in reverse order, except that each remove comes back with the rows its removal cascaded to, parent first; temporal storage columns are left out. `asked`, the ops as sent, tells a remove asked for from one cascaded; without it, removes one after another are taken for one cascade, so removes asked children first would come back children first. On Postgres the inverse comes with the ledger.

## One stream of changes — `v` and `_v`

Every change reaches subscribers as `{ doc, ops, v }` on the document's channel: `v` is the document's version after the change. `open` answers with `_v`, the version the snapshot is at, so a copy kept from the stream knows where it starts. The Postgres backend always versions; the SQLite backend versions with a ledger; the memory and source kinds always do. The browser client strips `_v` from `doc.data`, applies a broadcast whose `v` is the next one, ignores one it already has, and re-opens the document when it sees a gap, or a broadcast that does not apply to its copy (a remove of a row it does not hold: the copy has drifted, and is left as it was). Broadcasts without `v` (the JSON-file backend, SQLite without a ledger, fan-out onto other documents, custom docs) are applied as they come.

In-process, `createLocal().onPublish` is that stream for every channel: a server that renders can redraw from it without subscribing per document.

## Document kinds — memory, source, static

Documents whose truth is not a database (`@blueshed/delta/kinds`). Each registers for a prefix on any `WsServer` (`createWs()` or `createLocal().server`) and speaks the same `open` / `delta` / `close`, so the browser opens them like any other doc. Several kinds and backends sit side by side on one server, each owning its prefix. Register them **before** `createDocListener`: the Postgres listener answers 404 for any name it does not own, and the first answer wins.

**Memory — live, the truth is this process** (who is online, cursors, a game's lobby). Held in memory, gone on restart, never on a ledger. Written by a caller in this process — the server that knows who is connected — and refused (403) over a socket unless `writable: "any"`.

```ts
const here = registerMemory(ws, { prefix: "here:", empty: (id) => ({ people: {} }) });
await local.call("delta", { doc: "here:general", ops: [{ op: "add", path: "/people/p1", value: "Ada" }] });
here.peek("here:general");   // the value now, or undefined
here.forget("here:general"); // starts again from empty
```

An op that does not land is refused and changes nothing, with the code every backend gives it: 404 for what is not there (a remove or replace of a key it does not hold), 400 for a malformed op. `add /<coll>/-` on a map of rows is a new row the document names, as on the JSON file: a uuid in the path and in the value's `id` (on an array, `/-` appends). Open answers `{ ...value, _v }`; a write answers `{ ack, version, ops }` and broadcasts `{ doc, ops, v }`, the ops as applied.

**Source — the truth is outside** (a thermometer, an exchange rate, another API). One reading, shared by every watcher: taken when the first watcher opens the document (two opening at once share one start), then polled every `every` ms or pushed by `subscribe`, and stopped when the last watcher closes or drops.

```ts
const reactor = registerSource(ws, {
  prefix: "reactor:",
  read: async (id) => (await fetch(`https://sensors.example/${id}`)).json(),
  every: 5_000,      // poll while anyone watches; or subscribe: (id, push) => stop
  stale: 30_000,     // no reading for 30s → the document says stale: true
});
// open "reactor:core" → { reading, at, stale, _v }
reactor.stopAll();   // on shutdown
```

The document is `{ reading, at, stale }`. `at` is when the reading was taken; `stale` turns true when no reading comes within `stale` ms, so a page can say so instead of showing an old number as now. A source that fails gives no reading: the last one ages and goes stale (a first read that fails opens as `{ reading: null, at: null, stale: true }`). A reading equal to the last only moves `at`. Every write is refused (403).

**Static — the truth is the repository** (countries, SI units, a price list fixed for the release). A value per id, loaded on first open; a change is a deploy. The value must be an object: open answers it spread, with `_v: 1` added.

```ts
registerStatic(ws, { prefix: "units:", value: (id) => UNITS[id] });   // undefined → 404
// open "units:length" → { ...value, _v: 1 }; every delta refused (403)
```

## Stored functions (read-only contract)

Apply `src/sql/001a-001g-*.sql` alphabetically to every database — idempotent. Key functions:

| Function | Purpose |
|---|---|
| `delta_open(doc_name)` | returns `{ ...collections, _version }`; an implied document with no root row, its empty root and empty collections |
| `delta_open_at(doc_name, timestamptz)` | same, at a historical instant (temporal docs only) |
| `delta_apply(doc_name, ops jsonb)` | applies ops, writes `_delta_ops_log`, NOTIFYs `delta_changes` |
| `delta_fetch_ops(doc_name, since_version)` | returns (version, ops) rows after a base version |
| `_delta_fetch_log(doc_name, since_version)` | the listener's: the same rows with `applied`, the write as applied on the writer's entry where it differs from what the writer was told (null where they agree; `[]` on the others), for custom docs. On SQL without it the listener reads `delta_fetch_ops`, each entry heard as told, and warns once |
| `delta_snapshot(name, at)` | pins a timestamp to a label |
| `delta_resolve_snapshot(name)` | looks up a pinned timestamp |
| `delta_prune_ops(keep_interval interval)` | trims `_delta_ops_log` older than interval |
| `delta_open_as(user_id, doc_name)` | 1-RTT variant — `set_config('app.user_id', …, true)` + `delta_open` in one SELECT |
| `delta_open_at_as(user_id, doc_name, timestamptz)` | 1-RTT variant of `delta_open_at` |
| `delta_apply_as(user_id, doc_name, ops jsonb)` | 1-RTT variant of `delta_apply` |
| `delta_apply_logged(doc_name, ops, who, cursor, undoable?, undoes?)` | `delta_apply` with its ledger entry (`_delta_ledger`) in one transaction; returns `{ version, ops, inverse, entry }` (001g) |
| `delta_walk(cursor, who, back, dry?, entry?)` | the cursor's next entry (`back`: to undo, else to redo), walked by its guarded plan (`_delta_walk_plan`) through `delta_apply_logged`; returns its result with `doc`, `{ doc, ops: [], conflict }` on a conflict, the plan with `dry`, or NULL |
| `delta_undo(cursor, who?)` / `delta_redo(cursor, who?)` | `delta_walk` back / forward |
| `delta_history(doc_name, cursor, limit?)` | the newest entries, each with `mine`, never who or a cursor |
| `delta_apply_logged_as` / `delta_walk_as` / `delta_undo_as` / `delta_redo_as` | the same, with `app.user_id` set first for RLS |

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
bunx @blueshed/delta open  <docName>             # one-shot open + print + exit
bunx @blueshed/delta watch <docName>             # stream broadcast ops live (never exits)
bunx @blueshed/delta delta <docName> <opsJSON>   # apply ops
bunx @blueshed/delta call  <method>  [paramsJSON]  # invoke RPC
```

Always the scoped name: `bunx delta` without a local install runs an unrelated npm package called `delta`.

URL resolution: `--url` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`.

Build-time — Postgres only:

```bash
bunx @blueshed/delta init init_db --with-auth                      # vendor framework SQL
bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql   # codegen tables from schema
```

`init` copies `001a-001g-*.sql` (and optionally `002-users.sql` from auth-jwt) into the target directory; `--upgrade` replaces existing files with `.bak` backups. `sql` runs the codegen. Both are idempotent.

Vendor Claude Code skills — copies `.claude/skills/*` from this package and from the `@blueshed/*` packages in `node_modules` (e.g. `@blueshed/railroad` ships `railroad` and `bun-route`) into the consumer's `.claude/skills/` so Claude Code's project-skill autodiscovery picks them up. A skill is instructions an agent follows, so another package's skills are copied only when your `package.json` names it: `"claudeSkills": ["@acme/widgets"]`. Any other package that ships skills is skipped, with a line that says so:

```bash
bunx @blueshed/delta install-skills              # → ./.claude/skills/
bunx @blueshed/delta install-skills --user       # → ~/.claude/skills/
bunx @blueshed/delta install-skills --dry-run    # preview, touch nothing
```

Re-runs are idempotent: byte-identical destinations skip; locally edited copies are overwritten with a `.bak` backup. Re-run after upgrading `@blueshed/delta` (or any sibling that ships a skill) to pull in the latest skill text.

## Testing

**In your app**, test through `createLocal()` (below) or a real `Bun.serve` on port 0 with `connectWs("ws://localhost:<port>/ws")`. The helpers below are this repository's own `tests/setup.ts`; they are not in the npm package, so copy what you need.

```ts
// delta's tests/setup.ts (repository only):
newPool()                      // → Pool from DELTA_TEST_PG_URL (defaults to localhost:5433)
applyFramework(pool)           // runs 001*-delta-*.sql in order
applyAuthJwt(pool)             // runs auth-jwt.sql (users + login/register)
applyItemsFixture(pool)        // runs tests/fixtures/items.sql
resetState(pool)               // truncates items, users, _delta_versions, _delta_ops_log, _delta_ledger
mockClient(data?)              // a WS-shaped test client; mockClient({ local: true }) is an in-process caller
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

For SQLite and the kinds, `createLocal()` is the lightest harness: no socket, no mock — register on `local.server`, `await local.call(...)`, and collect `local.onPublish` into an array (see `tests/local.test.ts`, `tests/ledger.test.ts`, `tests/kinds.test.ts`).

### Client-side tests and one-shot scripts

Two things to know when driving `@blueshed/delta/client` from a Bun test or script instead of a browser:

- **`openDoc(name, ws?)` accepts an explicit client for multi-client scripts.** Each `connectWs()` instance owns its own per-client map of reactive entries, so two clients in one process get independent `data` signals + `onOps` handlers. Browser code keeps the DI ergonomic — `openDoc("foo")` resolves the client from `inject(WS)`. Tests / Bun scripts that simulate multiple devices pass the client explicitly:

  ```ts
  const alice = connectWs(url);
  const bob   = connectWs(url);
  const aliceDoc = openDoc<Board>("board:1", alice);
  const bobDoc   = openDoc<Board>("board:1", bob);
  ```

- **Pass an absolute URL** (`connectWs("ws://localhost:3000/ws")`): outside a browser there is no page to resolve `"/ws"` against, and `connectWs` says so. No `location` shim is needed. An absolute `wss://` stays `wss://`.
- **`wsClient.close()` suppresses the reconnect loop.** `connectWs` returns a reconnecting socket; without `close()`, it tries to come back forever after the server stops, keeping the process alive. Always call `close()` (it's idempotent) before tearing a server down.

## Local development across repos

To run an app against a checkout of delta (or railroad), install a **packed tarball**, not a
`file:` or `bun link` dependency. A linked checkout brings its own
`node_modules/@blueshed/railroad`, so the page loads two railroads, delta's `doc.data` is a
signal the app's railroad does not know, and the page sits on "connecting…" with no error.

```sh
cd ../delta && bun pm pack && cd ../app && bun add ../delta/blueshed-delta-<version>.tgz
```

After an edit, pack again, then remove the package and add the tarball:
`bun remove @blueshed/delta && bun add ../delta/blueshed-delta-<version>.tgz`. `bun.lock` pins
the first tarball by its integrity hash, so `bun add` of it again, `bun install --force` and
deleting `node_modules/@blueshed/delta` all keep the old contents (Bun 1.4.2); deleting
`bun.lock` works too. railroad's skill has the same recipe under *Local development across
repos*.

## Wire-level protocol

All WebSocket messages have shape `{ id?: number, action: string, ...rest }`. Responses mirror the id.

| Client → Server | Payload | Server → Client |
|---|---|---|
| `{ action: "open", doc }` | | `{ id, result: <docContents> }` — with `_v` where the backend versions |
| `{ action: "delta", doc, ops, cursor?, undoable?, inverse? }` | `cursor` in-process only; `undoable: false` for a fact; `inverse: true` (SQLite) | `{ id, result: { ack: true, version? } }`; with a ledger also `ops`, `inverse`, `entry` |
| `{ action: "undo", cursor? }` / `{ action: "redo", cursor? }` | ledger only | `{ id, result: { doc, ops, inverse, version, entry } \| null }` |
| `{ action: "history", doc, cursor?, limit? }` | ledger only | `{ id, result: [{ id, doc, version, ops, inverse, at, undoable, mine }] }` |
| `{ action: "open_at", doc, at }` | | `{ id, result: <snapshot> }` |
| `{ action: "close", doc }` | | `{ id, result: { ack: true } }` |
| `{ action: "call", method, params }` | | `{ id, result }` — e.g. `login`, `register`, `authenticate` |

Server-initiated broadcasts (no id):

| Server → Client | Shape |
|---|---|
| Op broadcast | `{ doc, ops: DeltaOp[], v? }` — `v` is the version after the change, where the backend versions |

Every message is JSON. Clients use `doc.send(ops)` internally; the protocol is only relevant when writing a custom action handler.

**Error codes** — `{ id, error: { code, message } }`, and `DeltaError.code` on the client, mean the same on every backend:

| code | means | e.g. |
|---|---|---|
| 400 | the op is malformed | a path without a leading `/`, an unknown field, a required field left out, a non-numeric id on Postgres, an id past 2^53 - 1 |
| 401 | not signed in | an `auth` gate said no |
| 403 | the document is read-only | custom, static and source docs; memory docs over a socket |
| 404 | not there | the document, a row, a path; a document the identity does not `own` |
| 409 | already there | `add` of a row id that exists |
| 500 | the server's own failure | the message says what |

## Why delta

Existing sync libraries are built for human developers: big API surfaces, many idioms, ecosystem dependencies. Delta is shaped for AI-driven development: the whole system fits in one context window, there is one way to do each thing, and the schema is generated from a single TypeScript source of truth. If an assistant reaches for Supabase or Firebase, that is a default trained from millions of projects; delta is not harder than those, it is smaller, and it can be read in full before a line is written.

Lineage: started as dzql (Vue / Pinia, database-first), matured into seiro (CQRS over WebSocket with Preact Signals), refined in paintbrush's delta-sync, realised in clean as a Postgres-resident primitive, and extracted as this package. eta, a server-rendering kernel, now builds on it in-process.
