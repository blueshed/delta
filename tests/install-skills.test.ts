/**
 * Tests for `bunx delta install-skills` — drives cli.ts as a subprocess against
 * a temp directory layout so the discovery + copy logic is exercised end-to-end.
 *
 * We don't import the CLI internals; install-skills is shaped around fs side
 * effects + cwd-relative paths, and the surface that matters is what a consumer
 * sees on disk. Subprocess tests catch wiring bugs (parseArgs typos, missing
 * switch case) that an in-process test would miss.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(import.meta.dir, "..", "cli.ts");

function makeSkill(root: string, pkgName: string, skillName: string, files: Record<string, string>): void {
  const dir = join(root, "node_modules", ...pkgName.split("/"), ".claude", "skills", skillName);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
}

async function runCli(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { stdout, stderr, code };
}

async function runInstall(cwd: string, ...extra: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCli(cwd, "install-skills", ...extra);
}

describe("install-skills", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delta-install-skills-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("installs delta-doc into ./.claude/skills/ on a fresh cwd", async () => {
    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    // The bundled delta-doc skill ships SKILL.md + reference.md.
    expect(existsSync(join(dir, ".claude/skills/delta-doc/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/delta-doc/reference.md"))).toBe(true);
    // Stderr names the origin so the user sees where each skill came from.
    expect(res.stderr).toContain("delta-doc");
    expect(res.stderr).toContain("@blueshed/delta");
  });

  test("dry-run reports what would happen without touching disk", async () => {
    const res = await runInstall(dir, "--dry-run");
    expect(res.code).toBe(0);
    expect(res.stderr).toContain("[dry-run]");
    expect(existsSync(join(dir, ".claude/skills/delta-doc/SKILL.md"))).toBe(false);
  });

  test("re-running on an unchanged tree reports everything as unchanged", async () => {
    await runInstall(dir);
    const second = await runInstall(dir);
    expect(second.code).toBe(0);
    // Marker '=' means unchanged in the CLI's tight format.
    expect(second.stderr).toMatch(/=.*SKILL\.md/);
    // No .bak files appear if nothing was overwritten.
    expect(existsSync(join(dir, ".claude/skills/delta-doc/SKILL.md.bak"))).toBe(false);
  });

  test("overwrites a locally edited file and leaves a .bak behind", async () => {
    await runInstall(dir);
    const target = join(dir, ".claude/skills/delta-doc/SKILL.md");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, "locally edited\n");

    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    // Marker '~' means upgraded.
    expect(res.stderr).toMatch(/~.*SKILL\.md/);

    expect(readFileSync(target, "utf8")).toBe(original);
    expect(readFileSync(target + ".bak", "utf8")).toBe("locally edited\n");
  });

  test("discovers a third-party skill from a sibling @scope/pkg in node_modules", async () => {
    // Lay down a fake sibling package that ships two skills, the way
    // @blueshed/railroad does in real consumer node_modules.
    makeSkill(dir, "@acme/widgets", "widgets-ui", {
      "SKILL.md": "# widgets-ui\n",
      "reference.md": "widgets reference\n",
    });
    makeSkill(dir, "@acme/widgets", "widgets-cli", {
      "SKILL.md": "# widgets-cli\n",
    });

    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    expect(existsSync(join(dir, ".claude/skills/widgets-ui/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".claude/skills/widgets-cli/SKILL.md"))).toBe(true);
    // Origin appears in the log so the user knows it came from a sibling.
    expect(res.stderr).toContain("@acme/widgets");
  });

  test("discovers a third-party skill from an unscoped sibling package", async () => {
    makeSkill(dir, "single-pkg", "single-skill", {
      "SKILL.md": "# single\n",
    });

    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    expect(existsSync(join(dir, ".claude/skills/single-skill/SKILL.md"))).toBe(true);
    expect(res.stderr).toContain("single-pkg");
  });

  test("ignores a sibling package that has no .claude/skills/ at all", async () => {
    // Just a plain package.json — no skills dir, no SKILL.md.
    const pkgDir = join(dir, "node_modules", "boring-lib");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "boring-lib" }));

    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    // Only the bundled delta-doc appears; boring-lib is silently skipped.
    expect(res.stderr).not.toContain("boring-lib");
  });

  test("does not clobber a pre-existing .bak when re-upgrading", async () => {
    await runInstall(dir);
    const target = join(dir, ".claude/skills/delta-doc/SKILL.md");
    const original = readFileSync(target, "utf8");

    // First local edit → upgrade leaves the edit in .bak.
    writeFileSync(target, "edit one\n");
    await runInstall(dir);
    expect(readFileSync(target + ".bak", "utf8")).toBe("edit one\n");

    // Second local edit → upgrade must NOT destroy the first .bak; the new
    // backup lands at .bak.1 instead.
    writeFileSync(target, "edit two\n");
    const res = await runInstall(dir);
    expect(res.code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(original);
    // Original backup preserved.
    expect(readFileSync(target + ".bak", "utf8")).toBe("edit one\n");
    // New backup written to a non-colliding name.
    expect(readFileSync(target + ".bak.1", "utf8")).toBe("edit two\n");
  });
});

// ---------------------------------------------------------------------------
// delta sql --out guard + bad-module error (CLI regressions)
// ---------------------------------------------------------------------------

const REPO_POSTGRES = resolve(import.meta.dir, "..", "src", "server", "postgres");

const TYPES_MODULE =
  `import { defineSchema, defineDoc } from ${JSON.stringify(REPO_POSTGRES)};\n` +
  `export const schema = defineSchema({ todos: { columns: { text: "text" }, temporal: false } });\n` +
  `export const docs = [defineDoc("todos:", { root: "todos", include: [] })];\n`;

describe("delta sql --out", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "delta-sql-out-"));
    writeFileSync(join(dir, "types.ts"), TYPES_MODULE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes a fresh --out file and stamps the generated header", async () => {
    const out = join(dir, "003-tables.sql");
    const res = await runCli(dir, "sql", "./types.ts", "--out", out);
    expect(res.code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("GENERATED FROM");
  });

  test("refuses to overwrite a non-generated --out file without --force", async () => {
    const out = join(dir, "hand-written.sql");
    writeFileSync(out, "-- my own SQL\nSELECT 1;\n");
    const res = await runCli(dir, "sql", "./types.ts", "--out", out);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("Refusing to overwrite");
    expect(res.stderr).toContain("--force");
    // File left untouched.
    expect(readFileSync(out, "utf8")).toBe("-- my own SQL\nSELECT 1;\n");
  });

  test("--force overwrites a non-generated --out file", async () => {
    const out = join(dir, "hand-written.sql");
    writeFileSync(out, "-- my own SQL\nSELECT 1;\n");
    const res = await runCli(dir, "sql", "./types.ts", "--out", out, "--force");
    expect(res.code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("GENERATED FROM");
  });

  test("overwrites a previously generated --out file and keeps a backup", async () => {
    const out = join(dir, "003-tables.sql");
    await runCli(dir, "sql", "./types.ts", "--out", out);
    const res = await runCli(dir, "sql", "./types.ts", "--out", out);
    expect(res.code).toBe(0);
    // Re-generated in place, with the prior generated copy backed up.
    expect(readFileSync(out, "utf8")).toContain("GENERATED FROM");
    expect(existsSync(out + ".bak")).toBe(true);
  });

  test("prints a friendly one-line error for a missing module path", async () => {
    const res = await runCli(dir, "sql", "./does-not-exist.ts");
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain('Cannot load module "./does-not-exist.ts"');
    // No raw ResolveMessage JSON blob / stack.
    expect(res.stderr).not.toContain("ResolveMessage");
    expect(res.stderr).not.toContain('"specifier"');
  });
});
