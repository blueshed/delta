# Bun HTML Routes — Reference

## How it works

Bun's `serve({ routes })` accepts imported HTML files as route values. When Bun encounters an HTML import from server-side code, it:

1. Scans the HTML for `<script>` and `<link>` tags
2. Bundles referenced JS/TS/TSX/JSX and CSS files
3. Rewrites paths with content-addressable hashes
4. Serves bundled assets automatically

## HTML template

The script extension must match the detected mode (`.js`, `.ts`, or `.tsx`):

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Page Title</title>
    <link rel="stylesheet" href="./page.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./page.{js,ts,tsx}"></script>
  </body>
</html>
```

## CSS strategy — self-contained per route

Each HTML route is a separate entry point with its own self-contained CSS file. Include all styles (resets, layout, typography, route-specific) directly in the route's CSS. Do not create a separate `base.css`.

## Client-side script by mode

### js / ts mode — plain DOM

```ts
function Page() {
  const el = document.createElement("div");
  el.innerHTML = `<h1>Page Title</h1><p>Content here</p>`;
  return el;
}

document.getElementById("root")!.append(Page());
```

### tsx-railroad mode

The sibling `railroad` skill (installed alongside this one in `@blueshed/railroad`'s `.claude/skills/`) covers the API surface and the seven JSX gotchas that bite if you're not careful (`.get()` in children, list keying, SVG namespace, dispose scopes, realtime escape hatches, lowercase event handlers, `list()` vs plain `.map()`). Read it before generating component code.

The mount pattern — `mount()` brackets a dispose scope so effects, `when()`, and `list()` inside the page tear down with it (bare `.append(<Page />)` works but leaves `when()`/`list()` created at the top level un-disposable, and railroad warns):

```tsx
import { mount } from "@blueshed/railroad";

function Page() {
  return (
    <div>
      <h1>Page Title</h1>
      <p>Content here</p>
    </div>
  );
}

mount(document.getElementById("root")!, () => <Page />);
```

For an interactive scaffold, prefer `routes(target, table)` so navigation, params, and dispose scoping work out of the box:

```tsx
import { routes } from "@blueshed/railroad";
routes(document.getElementById("root")!, {
  "/": () => <Page />,
});
```

### tsx-react mode

```tsx
import { createRoot } from "react-dom/client";

function Page() {
  return (
    <div>
      <h1>Page Title</h1>
      <p>Content here</p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
```

## Server registration (server.ts or server.js)

Use `Bun.serve` (not `import { serve } from "bun"` — both work, but `Bun.serve` matches the official docs and avoids one extra import line).

Always enable HMR and browser-console mirroring in dev — they're free wins from Bun 1.3 and the headline reasons to use the fullstack server. They're stripped from production builds automatically.

```ts
import homepage from "./index.html";
import aboutPage from "./about/about.html";

const server = Bun.serve({
  port: process.env.PORT || 3000,
  routes: {
    "/": homepage,
    "/about": aboutPage,
  },
  development: {
    hmr: true,       // import.meta.hot — Vite-shaped API
    console: true,   // mirror browser console.* to the terminal
  },
});

console.log(`Listening on ${server.url}`);
```

`development` is ignored when Bun is started with `NODE_ENV=production` (or via `bun build --production`), so you don't have to gate it manually — leave it on.

## API routes alongside HTML routes

```ts
Bun.serve({
  routes: {
    "/": homepage,
    "/api/users": {
      async GET(req) {
        return Response.json([]);
      },
      async POST(req) {
        const body = await req.json();
        return Response.json(body, { status: 201 });
      },
    },
    "/api/users/:id": async (req) => {
      const { id } = req.params;
      return Response.json({ id });
    },
  },
});
```

### Serving files & media (Bun 1.3.13+)

When a handler returns a `Bun.file(...)` (or a static-file route), `Bun.serve()` honours `Range: bytes=...` automatically — it replies `206 Partial Content` with `Content-Range`, supporting suffix (`bytes=-500`), open-ended (`bytes=1024-`), and standard forms (RFC 9110). This is what lets `<video>`/`<audio>` seek without any extra code. File responses also stream incrementally on SSL and Windows rather than buffering the whole file into memory.

## Production build & deploy

Two paths, both Bun-native — no separate bundler config.

**Static assets** — emit hashed JS/CSS chunks plus a rewritten HTML you can host anywhere:

```sh
bun build ./index.html --production --outdir=dist
```

**Single-binary deploy** — bundle the server, the client, and the runtime into one executable. No Node, no install, no Docker layer required at the destination:

```sh
bun build --compile server.ts --outfile myapp
./myapp
```

`--compile` follows the HTML imports inside `server.ts`, bundles every TSX/CSS/asset reference, and stamps it all into the output binary. Works on macOS, Linux, and Windows; cross-compile with `--target=bun-linux-x64` etc. As of Bun 1.3.14, `--target=bun` keeps `using` / `await using` as native syntax instead of lowering them to transpiled helpers — so the `await using view` pattern in the tests compiles cleanly.

## Key rules

- Always use relative paths (`./`) in HTML for CSS and script references
- CSS and script paths in the HTML are **relative to the HTML file**
- Bun resolves `@import` in CSS and bundles everything — no manual asset pipeline
- Use `type="module"` on script tags
- Supported script extensions: `.js`, `.ts`, `.tsx`, `.jsx` — Bun handles them all
- Only install framework deps when the mode requires them (see SKILL.md Bootstrap)

## Testing routes with `Bun.WebView`

Bun ships a headless browser as the global `Bun.WebView` — no import, no extra install. The global appeared in 1.3.12, but **these patterns assume Bun 1.3.14+**, where the options used below (`clickCount`, per-click `timeout`, constructor `console`/`dataStore`) and the test-runner flags landed. Tests run via plain `bun test`; no `--browser` flag. On macOS it uses system WKWebView; pass `backend: "chrome"` on Linux/Windows. Input is dispatched as real OS events (`isTrusted: true`), and selector methods (`click`, `type`) auto-wait for actionability — there is **no** `waitForSelector` or `waitForFunction`, but selector clicks take a per-call `timeout` (default 30000ms).

Two constructor options are worth knowing for tests:

- `console` — pass `console` (forward page logs to the terminal) or a callback `(type, ...args) => …` to capture and assert on page console output, instead of only the server-side `development: { console: true }`.
- `dataStore` — `"ephemeral"` (default-style throwaway storage per view) or `{ directory }` to persist a profile. Use `"ephemeral"` to keep cookies/localStorage from leaking between tests without managing temp dirs by hand.

### Make the server importable

Tests need to start the server on a random port against a throwaway data path. Refactor the server entry into an exported factory, with a CLI guard for `bun run dev`:

```ts
// server.ts
import indexHtml from "./index.html";

export interface StartOptions { port?: number; /* other injectable paths */ }

export async function startServer(opts: StartOptions = {}) {
  const server = Bun.serve({
    port: opts.port ?? Number(process.env.PORT ?? 3000),
    routes: { "/": indexHtml },
    development: { hmr: true, console: true },
  });
  return { server };
}

if (import.meta.main) {
  const { server } = await startServer();
  console.log(`Listening on ${server.url}`);
}
```

### Test skeleton

```ts
// tests/page.test.ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server";

let server: Awaited<ReturnType<typeof startServer>>["server"];
let url: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "app-test-"));
  const started = await startServer({ port: 0 /*, dataFile: join(tmpDir, "…") */ });
  server = started.server;
  url = server.url.href;
});

afterAll(() => {
  server?.stop(true);
  rmSync(tmpDir, { recursive: true, force: true });
});

test("renders and responds to click", async () => {
  await using view = new Bun.WebView({ width: 1024, height: 768 });
  await view.navigate(url);
  await view.click("#submit");
  // Always pass an explicit type arg — view.evaluate<T = unknown> defaults to
  // unknown, which makes bun:test's expect() pick the wrong overload (it
  // matches the `null`/`undefined` overloads instead of `string`).
  const text = await view.evaluate<string>("document.querySelector('#out').textContent");
  expect(text).toBe("ok");
});
```

`await using` disposes the view at scope exit. One browser subprocess is shared per Bun process — `new Bun.WebView()` opens a cheap tab.

### API surface

| Method | Notes |
|---|---|
| `navigate(url)` | Blocking; resolves when page is loaded. |
| `evaluate<T>(expr)` | **Single expression only.** Always pass `<T>` — defaults to `unknown` and breaks `expect()` overloads. For multi-statement bodies, wrap with `Function(...)()` — see below. |
| `click(selector \| x, y, opts?)` | Auto-waits for the element to be attached, visible, stable, unobscured. `opts`: `button`, `modifiers`, `clickCount` (1–3 — `2` = double-click), and on the selector form `timeout` (default 30000ms). |
| `type(text)`, `press(key, { modifiers })` | Keyboard input to the focused element. |
| `scroll(dx, dy)`, `scrollTo(selector)` | |
| `screenshot({ format, quality, encoding })` | Returns bytes/base64. |
| `resize(w, h)`, `goBack()`, `goForward()`, `reload()` | |
| `cdp(method, params)` | Chrome DevTools Protocol escape hatch (`chrome` backend only). |

Properties: `view.url`, `view.title`, `view.loading`.

**Double-click is native** — `click(selector, { clickCount: 2 })`. Still missing: `waitForSelector`, `waitForNavigation`, `waitForFunction`. Workarounds below.

### `evaluate` takes an expression, not statements

This will raise `SyntaxError: Unexpected token ';'`:

```ts
// ❌ BAD — multi-statement body
await view.evaluate(`
  const el = document.querySelector('#x');
  el.click();
  return el.textContent;
`);
```

Wrap in `Function(...)()` so the body is a valid expression:

```ts
// ✅ GOOD — Function-wrapped body
await view.evaluate(
  `Function("const el = document.querySelector('#x');" +
           "el.click();" +
           "return el.textContent;")()`
);
```

Escape double-quoted attribute selectors with `\\"`:

```ts
await view.evaluate(
  `Function("return document.querySelector('g[data-id=\\"s1\\"]') != null")()`
);
```

### Polling — the missing `waitForFunction`

```ts
async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, ms = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (pred(v)) return v;
    await Bun.sleep(50);
  }
  throw new Error("waitFor timed out");
}

// Usage: wait for an async WebSocket update to land in the DOM
const count = await waitFor(
  () => view.evaluate<number>("document.querySelectorAll('.row').length"),
  (n) => n >= 7,
);
```

### Synthetic events for gaps in the API

Dispatch real DOM events via `evaluate` when there's no helper. (Double-click no longer needs this — use `view.click(selector, { clickCount: 2 })`.) Remaining cases:

**Pointer drag** (for canvas/SVG interactions that respond to `pointerdown`/`move`/`up`):

```ts
await view.evaluate(
  `Function("const el = document.querySelector('#draggable');" +
           "const r = el.getBoundingClientRect();" +
           "const sx = r.left + r.width/2, sy = r.top + r.height/2;" +
           "const mk = (t,x,y) => new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,pointerId:1,pointerType:'mouse',isPrimary:true});" +
           "el.dispatchEvent(mk('pointerdown', sx, sy));" +
           "el.dispatchEvent(mk('pointermove', sx + 120, sy + 80));" +
           "el.dispatchEvent(mk('pointerup',   sx + 120, sy + 80));" +
           "return true;")()
`);
```

**Wheel / zoom:**

```ts
await view.evaluate(
  `Function("document.querySelector('svg').dispatchEvent(" +
           "new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-400,clientX:500,clientY:300}));" +
           "return true;")()`
);
```

### Order-independent tests

When tests share persistent state (a file, database, doc), don't assert on absolute values from a prior test's result — compute deltas relative to what you read before the action:

```ts
const before = JSON.parse(readFileSync(dataFile, "utf8")).shape;
// ... perform drag by (+120, +80) ...
await waitFor(
  () => JSON.parse(readFileSync(dataFile, "utf8")).shape,
  (s) => Math.abs(s.x - before.x - 120) < 1,
);
const after = JSON.parse(readFileSync(dataFile, "utf8")).shape;
expect(after.x - before.x).toBeCloseTo(120, 0);
```

### Running the suite (Bun 1.3.13+)

`bun test` gained flags that matter for these WebView suites:

- `--isolate` — runs each test file in a fresh global (drains microtasks, closes sockets, kills subprocesses between files). Use it when route tests would otherwise leak global/DOM state across files.
- `--parallel[=N]` — spreads files across worker processes. Safe only if each file binds its own `port: 0` server and its own throwaway data path (the factory pattern above already does this); files that share one on-disk fixture will race.
- `--shard=M/N` — splits files across CI runners (path-sorted, deterministic).
- `--changed` — runs only files whose import graph touches your git changes.

### What not to do

- Don't start the dev server in `beforeAll` via a shell command — import the factory and call `startServer({ port: 0 })`.
- Don't hardcode `http://localhost:3000` in tests — use `server.url.href` so port `0` (pick-random-port) works.
- Don't call `view.navigate(url)` once and share a `WebView` across tests that mutate state — make a fresh `await using view = new Bun.WebView(...)` per test.
- Don't rely on `evaluate` returning complex objects through tight equality — JSON-serialisable shapes only; functions/Nodes don't cross the boundary.

## tsconfig.json

`bun init` creates a tsconfig. Replace `compilerOptions` with the complete block for the detected mode — copy-paste, don't merge two snippets.

**ts mode** (no JSX):

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun-types"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext",
    "strict": true
  }
}
```

**tsx-railroad mode**:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun-types"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext",
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@blueshed/railroad"
  }
}
```

**tsx-react mode**:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["bun-types"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "esnext",
    "strict": true,
    "jsx": "react-jsx",
    "jsxImportSource": "react"
  }
}
```
