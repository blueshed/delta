# Railroad — Reference

The manual. `SKILL.md` is the checklist of what bites; this file is the full API
and the reasons behind it. Each source file's JSDoc header is the contract. When
this file and a header disagree, the header wins.

## Contents

- [Why Bun + railroad](#why-bun--railroad)
- [Setup](#setup): install, a complete app, JSX types
- [Signals](#signals): `signal`, `computed`, `effect`, `batch`, in-place mutation
- [JSX](#jsx): components, props, `when()`, `list()`, SVG
- [Routes](#routes): the router, wildcard layouts, error boundaries
- [Realtime](#realtime): hand-rolled patch streams, `@blueshed/delta`
- [Testing](#testing): unit tests and `Bun.WebView`
- [Shared (DI) and logger](#shared-di-and-logger)
- [Progressive adoption](#progressive-adoption)
- [What it isn't](#what-it-isnt)
- [The nine mistakes, in full](#the-nine-mistakes-in-full): the reasons behind `SKILL.md`'s checklist
- [Sharp edges](#sharp-edges)
- [Local development across repos](#local-development-across-repos): one copy of railroad per page

## Why Bun + railroad

Bun 1.3 ships what a frontend stack otherwise assembles from three packages and a
config file:

- **HTML imports in `Bun.serve`** ([1.2+](https://bun.com/blog/bun-v1.2)). The server reads `import index from "./index.html"`, bundles the scripts and styles it references, transpiles TSX, and content-hashes asset URLs. No `vite.config.ts`.
- **HMR and console mirroring** ([1.3+](https://bun.com/blog/bun-v1.3)). `development: { hmr: true, console: true }`.
- **`bun build --compile`** ([1.3+](https://bun.com/blog/bun-v1.3)). The whole HTML, TSX and server graph becomes one binary.
- **`Bun.WebView`** ([1.3.12+](https://bun.com/blog/bun-v1.3.12)). A real headless browser in `bun test`.

Railroad fills the remaining slot: a small, push-based reactive layer that binds
signals to real DOM. There is no virtual DOM, no compiler and no SSR.

## Setup

```sh
bun add @blueshed/railroad
```

`bun create blueshed my-app` scaffolds a full app: railroad, `@blueshed/delta`
and invoket, with agent wiring. For adding pages to an existing app, use the
`bun-route` skill.

**Bun or another bundler only.** Railroad ships TypeScript source with no build
step and extensionless imports. Your toolchain must transpile TS and resolve with
`moduleResolution: "bundler"` (or `"bun"`). It does not resolve under Node's
`node16` or `nodenext`.

A complete app, with a router:

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
bun server.ts                                        # dev with HMR
bun build ./index.html --production --outdir=dist    # production assets
bun build --compile server.ts                        # one-binary deploy
```

**JSX types.** Railroad declares no global `JSX` namespace, so it sits beside
React's types in one app. The automatic runtime (`jsx: react-jsx` with
`jsxImportSource`) finds its types in `@blueshed/railroad/jsx-runtime`. The
classic runtime (`"jsx": "react"`, `"jsxFactory": "createElement"`,
`"jsxFragmentFactory": "Fragment"`, importing `createElement` in each file) finds
them on the factory,
`createElement.JSX`. To annotate, import the type: `import type { JSX } from "@blueshed/railroad"`.
`JSX.Element` is a DOM `Node`.

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

// In-place mutation helpers, for large documents
const todos = signal([{ id: 1, text: "Buy milk" }]);
todos.mutate(arr => arr.push({ id: 2, text: "Walk dog" }));   // structuredClone + notify
todos.touch();                                                 // notify without replacing the ref

// .patch() shallow-merges object signals; it throws on arrays
const filter = signal({ color: "all", done: false });
filter.patch({ color: "blue" });                              // { color: "blue", done: false }

// Custom equality: suppress notifications when contents match
const coords = signal({ x: 1, y: 2 }, {
  equals: (a, b) => a.x === b.x && a.y === b.y,
});

batch(() => { count.set(10); count.set(20); });      // effect runs once
```

`effect(fn)` returns its disposer. `fn` may return a cleanup function, which runs
once before the next run or on dispose. Any other return value is ignored at run
time (tsc still rejects an expression body that returns a value; use a block). `fn`
must be synchronous: `effect(async () => …)` logs an error, because its Promise is
not a cleanup and nothing after the first `await` is tracked.

Writes made inside an effect body reach other effects **after the body returns**,
on its first run as on every later one. An effect that writes a signal and then
reads a computed of it that it has read before sees the old value, and re-runs once
the write settles; a computed it reads for the first time in the pass is brought up
to date first. An
effect that writes its own dependency (a clamp, a default) runs again after the
current run, never inside it.

**Each effect or computed run owns what it creates.** Anything its body creates is
disposed before the next run and when the effect is disposed: computeds (including
`.map()`), nested effects, `when()` and `list()`, components, and anything
registered with `trackDispose()`. Something meant to outlive one run goes outside
the body, as in mistake §4 below.

## JSX

Components run once and return real DOM nodes. Reactivity lives in the signals,
not in re-rendering.

```tsx
const name = signal("World");
function Greeting() {
  return <h1>Hello {name}</h1>;       // bare signal as child: reactive
}

// App root without a router: mount() brackets a dispose scope and returns the disposer.
// Routed apps get the same from routes().
const dispose = mount(document.getElementById("root")!, () => <Greeting />);

<span>{() => count.get() > 5 ? "High" : "Low"}</span>      // function child tracks its reads
<input value={name} />                                      // signal as prop
<div class={visible.map(v => v ? "show" : "hide")} />       // .map() for derived attributes
<div class={() => visible.get() ? "show" : "hide"} />       // function prop tracks too
<div style={() => ({ width: `${w.get()}px` })} />           // style: CSS string or object
```

A child that is a signal or a function renders its value as text. `null`,
`undefined`, `true` and `false` render as nothing, as a static child does.

A component body runs once and **untracked**: a `.get()` in it, or in a `when()`
branch, a `list()` row, a route handler or `mount()`'s render, is a one-shot read
that subscribes nothing. In development railroad warns once per render body, naming
it. A production build turns that check off. `.peek()` and `untrack()` don't warn.

### Props

A Signal or a function is reactive. Anything else is applied once. The exceptions
are `ref` (called once with the element) and `on*` (a listener, which must be a
function).

| Prop | Static value | Reactive value (Signal or function) |
|---|---|---|
| `class` / `className` | set; `null`/`undefined`/`false` → no attribute | same, re-applied on change |
| `style` | CSS string (`"color: red"`) or object (`{ color: "red", "--accent": "blue" }`: camelCase keys and custom properties); `null`/`false`/`""` → no attribute | same; may switch between string and object; an object clears keys the next object omits |
| `value` `checked` `disabled` `selected` `src` `srcdoc` | set as DOM property; `null`/`undefined` → `""`; a `<select>`'s `value` selects its option | same |
| `innerHTML` | set; `null`/`undefined` → `""`; replaces any JSX children | same |
| `htmlFor` | the `for` attribute | same |
| anything else | `setAttribute(String(v))`; `false`/`null`/`undefined` → removed | same |
| `ref` | called once with the element, after its children are appended | — |
| `on*` | `addEventListener`, lowercased. The DOM's events: `onchange` on a text input fires on commit, `oninput` per keystroke. A non-function warns and attaches nothing | not reactive |

Props are applied after the element's children, which lets a `<select value>` find
its `<option>`s.

Each tag's props are typed from the DOM's element types (`HTMLElementTagNameMap`).
An attribute is the element's property lowercased, as HTML writes it (`tabindex`,
`readonly`, `colspan`, `popovertarget`), plus `class`/`className`,
`for`/`htmlFor`, and any hyphenated name (`data-*`, `aria-*`, `http-equiv`, a
library's `hx-get`). Each value is static, a Signal, or a function of a string,
number, boolean, `null` or `undefined`. An `on*` prop is one of the element's own
events, lowercase, as a function of that event with `currentTarget` typed.
`oninput` gets an `InputEvent`, except on a `<select>`. A `ref` gets the element's
type. `onClick`, `tabIndex`, `<div clas>` and `onclick="…"` don't compile. An SVG
tag or a custom element (a name with a hyphen) takes any attribute, with typed
handlers and `ref`.

### `when(condition, truthy, falsy?)`

```tsx
{when(loggedIn, () => <Dashboard />, () => <Login />)}
```

`condition` is a signal or a function. The branch is rebuilt only when truthiness
flips, so a value change inside the same branch (`"a"` → `"b"`) does not re-render.
The truthy branch is given the value as `v$`: a `ReadonlySignal` of the current
truthy value, narrowed to `NonNullable<T>`. It notifies whenever the condition does
while it stays truthy, an in-place `.touch()` included:

```tsx
{when(user, (u$) => <Profile name={u$.map(u => u.name)} />, () => <Login />)}
```

The branch renders synchronously, so it is in the DOM as soon as `mount()` or the
parent append returns. It lives between `<!--when-->` and `<!--/when-->` comments,
and each branch gets its own dispose scope.

### `list(items, keyFn?, render, options?)`

```tsx
{list(todos, t => t.id, (todo$, idx$) => (
  <li class={idx$.map(i => i % 2 ? "odd" : "even")}>
    {todo$.map(t => t.text)}
  </li>
))}
```

The keyed form passes each row a `ReadonlySignal<T>` and a `ReadonlySignal<number>`
index. Rows are moved, not rebuilt, and each lives between bracket comments. A
reorder moves only the rows outside the longest run already in order, so a row
that didn't move keeps its focus, selection and scroll position. Rows render
synchronously, like `when()`.

The index form, `list(items, (item, i) => …)`, passes raw values and rebuilds every
row on every change. That is fine for static lists.

`options` (keyed form only) passes `SignalOptions` to each row's item signal. The
default `Object.is` is right when a changed row is a new object. Pass
`{ equals: () => false }` when a patch stream mutates row objects in place and
calls `.touch()`. See mistake §2 below.

### SVG

SVG tags (`circle`, `g`, `linearGradient`, `clipPath`, filter primitives…) are
created in the SVG namespace outright, including inside `when()` and `list()`, with
camelCase preserved. `<foreignObject>` children stay HTML.

## Routes

A hash-based client router. Handlers receive `(params, params$)`. The second is a
reactive `ReadonlySignal` that updates when the params change within the same
pattern, so `/users/1` → `/users/2` does not remount.

```tsx
import { routes, navigate, route, when } from "@blueshed/railroad";

routes(app, {
  "/":          () => <Home />,
  "/users/:id": (_p, params$) => <User id={params$.map(p => p.id)} />,
  "/posts/:id": { keyed: true, handler: ({ id }) => <Post id={id} /> },  // re-runs per id
  "/sites/*":   () => <SitesLayout />,    // wildcard keeps the layout mounted
});

function SitesLayout() {
  const detail = route<{ id: string }>("/sites/:id");
  return (
    <div>
      <SitesNav />
      {when(detail, (d$) => <SiteDetail id={d$.map(d => d.id)} />, () => <SitesList />)}
    </div>
  );
}

navigate("/users/42");   // route() and the router are current as it returns
```

`/sites` → `/sites/42` → `/sites/99` keeps `SitesLayout` mounted and swaps only
the inner content. Navigating away from `/sites/*` tears the layout down cleanly.

A keyed route (`{ keyed: true, handler }`) disposes the old run and builds a fresh
one when the params change, so its handler may destructure its params. Don't key a
wildcard layout: its `params["*"]` changes on every sub-path.

### Error boundaries

`routes()` takes an optional third argument, `{ onError }`:

```tsx
routes(
  document.getElementById("root")!,
  {
    "/": () => <Home />,
    "/bad": () => { throw new Error("Sync crash"); },
    "/bad-async": async () => { throw new Error("Async crash"); },
  },
  {
    onError: (err) => {
      console.warn("Caught route error:", err);   // err is unknown
      return <div class="error-boundary">Something went wrong.</div>;
    }
  }
);
```

When a handler throws synchronously or rejects, `onError` runs. If it returns a DOM
`Node`, that node renders in the router's container, so the screen isn't blank and
the dispose scope stack stays balanced. Without `onError`, the error goes to
`console.error`.

`routes()` returns its disposer. `matchRoute(pattern, path)` is the pure matcher,
exported for tests and server use.

## Realtime

Two patterns, depending on whether you control the patch stream or delegate it to
`@blueshed/delta`.

### Hand-rolled patch streams: `.touch()` and `.mutate()`

For a signal holding a large document that patches mutate in place (CRDT updates,
a custom WebSocket protocol, SQL `LISTEN/NOTIFY` payloads), `touch()` and `mutate()`
avoid the `structuredClone` cost of `.set()` on a fresh object:

```tsx
import { signal, list } from "@blueshed/railroad";

type Row = { id: number; text: string; done: boolean };
const rows = signal<Row[]>([]);

const ws = new WebSocket("/ws");
ws.onmessage = (ev) => {
  applyPatch(rows.peek(), JSON.parse(ev.data));   // any JSON-Patch applier; mutates in place
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

The `{ equals: () => false }` matters. `list()` pushes each sync into its row's
item signal, and an in-place patch re-delivers the same row reference, which the
default `Object.is` would swallow. The row's own `.map()` computeds still bail on
unchanged values, so DOM writes stay minimal.

### Delta: turnkey JSON-Patch sync

[`@blueshed/delta`](https://www.npmjs.com/package/@blueshed/delta) provides
WebSocket sync. Its `openDoc()` returns a `Doc<T>` whose `data` is a railroad
`ReadonlySignal<T | null>` (change it with `doc.send(ops)`). The client recipe, the keyed-list pattern and the
`applyOpsToCollection` steering are in SKILL.md › Realtime. This is the server side:

```tsx
// Same Bun.serve hosts the HTML route and the WebSocket
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

Delta's backends are a JSON file, SQLite (temporal), Postgres (RLS and
LISTEN/NOTIFY), memory, and an outside source or static document. The client is the
same for all of them. See delta's README for each.

Open a doc in a component or at module level, never inside an `effect()` body. A
doc opened in an effect is closed when the effect re-runs.

## Testing

Unit tests run against happy-dom, preloaded through `bunfig.toml`, for fast
reactivity assertions. Integration tests use `Bun.WebView` to drive a real headless
browser against the actual `Bun.serve` instance.

```ts
// tests/counter.test.ts
import { test, expect } from "bun:test";
import { startServer } from "../server";

test("counter increments", async () => {
  const { server } = await startServer({ port: 0 });
  await using view = new Bun.WebView({ width: 800, height: 600 });
  await view.navigate(server.url.href);
  await view.click("[data-testid=inc]");
  expect(await view.evaluate<string>("document.querySelector('#count').textContent")).toBe("1");
  server.stop(true);
});
```

Keep browser tests in their own file and run them by explicit path (this repo runs
`bun test ./tests/webview.test.ts`): a bare `bun test` can leave files under `tests/`
out of discovery. The `bun-route` skill has the full WebView
patterns, the version notes and the test footguns.

`navigate(path)` updates the route synchronously, so a unit test needs no tick
after it. Setting `location.hash` yourself, or following a `#/…` link, lands on the
next `hashchange`, one macrotask later: `await new Promise(r => setTimeout(r, 0))`.

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
logging: method, path, status and time. A throw is logged and re-thrown.
`LOG_LEVEL` is one of `silent`, `error`, `warn`, `info`, `debug`.

## Progressive adoption

Each module is independent. Take the level you need:

```
signals     no deps        Use anywhere: server, CLI, worker, tests
shared      no deps        Typed DI without prop threading
logger      no deps        Bun-friendly leveled console output
jsx         signals        Reactive real-DOM rendering
routes      signals, jsx   Hash router with reactive params (jsx for SVG adoption only; loads without a DOM)
```

```ts
// Just signals: no JSX, no tsconfig changes
import { signal, computed, effect } from "@blueshed/railroad/signals";
```

## What it isn't

- Not a TC39 Signals implementation. It is push-based, in the family of Vue's `ref`, Solid's `createSignal` and Preact's signals.
- Not an SSR or RSC framework. Bun doesn't ship those either.
- Not a virtual DOM or a hooks system.

## The nine mistakes, in full

`SKILL.md` gives each mistake as a rule and a ❌/✅ pair. This section has the
reasons, the edge cases and the rest of the examples.

### 1. Don't call `.get()` in JSX children or render bodies

```tsx
// ❌ Reads once, never updates
<span>{count.get()}</span>

// ✅ Bare signal: a reactive text node
<span>{count}</span>

// ✅ Function child: tracks the reads it makes
<span>{() => count.get() > 5 ? "High" : "Low"}</span>

// ✅ Derived attributes and list content
<input disabled={count.map(n => n > 10)} />
<div class={() => count.get() > 10 ? "hot" : "cold"} />
{list(todos, t => t.id, (todo$) => <li>{todo$.map(t => t.text)}</li>)}
```

`{count}` puts the Signal into JSX, so the runtime binds a reactive text node. `{count.get()}` puts in a plain number, which never changes again.

The same holds in any render body: a component body, a `when()` branch, a `list()` row, a route handler, `mount()`'s render. These run once and untracked, so a `.get()` there subscribes nothing. Bind the signal where the value should stay live, or use `.peek()` when a one-shot read is what you mean. In development railroad warns once per render body about a `.get()` there. `.peek()` and `untrack()` don't warn.

A function child must return **text**, not a Node. `{() => cond ? <A/> : <B/>}` renders the stringified element. Railroad warns about this in development and production alike. Use `when()` for a conditional element and `list()` for a collection.

### 2. `list()` rows are `Signal<T>`, not `T`

```tsx
// ❌ Destructuring reads the value once
{list(rows, r => r.id, ({ text }) => <li>{text}</li>)}

// ✅ Derive reactive content from the row signal
{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}

// ✅ .peek() for a key or attribute that never changes
{list(rows, r => r.id, (row$) => <li data-id={row$.peek().id}>{row$.map(r => r.text)}</li>)}
```

The index form, `list(items, (item, i) => …)`, passes raw values and rebuilds every row on change. Use it only for static lists.

`keyFn` must return a **unique** key per item. Duplicate keys collapse into one row and the rest are dropped (railroad warns). Key by a stable id.

When rows arrive by **in-place mutation plus `.touch()`**, pass `{ equals: () => false }` as the fourth argument. The sync re-delivers the same row reference, and the default `Object.is` would leave that row's DOM stale:

```tsx
{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>, { equals: () => false })}
```

Streams that replace whole row objects keep the default. `@blueshed/delta` is one of them: it broadcasts a changed row as a whole-row replace.

A keyed reorder moves only the rows that changed position, so a row being typed in keeps its focus.

### 3. SVG tags get the SVG namespace at creation

SVG-only tags (`circle`, `g`, `path`, `linearGradient`, `clipPath`, `foreignObject`, `fe*`…) are created in the SVG namespace wherever they appear: component returns, fragments, `when()` and `list()` renders. camelCase is kept. Children of `<foreignObject>` stay HTML.

```tsx
<svg>
  <defs><linearGradient id="g"><stop offset="0" stop-color="red" /></linearGradient></defs>
  {list(shapes, s => s.id, (s$) => <circle r={s$.map(s => s.r)} fill="url(#g)" />)}
  <foreignObject width="100" height="100"><div>html island</div></foreignObject>
</svg>
```

Two edges remain:

- `a`, `script`, `style` and `title` are shared with HTML. Inside `<svg>` they are created as HTML and **adopted** on append. On that path a `ref` fires twice (use the last call), and hand-attached listeners are lost. Use `on*` props, which are re-applied.
- An SVG element renders only under an `<svg>` ancestor in the document. That is SVG's rule, not railroad's.

Prefer `href` over `xlink:href` on `<use>` and `<textPath>`.

### 4. Effects auto-dispose only inside a parent scope

```tsx
// ✅ Inside a component, route handler, when(), list() or mount(): disposed on teardown
function Counter() {
  const c = signal(0);
  effect(() => console.log(c.get()));
  return <span>{c}</span>;
}

// ✅ App root without a router
const dispose = mount(document.getElementById("root")!, () => <App />);

// ❌ Module top level: never disposed
const c = signal(0);
effect(() => console.log(c.get()));
```

Scopes are pushed by `createElement(Component)`, `routes()` handlers, `when()`, `list()` and `mount()`. Every `effect()` and `computed()` run is a scope too: whatever its body creates is disposed before the next run and when the effect is disposed. `route()` (singular) is not a scope provider.

Three consequences:

- Anything that must outlive one run of an effect is created outside its body:

  ```tsx
  // ❌ Released on the next run; the cache goes dead
  let label: ReadonlySignal<string> | undefined;
  effect(() => { user.get(); label ??= name.map(n => n.toUpperCase()); });

  // ✅ Derived beside the effect
  const label = name.map(n => n.toUpperCase());
  effect(() => { user.get(); console.log(label.get()); });
  ```

  Opening a fresh resource on every run is fine when that is the intent, such as `openDoc(\`room:${room.get()}\`)` to follow `room`.
- A top-level `effect()` leaks unless you keep its disposer. So does one made in an event handler, because `onclick` is not a scope. Derive in the component body.
- `when()` or `list()` created outside any scope leaks, and railroad warns. For an advanced custom root, bracket it yourself and keep the disposer: `pushDisposeScope()` … build UI … `const dispose = popDisposeScope()`. Or register cleanups with `trackDispose(fn)`; `hasActiveDisposeScope()` says whether a scope is open.

### 5. Use the realtime hatches for large documents

Railroad is synchronous: `set()` notifies subscribers at once. For a large object changed by a patch stream, don't `set()` a fresh clone each time:

```tsx
// ❌ Clones the whole document on every patch
ws.onmessage = (ev) => {
  doc.set({ ...doc.peek(), ...applyPatch(doc.peek(), JSON.parse(ev.data)) });
};

// ✅ Mutate in place, then touch(). applyPatch is any JSON-Patch applier that mutates.
ws.onmessage = (ev) => {
  applyPatch(doc.peek(), JSON.parse(ev.data));
  doc.touch();
};

doc.mutate(d => { d.items.push(newRow); });   // structuredClone, mutate, notify
filter.patch({ color: "blue" });              // shallow merge for object signals
```

`.touch()` notifies effects and primitive-returning computeds. A computed that returns the same reference bails by design, so project to fresh values (`Object.values(...)`, primitives) or pass `{ equals: () => false }` to `.map()`. A keyed `list()` fed by an in-place stream needs the `equals` option from mistake §2.

### 6. Event handlers are lowercase HTML, not React

Railroad is HTML-flavoured JSX: `class`, `onclick`, `tabindex`. Props are typed from the DOM's element types, so `onClick`, `tabIndex` or a typo like `clas` fails to compile. `className` and `htmlFor` also compile, for React habits. Hyphenated attributes (`data-*`, `aria-*`, `hx-get`) take any value, as does every attribute on an SVG tag or custom element.

The value must be a **function**: `onclick={handler}`, never `onclick={handler()}`, and never a Signal, since handlers are not reactive. A non-function warns and attaches nothing. `onclick={maybeHandler}` with `null` or `undefined` is fine.

The events are the DOM's. `onchange` on a text input fires on commit (blur or Enter). Use `oninput` for every keystroke.

### 7. Dynamic arrays need `list()`; a plain `.map()` is for static collections

`{arr.map(item => <Row item={item} />)}` bakes its children in once. If `arr` changes length, the JSX does not react.

```tsx
// ✅ Static: the length never changes
const COLUMNS = [{ id: "todo" }, { id: "doing" }, { id: "done" }];
<main>{COLUMNS.map(c => <Column col={c} />)}</main>

// ❌ Dynamic: children won't update
<ul>{rows.peek().map(r => <li>{r.text}</li>)}</ul>

// ✅ Dynamic: keyed list() preserves identity per row
<ul>{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}</ul>
```

Any array derived from a signal goes through `list()`.

### 8. Async components resolve to a thunk

Components may be `async`. They render a placeholder, plus an optional `fallback` thunk, then fill in when the promise settles. The rule is to **resolve to a thunk**: the `() =>` on the return line is the whole contract.

```tsx
// ✅
async function Profile() {
  const user = await fetchUser();
  return () => <div>{user.name}</div>;
}
<Profile fallback={() => <p>loading…</p>} />

// ❌ Bare Node: a console error, and nothing renders
async function Profile() {
  const user = await fetchUser();
  return <div>{user.name}</div>;
}
```

Effects created after an `await` have no owner scope, because browser JS has no AsyncContext. The thunk gives railroad a synchronous moment in which it runs the bindings under a scope it owns, so teardown is correct however late the promise settles. Disposing before the promise settles drops the thunk: it never runs. `fallback` is a thunk too, rendered at once and swapped out on settlement; if the component rejects, the fallback is cleared and the error logged.

- Effects created before the first `await` belong to the component as usual.
- Async `routes()` handlers follow the same rule and resolve to `() => <Node>`, so post-await bindings die on navigation. A bare Node gets the same console error, and `onError` runs if given.
- For streaming or multi-stage states rather than one fallback-to-content swap, use an effect that writes a signal, rendered with `when()`.
- `effect()` must be synchronous. `effect(async () => …)` logs an error. Start the async work from the effect and write the result to a signal. Only a returned function is treated as cleanup.

### 9. What a render reads, it reads once: `when()` values and route params

Two habits from React show a stale value with no error. `when()` rebuilds its branch only when the condition's **truthiness** flips. A route handler runs once per **pattern**, so its `params` stay the first match.

```tsx
// ❌ /sites/42 → /sites/99 still shows site 42: the branch never rebuilds
{when(detail, () => <SiteDetail id={detail.get()!.id} />)}
// ✅ d$ is the current truthy value, narrowed (no !)
{when(detail, (d$) => <SiteDetail id={d$.map(d => d.id)} />)}

// ❌ /users/1 → /users/2 still shows user 1
routes(app, { "/users/:id": ({ id }) => <h1>user {id}</h1> });
// ✅ Read the id through params$, which updates in place
routes(app, { "/users/:id": (_, params$) => <h1>user {params$.map(p => p.id)}</h1> });
// ✅ Or mark the route keyed: the handler re-runs when the params change
routes(app, { "/users/:id": { keyed: true, handler: ({ id }) => <h1>user {id}</h1> } });
```

The `d$` in a `when()` branch notifies whenever the condition does while it stays truthy, including an in-place `.touch()`. Bind it (`d$.map(…)`, `{d$}`) rather than calling `.get()` in the branch. A keyed route rebuilds its state from scratch, so focus and local signals reset; `params$` keeps the data. Don't key a wildcard layout (`/sites/*`), because its `params["*"]` changes on every sub-path.

## Sharp edges

The rules marked ↗ are explained in the mistakes section above, so they are not repeated here.

- **Propagation is topologically ordered.** One write, or one `batch()`, runs each affected computed or effect at most once per settled pass, upstream before downstream. That holds for a computed that switches what it reads. A diamond never observes half-updated state. Siblings run in subscription order. An effect that writes signals re-queues their consumers in the same pass, and they settle before the next effect runs. A true cycle throws.
- **Effects own what they create.** ↗ mistake §4.
- **`when()` and `list()` need a dispose scope.** ↗ mistake §4.
- **Routes match in declaration order, on segments only.** The first match wins, so `/users/new` goes before `/users/:id`. A trailing slash is a real empty segment: `/users/42/` does not match `/users/:id`. There is no query-string handling; split `?` off yourself.
- **SVG adoption.** Only `a`, `script`, `style` and `title` are adopted when appended inside `<svg>`. A `when()` or `list()` fragment appended by hand (`svg.appendChild(when(…))`) does not adopt those four in its first render. Place it through JSX, `mount()`, `routes()` or a `when()`/`list()` parent instead.
- **One copy per page.** ↗ Local development across repos, below.
- **An event handler is not a dispose scope.** ↗ mistake §4.
- **`provide`/`inject` is a process-global singleton.** It suits client apps and app-wide services. On the server it is shared across all requests, so don't use it for per-request state.
- **`.mutate()` uses `structuredClone`.** It works only on plain-data signals: no functions, class instances or DOM nodes in the value.
- **Same-reference projections bail.** `doc.map(d => d.settings)` returns the same reference after a `.touch()`, so the computed bails. Project to fresh values (`Object.values(...)`, primitives) or pass `{ equals: () => false }`. ↗ mistake §5.
- **In-place row mutation needs `list()`'s `equals` option.** ↗ mistake §2.
- **Async components resolve to a thunk.** ↗ mistake §8.
- **The index-based `list()` rebuilds every row on every change.** That is its contract. Use the keyed form for anything that updates, so rows patch in place through their item signals.

## Local development across repos

A page must load **one copy** of railroad. Each copy has its own `Signal` class, scopes and provider registry, so the two cannot see each other, and railroad does not bridge them. Symptoms: the UI stops updating, an effect reading delta's `doc.data` never re-runs, `inject(WS)` finds no provider, and `openDoc()` in a component never auto-closes.

Railroad reports it. A second copy logs `A second copy of @blueshed/railroad has loaded (…)`, and rendering the other copy's signal throws, naming both copies.

The usual cause is a `file:` link or `bun link` to a delta checkout, which brings its own `node_modules/@blueshed/railroad`. Install a packed tarball instead, which carries no `node_modules`, so delta's peer resolves to the app's railroad:

```sh
cd ../delta && bun pm pack               # writes blueshed-delta-<version>.tgz
cd ../app   && bun remove @blueshed/delta && bun add ../delta/blueshed-delta-<version>.tgz
```

Repeat both after each change to the checkout. `bun add` of the same tarball keeps the old contents, and so do `bun install --force` and deleting `node_modules/@blueshed/delta`, because `bun.lock` pins the first tarball's integrity hash. Deleting `bun.lock` also works.
