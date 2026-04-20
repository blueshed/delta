/**
 * Driver — three side-by-side comparisons between raw-RLS and delta.
 *
 *   bun run examples/todos-vs-rls/run.ts
 *
 * Requires the dev compose running (`bun run db:up`). Drops + re-seeds
 * the example tables on every invocation.
 */
import { newPool, applySchema, ALICE, BOB } from "./setup";
import * as raw from "./raw-rls";
import { todosDocType, openTodos, applyTodos } from "./delta";

function hr(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 72 - title.length))}`);
}
function show(label: string, value: unknown) {
  console.log(`  ${label}`);
  const s = JSON.stringify(value, null, 2).replace(/^/gm, "    ");
  console.log(s);
}

async function main() {
  const pool = newPool();
  await applySchema(pool);
  const dt = todosDocType(pool);

  // -----------------------------------------------------------------------
  // 1. Reshape — "my todos with counts"
  // -----------------------------------------------------------------------
  hr("1. RESHAPE: list my todos + counts");
  console.log("    raw-rls needs two queries, client merges the result:");
  show("raw.listMyTodosWithCounts(Alice) →", await raw.listMyTodosWithCounts(pool, ALICE));

  console.log("\n    delta open() returns one composed object:");
  show("openTodos('todos:me', Alice) →", (await openTodos(dt, "todos:me", ALICE))?.result);

  // -----------------------------------------------------------------------
  // 2. Inject — "add a todo"
  // -----------------------------------------------------------------------
  hr("2. INJECT: add a todo (client sends only text)");
  console.log("    raw-rls requires the client to supply owner_id + team_id:");
  const rawRow = await raw.addTodo(pool, ALICE, {
    owner_id: ALICE.id,       // client MUST send — forget and RLS rejects
    team_id:  1,
    text:     "raw: write the blog post",
  });
  show("raw.addTodo(Alice, {owner_id, team_id, text}) →", rawRow);

  console.log(
    "\n    delta apply() accepts just {text}; owner_id + team_id injected:",
  );
  await applyTodos(
    dt,
    "todos:team:1",
    [{ op: "add", path: "/todos/-", value: { text: "delta: write the blog post" } }],
    ALICE,
  );
  const afterInject = await openTodos(dt, "todos:me", ALICE);
  show("…post-apply todos:me for Alice →", afterInject?.result);

  console.log(
    "\n    forged owner_id is silently overwritten by the DocType — not trusted:",
  );
  await applyTodos(
    dt,
    "todos:team:1",
    [{
      op: "add",
      path: "/todos/-",
      value: { text: "delta: forged", owner_id: BOB.id },  // attempt to impersonate Bob
    }],
    ALICE,
  );
  const whoOwns = (await raw.listVisibleTodos(pool, ALICE))
    .filter((r) => r.text === "delta: forged")
    .map((r) => ({ id: r.id, text: r.text, owner_id: r.owner_id }));
  show("rows named 'delta: forged' →", whoOwns);

  // -----------------------------------------------------------------------
  // 3. Dispatch — same prefix, two shapes
  // -----------------------------------------------------------------------
  hr("3. DISPATCH: one DocType, two lenses");
  console.log("    todos:me → just mine:");
  show("openTodos('todos:me', Alice).counts →",
    (await openTodos(dt, "todos:me", ALICE))?.result.counts);

  console.log("\n    todos:team:1 → everything in team 1 that RLS lets me see:");
  show("openTodos('todos:team:1', Alice).counts →",
    (await openTodos(dt, "todos:team:1", ALICE))?.result.counts);

  console.log(
    "\n    same prefix, different scope, same DocType — no per-call-site branching.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
