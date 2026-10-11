/** How a table's columns keep a scope's values, so a condition reads by one rule what an add stamps (./scope `Keep`). */
import type { ResolvedTable } from "../../schema";
import { isDay, type Keep } from "../scope";
import { encodeValue, refuse } from "./rows";

/**
 * A scope's value, text from the document's name, as its column takes it -- as
 * Postgres casts the text, for an add's stamping and a condition alike: a
 * boolean as Postgres reads one (true/false, yes/no, on/off and their
 * unambiguous prefixes, 1/0, any case); an integer's digits, signed, up to
 * 2^53 - 1; a real's finite decimal number -- by the grammar Postgres's
 * resolver holds its casts to (`_delta_resolve_scope`, which refuses 1_000,
 * 0x10 and Infinity); a json column's text as the JSON it is; a text as the
 * text; a time's a date, YYYY-MM-DD (the instant midnight UTC begins it);
 * an id or a parent key a whole number, or text (an id SQLite keeps as text).
 * Text the column cannot take is a 400.
 */
export function scopeValue(table: ResolvedTable, col: string, text: string): unknown {
  const t = text.trim();
  switch (Object.hasOwn(table.columns, col) ? table.columns[col]!.type : undefined) {
    case "boolean": {
      const l = t.toLowerCase();
      const prefix = (word: string, least = 1) => l.length >= least && word.startsWith(l);   // "o" is on or off: two letters at least
      if (l === "1" || prefix("true") || prefix("yes") || prefix("on", 2)) return true;
      if (l === "0" || prefix("false") || prefix("no") || prefix("off", 2)) return false;
      return refuse(400, `${col} must be a boolean (true/false, yes/no, on/off, 1/0, or a prefix), not "${text}"`);
    }
    case "integer":
      if (/^[+-]?\d+$/.test(t) && Number.isSafeInteger(Number(t))) return Number(t);
      return refuse(400, `${col} must be an integer, not "${text}"`);
    case "real": {
      // a finite decimal number a double holds, as Postgres's resolver reads it: not Infinity, NaN or 0x10, nor 1e400 or 1e-400
      const n = Number(t);
      if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t) && Number.isFinite(n) && (n !== 0 || !/[1-9]/.test(t.replace(/e.*$/i, "")))) return n;
      return refuse(400, `${col} must be a number, not "${text}"`);
    }
    case "json": try { return JSON.parse(text); } catch { return refuse(400, `${col} must be JSON, not "${text}"`); }
    case "timestamptz": {
      // A date, YYYY-MM-DD -- a name's ":" separates its values, so it holds no time of day -- the instant midnight
      // UTC begins it, as Postgres's resolver reads it; stamped on an add as the text, as a time is stored here.
      if (isDay(t)) return t;
      return refuse(400, `${col} must be a date, YYYY-MM-DD, not "${text}"`);
    }
    case "text": return text;
    default:
      // An id or a parent key, as Postgres's resolver reads one: a whole number, signed (+5, 007 and " 5 " are 5), up
      // to 2^53 - 1; a number not whole is no id (1.5, 1e0 -- the column's affinity would compare it as a number);
      // other text is an id kept as text (a session's token), which on Postgres, where every id is a number, is no row's.
      if (/^[+-]?\d+$/.test(t)) return Number.isSafeInteger(Number(t)) ? Number(t) : refuse(400, `${col} ${text} is past 2^53 - 1, which no number holds exactly`);
      if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return refuse(400, `${col} must be an id -- a whole number, or text -- not "${text}"`);
      return text;
  }
}

/**
 * How a table's columns keep a value (./scope `Keep`): a scope's text as an add
 * is given it (`scopeValue`), then as the column stores it -- a boolean 1 or 0,
 * json as its text -- and a row's value as the column stores it. So a
 * condition reads by one rule what the add stamps: `fo-seats:yes` reads the
 * rows an add through `fo-seats:true` made. A time is stored as the text it was
 * given, in whatever form, so a condition compares the instant each names, as
 * Postgres compares a timestamptz: the name's and the row's alike read by
 * SQLite's own date functions (`instant`), in the SQL and in the fan-out. That
 * reading hides the column from an index, so each such condition is asked
 * first of the bare column (`within`): a time that begins with its date, as
 * ISO 8601 does, is within a day of its instant's (a zone is at most 14:59
 * away), so the rows a date's condition meets lie between the days either
 * side -- a range an index on the column searches, then read exactly.
 */
export function keeping(db: any, table: ResolvedTable): Keep {
  let byTable = keeps.get(db);
  if (!byTable) keeps.set(db, (byTable = new WeakMap()));
  let keep = byTable.get(table);
  if (keep) return keep;
  const time = (col: string) => Object.hasOwn(table.columns, col) && table.columns[col]!.type === "timestamptz";
  // a name's condition is read once, not for each row the fan-out asks it of (a refusal is not kept: it throws again)
  const texts = new Map<string, unknown>();
  const bounds = new Map<string, { from?: string; below?: string } | undefined>();
  const once = <T>(memo: Map<string, T>, key: string, read: () => T): T => {
    if (memo.has(key)) return memo.get(key)!;
    const value = read();
    if (memo.size >= 1_000) memo.clear();
    memo.set(key, value);
    return value;
  };
  keep = {
    text: (col, text) => once(texts, `${col}:${text}`, () => (time(col) ? instant(db, scopeValue(table, col, text)) : encodeValue(table, col, scopeValue(table, col, text)))),
    value: (col, value) => (time(col) ? instant(db, value) : encodeValue(table, col, value)),
    column: (col) => (time(col) ? `strftime('%Y-%m-%d %H:%M:%f', ${col})` : col),
    within: (col, op, text) => {
      if (!time(col) || op === "!=") return undefined;
      return once(bounds, `${col}:${op}:${text}`, () => {
        const day = scopeValue(table, col, text) as string;   // a date, YYYY-MM-DD (or refused)
        return { from: op === "<" || op === "<=" ? undefined : dayAfter(day, -1), below: op === ">" || op === ">=" ? undefined : dayAfter(day, 1) };
      });
    },
  };
  byTable.set(table, keep);
  return keep;
}
const keeps = new WeakMap<object, WeakMap<ResolvedTable, Keep>>();

/** The date `days` from a date, YYYY-MM-DD (years below 100 too, which Date.UTC would read as 19xx); none past year 9999. */
function dayAfter(day: string, days: number): string | undefined {
  const d = new Date(0);
  d.setUTCFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + days);
  const iso = d.toISOString();
  return /^\d{4}-/.test(iso) ? iso.slice(0, 10) : undefined;
}

/**
 * A time as SQLite reads it, "YYYY-MM-DD HH:MM:SS.SSS" in UTC -- the sortable
 * form a row's validity is kept in (`sqliteTime`) -- or null for text it cannot
 * read: its own strftime, as `keeping`'s column is, so the fan-out and the SQL
 * read a stored time alike. Remembered, since the fan-out asks it of each row
 * for each document open (and of a row before and after a write): strftime
 * answers the same text the same way, whichever database asks -- but "now".
 */
const instants = new Map<string, string | null>();
function instant(db: any, value: unknown): string | null {
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (instants.has(text)) return instants.get(text)!;
  const t = (db.query("SELECT strftime('%Y-%m-%d %H:%M:%f', ?) AS t").get(text) as { t: string | null }).t;
  if (/^\s*now\s*$/i.test(text)) return t;
  if (instants.size >= 10_000) instants.clear();
  instants.set(text, t);
  return t;
}
