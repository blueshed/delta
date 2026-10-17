# Rendering a document

With railroad's JSX, from `examples/kanban/client.tsx`: derive the rows, render them keyed.

```tsx
provide(WS, connectWs("/ws"));
const doc = openDoc<BoardDoc>("board:1");

function BoardView(): JSX.Element {
  const columns$ = doc.data.map((d): Column[] =>
    d ? Object.values(d.kanban_columns).sort((a, b) => a.position - b.position) : []);
  return <div class="columns">
    {list<Column>(columns$, (c: Column) => c.id, (c$) => <ColumnView column$={c$} />)}
  </div>;
}

const App = () => when(doc.data, () => <BoardView />, () => <div>connecting…</div>);
document.getElementById("root")!.append(<App />);
```

Without JSX, the recipe's `applyOpsToCollection` (`recipe.md`; `DomCollection` in
`src/client/dom-ops.ts`): one `render(ops)` for the first paint
(`render([{ op: "replace", path: "", value: doc.data.get() }])` after `await doc.ready`), every
`doc.onOps`, and the reconnect's whole-document replace.

## Rules

- **One keyed path per project**: `list()` with JSX, `applyOpsToCollection` without. Never both,
  and never rebuild a collection from `doc.data` inside an `effect`.
- **Derive the rows, not the map**: `doc.data.map((d) => Object.values(d.cards))`. A
  collection's map keeps its identity (changed in place), so `d => d.cards` never sees an add,
  a field change or a removal. A changed row is a fresh object; others keep their reference.
- `doc.data` **is** a railroad signal, `ReadonlySignal<T | null>`: `get`, `peek`, `map`, no `set`.
- **Don't hand-build the first paint** for `applyOpsToCollection`: its id → node map is how
  `remove` finds a node and how the reconnect reconciles. `key` must equal the id in
  `/<coll>/<id>`. Pass your own map (5th argument) only to seed or inspect it, then thread it
  through every call.
- `update` is given the whole row, with a field op applied.
- `doc.data` alone is fine for a small document: one card, no focus to keep, under ~10 rows.

## Opening and closing

- `openDoc` is scope-aware: opened in a railroad dispose scope (a component, a `routes()`
  handler, a `when()` / `list()` render, `mount()`), it closes when the scope goes. Module-level
  opens stay for the life of the page.
- **Never open inside an `effect()` body**: each run is a scope, so it closes and re-opens every
  run. Open in the component or module; read `doc.data` in the effect.
- **In an async component, open inside the returned thunk**, not after an `await` in the body:
  there is no scope after an `await`, and the handle never closes. If you must, `close()` it.
- Repeated `openDoc(name)` on one client share one entry (the same signals), refcounted;
  `doc.close()` releases one, and the last sends the server `close`.
- `openDoc(name, client?)`: browser code finds the client by `inject(WS)`; pass one explicitly
  for several clients in one process (`testing.md`).
- railroad's own skill has the JSX gotchas (no `.get()` in children, keys, dispose scopes).
- In an eta app the page never opens a document: the server draws it from delta's documents and
  the client morphs it; an island (a railroad component) is handed its document's ops by eta.
  eta's own skill (`eta-app`) has that.
