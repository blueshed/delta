# Document shapes

From `tests/local.test.ts`: a room and its messages, there before anyone writes.

```ts
const schema = defineSchema({
  rooms: { columns: { topic: "text?" }, temporal: false },
  messages: { parent: "rooms", columns: { text: "text" }, temporal: false },
});
const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });
// open "room:a" → { rooms: { id: "a", topic: null }, messages: {} }, and no row made
```

`DocDef` in `src/schema.ts` is the contract. Name and scope rules: `scope.md`.

## The shapes

- **List**: `defineDoc("items:", { root: "items", include: [] })`; `items:` opens every row,
  `{ items: { "1": {…}, "2": {…} } }`.
- **Catalog**: a list root with includes, each loaded **in full** (list mode has no root id to
  filter by): `defineDoc("catalog:", { root: "products", include: ["parts", "faces"] })`, for
  collections read side by side.
- **Single**: `board:1` is one root row; each include travels its `parent` chain to that root.

## The parent chain

- An include reaches the root through its parents, whether or not the document includes the
  parents: `wedding:` with `include: ["drinks"]` (drinks under courses under weddings) holds its
  wedding's drinks, and may add one only under its own courses (another's is 404).
- A chain that meets a collection with no `parent` never reaches the root: a single document
  holds none of it and may not write it (404). Root the document where the chain ends, or list it.
- An included collection with no `parent` at all is a shared reference table: every document of
  the prefix holds all of it.

## Implied documents

`implied: true`: opening a missing root answers `{ id: <name's id>, …column defaults }` and empty
collections, and makes no row. The first write makes the root in the same transaction; a failed
one makes none. A list over the roots is told the row arrived before what was written under it.

- An implied document cannot declare a `scope` (`defineDoc` throws).
- Name it by number (`room:7`) for an app that will move on to Postgres, where `room:attic` is
  400; keep text names (`session:<token>`) for documents that never move.
- Its root removed, it opens empty again; an open copy is told that empty root, not null.
- A document that is not implied answers 404 for a missing root.

## Some columns

```ts
const tripMap = defineDoc("trip-map:", { root: "trips", include: ["legs", "stops"],
  columns: { legs: ["day", "from", "to"], stops: ["name", "lat", "lng"] } });
```

Holds, of each collection named, those columns plus the id and the parent key; others whole.

- It opens, is told and writes by those alone: a write of another column tells it nothing; one
  written through it is 400.
- A row replaced through it keeps the columns it does not hold. An add gives them defaults, so a
  required column it does not hold cannot be added through it (400).
- The ledger keeps rows whole: undo through it puts every column back, but its answers and
  `history` show its columns alone.
- A column its collection lacks is thrown at registration.
