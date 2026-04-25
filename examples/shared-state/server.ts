/**
 * The canonical "use delta-doc for shared state" answer.
 *
 * One doc, persisted to a JSON file. Browsers connect via WebSocket; every
 * change one user makes is broadcast to every other user with the doc open.
 * No database, no schema, no codegen.
 *
 * Run:
 *   bun examples/shared-state/server.ts
 *   open http://localhost:3100 in two tabs
 */
import index from "./index.html";
import { createWs, registerDoc } from "../../src/server/server";

interface ChatDoc {
  messages: Record<string, { author: string; text: string; at: string }>;
}

const ws = createWs();

await registerDoc<ChatDoc>(ws, "chat:room", {
  file: "./examples/shared-state/chat-room.json",
  empty: { messages: {} },
});

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
