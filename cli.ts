#!/usr/bin/env bun
/** @blueshed/delta CLI: the commands are listed in `USAGE`. */
import { parseArgs } from "node:util";
import { resolve, basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
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

const USAGE =
    `Usage:\n` +
    `  delta sql <module> [--out <file>] [--force] [--schema-export <name>] [--docs-export <name>]\n` +
    `  delta init <dir> [--with-auth] [--upgrade]\n` +
    `  delta install-skills [--user] [--dry-run]\n` +
    `  delta migrate <database> [--app <name>] [--dir <migrations>] [--status]   run (or list) an app's migrations\n` +
    `        <database>: a SQLite file, a PGlite directory, or a postgres:// URL; --dir defaults to ./migrations\n` +
    `\n` +
    `  delta open  <docName>                  Open a doc, print its state, exit.\n` +
    `  delta watch <docName>                  Open a doc, then print each broadcast to it, a line each.\n` +
    `        [--count <n>] [--for <ms>] [--until "<op> <path>"]   exit 0 at the first that comes\n` +
    `  delta delta <docName> <opsJSON>        Apply JSON-Patch ops to a doc; print the ops as applied.\n` +
    `  delta call  <method>  [paramsJSON]     Invoke an RPC method.\n` +
    `\n` +
    `Runtime commands take:\n` +
    `  --url <url>  |  DELTA_WS_URL  |  .delta file  |  ws://localhost:\${PORT:-3100}/ws   (in order)\n` +
    `  --token <t>  |  DELTA_TOKEN    sent as call authenticate first, never in the URL\n` +
    `  --timeout <ms>  for connecting and for each answer (default 10000; 0 waits for ever)\n` +
    `  --json       one JSON line per event on stdout; an error is one {"error":{"code","message"}}\n` +
    `               line on stderr: code is the server's, or 0 when the CLI met it itself\n` +
    `\n` +
    `Exit codes: 0 done, 1 an error (the server's, the connection's), 2 a bad argument.\n`;

// ---------------------------------------------------------------------------
// Runtime CLI — open / watch / delta / call against a running delta server.
//
// For a person: answers pretty-printed, status on stderr. With --json, for a
// program (an agent): one JSON line per event on stdout, nothing else; an
// error is one {"error":{code,message}} line on stderr -- the server's, or
// code 0 for one the CLI met itself -- exit 1, or 2 for a bad argument.
// ---------------------------------------------------------------------------

let json = process.argv.includes("--json");   // before parsing: a flag parseArgs refuses is answered in kind

const print = (result: unknown) => process.stdout.write(JSON.stringify(result ?? null, null, json ? undefined : 2) + "\n");
const say = (line: string) => { if (!json) process.stderr.write(line + "\n"); };

/** An error: the server's `{ code, message }` as it is, or one the CLI met itself, code 0. Exits `exit`. */
function fail(err: unknown, exit = 1): never {
  const told = !!err && typeof err === "object" && !(err instanceof Error);
  const error = told ? { code: 0, ...(err as object) } : { code: 0, message: err instanceof Error ? err.message : String(err) };
  process.stderr.write((json ? JSON.stringify({ error }) : `delta: ${told ? JSON.stringify(err) : error.message}`) + "\n");
  process.exit(exit);
}

/** A bad argument: exit 2; a person is shown the usage too, when `show`. */
function usageError(why: string, show = false): never {
  if (show && !json) process.stderr.write(USAGE + "\n");
  fail(why, 2);
}

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

interface Api {
  send: (msg: any) => Promise<any>;
  onBroadcast: (handler: (msg: any) => void) => void;
  /** Rejects when the server closes the socket. */
  closed: Promise<never>;
}

/**
 * Connect, sign in when there is a token (`--token` or DELTA_TOKEN, sent as
 * `call authenticate`, never in the URL), run `fn`, close.
 */
async function withWs<T>(values: Record<string, unknown>, fn: (api: Api) => Promise<T>): Promise<T> {
  const url = resolveWsUrl(values);
  const timeout = wholeNumber(values.timeout ?? "10000", "--timeout");
  /** `p`, or an error once it has gone --timeout ms unsettled (0: wait for ever). */
  const within = <V>(p: Promise<V>, what: string): Promise<V> => {
    if (!timeout) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeout} ms: ${what}`)), timeout); });
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
  };
  const ws = new WebSocket(url);
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  const broadcastHandlers = new Set<(msg: any) => void>();
  let nextId = 1;
  let onClosed!: (err: Error) => void;
  const closed = new Promise<never>((_, reject) => (onClosed = reject));
  closed.catch(() => {});   // asked only by watch

  await within(new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e: any) => reject(new Error(`WebSocket error: ${e?.message ?? "connection failed"}`));
  }), `connecting to ${url}`);

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
    onClosed(new Error("socket closed"));
  };

  const api: Api = {
    send(msg: any): Promise<any> {
      const id = nextId++;
      return within(new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ ...msg, id }));
      }), msg.action === "call" ? `call ${msg.method}` : `${msg.action} ${msg.doc}`);
    },
    onBroadcast(handler: (msg: any) => void) { broadcastHandlers.add(handler); },
    closed,
  };

  try {
    const token = (values.token as string | undefined) ?? process.env.DELTA_TOKEN;
    if (token) await api.send({ action: "call", method: "authenticate", params: { token } });
    return await fn(api);
  } finally {
    ws.onclose = null;
    try { ws.close(); } catch {}
  }
}

function parseJsonArg(s: string | undefined, label: string): unknown {
  if (s === undefined) return undefined;
  try { return JSON.parse(s); }
  catch (err) { usageError(`${label} is not valid JSON: ${(err as Error).message}`); }
}

async function cmdOpen(docName: string | undefined, values: Record<string, unknown>) {
  if (!docName) usageError("open takes a <docName>", true);
  print(await withWs(values, ({ send }) => send({ action: "open", doc: docName })));
}

function wholeNumber(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) usageError(`${flag} takes a whole number, not ${value}`);
  return n;
}

/** `--until "<op> <path>"` or `--until <path>`: an op at that path or under it, of that verb if given. */
function untilOf(value: unknown): ((op: any) => boolean) | undefined {
  if (value === undefined) return undefined;
  const s = String(value);
  const at = s.indexOf("/");
  const verb = at < 0 ? "" : s.slice(0, at).trim();
  const path = s.slice(at);
  if (at < 0 || (verb && !["add", "replace", "remove"].includes(verb))) {
    usageError(`--until takes "<op> <path>" or "<path>", e.g. "add /items", not ${s}`);
  }
  return (op) => (!verb || op?.op === verb) && (op?.path === path || String(op?.path).startsWith(path + "/"));
}

/**
 * Print the doc's state, then each broadcast to it, one JSON line each. Ends,
 * exit 0, when the first of --count broadcasts, --for ms or an op --until
 * names comes; without one, at Ctrl-C. An error told for the doc, or the
 * server closing the socket, ends it with exit 1.
 */
async function cmdWatch(docName: string | undefined, values: Record<string, unknown>) {
  if (!docName) usageError("watch takes a <docName>", true);
  const most = wholeNumber(values.count, "--count");
  const ms = wholeNumber(values.for, "--for");
  const until = untilOf(values.until);
  const line = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const ends = most !== undefined || ms !== undefined || until !== undefined;
  say(`watching ${docName} on ${resolveWsUrl(values)}${ends ? "" : " (Ctrl-C to stop)"}`);
  // --for counts from now, before connecting: run out before the doc is open, and it is an error
  const end = Promise.withResolvers<void>();
  let opened = false;
  const timer = ms === undefined ? undefined
    : setTimeout(() => (opened ? end.resolve() : end.reject(new Error(`no answer in ${ms} ms (--for): open ${docName}`))), ms);
  const watching = withWs(values, async ({ send, onBroadcast, closed }) => {
    let heard = 0;
    const enough = () => { if (most !== undefined && heard >= most) end.resolve(); };
    onBroadcast((msg) => {
      if (msg.doc !== docName) return;
      if (msg.error) return end.reject(msg.error);
      line(msg);
      heard++;
      enough();
      if (until && Array.isArray(msg.ops) && msg.ops.some(until)) end.resolve();
    });
    const state = await send({ action: "open", doc: docName });
    opened = true;
    say(`opened ${docName}`);
    line({ doc: docName, state: state ?? null });
    enough();
    await Promise.race([end.promise, closed]);
  });
  try { await Promise.race([end.promise, watching]); }
  finally { clearTimeout(timer); }
}

async function cmdDelta(
  docName: string | undefined,
  opsJson: string | undefined,
  values: Record<string, unknown>,
) {
  if (!docName || !opsJson) usageError("delta takes a <docName> and <opsJSON>", true);
  const ops = parseJsonArg(opsJson, "ops");
  if (!Array.isArray(ops)) usageError("ops must be a JSON array");
  print(await withWs(values, async ({ send }) => {
    // SQLite's registerDocs requires the doc to be cached before delta;
    // opening on the same socket is the cheapest way to guarantee it.
    await send({ action: "open", doc: docName });
    // `inverse: true` asks for the ops as applied (and the inverse, where the backend keeps one)
    return send({ action: "delta", doc: docName, ops, inverse: true });
  }));
}

async function cmdCall(
  method: string | undefined,
  paramsJson: string | undefined,
  values: Record<string, unknown>,
) {
  if (!method) usageError("call takes a <method>", true);
  const params = parseJsonArg(paramsJson, "params");
  print(await withWs(values, ({ send }) => send({ action: "call", method, params: params ?? {} })));
}

// ---------------------------------------------------------------------------
// Header handling — identifies files written by delta init (stamped with this
// package's version) so upgrades can read them back and avoid clobbering
// user-owned SQL, and a `diff -u` against a later `init --upgrade` shows what changed.
// ---------------------------------------------------------------------------

const HEADER_RE = /^-- @blueshed\/delta ([a-z0-9-]+) v(\d+\.\d+\.\d+)/;

function readHeader(path: string): { kind: string; version: string } | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  const m = first.match(HEADER_RE);
  return m ? { kind: m[1]!, version: m[2]! } : null;
}

function writeWithHeader(src: string, dest: string, kind: "framework" | "auth-jwt"): void {
  const header =
    `-- @blueshed/delta ${kind} v${PKG_VERSION}\n` +
    `-- Vendored by 'delta init'. Safe to read; prefer 'delta init --upgrade' over hand edits.\n\n`;
  writeFileSync(dest, header + readFileSync(src, "utf8"));
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
  if (!modulePath) usageError("sql takes a <module>", true);

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

  const schemaExport = values["schema-export"] as string;
  const docsExport = values["docs-export"] as string;
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
    mkdirSync(dirname(absOut), { recursive: true });
    await Bun.write(out, sql);
    process.stderr.write(`Wrote ${out} (${sql.length} bytes)\n`);
  } else {
    process.stdout.write(sql);
  }
}

// ---------------------------------------------------------------------------
// delta init
// ---------------------------------------------------------------------------

function cmdInit(dir: string | undefined, values: Record<string, unknown>) {
  if (!dir) usageError("init takes a <dir>", true);

  const absDir = resolve(process.cwd(), dir);
  mkdirSync(absDir, { recursive: true });

  const upgrade = !!values.upgrade;
  const plan: { src: string; dest: string; kind: "framework" | "auth-jwt" }[] =
    frameworkSqlFiles().map((src) => ({ src, dest: join(absDir, basename(src)), kind: "framework" }));
  if (values["with-auth"]) plan.push({ src: authJwtSqlFile(), dest: join(absDir, "002-users.sql"), kind: "auth-jwt" });

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
      if (!upgrade || readHeader(dest)?.version === PKG_VERSION) {
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
//   - @blueshed/* packages in node_modules with `.claude/skills/<name>/SKILL.md`
//     (e.g. @blueshed/railroad ships `railroad` and `bun-route`)
//   - any other package the consumer names in its package.json `claudeSkills`
// A skill is instructions an agent follows, so a package that merely sits in
// node_modules (a dependency of a dependency) does not get to ship one.
//
// Skills aren't versioned like SQL — we always overwrite, but back up the
// existing file as `.bak` so a consumer who edited their copy doesn't lose
// it. Bytewise-identical destinations are skipped. Each skill folder installed
// mirrors its source: a file the source no longer has is removed (a skill
// that split reference.md into reference/ leaves no stale reference.md
// beside it), but never a `.bak`, and never outside the folders installed.
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

/** The packages outside @blueshed/* whose skills the consumer asked for: package.json `claudeSkills`. */
function allowedSkillPackages(): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    return new Set(Array.isArray(pkg.claudeSkills) ? pkg.claudeSkills.filter((n: unknown) => typeof n === "string") : []);
  } catch {
    return new Set();
  }
}

function discoverSkillSources(): SkillSource[] {
  const sources = new Map<string, SkillSource>();   // by name: the first found wins
  const add = (s: SkillSource) => void (sources.has(s.name) || sources.set(s.name, s));
  const allowed = allowedSkillPackages();

  // Our own skill — always present, ships in this package.
  listSkillsIn(resolve(import.meta.dir, ".claude/skills"), "@blueshed/delta").forEach(add);

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
        if (!name.startsWith("@blueshed/") && !allowed.has(name)) {
          if (listSkillsIn(skillsRoot, name).length) {
            process.stderr.write(`  skipped ${name}: not @blueshed/*, and not in package.json "claudeSkills"\n`);
          }
          continue;
        }
        listSkillsIn(skillsRoot, name).forEach(add);
      }
    }
  }

  return [...sources.values()];
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

/** A backup install-skills left (`x.bak`, `x.bak.1`): the consumer's, never pruned. */
const isBackup = (name: string) => /\.bak(\.\d+)?$/.test(name);

/**
 * Remove from `dest` what `src` no longer has (`src` null: a folder the source
 * dropped), keeping backups; a folder left empty goes too.
 */
function pruneDir(
  src: string | null,
  dest: string,
  dryRun: boolean,
  onRemove: (relPath: string) => void,
  prefix = "",
): void {
  if (!existsSync(dest)) return;
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    const srcPath = src && join(src, entry.name);
    const destPath = join(dest, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const kept = srcPath && existsSync(srcPath) ? srcPath : null;
      pruneDir(kept, destPath, dryRun, onRemove, rel);
      if (!kept && !dryRun && readdirSync(destPath).length === 0) rmdirSync(destPath);
      continue;
    }
    if (isBackup(entry.name) || (srcPath && existsSync(srcPath))) continue;
    if (!dryRun) rmSync(destPath);
    onRemove(rel);
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
    const removed: string[] = [];
    pruneDir(srcDir, destDir, dryRun, (rel) => removed.push(rel));
    const parts: string[] = [];
    if (created.length) parts.push(`+${created.join(", ")}`);
    if (removed.length) parts.push(`-${removed.join(", ")}`);
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
// delta migrate
// ---------------------------------------------------------------------------

/**
 * Run an app's migrations (`--dir`, default ./migrations, each `NNN-name.ts`
 * exporting `up`; `--app` names the app when apps share the database) against
 * its database, or with --status say which ran and which are pending. With no
 * schema to ask, an app with nothing recorded is new only to a database with
 * no table but delta's: the app's own start-up, given its schema, knows better. The database: a postgres:// URL, a PGlite directory, or a
 * SQLite file -- one that is there: a name mistyped makes no new database.
 */
async function cmdMigrate(target: string | undefined, values: Record<string, unknown>) {
  if (!target) usageError("migrate takes a <database>: a SQLite file, a PGlite directory, or a postgres:// URL", true);
  const { setLogLevel } = await import("./src/server/logger");
  setLogLevel(json ? "silent" : "warn");
  const dir = resolve(process.cwd(), (values.dir as string | undefined) ?? "migrations");
  const status = !!values.status;
  const options = { app: (values.app as string | undefined) ?? "" };
  const isUrl = /^postgres(ql)?:\/\//.test(target);
  const path = resolve(process.cwd(), target);
  if (!isUrl && !existsSync(path)) usageError(`no database at ${target}`);
  if (!existsSync(dir)) usageError(`no migrations folder at ${dir} (--dir)`);

  let answer: unknown;
  if (isUrl || statSync(path).isDirectory()) {
    const pg = await import("./src/server/postgres/migrate");
    let pool: any;
    if (isUrl) {
      const { Pool } = await import("pg");
      pool = new Pool({ connectionString: target });
    } else {
      const { openPglite } = await import("./src/server/pglite");
      pool = await openPglite(path);
    }
    try {
      const list = await pg.fromFolder(dir);
      answer = status ? await pg.migrationStatus(pool, list, options) : await pg.migrate(pool, list, options);
    } finally { await pool.end(); }
  } else {
    const { Database } = await import("bun:sqlite");
    const sqlite = await import("./src/server/sqlite/migrate");
    const db = new Database(path);
    try {
      const list = await sqlite.fromFolder(dir);
      answer = status ? await sqlite.migrationStatus(db, list, options) : await sqlite.migrate(db, list, options);
    } finally { db.close(); }
  }
  if (json) return print(answer);
  if (status) {
    const s = answer as import("./src/server/migrate").MigrationStatus;
    if (s.fresh) process.stdout.write("new database: migrate records every migration as run, and runs none\n");
    for (const r of s.ran) process.stdout.write(`ran      ${r.id}  ${r.ran_at}\n`);
    for (const id of s.pending) process.stdout.write(`pending  ${id}\n`);
    for (const id of s.unknown) process.stdout.write(`unknown  ${id}  (ran here, not in ${dir})\n`);
    return;
  }
  const r = answer as import("./src/server/migrate").MigrateResult;
  if (r.fresh) process.stdout.write("new database: every migration recorded as run, none run\n");
  for (const id of r.ran) process.stdout.write(`ran      ${id}\n`);
  if (!r.fresh && r.ran.length === 0) process.stdout.write("nothing to run\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let parsed;
  try { parsed = parseArgs({
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
      token: { type: "string" },
      json: { type: "boolean", default: false },
      count: { type: "string" },
      for: { type: "string" },
      until: { type: "string" },
      timeout: { type: "string" },
      dir: { type: "string" },
      app: { type: "string" },
      status: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  }); }
  catch (err) { usageError((err as Error).message, true); }
  const { values, positionals } = parsed;

  if (values.help) { process.stdout.write(USAGE); return; }

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
    case "migrate":         return cmdMigrate(arg, values);
    default:                usageError(cmd ? `no command ${cmd}` : "a command, please", true);
  }
}

main().catch((err) => fail(err));
