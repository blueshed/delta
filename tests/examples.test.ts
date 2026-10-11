/**
 * The examples that need no Postgres server, run as their READMEs say.
 * (shared-state: tests/recipe.test.ts; the Postgres ones: tests/postgres-examples.test.ts.)
 */
import { test } from "bun:test";
import { bboxStory, runExample, stop, until } from "./helpers/examples";

test("sites-bbox on SQLite: a box is told the sites that come into it, move in it, and leave it", async () => {
  const server = runExample("sites-bbox/server.ts");
  try {
    const [, url, world] = await until(server, /(ws:\S+)[\s\S]*"(world:\d+)"/);
    await bboxStory(url!, url!, world!);
  } finally {
    await stop(server);
  }
});
