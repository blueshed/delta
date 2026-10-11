---
name: railroad
metadata:
  version: 0.16.0
description: "Railroad — reactive UI for the Bun fullstack runtime. Signals, JSX, hash router, DI, logger. Use when writing JSX with signals, when()/list()/routes(), or any import from @blueshed/railroad. Pair with @blueshed/delta for WebSocket document sync."
---

Railroad is the reactive layer for the Bun 1.3 fullstack pipeline. For scaffolding routes, server entries or `Bun.WebView` tests, use the `bun-route` skill: it detects `@blueshed/railroad` in `package.json` and scaffolds in its TSX mode. This skill is the checklist of what bites in railroad code.

Each source file's JSDoc header is the contract: `signals.ts` · `jsx.ts` · `routes.ts` · `shared.ts` · `logger.ts`.

Read `${CLAUDE_SKILL_DIR}/reference.md` for the full manual: setup, every API, realtime, testing, DI and the logger. Each rule below has its reasons and edge cases in reference.md › *The nine mistakes, in full*, under the same number.

There is no global `JSX` namespace. Annotate with `import type { JSX } from "@blueshed/railroad"`.

## The nine things that bite

### 1. Don't `.get()` in JSX or in a render body

```tsx
// ❌ Reads once, never updates
<span>{count.get()}</span>

// ✅ Bind the signal, or derive from it
<span>{count}</span>
<span>{() => count.get() > 5 ? "High" : "Low"}</span>
```

A component body, a `when()` branch, a `list()` row, a route handler and `mount()`'s render all run once and untracked. A `.get()` there subscribes nothing, and railroad warns in development. Use `.peek()` when a one-shot read is what you mean. A function child must return text, not a Node: use `when()` for an element and `list()` for a collection.

### 2. `list()` rows are `Signal<T>`, not `T`

```tsx
// ❌ Destructuring reads the value once
{list(rows, r => r.id, ({ text }) => <li>{text}</li>)}

// ✅ Derive from the row signal
{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}
```

Key by a unique, stable id. For rows changed in place by `.touch()`, add `{ equals: () => false }` as the fourth argument.

### 3. SVG tags need no help, except four shared with HTML

`circle`, `g`, `path`, `linearGradient`, `foreignObject` and the rest are created in the SVG namespace wherever they appear. `a`, `script`, `style` and `title` are created as HTML and adopted when placed inside `<svg>`. On that path, use `on*` props: hand-attached listeners are lost.

### 4. Effects auto-dispose only inside a parent scope

```tsx
// ❌ Module top level: never disposed
effect(() => console.log(c.get()));

// ✅ Inside a component, route handler, when(), list() or mount()
function Counter() {
  const c = signal(0);
  effect(() => console.log(c.get()));
  return <span>{c}</span>;
}
```

Every effect run owns what its body creates, so anything that must outlive a run is created outside the body. Keep the disposer of any top-level effect.

### 5. For large documents, mutate in place and `touch()`

```tsx
// ❌ Clones the whole document on every patch
doc.set({ ...doc.peek(), ...applyPatch(doc.peek(), patch) });

// ✅ Mutate, then notify (applyPatch is any JSON-Patch applier that mutates)
applyPatch(doc.peek(), patch);
doc.touch();
```

`.mutate(fn)` clones, mutates and notifies, so it is the safer middle ground. A computed that returns the same reference bails, so project to fresh values.

### 6. Handlers are lowercase functions

```tsx
// ❌ React's casing; a call at render; a Signal (handlers are not reactive)
<button onClick={inc}>+</button>
<button onclick={inc()}>+</button>
<button onclick={count}>+</button>

// ✅
<button onclick={() => count.update(n => n + 1)}>+</button>
```

Use `oninput` for every keystroke. `onchange` on a text input fires on commit.

### 7. A changing-length array needs `list()`

```tsx
// ❌ Baked in once; won't update when rows changes
<ul>{rows.peek().map(r => <li>{r.text}</li>)}</ul>

// ✅ Keyed, reactive
<ul>{list(rows, r => r.id, (row$) => <li>{row$.map(r => r.text)}</li>)}</ul>
```

A plain `.map()` is fine for a static array, such as a constant list of columns.

### 8. Async components resolve to a thunk

```tsx
// ❌ Bare Node after an await: a console error, nothing renders
async function Profile() {
  const user = await fetchUser();
  return <div>{user.name}</div>;
}

// ✅ The () => is the whole contract
async function Profile() {
  const user = await fetchUser();
  return () => <div>{user.name}</div>;
}
<Profile fallback={() => <p>loading…</p>} />
```

`effect(async () => …)` is an error. Start the async work from the effect and write the result to a signal. Async `routes()` handlers resolve to a thunk too; a bare Node gets the same console error. For streaming or multi-stage states, use an effect that writes a signal, shown with `when()`.

### 9. What a render reads, it reads once

`when()` rebuilds its branch only when the condition's **truthiness** flips. A route handler runs once per **pattern**.

```tsx
// ❌ /sites/42 → /sites/99 still shows site 42
{when(detail, () => <SiteDetail id={detail.get()!.id} />)}
// ✅ d$ is the current value
{when(detail, (d$) => <SiteDetail id={d$.map(d => d.id)} />)}

// ❌ /users/1 → /users/2 still shows user 1
routes(app, { "/users/:id": ({ id }) => <h1>user {id}</h1> });
// ✅ Read the id through params$, or mark the route keyed: true
routes(app, { "/users/:id": (_, params$) => <h1>user {params$.map(p => p.id)}</h1> });
```

## Routes

- **Declaration order.** The first match wins, so declare `/users/new` before `/users/:id`.
- **Segments only.** There is no query-string handling: split `?` off yourself.
- **A trailing slash is a segment.** `/users/42/` does not match `/users/:id`.
- **`navigate()` is synchronous.** Setting `location.hash` yourself, or following a `#/…` link, lands on the next `hashchange`, a macrotask later.

Wildcard layouts, `{ onError }` error boundaries and the rest are in reference.md › *Routes*.

## Realtime: pair with `@blueshed/delta`

For WebSocket document sync over JSON-Patch, use [`@blueshed/delta`](https://www.npmjs.com/package/@blueshed/delta). Its `openDoc()` returns a `Doc<T>` whose `data` **is** a railroad `ReadonlySignal<T | null>`, so it drops into JSX, `when()` and `list()` with no glue. It is read-only: change the document with `doc.send(ops)`, never `doc.data.set()`.

```tsx
import { provide, list, when } from "@blueshed/railroad";
import { connectWs, WS, openDoc } from "@blueshed/delta/client";

provide(WS, connectWs("/ws"));

interface Column { id: number; title: string }
interface Card { id: number; title: string; column_id: number }
interface BoardDoc { columns: Record<string, Column>; cards: Record<string, Card> }

const doc = openDoc<BoardDoc>("board:1");   // outside any effect body

function Board() {
  // doc.data is ReadonlySignal<BoardDoc | null>. .map() derives the card list;
  // list() keeps DOM identity per card.id, so only a changed card's row updates.
  const cards = doc.data.map((d) => d ? Object.values(d.cards) : []);
  return (
    <div>
      {when(doc.data, () => (
        <ul>{list(cards, (c) => c.id, (card$) => <li>{card$.map((c) => c.title)}</li>)}</ul>
      ), () => <p>loading…</p>)}
    </div>
  );
}

// Ops are JSON-Patch on the document: name the new card's key, and give it the id list() keys by.
await doc.send([{ op: "add", path: "/cards/7",
  value: { id: 7, column_id: 1, title: "new card" } }]);
```

Delta also ships `applyOpsToCollection` (`@blueshed/delta/dom-ops`) for vanilla DOM. With railroad in the project, use `list()` instead. The two overlap, so pick one:

| Project shape | Use |
|---|---|
| Vanilla DOM, no railroad | `applyOpsToCollection(parent, "coll", ops, { create, update })` |
| Railroad in deps | `list(doc.data.map(d => Object.values(d.coll)), r => r.id, (r$) => …)` |

The `delta-doc` skill, installed with `@blueshed/delta`, has the full API and backends. The server side is in reference.md › *Realtime*.

## One copy of railroad per page

Two copies (usually a `file:` link or `bun link` to a delta checkout) can't see each other's signals, scopes or providers: the UI stops updating, `inject(WS)` finds no provider, `openDoc()` never auto-closes. Railroad logs `A second copy of @blueshed/railroad has loaded (…)`. The fix (install a packed tarball) is in reference.md › *Local development across repos*.

## Don't

- **Use React.** No hooks, lifecycle methods, class components, or `react`/`react-dom` imports. Railroad is its own JSX runtime, selected by `jsxImportSource`.
- **Add an external bundler.** Bun's HTML imports and `bun build` cover the pipeline. For project setup, use `bun-route`.
- **Share DOM nodes across `when()` branches.** Each branch builds its own.
