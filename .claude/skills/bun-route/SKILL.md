---
name: bun-route
version: 0.11.0
description: Scaffold a new Bun HTML route with bundled CSS and TypeScript/JavaScript. Use when the user wants to add a page/route to a Bun fullstack app.
argument-hint: [route-path] [description]
---

# Bun Route Scaffolding

Create a new route for a Bun fullstack app using HTML imports.

Read `${CLAUDE_SKILL_DIR}/reference.md` for the full API patterns and file templates before scaffolding.

## Step 1 — Detect the environment

Before creating files, determine what kind of project this is by checking:

1. **Existing HTML files** — look at `<script src="...">` tags. What extension do they use? `.js`, `.ts`, `.tsx`?
2. **tsconfig.json** — does it exist? Does it have `jsxImportSource`?
3. **package.json** — check dependencies for `@blueshed/railroad`, `react`, or nothing (plain JS).
4. **Existing route files** — match the patterns already in use.

This determines the **mode**:

| Signal | Mode | Script ext | JSX framework |
|--------|------|-----------|---------------|
| No tsconfig, no JSX deps | **js** | `.js` | None — plain DOM |
| tsconfig exists, no JSX deps | **ts** | `.ts` | None — plain DOM |
| `@blueshed/railroad` in deps | **tsx-railroad** | `.tsx` | `@blueshed/railroad` |
| `react` in deps | **tsx-react** | `.tsx` | `react` |

If nothing gives away the mode, **ask the user**.

### Bootstrap (empty project)

If no `package.json` or server entry file exists, bootstrap the project first:

1. Run `bun init -y` to create `package.json` and `tsconfig.json`
2. Remove the generated `index.ts` — the route files replace it
3. Install dependencies **only as needed by the detected mode**:
   - **js** — no extra dependencies
   - **ts** — `bun add -d bun-types`
   - **tsx-railroad** — `bun add @blueshed/railroad && bun add -d bun-types`
   - **tsx-react** — `bun add react react-dom && bun add -d bun-types @types/react @types/react-dom`
4. For **ts** or **tsx** modes, replace `compilerOptions` in tsconfig with the complete block for the mode — see reference.md (do not partial-merge two snippets).
5. Create the server entry file (`server.js` or `server.ts` depending on mode) using `Bun.serve({ routes, development: { hmr: true, console: true } })`. Always enable `development.hmr` and `development.console` — they're free wins, stripped automatically in production, and the headline reason to use Bun's fullstack server. See reference.md for the full template.
6. Then proceed to create the route files as normal.

## Step 2 — Parse arguments

`$ARGUMENTS` should contain a route path (e.g., `/about`) and optionally a description. If no arguments, ask the user.

## Step 3 — Create the route files

For non-root routes, create in a directory matching the route name:
- `<name>.html` — the HTML entry point, referencing the CSS and script with relative paths
- `<name>.css` — all styles for this route (resets, layout, route-specific)
- `<name>.<ext>` — client-side script (extension determined by mode)

**Root route (`/`, `index`, `home`)**: place files in the project root as `index.html`, `index.css`, `index.<ext>` — do not create an `index/` subdirectory.

Match the style of existing route CSS files in the project. Each route's CSS is self-contained — no separate `base.css`.

## Step 4 — Register the route

Find the server entry file — look for `server.ts`, `server.js`, or whichever file calls `Bun.serve()`:
- Add an import: `import <name>Page from "./<path>/<name>.html";`
- Add to the `routes` object: `"/<route>": <name>Page,`

If the file still uses `import { serve } from "bun"`, leave it; both work. New scaffolds should use `Bun.serve` directly.

## Step 5 — Verify

Ask the user to start (or restart) the server if it's not already running. Then:

1. Check the server entry file for the port (default is 3000)
2. Use `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/<route>` to confirm the route returns 200
3. If Playwright MCP is available, take a screenshot to visually confirm the page renders correctly (use `http://host.docker.internal:<port>` from Docker)
4. Confirm CSS is consistent with existing pages (shared base applied, layout centred, interactive elements styled)

## Step 6 — Tests (when the route has interaction worth locking down)

Bun 1.3.12+ ships `Bun.WebView` — a real headless browser usable directly from `bun test`. If the route has non-trivial behaviour (forms, drag, WebSockets, client state), write a `bun test` against it. This skill's testing patterns assume **Bun 1.3.14+**, which is where the WebView options used below (`clickCount`, per-click `timeout`, constructor `console`/`dataStore`) and the `bun test` parallelism flags settled; on 1.3.12–1.3.13 the WebView exists but those options may be missing.

The testing flow requires the server to be **importable** — refactor its entry into an exported `startServer(opts)` factory so tests can bind to `port: 0` and inject throwaway paths. Then `await using view = new Bun.WebView(...)` and drive it with `navigate`, `click`, `evaluate`.

Three footguns worth knowing before you start:
- `view.evaluate` takes a single **expression**, not statement bodies. For multi-statement code, wrap with `Function("…; return …;")()`.
- `view.evaluate<T = unknown>` defaults to `unknown`, which makes bun:test's `expect()` pick the wrong overload. Always pass an explicit type arg: `view.evaluate<string>(...)`, `evaluate<number>(...)`, `evaluate<boolean>(...)`.
- There is no `waitForSelector` / `waitForFunction` — selector methods auto-wait on actionability (with a per-call `timeout`, default 30000ms), but for anything else (async WS updates landing in the DOM, file-system persistence) write a small `waitFor(fn, pred, ms)` poll helper.

Double-click is now native — `view.click(selector, { clickCount: 2 })` (1–3) — so the old synthetic-`dblclick` recipe is no longer needed. Pointer-drag and wheel still have no helper and need dispatched events.

Full patterns, the `Function(...)()` wrapping idiom, synthetic-event recipes for the remaining gaps (pointer-drag, wheel), and order-independent test structure are in `reference.md` → **Testing routes with `Bun.WebView`**.
