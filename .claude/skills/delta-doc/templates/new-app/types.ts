// Single source of truth for the domain. Run `bun run build:sql` after edits
// to regenerate init_db/003-tables.sql.
import { defineSchema, defineDoc } from "@blueshed/delta/postgres";

export const schema = defineSchema({
  // EXAMPLE — replace with the app's own collections.
  todos: {
    columns: {
      owner_id: "integer",
      text: "text",
      done: { type: "boolean", default: false },
    },
    temporal: false,
  },
});

export const docs = [
  // Per-user list: doc name "todos:<userId>" filters by owner_id = <userId>.
  // See per-user template for the matching server-side DocType wrapper.
  defineDoc("todos:", {
    root: "todos",
    include: [],
    scope: { owner_id: ":id" },
  }),
];

export interface Todo {
  id: number;
  owner_id: number;
  text: string;
  done: boolean;
}
