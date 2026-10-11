/**
 * README.md's "Try it" runs as written: its code block, saved and run with
 * Bun, prints what the README says it prints. The file is written inside the
 * package, so `@blueshed/delta/...` resolves to this source, as it would from
 * node_modules.
 */
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";

const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();

/** The fenced block that follows `marker`. */
function blockAfter(marker: string): string {
  const at = readme.indexOf(marker);
  if (at < 0) throw new Error(`README.md has no ${JSON.stringify(marker)}`);
  const open = readme.indexOf("```", at);
  const start = readme.indexOf("\n", open) + 1;
  return readme.slice(start, readme.indexOf("\n```", start) + 1);
}

test("README's Try it prints what the README shows", async () => {
  const file = new URL(`./.try-readme-${process.pid}.ts`, import.meta.url).pathname;
  await Bun.write(file, blockAfter("Save this as `try.ts`:"));
  try {
    const run = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()];
    expect(await run.exited).toBe(0);
    expect(err).toBe("");
    expect(out).toBe(blockAfter("Run `bun try.ts`:"));
  } finally {
    rmSync(file, { force: true });
  }
});
