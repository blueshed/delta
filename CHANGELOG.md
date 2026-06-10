# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-06-10

### Fixed

- **Client silently went stale on a missed Postgres broadcast** (`src/client/client.ts`,
  `src/server/postgres/listener.ts`, `src/server/postgres/registry.ts`). The client
  applied broadcast ops blindly and bumped a purely local counter, so a dropped op —
  notably across the open/subscribe race on Postgres — was invisible. The server now
  stamps a per-doc monotonic version on op-bearing messages (`_v` on the open snapshot,
  `v` on each broadcast) and the client validates the sequence: a duplicate (`v ≤ sv`)
  is ignored, a contiguous op (`v === sv+1`) is applied and advances the baseline, and a
  gap (`v > sv+1`) triggers a deduped re-open + resync — riding the existing reconnect
  synthetic-root-replace so `onOps` / `applyOpsToCollection` reconcile automatically.
  Versions are `Number()`-normalized on both ends (pg yields a top-level `BIGINT` as a
  string but JSONB-embedded numbers as JS numbers, so a strict comparison would otherwise
  fire spurious resyncs forever). Hardening from an adversarial pass: broadcasts arriving
  before the first open response are dropped (the snapshot is authoritative); a `_v`-less
  (re)open clears the baseline so a stale version can't survive; a non-numeric/`NaN` `v`
  falls into the unversioned path instead of poisoning `serverVersion`. **Scope:** Postgres
  standard docs. SQLite/JSON and PG custom docs are unversioned (no `v`) and the client
  applies them as-is — back-compatible.

## [0.4.16] — 2026-06-03

A correctness, security, and documentation hardening pass: 56 findings from a
multi-agent review, each adversarially verified against the source. +35
regression tests (full suite 263 → 298, typecheck clean). No breaking public-API
changes — additions are an opt-in `verifyUser` auth hook, a `delta sql --force`
flag, and an on-reconnect `onOps` reconciliation signal.

### Fixed

- **SQLite temporal PK collisions** (`src/server/sqlite.ts`). `now()` truncated to
  whole seconds against a `(id, valid_from)` primary key, so two writes to a row
  within one second — including a multi-field edit in a single delta, and the
  common create-then-edit — collided and rolled the delta back. `now()` is now
  strictly-monotonic millisecond resolution, root-field replaces are batched into
  one close+reinsert per delta, and the close shares the reinsert's timestamp so a
  closed version's `valid_to` exactly equals the new version's `valid_from` (no
  time-travel overlap).
- **Postgres dropped LISTEN notifications under concurrent writes**
  (`src/server/postgres/listener.ts`). A notification arriving while a fetch was
  in flight was silently dropped, leaving subscribers stale until the next write.
  The handler now coalesces (re-drains on a pending flag), pages past
  `delta_fetch_ops`' 1000-row LIMIT, and re-syncs every tracked doc after a
  reconnect (ops committed during the outage were NOTIFY'd to nobody).
- **Client in-flight requests hung forever on an unexpected disconnect**
  (`src/client/client.ts`). The transport `close` handler never rejected pending
  `send`/`call` promises; they now reject with a retryable `disconnected` error.
- **Listener reconnect leaked handlers / could double-reconnect**
  (`src/server/postgres/listener.ts`). Reconnect now detaches the old
  connection's notification/error listeners before release and holds a
  concurrency guard across the whole reconnect+resync.
- **Recompute custom-doc fan-out delivered stale snapshots out of order**. Per-doc
  recomputes are now serialized so a slower earlier recompute can't land after a
  later one.
- **SQLite post-COMMIT fan-out error masked the real error / aborted the handler**.
  ROLLBACK is now scoped to the `BEGIN..COMMIT` region; fan-out runs after commit
  and its failures are logged, not surfaced as a failed write.
- **SQLite cross-doc fan-out could clobber an included collection map** — a source
  root-level `replace /<coll>` is rewritten to a keyed `/<coll>/<id>` when the
  target treats that collection as a map.
- **dom-ops** (`src/client/dom-ops.ts`): removed a dead field-level-replace branch
  that silently did nothing; added a null-value guard on the explicit-id `add`.
- **core** (`src/core.ts`): `splitPath` no longer drops empty RFC-6901 reference
  tokens; documented that `add` to a numeric array index overwrites (not inserts).
- **`migrateSchema`** retrofits `valid_from`/`valid_to` + the `current_` view when a
  table gains `temporal: true` (and warns about the composite-PK rebuild).

### Security

- **Custom-doc `open` bypassed the auth gate** (`src/server/postgres/listener.ts`).
  The custom-doc handler registered before — and short-circuited — the gated
  standard handler, so an unauthenticated client could read scoped data. It now
  runs `auth.gate()` and returns 401 before `query`/`recompute`; the recompute
  fan-out skips any subscriber whose gate fails.
- **logout / identity switch now tears down doc subscriptions**
  (`src/server/server.ts`, `auth-jwt.ts`). Previously a socket kept receiving the
  prior identity's scoped broadcasts until it disconnected. Subscriptions are
  tracked per socket (`trackSubscribe`) and dropped on logout/switch.
- **`login` user-enumeration timing oracle + weak bcrypt cost** (`src/sql/auth-jwt.sql`).
  `login` now performs one bcrypt comparison on every call (a dummy hash when the
  email is unknown), and `register` uses `gen_salt('bf', 12)`.
- **`delta_apply` collection-scope guard** (`src/sql/001d-delta-write.sql`). An op
  may only target the doc's root or an included collection — defence-in-depth
  against writing to an unrelated collection through a doc.
- **Codegen identifier escaping + validation** (`src/server/postgres/codegen.ts`,
  `sql.ts`, `src/schema.ts`): single-quoted SQL literals, the `include[]` array
  literal, and `q()` double-quotes are escaped; `defineSchema`/`defineDoc` reject
  illegal identifiers early.
- **JWT algorithm pinned** to HS256 on verify (alg-confusion); **email PII removed**
  from login/register logs.

### Changed

- **`@blueshed/railroad` 0.8.2 → 0.9.0** (peer `^0.9.0`). API-compatible with
  delta's usage. `delta install-skills` vendors railroad's `railroad` and
  `bun-route` skills via sibling-package discovery.
- **`validateOps` is wired into the SQLite write path** and strengthened to reject
  unknown collections/fields (returns 400 instead of silently acking and diverging
  cache/broadcast from disk).
- **`_delta_find_doc`** matches by exact prefix (`left(name, len) = prefix`) rather
  than `LIKE`, so a `_`/`%` in a prefix can't over-match.
- **CLI**: `delta sql --out` refuses to overwrite a non-generated file without
  `--force` and backs up generated files; a bad module path prints a friendly
  error; `.bak` files are no longer clobbered; malformed WS frames don't crash.

### Added

- **`jwtAuth({ verifyUser })`** — optional hook to re-validate the identity against
  the database on `authenticate` (closes the stateless-JWT "deleted user keeps
  access" gap when desired).
- **`onOps` reconnect reconciliation** — on every reconnect the client emits a
  synthetic whole-doc `replace` op so `applyOpsToCollection` reconciles a
  drifted collection; the vanilla-DOM path now self-heals like the railroad path.

### Docs

- delta-doc skill/reference: canonical recipes now compile (`DomCollection.key`)
  and broadcast (`ws.setServer`); the scope-operator DSL is marked Postgres-only
  with the SQLite behaviour documented; framework-SQL is `001a–001f`, generated
  tables are `003-tables.sql`, framework path is `src/sql/`; `DeltaError` listed in
  the client exports. Example fixes (sites-bbox predicate signature + port).

## [0.4.15] — 2026-06-03

### Added

- **Live custom reads via whole-doc recompute** (`src/server/postgres/listener.ts`). A `CustomDocDef` may now provide `recompute(pool, criteria, identity?)` *instead of* `query` + `matches`: on open, and on any write to a `watch`ed collection, the whole doc is re-evaluated **per subscriber** (under that client's gated identity, so RLS applies) and republished as a single root-replace op. This makes **nested/joined** custom reads live — the case the flat per-row `matches` model can't express — without a fragile nested diff. Membership defs (`query` + `matches`) are unchanged. (PG integration test in `tests/postgres-custom.test.ts`.)
- **`applyOps` whole-doc root replace** (`src/core.ts`). An empty/root path (`""` or `"/"`) on `replace`/`remove` now swaps or clears the whole doc **in place** (object↔object, array↔array). Because the client applies ops in place and bumps `dataVersion`, this works end-to-end (server + client) from the one core change — the primitive the recompute republish builds on. +unit tests.

### Changed

- **delta-doc skill: documented the SQL-side doc-ops composition API** (`.claude/skills/delta-doc/reference.md`). The stored functions (`delta_open`/`delta_open_as`, `delta_apply`/`delta_apply_as`) were always callable from inside custom `plpgsql`/SQL, but the reference framed them only as the Bun layer's contract. Added a "Composing doc operations from SQL" recipe: a custom read evaluator composes docs via `delta_open_as` (identity bound one-shot, so RLS applies to every table it reads — avoiding the silent `app.user_id = ''` scope-to-nothing and the `::bigint`-on-`''` throw); a stored write mutates-and-broadcasts via `delta_apply_as` (never a raw `INSERT`, which wouldn't NOTIFY); and the `SECURITY DEFINER`-bypasses-RLS caveat (delta is persistence + broadcast, not authorization — a privilege-escalating function must enforce its own guards). Docs only, no code change — turns a supported-but-undocumented pattern into a documented one that generators (e.g. hjeli) can target.

## [0.4.14] — 2026-06-02

### Added

- **Private RPC methods — `_`-prefixed names are never callable from the WebSocket** (`src/server/server.ts`). The `call` dispatcher now rejects any inbound method whose name starts with `_`, responding with `{ error: { message: "Private method: <name>" } }` *before* any registered handler runs — so the gate can't be bypassed by a catch-all `ws.on("call", …)` and also covers names that were never registered. `registerMethod` complements this by throwing if asked to register a `_`-name, since such a method could never be reached over the wire (a programming error). Establishes the public/private boundary for the method surface: public methods are the sanctioned wire API; `_`-helpers are internal building blocks meant to be composed inside other handlers' bodies (e.g. generated precondition/guard predicates reused across commands). Id-less calls to a private method stay silent, consistent with the existing unknown-action behaviour.

## [0.4.13] — 2026-05-31

### Added

- **`bunx delta install-skills` — vendor Claude Code skills into the consumer repo** (`cli.ts`). Discovers `.claude/skills/*` from this package and from any sibling package in `node_modules` (e.g. `@blueshed/railroad` ships `railroad` and `bun-route`), then copies each skill into `./.claude/skills/<name>/` so Claude Code's project-skill autodiscovery picks them up. Flags: `--user` writes to `~/.claude/skills/` instead; `--dry-run` previews without touching disk. Re-runs are idempotent: byte-identical destinations are skipped; locally edited copies are overwritten with a `.bak` backup of the previous contents. Closes the gap where skills bundled with an npm package weren't discoverable until the consumer manually copied them out of `node_modules`.

### Changed

- **delta-doc skill refactor — SKILL.md trimmed from ~285 to ~172 lines, reference.md absorbs the moved content** (`.claude/skills/delta-doc/SKILL.md`, `.claude/skills/delta-doc/reference.md`). SKILL.md is now the router: canonical recipe + rules-as-one-liners + pointer index. Reference.md is the manual: railroad recipe (moved), CLI section (moved), and the existing in-depth sections. Every Rules bullet that used to carry a paragraph of detail now ends with `→ reference.md → <section>`. Principle stated up front: "this file is the router; reference.md is the manual." Reduces the per-session context cost of loading the skill without losing protection against any footgun.
- **Bumped `@blueshed/railroad` devDependency from `0.8.0` to `0.8.2`**. Peer range (`^0.8.0`) unchanged. Patch-level on the same minor; the four railroad primitives delta uses (`signal`, `peek`/`touch`, `key`, `inject`) are unchanged.
- **`package.json` `files` widened to `.claude/skills/delta-doc/**`** (was listing `SKILL.md` and `reference.md` individually) so future additions to the skill directory ship without needing a `files` update.

## [0.4.12] — 2026-05-31

### Changed

- **delta-doc skill — write loop documented** (`.claude/skills/delta-doc/SKILL.md`, `.claude/skills/delta-doc/reference.md`). `doc.send` echoes the same op back to the sender, which is what patches `doc.data` and fires `onOps` — so optimistic updates double-apply on echo (rows added twice, counters landing at +2, chat lines appearing twice), and reloads/re-opens after a write are pointless because `doc.data` is already the live in-place-patched state. Adds a non-negotiable rule to SKILL.md, a reinforcing comment in the canonical recipe's `send()`, and a dedicated "The write loop" section in reference.md (with the latency tradeoff and the transient-feedback escape hatch).
- **delta-doc skill — "no brute-force reload" framed as categorical** (`.claude/skills/delta-doc/SKILL.md`, `.claude/skills/delta-doc/reference.md`). A reload is never necessary under any trigger, because the framework owns the only two full reads that ever happen — the initial open and an automatic re-open of every tracked doc on every reconnect (`client.ts:178`, so outages self-heal). Reframes both the SKILL.md rule and the reference.md section away from "after a write" to unconditional, and adds a table walking through each tempting trigger (post-write, reconnect, refocus, "might be out of sync", "force-refresh to be safe") and why none of them needs a manual read.

## [0.4.11] — 2026-05-26

### Added

- **List-mode docs honour `include`** (`src/sql/001c-delta-read.sql`). A doc opened in list mode (`defineDoc("catalog:", { root: "products", include: ["parts", "faces"] })`) now returns every included collection in full alongside the root, with no FK filter — the answer to "catalog-shaped" workloads where a small reference table plus its children wants to open as a single doc. Previously the list branch silently dropped `include`, forcing apps to write custom `DocType` handlers that read each collection by hand. New helper `_delta_load_collection_all(key, at)` does the unfiltered load and is temporal-aware. Single-mode docs are unchanged (children still filter by `parent_fk = root.id`); writes already routed by path so `delta_apply` needed no change. Backwards-compatible: list docs declared with `include: []` keep returning only the root.

## [0.4.10] — 2026-05-21

### Added

- **RFC 6901 JSON Pointer path escaping** — path segments now unescape `~1` → `/` and `~0` → `~` via a shared `splitPath` helper exported from `src/core.ts`, applied uniformly across the SQLite (`src/server/sqlite.ts`) and Postgres (`src/server/postgres/{listener,schema}.ts`) backends. Row ids and field names containing `/` or `~` can now round-trip through delta ops without ambiguity.
- **Schema type-drift warnings in `migrateSchema`** — the SQLite migrator now reads existing column metadata via `PRAGMA table_info` and emits a `console.warn` when a declared column type differs from the schema definition, so drift surfaces at startup instead of silently mis-coercing reads.

### Changed

- **SKILL.md** documents JSON Pointer path escaping under the op vocabulary and adds a Type-drift warning bullet to the Footguns list.

## [0.4.9] — 2026-04-25

### Requires

- **`@blueshed/railroad` ≥ 0.8.0** (peer) — bumped from `^0.7.0`. 0.8.0 introduces `Signal.mutate(fn)`, `Signal.patch(partial)`, `SignalOptions.equals`, and the `ReadonlySignal<T>` type returned by `computed()` / `Signal.map()`. Delta itself uses only the unchanged primitives (`signal`, `Signal<T>.set/peek/touch`, `key`, `inject`, `createLogger`); the bump aligns delta with consumers that adopt the new helpers, and lets the skill recipe use `list()` / `when()` against the same `Signal` instance backing `doc.data`. Consumers pinned to 0.7.x must upgrade alongside this release.

### Added

- **`examples/kanban/` now has a canonical railroad UX** — `serve.ts` boots a fullstack `Bun.serve` (HTML route + WS + LISTEN/NOTIFY listener), `client.tsx` renders the board with `provide(WS, ...)` + `openDoc<BoardDoc>("board:1")` + `list(doc.data.map(...), keyFn, item$ => …)`. Click a card to cycle columns, double-click a header to rename, click "+ add card" to insert. Conforms to railroad's SKILL: no `.get()` in JSX children, `list()` keyed render with `Signal<T>` per row, `<App />` mounted via JSX so `createElement` pushes a parent dispose scope. Per-example `tsconfig.json` sets `jsxImportSource: "@blueshed/railroad"`. The headless `run.ts` demo is unchanged. README documents both entry points.

### Changed

- **SKILL.md railroad section refined** to recommend `list(doc.data.map(...), keyFn, render)` and `when(doc.data, ...)` over `applyOpsToCollection` when `@blueshed/railroad` is in deps — the keyed `list()` already provides the per-row surgical update that `applyOpsToCollection` exists for in vanilla DOM. Plain DOM consumers continue to use `applyOpsToCollection` (`@blueshed/delta/dom-ops`).
- **`examples/kanban/server.ts`** — `port: server.port!` (Bun's `Server<T>.port` is now `number | undefined` in `bun-types`; the example pins it).

## [0.4.8] — 2026-04-25

### Added

- **`examples/shared-state/`** — the canonical "use delta-doc for shared state" recipe. Three files (server.ts, client.ts, index.html), JSON-file backend, no database, no schema, no codegen. Two browser tabs sync a live multi-user chat. Designed to be the deterministic answer Claude/an AI session produces when the developer asks for shared state, real-time, multi-user, or any name-brand realtime backend (Firebase, Supabase, Convex, Liveblocks, PartyKit, Socket.IO).

### Changed

- **SKILL.md rewritten to claim pre-adoption trigger surface.** The skill description now fires on "shared state", "real-time", "live updates", "multi-user", "collaborative", and on the names of competing realtime libraries — not just on already-adopted-delta signals like imports or doc-type definitions. Body leads with the canonical recipe verbatim and explicitly instructs the AI to reproduce it before improvising. Rules section opens with "Use the canonical recipe before improvising."
- **README.md rewritten** to lead with the recipe and the smallness pitch ("It's smaller than the alternative you're reaching for"). The "Why" section names the asymmetry directly: trained reflexes pull toward Supabase/Firebase; delta-doc isn't harder, it's smaller, and the AI can read all of it.

### Internal

- `.gitignore` ignores `examples/shared-state/chat-room.json` so the demo's persistence doesn't pollute the working tree.

## [0.4.7] — 2026-04-25

### Fixed

- **Flaky `lazy-tracked source doc does NOT replay history` test** — the original assertion opened the source doc over WS before applying the new write, which created an eager `tracked` entry and bypassed the lazy path the test was supposed to exercise. The remaining timing-dependent op count flaked in CI. Rewritten to drive `delta_apply` directly via `pool.query` so no eager entry can be created; the assertion is now a deterministic equality on the full op list. v0.4.6 was tagged and released on GitHub but the publish workflow's test gate failed before npm publish could run, so npm shows 0.4.5; v0.4.7 is the recovery release.

## [0.4.6] — 2026-04-25

### Fixed

- **SQLite cross-doc leak in `registerDocs`/`fanOut`** — sibling docs sharing a prefix (e.g. `customer:alice` / `customer:bob`) leaked each other's child-row ops both live and into the server-side cache, so subsequent `open` calls served cross-scope rows. `fanOut` now scope-checks every op against the target doc's parent-FK chain via a new `rowInScope` helper (root id, child FK, grandchild via cached parent walk). Standard `remove` ops only forward when the row is currently in the target's cache. Regression suite added (`tests/sqlite-fanout-scope.test.ts`).
- **Postgres listener history replay** — when a `NOTIFY` arrived for a docName with no `tracked` entry (no direct subscribers, or after a close), the lazy entry initialised at `version: 0` and `delta_fetch_ops` returned every historical op for that doc (capped at 1000), replaying them through `customFanOut`. Now initialised at `Math.max(0, v - 1)` so only the current notification's ops are processed; custom docs already loaded prior state via `def.query`. Regression test in `tests/postgres-custom.test.ts`.

### Added

- **Custom doc types — predicate-based membership views** (`defineCustomDoc`). A custom doc declares a `prefix`, the `watch`ed collections, a `parse(docId)` for criteria, an initial `query(db|pool, criteria)`, and a `matches(coll, row, criteria)` predicate. Writes still go through standard docs; the framework evaluates membership on each commit and emits `add` / `replace` / `remove` ops on the custom doc's own shape (memoised per distinct criteria). Read-only — `delta` against a custom doc returns 403. Available on both backends:
  - SQLite: optional 5th arg `customDocs` to `registerDocs(ws, db, schema, docs, customDocs?)`.
  - Postgres: `opts.custom` to `createDocListener(ws, pool, { custom })`.
- **Runtime CLI commands** — `bunx delta open|watch|delta|call` for talking to a running delta server. URL resolution: `--url` → `DELTA_WS_URL` → `.delta` file in cwd → `ws://localhost:${PORT:-3100}/ws`. The `delta` subcommand opens the doc on the same socket before applying so it works against SQLite's cache-required apply path.
- **Backend-agnostic isolation property** (`tests/helpers/isolation.ts`) plus three suites that apply it (`tests/sqlite-isolation.test.ts`, `tests/postgres-isolation.test.ts`, `tests/sqlite-fanout-scope.test.ts`). Pins per-doc isolation against both backends so the leak fixed above can't regress.
- **`examples/sites-bbox/`** — worked example of a custom doc (sites within a bounding box) with both SQLite (`server.ts`) and Postgres (`server-pg.ts`) wirings. Same client code; only the server-side wiring differs.
- **Listener cleanup on destroy** (`src/server/postgres/listener.ts`) — `notification` and `error` listeners are now removed from the released pg client to prevent stale handlers firing on recycled pool connections (uncovered while running the per-test custom-doc suite).

### Documentation

- README now leads with three backends (JSON file / SQLite / Postgres) and includes a "Choosing a backend" section, runtime CLI block, and custom-doc pointer. Skill description (`SKILL.md` frontmatter) and exports tables updated to match.

### Internal

- `.gitignore` now ignores `*.sqlite{,-shm,-wal}` and `*.db{,-shm,-wal}` so example/test runs don't pollute the working tree.

## [0.4.5] — 2026-04-23

### Changed

- **Client echo applies ops in place** (`src/client/client.ts`) — `structuredClone` is gone from the hot path. Server → client op broadcasts now mutate `doc.data.peek()` directly via `applyOps`, then `entry.data.touch()` fires subscribers. This matches the server's documented in-place semantics (`core.ts:48`) and fixes a class of silent UI bugs where captured child references (e.g. a shape row bound into a drag-handler closure) went stale on every echo — first interaction correct, second interaction reading mount-time coords. Performance upside too: a 1000-row collection receiving a single-field update no longer clones 1000 rows per op.

### Requires

- **`@blueshed/railroad` ≥ 0.7.0** (peer) — needed for `Signal.touch()`, which the client now uses to notify subscribers after in-place mutation. `set(sameRef)` is a no-op under `Object.is`, so `touch()` is the escape hatch. Consumers pinned to railroad 0.6.x must upgrade alongside this release.

## [0.4.4] — 2026-04-20

### Fixed

- **Publish workflow** — rewritten to match the pattern used in `@blueshed/railroad`: trigger on `release: published`, Node 24, `NODE_AUTH_TOKEN=""` prefix to force OIDC Trusted Publishing over the token fallback `setup-node` otherwise configures, tests + publish inline. Tags `v0.4.1` / `v0.4.2` / `v0.4.3` exist in git but never reached npm; `0.4.4` is the first tag to ship through the automated pipeline. Users jumping from `0.4.0` → `0.4.4` on npm miss nothing — the intermediate versions were stuck-in-transit, not deliberately skipped.

## [0.4.3] — 2026-04-20

### Fixed

- **Publish workflow** — two changes so it actually ships to npm. (1) Drop the CI gate duplication: `ci.yml` already runs on the main-branch push and `/publish` runs `bun run ci` locally before tagging, so re-running the full gate in `publish.yml` was ceremony. (2) Swap in-place `npm install -g npm@latest` for `corepack prepare npm@latest --activate` — the in-place path hit a `MODULE_NOT_FOUND: promise-retry` self-upgrade race on hosted runners, which corepack sidesteps. v0.4.2 never reached npm; 0.4.3 is the first automated release.

## [0.4.2] — 2026-04-20

### Fixed

- **Publish workflow uses npm Trusted Publishing** (`.github/workflows/publish.yml`) — was configured for a classic `NPM_TOKEN` secret; the registry is actually set up for OIDC. Added `permissions: id-token: write` on the job, upgraded the runner's npm to 11.5.1+ (required for Trusted Publishing), and swapped `npm publish --access public` for `npm publish --access public --provenance` to emit attestations alongside the package. v0.4.1 was tagged but never reached npm because of this; 0.4.2 is the first automated release.

## [0.4.1] — 2026-04-20

### Added

- **GitHub Actions publish workflow** (`.github/workflows/publish.yml`) — fires on `v*` tag push, spins up Postgres 18 via `docker compose`, runs `bunx tsc --noEmit` + `bun test tests/`, verifies the pushed tag matches `package.json` version (catches tag/version drift before it hits the registry), and publishes to npm with `NPM_TOKEN` from repo secrets. The tag push on `git push --follow-tags` is now the explicit "make public" moment; the rest is automated.

### Changed

- **Tarball trim** — `.claude/commands/publish.md` is no longer shipped in the npm tarball. Each project adopting `@blueshed/delta` should copy the publish skill into their own `.claude/commands/` and tune the release cadence to fit (different preflight checks, CI gates, auth). The skill stays in-repo for our own releases.

## [0.4.0] — 2026-04-20

### Added

- **`src/schema.ts`** — shared schema vocabulary (`ColumnDef`, `ColumnType`, `TableDef`, `Schema`, `ResolvedTable`, `DocDef`, `defineSchema`, `defineDoc`, `ValidationError`) used by both the Postgres and SQLite backends. Previously duplicated word-for-word across `src/server/postgres/schema.ts` and `src/server/sqlite.ts`; the backends now re-export from here and only carry their own SQL helpers (`columnSqlType`, `defaultForType`, `validateFieldType`). SQLite now accepts `timestamptz` columns (stored as `TEXT` / ISO-8601) to match the shared type union.
- **`examples/kanban/`** — runnable reference server + three reactive clients demonstrating the core pitch: state in Postgres, views on every device, ops as the sync vocabulary. One `delta_open` composes a nested doc from three relational tables via JSON functions; `delta_apply` mutates them atomically; `pg_notify` / `createDocListener` / `ws.publish` fan the ops out to every subscriber; each client's reactive `data` signal updates via the client's built-in `applyOps` dispatch. No hand-written SQL in the write path.
- **`examples/todos-vs-rls/`** — side-by-side model of delta's `DocType` layer vs raw RLS. Shows three things RLS alone can't cleanly do: reshape (add computed aggregates to the response), inject on write (stamp `owner_id` / `created_at` from identity), and dispatch (`todos:me` vs `todos:team:42` through one handler).
- **`WsClient.close()`** (`src/client/client.ts`) — closes the reconnecting socket, suppresses the reconnect loop, rejects pending `send` promises, and clears per-client doc subscriptions. Idempotent. Tests and scripts that tear down a server no longer need `process.exit` workarounds.
- **Multi-instance `openDoc(name, ws?)`** — each `connectWs()` instance now owns its own reactive state map, so two clients in one process get independent `data` signals + `onOps` handlers. Browser DI path unchanged (`openDoc("foo")` still resolves the client from `inject(WS)`); scripts pass the client explicitly. `call(method, params, ws?)` gets the same optional parameter.
- **Scope DSL test matrix** (`tests/postgres.test.ts`) — every operator (`:id`, `=:name`, `>=:start`, `<=:end`, `like:prefix`, multi-key AND, empty-scope single/list, invalid-operator raise, end-to-end `delta_open` with scope) now has a direct assertion. Previously the operators had zero coverage.
- **Skill + reference updates** — `SKILL.md` gains four new rules covering fail-fast scope validation, the `delta_open` raising contract, `openDoc(name, ws?)` multi-instance usage, and `wsClient.close()` for clean teardown. `reference.md` adds the "scope keys must be real columns" note, a "Client-side tests and one-shot scripts" subsection, and a fixed scoped-single example that uses bare column names (not dotted keys).

### Changed

- **Fail-fast on `delta_open` / `delta_open_at` config errors** (`src/sql/001c-delta-read.sql`, `src/sql/001e-delta-ops.sql`). Unknown doc prefix and unknown root collection now raise `P0001` with a pointed message instead of returning NULL. The list-mode `open_at` case still returns NULL (supported "can't time-travel this shape" signal; `loadDocAt` maps it to `null`).
- **`_delta_resolve_scope` validates scope keys + whitelists range operators** (`src/sql/001b-delta-scope.sql`) — `scope: { "items.id": ":id" }` errors with `scope key "items.id" is not a column of "items" (valid keys: id, …)` instead of silently matching no rows. Range operators are whitelisted to `=, >=, <=, >, <, !=` so no future exposure of scope values to user input can smuggle arbitrary SQL into the generated WHERE clause.
- **`generateSql` emits `ALTER SEQUENCE … OWNED BY table.id`** (`src/server/postgres/codegen.ts`) — so `TRUNCATE … RESTART IDENTITY` resets the sequence. Non-breaking; fixes a silent-drift trap where re-seeds inherited stale counter values across runs.
- **`SKILL.md` "Regenerate 003-tables.sql" rule** — was `002-tables.sql`, which collided with the auth-jwt reference schema's `002-users.sql`. Now consistent with the CLI defaults and every other mention in the skill / CLI / examples.

### Driven by

A feedback loop from building two examples against the skill and noticing the first kanban iteration wasn't really *using* the library — it hand-rolled SQL around `_delta_bump_and_notify` instead of going through `docTypeFromDef` + `delta_apply` + `createDocListener`. Reworking it surfaced four ergonomic bugs that block "easy for Claude" in practice: silent NULL on config errors, `seq_*` counters drifting because `TRUNCATE RESTART IDENTITY` doesn't reset un-owned sequences, `connectWs` reconnecting forever after a server stop, and `openDoc`'s hidden module-level state blocking multi-client scripts. Each is now either fast-failing or per-client, with a message that says what's wrong and what's valid. A parallel four-agent review then flagged the schema-type duplication between the Postgres and SQLite backends, a scope-DSL example in `reference.md` that the new fail-fast raise would reject, a filename drift in `SKILL.md`, and the lack of scope-operator test coverage — all addressed here.

## [0.3.0] — 2026-04-20

### Added

- **`@blueshed/delta/dom-ops` subpath** (`src/client/dom-ops.ts`): `applyOpsToCollection(parent, collection, ops, { key, create, update?, remove? }, nodes?)` routes delta ops to a keyed `Map<id, Node>` and mutates the DOM surgically — no rebuild from `doc.data`, so focus, scroll, inputs in flight, and CSS transitions survive every op. Paired with six tests in `tests/dom-ops.test.ts`.
- **`Doc.onOps(handler)`** (`src/client/client.ts`): subscribe to raw `DeltaOp[]` **before** the full-state `doc.data` signal updates. Lets DOM patchers see the change-event, not a state blob. Returns an unsubscribe function.
- **1-RTT identity-scoped stored functions** (new `src/sql/001f-delta-as.sql`): `delta_open_as(user_id, doc_name)`, `delta_apply_as(user_id, doc_name, ops)`, `delta_open_at_as(user_id, doc_name, at)`. Each wraps `PERFORM set_config('app.user_id', …, true)` + the base call; the SELECT's implicit transaction scopes the setting, and RLS reads it back identically.
- **Bench suite** (`bench/`): single-write workload across `delta-new`, `delta-old`, and `raw-postgres` adapters. Results captured in [bench/results-0.3.0.md](bench/results-0.3.0.md) — on realistic (20 ms RTT) networks, `delta-new` is ~4× faster per authenticated op than `delta-old`.
- **Skill updates** (`.claude/skills/delta-doc/`): `SKILL.md` + `reference.md` cover the `dom-ops` export, the "never rebuild a collection inside an `effect`" rule, the canonical `onOps` + `applyOpsToCollection` pattern, and the `*_as` stored-function row + transparency note.

### Changed

- **`docTypeFromDef` hot path** (`src/server/postgres/registry.ts`): when `opts.auth?.asSqlArg` is set, `open` / `apply` / `openAt` call the `delta_*_as` variants directly — one round-trip per op. `withAppAuth` is no longer on the auth hot path; it stays exported as the escape hatch for arbitrary queries under an identity that can't be expressed as a single SELECT.

### Driven by

Two observations from feedback sessions. (1) `withAppAuth` was taking four round-trips (`BEGIN` / `set_config` / call / `COMMIT`) for one logical op the protocol can do in one — at 20 ms RTT, an 80 ms tax per authenticated write, compounding into UI lag on a mobile app. (2) The dominant client pattern would be `effect(() => rebuild(list, doc.data.get()))`, which throws away the op-level precision delta already has — focus, scroll, animations all reset on every keystroke in a collaborative doc. `dom-ops` + `onOps` preserves that precision end-to-end; the `*_as` variants collapse the four RTTs into one.

## [0.2.1] — 2026-04-19

### Added

- **Codegen** (`src/server/postgres/codegen.ts`): `generateSql(schema, docs)` produces a self-contained `CREATE TABLE` + `_delta_collections` + `_delta_docs` SQL file from TypeScript. Ported from `clean/tasks.ts`.
- **Bootstrap helpers** (`src/server/postgres/bootstrap.ts`): `applyFramework(pool)`, `applySql(pool, sql)`, `frameworkSql()`, `frameworkSqlFiles()` for programmatic DB setup.
- **Auth-JWT bootstrap** (`src/server/auth-jwt.ts`): `applyAuthJwtSchema(pool)`, `authJwtSql()`, `authJwtSqlFile()`.
- **CLI** (`cli.ts`): `delta sql <module>` regenerates table SQL; `delta init <dir> [--with-auth]` copies framework + optional users SQL into a consumer's `init_db/` with a `-- @blueshed/delta <kind> v<version>` header. `--upgrade` replaces older files with `.bak` backups, refuses to clobber files missing the header or at a newer version, and no-ops when already current.
- **`logout` action** on `jwtAuth` — clears `client.data.identity` for identity-switching on a live socket.
- **`DeltaError`** type export from `src/client/client.ts` with an `isDeltaError(e)` narrowing helper for typed rejection handling.
- **Skill recipes** in `reference.md`: per-user list isolation (most common multi-tenant shape), RLS two-pool pattern (admin + non-super `app` role for real RLS enforcement), auth-before-open race note, `scope` syntax table (`:id` vs `id` distinction), `owner_id` injection + RLS `WITH CHECK` rationale, Bun HTML-route + WebSocket co-serve recipe, `docker-entrypoint-initdb.d` bootstrap option, session-restore client flow (`localStorage.token` → `call("authenticate", ...)` on load).
- **`/publish` command** at `.claude/commands/publish.md` — reproducible release pipeline (preflight → CI → bump → CHANGELOG promote → commit → tag). Prints the `git push` command but does not push.

### Changed

- **`src/` layout.** All library code moved under `src/` with three children: `src/client/` (browser), `src/server/` (Bun + backends), `src/sql/` (vendored SQL — framework `001a-001e-*.sql` plus `auth-jwt.sql`). Shared `DeltaOp` primitive is `src/core.ts`. Subpath exports from `package.json` are unchanged (`@blueshed/delta/client`, `/server`, `/postgres`, `/auth`, `/auth-jwt`, etc.) — the reorganization is internal only.
- `compose.yml` annotated as test-only (`tmpfs` is ephemeral; real apps use a named volume).

### Fixed

- **`delta init` no longer requires `jose` to be installed.** The CLI was eagerly importing `auth-jwt.ts` (which value-imports jose at module load) just to read a file path constant. Split the SQL-file helpers into `src/server/auth-jwt-sql.ts` — the CLI imports from there; `@blueshed/delta/auth-jwt` still re-exports them for consumers.

### Driven by

Three fresh Claude sessions that built the same multi-user todo app against the skill. The first surfaced the codegen gap, the missing per-user recipe, the RLS two-pool requirement, the auth-before-open race, and the missing logout / error-type primitives. The second (with those fixes in place) surfaced the `scope` syntax subtlety, the injection-vs-RLS overlap, and the Bun route + WS wiring question. The third surfaced the CLI's eager jose import and the missing `docker-entrypoint-initdb.d` + session-restore recipes — all now in `reference.md`.

## [0.1.0] — 2026-04-18

Initial extraction from `@blueshed/railroad` (delta-*) and the `clean` venue-manager.

### Added

- **Core primitive** (`core.ts`): `applyOps` and `DeltaOp` (add/replace/remove on JSON-Pointer paths).
- **Client** (`client.ts`): reconnecting WebSocket, `openDoc` reactive signal, `call` RPC. Peer-deps `@blueshed/railroad`.
- **Server** (`server.ts`): `createWs` action router, `registerDoc` JSON-file doc, `registerMethod` RPC.
- **SQLite backend** (`sqlite.ts`): `defineSchema` / `defineDoc` / `registerDocs` with temporal tables.
- **Postgres backend** (`postgres/`): schema definition, SQL helpers, stored-function framework (`001a-001e-*.sql`), single-LISTEN dispatch (`createDocListener`), doc-type registry (`registerDocType`, `docTypeFromDef`).
- **Auth extension** (`auth.ts`): `DeltaAuth<Identity>` contract, `wireAuth`, `upgradeWithAuth`. No URL-token path by construction.
- **JWT reference** (`auth-jwt.ts` + `auth-jwt.sql`): `jwtAuth({ pool, secret })` with login/register/authenticate actions, bcrypt via pgcrypto.
- **RLS plumbing** (`postgres/auth.ts`): `withAppAuth(pool, sqlArg, fn)` sets `app.user_id` for the transaction.
- **Test infrastructure**: `compose.yml` (Postgres 18), setup helpers, 171 tests across 7 files (85% functions / 87% lines).
- **Skill**: `.claude/skills/delta-doc/` with router SKILL.md and reference.md.

### Lineage

Evolution of `dzql` (database-first codegen for Vue/Pinia), `seiro` (CQRS over WebSocket with Preact Signals), and `paintbrush` (delta-sync WS infrastructure). Realised as a Postgres-native primitive in the `clean` venue-manager; this package is the extraction.

### Known gaps

- `postgres/sql.ts` codegen (TS schema → `002-tables.sql`) not yet extracted — consumers bring their own or write SQL by hand.
- `@blueshed/railroad` still ships its own `delta-*` modules; strip after delta bakes.
- Full RLS policy enforcement requires a non-superuser role (BYPASSRLS overrides FORCE). Test suite verifies plumbing only.
