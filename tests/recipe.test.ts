/**
 * The skill's canonical recipe (SKILL.md: a free-form document, `registerDoc`,
 * served by `createWs`, two browsers on `connectWs` + `openDoc`): one sends
 * `add /messages/-`, the other hears the message, named by the server. And
 * `bun examples/shared-state/server.ts`, its full version, serves its page.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWs, registerDoc } from "../src/server/server";
import { connectWs, openDoc, type DeltaOp } from "../src/client/client";
import { setLogLevel } from "../src/server/logger";

setLogLevel("silent");
(globalThis as any).location ??= { href: "http://localhost/", protocol: "http:" };

interface Message { id: string; author: string; text: string; at: string }
interface ChatDoc { messages: Record<string, Message> }

test("the recipe: one browser sends add /messages/-, the other hears it, named by the server", async () => {
  const dir = mkdtempSync(join(tmpdir(), "delta-recipe-"));
  const ws = createWs();
  await registerDoc<ChatDoc>(ws, "chat:room", { file: join(dir, "chat-room.json"), empty: { messages: {} } });
  const server = Bun.serve({ port: 0, routes: { [ws.path]: ws.upgrade }, websocket: ws.websocket });
  ws.setServer(server);
  const url = `ws://localhost:${server.port}${ws.path}`;
  const [ada, bo] = [connectWs(url), connectWs(url)];
  try {
    const [mine, theirs] = [openDoc<ChatDoc>("chat:room", ada), openDoc<ChatDoc>("chat:room", bo)];
    await Promise.all([mine.ready, theirs.ready]);
    const heard: DeltaOp[][] = [];
    theirs.onOps((ops) => heard.push(ops));
    await mine.send([{ op: "add", path: "/messages/-", value: { author: "ada", text: "hi", at: "now" } }]);
    for (let i = 0; i < 50 && heard.length === 0; i++) await Bun.sleep(10);
    const [[op]] = heard as [[DeltaOp & { value: Message }]];
    const id = op!.path.split("/")[2]!;
    expect(id).not.toBe("-");
    expect(op).toEqual({ op: "add", path: `/messages/${id}`, value: { author: "ada", text: "hi", at: "now", id } });
    expect(theirs.data.get()).toEqual({ messages: { [id]: { author: "ada", text: "hi", at: "now", id } } });
    expect(mine.data.get()).toEqual(theirs.data.get());
  } finally {
    ada.close();
    bo.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bun examples/shared-state/server.ts serves its page", async () => {
  const root = new URL("..", import.meta.url).pathname;
  const run = Bun.spawn(["bun", "examples/shared-state/server.ts"], { cwd: root, env: { ...process.env, PORT: "0" }, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = run.stdout.getReader();
    let out = "";
    while (!/localhost:(\d+)/.test(out)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the example exited: ${out}${await new Response(run.stderr).text()}`);
      out += new TextDecoder().decode(value);
    }
    const port = /localhost:(\d+)/.exec(out)![1];
    const page = await fetch(`http://localhost:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('id="log"');
    expect(html).toMatch(/<script[^>]+src=/);
  } finally {
    run.kill();
    await run.exited;
  }
});
