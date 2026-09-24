/**
 * @blueshed/delta/logger — railroad's logger, kept in step with it.
 *
 * Colored and timestamped on a terminal, plain when piped or with `NO_COLOR`,
 * level-gated; an unknown `LOG_LEVEL` falls back to "info". The code below is
 * `@blueshed/railroad/logger.ts` (0.12.0) as it is, copied rather than
 * imported so a server that doesn't use delta's client needs no railroad;
 * `tests/server.test.ts` fails when the two differ. Re-sync it when railroad's
 * changes.
 *
 *   import { createLogger, setLogLevel, loggedRequest } from "@blueshed/delta/logger";
 *
 *   const log = createLogger("[server]");
 *   log.info("listening on :3000");   // 12:34:56.789 INFO  [server] listening on :3000
 *   setLogLevel("debug");             // show everything
 *   const handler = loggedRequest("[api]", myHandler);  // wrap a route with access logging
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

// A typo'd LOG_LEVEL would otherwise make LEVELS[current] undefined and silence
// every log (including errors), so coerce unknown values back to "info".
function normalizeLevel(level: string | undefined | null): LogLevel {
  return level != null && level in LEVELS ? (level as LogLevel) : "info";
}

// Read env without depending on Bun's ambient global type. This file ships as
// .ts, so a consumer's tsc type-checks it directly — referencing `globalThis.Bun`
// would force every consumer to install @types/bun (TS7017 otherwise). The cast
// keeps it portable across Bun, Node, and the browser.
const env: Record<string, string | undefined> =
  (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env ??
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ??
  {};

let current: LogLevel = normalizeLevel(env.LOG_LEVEL);

export function setLogLevel(level: LogLevel) {
  current = normalizeLevel(level);
}

export function getLogLevel(): LogLevel {
  return current;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[current] >= LEVELS[level];
}

// === Colors ===

// Emit ANSI colors only to an interactive terminal. Respects NO_COLOR
// (https://no-color.org) and stays plain when piped, redirected to a file, or
// running in a browser — contexts where raw escape codes corrupt the output.
const colorEnabled: boolean = (() => {
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  const stdout = (globalThis as { process?: { stdout?: { isTTY?: boolean } } })
    .process?.stdout;
  return stdout?.isTTY === true;
})();

const wrap = (code: string) => (s: string) =>
  colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s;
const gray = wrap("90");
const yellow = wrap("33");
const red = wrap("31");
const dim = wrap("2");

const color: Record<string, (s: string) => string> = {
  error: red,
  warn: yellow,
  info: gray,
  debug: dim,
};

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function fmt(level: LogLevel, tag: string, msg: string) {
  const colorFn = color[level] ?? gray;
  return `${gray(timestamp())} ${colorFn(level.toUpperCase().padEnd(5))} ${tag} ${msg}`;
}

/** Create a tagged logger instance. */
export function createLogger(tag: string) {
  return {
    info: (msg: string) => { if (shouldLog("info")) console.log(fmt("info", tag, msg)); },
    warn: (msg: string) => { if (shouldLog("warn")) console.warn(fmt("warn", tag, msg)); },
    error: (msg: string) => { if (shouldLog("error")) console.error(fmt("error", tag, msg)); },
    debug: (msg: string) => { if (shouldLog("debug")) console.log(fmt("debug", tag, msg)); },
  };
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Wrap a route handler with access logging. */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function loggedRequest(tag: string, handler: Handler): Handler {
  const log = createLogger(tag);
  return async (req: Request) => {
    const start = performance.now();
    try {
      const res = await handler(req);
      const ms = (performance.now() - start).toFixed(1);
      log.info(
        `${req.method} ${safePathname(req.url)} → ${res.status} (${ms}ms)`,
      );
      return res;
    } catch (err: unknown) {
      const ms = (performance.now() - start).toFixed(1);
      const msg = err instanceof Error ? err.message : String(err);
      log.error(
        `${req.method} ${safePathname(req.url)} threw (${ms}ms): ${msg}`,
      );
      throw err;
    }
  };
}
