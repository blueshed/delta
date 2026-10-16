#!/usr/bin/env bun
/** @blueshed/delta CLI: the commands are listed in `USAGE`. */
import { parseArgs } from "node:util";
import { resolve, basename, join, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync, statSync } from "node:fs";

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
    `  delta install-skills [--user] [--dry-run]\n` +
    `  delta migrate <database> [--app <name>] [--dir <migrations>] [--status]   run (or list) an app's migrations\n` +
    `        <database>: a SQLite file; --dir defaults to ./migrations (Postgres: dzql migrate)\n` +
    `  delta link <database> <person> [--origin <url>] [--opens <path>]   a link to sign in as someone\n` +
    `        (auth-link): the first person's, on the server; <database> a SQLite file (Postgres: dzql link)\n` +
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
 * no table but delta's: the app's own start-up, given its schema, knows better.
 * The database: a SQLite file that is there (a name mistyped makes no new
 * database); Postgres is dzql's (`dzql migrate`).
 */
// ---------------------------------------------------------------------------
// delta link
// ---------------------------------------------------------------------------

/**
 * A link to sign in as `person` (auth-link), made in the app's SQLite file: how the first person
 * signs in, before anyone can send them one. The site is --origin, else ORIGIN, else Railway's
 * domain. Postgres is dzql's (`dzql link`).
 */
async function cmdLink(target: string | undefined, person: string | undefined, values: Record<string, unknown>) {
  if (!target || !person) usageError("link takes a <database> and a <person>: delta link app.db 1", true);
  if (!/^\d+$/.test(person)) usageError(`<person> is a person's id, a number: ${person}`);
  const path = resolve(process.cwd(), target);
  if (/^postgres(ql)?:\/\//.test(target) || (existsSync(path) && statSync(path).isDirectory())) usageError(`${target} is Postgres: dzql link makes its links`);
  if (!existsSync(path)) usageError(`no database at ${target}`);
  const { Database } = await import("bun:sqlite");
  const { makeLink, siteOrigin, sqliteLinkStore } = await import("./src/server/auth-link");
  let origin: string;
  try { origin = (values.origin as string | undefined) ?? siteOrigin(); }
  catch (err) { usageError(`${(err as Error).message}, or pass --origin`); }
  const db = new Database(path);
  try {
    const made = await makeLink(sqliteLinkStore(db), Number(person), { origin, opens: values.opens as string | undefined });
    if (json) return print(made);
    process.stdout.write(`${made.url}\n(used once, until ${made.expires})\n`);
  } finally { db.close(); }
}

async function cmdMigrate(target: string | undefined, values: Record<string, unknown>) {
  if (!target) usageError("migrate takes a <database>: a SQLite file (Postgres: dzql migrate)", true);
  const { setLogLevel } = await import("./src/server/logger");
  setLogLevel(json ? "silent" : "warn");
  const dir = resolve(process.cwd(), (values.dir as string | undefined) ?? "migrations");
  const status = !!values.status;
  const options = { app: (values.app as string | undefined) ?? "" };
  const path = resolve(process.cwd(), target);
  if (/^postgres(ql)?:\/\//.test(target) || (existsSync(path) && statSync(path).isDirectory())) usageError(`${target} is Postgres: dzql migrate runs its migrations`);
  if (!existsSync(path)) usageError(`no database at ${target}`);
  if (!existsSync(dir)) usageError(`no migrations folder at ${dir} (--dir)`);

  let answer: unknown;
  const { Database } = await import("bun:sqlite");
  const sqlite = await import("./src/server/sqlite/migrate");
  const db = new Database(path);
  try {
    const list = await sqlite.fromFolder(dir);
    answer = status ? await sqlite.migrationStatus(db, list, options) : await sqlite.migrate(db, list, options);
  } finally { db.close(); }
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
      origin: { type: "string" },
      opens: { type: "string" },
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
    case "install-skills":  return cmdInstallSkills(values);
    case "open":            return cmdOpen(arg, values);
    case "watch":           return cmdWatch(arg, values);
    case "delta":           return cmdDelta(arg, arg2, values);
    case "call":            return cmdCall(arg, arg2, values);
    case "migrate":         return cmdMigrate(arg, values);
    case "link":            return cmdLink(arg, arg2, values);
    default:                usageError(cmd ? `no command ${cmd}` : "a command, please", true);
  }
}

main().catch((err) => fail(err));
