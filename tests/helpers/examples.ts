/**
 * Running an example as its README says: `bun examples/<x>/<file>` on a free
 * port, read until it says where it is; and the sites-bbox story, the same
 * client steps against either of its servers.
 */
import { expect } from "bun:test";
import { join } from "node:path";
import { connectWs, openDoc, type DeltaOp } from "../../src/client/client";
import { waitFor } from "../../src/testing";

(globalThis as any).location ??= { href: "http://localhost/", protocol: "http:" };

export type Proc = Bun.Subprocess<"ignore", "pipe", "pipe">;

/** Reads a process's stdout until `pattern` matches; fails if it exits first. */
export async function until(proc: Proc, pattern: RegExp): Promise<RegExpExecArray> {
  const reader = proc.stdout.getReader();
  let out = "";
  for (;;) {
    const m = pattern.exec(out);
    if (m) { reader.releaseLock(); return m; }
    const { value, done } = await reader.read();
    if (done) throw new Error(`exited before ${pattern}: ${out}${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
}

const root = join(import.meta.dir, "../..");

/** `bun examples/<file>` with PORT=0, run from `cwd` (the repo by default). */
export function runExample(file: string, env: Record<string, string> = {}, cwd = root): Proc {
  return Bun.spawn(["bun", join(root, "examples", file)], {
    cwd, env: { ...process.env, PORT: "0", ...env }, stdout: "pipe", stderr: "pipe",
  });
}

export async function stop(...procs: Proc[]): Promise<void> {
  for (const p of procs) p.kill();
  await Promise.all(procs.map((p) => p.exited));
}

/** lng 10..50, lat 0..30: not square, so lat and lng cannot be swapped unseen. */
const BOX = "sites-in-bbox:10,0,50,30";

/**
 * sites-bbox's README, step by step: sites written through `world` on
 * `writer`, a box open on `viewer` (the same server, or another on the same
 * rows). Opened, the box reads the sites in it; then a site moving into it is
 * added, within it told the fields that changed, out of it or deleted removed, and a site outside
 * is never sent. "Askew" sites are in on lng and out on lat: they stay out.
 */
export async function bboxStory(writer: string, viewer: string, world: string): Promise<void> {
  const [w, v, late] = [connectWs(writer), connectWs(viewer), connectWs(viewer)];
  try {
    const doc = openDoc<any>(world, w);
    await doc.ready;
    const site = (name: string) => Object.values<any>(doc.data.get().sites).find((s) => s.name === name).id;
    await doc.send([
      { op: "add", path: "/sites/-", value: { name: "Outside", lat: 80, lng: 80 } },
      { op: "add", path: "/sites/-", value: { name: "Inside", lat: 10, lng: 20 } },
      { op: "add", path: "/sites/-", value: { name: "Askew", lat: 40, lng: 20 } },
    ]);
    const [inside, outside] = [site("Inside"), site("Outside")];

    const box = openDoc<any>(BOX, v);
    const heard: DeltaOp[][] = [];
    box.onOps((ops) => heard.push(ops));
    await box.ready;
    expect(Object.keys(box.data.get().sites)).toEqual([String(inside)]);   // its query: not Outside, not Askew

    const told = async (n: number) => {
      await waitFor(() => heard.length >= n);
      return heard[n - 1]!.map(({ op, path }) => ({ op, path: path.split("/").slice(0, 3).join("/") }));   // the row an add or a remove is of
    };

    await doc.send([
      { op: "add", path: "/sites/-", value: { name: "Askew too", lat: 40, lng: 20 } },
      { op: "replace", path: `/sites/${outside}/lat`, value: 5 },   // still out on lng
      { op: "replace", path: `/sites/${outside}/lng`, value: 15 },
    ]);
    expect(await told(1)).toEqual([{ op: "add", path: `/sites/${outside}` }]);   // into the box; Askew too never sent

    await doc.send([{ op: "replace", path: `/sites/${inside}/lat`, value: 11 }]);
    await told(2);
    expect(heard[1]).toEqual([{ op: "replace", path: `/sites/${inside}/lat`, value: 11 }]);   // within it: told the field that changed
    expect(box.data.get().sites[inside].lat).toBe(11);

    const fresh = openDoc<any>(BOX, late);
    await fresh.ready;
    expect(box.data.get()).toEqual(fresh.data.get());   // live, it holds what an open reads

    await doc.send([{ op: "replace", path: `/sites/${outside}/lat`, value: 80 }]);
    expect(await told(3)).toEqual([{ op: "remove", path: `/sites/${outside}` }]);   // out of it
    await doc.send([{ op: "remove", path: `/sites/${inside}` }]);
    expect(await told(4)).toEqual([{ op: "remove", path: `/sites/${inside}` }]);   // deleted
    expect(box.data.get()).toEqual({ sites: {} });
  } finally {
    for (const c of [w, v, late]) c.close();
  }
}
