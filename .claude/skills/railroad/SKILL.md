---
name: railroad
version: 0.10.1
description: "Railroad — reactive UI for the Bun fullstack runtime. Signals, JSX, hash router, DI, logger. Use when writing JSX with signals, when()/list()/routes(), or any import from @blueshed/railroad. Pair with @blueshed/delta for WebSocket document sync."
---

Railroad is the reactive layer that fits the Bun 1.3 fullstack pipeline. **For scaffolding routes, server entries, or `Bun.WebView` test files, invoke the `bun-route` skill** — it auto-detects `@blueshed/railroad` in `package.json` and uses tsx-railroad mode. This skill covers what's railroad-specific: how the reactive primitives behave and the gotchas that bite in JSX.

Source files (each has a JSDoc header — read for full API): `signals.ts` · `jsx.ts` · `routes.ts` · `shared.ts` · `logger.ts`

## What railroad gives you on top of Bun

Bun 1.3 already ships HTML imports, HMR, TSX bundling, `--compile`, and `Bun.WebView`. Railroad adds:

- **Signals** — push-based reactive primitives (Vue/Solid/Preact family; not TC39). Glitch-free: propagation is topologically ordered, so diamonds settle in one consistent pass.
- **JSX runtime** — components run once, return real DOM nodes, signals bind to text and attributes automatically; supports automatic `style` signal property clearance when updated signals omit style keys.
- **`when()` / `list()` / `mount()`** — reactive conditionals, keyed lists, and a root scope helper, all with auto-disposal.
- **Hash router** — `routes(target, table, options)`, `route()` for sub-navigation, reactive `params$` so `/users/1` → `/users/2` updates without remounting; supports `options.onError` boundary callback.
- **DI / logger** — typed `provide`/`inject` with phantom-typed keys; leveled console output.
- **Realtime escape hatches** — `.touch()`, `.mutate()`, `.patch()` for in-place document mutation under WebSocket / CRDT / `LISTEN/NOTIFY` patch streams.

## The seven things that bite if you're not careful

### 1. Do NOT call `.get()` in JSX children

```tsx
// ❌ Reads once, never updates
<span>{count.get()}</span>

// ✅ Bare signal — auto-reactive text node
<span>{count}</span>

// ✅ Function child — auto-tracks reads
<span>{() => count.get() > 5 ? "High" : "Low"}</span>

// ✅ .map() for derived attrs / list content
<input disabled={count.map(n => n > 10)} />
{list(todos, t => t.id, (todo$) => <li>{todo$.map(t => t.text)}</li>)}
```

#1 bug. `{count}` puts the Signal *itself* into JSX, where the runtime registers a reactive text node. `{count.get()}` puts a plain number in, never reactive again.

A function child must also return **text**, not a Node. `{() => cond ? <A/> : <B/>}` renders the *stringified* element (e.g. `[object SVGElement]`), not the element — railroad warns on the console (dev and prod alike). To render elements conditionally use `when()`; for collections use `list()`.

### 2. `list()` keyed render gets `Signal<T>`, not `T`

```tsx
// ❌ Destructuring the signal turns it into a plain value (no reactivity)
{list(rows, r => r.id, ({ text }) => <li>{text}</li>)}

// ✅ Use .map() to derive reactive content
{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}

// ✅ .peek() for one-shot reads (key/attribute that won't change)
{list(rows, r => r.id, (row$) => <li data-id={row$.peek().id}>{row$.map(r => r.text)}</li>)}
```

Index-based form (no keyFn) gets raw values and recreates the row on change — fine for static lists, wasteful for editable ones.

`keyFn` must return a **unique** key per item. Duplicate keys collapse to a single row and silently drop the others (railroad warns on the console) — key by a stable unique id (`r => r.id`), not by a value that can repeat.

When rows arrive by **in-place mutation + `.touch()`** (a hand-rolled patch stream, delta's JSON-file backend), pass `{ equals: () => false }` as the keyed form's fourth argument — the sync re-delivers the *same row reference*, and the default `Object.is` swallows it, leaving that row's DOM silently stale:

```tsx
{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>, { equals: () => false })}
```

Row-level `.map()` computeds still bail on unchanged values, so DOM writes stay minimal. Streams that replace whole row objects (delta's SQLite/Postgres backends) keep the default.

### 3. SVG is first-class — tags get the SVG namespace at creation

SVG-only tags (`circle`, `g`, `path`, `linearGradient`, `clipPath`, `foreignObject`, `fe*` filters, …) are created directly in the SVG namespace, wherever they appear — components returning `<circle>`, fragments, `when()`/`list()` renders. camelCase is preserved; `<foreignObject>` children stay HTML.

```tsx
// ✅ All of this just works, with refs firing once and listeners surviving
<svg>
  <defs><linearGradient id="g"><stop offset="0" stop-color="red" /></linearGradient></defs>
  {list(shapes, s => s.id, (s$) => <circle r={s$.map(s => s.r)} fill="url(#g)" />)}
  <foreignObject width="100" height="100"><div>html island</div></foreignObject>
</svg>
```

Two edges remain:

- The four tags shared with HTML — `a`, `script`, `style`, `title` — are created as HTML and **adopted** when appended inside `<svg>`. On that path only, a `ref` fires twice (use the last call) and manual `addEventListener` calls are lost — use `on*` props, which are re-applied.
- An SVG element still needs an `<svg>` ancestor in the document to *render* — that's SVG itself, not railroad. Hand-built `createElementNS` elements pass through unchanged.

Prefer `href` over `xlink:href` on `<use>`/`<textPath>` — railroad sets plain attributes, which is exactly SVG2's `href`.

### 4. Effects auto-dispose **only** inside a parent scope — root apps with `mount()`

```tsx
// ✅ Inside a component / route / when / list / mount — auto-disposed on teardown
function Counter() {
  const c = signal(0);
  effect(() => console.log(c.get()));
  return <span>{c}</span>;
}

// ✅ App root without a router — mount() brackets a scope, returns the disposer
const dispose = mount(document.getElementById("root")!, () => <App />);

// ❌ Module top-level — never disposed (leaks until process exit)
const c = signal(0);
effect(() => console.log(c.get()));
```

Dispose scopes are pushed by `createElement(Component)`, a `routes()` handler, `when()`, `list()`, and `mount()` — for the effects/computeds created **inside** them. `route()` (singular) is **not** a scope provider: it returns a `ReadonlySignal` and does not dispose children for you.

Two consequences worth internalising:

- A top-level `effect()` you create yourself leaks unless you keep its disposer.
- `when()` / `list()` created **outside** any parent scope leak — their driving effect's disposer is unreachable, so railroad **warns on the console**. Mount UI through a component, a `routes()` handler, or `mount()`. For an advanced custom root, bracket it yourself: `pushDisposeScope()` … build UI … `const dispose = popDisposeScope()`, or register cleanups with `trackDispose(fn)`; `hasActiveDisposeScope()` tells you whether one is open.

### 5. Use the realtime escape hatches for large documents

Railroad is push-based and synchronous — `set()` notifies subscribers immediately. For large objects mutated by patch streams, don't `set()` a fresh clone every time:

```tsx
// ❌ Wasteful — clones whole document on every patch
ws.onmessage = (ev) => {
  doc.set({ ...doc.peek(), ...applyPatch(doc.peek(), JSON.parse(ev.data)) });
};

// ✅ Mutate in place, then touch() to notify without replacing the ref
ws.onmessage = (ev) => {
  applyPatch(doc.peek(), JSON.parse(ev.data));
  doc.touch();
};

// .mutate(fn) is the safer middle ground: structuredClone, mutate, notify
doc.mutate(d => { d.items.push(newRow); });

// .patch(partial) is shallow-merge for object signals
filter.patch({ color: "blue" });
```

`.touch()` propagates to effects and primitive-returning computeds. A computed that returns the same reference (`computed(() => doc.get().items)`) bails via its own `equals` guard — by design. Two consequences: project to fresh values (`Object.values(...)`, primitives) or pass `{ equals: () => false }` to `.map()`; and a keyed `list()` fed by an in-place stream needs `{ equals: () => false }` as its fourth argument (see §2), or edited rows go stale.

### 6. Event handlers are lowercase HTML, not React PascalCase

Railroad is HTML-flavoured JSX — it uses `class`, not `className`; `onclick`, not `onClick`. The runtime accepts PascalCase too (it lowercases anything starting with `on`), but mixing conventions makes diffs noisier and trains the next reader on the wrong style.

```tsx
// ✅ Lowercase HTML — matches `class`, `srcdoc`, `tabindex` etc.
<button onclick={() => count.update(n => n + 1)}>+1</button>
<div ondragover={onDragOver} ondrop={onDrop} />

// ❌ React-style PascalCase — works, but inconsistent with the rest of railroad
<button onClick={() => count.update(n => n + 1)}>+1</button>
```

### 7. Dynamic-length arrays need `list()`; plain `.map()` is fine for static collections

`{arr.map(item => <Row item={item} />)}` produces a flat array of nodes. Railroad has no reconciler, so if `arr` ever *changes length* (push, splice, filter), the JSX won't react — the children are baked in at the time JSX evaluated.

```tsx
// ✅ Static collection (length never changes) — plain .map() is fine
const COLUMNS = [{ id: "todo" }, { id: "doing" }, { id: "done" }];
<main>{COLUMNS.map(c => <Column col={c} />)}</main>

// ❌ Dynamic collection — children won't update on change
<ul>{rows.peek().map(r => <li>{r.text}</li>)}</ul>

// ✅ Dynamic collection — list() with a key preserves identity per row
<ul>{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}</ul>
```

Rule of thumb: any array derived from a signal (`doc.data.map(d => d.cards)`, `signal([...])`, etc.) must go through `list()`. Hard-coded arrays in module scope can use `.map()`.

## Mental model

Components run **once**. They return real DOM nodes. No virtual DOM, no reconciler, no diffing. Reactivity comes from signals — bare signals as children become reactive text nodes; signals as props become reactive attributes; function children auto-track signal reads.

Effects and computeds auto-dispose when their parent scope (component, route, `when`, `list`, `mount`) tears down.

## Routes — wildcard layouts

```tsx
routes(app, {
  "/":          () => <Home />,
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
```

`/sites` → `/sites/42` → `/sites/99`: layout stays mounted, only inner content swaps. `params$` updates without remounting; `route()` is a `ReadonlySignal<T | null>`.

Matching is purely segment-based: there is no query-string handling (`#/users/42?tab=1` matches `/users/:id` with `id === "42?tab=1"` — split on `?` yourself), and a trailing slash is a real empty segment (`/users/42/` does **not** match `/users/:id`).

In tests: `hashchange` is dispatched on the next macrotask in both happy-dom and real browsers. After `navigate(...)`, `await new Promise(r => setTimeout(r, 0))`.

### Error Boundaries (`options.onError`)

The router supports an optional third argument `options` with an `onError` boundary callback:

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
      console.warn("Caught route error:", err.message);
      return <div class="error-boundary">Something went wrong.</div>;
    }
  }
);
```

If a route handler throws synchronously or rejects asynchronously, the `onError` hook is executed. If it returns a standard DOM `Node`, that node is rendered in the router's container, avoiding a blank screen while keeping the internal dispose scope stack perfectly balanced. If omitted, the error is logged to `console.error`.

## Realtime — pair with `@blueshed/delta`

For WebSocket document sync over JSON-Patch use [`@blueshed/delta`](https://www.npmjs.com/package/@blueshed/delta). Delta declares `@blueshed/railroad` as a peer dependency and `delta/client.ts` imports `signal` directly — `openDoc("name")` returns a `Doc<T>` whose `data` field **is a railroad `Signal<T | null>`**, not a wrapper. It drops straight into JSX / `when()` / `list()` with no glue.

Three backends: JSON file, SQLite (temporal), Postgres (RLS + LISTEN/NOTIFY).

### Server — one Bun.serve hosting both the HTML route and the WebSocket

```tsx
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

### Client — `list(doc.data.map(...), keyFn, render)` is the keyed-list pattern

`doc.data` is a railroad signal. To render a collection from it, **use `list()`** with a `.map()` projection — not `applyOpsToCollection` from `@blueshed/delta/dom-ops`. List's keyed form already does the surgical per-row update that `applyOpsToCollection` exists to provide for vanilla DOM, so they overlap. With railroad in the project, `list()` wins:

```tsx
import { provide, list, when } from "@blueshed/railroad";
import { connectWs, WS, openDoc } from "@blueshed/delta/client";

provide(WS, connectWs("/ws"));

interface Card { id: number; title: string; column_id: number; }
interface BoardDoc { columns: Record<string, Column>; cards: Record<string, Card>; }

const doc = openDoc<BoardDoc>("board:1");

function Board() {
  // doc.data is Signal<BoardDoc | null>. .map() derives a ReadonlySignal<Card[]>
  // that re-emits whenever the doc updates. list() then preserves DOM identity
  // per card.id — only the changed row's signal updates, not the whole list.
  const cards = doc.data.map((d) => d ? Object.values(d.cards) : []);
  return (
    <div>
      {when(doc.data, () => (
        <ul>
          {list(cards, (c) => c.id, (card$) => (
            <li>{card$.map((c) => c.title)}</li>
          ))}
        </ul>
      ), () => <p>loading…</p>)}
    </div>
  );
}

// Sending an op — single verb, single path, signal updates automatically
await doc.send([{ op: "add", path: "/cards/-",
  value: { column_id: 1, title: "new card", position: 0 } }]);
```

### When NOT to use `applyOpsToCollection`

`@blueshed/delta/dom-ops` exists for projects that don't have a keyed reactive list primitive (e.g. vanilla DOM clients). Railroad's `list(..., keyFn, ...)` provides the same per-row identity preservation natively. Don't import both; pick one:

| Project shape | Use |
|---|---|
| Vanilla DOM (no railroad) | `applyOpsToCollection(parent, "coll", ops, { create, update })` from `@blueshed/delta/dom-ops` |
| Railroad in deps | `list(doc.data.map(d => Object.values(d.coll)), r => r.id, (r$) => …)` |

The `delta-doc` skill (installed with `@blueshed/delta`) has the full API surface, the three-backend graduation table, and the canonical recipe for non-railroad projects.

## Anti-patterns

1. **No React.** No `useState`, `useEffect`, hooks, lifecycle methods, class components, or `react`/`react-dom` imports. Railroad is its own JSX runtime via `jsxImportSource`.
2. **No external bundler.** Don't add Vite, esbuild config, or webpack. Bun's HTML imports + `bun build` cover the entire pipeline. For project setup, use the `bun-route` skill.
3. **No `.get()` in JSX children.** See section 1.
4. **No shared DOM nodes across `when()` branches.** Each branch creates fresh nodes.
5. **No effects at module top-level** unless you manually capture and dispose. See section 4.
6. **No `transition-all` in CSS** near layout boundaries — use specific properties.
