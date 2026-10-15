/**
 * What every backend answers alike about a write (`src/cases/writes.ts`,
 * published in `@blueshed/delta/testing`): the error table (D11), a row the
 * server names (D3), and write scope -- on SQLite and the JSON file (dzql asks
 * them of Postgres). Beside them, what
 * the protocol answers itself, and the free-form and memory documents, which
 * are not on the moving-on path.
 */
import { describe, test, expect } from "bun:test";
import { unlinkSync } from "node:fs";
import { createWs, registerDoc } from "../src/server/server";
import { registerMemory } from "../src/server/kinds";
import { setLogLevel } from "../src/server/logger";
import { applyOps } from "../src/core";
import { createRowCases, errorCodeCases, mistakes, mockClient, sendAndAwait, writeScopeCases } from "@blueshed/delta/testing";
import { onJson, onSqlite } from "./helpers/case-backends";

setLogLevel("silent");

for (const [name, backend] of [["SQLite", onSqlite], ["the JSON file", onJson]] as const) {
  describe(name, () => {
    errorCodeCases(backend);
    createRowCases(backend);
    writeScopeCases(backend);
  });
}

describe("the protocol's own answers", () => {
  test("a doc no backend owns is 404, an unknown action 400, a private method 403", async () => {
    const ws = createWs();
    ws.on("open", (msg, _c, respond) => { if (msg.doc === "chat:room") respond({ result: {} }); });   // a backend for one name
    const c = mockClient();
    expect((await sendAndAwait(ws, c, { action: "open", doc: "nobody:1" })).error.code).toBe(404);
    expect((await sendAndAwait(ws, c, { action: "frobnicate" })).error.code).toBe(400);
    expect((await sendAndAwait(ws, c, { action: "call", method: "_internal" })).error.code).toBe(403);
    ws.on("call", () => { throw new Error("boom"); });
    expect((await sendAndAwait(ws, c, { action: "call", method: "x" })).error).toEqual({ code: 500, message: "boom" });
  });
});

describe("the free-form document", () => {
  test("a malformed path is 400, a missing row 404", async () => {
    const file = `/tmp/delta-error-codes-${Date.now()}.json`;
    const ws = createWs();
    await registerDoc(ws, "case-room:1", { file, empty: { case_rooms: { id: "1", title: "" }, case_messages: { "7": { id: "7", text: "hi" } } } as any });
    for (const name of ["a path without a leading slash", "a row that is not there", "a remove of a row that is not there"]) {
      const c = mockClient();
      await sendAndAwait(ws, c, { action: "open", doc: "case-room:1" });
      const r = await sendAndAwait(ws, c, { action: "delta", doc: "case-room:1", ops: mistakes[name]!.ops });
      expect([name, r.error?.code]).toEqual([name, mistakes[name]!.code]);
    }
    try { unlinkSync(file); } catch {}
  });

  test("add /coll/- on a collection of rows makes a row under a key it names", async () => {
    const file = `/tmp/delta-create-row-${Date.now()}.json`;
    const ws = createWs();
    const published: any[] = [];
    ws.setServer({ publish: (_ch: string, raw: string) => published.push(JSON.parse(raw)) });
    await registerDoc(ws, "case-room:1", { file, empty: { case_rooms: { id: "1", title: "" }, case_messages: {} } as any });
    const peer = mockClient();
    const view = (await sendAndAwait(ws, peer, { action: "open", doc: "case-room:1" })).result;
    await sendAndAwait(ws, mockClient(), { action: "delta", doc: "case-room:1", ops: [{ op: "add", path: "/case_messages/-", value: { text: "hello" } }] });
    for (let i = 0; i < 50 && !published.length; i++) await Bun.sleep(20);
    for (const m of published) applyOps(view, m.ops);
    const [[key, row]] = Object.entries(view.case_messages as Record<string, any>) as [string, any][];
    expect(key).not.toBe("-");
    expect(String(row.id)).toBe(key);
    try { unlinkSync(file); } catch {}
  });

  test("/- on an array still appends", async () => {
    const file = `/tmp/delta-create-row-arr-${Date.now()}.json`;
    const ws = createWs();
    const h = await registerDoc(ws, "list", { file, empty: { items: [] as string[] } });
    h.applyAndBroadcast([{ op: "add", path: "/items/-", value: "a" }]);
    expect(h.getDoc()).toEqual({ items: ["a"] });
    try { unlinkSync(file); } catch {}
  });
});

describe("a memory document", () => {
  test("add /coll/- names its row (#14)", async () => {
    const ws = createWs();
    const here = registerMemory(ws, { prefix: "cr-here:", empty: () => ({ cr_messages: {} as Record<string, any> }), writable: "any" });
    const r = await sendAndAwait(ws, mockClient(), { action: "delta", doc: "cr-here:1", ops: [{ op: "add", path: "/cr_messages/-", value: { text: "hello" } }] });
    expect(r.error).toBeUndefined();
    const rows = here.peek("cr-here:1")!.cr_messages;
    expect(Object.keys(rows)).not.toContain("-");
    for (const [key, row] of Object.entries(rows)) expect(String((row as any).id)).toBe(key);
  });

  test("/- on an array still appends (#14)", async () => {
    const ws = createWs();
    const here = registerMemory(ws, { prefix: "cr-list:", empty: () => ({ items: [] as string[] }), writable: "any" });
    const r = await sendAndAwait(ws, mockClient(), { action: "delta", doc: "cr-list:1", ops: [{ op: "add", path: "/items/-", value: "a" }] });
    expect(r.result.ops).toEqual([{ op: "add", path: "/items/-", value: "a" }]);
    expect(here.peek("cr-list:1")).toEqual({ items: ["a"] });
  });
});
