#!/usr/bin/env bun
/**
 * @blueshed/delta CLI.
 *
 *   delta sql <module> [--out <file>] [--force] [--schema-export <name>] [--docs-export <name>]
 *     Regenerate a tables SQL file from a TypeScript schema module.
 *     Refuses to overwrite an existing --out file that wasn't produced by
 *     delta sql (no generated-file header) unless --force is given.
 *
 *   delta init <dir> [--with-auth] [--upgrade]
 *     Copy the framework SQL files into <dir> (typically your init_db/).
 *     --with-auth also copies the reference auth-jwt.sql (users + register/login).
 *     --upgrade replaces existing files with .bak backups, preserving versioning.
 *
 * The init command stamps each copied file with a version header read from
 * this package's package.json so you can `diff -u` against a future
 * `delta init --upgrade` and see exactly what changed.
 */
import { parseArgs } from "node:util";
import { resolve, basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { generateSql } from "./src/server/postgres/codegen";
import { frameworkSqlFiles } from "./src/server/postgres/bootstrap";
import { authJwtSqlFile } from "./src/server/auth-jwt-sql";
import type { Schema, DocDef } from "./src/server/postgres";

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "package.json"), "utf8"),
    );
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

function usage(code = 0): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    `Usage:\n` +
    `  delta sql <module> [--out <file>] [--force] [--schema-export <name>] [--docs-export <name>]\n` +
    `  delta init <dir> [--with-auth] [--upgrade]\n` +
    `  delta install-skills [--user] [--dry-run]\n` +
    `\n` +
    `  delta open  <docName>                  Open a doc, print its state, exit.\n` +
    `  delta watch <docName>                  Open a doc, then stream broadcast ops.\n` +
    `  delta delta <docName> <opsJSON>        Apply JSON-Patch ops to a doc.\n` +
    `  delta call  <method>  [paramsJSON]     Invoke an RPC method.\n` +
    `\n` +
    `URL resolution for runtime commands (in order):\n` +
    `  --url <url>  |  DELTA_WS_URL  |  .delta file  |  ws://localhost:\${PORT:-3100}/ws\n`,
  );
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Runtime CLI — open / watch / delta / call against a running delta server.
// ---------------------------------------------------------------------------

function resolveWsUrl(values: Record<string, unknown>): string {
  const flag = values.url as string | undefined;
  if (flag) return flag;
  if (process.env.DELTA_WS_URL) return process.env.DELTA_WS_URL;
  try {
    const fromFile = readFileSync(resolve(process.cwd(), ".delta"), "utf8").trim();
    if (fromFile) return fromFile;
  } catch {}
  return `ws://localhost:${process.env.PORT ?? "3100"}/ws`;
}

interface PendingResolver {
  resolve: (v: any) => void;
  reject: (e: any) => void;
}

async function withWs<T>(
  url: string,
  fn: (api: {
    send: (msg: any) => Promise<any>;
    onBroadcast: (handler: (msg: any) => void) => void;
  }) => Promise<T>,
): Promise<T> {
  const ws = new WebSocket(url);
  const pending = new Map<number, PendingResolver>();
  const broadcastHandlers = new Set<(msg: any) => void>();
  let nextId = 1;

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: any) => reject(new Error(`WebSocket error: ${e?.message ?? "connection failed"}`));
  });

  ws.onmessage = (ev: MessageEvent) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch (err) {
      // A malformed frame shouldn't crash the command — warn and keep going.
      process.stderr.write(
        `delta: ignoring malformed frame: ${(err as Error).message}\n`,
      );
      return;
    }
    try {
      if (msg.id != null && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(msg.error);
        else p.resolve(msg.result);
        return;
      }
      // Unsolicited broadcast (no id).
      for (const h of broadcastHandlers) h(msg);
    } catch (err) {
      process.stderr.write(
        `delta: error handling frame: ${(err as Error).message}\n`,
      );
    }
  };

  ws.onclose = () => {
    for (const p of pending.values()) p.reject(new Error("socket closed"));
    pending.clear();
  };

  const api = {
    send(msg: any): Promise<any> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ ...msg, id }));
      });
    },
    onBroadcast(handler: (msg: any) => void) { broadcastHandlers.add(handler); },
  };

  try {
    return await fn(api);
  } finally {
    try { ws.close(); } catch {}
  }
}

function parseJsonArg(s: string | undefined, label: string): unknown {
  if (s === undefined) return undefined;
  try { return JSON.parse(s); }
  catch (err) {
    process.stderr.write(`delta: ${label} is not valid JSON: ${(err as Error).message}\n`);
    process.exit(2);
  }
}

async function cmdOpen(docName: string | undefined, values: Record<string, unknown>) {
  if (!docName) usage(1);
  const url = resolveWsUrl(values);
  const result = await withWs(url, ({ send }) =>
    send({ action: "open", doc: docName }),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function cmdWatch(docName: string | undefined, values: Record<string, unknown>) {
  if (!docName) usage(1);
  const url = resolveWsUrl(values);
  process.stderr.write(`watching ${docName} on ${url} (Ctrl-C to stop)\n`);
  await withWs(url, ({ send, onBroadcast }) =>
    new Promise<never>(async (_, reject) => {
      onBroadcast((msg) => {
        if (msg.doc === docName) process.stdout.write(JSON.stringify(msg) + "\n");
      });
      try {
        const result = await send({ action: "open", doc: docName });
        process.stderr.write(`opened ${docName}\n`);
        process.stdout.write(JSON.stringify({ doc: docName, state: result }) + "\n");
      } catch (err) { reject(err); }
    }),
  );
}

async function cmdDelta(
  docName: string | undefined,
  opsJson: string | undefined,
  values: Record<string, unknown>,
) {
  if (!docName || !opsJson) usage(1);
  const ops = parseJsonArg(opsJson, "ops") as unknown;
  if (!Array.isArray(ops)) {
    process.stderr.write(`delta: ops must be a JSON array\n`);
    process.exit(2);
  }
  const url = resolveWsUrl(values);
  const result = await withWs(url, async ({ send }) => {
    // SQLite's registerDocs requires the doc to be cached before delta;
    // opening on the same socket is the cheapest way to guarantee it.
    await send({ action: "open", doc: docName });
    return send({ action: "delta", doc: docName, ops });
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

async function cmdCall(
  method: string | undefined,
  paramsJson: string | undefined,
  values: Record<string, unknown>,
) {
  if (!method) usage(1);
  const params = parseJsonArg(paramsJson, "params");
  const url = resolveWsUrl(values);
  const result = await withWs(url, ({ send }) =>
    send({ action: "call", method, params: params ?? {} }),
  );
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Header handling — identifies files written by delta init so upgrades can
// read them back and avoid clobbering user-owned SQL.
// ---------------------------------------------------------------------------

const HEADER_RE = /^-- @blueshed\/delta ([a-z0-9-]+) v(\d+\.\d+\.\d+)/;

function headerFor(kind: "framework" | "auth-jwt"): string {
  return (
    `-- @blueshed/delta ${kind} v${PKG_VERSION}\n` +
    `-- Vendored by 'delta init'. Safe to read; prefer 'delta init --upgrade' over hand edits.\n\n`
  );
}

function readHeader(path: string): { kind: string; version: string } | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  const m = first.match(HEADER_RE);
  return m ? { kind: m[1]!, version: m[2]! } : null;
}

function writeWithHeader(src: string, dest: string, kind: "framework" | "auth-jwt"): void {
  const body = readFileSync(src, "utf8");
  writeFileSync(dest, headerFor(kind) + body);
}

/**
 * Back up `dest` to `dest + ".bak"` without destroying a pre-existing backup.
 * If `dest.bak` already exists, fall back to `.bak.1`, `.bak.2`, … so an
 * earlier backup the user may still need is preserved. Returns the path the
 * backup was written to.
 */
function backupFile(dest: string): string {
  let bak = dest + ".bak";
  if (existsSync(bak)) {
    let n = 1;
    while (existsSync(`${dest}.bak.${n}`)) n++;
    bak = `${dest}.bak.${n}`;
    process.stderr.write(
      `Note: ${basename(dest)}.bak already exists; backing up to ${basename(bak)} instead.\n`,
    );
  }
  copyFileSync(dest, bak);
  return bak;
}

// ---------------------------------------------------------------------------
// delta sql
// ---------------------------------------------------------------------------

// Stable substring of the codegen header (see src/server/postgres/codegen.ts:
// "GENERATED FROM types.ts — DO NOT EDIT"). Matching on the leading words
// avoids depending on the em-dash byte sequence.
const GENERATED_MARKER = "GENERATED FROM";

async function cmdSql(modulePath: string | undefined, values: Record<string, unknown>) {
  if (!modulePath) usage(1);

  const abs = resolve(process.cwd(), modulePath);
  let mod: Record<string, unknown>;
  try {
    mod = await import(abs);
  } catch (err) {
    // Bun surfaces a `ResolveMessage` whose `.message` is a single useful line
    // (e.g. "Cannot find module '…'") but is fronted by the class-name prefix;
    // strip it to a clean one-liner instead of dumping the raw object/stack.
    const raw =
      err instanceof Error ? err.message.split("\n", 1)[0] : String(err);
    const reason = raw.replace(/^(ResolveMessage|BuildMessage|Error):\s*/, "");
    process.stderr.write(`Cannot load module "${modulePath}": ${reason}\n`);
    process.exit(2);
  }

  const schemaExport = (values["schema-export"] as string | undefined) ?? "schema";
  const docsExport = (values["docs-export"] as string | undefined) ?? "docs";
  const schema = mod[schemaExport] as Schema | undefined;
  const docs = mod[docsExport] as DocDef[] | undefined;

  if (!schema || typeof schema !== "object" || !("tables" in schema)) {
    process.stderr.write(
      `Module at ${modulePath} does not export a Schema as \`${schemaExport}\`.\n` +
      `Export one with: export const ${schemaExport} = defineSchema({ ... });\n`,
    );
    process.exit(2);
  }
  if (!Array.isArray(docs)) {
    process.stderr.write(
      `Module at ${modulePath} does not export a DocDef[] as \`${docsExport}\`.\n` +
      `Export one with: export const ${docsExport} = [defineDoc(...), ...];\n`,
    );
    process.exit(2);
  }

  const sql = generateSql(schema, docs);
  const out = values.out as string | undefined;
  const force = !!values.force;

  if (out) {
    const absOut = resolve(out);
    // Guard: never silently clobber a file we didn't generate. A previously
    // generated file carries the codegen header marker and is safe to replace;
    // anything else needs --force.
    if (existsSync(absOut) && !force) {
      const existing = readFileSync(absOut, "utf8");
      if (!existing.includes(GENERATED_MARKER)) {
        process.stderr.write(
          `Refusing to overwrite ${out}: it has no generated-file header ` +
          `(not produced by 'delta sql').\n` +
          `Pass --force to overwrite it anyway.\n`,
        );
        process.exit(3);
      }
      // It's a previously generated file — back it up before replacing.
      backupFile(absOut);
    }
    if (!existsSync(dirname(absOut))) {
      mkdirSync(dirname(absOut), { recursive: true });
    }
    await Bun.write(out, sql);
    process.stderr.write(`Wrote ${out} (${sql.length} bytes)\n`);
  } else {
    process.stdout.write(sql);
  }
}

// ---------------------------------------------------------------------------
// delta init
// ---------------------------------------------------------------------------

interface CopyPlan {
  src: string;
  dest: string;
  kind: "framework" | "auth-jwt";
}

function buildCopyPlan(absDir: string, withAuth: boolean): CopyPlan[] {
  const plan: CopyPlan[] = [];
  for (const src of frameworkSqlFiles()) {
    plan.push({ src, dest: join(absDir, basename(src)), kind: "framework" });
  }
  if (withAuth) {
    plan.push({ src: authJwtSqlFile(), dest: join(absDir, "002-users.sql"), kind: "auth-jwt" });
  }
  return plan;
}

function cmdInit(dir: string | undefined, values: Record<string, unknown>) {
  if (!dir) usage(1);

  const absDir = resolve(process.cwd(), dir);
  if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

  const upgrade = !!values.upgrade;
  const withAuth = !!values["with-auth"];
  const plan = buildCopyPlan(absDir, withAuth);

  // On upgrade we refuse to clobber files that don't have our header or that
  // point to a newer version than we ship. The user either wrote that file
  // themselves or has downgraded the package.
  if (upgrade) {
    const conflicts: string[] = [];
    for (const { dest } of plan) {
      if (!existsSync(dest)) continue;
      const hdr = readHeader(dest);
      if (!hdr) conflicts.push(`${basename(dest)}: not stamped by delta init`);
      else if (compareVersion(hdr.version, PKG_VERSION) > 0) {
        conflicts.push(`${basename(dest)}: has v${hdr.version}, package is v${PKG_VERSION}`);
      }
    }
    if (conflicts.length) {
      process.stderr.write(
        `Refusing to upgrade:\n  ${conflicts.join("\n  ")}\n\n` +
        `Resolve these manually (move or rename the offending files) and rerun.\n`,
      );
      process.exit(3);
    }
  }

  const created: string[] = [];
  const upgraded: string[] = [];
  const unchanged: string[] = [];

  for (const { src, dest, kind } of plan) {
    if (existsSync(dest)) {
      const existing = readHeader(dest);
      if (!upgrade) {
        unchanged.push(basename(dest));
        continue;
      }
      if (existing?.version === PKG_VERSION) {
        unchanged.push(basename(dest));
        continue;
      }
      const bak = backupFile(dest);
      writeWithHeader(src, dest, kind);
      upgraded.push(`${basename(dest)} (backup at ${basename(bak)})`);
    } else {
      writeWithHeader(src, dest, kind);
      created.push(basename(dest));
    }
  }

  const lines: string[] = [];
  if (created.length) lines.push("Created:\n  " + created.join("\n  "));
  if (upgraded.length) lines.push("Upgraded:\n  " + upgraded.join("\n  "));
  if (unchanged.length) lines.push("Unchanged:\n  " + unchanged.join("\n  "));
  process.stderr.write((lines.join("\n\n") || "Nothing to do.") + "\n");

  if (created.length || upgraded.length) {
    process.stderr.write(
      `\nNext: regenerate your table SQL from types.ts:\n` +
      `  bunx delta sql ./types.ts --out ${dir}/003-tables.sql\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// delta install-skills
//
// Vendor Claude Code skills into the consumer's .claude/skills/ directory.
// Discovers skills from:
//   - this package itself  (delta-doc)
//   - any sibling package in node_modules with `.claude/skills/<name>/SKILL.md`
//     (e.g. @blueshed/railroad ships `railroad` and `bun-route`)
//
// Skills aren't versioned like SQL — we always overwrite, but back up the
// existing file as `.bak` so a consumer who edited their copy doesn't lose
// it. Bytewise-identical destinations are skipped.
// ---------------------------------------------------------------------------

interface SkillSource {
  name: string;     // e.g. "delta-doc", "railroad", "bun-route"
  srcDir: string;   // absolute path to the skill directory
  origin: string;   // e.g. "@blueshed/delta", "@blueshed/railroad" — for the log
}

function listSkillsIn(skillsRoot: string, origin: string): SkillSource[] {
  if (!existsSync(skillsRoot)) return [];
  const out: SkillSource[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsRoot, entry.name);
    if (existsSync(join(dir, "SKILL.md"))) {
      out.push({ name: entry.name, srcDir: dir, origin });
    }
  }
  return out;
}

function findNodeModulesDir(start: string): string | null {
  // Walk up looking for the first node_modules dir that contains us.
  // This handles dev (running from the delta repo, where ./node_modules holds
  // sibling packages like railroad) and consumer use (where the consumer's
  // node_modules holds @blueshed/delta and any other sibling packages).
  let cur = resolve(start);
  while (true) {
    const candidate = join(cur, "node_modules");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

function discoverSkillSources(): SkillSource[] {
  const sources: SkillSource[] = [];
  const seenNames = new Set<string>();

  // Our own skill — always present, ships in this package.
  const ownRoot = resolve(import.meta.dir, ".claude/skills");
  for (const s of listSkillsIn(ownRoot, "@blueshed/delta")) {
    if (!seenNames.has(s.name)) { sources.push(s); seenNames.add(s.name); }
  }

  // Sibling packages. Look in both: the package the CLI lives in (its own
  // node_modules during dev) AND the consumer's cwd-rooted node_modules.
  const candidateRoots = new Set<string>();
  for (const start of [import.meta.dir, process.cwd()]) {
    const nm = findNodeModulesDir(start);
    if (nm) candidateRoots.add(nm);
  }

  for (const nm of candidateRoots) {
    // Walk node_modules: scoped (@scope/pkg) AND unscoped (pkg).
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(nm, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pkgDirs: { name: string; dir: string }[] = [];
      if (entry.name.startsWith("@")) {
        let subEntries: import("node:fs").Dirent[];
        try { subEntries = readdirSync(join(nm, entry.name), { withFileTypes: true }); }
        catch { continue; }
        for (const sub of subEntries) {
          if (sub.isDirectory()) {
            pkgDirs.push({ name: `${entry.name}/${sub.name}`, dir: join(nm, entry.name, sub.name) });
          }
        }
      } else {
        pkgDirs.push({ name: entry.name, dir: join(nm, entry.name) });
      }
      for (const { name, dir } of pkgDirs) {
        // Skip ourselves (we already added via ownRoot above).
        if (name === "@blueshed/delta") continue;
        const skillsRoot = join(dir, ".claude/skills");
        for (const s of listSkillsIn(skillsRoot, name)) {
          if (!seenNames.has(s.name)) { sources.push(s); seenNames.add(s.name); }
        }
      }
    }
  }

  return sources;
}

type CopyAction = "created" | "upgraded" | "unchanged";

function copyDirWithBackup(
  src: string,
  dest: string,
  dryRun: boolean,
  onFile: (relPath: string, action: CopyAction) => void,
  prefix = "",
): void {
  if (!dryRun) mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      copyDirWithBackup(srcPath, destPath, dryRun, onFile, rel);
      continue;
    }
    if (!entry.isFile()) continue;
    if (existsSync(destPath)) {
      const a = readFileSync(srcPath);
      const b = readFileSync(destPath);
      if (a.equals(b)) { onFile(rel, "unchanged"); continue; }
      if (!dryRun) {
        backupFile(destPath);
        copyFileSync(srcPath, destPath);
      }
      onFile(rel, "upgraded");
    } else {
      if (!dryRun) copyFileSync(srcPath, destPath);
      onFile(rel, "created");
    }
  }
}

function cmdInstallSkills(values: Record<string, unknown>): void {
  const user = !!values.user;
  const dryRun = !!values["dry-run"];
  const root = user
    ? join(homedir(), ".claude/skills")
    : resolve(process.cwd(), ".claude/skills");

  const sources = discoverSkillSources();
  if (sources.length === 0) {
    process.stderr.write(
      `install-skills: no skills found (expected delta-doc bundled with this package).\n`,
    );
    process.exit(2);
  }

  process.stderr.write(
    `${dryRun ? "[dry-run] " : ""}Installing ${sources.length} skill(s) → ${root}\n`,
  );

  for (const { name, srcDir, origin } of sources) {
    const destDir = join(root, name);
    const created: string[] = [];
    const upgraded: string[] = [];
    const unchanged: string[] = [];
    copyDirWithBackup(srcDir, destDir, dryRun, (rel, action) => {
      if (action === "created") created.push(rel);
      else if (action === "upgraded") upgraded.push(rel);
      else unchanged.push(rel);
    });
    const parts: string[] = [];
    if (created.length) parts.push(`+${created.join(", ")}`);
    if (upgraded.length) parts.push(`~${upgraded.join(", ")} (.bak)`);
    if (unchanged.length) parts.push(`=${unchanged.join(", ")}`);
    process.stderr.write(`  ${name}  [${origin}]  ${parts.join("  ") || "nothing to do"}\n`);
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", short: "o" },
      force: { type: "boolean", default: false },
      "schema-export": { type: "string", default: "schema" },
      "docs-export": { type: "string", default: "docs" },
      "with-auth": { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
      user: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      url: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) usage(0);

  const cmd = positionals[0];
  const arg = positionals[1];
  const arg2 = positionals[2];

  switch (cmd) {
    case "sql":             return cmdSql(arg, values);
    case "init":            return cmdInit(arg, values);
    case "install-skills":  return cmdInstallSkills(values);
    case "open":            return cmdOpen(arg, values);
    case "watch":           return cmdWatch(arg, values);
    case "delta":           return cmdDelta(arg, arg2, values);
    case "call":            return cmdCall(arg, arg2, values);
    default:                usage(1);
  }
}

main().catch((err) => {
  let msg: string;
  if (err instanceof Error) msg = err.message;
  else if (err && typeof err === "object") msg = JSON.stringify(err);
  else msg = String(err);
  process.stderr.write(`delta: ${msg}\n`);
  process.exit(1);
});
