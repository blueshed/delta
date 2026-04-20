/**
 * Driver — start a delta server, connect two WS clients, show sync live
 * through the library's reactive `openDoc` signal.
 *
 *   bun run db:up
 *   bun run examples/kanban/run.ts
 *
 * Two clients, "alice" and "bob", each with their own `connectWs()` and
 * their own reactive `openDoc("board:1")` signal. Alice mutates; the
 * framework commits + NOTIFYs; `createDocListener` fans the ops out;
 * bob's `data` signal updates automatically via the client's internal
 * `applyOps` dispatch. Nothing hand-rolled — every piece is the library.
 */

// `connectWs` resolves URLs against `location` — shim it for Bun.
(globalThis as any).location = { href: "http://localhost/", protocol: "http:" };

import { newPool, applyAll, PG_URL } from "./setup";
import { startServer } from "./server";
import { connectWs, openDoc } from "../../src/client/client";
import type { DeltaOp } from "../../src/core";

interface BoardDoc {
  kanban_boards:  Record<string, any>;
  kanban_columns: Record<string, any>;
  kanban_cards:   Record<string, any>;
}

function hr(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 72 - title.length))}`);
}
function show(label: string, value: unknown) {
  console.log(`  ${label}`);
  console.log(JSON.stringify(value, null, 2).replace(/^/gm, "    "));
}

async function main() {
  const pool = newPool();
  await applyAll(pool);
  const srv = await startServer(pool);
  console.log(`delta server up on ${srv.wsUrl}  (target DB: ${PG_URL})`);

  // Two independent WS clients — each gets its own reconnecting socket and
  // its own `openDoc` state. Per-client is a 0.4.0 feature; see
  // reference.md → "Client-side tests and one-shot scripts".
  const alice = connectWs(srv.wsUrl);
  const bob   = connectWs(srv.wsUrl);

  const aliceBoard = openDoc<BoardDoc>("board:1", alice);
  const bobBoard   = openDoc<BoardDoc>("board:1", bob);

  // Bob observes raw ops as they arrive — BEFORE `data` updates. Collect
  // them so we can print what he sees after alice's batch commits.
  const bobOps: DeltaOp[][] = [];
  bobBoard.onOps((ops) => bobOps.push(ops));

  await Promise.all([aliceBoard.ready, bobBoard.ready]);

  // -----------------------------------------------------------------------
  // 1. Initial state — each client's own reactive signal is populated
  // -----------------------------------------------------------------------
  hr("1. openDoc('board:1') — both clients have independent reactive state");
  console.log("  alice.data.get():");
  show("", aliceBoard.data.get());

  // -----------------------------------------------------------------------
  // 2. alice mutates — bob's signal updates via broadcast
  // -----------------------------------------------------------------------
  hr("2. alice.send(ops) — server commits, broadcasts, bob's signal updates");
  console.log(
    "    aliceBoard.send(ops) hits createWs, which dispatches to the 'delta'\n" +
    "    action, which calls delta_apply; that fires pg_notify; the listener\n" +
    "    publishes to bob's subscription; bob's openDoc message handler runs\n" +
    "    applyOps against bob.data's current value and re-emits the signal.\n",
  );

  await aliceBoard.send([
    { op: "replace", path: "/kanban_columns/2/title", value: "In flight" },
    { op: "replace", path: "/kanban_cards/1/kanban_columns_id", value: 2 },
    { op: "add", path: "/kanban_cards/-",
      value: { kanban_columns_id: 1, title: "draft release notes", position: 2, owner_id: 1 } },
  ]);

  // Let the broadcast fan out before we read.
  await new Promise((r) => setTimeout(r, 150));

  console.log(`  bob received ${bobOps.length} broadcast(s) via onOps:`);
  for (const ops of bobOps) show("ops →", ops);

  hr("3. bob.data.get() — the signal reflects the mutations (no re-open needed)");
  show("bob's columns:", bobBoard.data.get()?.kanban_columns);
  show("bob's cards:",   bobBoard.data.get()?.kanban_cards);

  // -----------------------------------------------------------------------
  // 4. Late-joiner opens the doc — sees the post-mutation state
  // -----------------------------------------------------------------------
  hr("4. charlie connects after the write — open returns current state");
  const charlie = connectWs(srv.wsUrl);
  const charlieBoard = openDoc<BoardDoc>("board:1", charlie);
  await charlieBoard.ready;
  show("charlie's board:", charlieBoard.data.get());

  // -----------------------------------------------------------------------
  // Teardown — close each client, stop the server, end the pool. `close()`
  // suppresses reconnection so the process exits cleanly.
  // -----------------------------------------------------------------------
  alice.close();
  bob.close();
  charlie.close();
  await srv.stop();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
