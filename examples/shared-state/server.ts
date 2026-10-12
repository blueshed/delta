/**
 * A chat room: one document, `room:1`, kept in a JSON file. Everyone who
 * opens it holds it, and is told each message anyone sends as it is sent.
 * No database to run.
 *
 * Run:
 *   bun examples/shared-state/server.ts
 *   open http://localhost:3100 in two tabs
 */
import index from "./index.html";
import { createWs } from "../../src/server/server";
import { registerDocs } from "../../src/server/json";
import { room, schema } from "./types";

const ws = createWs();
registerDocs(ws, "./examples/shared-state/chat-room.json", schema, [room]);   // where the documents are kept

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3100),
  routes: {
    "/": index,
    [ws.path]: ws.upgrade,
  },
  websocket: ws.websocket,
});
ws.setServer(server);

console.log(`shared-state demo on http://localhost:${server.port}`);
console.log(`  open two tabs, type messages, watch them sync`);
console.log(`  set PORT=<n> to use a different port`);
