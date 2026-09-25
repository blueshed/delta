/**
 * @blueshed/delta/pglite — Postgres in this process.
 *
 * The same stored functions, the same listener, the same documents as a
 * Postgres server, on PGlite (Postgres compiled to WASM): no database to run,
 * the data in a directory (or in memory). `openPglite()` answers the slice of
 * `pg`'s Pool delta uses, so everything in `@blueshed/delta/postgres` runs on
 * it unchanged:
 *
 *   const pool = await openPglite("./data");        // or openPglite() in memory
 *   await applyFramework(pool);
 *   await applySql(pool, generateSql(schema, docs));
 *   for (const def of docs) registerDocType(docTypeFromDef(def, pool));
 *   await createDocListener(ws, pool, { ledger: true });
 *
 * Outgrow it and move to a server: `exportTables(pool, schema)` here,
 * `importTables(server, schema, rows)` there -- the ids and sequences carry.
 * One process owns the directory. Taken from epsilon's `pglite.ts`.
 *
 * Optional, like `pg`: `bun add @electric-sql/pglite` to use it.
 */
import type { Pool } from "pg";

/** The slice of PGlite this drives (structural: no hard import). */
interface PGliteish {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  exec(text: string): Promise<{ rows: any[] }[]>;
  transaction<T>(fn: (tx: { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; exec(text: string): Promise<{ rows: any[] }[]> }) => Promise<T>): Promise<T>;
  listen(channel: string, callback: (payload: string) => void): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

type Runner = Pick<PGliteish, "query" | "exec">;
type Result = { rows: any[]; rowCount: number };

/** pg sends a JS object or array as JSON; PGlite binds by type, so give it the JSON text. */
const bind = (v: unknown): unknown => (v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v);

/** One statement with parameters, or several without, as `pg`'s query takes them. */
async function run(on: Runner, text: string, params?: unknown[]): Promise<Result> {
  if (params?.length) {
    const { rows } = await on.query(text, params.map(bind));
    return { rows, rowCount: rows.length };
  }
  const results = await on.exec(text);
  const rows = results[results.length - 1]?.rows ?? [];
  return { rows, rowCount: rows.length };
}

const verb = (text: string) => text.trim().replace(/;$/, "").toUpperCase();

/**
 * Wrap a PGlite instance in the Pool delta uses. PGlite is one session: a
 * client's `BEGIN` opens a PGlite transaction and holds it until `COMMIT` or
 * `ROLLBACK`, and every other query waits for it (PGlite runs queries and
 * transactions under one lock), so nothing lands inside another's
 * transaction. `LISTEN` on a client is PGlite's `listen`, its payloads the
 * client's `notification` events.
 */
export function pglitePool(db: PGliteish): Pool {
  function connect() {
    const handlers = new Set<(msg: { channel: string; payload: string }) => void>();
    const unlisten: (() => Promise<void>)[] = [];
    // The open transaction, if any: its queries, and how to end it.
    let tx: { on: Runner; end: (commit: boolean) => void; done: Promise<unknown> } | null = null;

    const client = {
      async query(text: string, params?: unknown[]): Promise<Result> {
        const v = verb(text);
        if (v === "BEGIN") {
          if (tx) throw new Error("a transaction is already open on this client");
          let opened!: (on: Runner) => void;
          const ready = new Promise<Runner>((r) => (opened = r));
          let end!: (commit: boolean) => void;
          const ended = new Promise<boolean>((r) => (end = r));
          const done = db.transaction(async (t) => {
            opened(t);
            if (!(await ended)) throw new Rollback();
          }).catch((err) => { if (!(err instanceof Rollback)) throw err; });
          tx = { on: await ready, end, done };
          return { rows: [], rowCount: 0 };
        }
        if (v === "COMMIT" || v === "ROLLBACK") {
          const open = tx;
          tx = null;
          if (!open) return { rows: [], rowCount: 0 };
          open.end(v === "COMMIT");
          await open.done;
          return { rows: [], rowCount: 0 };
        }
        const listen = /^LISTEN\s+"?([\w.]+)"?$/.exec(v);
        if (listen) {
          const channel = text.trim().replace(/;$/, "").split(/\s+/)[1]!.replace(/"/g, "");
          unlisten.push(await db.listen(channel, (payload) => { for (const h of handlers) h({ channel, payload }); }));
          return { rows: [], rowCount: 0 };
        }
        if (v.startsWith("UNLISTEN")) {
          for (const off of unlisten.splice(0)) await off();
          return { rows: [], rowCount: 0 };
        }
        return run(tx ? tx.on : db, text, params);
      },
      on(event: string, handler: (msg: any) => void) {
        if (event === "notification") handlers.add(handler);
        return client;
      },
      removeListener(event: string, handler: (msg: any) => void) {
        if (event === "notification") handlers.delete(handler);
        return client;
      },
      release() {
        // A client let go inside a transaction rolls it back, as pg's would be reset.
        if (tx) { tx.end(false); tx = null; }
      },
    };
    return client;
  }

  const pool = {
    query: (text: string, params?: unknown[]) => run(db, text, params),
    connect: async () => connect(),
    end: () => db.close(),
    on: () => pool,
  };
  return pool as unknown as Pool;
}

class Rollback extends Error {}

/**
 * Open (or create) an in-process Postgres: in `dir`, or in memory when none
 * is given, as the Pool delta's Postgres backend takes.
 */
export async function openPglite(dir?: string): Promise<Pool> {
  let PGlite: any;
  try {
    ({ PGlite } = await import("@electric-sql/pglite"));
  } catch {
    throw new Error("[delta/pglite] @electric-sql/pglite is not installed -- bun add @electric-sql/pglite");
  }
  const db: PGliteish = dir ? await PGlite.create(dir) : await PGlite.create();
  return pglitePool(db);
}
