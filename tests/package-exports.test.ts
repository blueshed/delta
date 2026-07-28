/**
 * Package export map — resolvable-from-outside checks.
 *
 * `package.json` declared `main`/`types` but its `exports` map had no `"."`
 * key. When `exports` is present, `main` is IGNORED, so the bare specifier
 * `import ... from "@blueshed/delta"` threw ERR_PACKAGE_PATH_NOT_EXPORTED and
 * those two fields actively misled — while being the first import anyone
 * writes (TODO.md #11).
 *
 * Asserting the JSON alone would be circular, so each subpath is resolved for
 * real: a temp package with a symlink to this repo, importing through the
 * published specifier exactly as a consumer would.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const repoRoot = join(import.meta.dir, "..");
const pkg = await Bun.file(join(repoRoot, "package.json")).json();

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "delta-exports-"));
  const scope = join(sandbox, "node_modules", "@blueshed");
  mkdirSync(scope, { recursive: true });
  symlinkSync(repoRoot, join(scope, "delta"), "dir");
  // Mark it a module so the probe files are treated as ESM.
  writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));
});

afterAll(() => {
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
});

/** Import `specifier` from a throwaway package; resolve to its exit code + stderr. */
async function importFrom(specifier: string, named: string) {
  const file = join(sandbox, `probe-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, `import { ${named} } from "${specifier}";\n`
    + `if (typeof ${named} === "undefined") { throw new Error("missing export: ${named}"); }\n`);
  const proc = Bun.spawn(["bun", file], { cwd: sandbox, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

describe("package exports", () => {
  test('the bare specifier "@blueshed/delta" resolves', async () => {
    const { code, stderr } = await importFrom("@blueshed/delta", "applyOps");
    expect(stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(code).toBe(0);
  });

  test('"." is declared and agrees with main/types', () => {
    // main/types are only reachable when a matching "." export exists; if a
    // future edit drops one of the three they must not drift apart silently.
    expect(pkg.exports["."]).toBeDefined();
    expect(pkg.exports["."]).toBe(`./${pkg.main}`);
    expect(pkg.exports["."]).toBe(`./${pkg.types}`);
  });

  test("the bare specifier and ./core are the same module", async () => {
    const file = join(sandbox, "same.ts");
    writeFileSync(file,
      `import * as bare from "@blueshed/delta";\n` +
      `import * as core from "@blueshed/delta/core";\n` +
      `if (bare.applyOps !== core.applyOps) throw new Error("bare and ./core diverged");\n`);
    const proc = Bun.spawn(["bun", file], { cwd: sandbox, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
  });

  // Every declared subpath, so a typo or a moved file is caught at the map
  // level rather than by whichever consumer imports it first.
  const probes: Record<string, string> = {
    "./core": "applyOps",
    "./client": "openDoc",
    "./dom-ops": "applyOpsToCollection",
    "./server": "createWs",
    "./sqlite": "registerDocs",
    "./postgres": "createDocListener",
    "./logger": "createLogger",
    "./auth": "wireAuth",
    "./auth-jwt": "jwtAuth",
  };

  test("every declared subpath is covered by this test", () => {
    const declared = Object.keys(pkg.exports).filter((k) => k !== ".").sort();
    expect(declared).toEqual(Object.keys(probes).sort());
  });

  for (const [subpath, named] of Object.entries(probes)) {
    // Keys carry the exports-map's leading "." — drop it to get the specifier
    // a consumer writes ("./core" -> "@blueshed/delta/core").
    const specifier = `@blueshed/delta${subpath.slice(1)}`;
    test(`"${specifier}" resolves`, async () => {
      const { code, stderr } = await importFrom(specifier, named);
      if (code !== 0) console.log(`STDERR ${specifier} >>`, stderr.slice(0, 400));
      expect(stderr).not.toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
      expect(code).toBe(0);
    });
  }
});
