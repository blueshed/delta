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
 * construction. One process owns the file; registrations of it on one server
 * share one database.
 */
import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { clearStaleTemps, readJsonFile, writeFileAtomic, writeFileAtomicSync } from "./file";
import { createLogger } from "./logger";
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
// What an app defines its documents with, from the same import as the backend: moving on changes the path only.
export { defineSchema, defineDoc } from "../schema";
export { defineCustomDoc, type CustomDocDef } from "./sqlite";

/** The file: the rows and sequences, and the ledger's rows. */
type Saved = Snapshot & { ledger?: { entries: Record<string, unknown>[]; versions: Record<string, unknown>[] } };

/**
 * The file: a store with no rows yet when it is not there, 0 bytes, or JSON
 * with no tables (`{}`) -- a newcomer's first file. One that is not JSON (cut
 * short by a crash) is refused by name, and left as it is.
 */
function read(file: string): Saved {
  const saved = existsSync(file) && statSync(file).size === 0 ? undefined : (readJsonFile(file) as Partial<Saved> | null | undefined);
  return { ...saved, tables: saved?.tables ?? {}, sequences: saved?.sequences ?? {} };
}

/** Every row the file holds, and each collection's last minted id. */
export function exportTables(file: string, _schema: Schema): Snapshot {
  const { tables, sequences } = read(file);
  return { tables, sequences };
}

/** Write a snapshot's rows into the file (it starts as that). */
export function importTables(file: string, _schema: Schema, snapshot: Snapshot): void {
  writeFileAtomicSync(file, JSON.stringify({ tables: snapshot.tables, sequences: snapshot.sequences ?? {} }, null, 2));
}

/** The database a file is loaded into, and its saving: one per server and file. */
type Engine = {
  db: Database;
  /** The ledger as the file left it, until a registration that keeps one loads it. */
  unloaded: Saved["ledger"];
  ledger: boolean;
  save(): void;
  saving: Promise<void>;
};

/**
 * Each server's engines, by file: a second `registerDocs` of the file on the
 * server (a public set beside a private one) shares the first's database, so
 * each sees what the other wrote -- an undo through one is guarded by a write
 * through the other (todo #64) -- and one file is saved, not two over each other.
 */
const engines = new WeakMap<WsServer, Map<string, Engine>>();

function engineOf(ws: WsServer, file: string, schema: Schema): Engine {
  const onServer = engines.get(ws) ?? new Map<string, Engine>();
  engines.set(ws, onServer);
  const known = onServer.get(resolve(file));
  if (known) return known;
  const db = new Database(":memory:");
  createTables(db, schema);
  clearStaleTemps(file);
  const saved = read(file);
  importSqlite(db, schema, saved);

  const log = createLogger("[delta-json]");
  const engine: Engine = {
    db, unloaded: saved.ledger, ledger: false, saving: Promise.resolve(),
    save() {
      const snapshot: Saved = exportSqlite(db, schema);
      if (engine.ledger) {
        snapshot.ledger = {
          entries: db.query("SELECT * FROM delta_ledger ORDER BY id").all() as Record<string, unknown>[],
          versions: db.query("SELECT * FROM delta_versions ORDER BY doc").all() as Record<string, unknown>[],
        };
      }
      const text = JSON.stringify(snapshot, null, 2);
      // Whole or not at all: a crash mid-save leaves the last whole file. One that
      // fails is logged, and the next writes the whole file: the chain goes on.
      const done = engine.saving.catch(() => {}).then(() => writeFileAtomic(file, text));
      done.catch((err: any) => log.error(`${file}: save failed: ${err?.message ?? err}`));
      engine.saving = done;
    },
  };
  onServer.set(resolve(file), engine);
  return engine;
}

/**
 * Serve the schema's documents from the file: as SQLite's `registerDocs`, with
 * the file in place of the database. `persisted()` resolves once every change
 * so far is in the file.
 */
export function registerDocs<I = unknown>(
  ws: WsServer,
  file: string,
  schema: Schema,
  docs: DocDef[],
  customDocs: CustomDocDef<any, I>[] = [],
  options: Omit<RegisterOptions<I>, "committed"> = {},
) {
  const engine = engineOf(ws, file, schema);
  const { db } = engine;
  engine.ledger ||= !!options.ledger;
  const handle = registerSqlite<I>(ws, db, schema, docs, customDocs, { ...options, committed: () => engine.save() });

  // the ledger as it was left: undo carries across a restart
  if (options.ledger && engine.unloaded) {
    const { entries, versions } = engine.unloaded;
    engine.unloaded = undefined;
    for (const [table, rows] of [["delta_ledger", entries], ["delta_versions", versions]] as const) {
      for (const row of rows) {
        const cols = Object.keys(row);
        db.run(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, Object.values(row) as any[]);
      }
    }
  }

  return { ...handle, persisted: () => engine.saving };
}
