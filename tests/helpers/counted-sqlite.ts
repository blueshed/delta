/**
 * A database file opened through the system's libsqlite3 (bun:ffi), shaped as
 * much of bun:sqlite's Database as the ledger uses (`run`, `query` → `get` /
 * `all` / `run`), so a test can read what SQLite itself counts of each
 * statement it runs: `sqlite3_stmt_status`, which bun:sqlite does not expose.
 * `steps()` is the virtual machine's steps over every statement prepared here
 * (what a lookup costs, read by SQLite), `fullScans()` the steps of full table
 * scans among them.
 */
import { CString, dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

const { symbols: sqlite } = dlopen(process.platform === "darwin" ? "/usr/lib/libsqlite3.dylib" : "libsqlite3.so.0", {
  sqlite3_open: { args: [FFIType.cstring, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_close_v2: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_errmsg: { args: [FFIType.ptr], returns: FFIType.cstring },
  sqlite3_prepare_v2: { args: [FFIType.ptr, FFIType.cstring, FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  sqlite3_bind_int64: { args: [FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  sqlite3_bind_double: { args: [FFIType.ptr, FFIType.i32, FFIType.f64], returns: FFIType.i32 },
  sqlite3_bind_text: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
  sqlite3_bind_null: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  sqlite3_step: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_reset: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_clear_bindings: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_finalize: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_column_count: { args: [FFIType.ptr], returns: FFIType.i32 },
  sqlite3_column_name: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.cstring },
  sqlite3_column_type: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  sqlite3_column_int64: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i64 },
  sqlite3_column_double: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.f64 },
  sqlite3_column_text: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.ptr },
  sqlite3_last_insert_rowid: { args: [FFIType.ptr], returns: FFIType.i64 },
  sqlite3_stmt_status: { args: [FFIType.ptr, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

const ROW = 100, DONE = 101, TRANSIENT = -1;
const FULLSCAN_STEP = 1, VM_STEP = 4;
const cstr = (s: string) => Buffer.from(s + "\0");

export function openCounted(file: string) {
  const out = new BigUint64Array(1);
  if (sqlite.sqlite3_open(cstr(file), ptr(out)) !== 0) throw new Error(`cannot open ${file}`);
  const db = read.ptr(ptr(out)) as Pointer;
  const fail = (): never => { throw new Error(String(sqlite.sqlite3_errmsg(db))); };
  const prepared: Pointer[] = [];

  const prepare = (sql: string): Pointer => {
    if (sqlite.sqlite3_prepare_v2(db, cstr(sql), -1, ptr(out), null) !== 0) fail();
    const stmt = read.ptr(ptr(out)) as Pointer;
    prepared.push(stmt);
    return stmt;
  };
  const rows = (stmt: Pointer, params: unknown[]): Record<string, unknown>[] => {
    sqlite.sqlite3_reset(stmt);
    sqlite.sqlite3_clear_bindings(stmt);
    params.forEach((p, i) => {
      if (p === null || p === undefined) sqlite.sqlite3_bind_null(stmt, i + 1);
      else if (typeof p === "number" && Number.isInteger(p)) sqlite.sqlite3_bind_int64(stmt, i + 1, p);
      else if (typeof p === "number") sqlite.sqlite3_bind_double(stmt, i + 1, p);
      else { const text = Buffer.from(String(p)); sqlite.sqlite3_bind_text(stmt, i + 1, text.length ? ptr(text) : null, text.length, TRANSIENT); }
    });
    const found: Record<string, unknown>[] = [];
    for (let rc = sqlite.sqlite3_step(stmt); rc !== DONE; rc = sqlite.sqlite3_step(stmt)) {
      if (rc !== ROW) fail();
      const row: Record<string, unknown> = {};
      for (let c = 0; c < sqlite.sqlite3_column_count(stmt); c++) {
        const type = sqlite.sqlite3_column_type(stmt, c);
        row[String(sqlite.sqlite3_column_name(stmt, c))] =
          type === 1 ? Number(sqlite.sqlite3_column_int64(stmt, c))
          : type === 2 ? sqlite.sqlite3_column_double(stmt, c)
          : type === 5 ? null
          : new CString(sqlite.sqlite3_column_text(stmt, c)!).toString();
      }
      found.push(row);
    }
    sqlite.sqlite3_reset(stmt);
    return found;
  };
  const count = (op: number) => prepared.reduce((n, stmt) => n + sqlite.sqlite3_stmt_status(stmt, op, 0), 0);

  return {
    run(sql: string, ...params: unknown[]) {
      rows(prepare(sql), params);
      return { lastInsertRowid: Number(sqlite.sqlite3_last_insert_rowid(db)) };
    },
    query(sql: string) {
      const stmt = prepare(sql);
      return {
        get: (...params: unknown[]) => rows(stmt, params)[0] ?? null,
        all: (...params: unknown[]) => rows(stmt, params),
        run: (...params: unknown[]) => { rows(stmt, params); return { lastInsertRowid: Number(sqlite.sqlite3_last_insert_rowid(db)) }; },
      };
    },
    /** The virtual machine's steps, over every statement prepared here: SQLite's own count of the work done. */
    steps: () => count(VM_STEP),
    /** Steps of full table scans, over every statement prepared here. */
    fullScans: () => count(FULLSCAN_STEP),
    close() {
      for (const stmt of prepared) sqlite.sqlite3_finalize(stmt);
      sqlite.sqlite3_close_v2(db);
    },
  };
}
