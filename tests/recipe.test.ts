/**
 * The skill's recipe runs as written: SKILL.md's `types.ts`, `server.ts`,
 * `client.ts` and `index.html` blocks, saved in a folder inside the package
 * (so `@blueshed/delta/...` resolves to this source, as from node_modules).
 * The server runs on a free port; each browser is a Bun process with
 * happy-dom for the page and Bun's own WebSocket. One types a message and
 * submits the form, and the other's `#log` shows it. And
 * `examples/shared-state/server.ts`, the recipe's full version, serves its
 * page and passes a message from one socket to another.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectWs, openDoc, type DeltaOp } from "../src/client/client";
import { runExample, until, type Proc } from "./helpers/examples";
import { waitFor } from "../src/testing";

const skill = await Bun.file(new URL("../.claude/skills/delta-doc/SKILL.md", import.meta.url)).text();

/** The fenced block under the heading `marker`. */
function blockAfter(marker: string): string {
  const at = skill.indexOf(marker);
  if (at < 0) throw new Error(`SKILL.md has no ${JSON.stringify(marker)}`);
  const open = skill.indexOf("```", at);
  const start = skill.indexOf("\n", open) + 1;
  return skill.slice(start, skill.indexOf("\n```", start) + 1);
}

/** One browser: the recipe's page in happy-dom, its client.ts, then (if asked) a message typed and sent; it exits once `#log` shows `HEAR`, or fails after 5 s. */
const BROWSER = `
import { GlobalRegistrator } from "@happy-dom/global-registrator";
const Native = globalThis.WebSocket;
GlobalRegistrator.register({ url: "http://localhost:" + process.env.PORT + "/" });
globalThis.WebSocket = Native;
const html = await Bun.file(new URL("./index.html", import.meta.url)).text();
document.body.innerHTML = html.replace(/<!doctype html>/i, "").replace(/<script[^>]*><\\/script>/, "");
await import("./client.ts");
if (process.env.SAY) {
  const form = document.getElementById("say");
  form.elements.namedItem("text").value = process.env.SAY;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
}
console.log("ready");
const log = document.getElementById("log");
for (let i = 0; i < 500 && !log.textContent.includes(process.env.HEAR); i++) await Bun.sleep(10);
if (!log.textContent.includes(process.env.HEAR)) { console.log("never heard; #log is " + JSON.stringify(log.textContent)); process.exit(1); }
console.log("heard " + log.textContent);
process.exit(0);
`;

test("SKILL.md's recipe, as written: one browser sends a message, the other's page shows it", async () => {
  const dir = new URL(`./.recipe-${process.pid}/`, import.meta.url).pathname;
  mkdirSync(dir, { recursive: true });
  const procs: Proc[] = [];
  const spawn = (file: string, env: Record<string, string> = {}) => {
    const p = Bun.spawn(["bun", file], { cwd: dir, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    procs.push(p);
    return p;
  };
  try {
    const server = blockAfter("### `server.ts`");
    expect(server).toContain("port: 3100,");   // the one line changed: a free port, said on stdout
    await Bun.write(join(dir, "server.ts"), server.replace("port: 3100,", "port: 0,") + 'console.log("port=" + server.port);\n');
    await Bun.write(join(dir, "types.ts"), blockAfter("### `types.ts`"));
    await Bun.write(join(dir, "client.ts"), blockAfter("### `client.ts`"));
    await Bun.write(join(dir, "index.html"), blockAfter("### `index.html`"));
    await Bun.write(join(dir, "browser.ts"), BROWSER);

    const [, port] = await until(spawn("server.ts"), /port=(\d+)/);
    const reader = spawn("browser.ts", { PORT: port!, HEAR: "hello from ada" });
    await until(reader, /ready/);
    const writer = spawn("browser.ts", { PORT: port!, HEAR: "hello from ada", SAY: "hello from ada" });
    expect((await until(writer, /heard (.*)/))[1]).toBe("me hello from ada");
    expect((await until(reader, /heard (.*)/))[1]).toBe("me hello from ada");   // author, then text
    // the room is kept in the JSON file (saved after the change is told)
    await waitFor(async () => (await Bun.file(join(dir, "chat.json")).text()).includes("hello from ada"));
  } finally {
    for (const p of procs) p.kill();
    await Promise.all(procs.map((p) => p.exited));
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("bun examples/shared-state/server.ts serves its page, and passes a message from one socket to another", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "delta-shared-state-"));   // its chat-room.json lands here, not in the repo
  const run = runExample("shared-state/server.ts", {}, cwd);
  let a: ReturnType<typeof connectWs> | undefined;
  let b: ReturnType<typeof connectWs> | undefined;
  try {
    const [, port] = await until(run, /localhost:(\d+)/);
    const page = await fetch(`http://localhost:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="log"');
    expect(html).toMatch(/<script[^>]+src=/);

    const url = `ws://localhost:${port}/ws`;
    [a, b] = [connectWs(url), connectWs(url)];
    const [mine, theirs] = [openDoc<any>("chat:room", a), openDoc<any>("chat:room", b)];
    await Promise.all([mine.ready, theirs.ready]);
    const heard: DeltaOp[][] = [];
    theirs.onOps((ops) => heard.push(ops));
    await mine.send([{ op: "add", path: "/messages/-", value: { author: "ada", text: "hi", at: "now" } }]);
    for (let i = 0; i < 100 && heard.length === 0; i++) await Bun.sleep(10);
    const op: any = heard[0]?.[0];
    const id = op?.path.split("/")[2];
    expect(op).toEqual({ op: "add", path: `/messages/${id}`, value: { author: "ada", text: "hi", at: "now", id } });
    expect(id).not.toBe("-");
  } finally {
    a?.close();
    b?.close();
    run.kill();
    await run.exited;
    rmSync(cwd, { recursive: true, force: true });
  }
});
