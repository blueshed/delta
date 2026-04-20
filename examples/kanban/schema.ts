/**
 * Kanban schema — three collections in a parent chain.
 *
 *   kanban_boards   (root)
 *   kanban_columns  parent: kanban_boards  → FK kanban_boards_id
 *   kanban_cards    parent: kanban_columns → FK kanban_columns_id
 *
 * `generateSql(schema, docs)` produces the CREATE TABLE / CREATE SEQUENCE
 * statements AND the `_delta_collections` + `_delta_docs` metadata inserts.
 * Once that SQL is applied, the framework's `delta_open("board:1")` composes
 * the full nested document by walking parent_fk relationships via
 * `_delta_load_collection`, and `delta_apply("board:1", ops)` mutates the
 * right table per op path. No hand-written SQL in this example.
 */
import { defineSchema, defineDoc } from "../../src/server/postgres";

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
 * cards included. The framework's `delta_open` reads the root row, then
 * walks the parent chain to pull in the two-hop `kanban_cards` filtered
 * by column ids belonging to this board.
 */
export const docs = [
  defineDoc("board:", {
    root: "kanban_boards",
    include: ["kanban_columns", "kanban_cards"],
    scope: { id: ":id" },   // single-mode: scope the root by the {id} in the doc name
  }),
];
