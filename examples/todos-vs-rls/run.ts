/**
 * Driver — three side-by-side comparisons between raw RLS and delta.
 *
 *   bun run examples/todos-vs-rls/run.ts
 *
 * Requires the dev compose running (`bun run db:up`). Drops and re-seeds the
 * example tables on every invocation.
 */
import { setLogLevel } from "../../src/server/logger";
import { setup, ALICE, BOB, CAROL } from "./setup";
import * as raw from "./raw-rls";
import { serveTodos } from "./delta";

setLogLevel("warn");

function hr(title: string) {
  console.log(`\n── ${title} ${"─".repeat(Math.max(2, 72 - title.length))}`);
}
function show(label: string, value: unknown) {
  console.log(`  ${label}`);
  console.log(JSON.stringify(value, null, 2).replace(/^/gm, "    "));
}
const settle = () => new Promise((r) => setTimeout(r, 200));   // for the NOTIFY to come round

async function main() {
  const { admin, app } = await setup();
  const { local, listener } = await serveTodos(app);
  const alice = local.as(ALICE);
  const heard: { doc: string; ops: unknown[] }[] = [];
  local.onPublish((_channel, change) => heard.push({ doc: change.doc, ops: change.ops }));

  // -----------------------------------------------------------------------
  // 1. Reshape — "my todos with counts"
  // -----------------------------------------------------------------------
  hr("1. RESHAPE: list my todos + counts");
  console.log("    raw-rls needs two queries, client merges the result:");
  show("raw.listMyTodosWithCounts(Alice) →", await raw.listMyTodosWithCounts(app, ALICE));

  console.log("\n    delta: one open of a custom doc recomputed as Alice:");
  show("alice open 'todos-summary:1' →", (await alice.call("open", { doc: "todos-summary:1" })).result);
  await alice.call("close", { doc: "todos-summary:1" });

  // -----------------------------------------------------------------------
  // 2. Inject — "add a todo"
  // -----------------------------------------------------------------------
  hr("2. INJECT: add a todo (client sends no owner)");
  console.log("    raw-rls requires the client to supply owner_id + team_id:");
  show("raw.addTodo(Alice, {owner_id, team_id, text}) →", await raw.addTodo(app, ALICE, {
    owner_id: ALICE.id,       // client MUST send — forget and RLS rejects
    team_id:  1,
    text:     "raw: write the blog post",
  }));
  await settle();
  console.log(`    ...and no one is told: delta heard ${heard.length} changes.`);

  console.log("\n    delta: add through Alice's own name; owner_id comes from the name:");
  await alice.call("open", { doc: "todos-mine:1" });
  const added = await alice.call("delta", { doc: "todos-mine:1", ops: [
    { op: "add", path: "/todos/-", value: { text: "delta: write the blog post", team_id: 1 } },
  ] });
  show("alice delta 'todos-mine:1' add /todos/- →", added.result ?? added.error);
  await settle();
  show("heard on todos-mine:1 (versioned, logged, NOTIFY'd) →", heard.at(-1));

  console.log("\n    a forged owner_id in the value is overwritten by the name's:");
  await alice.call("delta", { doc: "todos-mine:1", ops: [
    { op: "add", path: "/todos/-", value: { text: "delta: forged", team_id: 1, owner_id: BOB.id } },   // try to be Bob
  ] });
  show("rows named 'delta: forged' →", (await raw.listVisibleTodos(app, ALICE))
    .filter((r) => r.text === "delta: forged")
    .map((r) => ({ id: r.id, text: r.text, owner_id: r.owner_id })));
  await settle();
  console.log(`    delta heard ${heard.length} changes, each on the channel of the document it was written through.`);

  // -----------------------------------------------------------------------
  // 3. Dispatch — one table, a lens per name, an owner per name
  // -----------------------------------------------------------------------
  hr("3. DISPATCH: two lenses, and who may open each");
  const count = async (who: typeof ALICE, doc: string) => {
    const r = await local.as(who).call("open", { doc });
    return r.error ? `${r.error.code} ${r.error.message}` : `${Object.keys(r.result.todos).length} todos`;
  };
  show("Alice todos-mine:1  →", await count(ALICE, "todos-mine:1"));
  show("Alice todos-team:1  →", await count(ALICE, "todos-team:1"));
  show("Bob   todos-team:1  →", await count(BOB, "todos-team:1"));
  show("Carol todos-team:1  →", await count(CAROL, "todos-team:1"));   // not on the team: owns says no
  show("Bob   todos-mine:1  →", await count(BOB, "todos-mine:1"));    // Alice's name: owns says no

  await listener.destroy();
  await app.end();
  await admin.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
