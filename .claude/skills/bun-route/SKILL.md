---
name: bun-route
metadata:
  version: 0.15.1
description: "Scaffold a new page or route in a Bun fullstack app: an HTML entry, bundled CSS, a TypeScript, JavaScript or TSX client script, registered on the server. Also writes Bun.WebView browser tests for a route's interaction. Use when the user wants to add a page or route, or to test one in a real browser."
argument-hint: "[route-path] [description]"
---

# Bun Route Scaffolding

Create a route for a Bun fullstack app that uses HTML imports.

Read `${CLAUDE_SKILL_DIR}/reference.md` for the full API patterns and file templates before scaffolding.

## Step 1: Detect the environment

Before creating files, determine the project type from:

1. **Existing HTML files.** Check the `<script src="...">` extensions: `.js`, `.ts` or `.tsx`.
2. **tsconfig.json.** Does it exist, and does it set `jsxImportSource`?
3. **package.json.** Are `@blueshed/railroad`, `react` or neither in the dependencies?
4. **Existing route files.** Match the patterns already in use.

That determines the **mode**:

| Signal | Mode | Script ext | JSX framework |
|--------|------|-----------|---------------|
| No tsconfig, no JSX deps | **js** | `.js` | None: plain DOM |
| tsconfig exists, no JSX deps | **ts** | `.ts` | None: plain DOM |
| `@blueshed/railroad` in deps | **tsx-railroad** | `.tsx` | `@blueshed/railroad` |
| `react` in deps | **tsx-react** | `.tsx` | `react` |

If nothing settles the mode, ask the user.

### Bootstrap (empty project)

If there is no `package.json` and no server entry file, bootstrap first:

1. Run `bun init -y` to create `package.json` and `tsconfig.json`.
2. Delete the generated `index.ts`. The route files replace it.
3. Install only what the mode needs:
   - **js**: nothing extra.
   - **ts**: `bun add -d bun-types`.
   - **tsx-railroad**: `bun add @blueshed/railroad && bun add -d bun-types`.
   - **tsx-react**: `bun add react react-dom && bun add -d bun-types @types/react @types/react-dom`.
4. For **ts** or **tsx** modes, replace `compilerOptions` in the tsconfig with the complete block for the mode from reference.md. Don't merge two snippets.
5. Create the server entry (`server.js` or `server.ts`) with `Bun.serve({ routes, development: { hmr: true, console: true } })`. Always enable `development.hmr` and `development.console`. They are stripped automatically in production. See reference.md for the template.
6. Create the route files as in Step 3.

## Step 2: Parse arguments

`$ARGUMENTS` should contain a route path (for example `/about`) and optionally a description. If there are no arguments, ask the user.

## Step 3: Create the route files

For a non-root route, create a directory named after the route:
- `<name>.html`: the entry point, referencing the CSS and script by relative paths.
- `<name>.css`: all the styles for this route. It is self-contained.
- `<name>.<ext>`: the client script. The extension comes from the mode.

**Root route** (`/`, `index`, `home`): put the files in the project root as `index.html`, `index.css` and `index.<ext>`. Don't create an `index/` directory.

Each route's CSS is self-contained, with resets, layout and typography in the file itself. Don't create a shared `base.css`. Match the style of the existing route CSS files.

## Step 4: Register the route

Find the server entry: the file that calls `Bun.serve()`, usually `server.ts` or `server.js`.
- Add an import: `import <name>Page from "./<path>/<name>.html";`
- Add to the `routes` object: `"/<route>": <name>Page,`

If the file still uses `import { serve } from "bun"`, leave it. Both forms work. New scaffolds use `Bun.serve` directly.

## Step 5: Verify

Ask the user to start or restart the server if it is not running. Then:

1. Read the server entry for the port. The default is 3000.
2. Run `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/<route>` and confirm it returns `200`.
3. If a Playwright MCP browser is available, open the page and take a screenshot to check that it renders. If that Playwright MCP runs in Docker, `localhost` inside the container is the container itself, so use `http://host.docker.internal:<port>/<route>` in its place. Use `localhost` only when the browser runs on the host.
4. Check that the new CSS matches the existing route CSS: layout, typography and interactive elements.

## Step 6: Tests (when the route has interaction worth locking down)

`Bun.WebView` is a real headless browser that `bun test` can drive directly. Write a test when the route has non-trivial behaviour: forms, drag, WebSockets or client state.

Minimum versions:
- **1.3.12**: the `Bun.WebView` global and the basic methods.
- **1.3.13**: the test-runner flags `--isolate`, `--parallel`, `--shard` and `--changed`.
- **1.3.14**: the WebView options `clickCount`, the per-call `timeout`, and the constructor's `console` and `dataStore`.

Check `bun --version` before relying on a 1.3.14 option, and tell the user if the project's Bun is older.

The server must be **importable**. Refactor its entry into an exported `startServer(opts)` factory so tests can bind to `port: 0` and inject throwaway paths. Then use `await using view = new Bun.WebView(...)` and drive it with `navigate`, `click` and `evaluate`.

Three footguns:
- `view.evaluate` takes one **expression**, not statement bodies. For multi-statement code, wrap it in `Function("…; return …;")()`.
- `view.evaluate<T = unknown>` defaults to `unknown`, which makes `expect()` pick the wrong overload. Always pass a type argument: `evaluate<string>(...)`, `evaluate<number>(...)`, `evaluate<boolean>(...)`.
- There is no `waitForSelector` or `waitForFunction`. Selector methods auto-wait until the element is attached, visible, stable and not obscured, with a per-call `timeout` (default 30000 ms). They do **not** wait for it to be enabled: wait for a disabled button to enable before clicking it. For anything else, such as an async WebSocket update landing in the DOM or a file write, poll with a small `waitFor` helper.

The full patterns, the `Function(...)()` idiom, synthetic events for pointer-drag and wheel, and the order-independent test structure are in reference.md under **Testing routes with `Bun.WebView`**.
