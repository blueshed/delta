/**
 * Setup -- the kanban tables in SQLite, seeded with one board.
 *
 * Zero hand-written DDL: `createTables(db, schema)` makes the tables the
 * schema declares, and `importTables` seeds them, the serials past the ids.
 * KANBAN_DB names a file; by default the board lives in memory, fresh each run.
 */
import { Database } from "bun:sqlite";
import { createTables, importTables } from "../../src/server/sqlite";
import { schema } from "./schema";

export const DB_PATH = process.env.KANBAN_DB ?? ":memory:";

/** The database, its tables made and one board seeded: `board:1`, three columns, five cards. */
export function openBoard(): Database {
  const db = new Database(DB_PATH);
  createTables(db, schema);
  for (const t of ["kanban_cards", "kanban_columns", "kanban_boards"]) db.run(`DELETE FROM ${t}`);   // each run starts afresh
  importTables(db, schema, {
    tables: {
      kanban_boards: [{ id: 1, owner_id: 1, title: "Product roadmap" }],
      kanban_columns: [
        { id: 1, kanban_boards_id: 1, owner_id: 1, title: "Todo", position: 0 },
        { id: 2, kanban_boards_id: 1, owner_id: 1, title: "In progress", position: 1 },
        { id: 3, kanban_boards_id: 1, owner_id: 1, title: "Done", position: 2 },
      ],
      kanban_cards: [
        { id: 1, kanban_columns_id: 1, owner_id: 1, title: "write the kanban example", position: 0 },
        { id: 2, kanban_columns_id: 1, owner_id: 1, title: "sketch 0.4 roadmap", position: 1 },
        { id: 3, kanban_columns_id: 2, owner_id: 1, title: "review RLS policy", position: 0 },
        { id: 4, kanban_columns_id: 3, owner_id: 1, title: "ship v0.3.0", position: 0 },
        { id: 5, kanban_columns_id: 3, owner_id: 1, title: "capture bench results", position: 1 },
      ],
    },
  });
  return db;
}
