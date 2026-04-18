/**
 * Logger — colored, timestamped, level-gated console output.
 *
 * Usage:
 *   import { createLogger, setLogLevel, loggedRequest } from "@blueshed/railroad";
 *
 *   const log = createLogger("[server]");
 *   log.info("listening on :3000");   // 12:34:56.789 INFO  [server] listening on :3000
 *   log.debug("tick");                // only shown when level is "debug"
 *   log.warn("slow query");           // yellow
 *   log.error("connection failed");   // red, always shown
 *
 *   setLogLevel("debug");             // show everything
 *
 *   const handler = loggedRequest("[api]", myHandler);  // wrap a route with access logging
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVELS: Record<LogLevel, number> = { silent: -1, error: 0, warn: 1, info: 2, debug: 3 };

let current: LogLevel =
  (globalThis.Bun?.env?.LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel) {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[current] >= LEVELS[level];
}

// === Colors ===

const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

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
