# Testing an app, and scripts

From `tests/local.test.ts`: the lightest harness, no socket and no mock.

```ts
function setup() {
  const db = new Database(":memory:");
  createTables(db, schema);
  const local = createLocal();
  const heard: { channel: string; data: any }[] = [];
  local.onPublish((channel, data) => heard.push({ channel, data }));
  const { evict } = registerDocs(local.server, db, schema, [room]);
  return { db, local, heard, evict };
}

test("opens, writes and hears the broadcast", async () => {
  const { local, heard } = setup();
  await local.call("delta", { doc: "room:a", ops: [{ op: "add", path: "/messages/m1", value: { text: "hi" } }] });
  expect(heard[0].channel).toBe("room:a");
});
```

## Other harnesses

- **A real server**: `Bun.serve` on port 0, `connectWs("ws://localhost:<port>/ws")`
  (`tests/client.test.ts`).
- **`@blueshed/delta/testing`** (`src/testing.ts`): `mockClient(data?)` (a socket-shaped client,
  what it was sent in `.sent`; `{ identity }` signed in, `{ local: true }` in-process),
  `sendAndAwait(ws, client, msg)`, `waitFor(predicate, { timeout, interval })`.
- `pointerVectors` and `walkVectors` (`src/pointer-vectors.json`, `src/walk-vectors.json`): the
  path grammar and the undo guard as data, for a parser of your own to run the same cases.
- **Postgres**: the repo's `tests/setup.ts` (`newPool`, `applyFramework`, `resetState`, …) is not
  shipped; copy what you need. `listener.destroy()` after each test. A test that must prove a
  policy blocks makes its own `NOSUPERUSER` role (`rls.md`).

## Driving the client from Bun

- **Pass an absolute URL**: `connectWs("ws://localhost:3000/ws")`; outside a browser there is no
  page to resolve `/ws` against. No `location` shim needed; `wss://` stays `wss://`.
- **Several clients in one process**: each `connectWs` owns its documents, so pass the client:
  `openDoc<Board>("board:1", alice)`, `openDoc<Board>("board:1", bob)`.
- **Always `client.close()`** (idempotent) before stopping a server: otherwise it reconnects for
  ever and keeps the process alive.
- A script sending `delta` itself opens the document first (`wire.md`).

## Running an app against a delta checkout

Install a **packed tarball**, never `file:` or `bun link`: a linked checkout brings its own
railroad, so the page loads two, `doc.data` is a signal the app's railroad does not know, and the
page sits on "connecting…" with no error.

```sh
cd ../delta && bun pm pack && cd ../app && bun add ../delta/blueshed-delta-<version>.tgz
```

After an edit, pack again, then `bun remove @blueshed/delta && bun add <the .tgz>`: `bun.lock`
pins the first tarball by hash, so adding it again or `bun install --force` keeps the old
contents. Deleting `bun.lock` works too.
