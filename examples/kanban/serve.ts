/**
 * Kanban — the canonical UX entry point.
 *
 * Boots Postgres setup, applies framework + table SQL, starts the WS listener,
 * registers the "board:" doc type, serves the HTML page that drives `client.tsx`.
 *
 * Run:
 *   bun run db:up
 *   bun examples/kanban/serve.ts        # default port 3100
 *   PORT=3199 bun examples/kanban/serve.ts
 *
 * Open http://localhost:3100 in two tabs to see the live sync.
 */
import index from "./index.html";
import { newPool, applyAll, PG_URL } from "./setup";
import { createWs } from "../../src/server/server";
import {
  createDocListener,
  registerDocType,
  docTypeFromDef,
  clearRegistry,
} from "../../src/server/postgres";
import { docs } from "./schema";

const pool = newPool();
await applyAll(pool);

clearRegistry();
for (const def of docs) {
  registerDocType(docTypeFromDef(def, pool));
}

const ws = createWs();
const listener = await createDocListener(ws, pool);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3100),
  routes: {
    "/": index,
    [ws.path]: ws.upgrade,
  },
  websocket: ws.websocket,
  development: { hmr: true, console: true },
});
ws.setServer(server);

console.log(`kanban (railroad UX) on http://localhost:${server.port}  (DB: ${PG_URL})`);
console.log(`  open two tabs · click a card to cycle columns · double-click a header to rename`);

const shutdown = async () => {
  await listener.destroy();
  await pool.end();
  server.stop(true);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
