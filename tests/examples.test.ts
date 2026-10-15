/**
 * The examples, run as their READMEs say. (shared-state: tests/recipe.test.ts;
 * the Postgres ones are dzql's.)
 *
 *   kanban      -- two browsers on one board: a card one clicks moves on both;
 *                  and run.ts, the headless story, runs through
 *   sites-bbox  -- a box told the sites that come into it, move in it, and leave it
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bboxStory, runExample, stop, until, type Proc } from "./helpers/examples";

test("sites-bbox on SQLite: a box is told the sites that come into it, move in it, and leave it", async () => {
  const server = runExample("sites-bbox/server.ts");
  try {
    const [, url, world] = await until(server, /(ws:\S+)[\s\S]*"(world:\d+)"/);
    await bboxStory(url!, url!, world!);
  } finally {
    await stop(server);
  }
});

describe("kanban", () => {
  test("two browsers on board:1: a card clicked in one moves to the next column in both", async () => {
    const server = runExample("kanban/serve.ts");
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
    const run = runExample("kanban/run.ts");
    const hang = setTimeout(() => run.kill(), 15_000);   // a hang is killed before the test's timeout, so the finally runs
    try {
      const out = await new Response(run.stdout).text();
      expect(await run.exited).toBe(0);
      const told = out.slice(out.indexOf("bob received"), out.indexOf("3. bob.data.get()"));
      expect(told).toContain('"path": "/kanban_columns/2/title"');   // told the fields that changed, not the rows
      expect(told).toContain('"path": "/kanban_cards/1/kanban_columns_id"');
      const bob = out.slice(out.indexOf("3. bob.data.get()"), out.indexOf("4. charlie"));
      expect(bob).toContain('"title": "In flight"');
      expect(bob).toContain('"title": "draft release notes"');
      expect(out.slice(out.indexOf("4. charlie"))).toContain('"title": "draft release notes"');
    } finally {
      clearTimeout(hang);
      await stop(run);   // never left running with its pool open
    }
  }, 20_000);
});
