# The server: one `Bun.serve` for the page and the socket

From the recipe's `server.ts` (`recipe.md`):

```ts
import index from "./index.html";
import { createWs } from "@blueshed/delta/server";
import { registerDocs } from "@blueshed/delta/json";
import { room, schema } from "./types";

const ws = createWs();
registerDocs(ws, "./chat.json", schema, [room]);

const server = Bun.serve({
  port: 3100,
  routes: { "/": index, [ws.path]: ws.upgrade },   // Bun bundles the HTML and its TS
  websocket: ws.websocket,
});
ws.setServer(server);
```

`WsOptions` and `WsServer` in `src/server/server.ts` are the contract (`path` defaults to `/ws`).

## Rules

- **`ws.setServer(server)` is required**: without it nothing is broadcast.
- Route order does not matter: the upgrade is its own request.
- `registerMethod(ws, name, (params, client) => …)` adds a `call` method; a name starting with
  `_` is private and throws. Mark one that signs a socket in with `ws.changesIdentity(name)` (`auth.md`).
- Port `0` lets the OS pick one (tests).

## Origins

A WebSocket is not bound by the same-origin policy: any page a signed-in person visits could open
one as them, cookies and all. So `ws.upgrade` (and `upgradeWithAuth`, before `onUpgrade`) answers
**403** to a browser whose `Origin` is not the server's own (the `Host` it asked, whatever scheme a
proxy terminates). A request with no `Origin` (the CLI, a test, a server) is let in.

```ts
createWs();                                                                     // its own origin only
createWs({ origins: ["https://admin.example.com", "http://localhost:5173"] });  // and these
createWs({ origins: "*" });                                                     // every origin
```

- List a page served from another origin (a dev server on another port, an admin app) and the
  public origin when a proxy rewrites `Host`.
- An entry is `scheme://host[:port]`; one that is not a URL throws at `createWs`.
- `refuseOrigin(req, origins)` is the same check for your own upgrade handler: a `Response` to
  return, or `undefined` to go on.

## Gotchas

- The logger is railroad's, kept in step: `@blueshed/delta/logger` (`createLogger`,
  `setLogLevel`, `loggedRequest`), so a server needs no railroad.
- A socket's messages run side by side except around a sign-in; `maxHeld` / `maxHeldBytes`
  cap what waits (`auth.md`).
