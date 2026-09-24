# Railroad — Reference

The manual. `SKILL.md` is the checklist of what bites; this file is the full
tour of the API and the reasons behind it. The JSDoc header at the top of each
source file (`signals.ts`, `jsx.ts`, `routes.ts`, `shared.ts`, `logger.ts`) is
the authoritative contract — when this file and a header disagree, the header
wins.

## Why Bun + railroad

Bun 1.3 ships the parts that frontend stacks normally need three packages and a
config file to assemble:

- **HTML imports in `Bun.serve`** ([1.2+](https://bun.com/blog/bun-v1.2)) — the server reads `import index from "./index.html"`, walks `<script>` and `<link>` tags, transpiles TSX/JSX, bundles imports, processes CSS, hashes asset URLs. No `vite.config.ts`. No build step in development.
- **First-class JSX/TSX** — `jsxImportSource: "@blueshed/railroad"` in `tsconfig.json` is the entire setup. Bun's transpiler and bundler both honour it; railroad ships matching `jsx-runtime` and `jsx-dev-runtime` modules so dev mode (`jsxDEV`) works too.
- **HMR** ([1.3+](https://bun.com/blog/bun-v1.3)) — `Bun.serve({ development: { hmr: true } })` gives you `import.meta.hot` modelled on Vite's, including console mirroring (`development: { console: true }`).
- **`bun build --compile`** ([1.3+](https://bun.com/blog/bun-v1.3)) — compile the entire HTML+TSX+server graph into a single static binary you can scp to a server. No Node, no install, no Docker layer.
- **`Bun.WebView`** ([1.3.12+](https://bun.com/blog/bun-v1.3.12)) — real headless browser tests in the same `bun test` you already run for unit tests. WKWebView on macOS, Chrome via CDP elsewhere. Railroad uses it.

Railroad fills exactly the slot Bun leaves open: a small, push-based reactive
layer that binds signals to real DOM. No virtual DOM, no compiler, no SSR layer
Bun doesn't have anyway. You get reactivity, JSX, and a router; you keep Bun's
pipeline.

## Setup

```sh
bun add @blueshed/railroad
```

Starting fresh? `bun create blueshed my-app` scaffolds a full app — railroad +
`@blueshed/delta` + invoket, agent wiring included. For adding pages to an
existing app, use the `bun-route` skill.

**Bun / bundler only.** Railroad ships TypeScript source with no build step and
uses extensionless imports, so your toolchain must transpile TS and resolve
with `moduleResolution: "bundler"` (or `"bun"`). It does **not** resolve under
Node's `node16`/`nodenext`.

A working app, end to end, with a router -- a fuller version of the README's thirty-second
example:

```json
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@blueshed/railroad",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "module": "esnext",
    "target": "esnext",
    "moduleResolution": "bundler",
    "strict": true
  }
}
```

```html
<!-- index.html -->
<!DOCTYPE html>
<html>
  <body>
    <div id="root"></div>
    <script type="module" src="./app.tsx"></script>
  </body>
</html>
```

```tsx
// app.tsx
import { signal, routes } from "@blueshed/railroad";

const count = signal(0);

function Home() {
  return (
    <div>
      <h1>Hello World</h1>
      <button onclick={() => count.update(n => n + 1)}>
        Count: {count}
      </button>
    </div>
  );
}

routes(document.getElementById("root")!, {
  "/": () => <Home />,
});
```

```ts
// server.ts
import home from "./index.html";

Bun.serve({
  routes: { "/": home },
  development: { hmr: true, console: true },
});
```

```sh
bun server.ts                          # dev with HMR
bun build ./index.html --production --outdir=dist   # production assets
bun build --compile server.ts          # one-binary deploy
```

No Vite, no webpack, no Rollup config, no `tsx-loader`, no
`@vitejs/plugin-react`. HMR works, TSX compiles, sourcemaps are emitted, CSS
bundles, and asset URLs are content-hashed out of the box.

## Signals

```ts
import { signal, computed, effect, batch, untrack } from "@blueshed/railroad";

const count = signal(0);
const doubled = computed(() => count.get() * 2);     // ReadonlySignal — no .set
const label = count.map(n => `Count: ${n}`);         // also ReadonlySignal

effect(() => console.log(count.get()));              // runs on count change

count.set(1);
count.update(n => n + 1);
count.peek();                                         // read without tracking
untrack(() => count.get());                           // same, function form

// In-place mutation helpers — the realtime story
const todos = signal([{ id: 1, text: "Buy milk" }]);
todos.mutate(arr => arr.push({ id: 2, text: "Walk dog" }));   // structuredClone + notify
todos.touch();                                                 // notify without replacing the ref

// .patch() shallow-merges OBJECT signals (throws on arrays — use
// .set()/.update()/.mutate() for array signals)
const filter = signal({ color: "all", done: false });
filter.patch({ color: "blue" });                              // { color: "blue", done: false }

// Custom equality — suppress notifications when contents match
const coords = signal({ x: 1, y: 2 }, {
  equals: (a, b) => a.x === b.x && a.y === b.y,
});

batch(() => { count.set(10); count.set(20); });      // effect runs once
```

`effect(fn)` returns its disposer; `fn` may return a cleanup function, called
once, before the next run or on dispose. Any other return value is ignored at
run time (tsc still rejects an expression body that returns a value; use a
block). `fn` must be synchronous: `effect(async () => …)` logs an error, because its
Promise is not a cleanup and nothing after its first `await` is tracked.

Writes made inside an effect body reach other listeners **after the body
returns**, on its first run as on every later one. An effect that writes `a`
and then reads a computed of `a` sees the old value and re-runs once the
write settles; an effect that writes its own dependency (a clamp, a default)
runs again after its current run, never inside it.

**Each effect/computed run owns what it creates** (0.12+). Anything its body
creates — computeds (including `.map()`), nested effects, `when()`/`list()`,
components, anything registered with `trackDispose()` — is disposed before the
next run and when the effect is disposed. Re-running an effect therefore
never piles up copies of what it built. The flip side: something meant to
outlive one run (a cached `.map()`, a `@blueshed/delta` `openDoc()`) must be
created outside the effect body.

```ts
// ❌ Released on the next run of the effect — the cache goes dead
let label: ReadonlySignal<string> | undefined;
effect(() => { user.get(); label ??= name.map(n => n.toUpperCase()); });

// ✅ Long-lived derivation lives beside the effect, not in it
const label = name.map(n => n.toUpperCase());
effect(() => { user.get(); console.log(label.get()); });
```

## JSX

Components run **once** and return real DOM nodes. Reactivity is in the
signals, not in re-rendering.

```tsx
const name = signal("World");
function Greeting() {
  return <h1>Hello {name}</h1>;       // bare signal as child — auto-reactive
}

// App root without a router: mount() brackets a dispose scope and
// returns the disposer. (Routed apps get the same from routes().)
const dispose = mount(document.getElementById("root")!, () => <Greeting />);

<span>{() => count.get() > 5 ? "High" : "Low"}</span>      // function child auto-tracks
<input value={name} />                                      // signal as prop
<div class={visible.map(v => v ? "show" : "hide")} />       // .map() for derived attrs
<div class={() => visible.get() ? "show" : "hide"} />       // function prop auto-tracks too
<div style={() => ({ width: `${w.get()}px` })} />           // style: CSS string or object
```

A child that is a signal or a function renders its value as text, and
`null`, `undefined`, `true` and `false` as nothing, exactly as a static child
does. A component body runs once and **untracked**: a `.get()` in it (or in a
`when()` branch, a `list()` row, a route handler) is a one-shot read that
subscribes nothing, not even the effect that happens to be building it.

### Props

Props follow the same rule as children: a Signal or a function is reactive,
anything else is applied once. The exceptions are `ref` (called once with the
element) and `on*` (attached as a listener; must be a function).

| Prop | Static value | Reactive value (Signal or function) |
|---|---|---|
| `class` / `className` | set; `null`/`undefined`/`false` → no attribute | same, re-applied on change |
| `style` | CSS string (`"color: red"`) or object (`{ color: "red", "--accent": "blue" }`: camelCase keys and custom properties); `null`/`false`/`""` → no attribute | same; may switch between string and object; an object clears keys the next object omits |
| `value` `checked` `disabled` `selected` `src` `srcdoc` | set as DOM property; `null`/`undefined` → `""`; a `<select>`'s `value` selects its option | same |
| `innerHTML` | set; `null`/`undefined` → `""`; replaces any JSX children | same |
| `htmlFor` | the `for` attribute | same |
| anything else | `setAttribute(String(v))`; `false`/`null`/`undefined` → removed | same |
| `ref` | called once with the element, after its children are appended | — |
| `on*` | `addEventListener` (lowercased; the DOM's events, so `onchange` on a text input fires on commit, `oninput` per keystroke); non-function warns, attaches nothing | not reactive |

Props are applied after the element's children, which is what lets a
`<select value>` find its `<option>`s.

### `when(condition, truthy, falsy?)`

```tsx
{when(loggedIn, () => <Dashboard />, () => <Login />)}
```

`condition` is a signal or a function (wrapped in a computed). The branch is
rebuilt only when truthiness flips (falsy ↔ truthy); a value change inside the
same branch (`"a"` → `"b"`) does not re-render, so a value read with `.get()`
in the branch stays the first one. Pass a signal into the branch instead:
`when(user, () => <Profile name={user.map(u => u?.name ?? "")} />)`. The branch renders **synchronously** (0.12+): it is in
the returned fragment, and so in the DOM as soon as `mount()` / the parent
append returns. The branch lives between `<!--when-->` and `<!--/when-->`
comments, and each branch gets its own dispose scope.

### `list(items, keyFn?, render, options?)` — keyed reactive list

```tsx
{list(todos, t => t.id, (todo$, idx$) => (
  <li class={idx$.map(i => i % 2 ? "odd" : "even")}>
    {todo$.map(t => t.text)}
  </li>
))}
```

The keyed form passes each row a `ReadonlySignal<T>` and a `ReadonlySignal<number>` index;
rows are moved, not rebuilt, and each row lives between bracket comments. A
reorder moves only the rows outside the longest run already in order, so a
row that didn't move keeps its focus, selection and scroll position.
The index form (`list(items, (item, i) => …)`) passes raw values and rebuilds
every row on every change — fine for static lists. Rows render
**synchronously** (0.12+), like `when()`.

`options` (keyed form only) forwards `SignalOptions` to each row's item
signal. The default `Object.is` is right when a changed row is a new object;
pass `{ equals: () => false }` when a patch stream mutates row objects **in
place** and notifies via `.touch()` — see Realtime below.

### SVG

SVG works transparently — SVG tags (`circle`, `g`, `linearGradient`,
`clipPath`, filter primitives, …) are created in the SVG namespace outright,
including inside `when()` and `list()`, with camelCase preserved.
`<foreignObject>` children stay HTML.

## Routes

Hash-based client router. Handlers receive `(params, params$)` — the second is
a reactive `ReadonlySignal` that updates when params change within the same
pattern (`/users/1` → `/users/2` does not re-render). The handler runs once per
pattern, so `params` is the first match: `({ id }) => <h1>{id}</h1>` still
shows `1` at `/users/2`. Read anything that changes through `params$`.

```tsx
import { routes, navigate, route, when } from "@blueshed/railroad";

routes(app, {
  "/":          () => <Home />,
  "/users/:id": (_p, params$) => <User id={params$.map(p => p.id)} />,
  "/sites/*":   () => <SitesLayout />,    // wildcard keeps layout mounted
});

function SitesLayout() {
  const detail = route<{ id: string }>("/sites/:id");
  return (
    <div>
      <SitesNav />
      {when(detail, () => <SiteDetail />, () => <SitesList />)}
    </div>
  );
}

navigate("/users/42");
```

`/sites` → `/sites/42` → `/sites/99`: `SitesLayout` stays mounted, only the
inner content swaps. Navigate away from `/sites/*` and the layout tears down
cleanly. `routes()` returns its disposer and takes an optional third argument,
`{ onError }` — see SKILL.md › Error Boundaries. `matchRoute(pattern, path)` is
the pure matcher, exported for tests and server use.

## Realtime — the reason this library exists

Two patterns, depending on whether the patch stream is something you control
or something you delegate to `@blueshed/delta`.

### Hand-rolled patch streams — `.touch()` + `.mutate()`

For a signal holding a large document mutated in place by patches (CRDT
updates, custom WebSocket protocols, SQL `LISTEN/NOTIFY` payloads),
`Signal.touch()` and `.mutate()` skip the `structuredClone` cost of `.set()` on
a fresh object:

```tsx
import { signal, list } from "@blueshed/railroad";

type Row = { id: number; text: string; done: boolean };
const rows = signal<Row[]>([]);

const ws = new WebSocket("/ws");
ws.onmessage = (ev) => {
  applyPatch(rows.peek(), JSON.parse(ev.data));   // mutate the existing array
  rows.touch();                                    // notify without cloning
};

function App() {
  return (
    <ul>
      {list(rows, r => r.id, (row$) => (
        <li>
          <input type="checkbox" checked={row$.map(r => r.done)} />
          {row$.map(r => r.text)}
        </li>
      ), { equals: () => false })}
    </ul>
  );
}
```

The `{ equals: () => false }` matters: `list()` pushes each sync into the
row's item signal, and an in-place patch re-delivers the **same row
reference** — which the default `Object.is` swallows, leaving that row's DOM
stale. Forcing the notify makes every row re-project; the row's own `.map()`
computeds still bail on unchanged values, so actual DOM writes stay minimal.
Streams that replace whole row objects can keep the default; `@blueshed/delta`
is one, since every backend broadcasts a changed row as a whole-row replace.

### Delta-doc — turnkey JSON-Patch sync, signal-backed

(Open a doc in the component or at module level, not inside an `effect()` body: from 0.12 each effect run owns what it creates, so a doc opened there is closed when the effect re-runs.)

For a turnkey WebSocket sync layer use [`@blueshed/delta`](https://www.npmjs.com/package/@blueshed/delta). Delta declares railroad as a peer dependency and `delta/client.ts` imports `signal` directly — `openDoc("name")` returns a `Doc<T>` whose `data` field **is** a railroad `Signal<T | null>`, not a wrapper. It drops straight into JSX, `when()`, and `list()` with no glue. Backends: JSON file, SQLite, Postgres (RLS + LISTEN/NOTIFY), and documents held in memory, fixed for a release, or read from outside -- see delta's own README.

```tsx
// Server — same Bun.serve hosting your JSX routes
import home from "./index.html";
import { createWs, registerDoc } from "@blueshed/delta/server";

const ws = createWs();
await registerDoc(ws, "board:1", {
  file: "./board.json",
  empty: { columns: {}, cards: {} },
});

Bun.serve({
  routes: { "/": home, [ws.path]: ws.upgrade },
  websocket: ws.websocket,
  development: { hmr: true, console: true },
});
```

```tsx
// Client — list() reads doc.data directly, preserving per-row identity
import { provide, list, when } from "@blueshed/railroad";
import { connectWs, WS, openDoc } from "@blueshed/delta/client";

provide(WS, connectWs("/ws"));

interface Card { id: number; title: string; column_id: number }
interface BoardDoc { columns: Record<string, Column>; cards: Record<string, Card> }

const doc = openDoc<BoardDoc>("board:1");

function Board() {
  const cards = doc.data.map((d) => d ? Object.values(d.cards) : []);
  return when(doc.data, () => (
    <ul>
      {list(cards, c => c.id, (card$) => (
        <li>{card$.map(c => c.title)}</li>
      ))}
    </ul>
  ), () => <p>loading…</p>);
}

await doc.send([{ op: "add", path: "/cards/-",
  value: { column_id: 1, title: "new card", position: 0 } }]);
```

**One important steering note:** delta also ships `applyOpsToCollection` (in `@blueshed/delta/dom-ops`) for projects without a keyed reactive list primitive. **If you have railroad, use `list()` instead** — the keyed form already does the per-row surgical update that `applyOpsToCollection` exists to provide. They overlap; pick one per project. Use `list(doc.data.map(d => Object.values(d.coll)), r => r.id, ...)` and keep the realtime story in one idiom.

## Testing — `bun test` does both halves

Unit tests run against happy-dom (preloaded via `bunfig.toml`) for fast
reactivity assertions. Integration tests use **`Bun.WebView`** (1.3.12+) to
drive a real headless browser against your actual `Bun.serve` instance:

```ts
import { test, expect } from "bun:test";
import { startServer } from "./server";

test("counter increments", async () => {
  const { server } = await startServer({ port: 0 });
  await using view = new Bun.WebView({ width: 800, height: 600 });
  await view.navigate(server.url.href);
  await view.click("[data-testid=inc]");
  expect(await view.evaluate<string>("document.querySelector('#count').textContent")).toBe("1");
  server.stop(true);
});
```

Same `bun test` runner. No Playwright install. No browser binary download on
macOS (uses system WKWebView). Run the browser layer by explicit path (railroad
itself uses `bun run test:webview`) — bare `bun test` can drop files under
`tests/` from discovery. The `bun-route` skill's reference has the full
WebView patterns.

After `navigate(...)` in a test, `hashchange` lands on the next macrotask:
`await new Promise(r => setTimeout(r, 0))`.

## Shared (DI) and logger

```ts
import { key, provide, inject, tryInject } from "@blueshed/railroad";
const STORE = key<AppStore>("store");
provide(STORE, createStore());
const store = inject(STORE);          // throws if nothing was provided
const maybe = tryInject(STORE);       // undefined instead

import { createLogger, setLogLevel } from "@blueshed/railroad";
const log = createLogger("[server]");
log.info("listening");                // gated by LOG_LEVEL in .env
```

`loggedRequest(tag, handler)` wraps a `Bun.serve` route handler with access
logging (method, path, status, time; a throw is logged and re-thrown).
`LOG_LEVEL` is one of `silent` `error` `warn` `info` `debug`.

## Progressive adoption

Each module is independent — pick the level you need:

```
signals     no deps        Use anywhere: server, CLI, worker, tests
shared      no deps        Typed DI without prop threading
logger      no deps        Bun-friendly leveled console output
jsx         signals        Reactive real-DOM rendering
routes      signals, jsx   Hash router with reactive params (jsx for SVG adoption only; loads without a DOM)
```

```ts
// Just signals (no JSX, no tsconfig changes)
import { signal, computed, effect } from "@blueshed/railroad/signals";
```

## What it isn't

- Not a TC39 Signals implementation. It's push-based, in the same family as Vue's `ref`, Solid's `createSignal`, Preact's signals.
- Not an SSR / RSC framework. Bun doesn't ship those either; railroad doesn't add them on top.
- Not a 30KB framework with a hooks system, lifecycle methods, or a virtual DOM.

## Sharp edges

- **Propagation is topologically ordered** (0.10+). One write — or one `batch()` of writes — runs each affected computed/effect at most once per settled pass, upstream before downstream, so a diamond (`a → b`, `a → c`, an effect reads both) never observes half-updated state. That holds while each computed reads the same signals every time. A computed that switches what it reads (`flag.get() ? b.get() : a.get() * 2`) can end up deeper than the effects reading it were ordered for; on a later write such an effect can run once on half-updated values and then again on the settled ones. Every write settles consistently, and within the same synchronous pass, so JSX bindings (text, attributes) never paint the half-updated value; only an effect with a side effect per run (a log, a request) sees the extra run. Siblings at the same depth run in subscription order; an effect that *writes* signals re-queues their consumers in the same pass (a true cycle throws).
- **Effects own what they create** (0.12+). Anything an `effect()` or `computed()` body creates — computeds, nested effects, `when()`/`list()`, components, `trackDispose()` registrations such as delta's `openDoc()` — is disposed before the next run and when the effect is disposed. Keep long-lived state outside the effect body.
- **`when()`/`list()` need a dispose scope.** Created outside a component, `routes()` handler, or `mount()`, their internal effects are unreachable — railroad warns on the console. Mount roots via `mount()` or `routes()`.
- **Routes match in declaration order.** The first pattern that matches wins — declare `/users/new` before `/users/:id`.
- **Route matching is segment-based only.** No query-string handling (`#/users/42?tab=1` matches `/users/:id` with `id === "42?tab=1"`), and a trailing slash is a real empty segment (`/users/42/` does not match `/users/:id`).
- **SVG tags get their namespace at creation** (0.10+) — refs fire once and manual listeners survive. Only the four HTML/SVG-ambiguous tags (`a`, `script`, `style`, `title`) still go through adoption when appended inside `<svg>`: on that path a `ref` fires twice (use the last call) and hand-attached listeners don't carry over — use `on*` props. Adoption happens when a node is placed through JSX, `mount()`, `routes()`, or a `when()`/`list()` parent; a `when()`/`list()` fragment appended *by hand* into an `<svg>` (`svg.appendChild(when(…))`) does not adopt those four tags in its first render -- place it through one of those instead.
- **One copy of railroad per page.** Signals, scopes and providers don't cross copies, so with two (a `file:`-linked checkout that brings its own `node_modules/@blueshed/railroad`) the UI stops updating. The second copy logs `A second copy of @blueshed/railroad has loaded (…)`; SKILL.md › Local development across repos has the fix.
- **An event handler is not a dispose scope.** A `computed()`, `.map()` or `effect()` created in `onclick` lives until you dispose it; derive in the component body.
- **`provide`/`inject` is a process-global singleton.** Great for client apps and app-wide services; on the server it is shared across all requests, so don't use it for per-request state.
- **`.mutate()` uses `structuredClone`** — it only works on plain-data signals (no functions, class instances, or DOM nodes in the value).
- **In-place row mutation + `.touch()` needs `list()`'s `equals` option.** A keyed `list()` pushes updates into each row's item signal; a patch stream that mutates row objects in place re-delivers the same reference, which the default `Object.is` swallows — the row's DOM goes silently stale. Pass `{ equals: () => false }` as the fourth argument for such streams. (`@blueshed/delta` broadcasts whole rows, so its docs don't need it.) Same-reference projections have the same trap: `doc.map(d => d.settings)` returns the same ref after a `.touch()`, so the computed bails — project to fresh values (`Object.values(...)`, primitives) or pass `{ equals: () => false }` to `.map()`.
- **Async components resolve to a thunk.** `async function Profile() { const u = await fetchUser(); return () => <div>{u.name}</div>; }` renders a placeholder (plus an optional `fallback={() => <p>loading…</p>}` prop) and fills in on resolution. The `() =>` on the return line is the whole contract: effects created after an `await` have no owner scope (browser JS has no AsyncContext), so the thunk gives railroad a synchronous moment to bracket them — teardown then works no matter when the promise settles. A bare-Node resolution gets a pointed console.error naming the fix. The same contract applies to async `routes()` handlers (`Promise<() => Node>`); a bare `Promise<Node>` still renders, but its post-await bindings outlive the route.
- **The index-based `list()` form rebuilds every row on every change.** It disposes and re-renders each row per sync; that's its contract. Use the keyed form (`list(items, keyFn, render)`) for anything that updates — rows then patch in place through their item signals.
