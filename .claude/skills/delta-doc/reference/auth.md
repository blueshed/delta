# Signing in

Server and client: the four places auth is wired, and the sign-in `ConnectOptions.onConnect`
(`src/client/client.ts`) exists for (`tests/client.test.ts`, "onConnect").

```ts
// server
const auth = jwtAuth({ pool, secret: process.env.JWT_SECRET! });   // @blueshed/delta/auth-jwt
wireAuth(ws, auth);                                  // auth.actions → "call" handlers
ws.upgrade = upgradeWithAuth(ws, auth);              // onUpgrade: cookie / Authorization
await createDocListener(ws, pool, { types: [docTypeFromDef(def, pool, { auth, owns })], auth });
// SQLite or the JSON file: registerDocs(ws, db, schema, docs, customDocs, { auth, owns })

// client: sign in on EVERY connect, before any document opens or re-opens
provide(WS, connectWs("/ws", {
  onConnect: async (ws) => {
    const token = localStorage.getItem("token");
    if (!token) return showLogin();
    try { showApp(await call<User>("authenticate", { token }, ws)); }   // showApp must be idempotent
    catch { localStorage.removeItem("token"); showLogin(); }           // stale or revoked
  },
}));
```

`DeltaAuth` in `src/server/auth.ts` is the contract: `onUpgrade?`, `actions?`, `gate`,
`asSqlArg?` (for RLS). Delta reads no credentials itself; `jwtAuth` (`bun add jose pg`; needs `auth-jwt.sql`:
`applyAuthJwtSchema(pool)` or `init --with-auth`) is the reference, with `login`, `register`,
`authenticate` and `logout` actions. Who may open which document: `ownership.md`.

## Gotchas

- **Never put a token in the socket URL.** Upgrade-time (cookie or header via `onUpgrade`, no
  hook needed: every new socket arrives signed in) or in-band `call("authenticate", { token })`.
- **Use `onConnect`, not one `await call("authenticate")`**: a reconnect is a new,
  unauthenticated socket; without the hook its re-opens 401 and stop. What the hook sends goes
  out at once; documents wait for it.
- After `login`, store the token: the next reconnect signs in with it.
- **A socket's messages run side by side, except around an identity change** (`authenticate`,
  `login`, `register`, `logout`, or a method you mark with `ws.changesIdentity(method)`): it
  waits for what came before, and what comes after waits for it. So an `open` sent straight
  after `authenticate` is handled signed in.
- A socket may hold 1000 messages and 1 MiB waiting (`createWs({ maxHeld, maxHeldBytes })`); past
  either it closes with 1008 and none runs. Wait for the sign-in's answer before a large frame.
- **`logout` unsubscribes the socket from every document**; after it, open/delta are 401. On an
  identity switch re-open what the new user should see; nothing carries over.
- **A token that runs out** (`exp`): the gate refuses the socket and drops its subscriptions, at
  a request or before a change is told. The socket is told `{ doc, error: { code: 401 } }` and the
  client reconnects, so `onConnect` signs in again. A request's own 401 leaves the socket as is.
- `gate` is asked before every open, delta, open_at, history, undo, redo and close.
- `jwtAuth` writes `users`: give it an admin pool, and documents the app pool (`rls.md`).
