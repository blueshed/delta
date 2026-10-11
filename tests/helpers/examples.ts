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

/**
 * sites-bbox's README, step by step: a box open on `viewer`, sites written
 * through `world` on `writer` (the same server, or another on the same rows).
 * A site moving into the box is added to it, within it replaced, out of it or
 * deleted removed; a site outside every box is never sent. Ends with the box
 * holding what a fresh open of it holds.
 */
export async function bboxStory(writer: string, viewer: string, world: string): Promise<void> {
  const [w, v, late] = [connectWs(writer), connectWs(viewer), connectWs(viewer)];
  try {
    const box = openDoc<any>("sites-in-bbox:0,0,50,50", v);
    const heard: DeltaOp[][] = [];
    box.onOps((ops) => heard.push(ops));
    const doc = openDoc<any>(world, w);
    await Promise.all([box.ready, doc.ready]);
    expect(box.data.get()).toEqual({ sites: {} });

    const told = async (n: number) => {
      await waitFor(() => heard.length >= n);
      return heard[n - 1]!.map(({ op, path }) => ({ op, path: path.split("/").slice(0, 3).join("/") }));   // the row, whether told whole or by field
    };
    const site = (name: string) => Object.values<any>(doc.data.get().sites).find((s) => s.name === name);

    await doc.send([
      { op: "add", path: "/sites/-", value: { name: "Outside", lat: 80, lng: 80 } },
      { op: "add", path: "/sites/-", value: { name: "Inside", lat: 10, lng: 20 } },
    ]);
    const [inside, outside] = [site("Inside").id, site("Outside").id];
    expect(await told(1)).toEqual([{ op: "add", path: `/sites/${inside}` }]);   // Outside never sent

    await doc.send([{ op: "replace", path: `/sites/${outside}/lat`, value: 5 }, { op: "replace", path: `/sites/${outside}/lng`, value: 5 }]);
    expect(await told(2)).toEqual([{ op: "add", path: `/sites/${outside}` }]);   // into the box

    await doc.send([{ op: "replace", path: `/sites/${inside}/lat`, value: 11 }]);
    expect(await told(3)).toEqual([{ op: "replace", path: `/sites/${inside}` }]);   // within it
    expect(box.data.get().sites[inside].lat).toBe(11);

    const fresh = openDoc<any>("sites-in-bbox:0,0,50,50", late);
    await fresh.ready;
    expect(box.data.get()).toEqual(fresh.data.get());   // live, it holds what an open reads

    await doc.send([{ op: "replace", path: `/sites/${outside}/lat`, value: 80 }]);
    expect(await told(4)).toEqual([{ op: "remove", path: `/sites/${outside}` }]);   // out of it
    await doc.send([{ op: "remove", path: `/sites/${inside}` }]);
    expect(await told(5)).toEqual([{ op: "remove", path: `/sites/${inside}` }]);   // deleted
    expect(box.data.get()).toEqual({ sites: {} });
  } finally {
    for (const c of [w, v, late]) c.close();
  }
}
