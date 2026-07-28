# TODO — known open bugs

Findings from a full review of v0.5.0 (core, both backends, client, tests, docs).

**Last re-verified at `a82488a`** — after the write-scoping fixes *and* the
railroad 0.10 sync landed. Every entry below was re-checked against that tree:
all eleven are still open, and every file:line reference still resolves. The
two whose code paths the railroad work touched (#1, #2) were re-run
end-to-end rather than re-read — `normalizeForBroadcast` only rewrites depth ≥ 3
ops, so the depth-2 pollution path echoes unchanged.

This list is closed, not a sample. It is what one review pass found; it is not
growing as work proceeds.

Two confidence tiers:

- **Confirmed** — reproduced by running code. Repro steps are given.
- **Reported** — surfaced by review agents reading the code, and the code still
  reads that way, but not exercised end-to-end. Verify before fixing.

Fixed already (for context, not open): cross-doc writes on both backends;
`_delta_cascade_remove` announcing removals it hadn't made; `applyOpsToCollection`
losing its node map; non-temporal SQLite rows being unupdatable; and, in the
railroad sync, field-level ops leaving keyed `list()` rows stale on the
JSON-file backend, double flushes per broadcast, and a doc opened before
`provide(WS, ...)` never receiving.

---

## P0 — remotely triggerable

### 1. Prototype pollution in `applyOps` — FIXED

> **FIXED** (batch 1): `applyOps` now rejects `__proto__` / `constructor` /
> `prototype` as reference tokens, in `core.ts` so all three backends and the
> browser client inherit it. A **second vector** turned up while testing and is
> fixed too: a root replace whose *value* carried an own `__proto__` key
> re-pointed the document's prototype, because `Object.assign` honours that key
> by invoking the prototype setter — root replaces now copy own keys explicitly
> and skip the dangerous ones. Whole tokens only, so a field legitimately named
> `constructorName` is unaffected. Regression tests: `tests/core.test.ts` →
> "prototype pollution" describe (5 path vectors, the value vector, the
> substring control, and batch-partiality).

`src/core.ts:61`. `applyOps` walks a client-supplied JSON Pointer and assigns
through it with no key filtering, so `__proto__` and `constructor/prototype` are
reachable path segments.

The JSON-file backend (`registerDoc`, `src/server/server.ts`) applies client ops
with no validation at all, then **echoes them verbatim** to every subscriber. So
one client poisons the server process *and* every other connected browser.

```ts
// against a registerDoc server, from an unauthenticated socket:
{ action: "delta", doc: "chat:room",
  ops: [{ op: "add", path: "/__proto__/isAdmin", value: true }] }
// server: ({}).isAdmin === true
// every peer that applies the broadcast: ({}).isAdmin === true
```

SQLite and Postgres reject `/__proto__/x` incidentally — `__proto__` fails the
"unknown collection" check — but `/items/1/__proto__` passes `validateOps`,
because the column lookup is `table.columns[field]`, and indexing a plain object
with `__proto__` returns a truthy value.

Fix in `core.ts` so all three backends and the client inherit it: reject
`__proto__` / `constructor` / `prototype` as reference tokens in `splitPath` or
`walk`. Use `Object.create(null)` or a `Map` for the column lookup in
`validateOps` while you're there.

### 2. Malformed WS frame → unhandled rejection — FIXED

> **FIXED** (batch 1): the parse moved inside the `try`, with `msg`/`id`/`action`
> hoisted so the existing catch can still answer on an id when it recovers one.
> A parse failure has no id to answer on, so it logs only. Regression tests:
> `tests/server.test.ts` → "malformed frames" describe — no unhandled rejection,
> the socket still serves valid frames afterwards, a throwing handler still
> answers on its id, and a bad frame is not misrouted to `_raw`.

`src/server/server.ts:174`. `const msg = JSON.parse(String(raw))` sits **outside**
the `try` that begins at line 184, inside an `async` handler. Any non-JSON frame
rejects with nothing to catch it and no `id` to reply on.

```
send the literal bytes `not json` → "UNHANDLED REJECTION: JSON Parse error"
```

The socket survives under Bun's default rejection handling, so this is a
robustness/log-noise issue rather than a crash — but a process that installs a
strict `unhandledRejection` handler turns it into a remote kill. Move the parse
inside the `try` and reply `400` when an `id` can be recovered.

---

## P1 — silent data loss / wrong data

### 3. Whole-row `replace /<coll>/<id>` acked but discarded (SQLite) — FIXED

> **FIXED** (second review pass, working tree): implemented as a partial merge
> riding the existing field-batch writer — Postgres parity (`v_row || value`),
> collapses with field ops on the same row, `id`/temporal columns in the value
> ignored. Whole-root `replace /<root>` (previously validate-pass → executor
> 500) merges too. `validateOps` now also rejects non-object replace values and
> `/coll`-level ops with a 400 instead of letting them 500 or no-op.
> Regression tests: `tests/sqlite.test.ts` → "todo fixes" describe.

`src/server/sqlite.ts:~326-352`. The `parts.length === 2` block handles `add` and
`remove`; a `replace` matches neither branch and there is no `else`, so it falls
through, produces no SQL and no broadcast ops — then the handler answers
`{ack: true}`. `validateOps` (`sqlite.ts:~895`) explicitly *accepts* this shape
and type-checks its fields, so nothing upstream rejects it either.

```
open tenant:1 → delta [{op:"replace", path:"/projects/p1", value:{title:"CHANGED"}}]
→ {"ack":true}, DB still holds "Orig"
```

Silent data loss with a positive acknowledgement, and no echo to correct the UI.
This is exactly the failure mode the comment at `sqlite.ts:~901` says the
validator was hardened against. Either implement it (close + reinsert, same as
the field batch) or reject it in `validateOps`. Postgres implements it correctly.

### 4. JSON columns corrupt string values on cold read (SQLite) — CONFIRMED

`src/server/sqlite.ts:1210` (encode) and `:1221` (decode). Encode skips
stringifying a value that is *already* a string; decode `JSON.parse`s any string
it finds. Type identity is lost the moment the row is re-read from SQL rather
than served from cache — i.e. after a restart or a cache eviction.

```
stored "123"   → cold read 123      (number)
stored "true"  → cold read true     (boolean)
stored "[1,2]" → cold read [1, 2]   (array)
stored "hello" → cold read "hello"  (ok — only non-JSON-parseable strings survive)
```

Fix: always `JSON.stringify` on encode, always `JSON.parse` on decode. The
`catch {}` around the decode also swallows genuine corruption — let it surface.

### 5. `insertRootRow` drops the parent FK — REPORTED

`src/server/sqlite.ts:1025`: `const cols = ["id", ...Object.keys(table.columns)]`.
Unlike `reinsertRow` and `insertCollectionRow`, it never appends
`table.parent.fkColumn`. Since `createTables` declares FK columns `NOT NULL`, a
root-field replace on a doc whose **root table has a parent** fails the
constraint and 500s.

Narrow (most roots are top-level) and it fails loudly rather than corrupting.
Note the asymmetry introduced by the recent fix: the non-temporal path now goes
through `updateRow`, which *does* write the FK, so only the temporal root path is
affected. This is the same three-near-identical-row-writers drift described at
the bottom of this file.

---

## P2 — lifecycle and scale

### 6. `evict()` silently mutes live subscribers — REPORTED

`src/server/sqlite.ts:698`. It deletes from `cache` and `customCriteria` but not
`subscriptions`. `fanOut` then runs with `cached === undefined`, which drops
removes and grandchild add/replace ops on the floor (direct children still flow,
because the root-FK check short-circuits first). Result: partial, silent,
permanent divergence for anyone still connected. Either drop the subscription
entry too, or force a reload rather than a bare delete.

### 7. Abrupt disconnects never clean up `subscriptions` / `cache` — FIXED

> **FIXED** (second review pass, working tree): added `onClientDrop(client, fn)`
> to `server.ts` — per-socket teardown hooks (Set, deduped by function identity)
> run from BOTH the transport-level `websocket.close` and
> `dropClientSubscriptions` (logout / identity switch). Both backends register a
> `releaseClient` on every open: sqlite drops the socket from `subscriptions`
> and evicts `cache`/`customCriteria` at zero subscribers (mirrors the close
> action); the Postgres listener does the same for `tracked` and the custom-doc
> maps `pruneDoc` never touched. Regression tests: `tests/sqlite.test.ts` →
> "todo fixes" describe (drop, logout, and survivor-keeps-cache cases).

`src/server/sqlite.ts:~509-525` shrinks those maps only from the `close`
**action** — i.e. only when a client politely sends one. The transport-level
`close` hook (`src/server/server.ts:~242`) removes just the `clientId → socket`
mapping and doesn't notify backends, and `dropClientSubscriptions` unsubscribes
the Bun channel without touching them either.

So every tab close and every dropped connection leaves a dead socket in
`subscriptions`, `size === 0` never fires, and the doc stays cached forever while
`fanOut` iterates a monotonically growing set. After a **logout** the previous
user's scoped doc also stays resident, so a later re-open can serve stale cached
state. Needs a socket-disconnect hook, or a teardown callback registered by
`registerDocs`.

*Narrowed, not fixed, by the railroad sync.* `doc.close()` now sends the server's
`close` action at refcount zero (`src/client/client.ts:565`), and a doc opened
inside a railroad dispose scope closes automatically on teardown — so a
well-behaved client navigating between routes now does release its subscriptions.
What remains is every path where no close is ever sent: a crashed tab, a dropped
network, a non-railroad client, or any client that simply doesn't call `close()`.
The server still has no disconnect-driven cleanup, so those still leak.

### 8. No `busy_timeout`, and `BEGIN` is deferred (SQLite) — REPORTED

`src/server/sqlite.ts:495` issues a plain (deferred) `BEGIN`, and nothing
anywhere sets `PRAGMA busy_timeout` (grep returns zero hits). Two processes on
one file → the first write after a read lock hits `SQLITE_BUSY` immediately with
no retry, and a perfectly valid write 500s.

`BEGIN IMMEDIATE` plus a `busy_timeout` addresses it. Related and worth
documenting either way: the in-memory `cache` is process-local with no
invalidation channel, so **two server processes against one SQLite file serve
divergent state**. Either document single-process as a hard constraint or give
SQLite a change-notification channel like the Postgres listener.

### 9. Unparented included collections are filtered by the *root's* scope — REPORTED

`src/server/sqlite.ts:266-271`. For a collection with no parent, `loadCollection`
builds `WHERE <root scope columns> = ?` against that collection's own table. With
the default scope that becomes `WHERE id = <docId>` — at most the row whose own
id happens to equal the doc id, which is almost never intended. With a custom
scope it references columns that table may not have, and errors at open time.

`rowInScope` compounds it by returning `true` for any unparented collection
("preserve existing behaviour"), so those rows fan out to **every** doc of that
prefix. In a tenant-scoped schema with a shared unparented collection that is a
cross-tenant read leak. No test covers this shape.

---

## P3 — API and packaging

### 10. JWT sessions outlive their tokens — CONFIRMED

`src/server/auth-jwt.ts:180`. `gate()` returns `client.data?.identity` and never
rechecks `exp`. `verifyToken` runs only inside the `authenticate` action, so once
a socket authenticates it keeps full access for the socket's lifetime — and with
`idleTimeout: 60` plus `sendPings`, that is indefinite.

```
authenticate with a token expiring in 1s → ok
wait 3s → gate() still returns the identity
         re-authenticating with the SAME token is correctly rejected
```

Stateless JWT is a legitimate design choice and `verifyUser` exists as an opt-in
hook, but "signed once, valid until disconnect" should at minimum be documented —
or `gate()` should re-verify (stash the token and its `exp` alongside the
identity).

### 11. `import from "@blueshed/delta"` fails — FIXED

> **FIXED** (batch 1): added `".": "./src/core.ts"` to `exports`, so `main`/
> `types` are reachable rather than dead. Regression tests:
> `tests/package-exports.test.ts` — resolves the bare specifier and **every**
> declared subpath for real, from a temp package symlinked to this repo, rather
> than asserting the JSON against itself. Also pins that `"."`, `main` and
> `types` agree, that the bare specifier and `./core` are the same module, and
> that the probe list covers the whole export map.

`package.json` sets `main` and `types` to `src/core.ts` but `exports` has **no
`"."` key** (current keys: `./core ./client ./dom-ops ./server ./sqlite
./postgres ./logger ./auth ./auth-jwt`). When `exports` is present `main` is
ignored, so the bare specifier throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and those
two fields actively mislead. Everyone's first import is the bare one.

Add `".": "./src/core.ts"`, or drop the dead `main`/`types`.

---

## The structural note

Most of the above are instances of two multipliers, not independent defects:

**Three backends reimplement the same op semantics.** A bug class therefore
exists up to three times and gets fixed one instance at a time — the write-scoping
gap needed two separate fixes for one conceptual rule, and #3 is Postgres-correct
but SQLite-broken.

**Inside `sqlite.ts`, three near-identical row writers** — `insertRootRow`,
`insertCollectionRow`, `reinsertRow` (`~1024-1100`) — have already drifted apart,
and #5 *is* that drift rather than a separate bug.

Collapsing those three writers into one, and lifting op semantics into a layer
the backends implement rather than reimplement, removes several of these as a
side effect instead of requiring individual fixes. Worth doing before working
down the list.

Two supporting gaps make the class hard to see: `sqlite.ts` types its `db` handle
and doc values as `any`, discarding checks that would have caught #3 at compile
time; and the tests are strong on the mainstream (temporal, in-scope, happy) path
but thin on the cross-product — writing a single positive-control test is what
surfaced the non-temporal bug.

---

## Addendum — second review pass (2026-07-28, independent full read)

A separate full-source review independently confirmed #3 and #7 before reading
this file (same repro for #3), then fixed both — see the FIXED notes inline
above. Three additional observations, none overlapping the eleven:

### A1. `openDoc` refcount: creator-close race parks a live handle — NOT REPRODUCIBLE (hardened anyway)

> **NOT REPRODUCIBLE** (batch 1). The premise below — that the `pending.refs++`
> path "schedules no microtask of its own" — does not match the code:
> `queueMicrotask` sits *outside* the inner `if/else`, so **every** pending
> handle queues one. Running the exact sequence (A opens pre-provide, B opens
> the same name, A closes, then provide) registers normally and B's `data`
> populates; a control with no close behaves identically.
>
> The guard was still changed to `cur().refs <= 0` (and `ensureClient` to
> `e.refs > 0`) as asked: deciding a *shared* entry's fate from one handle's
> flag is only correct by accident, and would become a live bug the moment
> someone "optimises" the duplicate microtask away. **This is hardening, not a
> bug fix — no observable behaviour changed.** `tests/client.test.ts` →
> "deferred registration refcount" pins the invariant (co-handle close doesn't
> strand the survivor; a fully released doc doesn't register; repeated close of
> one handle can't drive refs negative). Those tests pass before and after —
> they exist to hold the invariant, not to prove a fix.

`src/client/client.ts`, the deferred-registration path added in the railroad
sync. The `queueMicrotask` guard is `if (closed) return` — but `closed` is the
**creating handle's** flag. Sequence: handle A calls `openDoc("x")` before
`provide(WS, ...)` (entry parked in `pendingDocs`), handle B opens the same
name (takes the `pending.refs++` path, which schedules no microtask of its
own), A calls `close()` before the microtask runs. A's flag suppresses the only
registration; `refs` is still 1 but the entry never registers — B's `doc.data`
stays `null` until a `send()` self-heals it. Guard on `cur().refs <= 0`
instead of the handle-local flag.

### A2. JSON-file `persist()` is fire-and-forget — FIXED

> **FIXED** (batch 1): writes are serialized through a promise chain, so
> `persist()` resolves only after its own write and the file always settles on
> the latest state. The chain continues from a swallowed copy so one failed
> write can't wedge it, while the returned promise still rejects — an explicit
> `await handle.persist()` can observe the error, and the fire-and-forget call
> in `applyAndBroadcast` logs it rather than leaving an unhandled rejection.
> Regression tests: `tests/server.test.ts` → "persist queue". The load-bearing
> one instruments `Bun.write` and asserts `maxInFlight === 1`, because ordering
> assertions alone are timing-dependent and prove little about a race —
> verified to report **21** concurrent writers against the pre-fix code and 1
> after.

`src/server/server.ts` `registerDoc`: `applyAndBroadcast` calls `persist()`
without await, queue, or catch. Two rapid deltas race whole-file `Bun.write`s
(the file can settle on the older snapshot if writes complete out of order),
and an fs failure after a successful ack surfaces as an unhandled rejection.
A promise-chain queue (`persisting = persisting.then(write)`) with a logged
catch is ~3 lines. Tier-appropriate today; cheap to harden.

### A3. Depth-2 replace semantics: JSON backend assigns, SQL backends merge — NOTE

With #3 fixed, SQLite and Postgres both treat `replace /<coll>/<id>` as a
partial merge (omitted fields survive). The JSON-file backend's `applyOps`
assigns the value verbatim (omitted fields deleted). Same op, two meanings
across the graduation ladder — the skill/README should say "always send full
rows" (which makes the two behaviours identical), or `registerDoc` should
merge to match. Related to the structural note: op semantics live in three
places.
