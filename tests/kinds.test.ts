import { describe, expect, test } from "bun:test";
import { createLocal } from "../src/server/local";
import { registerMemory, registerSource, registerStatic } from "../src/server/kinds";

function setup() {
  const local = createLocal();
  const heard: any[] = [];
  local.onPublish((_c, data) => heard.push(data));
  return { local, heard };
}

describe("memory: live documents", () => {
  test("open empty, written by the server, heard as a change with its version; never over the socket", async () => {
    const { local, heard } = setup();
    const here = registerMemory(local.server, { prefix: "here:", empty: () => ({ people: {} as Record<string, string> }) });
    expect((await local.call("open", { doc: "here:general" })).result).toEqual({ people: {}, _v: 0 });
    expect((await local.call("delta", { doc: "here:general", ops: [{ op: "add", path: "/people/p1", value: "Ada" }] })).result).toMatchObject({ ack: true, version: 1 });
    expect(heard).toEqual([{ doc: "here:general", ops: [{ op: "add", path: "/people/p1", value: "Ada" }], v: 1 }]);
    expect(here.peek("here:general")).toEqual({ people: { p1: "Ada" } });

    // a socket client -- not in this process -- may not write it
    let answer: any;
    const handlers: any[] = [];
    const server = { on: (a: string, h: any) => a === "delta" && handlers.push(h), publish() {} } as any;
    registerMemory(server, { prefix: "here:", empty: () => ({}) });
    handlers[0]({ doc: "here:x", ops: [] }, { data: { clientId: "c" } }, (r: any) => (answer = r));
    expect(answer.error.code).toBe(403);
  });

  test("an op that does not land is refused and changes nothing; forget starts it again", async () => {
    const { local } = setup();
    const here = registerMemory(local.server, { prefix: "here:", empty: () => ({ people: {} }) });
    expect((await local.call("delta", { doc: "here:a", ops: [{ op: "replace", path: "/nobody/x", value: 1 }] })).error?.code).toBe(400);
    await local.call("delta", { doc: "here:a", ops: [{ op: "add", path: "/people/p1", value: "Ada" }] });
    here.forget("here:a");
    expect(here.peek("here:a")).toBeUndefined();
    expect((await local.call("close", { doc: "here:a" })).result).toEqual({ ack: true });
  });

  test("anyone may write one that says so", async () => {
    const handlers: any[] = [];
    const server = { on: (a: string, h: any) => a === "delta" && handlers.push(h), publish() {} } as any;
    registerMemory(server, { prefix: "cursor:", empty: () => ({ at: 0 }), writable: "any" });
    let answer: any;
    handlers[0]({ doc: "cursor:x", ops: [{ op: "replace", path: "/at", value: 3 }] }, { data: { clientId: "c" } }, (r: any) => (answer = r));
    expect(answer.result.ack).toBe(true);
  });
});

describe("static: fixed for the release", () => {
  test("read, never written; one that is not there is not found", async () => {
    const { local } = setup();
    const units: Record<string, { symbol: string }> = { metre: { symbol: "m" } };
    registerStatic(local.server, { prefix: "unit:", value: (id) => units[id] });
    expect((await local.call("open", { doc: "unit:metre" })).result).toEqual({ symbol: "m", _v: 1 });
    expect((await local.call("open", { doc: "unit:furlong" })).error?.code).toBe(404);
    expect((await local.call("delta", { doc: "unit:metre", ops: [{ op: "replace", path: "/symbol", value: "M" }] })).error?.code).toBe(403);
    expect((await local.call("close", { doc: "unit:metre" })).result).toEqual({ ack: true });
  });
});

describe("source: the truth is outside", () => {
  test("read when first opened, polled while watched, stamped with its time; the second watcher shares it; the last to close stops it", async () => {
    const { local, heard } = setup();
    let temperature = 300;
    let reads = 0;
    let clock = 1000;
    const reactor = registerSource(local.server, { prefix: "reactor:", read: () => (reads++, temperature), every: 15, now: () => clock });
    expect((await local.call("open", { doc: "reactor:1" })).result).toEqual({ reading: 300, at: 1000, stale: false, _v: 0 });
    await local.as("b").call("open", { doc: "reactor:1" });
    expect(reads).toBe(1); // one reading, shared

    temperature = 312;
    clock = 2000;
    await Bun.sleep(40);
    expect(heard.find((h) => h.ops.some((o: any) => o.path === "/reading"))).toMatchObject({ doc: "reactor:1", ops: [{ op: "replace", path: "/reading", value: 312 }, { op: "replace", path: "/at", value: 2000 }] });

    await local.call("close", { doc: "reactor:1" });
    const polled = reads;
    await Bun.sleep(40);
    expect(reads).toBeGreaterThan(polled); // one watcher left: still polled
    await local.as("b").call("close", { doc: "reactor:1" });
    const last = reads;
    await Bun.sleep(40);
    expect(reads).toBe(last); // nobody watching: stopped
    reactor.stopAll();
  });

  test("a source that goes quiet makes its document stale; the next reading makes it fresh", async () => {
    const { local, heard } = setup();
    let push: (r: number) => void = () => {};
    let clock = 0;
    registerSource(local.server, { prefix: "reactor:", read: () => 300, subscribe: (_id, p) => ((push = p), () => {}), stale: 40, now: () => clock });
    await local.call("open", { doc: "reactor:1" });
    clock = 100;
    await Bun.sleep(30);
    expect(heard.at(-1)).toEqual({ doc: "reactor:1", ops: [{ op: "replace", path: "/stale", value: true }], v: 1 });
    push(305);
    expect(heard.at(-1).ops).toEqual([{ op: "replace", path: "/reading", value: 305 }, { op: "replace", path: "/at", value: 100 }, { op: "replace", path: "/stale", value: false }]);
    expect((await local.call("delta", { doc: "reactor:1", ops: [] })).error?.code).toBe(403);
    await local.call("close", { doc: "reactor:1" });
  });

  test("a source that cannot be read opens stale, with no reading; a failed poll leaves the last reading to age", async () => {
    const { local } = setup();
    let fail = true;
    const r = registerSource(local.server, { prefix: "api:", read: () => { if (fail) throw new Error("down"); return 1; }, every: 10 });
    expect((await local.call("open", { doc: "api:x" })).result).toEqual({ reading: null, at: null, stale: true, _v: 0 });
    fail = false;
    await Bun.sleep(30);
    expect((await local.as("c").call("open", { doc: "api:x" })).result).toMatchObject({ reading: 1, stale: false });
    fail = true;
    await Bun.sleep(30); // polls fail: nothing published, nothing thrown
    r.stopAll();
  });

  test("two watchers opening at once share one start", async () => {
    const { local } = setup();
    let reads = 0;
    registerSource(local.server, { prefix: "slow:", read: async () => (await Bun.sleep(5), ++reads) });
    const [a, b] = await Promise.all([local.call("open", { doc: "slow:1" }), local.as("b").call("open", { doc: "slow:1" })]);
    expect(reads).toBe(1);
    expect(a.result.reading).toBe(1);
    expect(b.result.reading).toBe(1);
  });
});
