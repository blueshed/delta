/**
 * @blueshed/delta/logger — railroad's logger, re-exported.
 *
 * Delta's server and client log through one logger: `@blueshed/railroad/logger`
 * (colored and timestamped on a terminal, plain when piped or with `NO_COLOR`,
 * level-gated; an unknown `LOG_LEVEL` falls back to "info"). One
 * `setLogLevel` sets it for delta and railroad alike.
 *
 *   import { createLogger, setLogLevel, loggedRequest } from "@blueshed/delta/logger";
 *
 *   const log = createLogger("[server]");
 *   log.info("listening on :3000");   // 12:34:56.789 INFO  [server] listening on :3000
 *   setLogLevel("debug");             // show everything
 *   const handler = loggedRequest("[api]", myHandler);  // wrap a route with access logging
 */
export { createLogger, setLogLevel, getLogLevel, loggedRequest, type LogLevel } from "@blueshed/railroad/logger";
