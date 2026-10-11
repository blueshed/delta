/**
 * The Postgres examples, run as their READMEs say, against the compose
 * database: what each README promises, proved.
 *
 *   kanban       -- two browsers on one board: a card one clicks moves on both;
 *                   and run.ts, the headless story, runs through
 *   sites-bbox   -- the SQLite story again on Postgres, and across two
 *                   processes on the one database
 *   todos-vs-rls -- raw RLS and delta give the same answers, as a
 *                   NOSUPERUSER role; delta stamps the owner and is heard
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Pool } from "pg";
import { setLogLevel } from "../src/server/logger";
import { newPool, PG_URL } from "./setup";
import { bboxStory, runExample, stop, until, type Proc } from "./helpers/examples";
import { setup, ALICE, BOB, CAROL, type Identity } from "../examples/todos-vs-rls/setup";
import * as raw from "../examples/todos-vs-rls/raw-rls";
import { serveTodos } from "../examples/todos-vs-rls/delta";

setLogLevel("silent");
const env = { EXAMPLE_PG_URL: PG_URL, PG_URL };

let pool: Pool;
beforeAll(async () => { pool = await newPool(); });
afterAll(async () => { await pool.end(); });

describe("kanban", () => {
  test("two browsers on board:1: a card clicked in one moves to the next column in both", async () => {
    const server = runExample("kanban/serve.ts", env);
    const browsers: Proc[] = [];
    const browser = (more: Record<string, string>) => {
      const p = Bun.spawn(["bun", join(import.meta.dir, "helpers/kanban-browser.ts")], {
        cwd: join(import.meta.dir, "../examples/kanban"),   // its tsconfig: railroad's JSX
        env: { ...process.env, PORT: port!, SEE: "write the kanban example", IN: "In progress", ...more },
        stdout: "pipe", stderr: "pipe",
      });
      browsers.push(p);
      return p;
    };
    let port: string | undefined;
    try {
      [, port] = await until(server, /localhost:(\d+)/);
      expect((await fetch(`http://localhost:${port}/`)).status).toBe(200);
      const watcher = browser({});
      await until(watcher, /ready/);
      const clicker = browser({ CLICK: "write the kanban example" });
      for (const b of [clicker, watcher]) {
        const [, shown] = await until(b, /board (.*)/);
        expect(JSON.parse(shown!)["In progress"]).toContain("write the kanban example");
        expect(JSON.parse(shown!)["Todo"]).not.toContain("write the kanban example");
      }
    } finally {
      await stop(server, ...browsers);
    }
  }, 20_000);

  test("run.ts: bob's board shows alice's rename, move and new card; charlie, opening late, the same", async () => {
    const run = runExample("kanban/run.ts", env);
    const out = await new Response(run.stdout).text();
    expect(await run.exited).toBe(0);
    const bob = out.slice(out.indexOf("3. bob.data.get()"), out.indexOf("4. charlie"));
    expect(bob).toContain('"title": "In flight"');
    expect(bob).toContain('"title": "draft release notes"');
    expect(out.slice(out.indexOf("4. charlie"))).toContain('"title": "draft release notes"');
  }, 20_000);
});

describe("sites-bbox", () => {
  const fresh = () => pool.query(`DO $$ BEGIN
    IF to_regclass('worlds') IS NOT NULL THEN EXECUTE 'TRUNCATE worlds, sites RESTART IDENTITY'; END IF; END $$`);
  const serve = async () => {
    const p = runExample("sites-bbox/server-pg.ts", env);
    const [, url, world] = await until(p, /(ws:\S+)[\s\S]*"(world:\d+)"/);
    return { p, url: url!, world: world! };
  };

  test("server-pg.ts: the same box, told the same, as on SQLite", async () => {
    await fresh();
    const a = await serve();
    try {
      await bboxStory(a.url, a.url, a.world);
    } finally {
      await stop(a.p);
    }
  }, 20_000);

  test("two server-pg.ts on one database: a box open on one is told of sites written through the other", async () => {
    await fresh();
    const a = await serve();
    const b = await serve();   // after a, so the one world is a's
    try {
      expect(b.world).toBe(a.world);
      await bboxStory(a.url, b.url, a.world);
    } finally {
      await stop(a.p, b.p);
    }
  }, 20_000);
});

describe("todos-vs-rls", () => {
  let admin: Pool, app: Pool;
  let served: Awaited<ReturnType<typeof serveTodos>>;
  const heard: string[] = [];
  const settle = () => Bun.sleep(200);   // for a NOTIFY to come round

  beforeAll(async () => {
    ({ admin, app } = await setup());
    served = await serveTodos(app);
    served.local.onPublish((_channel, change) => heard.push(change.doc));
  });
  afterAll(async () => {
    await served.listener.destroy();
    await app.end();
    await admin.end();
  });

  const open = async (who: Identity, doc: string) => {
    const r = await served.local.as(who).call("open", { doc });
    await served.local.as(who).call("close", { doc });
    return r;
  };
  /** id, text, done of each todo, by id: raw rows and delta's documents compared. */
  const rows = (todos: any[]) => todos.map((t) => ({ id: Number(t.id), text: t.text, done: t.done })).sort((x, y) => x.id - y.id);
  /** Every todo `who` may see, by lens, both ways. */
  const lenses = async (who: Identity, teams: number[]) => {
    const all = await raw.listVisibleTodos(app, who);
    const mine = (await open(who, `todos-mine:${who.id}`)).result.todos;
    expect(rows(Object.values(mine))).toEqual(rows(all.filter((t) => Number(t.owner_id) === who.id)));
    for (const team of teams) {
      const theirs = (await open(who, `todos-team:${team}`)).result.todos;
      expect(rows(Object.values(theirs))).toEqual(rows(all.filter((t) => Number(t.team_id) === team)));
    }
  };

  test("both read as example_app, a role RLS holds", async () => {
    const { rows: [role] } = await app.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test("reshape: my todos with counts, two queries or one open, the same answer", async () => {
    const twoQueries = await raw.listMyTodosWithCounts(app, ALICE);
    const oneOpen = (await open(ALICE, "todos-summary:1")).result;
    expect(rows(Object.values(oneOpen.todos))).toEqual(rows(twoQueries.todos));
    expect(oneOpen.counts).toEqual(twoQueries.counts);
    expect(oneOpen.counts).toEqual({ open: 1, done: 2 });
    expect((await open(BOB, "todos-summary:1")).error?.code).toBe(404);   // Alice's, not Bob's
  });

  test("inject: raw RLS rejects a forged owner; delta stamps the name's owner, and is heard", async () => {
    await expect(raw.addTodo(app, ALICE, { owner_id: BOB.id, team_id: 1, text: "raw: forged" })).rejects.toThrow(/row-level security/);
    await raw.addTodo(app, ALICE, { owner_id: ALICE.id, team_id: 1, text: "raw: mine" });
    await settle();
    expect(heard).toEqual([]);   // a raw INSERT tells no one

    const alice = served.local.as(ALICE);
    await alice.call("open", { doc: "todos-mine:1" });
    const r = await alice.call("delta", { doc: "todos-mine:1", ops: [
      { op: "add", path: "/todos/-", value: { text: "delta: forged", team_id: 1, owner_id: BOB.id } },
    ] });
    expect(r.error).toBeUndefined();
    const forged = (await raw.listVisibleTodos(app, ALICE)).filter((t) => t.text === "delta: forged");
    expect(forged.map((t) => Number(t.owner_id))).toEqual([ALICE.id]);
    await settle();
    expect(heard).toEqual(["todos-mine:1"]);
    await alice.call("close", { doc: "todos-mine:1" });
  });

  test("dispatch: each lens answers as RLS does, for each person; a name not yours is a 404", async () => {
    await lenses(ALICE, [1]);
    await lenses(BOB, [1]);
    await lenses(CAROL, [2]);
    expect((await open(CAROL, "todos-team:1")).error?.code).toBe(404);
    expect((await open(BOB, "todos-mine:1")).error?.code).toBe(404);
  });
});
