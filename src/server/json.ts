/**
 * @blueshed/delta/json — the app's rows in one JSON file.
 *
 * The first place on the path: the same schema, the same documents, the same
 * writes as SQLite and Postgres, with the truth kept in a file you can read
 * and edit by hand. Swap it for SQLite, then Postgres in process, then a
 * Postgres server, and the app does not change -- only where its truth lives.
 *
 *   importTables("./data.json", schema, seed);         // once, to start it
 *   const store = registerDocs(ws, "./data.json", schema, docs, [], { ledger: true });
 *
 * The file is `{ tables, sequences, ledger }`: every row by collection (every
 * version of a temporal row), the last id each collection has minted, and the
 * ledger, so undo carries across a restart. Its rows are what
 * `exportTables` gives; moving on is `sqlite.importTables(db, schema,
 * json.exportTables(file, schema))`.
 *
 * The engine is SQLite in memory, loaded from the file at start and written
 * back to it after every change -- so the file behaves as SQLite does, by
 * construction. One process owns the file.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { WsServer } from "./server";
import type { DocDef, Schema, Snapshot } from "../schema";
import {
  createTables,
  exportTables as exportSqlite,
  importTables as importSqlite,
  registerDocs as registerSqlite,
  type CustomDocDef,
  type RegisterOptions,
} from "./sqlite";

export type { Snapshot } from "../schema";

/** The file: the rows and sequences, and the ledger's rows. */
type Saved = Snapshot & { ledger?: { entries: Record<string, unknown>[]; versions: Record<string, unknown>[] } };

function read(file: string): Saved {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Saved) : { tables: {}, sequences: {} };
}

/** Every row the file holds, and each collection's last minted id. */
export function exportTables(file: string, _schema: Schema): Snapshot {
  const { tables, sequences } = read(file);
  return { tables, sequences: sequences ?? {} };
}

/** Write a snapshot's rows into the file (it starts as that). */
export function importTables(file: string, _schema: Schema, snapshot: Snapshot): void {
  writeFileSync(file, JSON.stringify({ tables: snapshot.tables, sequences: snapshot.sequences ?? {} }, null, 2));
}

/**
 * Serve the schema's documents from the file: as SQLite's `registerDocs`, with
 * the file in place of the database. `persisted()` resolves once every change
 * so far is in the file.
 */
export function registerDocs(
  ws: WsServer,
  file: string,
  schema: Schema,
  docs: DocDef[],
  customDocs: CustomDocDef<any>[] = [],
  options: Omit<RegisterOptions, "committed"> = {},
) {
  const db = new Database(":memory:");
  createTables(db, schema);
  const saved = read(file);
  importSqlite(db, schema, saved);

  let saving: Promise<void> = Promise.resolve();
  const save = () => {
    const snapshot: Saved = exportSqlite(db, schema);
    if (options.ledger) {
      snapshot.ledger = {
        entries: db.query("SELECT * FROM delta_ledger ORDER BY id").all() as Record<string, unknown>[],
        versions: db.query("SELECT * FROM delta_versions ORDER BY doc").all() as Record<string, unknown>[],
      };
    }
    const text = JSON.stringify(snapshot, null, 2);
    saving = saving.then(() => Bun.write(file, text)).then(() => {});
  };

  const handle = registerSqlite(ws, db, schema, docs, customDocs, { ...options, committed: save });

  // the ledger as it was left: undo carries across a restart
  if (options.ledger && saved.ledger) {
    for (const [table, rows] of [["delta_ledger", saved.ledger.entries], ["delta_versions", saved.ledger.versions]] as const) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, Object.values(row) as any[]);
      }
    }
  }

  return { ...handle, persisted: () => saving };
}
