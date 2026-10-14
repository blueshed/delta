# Schema

`examples/kanban/schema.ts`: three tables in a parent chain, and the one document over them.

```ts
import { defineSchema, defineDoc } from "@blueshed/delta/postgres";   // or ./sqlite, ./json

export const schema = defineSchema({
  kanban_boards:  { columns: { owner_id: "integer", title: "text" }, temporal: false },
  kanban_columns: { columns: { owner_id: "integer", title: "text", position: "integer" },
                    parent: "kanban_boards", temporal: false },    // → kanban_boards_id
  kanban_cards:   { columns: { owner_id: "integer", title: "text", position: "integer" },
                    parent: "kanban_columns", temporal: false },   // → kanban_columns_id
});

export const docs = [
  defineDoc("board:", { root: "kanban_boards", include: ["kanban_columns", "kanban_cards"], scope: { id: ":id" } }),
];
```

The contract is `TableDef`, `ColumnDef`, `ColumnShorthand` and `DocDef` in `src/schema.ts`.

## Rules

- Column types: `text`, `integer`, `real`, `boolean`, `json`, `timestamptz`; append `?` for
  nullable, or `{ type, default, nullable }`.
- A column neither nullable nor defaulted is **required**: an add without it is 400 `Required
  field missing`. Give it a default or make it nullable.
- `parent: "lists"` makes the key column `lists_id`; `cascadeOn: ["user_id"]` removes a row when
  the row its key names is removed (`writes.md`).
- `temporal` defaults to true (`valid_from` / `valid_to`, read with `open_at`); rows come back
  without those columns.
- Table names are lowercase snake_case on every backend: `{ prMixed: { table: "pr_mixed", … } }`;
  `"PrMixed"` throws. A keyword (`order`, `from`) is fine: names are quoted.
- A root row added through a list document is given its scope's equality values from the name
  (`scope.md`), so it need not repeat them.

## Validating before a write

```ts
const errors = validateOps(schema, itemsDoc, [{ op: "add", path: "/items/-", value: { name: "a" } }], { doc: "items:" });
```

Give it the name (`{ doc }`) or `{ list, values }`, so it knows single or list mode; given
neither, a root field's replace is taken as single and a root row's add as list. It refuses
what the backend refuses as a mistake (400); a 404, a 409 or a value the column cannot cast is
the database's. The backend runs its own: `sqlite/validate.ts`; Postgres's is exported but the
listener relies on `delta_apply`.

## Postgres tables

Never hand-write them: `generateSql(schema, docs)`, or
`bunx @blueshed/delta sql ./types.ts --out init_db/003-tables.sql`. It makes the tables, the
`seq_<table>` sequences `delta_apply` expects, and the `_delta_collections` / `_delta_docs`
rows (never hand-edit those). Framework SQL is `001a–001g`, auth-jwt `002`, yours `003`
(`postgres.md`).
