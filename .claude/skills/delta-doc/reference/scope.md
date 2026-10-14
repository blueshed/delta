# Scope: what a document's name selects

From `examples/todos-vs-rls/setup.ts`: one table, a document per owner and one per team.

```ts
export const myTodos = defineDoc("todos-mine:", { root: "todos", include: [], scope: { owner_id: ":id" } });
export const teamTodos = defineDoc("todos-team:", { root: "todos", include: [], scope: { team_id: ":id" } });
// "todos-mine:5" → every todo whose owner_id is 5, keyed by id (list mode);
// an add /todos/- through it takes owner_id 5 from the name, never from the value
```

One rule on every backend: Postgres's `_delta_resolve_scope` (`src/sql/001b-delta-scope.sql`)
and its twin for SQLite and the JSON file (`src/server/scope.ts`).

## The values

`scope` maps a root column to a value read from the name, after the prefix, split on `:`.

- `":id"` (or plain `"id"`: the colon is optional, a plain value is a param, never a literal):
  `col = <param>`. `"=:name"` is the same, explicit.
- `"<=:end"`, `>=`, `<`, `>`, `!=`: a range. `"like:prefix"`: starts with, any case.
- `"at:when"`: the time the document is read at, not a condition (below).
- `id` takes position 1; other names follow alphabetically. `venue-at:42:2026-06-16` has `id=42`
  and the second. An empty value sets no condition.
- Keys must be real columns of the root (`id`, its parent key, its columns): `"items.id"`
  throws (SQLite and JSON at registration, Postgres at open).

## Single or list

- A scope that binds `id`, or no scope and a non-empty id, is **single**: one root row and its
  children. The rest of the scope must hold too (`guest:1:a@x` is household 1 only while its
  email is `a@x`, else 404). Omit `scope` for a plain `WHERE id = <id>`.
- Anything else is **list**: every root row the conditions admit, keyed by id, each included
  collection **in full**. `items:` is every item; `by-status:active` over `{ status: ":id" }` is
  every active row (`:id` names the param, not the row).
- **A list writes only within its scope**: an add gets the equality values and must meet the
  rest (else 404); a replace that would take a root row out of scope is 404 and undone. A single
  document's root is held to its scope the same way.

## How values are read

As the column takes them, on every backend: a boolean's `true`/`yes`/`on`/`1`; an integer's
`05` is 5; a `json` column's value is the JSON it names; `text` stays as written; an id is a
whole number. A `timestamptz` is a date, `YYYY-MM-DD`, midnight UTC (a name's `:` cannot hold a
time). A value the column cannot take (`seats-kept:maybe`) is 400.

## Gotchas

- Write times as ISO 8601 with a zone: a stored time without one is UTC on SQLite and the
  session's `TimeZone` on Postgres. Anything else written is 400.
- **`at:` reads the past**: a temporal table as it stood, the others as they are now. Such a
  document takes no writes (403). It is told only what its time does not keep; a future date reads as now.
- Do not put tenant-sensitive identifiers in a prefix (`tenant-42:`): error messages name
  prefixes (`rls.md`).
