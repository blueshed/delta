/**
 * What every backend's `migrate` answers alike, for a history from empty (`../server/changes.ts`, the
 * Django way): SQLite's in delta, Postgres's in dzql. A new database is made by running every
 * migration from the first, and nothing runs twice; one made the older way (the schema's tables at
 * start-up, rows in them) adopts the history; a migration's changes and its data run in one
 * transaction, and fail together; renames keep values and rows, drops take them; and the definitions
 * saying more than the history is reported.
 *
 *   migrationCases("sqlite", { open, migrate, columns, query, makeTables });
 */
import { describe, expect, test } from "bun:test";
import { addColumn, createTable, dropColumn, dropTable, renameColumn, renameTable } from "../server/changes";
import type { MigrateOptions, MigrateResult, Migration } from "../server/migrate";
import { defineSchema, type Schema } from "../schema";

/** A backend, as the cases ask it: a fresh database each `open`. */
export interface MigrationBackend<H> {
  open(): Promise<H>;
  migrate(h: H, list: Migration[], options?: MigrateOptions): Promise<MigrateResult>;
  /** The table's columns, in order. */
  columns(h: H, table: string): Promise<string[]>;
  /** Runs SQL both backends speak alike; its rows. */
  query(h: H, sql: string): Promise<Record<string, unknown>[]>;
  /** The schema's tables made the older way (createTables / generateSql at start-up). */
  makeTables(h: H, schema: Schema): Promise<void>;
  /** In a migration's `up`: SQL on the transaction it is given. */
  run(tx: unknown, sql: string): Promise<void>;
}

const history: Migration[] = [
  { id: "001-people", changes: [createTable("people", { columns: { name: "text" }, temporal: false })] },
  { id: "002-posts", changes: [createTable("posts", { parent: "people", columns: { title: "text", body: "text?" }, temporal: false })] },
];
const schema = defineSchema({
  people: { columns: { name: "text" }, temporal: false },
  posts: { parent: "people", columns: { title: "text", body: "text?" }, temporal: false },
});

export function migrationCases<H>(name: string, b: MigrationBackend<H>) {
  describe(`${name}: migrate, a history from empty`, () => {
    test("a new database is made by every migration from the first; then nothing runs again", async () => {
      const h = await b.open();
      expect(await b.migrate(h, history, { schema })).toEqual({ ran: ["001-people", "002-posts"], fresh: false, unknown: [], drift: [] });
      expect(await b.columns(h, "posts")).toEqual(["id", "people_id", "title", "body"]);
      expect(await b.migrate(h, history, { schema })).toEqual({ ran: [], fresh: false, unknown: [], drift: [] });
    });

    test("a database made the older way, rows in it, adopts the history: each recorded as run, none run", async () => {
      const h = await b.open();
      await b.makeTables(h, schema);
      await b.query(h, "INSERT INTO people (id, name) VALUES (1, 'Ann')");
      expect(await b.migrate(h, history, { schema })).toEqual({ ran: [], fresh: true, unknown: [], drift: [] });
      expect(await b.query(h, "SELECT name FROM people")).toEqual([{ name: "Ann" }]);
    });

    test("a migration's changes and its data run together, and fail together", async () => {
      const h = await b.open();
      await b.migrate(h, history);
      await b.query(h, "INSERT INTO people (id, name) VALUES (1, 'Ann')");
      const filled: Migration[] = [...history, { id: "003-short", changes: [addColumn("people", "short", "text?")], up: (tx) => b.run(tx, "UPDATE people SET short = name") }];
      expect((await b.migrate(h, filled)).ran).toEqual(["003-short"]);
      expect(await b.query(h, "SELECT short FROM people")).toEqual([{ short: "Ann" }]);
      const broken: Migration[] = [...filled, { id: "004-broken", changes: [addColumn("people", "nick", "text?")], up: () => { throw new Error("no"); } }];
      await expect(b.migrate(h, broken)).rejects.toThrow("004-broken failed, and was rolled back: no");
      expect(await b.columns(h, "people")).not.toContain("nick");
    });

    test("a column renamed keeps its values, a table renamed its rows; a column and a table dropped are gone", async () => {
      const h = await b.open();
      await b.migrate(h, history);
      await b.query(h, "INSERT INTO people (id, name) VALUES (1, 'Ann')");
      await b.query(h, "INSERT INTO posts (id, people_id, title) VALUES (1, 1, 'Hi')");
      const moved: Migration[] = [...history,
        { id: "003-rename", changes: [renameColumn("people", "name", "full_name"), renameTable("posts", "notes")] },
        { id: "004-drop", changes: [dropColumn("notes", "body"), createTable("tags", { columns: { label: "text" }, temporal: false }), dropTable("tags")] },
      ];
      expect((await b.migrate(h, moved)).ran).toEqual(["003-rename", "004-drop"]);
      expect(await b.query(h, "SELECT full_name FROM people")).toEqual([{ full_name: "Ann" }]);
      expect(await b.query(h, "SELECT title FROM notes")).toEqual([{ title: "Hi" }]);
      expect(await b.columns(h, "notes")).toEqual(["id", "people_id", "title"]);
    });

    test("a temporal table made from empty keeps versions: its validity columns", async () => {
      const h = await b.open();
      await b.migrate(h, [{ id: "001-notes", changes: [createTable("notes", { columns: { text: "text" } })] }]);
      expect(await b.columns(h, "notes")).toEqual(["id", "text", "valid_from", "valid_to"]);
    });

    test("the definitions saying more than the history is reported, as the next migration's changes", async () => {
      const h = await b.open();
      const more = defineSchema({ people: { columns: { name: "text", email: "text?" }, temporal: false }, posts: { parent: "people", columns: { title: "text", body: "text?" }, temporal: false } });
      expect((await b.migrate(h, history, { schema: more })).drift).toEqual(["addColumn people.email"]);
    });
  });
}
