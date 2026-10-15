/**
 * Kanban schema — three collections in a parent chain.
 *
 *   kanban_boards   (root)
 *   kanban_columns  parent: kanban_boards  → FK kanban_boards_id
 *   kanban_cards    parent: kanban_columns → FK kanban_columns_id
 *
 * `createTables(db, schema)` makes the tables in SQLite; `registerDocs` then
 * opens `board:1` by walking the parent keys down from the board, and applies
 * each op to the table its path names. No hand-written SQL in this example.
 * (On Postgres the same schema and documents run on dzql: `dzql/postgres`.)
 */
import { defineSchema, defineDoc } from "../../src/server/sqlite";

export const schema = defineSchema({
  kanban_boards: {
    columns: {
      owner_id: "integer",
      title:    "text",
    },
    temporal: false,
  },
  kanban_columns: {
    columns: {
      owner_id: "integer",
      title:    "text",
      position: "integer",
    },
    parent:   "kanban_boards",   // → kanban_boards_id FK
    temporal: false,
  },
  kanban_cards: {
    columns: {
      owner_id: "integer",
      title:    "text",
      position: "integer",
    },
    parent:   "kanban_columns",  // → kanban_columns_id FK (two hops from board)
    temporal: false,
  },
});

/**
 * The doc: `board:<id>`. Scoped-single — one board with its columns and
 * cards included: the root row, then the parent chain down to the two-hop
 * `kanban_cards` of this board's columns.
 */
export const docs = [
  defineDoc("board:", {
    root: "kanban_boards",
    include: ["kanban_columns", "kanban_cards"],
    scope: { id: ":id" },   // single-mode: scope the root by the {id} in the doc name
  }),
];
