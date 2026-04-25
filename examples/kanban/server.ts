/**
 * Server — a real delta-doc server, 100% library surface.
 *
 *   createWs()                                    — WS action router + pub/sub
 *   createDocListener(ws, pool)                   — Postgres LISTEN → WS publish
 *   registerDocType(docTypeFromDef(docs[0], pool)) — wire the "board:" prefix
 *   Bun.serve({ routes, websocket })              — HTTP + WebSocket
 *
 * No hand-written SQL in the write path. `docTypeFromDef` uses `delta_open`
 * + `delta_apply` under the hood. The listener is the framework's own —
 * it LISTENs on `delta_changes`, calls `delta_fetch_ops` on bump, and
 * `ws.publish(docName, {doc, ops})` reaches every subscriber of that doc.
 */
import type { Pool } from "pg";
import type { Server } from "bun";
import { createWs } from "../../src/server/server";
import {
  createDocListener,
  registerDocType,
  docTypeFromDef,
  clearRegistry,
} from "../../src/server/postgres";
import { docs } from "./schema";

export interface KanbanServer {
  server: Server<unknown>;
  port:   number;
  wsUrl:  string;
  stop(): Promise<void>;
}

export async function startServer(pool: Pool): Promise<KanbanServer> {
  // One DocType per doc def — framework-generic, no custom SQL.
  clearRegistry();
  for (const def of docs) {
    registerDocType(docTypeFromDef(def, pool));
  }

  const ws = createWs();
  const listener = await createDocListener(ws, pool);

  const server = Bun.serve({
    port: 0,                                        // let the OS pick
    routes: { [ws.path]: ws.upgrade },
    websocket: ws.websocket,
  });
  ws.setServer(server);

  const port  = server.port!;
  const wsUrl = `ws://localhost:${port}${ws.path}`;

  return {
    server,
    port,
    wsUrl,
    async stop() {
      await listener.destroy();   // releases the LISTEN connection back to the pool
      server.stop(true);
    },
  };
}
